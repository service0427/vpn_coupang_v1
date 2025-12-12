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
 * 스코어링 시스템:
 * - 성공/실패: +1점
 * - 차단: -1점
 * - 스코어 < 2 이면 IP 토글
 *
 * 사용법:
 *   sudo node index-vpn-multi.js [옵션]
 *
 * 옵션:
 *   --vpn-count <n>  VPN 개수 (1~10, 기본: 10)
 *   --threads <n>    VPN당 쓰레드 수 (1~5, 기본: 5)
 *   --once           1회만 실행 후 종료
 *   --help           도움말 표시
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// API 클라이언트 import
const { BatchAllocator, DongleAllocator, getEthernetIp } = require('./lib/modules/api-service');

// 설정
const DEFAULT_VPN_COUNT = 10;  // 기본 VPN 개수
const DEFAULT_THREADS_PER_VPN = 8;  // VPN당 8쓰레드
// hostname에서 "tech-" prefix 제거 (tech-U22-03 → U22-03)
const HOSTNAME = os.hostname().replace(/^tech-/i, '');  // 예: "U22-03"

// 전역 디버그 모드 (--debug 옵션으로 활성화)
let DEBUG_MODE = false;

// 색상 출력
const colors = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
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

// 타임스탬프 생성 (밀리초 3자리 포함)
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

// VPN 인스턴스별 로그 (agentId 기반)
const vpnLog = (agentId, msg) => {
  // agentId에서 인덱스 추출 (예: "U22-01-03" -> 3)
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
    debug: false,  // 디버그 모드: child process 로그 실시간 출력
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--debug') options.debug = true;
    else if (arg.startsWith('--vpn-count=')) options.vpnCount = parseInt(arg.split('=')[1]);
    else if (arg === '--vpn-count' && args[i + 1]) options.vpnCount = parseInt(args[++i]);
    else if (arg.startsWith('--threads=')) options.threadsPerVpn = parseInt(arg.split('=')[1]);
    else if (arg === '--threads' && args[i + 1]) options.threadsPerVpn = parseInt(args[++i]);
  }

  // 유효성 검사
  options.vpnCount = Math.max(1, Math.min(10, options.vpnCount || DEFAULT_VPN_COUNT));
  options.threadsPerVpn = Math.max(1, Math.min(8, options.threadsPerVpn || DEFAULT_THREADS_PER_VPN));

  return options;
}

function printHelp() {
  console.log(`
🌐 멀티 VPN 동시 실행 모드 - 쿠팡 Chrome 자동화

agent_id 형식: ${HOSTNAME}-{순번}
  예: ${HOSTNAME}-01, ${HOSTNAME}-02, ...

동글 할당: 서버에서 동적으로 할당 (/dongle/allocate)
동글 반납: 종료 시 자동 반납 (/dongle/release)

사용법:
  sudo node index-vpn-multi.js [옵션]

옵션:
  --vpn-count <n>  VPN 개수 (1~10, 기본: ${DEFAULT_VPN_COUNT})
  --threads <n>    VPN당 쓰레드 수 (1~8, 기본: ${DEFAULT_THREADS_PER_VPN})
  --once           1회만 실행 후 종료
  --debug          디버그 모드 (child process 로그 실시간 출력)
  --help           도움말 표시

예시:
  sudo node index-vpn-multi.js                     # 10 VPN × 5쓰레드 = 50쓰레드
  sudo node index-vpn-multi.js --vpn-count=5       # 5 VPN × 5쓰레드 = 25쓰레드
  sudo node index-vpn-multi.js --threads=3         # 10 VPN × 3쓰레드 = 30쓰레드
  sudo node index-vpn-multi.js --once              # 1회 실행

스코어링:
  - 성공/실패: +1점
  - 차단: -1점
  - 스코어 < 2 이면 IP 토글
`);
}

// 싱글톤 DongleAllocator 인스턴스
const dongleAllocator = new DongleAllocator();

// agent_id 생성 헬퍼
function createAgentId(vpnIndex) {
  // vpnIndex: 1~10 → "U22-01-01", "U22-01-02", ...
  return `${HOSTNAME}-${String(vpnIndex).padStart(2, '0')}`;
}

// VPN 네임스페이스 생성 및 연결 (새 API 기반)
function setupVpnNamespace(namespace, wgInterface, config, agentId) {
  const step = (msg) => DEBUG_MODE && vpnLog(agentId, `  [setup] ${msg}`);

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
    } catch (e) {}

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
    vpnLog(agentId, `❌ 네임스페이스 설정 실패: ${error.message}`);
    // 정리
    try {
      execSync(`ip link del ${wgInterface} 2>/dev/null || true`, { stdio: 'pipe' });
      execSync(`ip netns del ${namespace} 2>/dev/null || true`, { stdio: 'pipe' });
    } catch (e) {}
    throw error;
  }
}

// VPN 공인 IP 확인 (단순 버전 - 블로킹 없음)
function getVpnPublicIp(namespace) {
  try {
    const ip = execSync(`ip netns exec ${namespace} curl -s --max-time 10 https://api.ipify.org`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return ip;
  } catch (e) {
    return null;
  }
}

// VPN 정리 (개별 네임스페이스)
function cleanupVpn(namespace, wgInterface) {
  try {
    // 1. 네임스페이스 내 프로세스 강제 종료
    try {
      const pids = execSync(`ip netns pids ${namespace} 2>/dev/null || true`, { encoding: 'utf8' })
        .trim().split('\n').filter(p => p.trim());
      for (const pid of pids) {
        execSync(`kill -9 ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
      }
    } catch (e) {}

    // 2. 네임스페이스 내 모든 wg 인터페이스 삭제
    try {
      const nsInterfaces = execSync(`ip -n ${namespace} link show 2>/dev/null || true`, { encoding: 'utf8' });
      const wgInNs = nsInterfaces.match(/wg-\d+/g) || [];
      for (const wg of wgInNs) {
        execSync(`ip -n ${namespace} link del ${wg} 2>/dev/null || true`, { stdio: 'pipe' });
      }
    } catch (e) {}

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
  } catch (e) {}
}

// 활성 VPN 인스턴스 추적 (정리용)
let activeVpnInstances = [];

// 모든 VPN 네임스페이스 정리 (프로그램 시작/종료 시)
function cleanupAllVpns() {
  log('🧹 기존 VPN 정리 시작...');
  let cleanedCount = 0;

  try {
    // 0. VPN 관련 모든 프로세스 먼저 종료 (네임스페이스 삭제 전 필수!)
    try {
      // VPN 네임스페이스 내에서 실행 중인 모든 프로세스 종료
      // 새 형식: U22-XX-XX-XXX (호스트네임 기반)
      execSync(`pkill -9 -f "ip netns exec ${HOSTNAME}" 2>/dev/null || true`, { stdio: 'pipe' });
      // 기존 형식도 정리: vpn-
      execSync('pkill -9 -f "ip netns exec vpn-" 2>/dev/null || true', { stdio: 'pipe' });
      // Chrome 프로세스 종료
      execSync('pkill -9 -f "browser-data/vpn_" 2>/dev/null || true', { stdio: 'pipe' });
      // 잠시 대기 (프로세스 종료 완료 대기)
      execSync('sleep 0.5', { stdio: 'pipe' });
    } catch (e) {}

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
    } catch (e) {}

    // 2. 현재 존재하는 모든 VPN 네임스페이스 찾기
    // 새 형식: U22-XX-XX-XXX (호스트네임으로 시작)
    // 기존 형식: vpn-U22-XX-XX
    const nsList = execSync('ip netns list 2>/dev/null || true', { encoding: 'utf8' });
    const namespaces = nsList
      .split('\n')
      .filter(ns => {
        const name = ns.trim();
        return name.startsWith(HOSTNAME) || name.startsWith('vpn-');
      })
      .map(ns => ns.split(' ')[0].trim())
      .filter(ns => ns.length > 0);

    if (namespaces.length === 0) {
      log('🧹 기존 VPN 없음 - 정리 완료');
      return;
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
        } catch (e) {}

        // 네임스페이스 내 프로세스 강제 종료 (SIGKILL)
        try {
          const pids = execSync(`ip netns pids ${ns} 2>/dev/null || true`, { encoding: 'utf8' })
            .trim().split('\n').filter(p => p.trim());
          for (const pid of pids) {
            execSync(`kill -9 ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
          }
        } catch (e) {}

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
        return name.startsWith(HOSTNAME) || name.startsWith('vpn-');
      })
      .map(ns => ns.split(' ')[0].trim())
      .filter(ns => ns.length > 0);

    if (remaining.length > 0) {
      warn(`  └─ ⚠️ 삭제 실패한 네임스페이스: ${remaining.join(', ')}`);
    } else {
      log(`🧹 기존 VPN 정리 완료 (${cleanedCount}개 삭제됨)`);
    }
  } catch (e) {
    warn(`🧹 기존 VPN 정리 중 오류: ${e.message}`);
  }
}

// 공유 로그 디렉토리 (모든 VPN이 같은 디렉토리 사용)
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

// VPN 인스턴스 관리 클래스 (독립 운영 - DongleAllocator 기반)
class VpnInstance {
  constructor(vpnIndex, threadsPerVpn, onceMode) {
    this.vpnIndex = vpnIndex;  // VPN 순번 (1~10)
    this.agentId = createAgentId(vpnIndex);  // 예: "U22-01-01"
    this.maxThreads = threadsPerVpn;
    this.onceMode = onceMode;

    // 동글 정보 (connect 시 할당받음)
    this.dongleInfo = null;  // { id, dongleNumber, serverIp, privateKey, publicKey }
    this.dongleNumber = null;

    // 네임스페이스/인터페이스 (동글 할당 후 설정)
    this.namespace = null;
    this.wgInterface = null;

    this.connected = false;
    this.vpnIp = null;
    this.process = null;
    this.score = 0;
    this.stats = { success: 0, fail: 0, blocked: 0 };
    this.totalStats = { success: 0, fail: 0, blocked: 0, toggleCount: 0, runCount: 0, taskCount: 0 };
    this.running = false;
    this.shouldStop = false;

    // 토글 이후 성공 카운터 (50회 이상이면 예방적 토글)
    this.successSinceToggle = 0;

    // 연속 작업없음 카운터 (3회 이상이면 반납+재할당)
    this.noWorkCount = 0;

    // BatchAllocator (작업 할당용)
    this.allocator = null;
  }

  async connect(retryCount = 0) {
    const MAX_RETRIES = 3;

    try {
      vpnLog(this.agentId, `동글 할당 요청 중...${retryCount > 0 ? ` (재시도 ${retryCount}/${MAX_RETRIES})` : ''}`);

      // 1. 서버에서 동글 할당받기
      this.dongleInfo = await dongleAllocator.allocate(this.agentId);
      if (!this.dongleInfo) {
        throw new Error('동글 할당 실패');
      }

      this.dongleNumber = this.dongleInfo.dongleNumber;
      vpnLog(this.agentId, `동글 할당됨: dongle=${this.dongleNumber}, server=${this.dongleInfo.serverIp}`);

      // 2. 네임스페이스/인터페이스 이름 설정
      // 형식: {agentId}-{dongleId} (예: U22-01-05-031)
      // dongleId = 할당 ID (고유값), dongleNumber = 동글 번호 (중복 가능)
      // ip netns list로 어떤 에이전트가 어떤 동글 할당을 쓰는지 바로 확인 가능
      const dongleIdStr = String(this.dongleInfo.id).padStart(3, '0');
      this.namespace = `${this.agentId}-${dongleIdStr}`;
      this.wgInterface = `wg-${this.dongleNumber}`;

      // 3. WireGuard 설정 생성
      const wgConfig = DongleAllocator.createWgConfig(this.dongleInfo);
      vpnLog(this.agentId, `WireGuard 설정: ${wgConfig.endpoint}, ${wgConfig.address}`);

      // 4. VPN 네임스페이스 설정
      setupVpnNamespace(this.namespace, this.wgInterface, wgConfig, this.agentId);
      this.connected = true;

      // 5. VPN 공인 IP 확인 (필수! 실패 시 토글+반납+재시도)
      const vpnIp = getVpnPublicIp(this.namespace);
      if (!vpnIp) {
        vpnLog(this.agentId, `❌ IP 확인 실패 → 토글 후 재시도`);

        // IP 토글
        await dongleAllocator.toggle(this.dongleInfo.serverIp, this.dongleNumber);

        // VPN 정리 및 동글 반납
        cleanupVpn(this.namespace, this.wgInterface);
        await dongleAllocator.release(this.agentId, this.dongleInfo.id);
        this.dongleInfo = null;
        this.dongleNumber = null;
        this.connected = false;

        // 재시도
        if (retryCount < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 2000));
          return this.connect(retryCount + 1);
        }
        throw new Error('IP 확인 실패 (최대 재시도 초과)');
      }

      this.vpnIp = vpnIp;
      vpnLog(this.agentId, `연결됨 - 공인 IP: ${vpnIp}`);

      // 6. BatchAllocator 초기화 (작업 할당용)
      const agentIp = getEthernetIp();
      this.allocator = new BatchAllocator({
        agentIp: agentIp,
        vpnId: `${this.dongleInfo.serverIp}_${this.dongleNumber}`,
        externalIp: vpnIp
      });
      vpnLog(this.agentId, `BatchAllocator 초기화 완료`);

      return true;
    } catch (err) {
      vpnLog(this.agentId, `연결 실패: ${err.message}`);

      // 연결 실패 시 동글 반납
      if (this.dongleInfo) {
        vpnLog(this.agentId, `연결 실패로 동글 반납: dongle=${this.dongleNumber}`);
        try {
          await dongleAllocator.release(this.agentId, this.dongleInfo.id);
        } catch (releaseErr) {
          vpnLog(this.agentId, `⚠️ 동글 반납 실패: ${releaseErr.message}`);
        }
        this.dongleInfo = null;
        this.dongleNumber = null;
      }

      // VPN 네임스페이스 정리
      if (this.namespace && this.wgInterface) {
        cleanupVpn(this.namespace, this.wgInterface);
      }

      // 재시도 (catch에서도 재시도 허용)
      if (retryCount < MAX_RETRIES) {
        const delay = 3000 + retryCount * 2000; // 3초, 5초, 7초
        vpnLog(this.agentId, `${delay/1000}초 후 재시도... (${retryCount + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        return this.connect(retryCount + 1);
      }

      return false;
    }
  }

  // VPN 재연결 (기존 정리 후 connect() 재사용)
  async reconnect() {
    vpnLog(this.agentId, 'VPN 재연결 중...');

    // 1. 기존 VPN 연결 정리
    if (this.namespace && this.wgInterface) {
      cleanupVpn(this.namespace, this.wgInterface);
    }
    this.connected = false;

    // 2. 기존 동글 반납
    if (this.dongleInfo) {
      vpnLog(this.agentId, `기존 동글 반납: dongle=${this.dongleNumber}`);
      await dongleAllocator.release(this.agentId, this.dongleInfo.id);
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

  // 동글 반납
  async releaseDongle() {
    if (this.dongleInfo) {
      vpnLog(this.agentId, '동글 반납 중...');
      await dongleAllocator.release(this.agentId, this.dongleInfo.id);
      this.dongleInfo = null;
    }
  }

  // 동글 연장 (heartbeat - 타임아웃 방지)
  async heartbeat() {
    if (this.dongleInfo) {
      await dongleAllocator.heartbeat(this.dongleInfo.id);
    }
  }

  // IP 토글 요청 (토글 후 반납 → 재할당 필요)
  async toggleIp() {
    if (this.dongleInfo) {
      vpnLog(this.agentId, `🔄 IP 토글 요청 (dongle=${this.dongleNumber})...`);
      // GET http://{serverIp}/toggle/{dongleNumber}
      const success = await dongleAllocator.toggle(this.dongleInfo.serverIp, this.dongleNumber);
      if (success) {
        vpnLog(this.agentId, `✅ IP 토글 완료`);
      }
      return success;
    }
    return false;
  }

  /**
   * 단일 작업을 자식 프로세스로 실행 (네임스페이스 격리)
   * @param {Object} task - 할당된 작업
   * @param {number} threadNum - 쓰레드 번호
   *
   * 최대 실행 시간: 120초 (하드 타임아웃)
   * - 120초 초과 시 무조건 TIMEOUT 오류로 처리
   * - 프로세스 강제 종료 및 좀비 정리
   */
  async executeTaskInNamespace(task, threadNum) {
    const TASK_TIMEOUT = 120000;  // 120초 하드 타임아웃
    const startTime = Date.now();
    const allocationKey = task.allocation_key;
    const keywordShort = task.keyword.length > 20 ? task.keyword.substring(0, 20) + '...' : task.keyword;

    vpnLog(this.agentId, `[T${threadNum}] 작업 시작: ${keywordShort} (${task.product_id})`);

    return new Promise((resolve) => {
      // 단일 작업용 스크립트 실행
      const scriptPath = path.join(__dirname, 'lib', 'core', 'single-task-runner.js');

      // 작업 데이터를 환경변수로 전달
      const taskEnv = {
        ...process.env,
        VPN_NAMESPACE: this.namespace,
        VPN_MODE: 'true',
        VPN_DONGLE: String(this.dongleNumber),
        VPN_INDEX: String(this.vpnIndex),  // VPN 순번 (1~10) - 창 위치 계산용
        VPN_IP: this.vpnIp || '',  // VPN 공인 IP
        AGENT_ID: this.agentId,
        TASK_ALLOCATION_KEY: task.allocation_key,
        TASK_KEYWORD: task.keyword,
        TASK_PRODUCT_ID: task.product_id || '',
        TASK_ITEM_ID: task.item_id || '',
        TASK_VENDOR_ITEM_ID: task.vendor_item_id || '',
        TASK_WORK_TYPE: task.work_type || 'click',
        THREAD_NUMBER: String(threadNum),
        DISPLAY: ':0',
        HOME: '/home/tech',
        USER: 'tech',
        XAUTHORITY: '/home/tech/.Xauthority',
      };

      // VPN 네임스페이스 내에서 node 실행
      const cmd = 'ip';
      const cmdArgs = ['netns', 'exec', this.namespace, 'node', scriptPath];

      const proc = spawn(cmd, cmdArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: taskEnv
      });

      let stdout = '';
      let stderr = '';
      let isTimedOut = false;
      let isResolved = false;

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        // 디버그 모드: 실시간 출력 (__RESULT__: 마커는 제외)
        if (DEBUG_MODE) {
          text.split('\n').filter(l => l.trim() && !l.startsWith('__RESULT__:')).forEach(line => {
            vpnLog(this.agentId, `[T${threadNum}] ${line}`);
          });
        }
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        // 디버그 모드: 실시간 에러 출력
        if (DEBUG_MODE) {
          text.split('\n').filter(l => l.trim()).forEach(line => {
            vpnLog(this.agentId, `[T${threadNum}] ⚠️ ${line}`);
          });
        }
      });

      // 120초 하드 타임아웃 처리
      const timeoutId = setTimeout(() => {
        if (isResolved) return;
        isTimedOut = true;
        const elapsed = Date.now() - startTime;
        vpnLog(this.agentId, `[T${threadNum}] ⏰ 하드 타임아웃 (120초 초과) - 강제 종료`);

        // 프로세스 강제 종료
        try {
          proc.kill('SIGKILL');
        } catch (e) {}

        // 좀비 Chrome 프로세스 정리
        try {
          const profilePath = `vpn_${this.dongleNumber}`;
          execSync(`pkill -9 -f "${profilePath}" 2>/dev/null || true`);
        } catch (e) {}

        isResolved = true;
        resolve({
          success: false,
          blocked: false,
          allocationKey,
          elapsed,
          errorType: 'TIMEOUT',
          errorMessage: `작업 시간 초과 (120초)`
        });
      }, TASK_TIMEOUT);

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        if (isResolved) return;  // 이미 타임아웃으로 처리됨
        isResolved = true;

        const elapsed = Date.now() - startTime;

        // 타임아웃으로 종료된 경우 (code가 null일 때)
        if (isTimedOut || code === null) {
          vpnLog(this.agentId, `[T${threadNum}] ⏰ 타임아웃 종료 (${elapsed}ms)`);
          resolve({
            success: false,
            blocked: false,
            allocationKey,
            elapsed,
            errorType: 'TIMEOUT',
            errorMessage: `프로세스 타임아웃 (${Math.round(elapsed / 1000)}초)`
          });
          return;
        }

        // 결과 파싱 (stdout에서 __RESULT__: 마커 찾기)
        try {
          const lines = stdout.trim().split('\n');
          let jsonLine = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            // __RESULT__: 마커로 시작하는 줄 찾기
            if (line.startsWith('__RESULT__:')) {
              jsonLine = line.substring('__RESULT__:'.length);
              break;
            }
          }

          if (jsonLine) {
            const result = JSON.parse(jsonLine);

            if (result.success) {
              vpnLog(this.agentId, `[T${threadNum}] ✅ 성공: ${keywordShort} (${elapsed}ms)`);

              // extras 추출 (cookies, chrome_version, vpn_ip)
              const extras = {};
              if (result.cookies) extras.cookies = result.cookies;
              if (result.chrome_version) extras.chrome_version = result.chrome_version;
              if (result.vpn_ip) extras.vpn_ip = result.vpn_ip;

              resolve({ success: true, blocked: false, allocationKey, elapsed, extras });
            } else {
              const isBlocked = result.error_type === 'BLOCKED' || result.error_type === 'AKAMAI';
              const emoji = isBlocked ? '🚫' : '❌';
              vpnLog(this.agentId, `[T${threadNum}] ${emoji} 실패: ${result.error_type} (${elapsed}ms)`);
              resolve({
                success: false,
                blocked: isBlocked,
                allocationKey,
                elapsed,
                errorType: result.error_type,
                errorMessage: result.error_message
              });
            }
            return;
          }
        } catch (parseErr) {
          // JSON 파싱 실패 - stderr 확인
        }

        // 프로세스 종료 코드로 판단
        if (code === 0) {
          vpnLog(this.agentId, `[T${threadNum}] ✅ 완료 (${elapsed}ms)`);
          resolve({ success: true, blocked: false, allocationKey, elapsed });
        } else {
          const isBlocked = stderr.includes('HTTP2') || stderr.includes('Akamai') || stderr.includes('403');
          vpnLog(this.agentId, `[T${threadNum}] ❌ 종료코드 ${code} (${elapsed}ms)`);
          resolve({
            success: false,
            blocked: isBlocked,
            allocationKey,
            elapsed,
            errorType: 'EXIT_ERROR',
            errorMessage: stderr.substring(0, 200) || `Exit code: ${code}`
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        if (isResolved) return;
        isResolved = true;

        const elapsed = Date.now() - startTime;
        vpnLog(this.agentId, `[T${threadNum}] 💥 프로세스 에러: ${err.message} (${elapsed}ms)`);
        resolve({
          success: false,
          blocked: false,
          allocationKey,
          elapsed,
          errorType: 'SPAWN_ERROR',
          errorMessage: err.message
        });
      });
    });
  }

  /**
   * 배치 사이클 실행 (1회)
   * - BatchAllocator로 작업 할당받기
   * - 할당받은 작업 수만큼 병렬 실행 (최대 5개)
   * - 결과 즉시 제출
   */
  async runBatchCycle() {
    const runNum = this.totalStats.runCount + 1;
    vpnLog(this.agentId, `━━━ 배치 사이클 #${runNum} 시작 ━━━`);

    // 1. 배치 할당 요청
    if (!this.allocator) {
      vpnLog(this.agentId, `❌ BatchAllocator가 초기화되지 않음`);
      return { agentId: this.agentId, score: 0, stats: this.stats, shouldToggle: false };
    }

    const tasks = await this.allocator.allocateBatch();

    if (!tasks || tasks.length === 0) {
      vpnLog(this.agentId, `📭 할당된 작업 없음 - 대기 후 재시도`);
      this.totalStats.runCount++;
      return { agentId: this.agentId, score: 0, stats: this.stats, shouldToggle: false };
    }

    const taskCount = Math.min(tasks.length, this.maxThreads);
    vpnLog(this.agentId, `📋 ${tasks.length}개 작업 할당됨 → ${taskCount}개 병렬 실행`);

    // 2. 병렬 실행 (할당받은 작업 수만큼, 최대 maxThreads개)
    this.stats = { success: 0, fail: 0, blocked: 0 };
    const tasksToRun = tasks.slice(0, taskCount);

    // 로그 파일 설정
    const logDir = getSharedLogDir();
    const logFile = path.join(logDir, `${this.agentId}.log`);
    const headerTime = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    fs.appendFileSync(logFile, `\n${'─'.repeat(50)}\n[${headerTime}] 사이클 #${runNum} - ${taskCount}개 작업\n${'─'.repeat(50)}\n`);

    // 병렬 실행 및 결과 즉시 제출
    const results = await Promise.all(
      tasksToRun.map(async (task, idx) => {
        const threadNum = idx + 1;

        // 작업 실행 (네임스페이스 내에서)
        const result = await this.executeTaskInNamespace(task, threadNum);

        // 3. 결과 즉시 제출 (빠른 실패 리턴)
        try {
          if (result.success) {
            await this.allocator.submitResult(
              BatchAllocator.createClickSuccess(result.allocationKey, result.extras || {})
            );
          } else {
            await this.allocator.submitResult(
              BatchAllocator.createClickFailure(
                result.allocationKey,
                result.errorType || 'UNKNOWN',
                result.errorMessage || 'Unknown error'
              )
            );
          }

          // 4. 개별 작업 완료 후 heartbeat (동글 타임아웃 방지)
          await this.heartbeat();
        } catch (submitErr) {
          vpnLog(this.agentId, `[T${threadNum}] ⚠️ 결과 제출 실패: ${submitErr.message}`);
        }

        return result;
      })
    );

    // 4. 통계 집계
    for (const result of results) {
      if (result.success) {
        this.stats.success++;
      } else if (result.blocked) {
        this.stats.blocked++;
      } else {
        this.stats.fail++;  // 타임아웃 포함
      }
    }

    // 스코어 계산: 성공 +1, 실패 0, 차단 -1
    this.score = this.stats.success - this.stats.blocked;

    // 누적 통계
    this.totalStats.success += this.stats.success;
    this.totalStats.fail += this.stats.fail;
    this.totalStats.blocked += this.stats.blocked;
    this.totalStats.taskCount += taskCount;
    this.totalStats.runCount++;

    const scoreStatus = this.score <= -2 ? '⚠️ 재할당필요' : '✅';
    vpnLog(this.agentId, `사이클 #${runNum} 완료 - 성공:${this.stats.success} 실패:${this.stats.fail} 차단:${this.stats.blocked} → 스코어:${this.score} ${scoreStatus}`);

    return {
      agentId: this.agentId,
      score: this.score,
      stats: { ...this.stats },
      shouldToggle: this.score <= -2  // -2 이하면 토글+재할당
    };
  }

  // 독립 루프 실행 (각 VPN이 자체적으로 계속 돌아감)
  async runIndependentLoop() {
    this.running = true;

    while (!this.shouldStop) {
      // 배치 사이클 1회 실행
      const result = await this.runBatchCycle();

      if (this.shouldStop) break;

      const hasWork = result.stats.success + result.stats.fail + result.stats.blocked > 0;

      // 작업 유무에 따른 카운터 관리
      if (hasWork) {
        this.noWorkCount = 0;  // 작업 있으면 리셋
        // heartbeat은 각 작업 완료 시 개별 호출됨 (runBatchCycle 내부)
      } else {
        this.noWorkCount++;  // 작업 없으면 증가
      }

      // 성공 카운터 업데이트
      this.successSinceToggle += result.stats.success;

      // ========================================
      // 조건 0: 연속 3회 작업 없음 → 토글 + 반납 + 새 동글 할당
      // ========================================
      if (this.noWorkCount >= 3) {
        vpnLog(this.agentId, `📭 연속 ${this.noWorkCount}회 작업 없음 → 토글 후 반납 + 새 동글 할당`);
        this.noWorkCount = 0;

        // 1. IP 토글 (반납 전에)
        await this.toggleIp();

        // 2. VPN 재연결 (반납 + 새 동글 할당)
        const reconnected = await this.reconnect();
        if (!reconnected) {
          vpnLog(this.agentId, '❌ VPN 재연결 실패 → 10초 후 재시도');
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }
      }
      // ========================================
      // 조건 1: 스코어 <= -2 → IP 토글 + 반납 + 재할당
      // ========================================
      else if (result.shouldToggle && hasWork) {
        vpnLog(this.agentId, `스코어 ${result.score} <= -2 (차단:${result.stats.blocked}) → IP 토글 후 재할당`);
        this.totalStats.toggleCount++;

        // 1. IP 토글 (반납 전에)
        await this.toggleIp();

        // 2. VPN 재연결 (반납 + 새 동글 할당)
        let reconnected = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          reconnected = await this.reconnect();
          if (reconnected) break;
          vpnLog(this.agentId, `VPN 재연결 실패 (${attempt}/3) → ${attempt < 3 ? '10초 후 재시도' : '포기'}`);
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 10000));
          }
        }

        if (!reconnected) {
          vpnLog(this.agentId, '❌ VPN 재연결 3회 실패 → 루프 종료');
          break;
        }

        // 성공 카운터 리셋
        this.successSinceToggle = 0;
      }
      // ========================================
      // 조건 2: 성공 50회 이상 → IP 토글 + 반납 + 재할당
      // ========================================
      else if (this.successSinceToggle >= 50) {
        vpnLog(this.agentId, `✨ 성공 ${this.successSinceToggle}회 → 예방적 토글 후 재할당`);
        this.totalStats.toggleCount++;

        // 1. IP 토글 (반납 전에)
        await this.toggleIp();

        // 2. VPN 재연결 (반납 + 새 동글 할당)
        await this.reconnect();

        // 성공 카운터 리셋
        this.successSinceToggle = 0;
      }
      // 조건 3: 정상 → 계속 사용 (heartbeat은 위에서 이미 호출됨)

      // onceMode면 1회 실행 후 종료
      if (this.onceMode) {
        vpnLog(this.agentId, '--once 모드: 1회 실행 완료');
        break;
      }

      // 작업이 없었으면 10초 대기, 있었으면 2초 대기
      const waitTime = hasWork ? 2000 : 10000;
      await new Promise(r => setTimeout(r, waitTime));
    }

    this.running = false;
    return this.totalStats;
  }

  stop() {
    this.shouldStop = true;
    if (this.process) {
      this.process.kill('SIGTERM');
    }
  }

  async cleanup() {
    this.stop();
    // 동글 반납
    await this.releaseDongle();
    // VPN 정리
    if (this.connected && this.namespace && this.wgInterface) {
      cleanupVpn(this.namespace, this.wgInterface);
      vpnLog(this.agentId, 'VPN 정리 완료');
    }
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
    console.log('');
    console.log('💡 매번 비밀번호 입력이 귀찮다면 아래 명령어를 한 번 실행하세요:');
    console.log('');
    console.log('  sudo bash -c \'echo "tech ALL=(ALL) NOPASSWD: /usr/bin/node, /usr/sbin/ip, /sbin/ip" > /etc/sudoers.d/tech-nopasswd && chmod 440 /etc/sudoers.d/tech-nopasswd\'');
    console.log('');
    process.exit(1);
  }

  const totalThreads = options.vpnCount * options.threadsPerVpn;

  // 디버그 모드 설정
  DEBUG_MODE = options.debug;

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  🌐 멀티 VPN 독립 실행 모드 - 쿠팡 Chrome 자동화');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  호스트: ${HOSTNAME}`);
  if (DEBUG_MODE) console.log(`  🐛 디버그 모드: ON (child process 로그 실시간 출력)`);
  console.log(`  agent_id 범위: ${HOSTNAME}-01 ~ ${HOSTNAME}-${String(options.vpnCount).padStart(2, '0')}`);
  console.log(`  VPN 개수: ${options.vpnCount}개 (동적 동글 할당)`);
  console.log(`  VPN당 쓰레드: ${options.threadsPerVpn}개`);
  console.log(`  총 쓰레드: ${totalThreads}개`);
  console.log(`  모드: ${options.once ? '1회 실행' : '연속 독립 실행'}`);
  console.log('');
  console.log('  각 VPN은 독립적으로 동작:');
  console.log('  - 서버에서 동적으로 동글 할당/반납');
  console.log('  - 자체 스코어 계산 후 재연결 여부 결정');
  console.log('  - 다른 VPN에 영향 없음');
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

  // VPN 인스턴스 생성 (vpnIndex: 1 ~ vpnCount)
  const vpnInstances = [];
  for (let i = 1; i <= options.vpnCount; i++) {
    vpnInstances.push(new VpnInstance(i, options.threadsPerVpn, options.once));
  }
  activeVpnInstances = vpnInstances;  // 전역 참조 저장 (정리용)

  // 종료 시 정리
  let isShuttingDown = false;
  const cleanup = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('');
    log('종료 신호 받음, 모든 VPN 중지 중...');

    // 모든 인스턴스 중지
    for (const instance of vpnInstances) {
      instance.stop();
    }

    // 동글 반납 (병렬 실행)
    log('동글 반납 중...');
    await Promise.all(
      vpnInstances.map(instance => instance.releaseDongle().catch(() => {}))
    );
    log('동글 반납 완료');

    // 잠시 대기 후 VPN 네임스페이스 정리
    await new Promise(r => setTimeout(r, 1000));
    cleanupAllVpns();

    // 최종 통계 출력
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    log('최종 실행 통계');
    console.log('═══════════════════════════════════════════════════════════════');

    let grandTotal = { success: 0, fail: 0, blocked: 0, toggleCount: 0, runCount: 0, taskCount: 0 };
    for (const instance of vpnInstances) {
      const s = instance.totalStats;
      grandTotal.success += s.success;
      grandTotal.fail += s.fail;
      grandTotal.blocked += s.blocked;
      grandTotal.toggleCount += s.toggleCount;
      grandTotal.runCount += s.runCount;
      grandTotal.taskCount += s.taskCount || 0;

      vpnLog(instance.agentId, `사이클:${s.runCount}회 작업:${s.taskCount || 0}개 성공:${s.success} 실패:${s.fail} 차단:${s.blocked} 재연결:${s.toggleCount}회`);
    }

    console.log('');
    log(`전체 총계 - 사이클:${grandTotal.runCount}회 작업:${grandTotal.taskCount}개 성공:${grandTotal.success} 실패:${grandTotal.fail} 차단:${grandTotal.blocked} 재연결:${grandTotal.toggleCount}회`);

    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // 1. VPN 순차 연결 (1초 간격으로 시작하여 429 에러 방지)
    log(`${options.vpnCount}개 VPN 순차 연결 시작 (동글 동적 할당, 1초 간격)...`);
    console.log('');

    const connectResults = [];
    for (let i = 0; i < vpnInstances.length; i++) {
      const instance = vpnInstances[i];
      const result = await instance.connect();
      connectResults.push(result);

      // 마지막이 아니면 1초 대기 (API 과부하 방지)
      if (i < vpnInstances.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const connectedCount = connectResults.filter(r => r).length;
    console.log('');
    log(`VPN 연결 완료: ${connectedCount}/${options.vpnCount}개 성공`);

    if (connectedCount === 0) {
      throw new Error('모든 VPN 연결 실패');
    }

    // 연결된 VPN만 필터
    const activeInstances = vpnInstances.filter(instance => instance.connected);

    console.log('');
    log('독립 루프 시작 (5초 간격으로 순차 시작)...');
    console.log('');

    // 2. 각 VPN을 독립 루프로 실행 (5초 간격으로 순차 시작)
    const loopPromises = [];
    for (let i = 0; i < activeInstances.length; i++) {
      const instance = activeInstances[i];
      // 각 VPN을 5초 간격으로 시작 (브라우저 리소스 충돌 방지)
      if (i > 0) {
        await new Promise(r => setTimeout(r, 5000));
      }
      vpnLog(instance.agentId, `독립 루프 시작 (${i + 1}/${activeInstances.length})`)
      // 독립 루프 시작 (각 VPN이 자체적으로 돌아감)
      loopPromises.push(instance.runIndependentLoop());
    }

    // 모든 독립 루프 완료 대기 (once 모드일 때만 실제로 완료됨)
    const finalStats = await Promise.all(loopPromises);

    // 결과 요약 (once 모드에서만 도달)
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    log('실행 결과 요약');
    console.log('═══════════════════════════════════════════════════════════════');

    let grandTotal = { success: 0, fail: 0, blocked: 0, toggleCount: 0, runCount: 0, taskCount: 0 };
    for (let i = 0; i < activeInstances.length; i++) {
      const instance = activeInstances[i];
      const s = finalStats[i];
      grandTotal.success += s.success;
      grandTotal.fail += s.fail;
      grandTotal.blocked += s.blocked;
      grandTotal.toggleCount += s.toggleCount;
      grandTotal.runCount += s.runCount;
      grandTotal.taskCount += s.taskCount || 0;

      vpnLog(instance.agentId, `사이클:${s.runCount}회 작업:${s.taskCount || 0}개 성공:${s.success} 실패:${s.fail} 차단:${s.blocked} 재연결:${s.toggleCount}회`);
    }

    console.log('');
    log(`전체 총계 - 사이클:${grandTotal.runCount}회 작업:${grandTotal.taskCount}개 성공:${grandTotal.success} 실패:${grandTotal.fail} 차단:${grandTotal.blocked} 재연결:${grandTotal.toggleCount}회`);

  } catch (err) {
    error(`오류 발생: ${err.message}`);
    process.exitCode = 1;
  } finally {
    // 동글 반납 (정상 종료 시에도 반드시 반납)
    console.log('');
    log('동글 반납 중...');
    try {
      await Promise.all(
        vpnInstances.map(instance => instance.releaseDongle().catch(() => {}))
      );
      log('동글 반납 완료');
    } catch (e) {
      warn(`동글 반납 중 오류: ${e.message}`);
    }

    // VPN 네임스페이스 정리
    cleanupAllVpns();
  }
}

// 실행
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { VpnInstance, createAgentId, HOSTNAME };
