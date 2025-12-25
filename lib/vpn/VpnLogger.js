/**
 * VpnLogger - VPN 상세 로그 파일 저장
 *
 * VPN 할당/반납/토글/에러 등 상세 이벤트를 파일로 기록합니다.
 * 콘솔로 전달하기 어려운 에러 디버깅용입니다.
 *
 * 사용법:
 *   const logger = new VpnLogger('U22-01-01');
 *   logger.info('동글 할당 요청');
 *   logger.error('연결 실패', { reason: 'timeout' });
 */

const fs = require('fs');
const path = require('path');

class VpnLogger {
  /**
   * @param {string} agentId - 에이전트 ID (예: U22-01-01)
   * @param {Object} options
   * @param {string} options.logDir - 로그 디렉토리 (기본: ./logs/vpn)
   * @param {boolean} options.consoleOutput - 콘솔에도 출력 (기본: false)
   * @param {boolean} options.enabled - 파일 로깅 활성화 (기본: false, DEBUG 모드에서만 true)
   */
  constructor(agentId, options = {}) {
    this.agentId = agentId;
    this.logDir = options.logDir || path.join(process.cwd(), 'logs', 'vpn');
    this.consoleOutput = options.consoleOutput || false;
    // 기본값 false - DEBUG 환경변수 또는 명시적 enabled로만 활성화
    this.enabled = options.enabled || process.env.VPN_DEBUG === 'true' || false;

    // 비활성화 상태면 파일 생성 안 함
    if (!this.enabled) {
      this.logFile = null;
      return;
    }

    // 로그 디렉토리 생성
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // 로그 파일 경로 (일별 + 에이전트별)
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    this.logFile = path.join(this.logDir, `${date}_${agentId}.log`);

    // 세션 시작 로그
    this._write('SESSION_START', `VPN 로거 시작 - ${agentId}`);
  }

  /**
   * 타임스탬프 생성
   */
  _timestamp() {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return kst.toISOString().replace('T', ' ').slice(0, 23);
  }

  /**
   * 로그 기록
   */
  _write(level, message, data = null) {
    // 비활성화 상태면 기록 안 함
    if (!this.enabled || !this.logFile) {
      return;
    }

    const timestamp = this._timestamp();
    let logLine = `[${timestamp}] [${level}] ${message}`;

    if (data) {
      try {
        const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        logLine += `\n  └─ ${dataStr.replace(/\n/g, '\n     ')}`;
      } catch (e) {
        logLine += `\n  └─ [데이터 직렬화 실패]`;
      }
    }

    logLine += '\n';

    // 파일에 기록
    try {
      fs.appendFileSync(this.logFile, logLine);
    } catch (e) {
      console.error(`[VpnLogger] 파일 기록 실패: ${e.message}`);
    }

    // 콘솔 출력 (옵션)
    if (this.consoleOutput) {
      console.log(`[VPN-LOG] ${logLine.trim()}`);
    }
  }

  /**
   * 일반 정보 로그
   */
  info(message, data = null) {
    this._write('INFO', message, data);
  }

  /**
   * 경고 로그
   */
  warn(message, data = null) {
    this._write('WARN', message, data);
  }

  /**
   * 에러 로그
   */
  error(message, data = null) {
    this._write('ERROR', message, data);
  }

  /**
   * 디버그 로그
   */
  debug(message, data = null) {
    this._write('DEBUG', message, data);
  }

  // ========== VPN 전용 로그 메서드 ==========

  /**
   * 동글 할당 로그
   */
  dongleAllocated(dongleInfo) {
    this._write('DONGLE', '동글 할당됨', {
      id: dongleInfo.id,
      dongleNumber: dongleInfo.dongleNumber,
      serverIp: dongleInfo.serverIp
    });
  }

  /**
   * 동글 반납 로그
   */
  dongleReleased(dongleId, reason = '정상 반납') {
    this._write('DONGLE', `동글 반납 (${reason})`, { dongleId });
  }

  /**
   * VPN 연결 성공 로그
   */
  connected(namespace, vpnIp) {
    this._write('CONNECT', 'VPN 연결 성공', { namespace, vpnIp });
  }

  /**
   * VPN 연결 실패 로그
   */
  connectFailed(reason, details = null) {
    this._write('CONNECT', `VPN 연결 실패: ${reason}`, details);
  }

  /**
   * IP 체크 로그
   */
  ipCheck(success, ip = null, elapsed = null) {
    if (success) {
      this._write('IP_CHECK', `IP 확인 성공: ${ip}`, { elapsed: `${elapsed}ms` });
    } else {
      this._write('IP_CHECK', 'IP 확인 실패', { elapsed: `${elapsed}ms` });
    }
  }

  /**
   * 토글 로그
   */
  toggle(reason, details = null) {
    this._write('TOGGLE', `IP 토글: ${reason}`, details);
  }

  /**
   * 정책 토글 로그 (토글 이유 명확히 기록)
   */
  policyToggle(toggleReason, message, context = {}) {
    this._write('POLICY_TOGGLE', `${message}`, {
      reason: toggleReason,
      successSinceToggle: context.successCount,
      score: context.score,
      noWorkCount: context.noWorkCount
    });
  }

  /**
   * 50회 성공 달성 로그
   */
  milestone50(successCount, totalStats = {}) {
    this._write('MILESTONE', `🎉 50회 성공 달성! (실제: ${successCount}회)`, {
      totalSuccess: totalStats.success,
      totalFail: totalStats.fail,
      totalBlocked: totalStats.blocked,
      toggleCount: totalStats.toggleCount,
      cycleCount: totalStats.cycleCount
    });
  }

  /**
   * 성공 카운트 진행 로그 (10회마다)
   */
  successProgress(successCount, threshold = 50) {
    if (successCount > 0 && successCount % 10 === 0) {
      const percentage = Math.round((successCount / threshold) * 100);
      this._write('PROGRESS', `성공 ${successCount}/${threshold}회 (${percentage}%)`, {
        remaining: threshold - successCount
      });
    }
  }

  /**
   * 재연결 로그
   */
  reconnect(attempt, maxAttempts, success) {
    const status = success ? '성공' : '실패';
    this._write('RECONNECT', `재연결 ${status} (${attempt}/${maxAttempts})`);
  }

  /**
   * 배치 사이클 로그
   */
  batchCycle(cycleNum, taskCount, stats) {
    this._write('BATCH', `사이클 #${cycleNum}`, {
      tasks: taskCount,
      success: stats.success,
      fail: stats.fail,
      blocked: stats.blocked,
      score: (stats.success || 0) - (stats.blocked || 0)
    });
  }

  /**
   * 작업 결과 로그
   */
  taskResult(threadNum, task, result) {
    const status = result.success ? 'SUCCESS' : (result.blocked ? 'BLOCKED' : 'FAIL');
    this._write('TASK', `[T${threadNum}] ${status}`, {
      keyword: task.keyword?.substring(0, 30),
      productId: task.product_id,
      errorType: result.errorType,
      errorMessage: result.errorMessage?.substring(0, 100)
    });
  }

  /**
   * 루프 종료 로그
   */
  loopEnd(reason, totalStats) {
    this._write('LOOP_END', `루프 종료: ${reason}`, totalStats);
  }

  /**
   * 예외 로그 (스택 트레이스 포함)
   */
  exception(message, error) {
    this._write('EXCEPTION', message, {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 5).join('\n')
    });
  }

  /**
   * 세션 종료
   */
  close(stats = null) {
    this._write('SESSION_END', 'VPN 로거 종료', stats);
  }
}

module.exports = VpnLogger;
