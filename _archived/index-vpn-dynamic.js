/**
 * VPN 동적 연결 모드 - 쿠팡 Chrome 자동화
 *
 * 사전등록 없이 VPN 키를 동적으로 가져와서 연결 후 작업 수행
 *
 * 흐름:
 *   1. VPN 키 서버에서 설정 가져오기 (49.171.88.233, 동글 11~20, 슬롯 0~9 랜덤)
 *   2. WireGuard 네임스페이스 생성 및 연결
 *   3. 작업 할당 받기 (프록시 정보 무시)
 *   4. 네임스페이스 내에서 브라우저 실행
 *   5. 작업 완료 후 VPN 정리
 *
 * 사용법:
 *   sudo node index-vpn-dynamic.js [옵션]
 *
 * 옵션:
 *   --dongle <n>        동글 번호 지정 (11~20, 기본: 랜덤)
 *   --slot <n>          슬롯 번호 지정 (0~9, 기본: 랜덤)
 *   --once              1회만 실행 후 종료
 *   --keep-vpn          종료 시 VPN 유지 (디버깅용)
 *   --help              도움말 표시
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// 설정
const VPN_SERVER = '49.171.88.233';
const VPN_KEY_PORT = 8080;
const DONGLE_RANGE = { min: 11, max: 20 };
const SLOT_RANGE = { min: 0, max: 9 };

// 색상 출력
const colors = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const log = (msg) => console.log(`${colors.green('[VPN-DYN]')} ${msg}`);
const warn = (msg) => console.log(`${colors.yellow('[VPN-DYN]')} ${msg}`);
const error = (msg) => console.log(`${colors.red('[VPN-DYN]')} ${msg}`);
const info = (msg) => console.log(`${colors.cyan('[VPN-DYN]')} ${msg}`);

// 명령줄 인자 파싱
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dongle: null,  // null이면 랜덤
    slot: null,    // null이면 랜덤
    threads: 1,    // 쓰레드 수 (1~4)
    once: false,
    keepVpn: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--keep-vpn') options.keepVpn = true;
    else if (arg.startsWith('--dongle=')) options.dongle = parseInt(arg.split('=')[1]);
    else if (arg.startsWith('--slot=')) options.slot = parseInt(arg.split('=')[1]);
    else if (arg.startsWith('--threads=')) options.threads = parseInt(arg.split('=')[1]);
    else if (arg === '--dongle' && args[i + 1]) options.dongle = parseInt(args[++i]);
    else if (arg === '--slot' && args[i + 1]) options.slot = parseInt(args[++i]);
    else if (arg === '--threads' && args[i + 1]) options.threads = parseInt(args[++i]);
  }

  // 쓰레드 수 유효성 검사 (1~10)
  options.threads = Math.max(1, Math.min(10, options.threads || 1));

  return options;
}

function printHelp() {
  console.log(`
🌐 VPN 동적 연결 모드 - 쿠팡 Chrome 자동화

사용법:
  sudo node index-vpn-dynamic.js [옵션]

옵션:
  --dongle <n>        동글 번호 지정 (11~20, 기본: 랜덤)
  --slot <n>          슬롯 번호 지정 (0~9, 기본: 랜덤)
  --threads <n>       쓰레드 수 (1~10, 기본: 1)
  --once              1회만 실행 후 종료
  --keep-vpn          종료 시 VPN 유지 (디버깅용)
  --help              도움말 표시

예시:
  sudo node index-vpn-dynamic.js                        # 랜덤 VPN, 쓰레드 1개
  sudo node index-vpn-dynamic.js --dongle=15            # 동글 15 사용
  sudo node index-vpn-dynamic.js --threads=4            # 쓰레드 4개 실행
  sudo node index-vpn-dynamic.js --dongle=14 --threads=2 --once  # 동글 14, 2쓰레드, 1회
`);
}

// 랜덤 숫자 생성
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// VPN 키 설정 가져오기
async function fetchVpnConfig(dongle, slot) {
  const url = `http://${VPN_SERVER}:${VPN_KEY_PORT}/vpnkeys_tech/${dongle}/${slot}/conf`;
  info(`VPN 설정 조회: ${url}`);

  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (data.includes('[Interface]')) {
          // WireGuard 설정 파싱 (키에 = 포함될 수 있으므로 첫 번째 = 이후 전체를 값으로)
          const config = {};
          const lines = data.split('\n');
          for (const line of lines) {
            const eqIndex = line.indexOf('=');
            if (eqIndex === -1) continue;
            const key = line.substring(0, eqIndex).trim();
            const value = line.substring(eqIndex + 1).trim();

            if (key === 'PrivateKey') config.privateKey = value;
            else if (key === 'Address') config.address = value;
            else if (key === 'PublicKey') config.publicKey = value;
            else if (key === 'Endpoint') config.endpoint = value;
          }
          resolve(config);
        } else {
          reject(new Error('Invalid VPN config response'));
        }
      });
    }).on('error', reject);
  });
}

// VPN 네임스페이스 생성 및 연결
function setupVpnNamespace(namespace, wgInterface, config) {
  log(`VPN 네임스페이스 설정 중: ${namespace}`);

  // 기존 정리
  try {
    execSync(`ip netns del ${namespace} 2>/dev/null || true`, { stdio: 'pipe' });
  } catch (e) {}

  // 네임스페이스 생성
  execSync(`ip netns add ${namespace}`);
  execSync(`ip netns exec ${namespace} ip link set lo up`);

  // WireGuard 인터페이스 생성
  execSync(`ip link add ${wgInterface} type wireguard`);
  execSync(`ip link set ${wgInterface} netns ${namespace}`);

  // WireGuard 설정 파일 생성
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
  execSync(`ip netns exec ${namespace} ip addr add ${config.address} dev ${wgInterface}`);
  execSync(`ip netns exec ${namespace} ip link set ${wgInterface} up`);

  // 라우팅 설정
  execSync(`ip netns exec ${namespace} ip route add default dev ${wgInterface}`);

  // DNS 설정
  const dnsDir = `/etc/netns/${namespace}`;
  if (!fs.existsSync(dnsDir)) {
    fs.mkdirSync(dnsDir, { recursive: true });
  }
  fs.writeFileSync(`${dnsDir}/resolv.conf`, 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n');

  log(`VPN 연결 완료: ${namespace}`);
}

// VPN 공인 IP 확인
function getVpnPublicIp(namespace) {
  try {
    const ip = execSync(`ip netns exec ${namespace} curl -s --max-time 10 https://api.ipify.org`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return ip;
  } catch (e) {
    return '확인 실패';
  }
}

// VPN IP 토글 (작업 완료 후 호출)
function toggleVpnIp(serverIp, dongle) {
  const toggleUrl = `http://${serverIp}/toggle/${dongle}`;
  log(`IP 토글 요청: ${toggleUrl}`);

  return new Promise((resolve) => {
    http.get(toggleUrl, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          log(`IP 토글 완료: ${data.trim() || 'OK'}`);
          resolve(true);
        } else {
          warn(`IP 토글 응답: ${res.statusCode}`);
          resolve(false);
        }
      });
    }).on('error', (e) => {
      warn(`IP 토글 실패: ${e.message}`);
      resolve(false);
    });
  });
}

// VPN 정리
function cleanupVpn(namespace, wgInterface) {
  log(`VPN 정리 중: ${namespace}`);
  try {
    execSync(`ip -n ${namespace} link del ${wgInterface} 2>/dev/null || true`, { stdio: 'pipe' });
    execSync(`ip netns del ${namespace} 2>/dev/null || true`, { stdio: 'pipe' });
    const dnsDir = `/etc/netns/${namespace}`;
    if (fs.existsSync(dnsDir)) {
      fs.rmSync(dnsDir, { recursive: true, force: true });
    }
    log(`VPN 정리 완료: ${namespace}`);
  } catch (e) {
    warn(`VPN 정리 중 오류: ${e.message}`);
  }
}

// 네임스페이스 내에서 Node.js 실행 (root로 실행, 환경변수로 tech 설정)
function runInNamespace(namespace, scriptPath, args = [], logFile = null) {
  return new Promise((resolve, reject) => {
    let cmd, cmdArgs;

    // 로그 파일이 지정된 경우 tee로 저장하면서 출력
    if (logFile) {
      const logDir = path.dirname(logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      // 로그 헤더 작성 (KST)
      const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      fs.writeFileSync(logFile, `${'='.repeat(60)}\n[${timestamp}] VPN 동적 모드 실행 시작\n네임스페이스: ${namespace}\n${'='.repeat(60)}\n\n`);

      // bash -c로 tee 파이프라인 실행 (sudo -u 제거 - 네임스페이스 유지 위해)
      cmd = 'bash';
      cmdArgs = ['-c', `ip netns exec ${namespace} node ${scriptPath} ${args.join(' ')} 2>&1 | tee -a ${logFile}`];
      log(`로그 저장: ${logFile}`);
    } else {
      // sudo -u tech 제거 - 네임스페이스가 유지되지 않음
      cmd = 'ip';
      cmdArgs = ['netns', 'exec', namespace, 'node', scriptPath, ...args];
    }

    log(`실행: ip netns exec ${namespace} node ${scriptPath} ${args.join(' ')}`);

    const child = spawn(cmd, cmdArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        VPN_NAMESPACE: namespace,
        VPN_MODE: 'true',  // VPN 모드 플래그 - 프록시 무시
        DISPLAY: ':0',
        HOME: '/home/tech',  // tech 사용자 홈 디렉토리
        USER: 'tech',
        XAUTHORITY: '/home/tech/.Xauthority',  // X 인증 파일
      }
    });

    child.on('close', (code) => {
      // 종료 코드 = 실패 횟수 (0~255)
      // code가 null이면 에러로 처리
      if (code !== null) {
        resolve(code);  // 실패 횟수 반환
      } else {
        reject(new Error('Process terminated unexpectedly'));
      }
    });

    child.on('error', reject);
  });
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
    process.exit(1);
  }

  // 동글/슬롯 결정
  const dongle = options.dongle || randomInt(DONGLE_RANGE.min, DONGLE_RANGE.max);
  const slot = options.slot !== null ? options.slot : randomInt(SLOT_RANGE.min, SLOT_RANGE.max);

  const namespace = `vpn-dyn-${dongle}`;
  const wgInterface = `wg-dyn-${dongle}`;

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🌐 VPN 동적 연결 모드 - 쿠팡 Chrome 자동화');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  서버: ${VPN_SERVER}`);
  console.log(`  동글: ${dongle} / 슬롯: ${slot}`);
  console.log(`  쓰레드: ${options.threads}개`);
  console.log(`  네임스페이스: ${namespace}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  let vpnConnected = false;

  try {
    // 1. VPN 설정 가져오기
    log('VPN 설정 가져오는 중...');
    const vpnConfig = await fetchVpnConfig(dongle, slot);
    log(`PrivateKey: ${vpnConfig.privateKey.substring(0, 10)}...`);
    log(`Address: ${vpnConfig.address}`);
    log(`Endpoint: ${vpnConfig.endpoint}`);

    // 2. VPN 연결
    setupVpnNamespace(namespace, wgInterface, vpnConfig);
    vpnConnected = true;

    // 3. VPN IP 확인
    const vpnIp = getVpnPublicIp(namespace);
    log(`VPN 공인 IP: ${vpnIp}`);

    if (vpnIp === '확인 실패') {
      throw new Error('VPN 연결 확인 실패');
    }

    // 4. 메인 IP 확인 (변경되지 않았는지)
    try {
      const mainIp = execSync('curl -s --max-time 5 https://api.ipify.org', { encoding: 'utf8' }).trim();
      log(`메인 IP: ${mainIp} (변경 없음 확인)`);
    } catch (e) {
      warn('메인 IP 확인 실패');
    }

    // 5. X서버 접근 권한 설정 (root가 tech의 X서버에 접근할 수 있도록)
    try {
      execSync('xhost +local:root 2>/dev/null || true', {
        stdio: 'pipe',
        env: { ...process.env, DISPLAY: ':0' }
      });
      log('X서버 접근 권한 설정 완료');
    } catch (e) {
      warn('X서버 접근 권한 설정 실패 (무시)');
    }

    // 6. 네임스페이스 내에서 index.js 실행
    console.log('');
    log('브라우저 자동화 시작...');
    console.log('');

    const scriptArgs = ['--threads', String(options.threads)];
    if (options.once) scriptArgs.push('--once');

    // --once 모드에서 로그 파일 생성 (KST 타임스탬프)
    let logFile = null;
    if (options.once) {
      const now = new Date();
      const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9
      const timestamp = kst.toISOString().replace(/[:.]/g, '-').substring(0, 19);
      logFile = path.join(__dirname, 'logs', `vpn-dyn-${dongle}_${timestamp}.log`);
    }

    const blockedCount = await runInNamespace(namespace, path.join(__dirname, 'index.js'), scriptArgs, logFile);

    log(`작업 완료 (차단: ${blockedCount}개)`);
    if (logFile) {
      log(`로그 저장 완료: ${logFile}`);
    }

    // 7. 작업 완료 후 IP 토글 (차단 2회 이상일 때만, --keep-vpn이 아닐 때)
    if (!options.keepVpn && blockedCount >= 2) {
      log(`차단 ${blockedCount}회 → IP 토글 실행`);
      await toggleVpnIp(VPN_SERVER, dongle);
    } else if (!options.keepVpn && blockedCount < 2) {
      log(`차단 ${blockedCount}회 → IP 토글 생략`);
    }

  } catch (err) {
    error(`오류 발생: ${err.message}`);
    process.exitCode = 1;
  } finally {
    // VPN 정리
    if (vpnConnected && !options.keepVpn) {
      cleanupVpn(namespace, wgInterface);
    } else if (options.keepVpn) {
      warn(`VPN 유지됨. 정리: sudo ip netns del ${namespace}`);
    }
  }
}

// 실행
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { fetchVpnConfig, setupVpnNamespace, cleanupVpn, getVpnPublicIp };
