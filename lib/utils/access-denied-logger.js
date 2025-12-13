/**
 * Access Denied 전용 로거
 * - Access Denied 발생/해제 이벤트 상세 추적
 * - 새로고침 시도 횟수별 성공률 통계
 * - 시간대별/VPN별 패턴 분석
 *
 * Created: 2025-12-13
 */

const fs = require('fs');
const path = require('path');

// 한국시간(KST) 기준 날짜 문자열 생성
function getKSTDateString() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000)); // UTC + 9시간
  return kst.toISOString().split('T')[0];
}

// 로그 파일 경로 (한국시간 기준)
const LOG_DIR = path.join(process.cwd(), 'logs', 'access-denied');
const LOG_FILE = path.join(LOG_DIR, `access-denied-${getKSTDateString()}.jsonl`);
const SUMMARY_FILE = path.join(LOG_DIR, `summary-${getKSTDateString()}.json`);

// 메모리 내 통계 (프로세스 종료 시 저장)
const stats = {
  totalDetected: 0,           // 총 감지 횟수
  recoveredTotal: 0,          // 복구 성공 총 횟수
  failedTotal: 0,             // 복구 실패 총 횟수

  // 새로고침 시도 횟수별 성공 통계
  recoveryByAttempt: {
    1: 0,  // 1번째 시도에 성공
    2: 0,  // 2번째 시도에 성공
    3: 0,  // 3번째 시도에 성공
  },

  // VPN/동글별 통계
  byDongle: {},  // { dongle_16: { detected: 0, recovered: 0, failed: 0 } }

  // 시간대별 통계 (시간별)
  byHour: {},    // { '14': { detected: 0, recovered: 0, failed: 0 } }

  // 감지 위치별 통계
  byLocation: {
    selector_wait: 0,       // 셀렉터 대기 중 감지
    timeout_check: 0,       // 타임아웃 후 체크
    title_check: 0,         // 타이틀 체크
  },

  // 연속 실패 추적 (같은 VPN에서)
  consecutiveFailures: {},  // { dongle_16: 0 }
  maxConsecutiveFailures: 0,

  // 세션 시작 시간
  sessionStart: new Date().toISOString(),
};

// 디렉토리 생성
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

// 한국시간(KST) 타임스탬프 생성
function getKSTTimestamp() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().replace('Z', '+09:00');
}

/**
 * 로그 이벤트 기록
 */
function logEvent(event) {
  ensureLogDir();

  const logEntry = {
    timestamp: getKSTTimestamp(),
    ...event
  };

  // JSONL 형식으로 파일에 추가
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n');
    // 디버그: 파일 기록 성공
    console.log(`[AccessDeniedLog] 📝 파일 기록: ${LOG_FILE}`);
  } catch (err) {
    console.error(`[AccessDeniedLog] ❌ 파일 기록 실패: ${err.message}`);
  }

  return logEntry;
}

/**
 * Access Denied 감지 기록
 * @param {Object} params
 * @param {string} params.location - 감지 위치 (selector_wait, timeout_check, title_check)
 * @param {number} params.threadNum - 쓰레드 번호
 * @param {number|string} params.dongle - VPN 동글 번호 (없으면 'standard')
 * @param {number|null} params.keywordId - 키워드 ID
 * @param {string} params.url - 현재 URL
 * @param {string} params.pageTitle - 페이지 타이틀
 */
function logDetected({ location, threadNum, dongle = 'standard', keywordId, url, pageTitle }) {
  const hour = new Date().getHours().toString();
  const dongleKey = `dongle_${dongle}`;

  // 통계 업데이트
  stats.totalDetected++;
  stats.byLocation[location] = (stats.byLocation[location] || 0) + 1;

  // 동글별 통계
  if (!stats.byDongle[dongleKey]) {
    stats.byDongle[dongleKey] = { detected: 0, recovered: 0, failed: 0, recoveryAttempts: { 1: 0, 2: 0, 3: 0 } };
  }
  stats.byDongle[dongleKey].detected++;

  // 시간대별 통계
  if (!stats.byHour[hour]) {
    stats.byHour[hour] = { detected: 0, recovered: 0, failed: 0 };
  }
  stats.byHour[hour].detected++;

  const event = logEvent({
    type: 'DETECTED',
    location,
    threadNum,
    dongle,
    keywordId,
    url: url?.substring(0, 200),  // URL 길이 제한
    pageTitle,
  });

  // 콘솔에도 요약 출력
  console.log(`[AccessDeniedLog] 🚫 감지 #${stats.totalDetected} | 동글:${dongle} | 위치:${location}`);

  return event;
}

/**
 * 새로고침 시도 기록
 */
function logRefreshAttempt({ attemptNum, threadNum, dongle = 'standard', keywordId }) {
  return logEvent({
    type: 'REFRESH_ATTEMPT',
    attemptNum,
    threadNum,
    dongle,
    keywordId,
  });
}

/**
 * 복구 성공 기록
 * @param {Object} params
 * @param {number} params.attemptNum - 성공한 시도 횟수 (1, 2, 3)
 * @param {number} params.threadNum - 쓰레드 번호
 * @param {number|string} params.dongle - VPN 동글 번호
 * @param {number|null} params.keywordId - 키워드 ID
 * @param {number} params.recoveryTimeMs - 복구에 걸린 시간 (ms)
 */
function logRecovered({ attemptNum, threadNum, dongle = 'standard', keywordId, recoveryTimeMs }) {
  const hour = new Date().getHours().toString();
  const dongleKey = `dongle_${dongle}`;

  // 통계 업데이트
  stats.recoveredTotal++;
  stats.recoveryByAttempt[attemptNum] = (stats.recoveryByAttempt[attemptNum] || 0) + 1;

  // 동글별
  if (stats.byDongle[dongleKey]) {
    stats.byDongle[dongleKey].recovered++;
    stats.byDongle[dongleKey].recoveryAttempts[attemptNum] =
      (stats.byDongle[dongleKey].recoveryAttempts[attemptNum] || 0) + 1;
  }

  // 시간대별
  if (stats.byHour[hour]) {
    stats.byHour[hour].recovered++;
  }

  // 연속 실패 초기화
  stats.consecutiveFailures[dongleKey] = 0;

  const event = logEvent({
    type: 'RECOVERED',
    attemptNum,
    threadNum,
    dongle,
    keywordId,
    recoveryTimeMs,
  });

  // 콘솔에도 요약 출력
  const rate = ((stats.recoveredTotal / stats.totalDetected) * 100).toFixed(1);
  console.log(`[AccessDeniedLog] ✅ 복구 성공 | 시도:${attemptNum}회 | 동글:${dongle} | 복구율:${rate}%`);

  return event;
}

/**
 * 복구 실패 기록 (3회 시도 후 실패)
 */
function logFailed({ threadNum, dongle = 'standard', keywordId, finalError }) {
  const hour = new Date().getHours().toString();
  const dongleKey = `dongle_${dongle}`;

  // 통계 업데이트
  stats.failedTotal++;

  // 동글별
  if (stats.byDongle[dongleKey]) {
    stats.byDongle[dongleKey].failed++;
  }

  // 시간대별
  if (stats.byHour[hour]) {
    stats.byHour[hour].failed++;
  }

  // 연속 실패 카운트
  stats.consecutiveFailures[dongleKey] = (stats.consecutiveFailures[dongleKey] || 0) + 1;
  if (stats.consecutiveFailures[dongleKey] > stats.maxConsecutiveFailures) {
    stats.maxConsecutiveFailures = stats.consecutiveFailures[dongleKey];
  }

  const event = logEvent({
    type: 'FAILED',
    threadNum,
    dongle,
    keywordId,
    finalError: finalError?.substring(0, 500),
    consecutiveFailures: stats.consecutiveFailures[dongleKey],
  });

  // 콘솔에도 요약 출력 (경고 강조)
  const rate = ((stats.failedTotal / stats.totalDetected) * 100).toFixed(1);
  console.log(`[AccessDeniedLog] ❌ 복구 실패 | 동글:${dongle} | 연속실패:${stats.consecutiveFailures[dongleKey]}회 | 실패율:${rate}%`);

  return event;
}

/**
 * 현재 통계 조회
 */
function getStats() {
  const total = stats.totalDetected;

  return {
    ...stats,
    // 계산된 비율들
    recoveryRate: total > 0 ? ((stats.recoveredTotal / total) * 100).toFixed(2) + '%' : '0%',
    failureRate: total > 0 ? ((stats.failedTotal / total) * 100).toFixed(2) + '%' : '0%',

    // 시도 횟수별 성공률
    recoveryByAttemptRate: {
      1: stats.recoveredTotal > 0 ? ((stats.recoveryByAttempt[1] / stats.recoveredTotal) * 100).toFixed(1) + '%' : '0%',
      2: stats.recoveredTotal > 0 ? ((stats.recoveryByAttempt[2] / stats.recoveredTotal) * 100).toFixed(1) + '%' : '0%',
      3: stats.recoveredTotal > 0 ? ((stats.recoveryByAttempt[3] / stats.recoveredTotal) * 100).toFixed(1) + '%' : '0%',
    },

    // 세션 정보
    sessionDuration: Math.floor((Date.now() - new Date(stats.sessionStart).getTime()) / 1000 / 60) + '분',
  };
}

/**
 * 통계 요약 출력
 */
function printSummary() {
  const s = getStats();

  console.log('\n' + '='.repeat(60));
  console.log('📊 Access Denied 통계 요약');
  console.log('='.repeat(60));
  console.log(`세션 시작: ${stats.sessionStart} (${s.sessionDuration})`);
  console.log(`총 감지: ${s.totalDetected}회`);
  console.log(`복구 성공: ${s.recoveredTotal}회 (${s.recoveryRate})`);
  console.log(`복구 실패: ${s.failedTotal}회 (${s.failureRate})`);
  console.log('');
  console.log('📈 새로고침 시도 횟수별 성공:');
  console.log(`  1회차: ${s.recoveryByAttempt[1]}회 (${s.recoveryByAttemptRate[1]})`);
  console.log(`  2회차: ${s.recoveryByAttempt[2]}회 (${s.recoveryByAttemptRate[2]})`);
  console.log(`  3회차: ${s.recoveryByAttempt[3]}회 (${s.recoveryByAttemptRate[3]})`);
  console.log('');
  console.log('🔌 동글별 통계:');
  for (const [dongle, data] of Object.entries(s.byDongle)) {
    const dongleRate = data.detected > 0 ? ((data.recovered / data.detected) * 100).toFixed(1) : 0;
    console.log(`  ${dongle}: 감지 ${data.detected}, 복구 ${data.recovered}, 실패 ${data.failed} (복구율 ${dongleRate}%)`);
  }
  console.log('');
  console.log('⏰ 시간대별 통계:');
  const sortedHours = Object.keys(s.byHour).sort((a, b) => parseInt(a) - parseInt(b));
  for (const hour of sortedHours) {
    const data = s.byHour[hour];
    console.log(`  ${hour}시: 감지 ${data.detected}, 복구 ${data.recovered}, 실패 ${data.failed}`);
  }
  console.log('');
  console.log('📍 감지 위치별:');
  for (const [loc, count] of Object.entries(s.byLocation)) {
    console.log(`  ${loc}: ${count}회`);
  }
  console.log(`\n최대 연속 실패: ${s.maxConsecutiveFailures}회`);
  console.log('='.repeat(60) + '\n');
}

/**
 * 통계를 파일로 저장
 */
function saveSummary() {
  ensureLogDir();
  const summary = getStats();
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  console.log(`[AccessDeniedLog] 통계 저장됨: ${SUMMARY_FILE}`);
}

/**
 * 프로세스 종료 시 통계 저장
 */
function setupExitHandler() {
  const handler = () => {
    if (stats.totalDetected > 0) {
      printSummary();
      saveSummary();
    }
  };

  process.on('exit', handler);
  process.on('SIGINT', () => { handler(); process.exit(0); });
  process.on('SIGTERM', () => { handler(); process.exit(0); });
}

// 자동으로 종료 핸들러 등록
setupExitHandler();

module.exports = {
  logDetected,
  logRefreshAttempt,
  logRecovered,
  logFailed,
  getStats,
  printSummary,
  saveSummary,
};
