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

    try {
      this.log(`동글 할당 요청 중...${retryCount > 0 ? ` (재시도 ${retryCount}/${MAX_RETRIES})` : ''}`);
      this.fileLogger.info(`동글 할당 요청`, { retryCount, maxRetries: MAX_RETRIES });

      // 1. 서버에서 동글 할당받기
      this.dongleInfo = await this.dongleAllocator.allocate(this.agentId);
      if (!this.dongleInfo) {
        this.fileLogger.error('동글 할당 실패', { response: 'null' });
        throw new Error('동글 할당 실패');
      }

      this.dongleNumber = this.dongleInfo.dongleNumber;
      this.log(`동글 할당됨: dongle=${this.dongleNumber}, server=${this.dongleInfo.serverIp}`);
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

          // 동글 반납
          this.fileLogger.dongleReleased(this.dongleInfo.id, 'IP 확인 실패');
          await this.dongleAllocator.release(this.agentId, this.dongleInfo.id);
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

      // 연결 실패 시 동글 반납
      if (this.dongleInfo) {
        this.log(`연결 실패로 동글 반납: dongle=${this.dongleNumber}`);
        try {
          this.fileLogger.dongleReleased(this.dongleInfo.id, '연결 실패');
          await this.dongleAllocator.release(this.agentId, this.dongleInfo.id);
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

    // 2. 기존 동글 반납
    if (this.dongleInfo) {
      this.log(`기존 동글 반납: dongle=${this.dongleNumber}`);
      this.fileLogger.dongleReleased(this.dongleInfo.id, '재연결을 위한 반납');
      await this.dongleAllocator.release(this.agentId, this.dongleInfo.id);
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
   * @returns {Promise<boolean>} 토글 성공 여부
   */
  async toggleIp() {
    if (this.dongleInfo) {
      this.log(`🔄 IP 토글 요청 (dongle=${this.dongleNumber})...`);
      this.fileLogger.toggle('수동/정책 토글', {
        serverIp: this.dongleInfo.serverIp,
        dongleNumber: this.dongleNumber
      });
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
   * 동글 반납
   */
  async releaseDongle() {
    if (this.dongleInfo) {
      this.log('동글 반납 중...');
      this.fileLogger.dongleReleased(this.dongleInfo.id, '명시적 반납');
      await this.dongleAllocator.release(this.agentId, this.dongleInfo.id);
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
   */
  async cleanup() {
    this.fileLogger.info('cleanup 시작');

    // 동글 반납
    await this.releaseDongle();

    // VPN 정리
    if (this.connected && this.namespace && this.wgInterface) {
      this.wgHelper.cleanupNamespace(this.namespace, this.wgInterface);
      this.log('VPN 정리 완료');
      this.fileLogger.info('VPN 네임스페이스 정리 완료');
    }

    this.connected = false;
    this.fileLogger.close({ reason: 'cleanup 완료' });
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
}

module.exports = VpnManager;
