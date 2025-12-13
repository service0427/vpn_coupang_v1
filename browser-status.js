#!/usr/bin/env node
/**
 * 브라우저 상태 조회 CLI
 *
 * 사용법:
 *   node browser-status.js          # 현재 상태 출력
 *   node browser-status.js --watch  # 실시간 모니터링 (5초마다)
 *   node browser-status.js --json   # JSON 형식 출력
 *   node browser-status.js --history # 오늘 히스토리 요약
 */

const browserStateManager = require('./lib/utils/browser-state-manager');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const watchMode = args.includes('--watch') || args.includes('-w');
const jsonMode = args.includes('--json') || args.includes('-j');
const historyMode = args.includes('--history') || args.includes('-h');

/**
 * KST 시간 포맷
 */
function formatKST(isoString) {
  if (!isoString) return 'N/A';
  const date = new Date(isoString);
  return date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

/**
 * 상태 출력
 */
function printStatus() {
  const state = browserStateManager.getState();

  if (jsonMode) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  // 화면 클리어 (watch 모드)
  if (watchMode) {
    console.clear();
  }

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           📊 브라우저 상태 모니터                             ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log(`║  총 브라우저: ${String(state.summary.total).padStart(3)}개                                       ║`);
  console.log(`║  마지막 업데이트: ${state.lastUpdated ? state.lastUpdated.split('T')[1].split('.')[0] : 'N/A'}                           ║`);
  console.log('╠═══════════════════════════════════════════════════════════════╣');

  // VPN별 현황
  const vpnEntries = Object.entries(state.summary.byVpn).sort((a, b) => {
    const numA = parseInt(a[0].split('_')[1]);
    const numB = parseInt(b[0].split('_')[1]);
    return numA - numB;
  });

  if (vpnEntries.length === 0) {
    console.log('║  실행 중인 브라우저 없음                                      ║');
  } else {
    // 2열로 VPN 정보 출력
    for (let i = 0; i < vpnEntries.length; i += 2) {
      let line = '║  ';
      const [vpn1, count1] = vpnEntries[i];
      const num1 = vpn1.split('_')[1];
      line += `VPN ${num1.padStart(2)}: ${String(count1).padStart(2)}개`;

      if (i + 1 < vpnEntries.length) {
        const [vpn2, count2] = vpnEntries[i + 1];
        const num2 = vpn2.split('_')[1];
        line += `          VPN ${num2.padStart(2)}: ${String(count2).padStart(2)}개`;
      } else {
        line += '                        ';
      }

      line += '                   ║';
      console.log(line);
    }
  }

  console.log('╠═══════════════════════════════════════════════════════════════╣');

  // 상세 정보 (최대 10개)
  const browsers = Object.values(state.browsers);
  if (browsers.length > 0) {
    console.log('║  최근 시작된 브라우저:                                        ║');
    const sorted = browsers.sort((a, b) =>
      new Date(b.startedAt) - new Date(a.startedAt)
    ).slice(0, 10);

    sorted.forEach(b => {
      const time = b.startedAt ? b.startedAt.split('T')[1].split('.')[0] : 'N/A';
      const info = `${b.key.padEnd(12)} PID:${String(b.pid).padEnd(7)} ${time}`;
      console.log(`║    ${info.padEnd(56)}║`);
    });
  }

  console.log('╚═══════════════════════════════════════════════════════════════╝');

  if (watchMode) {
    console.log('\n  [Ctrl+C] 종료 | 5초마다 갱신');
  }
}

/**
 * 히스토리 요약
 */
function printHistory() {
  const historyFile = browserStateManager.HISTORY_FILE;

  if (!fs.existsSync(historyFile)) {
    console.log('오늘 히스토리가 없습니다.');
    return;
  }

  const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n');
  const events = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);

  // 통계 계산
  const stats = {
    starts: 0,
    stops: 0,
    crashes: 0,
    recovered: 0,
    byVpn: {}
  };

  events.forEach(e => {
    if (e.event === 'BROWSER_START') stats.starts++;
    else if (e.event === 'BROWSER_STOP') stats.stops++;
    else if (e.event === 'BROWSER_CRASHED') stats.crashes++;
    else if (e.event === 'BROWSER_RECOVERED') stats.recovered++;

    if (e.vpn) {
      const key = `vpn_${e.vpn}`;
      if (!stats.byVpn[key]) stats.byVpn[key] = { starts: 0, stops: 0 };
      if (e.event === 'BROWSER_START') stats.byVpn[key].starts++;
      if (e.event === 'BROWSER_STOP') stats.byVpn[key].stops++;
    }
  });

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           📜 오늘의 브라우저 히스토리                         ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log(`║  총 이벤트: ${events.length}개                                           ║`);
  console.log(`║  시작: ${stats.starts}개  |  종료: ${stats.stops}개  |  크래시: ${stats.crashes}개  |  복구: ${stats.recovered}개     ║`);
  console.log('╠═══════════════════════════════════════════════════════════════╣');

  // VPN별 통계
  console.log('║  VPN별 현황:                                                  ║');
  Object.entries(stats.byVpn)
    .sort((a, b) => parseInt(a[0].split('_')[1]) - parseInt(b[0].split('_')[1]))
    .forEach(([vpn, data]) => {
      const num = vpn.split('_')[1];
      console.log(`║    VPN ${num.padStart(2)}: 시작 ${String(data.starts).padStart(3)}  종료 ${String(data.stops).padStart(3)}                               ║`);
    });

  console.log('╚═══════════════════════════════════════════════════════════════╝');
}

// 메인 실행
browserStateManager.syncWithRunningBrowsers();

if (historyMode) {
  printHistory();
} else if (watchMode) {
  printStatus();
  setInterval(() => {
    browserStateManager.syncWithRunningBrowsers();
    printStatus();
  }, 5000);
} else {
  printStatus();
}
