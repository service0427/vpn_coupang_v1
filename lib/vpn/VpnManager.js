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

class VpnManager {
  /**
   * @param {Object} options
   * @param {string} options.agentId - 에이전트 ID (예: "U22-01-01")
   * @param {DongleAllocator} options.dongleAllocator - 동글 할당자
   * @param {WireGuardHelper} options.wgHelper - WireGuard 헬퍼
   * @param {Function} options.logger - 로깅 함수 (agentId, msg)
   */
  constructor(options) {
    this.agentId = options.agentId;
    this.dongleAllocator = options.dongleAllocator;
    this.wgHelper = options.wgHelper;
    this.logger = options.logger || ((id, msg) => console.log(`[${id}] ${msg}`));

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

      // 1. 서버에서 동글 할당받기
      this.dongleInfo = await this.dongleAllocator.allocate(this.agentId);
      if (!this.dongleInfo) {
        throw new Error('동글 할당 실패');
      }

      this.dongleNumber = this.dongleInfo.dongleNumber;
      this.log(`동글 할당됨: dongle=${this.dongleNumber}, server=${this.dongleInfo.serverIp}`);

      // 2. 네임스페이스/인터페이스 이름 설정
      // 형식: {agentId}-{dongleId} (예: U22-01-05-031)
      const dongleIdStr = String(this.dongleInfo.id).padStart(3, '0');
      this.namespace = `${this.agentId}-${dongleIdStr}`;
      this.wgInterface = `wg-${this.dongleNumber}`;

      // 3. WireGuard 설정 생성
      const wgConfig = DongleAllocator.createWgConfig(this.dongleInfo);
      this.log(`WireGuard 설정: ${wgConfig.endpoint}, ${wgConfig.address}`);

      // 4. VPN 네임스페이스 설정
      this.wgHelper.setupNamespace(this.namespace, this.wgInterface, wgConfig, this.agentId);
      this.connected = true;

      // 4.5. WireGuard 핸드셰이크 안정화 대기 (1초)
      await new Promise(r => setTimeout(r, 1000));

      // 5. VPN 공인 IP 확인 (타임아웃 5초, 실패 시 VPN정리→토글→반납→재시도)
      this.log(`IP 확인 중... (타임아웃 5초)`);
      const ipCheckStart = Date.now();
      const vpnIp = this.wgHelper.getPublicIp(this.namespace, 5);
      const ipCheckElapsed = Date.now() - ipCheckStart;

      if (!vpnIp) {
        this.log(`❌ IP 확인 실패 (${ipCheckElapsed}ms) → VPN 정리 후 토글+반납`);

        // 1. 먼저 VPN 정리 (네임스페이스 삭제)
        this.wgHelper.cleanupNamespace(this.namespace, this.wgInterface);
        this.connected = false;

        // 네임스페이스 삭제 완료 대기
        await new Promise(r => setTimeout(r, 500));

        // 2. IP 토글 (백그라운드)
        this.dongleAllocator.toggle(this.dongleInfo.serverIp, this.dongleNumber);

        // 토글 요청 전송 후 잠시 대기
        await new Promise(r => setTimeout(r, 1000));

        // 3. 동글 반납
        await this.dongleAllocator.release(this.agentId, this.dongleInfo.id);
        this.dongleInfo = null;
        this.dongleNumber = null;

        // 재시도
        if (retryCount < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 2000));
          return this.connect(retryCount + 1);
        }
        throw new Error('IP 확인 실패 (최대 재시도 초과)');
      }

      this.vpnIp = vpnIp;
      this.log(`연결됨 - 공인 IP: ${vpnIp}`);

      // 6. BatchAllocator 초기화 (작업 할당용)
      const agentIp = getEthernetIp();
      this.allocator = new BatchAllocator({
        agentIp: agentIp,
        vpnId: `${this.dongleInfo.serverIp}_${this.dongleNumber}`,
        externalIp: vpnIp
      });
      this.log(`BatchAllocator 초기화 완료`);

      return true;
    } catch (err) {
      this.log(`연결 실패: ${err.message}`);

      // 연결 실패 시 동글 반납
      if (this.dongleInfo) {
        this.log(`연결 실패로 동글 반납: dongle=${this.dongleNumber}`);
        try {
          await this.dongleAllocator.release(this.agentId, this.dongleInfo.id);
        } catch (releaseErr) {
          this.log(`⚠️ 동글 반납 실패: ${releaseErr.message}`);
        }
        this.dongleInfo = null;
        this.dongleNumber = null;
      }

      // VPN 네임스페이스 정리
      if (this.namespace && this.wgInterface) {
        this.wgHelper.cleanupNamespace(this.namespace, this.wgInterface);
      }

      // 재시도
      if (retryCount < MAX_RETRIES) {
        const delay = 3000 + retryCount * 2000; // 3초, 5초, 7초
        this.log(`${delay/1000}초 후 재시도... (${retryCount + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        return this.connect(retryCount + 1);
      }

      return false;
    }
  }

  /**
   * VPN 재연결 (기존 정리 후 새로 연결)
   * @returns {Promise<boolean>} 연결 성공 여부
   */
  async reconnect() {
    this.log('VPN 재연결 중...');

    // 1. 기존 VPN 연결 정리
    if (this.namespace && this.wgInterface) {
      this.wgHelper.cleanupNamespace(this.namespace, this.wgInterface);
    }
    this.connected = false;

    // 2. 기존 동글 반납
    if (this.dongleInfo) {
      this.log(`기존 동글 반납: dongle=${this.dongleNumber}`);
      await this.dongleAllocator.release(this.agentId, this.dongleInfo.id);
      this.dongleInfo = null;
      this.dongleNumber = null;
    }

    // 3. 짧은 대기
    await new Promise(r => setTimeout(r, 500));

    // 4. connect() 호출 (토글+재시도 로직 포함)
    const result = await this.connect();

    // 5. BatchAllocator 업데이트 (connect 성공 시)
    if (result && this.allocator && this.vpnIp) {
      this.allocator.setExternalIp(this.vpnIp);
      this.allocator.setVpnId(`${this.dongleInfo.serverIp}_${this.dongleNumber}`);
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
      const success = await this.dongleAllocator.toggle(this.dongleInfo.serverIp, this.dongleNumber);
      if (success) {
        this.log(`✅ IP 토글 완료`);
      }
      return success;
    }
    return false;
  }

  /**
   * 동글 반납
   */
  async releaseDongle() {
    if (this.dongleInfo) {
      this.log('동글 반납 중...');
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
    }
  }

  /**
   * VPN 공인 IP 확인
   * @returns {string|null} 공인 IP 또는 null
   */
  checkIp() {
    if (!this.namespace) return null;
    return this.wgHelper.getPublicIp(this.namespace);
  }

  /**
   * 완전 정리 (동글 반납 + VPN 정리)
   */
  async cleanup() {
    // 동글 반납
    await this.releaseDongle();

    // VPN 정리
    if (this.connected && this.namespace && this.wgInterface) {
      this.wgHelper.cleanupNamespace(this.namespace, this.wgInterface);
      this.log('VPN 정리 완료');
    }

    this.connected = false;
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
