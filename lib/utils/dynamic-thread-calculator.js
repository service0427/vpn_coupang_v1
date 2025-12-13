/**
 * 동적 쓰레드 수 계산기
 *
 * 시스템 리소스(메모리, CPU)를 실시간 확인하여
 * 최적의 쓰레드 수를 계산합니다.
 *
 * 사용법:
 *   const calculator = require('./dynamic-thread-calculator');
 *   const threadCount = calculator.getOptimalThreadCount({ min: 6, max: 10 });
 */

const { execSync } = require('child_process');
const os = require('os');

// 브라우저 1개당 예상 리소스 (실측 기반)
const BROWSER_MEMORY_MB = 600;   // 실제 ~500-700MB (스왑 있을 때)
const BROWSER_CPU_LOAD = 0.3;    // 평균 CPU (대기 시 낮음, 작업 시 스파이크)

// 여유분 확보 (안전 마진)
const MEMORY_SAFETY_MARGIN = 0.85;  // 가용 메모리+스왑의 85% 사용 가능
const CPU_MAX_LOAD_RATIO = 1.2;     // CPU 코어 수의 120%까지 허용 (스파이크 대응)

/**
 * 시스템 메트릭 수집
 */
function getSystemMetrics() {
  const metrics = {
    availableMemoryMB: 0,
    availableSwapMB: 0,
    totalAvailableMB: 0,  // 메모리 + 스왑
    cpuLoad1min: 0,
    cpuCores: os.cpus().length,
    currentBrowserCount: 0
  };

  try {
    // 가용 메모리 + 스왑 (한글 시스템 대응)
    const freeOutput = execSync('free -m', { encoding: 'utf8' });
    const lines = freeOutput.split('\n');

    // 메모리 라인
    const memLine = lines.find(line =>
      line.includes('메모리') || line.includes('Mem')
    );
    if (memLine) {
      const parts = memLine.split(/\s+/).filter(p => p);
      metrics.availableMemoryMB = parseInt(parts[parts.length - 1]) || 0;
    }

    // 스왑 라인 ("스  왑" 또는 "Swap")
    const swapLine = lines.find(line =>
      line.match(/스\s*왑/) || line.includes('Swap')
    );
    if (swapLine) {
      const parts = swapLine.split(/\s+/).filter(p => p && !p.match(/스|왑/));
      // 스왑: [총계, 사용, 여분] → 여분은 인덱스 2
      metrics.availableSwapMB = parseInt(parts[2]) || 0;
    }

    // 총 가용 = 메모리 + 스왑의 50% (스왑은 느리므로 반만 계산)
    metrics.totalAvailableMB = metrics.availableMemoryMB + Math.floor(metrics.availableSwapMB * 0.5);
  } catch (e) {
    // fallback: os 모듈 사용
    metrics.availableMemoryMB = Math.floor(os.freemem() / 1024 / 1024);
    metrics.totalAvailableMB = metrics.availableMemoryMB;
  }

  try {
    // CPU 로드
    const loadAvg = os.loadavg();
    metrics.cpuLoad1min = loadAvg[0];
  } catch (e) {
    metrics.cpuLoad1min = 0;
  }

  try {
    // 현재 브라우저 수
    const chromeCount = execSync('pgrep -c chrome 2>/dev/null || echo 0', { encoding: 'utf8' });
    metrics.currentBrowserCount = parseInt(chromeCount.trim()) || 0;
  } catch (e) {
    metrics.currentBrowserCount = 0;
  }

  return metrics;
}

/**
 * 최적 쓰레드 수 계산
 * @param {Object} options
 * @param {number} options.min - 최소 쓰레드 (기본 6)
 * @param {number} options.max - 최대 쓰레드 (기본 10)
 * @param {number} options.vpnCount - 현재 VPN 수 (전체 브라우저 계산용)
 * @returns {number} 계산된 쓰레드 수
 */
function getOptimalThreadCount(options = {}) {
  const { min = 6, max = 10, vpnCount = 1, verbose = false } = options;

  const metrics = getSystemMetrics();

  // 1. 메모리 기반 계산 (스왑 포함)
  const availableForBrowsers = metrics.totalAvailableMB * MEMORY_SAFETY_MARGIN;
  const maxByMemory = Math.floor(availableForBrowsers / BROWSER_MEMORY_MB / vpnCount);

  // 2. CPU 기반 계산 (현재 로드 기준으로 추가 가능한 브라우저 수)
  const maxAllowedLoad = metrics.cpuCores * CPU_MAX_LOAD_RATIO;  // 24코어면 28.8까지 허용
  const remainingCpuCapacity = Math.max(0, maxAllowedLoad - metrics.cpuLoad1min);
  const maxByCpu = Math.floor(remainingCpuCapacity / BROWSER_CPU_LOAD / vpnCount);

  // 3. 최종 결정 (둘 중 작은 값, min/max 범위 내)
  let optimal = Math.min(maxByMemory, maxByCpu);
  optimal = Math.max(min, Math.min(max, optimal));

  if (verbose) {
    console.log('═══════════════════════════════════════════════════════');
    console.log('📊 동적 쓰레드 계산 결과');
    console.log('───────────────────────────────────────────────────────');
    console.log(`  가용 메모리: ${metrics.availableMemoryMB}MB`);
    console.log(`  가용 스왑: ${metrics.availableSwapMB}MB (50% 반영)`);
    console.log(`  총 가용: ${metrics.totalAvailableMB}MB`);
    console.log(`  CPU 로드: ${metrics.cpuLoad1min.toFixed(2)} / ${metrics.cpuCores} 코어`);
    console.log(`  현재 브라우저: ${metrics.currentBrowserCount}개`);
    console.log('───────────────────────────────────────────────────────');
    console.log(`  메모리 기준 최대: ${maxByMemory}개/VPN`);
    console.log(`  CPU 기준 최대: ${maxByCpu}개/VPN`);
    console.log(`  설정 범위: ${min}~${max}`);
    console.log('───────────────────────────────────────────────────────');
    console.log(`  ✅ 최적 쓰레드 수: ${optimal}개/VPN`);
    console.log(`     (${vpnCount}개 VPN × ${optimal} = 총 ${vpnCount * optimal}개 브라우저)`);
    console.log('═══════════════════════════════════════════════════════');
  }

  return optimal;
}

/**
 * 새 브라우저 시작 가능 여부 확인
 * @returns {boolean} 시작 가능 여부
 */
function canStartNewBrowser() {
  const metrics = getSystemMetrics();

  // 메모리 체크 (최소 2GB 여유)
  if (metrics.availableMemoryMB < 2000) {
    return { canStart: false, reason: `메모리 부족 (${metrics.availableMemoryMB}MB < 2000MB)` };
  }

  // CPU 체크 (로드가 코어 수의 90% 미만)
  const cpuThreshold = metrics.cpuCores * 0.9;
  if (metrics.cpuLoad1min > cpuThreshold) {
    return { canStart: false, reason: `CPU 과부하 (${metrics.cpuLoad1min.toFixed(1)} > ${cpuThreshold.toFixed(1)})` };
  }

  return { canStart: true, reason: 'OK' };
}

/**
 * 브라우저 시작 대기 (리소스 여유 생길 때까지)
 * @param {number} maxWaitMs - 최대 대기 시간 (기본 30초)
 * @returns {Promise<boolean>} 시작 가능 여부
 */
async function waitForResources(maxWaitMs = 30000) {
  const startTime = Date.now();
  const checkInterval = 1000;  // 1초마다 체크

  while (Date.now() - startTime < maxWaitMs) {
    const { canStart, reason } = canStartNewBrowser();
    if (canStart) {
      return true;
    }

    // 대기
    await new Promise(r => setTimeout(r, checkInterval));
  }

  return false;
}

module.exports = {
  getSystemMetrics,
  getOptimalThreadCount,
  canStartNewBrowser,
  waitForResources,
  BROWSER_MEMORY_MB,
  BROWSER_CPU_LOAD
};
