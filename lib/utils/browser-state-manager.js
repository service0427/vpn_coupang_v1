/**
 * 브라우저 상태 관리자
 *
 * 실시간으로 브라우저 창 상태를 추적하고 JSON으로 관리
 * - 브라우저 시작/종료 이벤트 기록
 * - 갑작스런 종료 후 재시작 시 상태 복구
 * - 실시간 모니터링 지원
 *
 * 사용법:
 *   const browserStateManager = require('./browser-state-manager');
 *   browserStateManager.registerBrowser({ vpn: 20, thread: 6, pid: 12345 });
 *   browserStateManager.unregisterBrowser({ vpn: 20, thread: 6 });
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// DEBUG 모드에서만 파일 로깅 활성화
const LOG_ENABLED = process.env.LOG_DEBUG === 'true';

// 상태 파일 경로
const STATE_DIR = path.join(process.cwd(), 'logs', 'browser-state');
const STATE_FILE = path.join(STATE_DIR, 'browsers.json');
const HISTORY_FILE = path.join(STATE_DIR, `history-${new Date().toISOString().split('T')[0]}.jsonl`);

// 메모리 내 상태
let browserState = {
  lastUpdated: null,
  browsers: {},  // key: "vpn_{dongle}_{thread}" → value: browser info
  summary: {
    total: 0,
    byVpn: {}  // vpn별 브라우저 수
  }
};

/**
 * 상태 디렉토리 확인/생성
 */
function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

/**
 * KST 타임스탬프 생성
 */
function getKSTTimestamp() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().replace('Z', '+09:00');
}

/**
 * 상태 파일 로드
 */
function loadState() {
  ensureStateDir();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      browserState = JSON.parse(data);
      return true;
    }
  } catch (e) {
    console.error('[BrowserState] 상태 파일 로드 실패:', e.message);
  }
  return false;
}

/**
 * 상태 파일 저장
 */
function saveState() {
  // DEBUG 모드가 아니면 저장 안 함
  if (!LOG_ENABLED) return;

  ensureStateDir();
  try {
    browserState.lastUpdated = getKSTTimestamp();
    fs.writeFileSync(STATE_FILE, JSON.stringify(browserState, null, 2));
  } catch (e) {
    // 저장 실패 무시
  }
}

/**
 * 히스토리 기록 (JSONL)
 */
function logHistory(event) {
  // DEBUG 모드가 아니면 기록 안 함
  if (!LOG_ENABLED) return;

  ensureStateDir();
  try {
    const entry = {
      timestamp: getKSTTimestamp(),
      ...event
    };
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    // 히스토리 기록 실패는 무시
  }
}

/**
 * 요약 정보 업데이트
 */
function updateSummary() {
  const browsers = Object.values(browserState.browsers);
  browserState.summary.total = browsers.length;

  // VPN별 카운트
  const byVpn = {};
  browsers.forEach(b => {
    const vpnKey = `vpn_${b.vpn}`;
    byVpn[vpnKey] = (byVpn[vpnKey] || 0) + 1;
  });
  browserState.summary.byVpn = byVpn;
}

/**
 * 브라우저 등록
 * @param {Object} info - { vpn, thread, pid, chromeVersion, userDataDir }
 */
function registerBrowser(info) {
  const { vpn, thread, pid, chromeVersion, userDataDir } = info;
  const key = `vpn_${vpn}_t${thread}`;

  browserState.browsers[key] = {
    key,
    vpn,
    thread,
    pid,
    chromeVersion: chromeVersion || 'unknown',
    userDataDir: userDataDir || '',
    startedAt: getKSTTimestamp(),
    status: 'running'
  };

  updateSummary();
  saveState();

  logHistory({
    event: 'BROWSER_START',
    key,
    vpn,
    thread,
    pid
  });

  return key;
}

/**
 * 브라우저 해제
 * @param {Object} info - { vpn, thread } 또는 { key }
 */
function unregisterBrowser(info) {
  let key;
  if (info.key) {
    key = info.key;
  } else {
    key = `vpn_${info.vpn}_t${info.thread}`;
  }

  const browser = browserState.browsers[key];
  if (browser) {
    const duration = Date.now() - new Date(browser.startedAt).getTime();

    logHistory({
      event: 'BROWSER_STOP',
      key,
      vpn: browser.vpn,
      thread: browser.thread,
      pid: browser.pid,
      durationMs: duration
    });

    delete browserState.browsers[key];
    updateSummary();
    saveState();

    return true;
  }
  return false;
}

/**
 * 브라우저 상태 업데이트
 * @param {string} key - 브라우저 키
 * @param {Object} updates - 업데이트할 필드
 */
function updateBrowser(key, updates) {
  if (browserState.browsers[key]) {
    Object.assign(browserState.browsers[key], updates);
    browserState.browsers[key].lastUpdated = getKSTTimestamp();
    saveState();
    return true;
  }
  return false;
}

/**
 * 실제 실행 중인 브라우저와 상태 동기화
 * 갑작스런 종료 후 재시작 시 사용
 */
function syncWithRunningBrowsers() {
  loadState();

  try {
    // 실행 중인 Chrome 프로세스에서 user-data-dir 추출
    const psOutput = execSync(
      "ps aux | grep -E 'chrome.*user-data-dir.*vpn_' | grep -v grep",
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    const runningBrowsers = new Set();

    psOutput.split('\n').forEach(line => {
      // user-data-dir=/path/vpn_20/06/126 형식에서 추출
      const match = line.match(/user-data-dir=([^\s]+vpn_(\d+)\/(\d+))/);
      if (match) {
        const vpn = parseInt(match[2]);
        const thread = parseInt(match[3]);
        const key = `vpn_${vpn}_t${thread}`;
        runningBrowsers.add(key);

        // PID 추출
        const pidMatch = line.match(/^\S+\s+(\d+)/);
        const pid = pidMatch ? parseInt(pidMatch[1]) : 0;

        // 상태에 없으면 추가 (크래시 복구)
        if (!browserState.browsers[key]) {
          browserState.browsers[key] = {
            key,
            vpn,
            thread,
            pid,
            startedAt: getKSTTimestamp(),
            status: 'running',
            recoveredAt: getKSTTimestamp()
          };

          logHistory({
            event: 'BROWSER_RECOVERED',
            key,
            vpn,
            thread,
            pid
          });
        }
      }
    });

    // 상태에는 있지만 실제로 없는 브라우저 제거
    Object.keys(browserState.browsers).forEach(key => {
      if (!runningBrowsers.has(key)) {
        logHistory({
          event: 'BROWSER_CRASHED',
          key,
          vpn: browserState.browsers[key].vpn,
          thread: browserState.browsers[key].thread
        });
        delete browserState.browsers[key];
      }
    });

    updateSummary();
    saveState();

    return {
      synced: true,
      total: browserState.summary.total,
      byVpn: browserState.summary.byVpn
    };
  } catch (e) {
    // ps 명령 실패 시 (브라우저 없음)
    if (e.status === 1) {
      // grep 결과 없음 = 브라우저 없음
      browserState.browsers = {};
      updateSummary();
      saveState();
      return { synced: true, total: 0, byVpn: {} };
    }
    return { synced: false, error: e.message };
  }
}

/**
 * 현재 상태 조회
 */
function getState() {
  return {
    ...browserState,
    timestamp: getKSTTimestamp()
  };
}

/**
 * 특정 VPN의 브라우저 목록
 */
function getBrowsersByVpn(vpn) {
  return Object.values(browserState.browsers)
    .filter(b => b.vpn === vpn);
}

/**
 * 실시간 상태 출력 (콘솔)
 */
function printStatus() {
  syncWithRunningBrowsers();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('📊 브라우저 상태 현황');
  console.log('───────────────────────────────────────────────────────');
  console.log(`  총 브라우저: ${browserState.summary.total}개`);
  console.log(`  마지막 업데이트: ${browserState.lastUpdated}`);
  console.log('───────────────────────────────────────────────────────');

  // VPN별 현황
  Object.entries(browserState.summary.byVpn)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([vpn, count]) => {
      console.log(`  ${vpn}: ${count}개`);
    });

  console.log('═══════════════════════════════════════════════════════\n');

  return browserState.summary;
}

/**
 * 초기화 (시작 시 호출)
 */
function initialize() {
  ensureStateDir();
  const result = syncWithRunningBrowsers();
  console.log(`[BrowserState] 초기화 완료: ${result.total}개 브라우저 감지`);
  return result;
}

module.exports = {
  initialize,
  registerBrowser,
  unregisterBrowser,
  updateBrowser,
  syncWithRunningBrowsers,
  getState,
  getBrowsersByVpn,
  printStatus,
  STATE_FILE,
  HISTORY_FILE
};
