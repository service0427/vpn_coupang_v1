/**
 * VpnManager - VPN 연결 상태 관리
 *
 * 책임:
 * - 동글 할당/반납 (DongleAllocator)
 * - WireGuard 네임스페이스 설정 (WireGuardHelper)
 * - IP 토글/재연결
 * - BatchAllocator 초기화
 *
 * 사용법:
 *   const manager = new VpnManager({
 *     agentId: 'U22-01-01',
 *     dongleAllocator,
 *     wgHelper,
 *     logger: vpnLog
 *   });
 *   await manager.connect();
 *   await manager.toggleIp();
 *   await manager.reconnect();
 */

const { BatchAllocator, DongleAllocator, getEthernetIp } = require('../modules/api-service');
const VpnLogger = require('./VpnLogger');

class VpnManager {
  /**
   * @param {Object} options
   * @param {string} options.agentId - 에이전트 ID (예: "U22-01-01")
   * @param {DongleAllocator} options.dongleAllocator - 동글 할당자
   * @param {WireGuardHelper} options.wgHelper - WireGuard 헬퍼
   * @param {Function} options.logger - 로깅 함수 (agentId, msg)
   * @param {string} options.logDir - VPN 로그 디렉토리 (선택)
   */
  constructor(options) {
    this.agentId = options.agentId;
    this.dongleAllocator = options.dongleAllocator;
    this.wgHelper = options.wgHelper;
    this.logger = options.logger || ((id, msg) => console.log(`[${id}] ${msg}`));

    // 파일 로거 (상세 디버깅용)
    this.fileLogger = new VpnLogger(options.agentId, {
      logDir: options.logDir
    });

    // VPN 통계
    this.stats = {
      // 연결 관련
      connectAttempts: 0,       // 연결 시도 횟수
      connectSuccesses: 0,      // 연결 성공 횟수
      connectFailures: 0,       // 연결 실패 횟수

      // 타이밍 (ms)
      timing: {
        connectStart: null,          // 연결 시작 시각
        connectEnd: null,            // 연결 완료 시각
        lastConnectDuration: 0,      // 마지막 연결 소요 시간
        totalConnectTime: 0,         // 총 연결 소요 시간 (합산)
        ipCheckDurations: [],        // IP 확인 소요 시간 배열
        sessionStart: null,          // 세션 시작 시각
        sessionEnd: null,            // 세션 종료 시각
      },

      // 토글 관련
      toggleCount: 0,
      toggleReasons: {
        BLOCKED: 0,
        PREVENTIVE: 0,
        NO_WORK: 0,
        IP_CHECK_FAILED: 0,
        MANUAL: 0
      },

      // 동글 관련
      dongleAllocations: 0,     // 동글 할당 횟수
      dongleReleases: 0,        // 동글 반납 횟수
      currentDongle: null,      // 현재 동글 번호
      dongleHistory: [],        // 사용한 동글 기록 [{dongle, allocatedAt, releasedAt, duration}]
    };

    // 동글 정보 (connect 시 할당받음)
    this.dongleInfo = null;  // { id, dongleNumber, serverIp, privateKey, publicKey }
    this.dongleNumber = null;

    // 네임스페이스/인터페이스 (동글 할당 후 설정)
    this.namespace = null;
    this.wgInterface = null;

    // 연결 상태
    this.connected = false;
    this.vpnIp = null;

    // BatchAllocator (작업 할당용)
    this.allocator = null;
  }

  /**
   * 로그 출력
   * @param {string} msg - 메시지
   */
  log(msg) {
    this.logger(this.agentId, msg);
  }

  /**
   * VPN 연결 (동글 할당 → WireGuard 설정 → IP 확인)
   * @param {number} retryCount - 재시도 횟수 (내부용)
   * @returns {Promise<boolean>} 연결 성공 여부
   */
  async connect(retryCount = 0) {
    const MAX_RETRIES = 3;
    const connectStartTime = Date.now();

    // 통계: 연결 시도
    if (retryCount === 0) {
      this.stats.connectAttempts++;
      this.stats.timing.connectStart = new Date();
      if (!this.stats.timing.sessionStart) {
        this.stats.timing.sessionStart = new Date();
      }
    }

    try {
      this.log(`동글 할당 요청 중...${retryCount > 0 ? ` (재시도 ${retryCount}/${MAX_RETRIES})` : ''}`);
      this.fileLogger.info(`동글 할당 요청`, { retryCount, maxRetries: MAX_RETRIES });

      // 1. 서버에서 동글 할당받기
      const allocateStart = Date.now();
      this.dongleInfo = await this.dongleAllocator.allocate(this.agentId);
      if (!this.dongleInfo) {
        this.fileLogger.error('동글 할당 실패', { response: 'null' });
        throw new Error('동글 할당 실패');
      }

      // 통계: 동글 할당
      this.stats.dongleAllocations++;
      this.stats.currentDongle = this.dongleInfo.dongleNumber;
      this.stats.dongleHistory.push({
        dongle: this.dongleInfo.dongleNumber,
        dongleId: this.dongleInfo.id,
        serverIp: this.dongleInfo.serverIp,
        allocatedAt: new Date(),
        releasedAt: null,
        duration: null
      });

      this.dongleNumber = this.dongleInfo.dongleNumber;
      this.log(`동글 할당됨: dongle=${this.dongleNumber}, server=${this.dongleInfo.serverIp} (${Date.now() - allocateStart}ms)`);
      this.fileLogger.dongleAllocated(this.dongleInfo);

      // 2. 네임스페이스/인터페이스 이름 설정
      // 형식: {agentId}-{dongleId} (예: U22-01-05-031)
      const dongleIdStr = String(this.dongleInfo.id).padStart(3, '0');
      this.namespace = `${this.agentId}-${dongleIdStr}`;
      this.wgInterface = `wg-${this.dongleNumber}`;
      this.fileLogger.debug('네임스페이스 설정', { namespace: this.namespace, wgInterface: this.wgInterface });

      // 3. WireGuard 설정 생성
      const wgConfig = DongleAllocator.createWgConfig(this.dongleInfo);
      this.log(`WireGuard 설정: ${wgConfig.endpoint}, ${wgConfig.address}`);
      this.fileLogger.debug('WireGuard 설정', { endpoint: wgConfig.endpoint, address: wgConfig.address });

      // 4. VPN 네임스페이스 설정
      this.fileLogger.info('VPN 네임스페이스 설정 시작');
      this.wgHelper.setupNamespace(this.namespace, this.wgInterface, wgConfig, this.agentId);
      this.connected = true;
      this.fileLogger.info('VPN 네임스페이스 설정 완료');

      // 4.5. WireGuard 핸드셰이크 안정화 대기 (1초)
      await new Promise(r => setTimeout(r, 1000));

      // 5. VPN 공인 IP 확인 (타임아웃 5초, 실패 시 VPN정리→토글→반납→재시도)
      this.log(`IP 확인 중... (타임아웃 5초)`);
      this.fileLogger.info('IP 확인 시작', { timeout: '5초' });
      const ipCheckStart = Date.now();
      const vpnIp = this.wgHelper.getPublicIp(this.namespace, 5);
      const ipCheckElapsed = Date.now() - ipCheckStart;

      if (!vpnIp) {
        this.log(`❌ IP 확인 실패 (${ipCheckElapsed}ms) → VPN 정리 후 토글+반납`);
        this.fileLogger.ipCheck(false, null, ipCheckElapsed);
        this.stats.timing.ipCheckDurations.push({ success: false, duration: ipCheckElapsed });
        this.stats.toggleReasons.IP_CHECK_FAILED++;

        // 1. 먼저 VPN 정리 (네임스페이스 삭제)
        this.fileLogger.info('VPN 정리 시작 (IP 확인 실패)');
        this.wgHelper.cleanupNamespace(this.namespace, this.wgInterface);
        this.connected = false;

        // 네임스페이스 삭제 완료 대기
        await new Promise(r => setTimeout(r, 500));

        // 2. IP 토글 + 동글 반납 (dongleInfo가 유효한 경우에만)
        if (this.dongleInfo) {
          // IP 토글 (백그라운드)
          this.fileLogger.toggle('IP 확인 실패로 토글', { serverIp: this.dongleInfo.serverIp, dongleNumber: this.dongleNumber });
          this.dongleAllocator.toggle(this.dongleInfo.serverIp, this.dongleNumber);

          // 토글 요청 전송 후 잠시 대기
          await new Promise(r => setTimeout(r, 1000));

          // 동글 반납 (통계 포함)
          this.fileLogger.dongleReleased(this.dongleInfo.id, 'IP 확인 실패');
          const releaseStats = {
            session_duration_ms: this.stats.timing.sessionStart
              ? Date.now() - this.stats.timing.sessionStart.getTime()
              : 0,
            toggle_count: this.stats.toggleCount,
            toggle_reasons: { ...this.stats.toggleReasons },
            connect_attempts: this.stats.connectAttempts,
            connect_successes: this.stats.connectSuccesses,
            avg_connect_time_ms: 0,
            release_reason: 'IP 확인 실패'
          };
          await this.dongleAllocator.release(this.agentId, this.dongleInfo.id, releaseStats);
          this.dongleInfo = null;
          this.dongleNumber = null;
        } else {
          this.fileLogger.warn('IP 확인 실패 후 토글/반납 스킵 - dongleInfo 없음');
        }

        // 재시도
        if (retryCount < MAX_RETRIES) {
          this.fileLogger.info(`재시도 대기`, { nextRetry: retryCount + 1, delay: '2초' });
          await new Promise(r => setTimeout(r, 2000));
          return this.connect(retryCount + 1);
        }
        throw new Error('IP 확인 실패 (최대 재시도 초과)');
      }

      this.vpnIp = vpnIp;
      this.log(`연결됨 - 공인 IP: ${vpnIp}`);
      this.fileLogger.ipCheck(true, vpnIp, ipCheckElapsed);
      this.fileLogger.connected(this.namespace, vpnIp);

      // 통계: 연결 성공
      this.stats.timing.ipCheckDurations.push({ success: true, duration: ipCheckElapsed });
      const totalConnectDuration = Date.now() - connectStartTime;
      this.stats.connectSuccesses++;
      this.stats.timing.connectEnd = new Date();
      this.stats.timing.lastConnectDuration = totalConnectDuration;
      this.stats.timing.totalConnectTime += totalConnectDuration;
      this.log(`⏱️ 연결 완료: ${totalConnectDuration}ms (IP확인: ${ipCheckElapsed}ms)`);

      // 6. BatchAllocator 초기화 (작업 할당용)
      const agentIp = getEthernetIp();
      this.allocator = new BatchAllocator({
        agentIp: agentIp,
        vpnId: `${this.dongleInfo.serverIp}_${this.dongleNumber}`,
        externalIp: vpnIp
      });
      this.log(`BatchAllocator 초기화 완료`);
      this.fileLogger.info('BatchAllocator 초기화 완료', { agentIp, vpnId: `${this.dongleInfo.serverIp}_${this.dongleNumber}` });

      return true;
    } catch (err) {
      this.log(`연결 실패: ${err.message}`);
      this.fileLogger.exception('connect() 실패', err);

      // 연결 실패 시 동글 반납 (통계 포함)
      if (this.dongleInfo) {
        this.log(`연결 실패로 동글 반납: dongle=${this.dongleNumber}`);
        try {
          this.fileLogger.dongleReleased(this.dongleInfo.id, '연결 실패');
          const releaseStats = {
            session_duration_ms: this.stats.timing.sessionStart
              ? Date.now() - this.stats.timing.sessionStart.getTime()
              : 0,
            toggle_count: this.stats.toggleCount,
            toggle_reasons: { ...this.stats.toggleReasons },
            connect_attempts: this.stats.connectAttempts,
            connect_successes: this.stats.connectSuccesses,
            avg_connect_time_ms: 0,
            release_reason: '연결 실패'
          };
          await this.dongleAllocator.release(this.agentId, this.dongleInfo.id, releaseStats);
        } catch (releaseErr) {
          this.log(`⚠️ 동글 반납 실패: ${releaseErr.message}`);
          this.fileLogger.exception('동글 반납 실패', releaseErr);
        }
        this.dongleInfo = null;
        this.dongleNumber = null;
      }

      // VPN 네임스페이스 정리
      if (this.namespace && this.wgInterface) {
        this.fileLogger.info('VPN 네임스페이스 정리 (에러 복구)');
        this.wgHelper.cleanupNamespace(this.namespace, this.wgInterface);
      }

      // 재시도
      if (retryCount < MAX_RETRIES) {
        const delay = 3000 + retryCount * 2000; // 3초, 5초, 7초
        this.log(`${delay/1000}초 후 재시도... (${retryCount + 1}/${MAX_RETRIES})`);
        this.fileLogger.info(`재시도 대기`, { nextRetry: retryCount + 1, delay: `${delay}ms` });
        await new Promise(r => setTimeout(r, delay));
        return this.connect(retryCount + 1);
      }

      // 통계: 연결 실패
      this.stats.connectFailures++;
      this.fileLogger.connectFailed('최대 재시도 초과', { retryCount });
      return false;
    }
  }

  /**
   * VPN 재연결 (기존 정리 후 새로 연결)
   * @returns {Promise<boolean>} 연결 성공 여부
   */
  async reconnect() {
    this.log('VPN 재연결 중...');
    this.fileLogger.info('재연결 시작', {
      currentNamespace: this.namespace,
      currentDongle: this.dongleNumber
    });

    // 1. 기존 VPN 연결 정리
    if (this.namespace && this.wgInterface) {
      this.fileLogger.info('기존 VPN 네임스페이스 정리');
      this.wgHelper.cleanupNamespace(this.namespace, this.wgInterface);
    }
    this.connected = false;

    // 2. 기존 동글 반납 (간단한 통계만 전달)
    if (this.dongleInfo) {
      this.log(`기존 동글 반납: dongle=${this.dongleNumber}`);
      this.fileLogger.dongleReleased(this.dongleInfo.id, '재연결을 위한 반납');

      // 재연결 시에는 간단한 통계만 전달
      const releaseStats = {
        session_duration_ms: this.stats.timing.sessionStart
          ? Date.now() - this.stats.timing.sessionStart.getTime()
          : 0,
        toggle_count: this.stats.toggleCount,
        toggle_reasons: { ...this.stats.toggleReasons },
        connect_attempts: this.stats.connectAttempts,
        connect_successes: this.stats.connectSuccesses,
        avg_connect_time_ms: this.stats.connectSuccesses > 0
          ? Math.round(this.stats.timing.totalConnectTime / this.stats.connectSuccesses)
          : 0,
        release_reason: '재연결을 위한 반납'
      };

      await this.dongleAllocator.release(this.agentId, this.dongleInfo.id, releaseStats);
      this.dongleInfo = null;
      this.dongleNumber = null;
    }

    // 3. 짧은 대기
    await new Promise(r => setTimeout(r, 500));

    // 4. connect() 호출 (토글+재시도 로직 포함)
    const result = await this.connect();
    this.fileLogger.reconnect(1, 1, result);

    // 5. BatchAllocator 업데이트 (connect 성공 시)
    if (result && this.allocator && this.vpnIp) {
      this.allocator.setExternalIp(this.vpnIp);
      this.allocator.setVpnId(`${this.dongleInfo.serverIp}_${this.dongleNumber}`);
      this.fileLogger.info('BatchAllocator 업데이트', { newVpnIp: this.vpnIp });
    }

    return result;
  }

  /**
   * IP 토글 요청
   * @param {string} reason - 토글 사유 (BLOCKED, PREVENTIVE, NO_WORK, MANUAL)
   * @returns {Promise<boolean>} 토글 성공 여부
   */
  async toggleIp(reason = 'MANUAL') {
    if (this.dongleInfo) {
      this.log(`🔄 IP 토글 요청 (dongle=${this.dongleNumber}, 사유: ${reason})...`);
      this.fileLogger.toggle(`토글: ${reason}`, {
        serverIp: this.dongleInfo.serverIp,
        dongleNumber: this.dongleNumber,
        reason
      });

      // 통계: 토글 카운트 및 사유
      this.stats.toggleCount++;
      if (this.stats.toggleReasons[reason] !== undefined) {
        this.stats.toggleReasons[reason]++;
      } else {
        this.stats.toggleReasons.MANUAL++;
      }

      const success = await this.dongleAllocator.toggle(this.dongleInfo.serverIp, this.dongleNumber);
      if (success) {
        this.log(`✅ IP 토글 완료`);
        this.fileLogger.info('IP 토글 완료');
      } else {
        this.fileLogger.warn('IP 토글 실패');
      }
      return success;
    }
    this.fileLogger.warn('toggleIp 호출됨 - 동글 정보 없음');
    return false;
  }

  /**
   * 동글 반납 (통계 포함)
   * @param {string} reason - 반납 사유
   */
  async releaseDongle(reason = '명시적 반납') {
    if (this.dongleInfo) {
      this.log('동글 반납 중...');
      this.fileLogger.dongleReleased(this.dongleInfo.id, reason);

      // 통계: 동글 반납
      this.stats.dongleReleases++;
      const lastDongleEntry = this.stats.dongleHistory[this.stats.dongleHistory.length - 1];
      if (lastDongleEntry && !lastDongleEntry.releasedAt) {
        lastDongleEntry.releasedAt = new Date();
        lastDongleEntry.duration = lastDongleEntry.releasedAt - lastDongleEntry.allocatedAt;
        lastDongleEntry.reason = reason;
      }
      this.stats.currentDongle = null;

      // 반납 시 전송할 통계 수집
      const releaseStats = {
        session_duration_ms: this.stats.timing.sessionStart
          ? Date.now() - this.stats.timing.sessionStart.getTime()
          : 0,
        toggle_count: this.stats.toggleCount,
        toggle_reasons: { ...this.stats.toggleReasons },
        connect_attempts: this.stats.connectAttempts,
        connect_successes: this.stats.connectSuccesses,
        avg_connect_time_ms: this.stats.connectSuccesses > 0
          ? Math.round(this.stats.timing.totalConnectTime / this.stats.connectSuccesses)
          : 0,
        release_reason: reason
      };

      await this.dongleAllocator.release(this.agentId, this.dongleInfo.id, releaseStats);
      this.dongleInfo = null;
    }
  }

  /**
   * 동글 연장 (heartbeat - 타임아웃 방지)
   */
  async heartbeat() {
    if (this.dongleInfo) {
      await this.dongleAllocator.heartbeat(this.dongleInfo.id);
      // heartbeat는 너무 자주 호출되므로 로깅 생략
    }
  }

  /**
   * VPN 공인 IP 확인
   * @returns {string|null} 공인 IP 또는 null
   */
  checkIp() {
    if (!this.namespace) return null;
    const ip = this.wgHelper.getPublicIp(this.namespace);
    if (!ip) {
      this.fileLogger.warn('checkIp 실패', { namespace: this.namespace });
    }
    return ip;
  }

  /**
   * 완전 정리 (동글 반납 + VPN 정리)
   * @param {boolean} printStats - 통계 출력 여부 (기본: true)
   */
  async cleanup(printStats = true) {
    // 세션 종료 시각 기록
    this.stats.timing.sessionEnd = new Date();
    this.fileLogger.info('cleanup 시작');

    // 동글 반납
    await this.releaseDongle('세션 종료');

    // VPN 정리
    if (this.connected && this.namespace && this.wgInterface) {
      this.wgHelper.cleanupNamespace(this.namespace, this.wgInterface);
      this.log('VPN 정리 완료');
      this.fileLogger.info('VPN 네임스페이스 정리 완료');
    }

    this.connected = false;

    // 최종 통계 출력
    if (printStats) {
      console.log('');
      console.log(this.getStatsSummary());
      console.log('');
    }

    // 파일 로거에 최종 통계 기록
    this.fileLogger.close({ reason: 'cleanup 완료', stats: this.getStats() });
  }

  /**
   * 연결 상태 확인
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  /**
   * 현재 VPN IP
   * @returns {string|null}
   */
  getVpnIp() {
    return this.vpnIp;
  }

  /**
   * 네임스페이스 이름
   * @returns {string|null}
   */
  getNamespace() {
    return this.namespace;
  }

  /**
   * 동글 번호
   * @returns {number|null}
   */
  getDongleNumber() {
    return this.dongleNumber;
  }

  /**
   * BatchAllocator 인스턴스
   * @returns {BatchAllocator|null}
   */
  getAllocator() {
    return this.allocator;
  }

  /**
   * VPN 통계 반환
   * @returns {Object} 통계 객체 (계산된 값 포함)
   */
  getStats() {
    const stats = { ...this.stats };

    // 계산된 값 추가
    const ipCheckDurations = stats.timing.ipCheckDurations;
    if (ipCheckDurations.length > 0) {
      const successfulChecks = ipCheckDurations.filter(d => d.success);
      const durations = successfulChecks.map(d => d.duration);

      stats.computed = {
        // 평균 연결 시간
        avgConnectTime: stats.connectSuccesses > 0
          ? Math.round(stats.timing.totalConnectTime / stats.connectSuccesses)
          : 0,

        // IP 체크 통계
        avgIpCheckTime: durations.length > 0
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : 0,
        minIpCheckTime: durations.length > 0 ? Math.min(...durations) : 0,
        maxIpCheckTime: durations.length > 0 ? Math.max(...durations) : 0,

        // 성공률
        connectSuccessRate: stats.connectAttempts > 0
          ? ((stats.connectSuccesses / stats.connectAttempts) * 100).toFixed(1)
          : '0.0',

        // 세션 시간
        sessionDuration: stats.timing.sessionStart
          ? Date.now() - stats.timing.sessionStart.getTime()
          : 0,

        // 평균 동글 사용 시간
        avgDongleUsageTime: this._calcAvgDongleUsage()
      };
    } else {
      stats.computed = {
        avgConnectTime: 0,
        avgIpCheckTime: 0,
        minIpCheckTime: 0,
        maxIpCheckTime: 0,
        connectSuccessRate: '0.0',
        sessionDuration: 0,
        avgDongleUsageTime: 0
      };
    }

    return stats;
  }

  /**
   * 평균 동글 사용 시간 계산 (내부용)
   */
  _calcAvgDongleUsage() {
    const completedDongles = this.stats.dongleHistory.filter(d => d.duration);
    if (completedDongles.length === 0) return 0;
    const totalDuration = completedDongles.reduce((sum, d) => sum + d.duration, 0);
    return Math.round(totalDuration / completedDongles.length);
  }

  /**
   * 통계 요약 문자열 반환
   * @returns {string}
   */
  getStatsSummary() {
    const s = this.getStats();
    const sessionMin = Math.round(s.computed.sessionDuration / 60000);

    const lines = [
      `═══ ${this.agentId} VPN 통계 ═══`,
      `⏱️  세션: ${sessionMin}분 | 연결: ${s.connectSuccesses}/${s.connectAttempts}회 (${s.computed.connectSuccessRate}%)`,
      `🔌 동글: 할당 ${s.dongleAllocations}회, 반납 ${s.dongleReleases}회`,
      `⏳ 연결시간: 평균 ${s.computed.avgConnectTime}ms, IP확인 평균 ${s.computed.avgIpCheckTime}ms`,
      `🔄 토글: ${s.toggleCount}회 (차단:${s.toggleReasons.BLOCKED} 예방:${s.toggleReasons.PREVENTIVE} 작업없음:${s.toggleReasons.NO_WORK} IP실패:${s.toggleReasons.IP_CHECK_FAILED})`,
    ];

    return lines.join('\n');
  }
}

module.exports = VpnManager;
