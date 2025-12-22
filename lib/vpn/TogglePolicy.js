/**
 * TogglePolicy - VPN 토글 조건 중앙 관리
 *
 * 토글이 필요한 모든 조건을 한 곳에서 관리합니다.
 * 현재 분산된 4가지 토글 조건:
 * 1. IP 체크 실패 (connect 시)
 * 2. 연속 3회 작업 없음 (noWorkCount >= 3)
 * 3. 차단됨 (score <= -2)
 * 4. 예방적 토글 (success >= 50)
 *
 * 사용법:
 *   const policy = new TogglePolicy();
 *   const { toggle, reason } = policy.shouldToggle({
 *     ipCheckFailed: false,
 *     noWorkCount: 2,
 *     score: 3,
 *     successCount: 45
 *   });
 */

/**
 * 토글 이유 enum
 */
const ToggleReason = {
  IP_CHECK_FAILED: 'IP_CHECK_FAILED',     // IP 확인 실패
  NO_WORK_STREAK: 'NO_WORK_STREAK',       // 연속 작업 없음
  BLOCKED: 'BLOCKED',                     // IP 차단됨
  PREVENTIVE: 'PREVENTIVE',               // 예방적 토글
  MANUAL: 'MANUAL',                       // 수동 요청
};

class TogglePolicy {
  /**
   * @param {Object} options - 정책 설정
   * @param {number} options.maxNoWorkStreak - 연속 작업 없음 임계값 (기본: 3)
   * @param {number} options.blockThreshold - 차단 판정 스코어 (기본: -2)
   * @param {number} options.preventiveToggleAt - 예방적 토글 성공 횟수 (기본: 50)
   */
  constructor(options = {}) {
    this.maxNoWorkStreak = options.maxNoWorkStreak ?? 3;
    this.blockThreshold = options.blockThreshold ?? -2;
    this.preventiveToggleAt = options.preventiveToggleAt ?? 50;
  }

  /**
   * 토글 필요 여부 판단
   *
   * @param {Object} context - 현재 상태
   * @param {boolean} context.ipCheckFailed - IP 체크 실패 여부
   * @param {number} context.noWorkCount - 연속 작업 없음 횟수
   * @param {number} context.score - 현재 스코어 (성공 - 차단)
   * @param {number} context.successCount - 토글 이후 성공 횟수
   * @returns {{ toggle: boolean, reason: string|null, priority: number }}
   *
   * priority 값 (낮을수록 높은 우선순위):
   * 1: IP_CHECK_FAILED - 즉시 처리 필요
   * 2: BLOCKED - 차단 상태
   * 3: NO_WORK_STREAK - 작업 할당 문제
   * 4: PREVENTIVE - 예방적
   */
  shouldToggle(context) {
    const {
      ipCheckFailed = false,
      noWorkCount = 0,
      score = 0,
      successCount = 0
    } = context;

    // 우선순위 1: IP 체크 실패 (가장 심각)
    if (ipCheckFailed) {
      return {
        toggle: true,
        reason: ToggleReason.IP_CHECK_FAILED,
        priority: 1,
        message: 'VPN 공인 IP 확인 실패'
      };
    }

    // 우선순위 2: 차단됨 (score <= -2)
    if (score <= this.blockThreshold) {
      return {
        toggle: true,
        reason: ToggleReason.BLOCKED,
        priority: 2,
        message: `스코어 ${score} <= ${this.blockThreshold} (차단 의심)`
      };
    }

    // 우선순위 3: 연속 작업 없음 (noWorkCount >= 3)
    if (noWorkCount >= this.maxNoWorkStreak) {
      return {
        toggle: true,
        reason: ToggleReason.NO_WORK_STREAK,
        priority: 3,
        message: `연속 ${noWorkCount}회 작업 없음`
      };
    }

    // 우선순위 4: 예방적 토글 (successCount >= 50)
    if (successCount >= this.preventiveToggleAt) {
      return {
        toggle: true,
        reason: ToggleReason.PREVENTIVE,
        priority: 4,
        message: `성공 ${successCount}회 도달 (예방적 토글)`
      };
    }

    return {
      toggle: false,
      reason: null,
      priority: 0,
      message: null
    };
  }

  /**
   * 스코어 계산 헬퍼
   * - 성공: +1
   * - 실패: 0 (점수 변동 없음)
   * - 차단: -1
   *
   * @param {Object} stats - 실행 통계
   * @param {number} stats.success - 성공 횟수
   * @param {number} stats.fail - 실패 횟수
   * @param {number} stats.blocked - 차단 횟수
   * @returns {number} 스코어
   */
  static calculateScore(stats) {
    return (stats.success || 0) - (stats.blocked || 0);
  }

  /**
   * 토글 조건 요약 문자열 생성
   *
   * @param {Object} context - shouldToggle과 동일한 컨텍스트
   * @returns {string} 현재 상태 요약
   */
  getStatusSummary(context) {
    const parts = [];

    if (context.score !== undefined) {
      const scoreStatus = context.score <= this.blockThreshold ? '⚠️' : '✅';
      parts.push(`스코어:${context.score}${scoreStatus}`);
    }

    if (context.noWorkCount !== undefined && context.noWorkCount > 0) {
      parts.push(`연속무작업:${context.noWorkCount}/${this.maxNoWorkStreak}`);
    }

    if (context.successCount !== undefined) {
      parts.push(`성공:${context.successCount}/${this.preventiveToggleAt}`);
    }

    return parts.join(' ');
  }

  /**
   * 토글 이유를 한글 메시지로 변환
   *
   * @param {string} reason - ToggleReason 값
   * @returns {string} 한글 메시지
   */
  static getReasonMessage(reason) {
    const messages = {
      [ToggleReason.IP_CHECK_FAILED]: 'IP 확인 실패',
      [ToggleReason.NO_WORK_STREAK]: '연속 작업 없음',
      [ToggleReason.BLOCKED]: 'IP 차단됨',
      [ToggleReason.PREVENTIVE]: '예방적 토글',
      [ToggleReason.MANUAL]: '수동 요청',
    };
    return messages[reason] || reason;
  }
}

module.exports = { TogglePolicy, ToggleReason };
