/**
 * WireGuardHelper - WireGuard 및 네트워크 네임스페이스 관리
 *
 * 책임:
 * - 네임스페이스 생성/삭제
 * - WireGuard 인터페이스 설정
 * - 공인 IP 확인
 * - 시스템 명령어 실행 캡슐화
 *
 * 사용법:
 *   const helper = new WireGuardHelper();
 *   helper.setupNamespace(namespace, wgInterface, config, agentId);
 *   helper.cleanupNamespace(namespace, wgInterface);
 *   helper.getPublicIp(namespace);
 */

const { execSync } = require('child_process');
const fs = require('fs');

class WireGuardHelper {
  /**
   * @param {Object} options
   * @param {boolean} options.debug - 디버그 로그 활성화
   * @param {Function} options.logger - 로그 출력 함수 (agentId, msg) => void
   */
  constructor(options = {}) {
    this.debug = options.debug || false;
    this.logger = options.logger || null;
  }

  /**
   * 디버그 로그 출력
   * @private
   */
  _log(agentId, msg) {
    if (this.debug && this.logger) {
      this.logger(agentId, `  [wg] ${msg}`);
    }
  }

  /**
   * VPN 네임스페이스 생성 및 WireGuard 설정
   *
   * @param {string} namespace - 네임스페이스 이름 (예: U22-01-05-031)
   * @param {string} wgInterface - WireGuard 인터페이스 이름 (예: wg-16)
   * @param {Object} config - WireGuard 설정
   * @param {string} config.privateKey - 클라이언트 비밀키
   * @param {string} config.publicKey - 서버 공개키
   * @param {string} config.endpoint - 서버 엔드포인트 (IP:포트)
   * @param {string} config.address - 클라이언트 IP/서브넷 (예: 10.0.16.2/24)
   * @param {string} agentId - 로깅용 에이전트 ID
   */
  setupNamespace(namespace, wgInterface, config, agentId) {
    const step = (msg) => this._log(agentId, msg);

    try {
      // 기존 정리 (철저하게)
      step('기존 네임스페이스 정리...');

      // 1. 네임스페이스가 존재하면 내부 wg 인터페이스 먼저 삭제
      try {
        const nsExists = execSync(`ip netns list 2>/dev/null | grep -q "^${namespace}" && echo yes || echo no`, {
          encoding: 'utf8'
        }).trim();
        if (nsExists === 'yes') {
          // 네임스페이스 내의 모든 wg 인터페이스 삭제
          const nsLinks = execSync(`ip -n ${namespace} link show 2>/dev/null || true`, { encoding: 'utf8' });
          const wgInNs = nsLinks.match(/wg-\d+/g) || [];
          for (const wg of wgInNs) {
            execSync(`ip -n ${namespace} link del ${wg} 2>/dev/null || true`, { stdio: 'pipe' });
          }
        }
      } catch (e) { /* 무시 */ }

      // 2. 네임스페이스 삭제
      execSync(`ip netns del ${namespace} 2>/dev/null || true`, { stdio: 'pipe' });

      // 3. 새로 만들 wgInterface가 메인에 있으면 삭제
      execSync(`ip link del ${wgInterface} 2>/dev/null || true`, { stdio: 'pipe' });

      // 네임스페이스 생성
      step('네임스페이스 생성...');
      execSync(`ip netns add ${namespace}`);
      execSync(`ip netns exec ${namespace} ip link set lo up`);

      // WireGuard 인터페이스 생성
      step(`WireGuard 인터페이스 생성: ${wgInterface}`);
      execSync(`ip link add ${wgInterface} type wireguard`);
      execSync(`ip link set ${wgInterface} netns ${namespace}`);

      // WireGuard 설정 파일 생성
      step('WireGuard 설정 적용...');
      const tempConf = `/tmp/wg-${namespace}.conf`;
      const wgConfig = `[Interface]
PrivateKey = ${config.privateKey}

[Peer]
PublicKey = ${config.publicKey}
Endpoint = ${config.endpoint}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
`;
      fs.writeFileSync(tempConf, wgConfig);

      // WireGuard 설정 적용
      execSync(`ip netns exec ${namespace} wg setconf ${wgInterface} ${tempConf}`);
      fs.unlinkSync(tempConf);

      // IP 할당 및 활성화
      step(`IP 할당: ${config.address}`);
      execSync(`ip netns exec ${namespace} ip addr add ${config.address} dev ${wgInterface}`);
      execSync(`ip netns exec ${namespace} ip link set ${wgInterface} up`);

      // 라우팅 설정
      step('라우팅 설정...');
      execSync(`ip netns exec ${namespace} ip route add default dev ${wgInterface}`);

      // DNS 설정
      step('DNS 설정...');
      const dnsDir = `/etc/netns/${namespace}`;
      if (!fs.existsSync(dnsDir)) {
        fs.mkdirSync(dnsDir, { recursive: true });
      }
      fs.writeFileSync(`${dnsDir}/resolv.conf`, 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n');

      step('설정 완료 ✓');
    } catch (error) {
      // 에러 발생 시 정리
      try {
        execSync(`ip link del ${wgInterface} 2>/dev/null || true`, { stdio: 'pipe' });
        execSync(`ip netns del ${namespace} 2>/dev/null || true`, { stdio: 'pipe' });
      } catch (e) { /* 무시 */ }
      throw error;
    }
  }

  /**
   * 개별 네임스페이스 정리
   *
   * @param {string} namespace - 네임스페이스 이름
   * @param {string} wgInterface - WireGuard 인터페이스 이름
   */
  cleanupNamespace(namespace, wgInterface) {
    try {
      // 1. 네임스페이스 내 프로세스 강제 종료
      try {
        const pids = execSync(`ip netns pids ${namespace} 2>/dev/null || true`, { encoding: 'utf8' })
          .trim().split('\n').filter(p => p.trim());
        for (const pid of pids) {
          execSync(`kill -9 ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
        }
      } catch (e) { /* 무시 */ }

      // 2. 네임스페이스 내 모든 wg 인터페이스 삭제
      try {
        const nsInterfaces = execSync(`ip -n ${namespace} link show 2>/dev/null || true`, { encoding: 'utf8' });
        const wgInNs = nsInterfaces.match(/wg-\d+/g) || [];
        for (const wg of wgInNs) {
          execSync(`ip -n ${namespace} link del ${wg} 2>/dev/null || true`, { stdio: 'pipe' });
        }
      } catch (e) { /* 무시 */ }

      // 3. 특정 인터페이스도 삭제 시도
      execSync(`ip -n ${namespace} link del ${wgInterface} 2>/dev/null || true`, { stdio: 'pipe' });

      // 4. 네임스페이스 삭제
      execSync(`ip netns del ${namespace} 2>/dev/null || true`, { stdio: 'pipe' });

      // 5. DNS 설정 파일 정리
      const dnsDir = `/etc/netns/${namespace}`;
      if (fs.existsSync(dnsDir)) {
        fs.rmSync(dnsDir, { recursive: true, force: true });
      }

      // 6. 전역 wg 인터페이스도 삭제 (혹시 남아있으면)
      execSync(`ip link del ${wgInterface} 2>/dev/null || true`, { stdio: 'pipe' });
    } catch (e) { /* 무시 */ }
  }

  /**
   * 호스트 관련 모든 VPN 네임스페이스 정리
   *
   * @param {string} hostnamePrefix - 호스트명 접두사 (예: U22-01)
   * @param {Object} options
   * @param {Function} options.log - 일반 로그 함수
   * @param {Function} options.warn - 경고 로그 함수
   * @returns {number} 정리된 네임스페이스 수
   */
  cleanupAllNamespaces(hostnamePrefix, options = {}) {
    const log = options.log || console.log;
    const warn = options.warn || console.warn;
    let cleanedCount = 0;

    try {
      // 0. VPN 관련 모든 프로세스 먼저 종료 (네임스페이스 삭제 전 필수!)
      try {
        // 새 형식: U22-XX-XX-XXX (호스트네임 기반)
        execSync(`pkill -9 -f "ip netns exec ${hostnamePrefix}" 2>/dev/null || true`, { stdio: 'pipe' });
        // 기존 형식도 정리: vpn-
        execSync('pkill -9 -f "ip netns exec vpn-" 2>/dev/null || true', { stdio: 'pipe' });
        // Chrome 프로세스 종료
        execSync('pkill -9 -f "browser-data/vpn_" 2>/dev/null || true', { stdio: 'pipe' });
        // 잠시 대기 (프로세스 종료 완료 대기)
        execSync('sleep 0.5', { stdio: 'pipe' });
      } catch (e) { /* 무시 */ }

      // 1. 모든 wg- 인터페이스 삭제 (네임스페이스 밖에 있는 것들)
      try {
        const interfaces = execSync('ip link show 2>/dev/null || true', { encoding: 'utf8' });
        const wgInterfaces = interfaces.match(/wg-\d+/g) || [];
        for (const wg of wgInterfaces) {
          execSync(`ip link del ${wg} 2>/dev/null || true`, { stdio: 'pipe' });
        }
        if (wgInterfaces.length > 0) {
          log(`  ├─ 전역 wg 인터페이스 ${wgInterfaces.length}개 삭제`);
        }
      } catch (e) { /* 무시 */ }

      // 2. 현재 존재하는 모든 VPN 네임스페이스 찾기
      // 새 형식: U22-XX-XX-XXX (호스트네임으로 시작)
      // 기존 형식: vpn-U22-XX-XX
      const nsList = execSync('ip netns list 2>/dev/null || true', { encoding: 'utf8' });
      const namespaces = nsList
        .split('\n')
        .filter(ns => {
          const name = ns.trim();
          return name.startsWith(hostnamePrefix) || name.startsWith('vpn-');
        })
        .map(ns => ns.split(' ')[0].trim())
        .filter(ns => ns.length > 0);

      if (namespaces.length === 0) {
        return 0;
      }

      log(`  ├─ ${namespaces.length}개 네임스페이스 발견: ${namespaces.join(', ')}`);

      for (const ns of namespaces) {
        try {
          // 네임스페이스 내의 모든 인터페이스 삭제
          try {
            const nsInterfaces = execSync(`ip -n ${ns} link show 2>/dev/null || true`, { encoding: 'utf8' });
            const wgInNs = nsInterfaces.match(/wg-\d+/g) || [];
            for (const wg of wgInNs) {
              execSync(`ip -n ${ns} link del ${wg} 2>/dev/null || true`, { stdio: 'pipe' });
            }
          } catch (e) { /* 무시 */ }

          // 네임스페이스 내 프로세스 강제 종료 (SIGKILL)
          try {
            const pids = execSync(`ip netns pids ${ns} 2>/dev/null || true`, { encoding: 'utf8' })
              .trim().split('\n').filter(p => p.trim());
            for (const pid of pids) {
              execSync(`kill -9 ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
            }
          } catch (e) { /* 무시 */ }

          // 네임스페이스 삭제 (강제)
          execSync(`ip netns del ${ns}`, { stdio: 'pipe' });

          // DNS 설정 파일 정리
          const dnsDir = `/etc/netns/${ns}`;
          if (fs.existsSync(dnsDir)) {
            fs.rmSync(dnsDir, { recursive: true, force: true });
          }

          cleanedCount++;
        } catch (e) {
          warn(`  ├─ ⚠️ ${ns} 삭제 실패: ${e.message}`);
        }
      }

      // 3. 삭제 확인
      const remaining = execSync('ip netns list 2>/dev/null || true', { encoding: 'utf8' })
        .split('\n')
        .filter(ns => {
          const name = ns.trim();
          return name.startsWith(hostnamePrefix) || name.startsWith('vpn-');
        })
        .map(ns => ns.split(' ')[0].trim())
        .filter(ns => ns.length > 0);

      if (remaining.length > 0) {
        warn(`  └─ ⚠️ 삭제 실패한 네임스페이스: ${remaining.join(', ')}`);
      }
    } catch (e) {
      warn(`정리 중 오류: ${e.message}`);
    }

    return cleanedCount;
  }

  /**
   * VPN 네임스페이스 내에서 공인 IP 확인
   *
   * @param {string} namespace - 네임스페이스 이름
   * @param {number} timeout - 타임아웃 (초, 기본: 10)
   * @returns {string|null} 공인 IP 또는 null
   */
  getPublicIp(namespace, timeout = 5) {
    const startTime = Date.now();
    try {
      const ip = execSync(`ip netns exec ${namespace} curl -s --connect-timeout ${timeout} --max-time ${timeout} https://api.ipify.org`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: (timeout + 2) * 1000  // execSync 타임아웃 (curl보다 2초 여유)
      }).trim();
      const elapsed = Date.now() - startTime;
      if (this.debug) {
        console.log(`[WireGuardHelper] IP 확인 성공: ${ip} (${elapsed}ms)`);
      }
      return ip || null;
    } catch (e) {
      const elapsed = Date.now() - startTime;
      if (this.debug) {
        console.log(`[WireGuardHelper] IP 확인 실패 (${elapsed}ms): ${e.message?.substring(0, 50) || 'timeout'}`);
      }
      return null;
    }
  }

  /**
   * 네임스페이스 존재 여부 확인
   *
   * @param {string} namespace - 네임스페이스 이름
   * @returns {boolean}
   */
  namespaceExists(namespace) {
    try {
      const result = execSync(`ip netns list 2>/dev/null | grep -q "^${namespace}" && echo yes || echo no`, {
        encoding: 'utf8'
      }).trim();
      return result === 'yes';
    } catch (e) {
      return false;
    }
  }

  /**
   * 현재 네임스페이스 목록 조회
   *
   * @param {string} prefix - 필터링할 접두사 (선택)
   * @returns {string[]} 네임스페이스 이름 배열
   */
  getNamespaceList(prefix = null) {
    try {
      const nsList = execSync('ip netns list 2>/dev/null || true', { encoding: 'utf8' });
      let namespaces = nsList
        .split('\n')
        .map(ns => ns.split(' ')[0].trim())
        .filter(ns => ns.length > 0);

      if (prefix) {
        namespaces = namespaces.filter(ns => ns.startsWith(prefix));
      }

      return namespaces;
    } catch (e) {
      return [];
    }
  }
}

module.exports = WireGuardHelper;
