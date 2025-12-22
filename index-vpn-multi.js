/**
 * 멀티 VPN 독립 실행 모드 - 쿠팡 Chrome 자동화
 *
 * 서버에서 동글을 동적으로 할당받아 VPN 연결
 * - 동글 할당: /dongle/allocate API
 * - 동글 반납: /dongle/release API
 * - agent_id: {hostname}-{순번} (예: U22-01-01, U22-01-02, ...)
 *
 * 독립 운영 모드:
 * - 각 VPN은 자체적으로 스코어 계산
 * - 스코어 < 2 이면 해당 VPN만 IP 토글 후 재시작
 * - 다른 VPN에 영향 없이 독립적으로 동작
 *
 * ============================================================
 * 기본 사용법:
 * ============================================================
 *   sudo npm start              # 기본: VPN 10개, 쓰레드 3개
 *   sudo npm start -- -v 5      # VPN 5개
 *   sudo npm start -- -v 5 -t 2 # VPN 5개, 쓰레드 2개
 *
 * ============================================================
 * 디버깅 예제:
 * ============================================================
 *
 * 1. 최소 구성 (VPN 1개, 쓰레드 1개, 1회 실행, 브라우저 유지):
 *    sudo node index-vpn-multi.js -v 1 -t 1 --once --debug
 *    → 작업 완료 후 브라우저 유지, 엔터 누르면 종료
 *
 * 2. 상세 로그와 함께 파일 저장:
 *    sudo node index-vpn-multi.js -v 1 -t 1 --debug 2>&1 | tee "logs/debug_$(date +%Y%m%d_%H%M%S).log"
 *
 * 3. VPN 3개, 쓰레드 2개로 테스트:
 *    sudo node index-vpn-multi.js -v 3 -t 2 --debug
 *
 * 참고:
 * - --debug: 브라우저 내부 로그 실시간 출력
 * - --once + -t 1: 작업 완료 후 브라우저 유지 (엔터로 종료)
 * - 로그 파일: logs/{agent_id}.log 에 저장됨
 * - VPN 상태 JSON: browser-data/vpn-status/{agent_id}.json
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// API 클라이언트 import
const { DongleAllocator } = require('./lib/modules/api-service');

// VPN 모듈 import
const { WireGuardHelper, VpnManager, VpnAgent } = require('./lib/vpn');

// 설정
const DEFAULT_VPN_COUNT = 10;
const DEFAULT_THREADS_PER_VPN = 3;
const HOSTNAME = os.hostname().replace(/^tech-/i, '');

// 전역 디버그 모드
let DEBUG_MODE = false;

// 색상 출력
const colors = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// VPN 인덱스별 색상 (10가지)
const vpnColors = [
  (s) => `\x1b[38;5;196m${s}\x1b[0m`,  // 빨강
  (s) => `\x1b[38;5;208m${s}\x1b[0m`,  // 주황
  (s) => `\x1b[38;5;226m${s}\x1b[0m`,  // 노랑
  (s) => `\x1b[38;5;46m${s}\x1b[0m`,   // 초록
  (s) => `\x1b[38;5;51m${s}\x1b[0m`,   // 청록
  (s) => `\x1b[38;5;21m${s}\x1b[0m`,   // 파랑
  (s) => `\x1b[38;5;93m${s}\x1b[0m`,   // 보라
  (s) => `\x1b[38;5;201m${s}\x1b[0m`,  // 분홍
  (s) => `\x1b[38;5;250m${s}\x1b[0m`,  // 회색
  (s) => `\x1b[38;5;255m${s}\x1b[0m`,  // 흰색
];

// 타임스탬프 생성
const getTimestamp = () => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
};

const log = (msg) => console.log(`[${getTimestamp()}] ${colors.green('[MULTI-VPN]')} ${msg}`);
const warn = (msg) => console.log(`[${getTimestamp()}] ${colors.yellow('[MULTI-VPN]')} ${msg}`);
const error = (msg) => console.log(`[${getTimestamp()}] ${colors.red('[MULTI-VPN]')} ${msg}`);

// VPN 인스턴스별 로그
const vpnLog = (agentId, msg) => {
  const parts = agentId.split('-');
  const idx = parseInt(parts[parts.length - 1]) - 1;
  const colorFn = vpnColors[idx % vpnColors.length] || colors.cyan;
  console.log(`[${getTimestamp()}] ${colorFn(`[${agentId}]`)} ${msg}`);
};

// 명령줄 인자 파싱
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    vpnCount: DEFAULT_VPN_COUNT,
    threadsPerVpn: DEFAULT_THREADS_PER_VPN,
    once: false,
    debug: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--debug') options.debug = true;
    // VPN 개수: -v, --vpn-count, --vpn-count=N
    else if (arg === '-v' && args[i + 1]) options.vpnCount = parseInt(args[++i]);
    else if (arg.startsWith('--vpn-count=')) options.vpnCount = parseInt(arg.split('=')[1]);
    else if (arg === '--vpn-count' && args[i + 1]) options.vpnCount = parseInt(args[++i]);
    // 쓰레드 수: -t, --threads, --threads=N
    else if (arg === '-t' && args[i + 1]) options.threadsPerVpn = parseInt(args[++i]);
    else if (arg.startsWith('--threads=')) options.threadsPerVpn = parseInt(arg.split('=')[1]);
    else if (arg === '--threads' && args[i + 1]) options.threadsPerVpn = parseInt(args[++i]);
  }

  options.vpnCount = Math.max(1, Math.min(10, options.vpnCount || DEFAULT_VPN_COUNT));
  options.threadsPerVpn = Math.max(1, Math.min(10, options.threadsPerVpn || DEFAULT_THREADS_PER_VPN));

  return options;
}

function printHelp() {
  console.log(`
🌐 멀티 VPN 동시 실행 모드 - 쿠팡 Chrome 자동화

agent_id 형식: ${HOSTNAME}-{순번}
  예: ${HOSTNAME}-01, ${HOSTNAME}-02, ...

사용법:
  sudo node index-vpn-multi.js              # 기본값으로 실행
  sudo node index-vpn-multi.js -v 5 -t 2    # VPN 5개, 쓰레드 2개

옵션:
  -v, --vpn-count <n>  VPN 개수 (1~10, 기본: ${DEFAULT_VPN_COUNT})
  -t, --threads <n>    VPN당 쓰레드 수 (1~10, 기본: ${DEFAULT_THREADS_PER_VPN})
  --once               1회만 실행 후 종료
  --debug              디버그 모드
  -h, --help           도움말 표시

디버깅:
  sudo node index-vpn-multi.js --debug 2>&1 | tee "logs/multi_$(date +%Y%m%d_%H%M%S).log"
`);
}

// 싱글톤 인스턴스
const dongleAllocator = new DongleAllocator();
const wgHelper = new WireGuardHelper({ debug: DEBUG_MODE, logger: vpnLog });

// agent_id 생성 헬퍼
function createAgentId(vpnIndex) {
  return `${HOSTNAME}-${String(vpnIndex).padStart(2, '0')}`;
}

// 공유 로그 디렉토리
let sharedLogDir = null;

function getSharedLogDir() {
  if (!sharedLogDir) {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const timestamp = kst.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    sharedLogDir = path.join(__dirname, 'logs', `multi-${timestamp}`);
    if (!fs.existsSync(sharedLogDir)) {
      fs.mkdirSync(sharedLogDir, { recursive: true });
    }
  }
  return sharedLogDir;
}

// 모든 VPN 네임스페이스 정리
function cleanupAllVpns() {
  log('🧹 기존 VPN 정리 시작...');
  const cleanedCount = wgHelper.cleanupAllNamespaces(HOSTNAME, { log, warn });
  if (cleanedCount > 0) {
    log(`🧹 기존 VPN 정리 완료 (${cleanedCount}개 삭제됨)`);
  } else {
    log('🧹 기존 VPN 없음 - 정리 완료');
  }
}

// 메인 실행
async function main() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  // root 권한 확인
  if (process.getuid() !== 0) {
    error('root 권한이 필요합니다. sudo를 사용하세요.');
    process.exit(1);
  }

  const totalThreads = options.vpnCount * options.threadsPerVpn;
  DEBUG_MODE = options.debug;

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  🌐 멀티 VPN 독립 실행 모드 - 쿠팡 Chrome 자동화');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  호스트: ${HOSTNAME}`);
  if (DEBUG_MODE) console.log(`  🐛 디버그 모드: ON`);
  console.log(`  agent_id 범위: ${HOSTNAME}-01 ~ ${HOSTNAME}-${String(options.vpnCount).padStart(2, '0')}`);
  console.log(`  VPN 개수: ${options.vpnCount}개`);
  console.log(`  VPN당 쓰레드: ${options.threadsPerVpn}개`);
  console.log(`  총 쓰레드: ${totalThreads}개`);
  console.log(`  모드: ${options.once ? '1회 실행' : '연속 독립 실행'}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // 기존 VPN 정리
  cleanupAllVpns();

  // X서버 접근 권한 설정
  try {
    execSync('xhost +local:root 2>/dev/null || true', {
      stdio: 'pipe',
      env: { ...process.env, DISPLAY: ':0' }
    });
    log('X서버 접근 권한 설정 완료');
  } catch (e) {
    warn('X서버 접근 권한 설정 실패 (무시)');
  }

  // VpnManager + VpnAgent 쌍 생성
  const agents = [];
  const managers = [];

  for (let i = 1; i <= options.vpnCount; i++) {
    const agentId = createAgentId(i);

    const manager = new VpnManager({
      agentId,
      dongleAllocator,
      wgHelper,
      logger: vpnLog
    });

    const agent = new VpnAgent(manager, {
      vpnIndex: i,
      maxThreads: options.threadsPerVpn,
      onceMode: options.once,
      logger: vpnLog,
      getLogDir: getSharedLogDir,
      debugMode: DEBUG_MODE
    });

    managers.push(manager);
    agents.push(agent);
  }

  // 종료 시 정리
  let isShuttingDown = false;
  const cleanup = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('');
    log('종료 신호 받음, 모든 VPN 중지 중...');

    // 모든 에이전트 중지
    for (const agent of agents) {
      agent.stop();
    }

    // 동글 반납
    log('동글 반납 중...');
    await Promise.all(managers.map(m => m.releaseDongle().catch(() => {})));
    log('동글 반납 완료');

    await new Promise(r => setTimeout(r, 1000));
    cleanupAllVpns();

    // 최종 통계
    printFinalStats(agents);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // 각 VPN을 완전히 독립적으로 실행 (연결 즉시 루프 시작)
    log(`${options.vpnCount}개 VPN 독립 실행 시작...`);
    console.log('');

    // 각 VPN의 전체 생명주기를 독립적인 Promise로 실행
    const runVpnIndependently = async (manager, agent, index) => {
      // 연결 시도 간격 (1초씩 지연)
      if (index > 0) {
        await new Promise(r => setTimeout(r, index * 1000));
      }

      // 무한 루프 (--once가 아닐 때)
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 3;
      const RETRY_DELAY_SECONDS = 60;

      while (true) {
        // 연결 시도
        const connected = await manager.connect();

        if (!connected) {
          consecutiveFailures++;

          if (options.once) {
            // --once 모드: 실패하면 건너뜀
            vpnLog(agent.agentId, `❌ 연결 실패 - 이 VPN은 건너뜀`);
            return { agent, connected: false };
          }

          // 연속 모드: 재시도
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            vpnLog(agent.agentId, `❌ ${consecutiveFailures}회 연속 연결 실패 → ${RETRY_DELAY_SECONDS}초 후 재시도`);
            await new Promise(r => setTimeout(r, RETRY_DELAY_SECONDS * 1000));
            consecutiveFailures = 0;  // 리셋
          } else {
            vpnLog(agent.agentId, `❌ 연결 실패 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) → 10초 후 재시도`);
            await new Promise(r => setTimeout(r, 10000));
          }
          continue;  // 다시 시도
        }

        // 연결 성공 → 즉시 독립 루프 시작
        consecutiveFailures = 0;
        vpnLog(agent.agentId, `✅ 연결됨 → 독립 루프 즉시 시작`);
        await agent.runIndependentLoop();

        // --once 모드면 루프 종료
        if (options.once) {
          return { agent, connected: true };
        }

        // 연속 모드: runIndependentLoop이 끝났다면 (예: 예방적 토글로 종료)
        // 잠시 대기 후 새 동글로 재연결
        vpnLog(agent.agentId, `🔄 루프 종료 → 5초 후 새 동글 할당 시도`);
        await new Promise(r => setTimeout(r, 5000));
      }
    };

    // 모든 VPN을 병렬로 시작 (각각 독립적으로 연결 → 루프 실행)
    const allPromises = managers.map((manager, i) =>
      runVpnIndependently(manager, agents[i], i)
    );

    const results = await Promise.all(allPromises);
    const activeAgents = results.filter(r => r.connected).map(r => r.agent);

    if (activeAgents.length === 0) {
      throw new Error('모든 VPN 연결 실패');
    }

    // 결과 요약 (once 모드에서만 도달)
    printFinalStats(activeAgents);

  } catch (err) {
    error(`오류 발생: ${err.message}`);
    process.exitCode = 1;
  } finally {
    // 동글 반납
    console.log('');
    log('동글 반납 중...');
    await Promise.all(managers.map(m => m.releaseDongle().catch(() => {})));
    log('동글 반납 완료');
    cleanupAllVpns();
  }
}

// 최종 통계 출력
function printFinalStats(agents) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  log('실행 결과 요약');
  console.log('═══════════════════════════════════════════════════════════════');

  let grandTotal = { success: 0, fail: 0, blocked: 0, toggleCount: 0, runCount: 0, taskCount: 0 };
  let vpnTotals = { connectAttempts: 0, connectSuccesses: 0, dongleAllocations: 0, totalConnectTime: 0 };

  for (const agent of agents) {
    const s = agent.getTotalStats();
    grandTotal.success += s.success;
    grandTotal.fail += s.fail;
    grandTotal.blocked += s.blocked;
    grandTotal.toggleCount += s.toggleCount;
    grandTotal.runCount += s.runCount;
    grandTotal.taskCount += s.taskCount || 0;

    // VPN 통계 수집
    const vpnStats = agent.vpnManager?.getStats();
    if (vpnStats) {
      vpnTotals.connectAttempts += vpnStats.connectAttempts;
      vpnTotals.connectSuccesses += vpnStats.connectSuccesses;
      vpnTotals.dongleAllocations += vpnStats.dongleAllocations;
      vpnTotals.totalConnectTime += vpnStats.timing.totalConnectTime;
    }

    // 작업 통계
    const successRate = s.taskCount > 0 ? ((s.success / s.taskCount) * 100).toFixed(1) : '0.0';
    vpnLog(agent.agentId, `사이클:${s.runCount}회 작업:${s.taskCount || 0}개 성공:${s.success}(${successRate}%) 실패:${s.fail} 차단:${s.blocked} 토글:${s.toggleCount}회`);
  }

  console.log('');
  console.log('───────────────────────────────────────────────────────────────');

  // 작업 통계
  const totalSuccessRate = grandTotal.taskCount > 0
    ? ((grandTotal.success / grandTotal.taskCount) * 100).toFixed(1)
    : '0.0';
  log(`📋 작업 총계: ${grandTotal.taskCount}개 | 성공: ${grandTotal.success} (${totalSuccessRate}%) | 실패: ${grandTotal.fail} | 차단: ${grandTotal.blocked}`);

  // VPN 통계
  const avgConnectTime = vpnTotals.connectSuccesses > 0
    ? Math.round(vpnTotals.totalConnectTime / vpnTotals.connectSuccesses)
    : 0;
  const connectSuccessRate = vpnTotals.connectAttempts > 0
    ? ((vpnTotals.connectSuccesses / vpnTotals.connectAttempts) * 100).toFixed(1)
    : '0.0';
  log(`🔌 VPN 연결: ${vpnTotals.connectSuccesses}/${vpnTotals.connectAttempts}회 (${connectSuccessRate}%) | 평균 연결시간: ${avgConnectTime}ms`);
  log(`🔄 토글: ${grandTotal.toggleCount}회 | 동글 할당: ${vpnTotals.dongleAllocations}회`);

  console.log('═══════════════════════════════════════════════════════════════');
}

// 실행
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { VpnManager, VpnAgent, createAgentId, HOSTNAME };
