/**
 * VPN 네임스페이스 모드 - 쿠팡 Chrome 자동화
 *
 * 네이버 쇼핑 방식과 동일하게 Node.js 프로세스 전체를 VPN 네임스페이스 안에서 실행합니다.
 * 이 방식은 별도의 프록시 설정 없이 모든 네트워크 트래픽이 VPN을 통과합니다.
 *
 * 사용법:
 *   sudo ./vpn/run-parallel.sh              # 4개 VPN 병렬 실행 (권장)
 *   sudo ./vpn/run-parallel.sh --once       # 4개 VPN 병렬 1회 실행
 *   sudo ./vpn/run-parallel.sh --status     # 상태 모니터링 활성화
 *
 * 단일 VPN 직접 실행 (테스트용):
 *   sudo ./vpn/run-in-vpn.sh 16 node index-vpn.js --vpn=16 --thread-index=0
 *
 * 옵션:
 *   --vpn <n>           VPN 동글 번호 (16, 17, 18, 19)
 *   --thread-index <n>  쓰레드 인덱스 (0, 1, 2, 3)
 *   --once              1회만 실행 후 종료
 *   --keep-browser      에러 시 브라우저 유지 (디버깅용)
 *   --no-gpu            GPU 비활성화
 *   --chrome <version>  Chrome 버전 지정 (예: 138, 140)
 *   --status            상태 모니터링 서버 활성화 (포트 3303)
 *   --help              도움말 표시
 */

// 병렬 실행 스크립트 안내
if (require.main === module && !process.env.VPN_NAMESPACE && !process.argv.includes('--vpn')) {
  console.log(`
═══════════════════════════════════════════════════════════
  🌐 VPN 네임스페이스 모드 - 쿠팡 Chrome 자동화
═══════════════════════════════════════════════════════════

이 모드는 Node.js 프로세스 전체를 VPN 네임스페이스 안에서 실행합니다.
네이버 쇼핑 자동화와 동일한 방식입니다.

사용법:
  sudo ./vpn/run-parallel.sh              # 4개 VPN 병렬 실행 (권장)
  sudo ./vpn/run-parallel.sh --once       # 4개 VPN 병렬 1회 실행
  sudo ./vpn/run-parallel.sh --status     # 상태 모니터링 활성화

VPN 네임스페이스 (vpn-16, vpn-17, vpn-18, vpn-19)가 미리 설정되어 있어야 합니다.
설정 방법: /home/tech/naver/shop/vpn/vpn-up.sh

단일 VPN 직접 실행 (테스트용):
  sudo ./vpn/run-in-vpn.sh 16 node index-vpn.js --vpn=16 --thread-index=0
`);
  process.exit(0);
}

// Linux 환경에서 DISPLAY 환경변수 설정 (모듈 로드 전에 설정)
if (process.platform === 'linux' && !process.env.DISPLAY) {
  process.env.DISPLAY = ':0';
}

// 글로벌 에러 핸들러 - 프로세스 종료 방지
process.on('unhandledRejection', (reason, promise) => {
  const errorMessage = reason?.message || String(reason);
  if (errorMessage.includes('session closed') ||
      errorMessage.includes('Target closed') ||
      errorMessage.includes('Protocol error') ||
      errorMessage.includes('Connection closed')) {
    console.log(`[VPN] 브라우저 세션 종료 에러 (무시됨): ${errorMessage.substring(0, 100)}`);
    return;
  }
  console.error('[VPN] Unhandled Rejection:', errorMessage);
});

process.on('uncaughtException', (error) => {
  const errorMessage = error?.message || String(error);
  if (errorMessage.includes('session closed') ||
      errorMessage.includes('Target closed') ||
      errorMessage.includes('Protocol error') ||
      errorMessage.includes('Connection closed')) {
    console.log(`[VPN] 브라우저 세션 종료 에러 (무시됨): ${errorMessage.substring(0, 100)}`);
    return;
  }
  console.error('[VPN] Uncaught Exception:', errorMessage);
  if (!errorMessage.includes('ECONNRESET') && !errorMessage.includes('EPIPE')) {
    process.exit(1);
  }
});

const { runApiMode } = require('./lib/core/api-mode');
const UbuntuSetup = require('./lib/utils/ubuntu-setup');
const fs = require('fs');
const path = require('path');

// 명령줄 인자 파싱
function parseVPNArgs() {
  const args = process.argv.slice(2);
  const options = {
    vpnNumber: null,
    threadIndex: 0,
    threadCount: 1,  // 배치 모드: VPN당 쓰레드 수 (기본값 1)
    once: false,
    keepBrowser: false,
    noGpu: false,
    chromeVersion: null,
    directUrl: false,
    status: false,
    workType: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help') {
      options.help = true;
    } else if (arg.startsWith('--vpn=')) {
      options.vpnNumber = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--thread-index=')) {
      options.threadIndex = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--threads=')) {
      options.threadCount = parseInt(arg.split('=')[1]);
    } else if (arg === '--once') {
      options.once = true;
    } else if (arg === '--keep-browser') {
      options.keepBrowser = true;
    } else if (arg === '--no-gpu') {
      options.noGpu = true;
    } else if (arg === '--direct-url') {
      options.directUrl = true;
    } else if (arg === '--status') {
      options.status = true;
    } else if (arg.startsWith('--chrome=')) {
      options.chromeVersion = arg.split('=')[1];
    } else if (arg === '--chrome' && args[i + 1]) {
      options.chromeVersion = args[++i];
    } else if (arg.startsWith('--work-type=')) {
      options.workType = arg.split('=')[1];
    }
  }

  return options;
}

function printHelp() {
  console.log(`
🌐 VPN 네임스페이스 모드 - 쿠팡 Chrome 자동화

사용법:
  sudo ./vpn/run-parallel.sh [옵션]     # 4개 VPN 병렬 실행 (권장)
  node index-vpn.js --vpn=16 [옵션]     # 단일 VPN 실행 (VPN 내에서)

옵션:
  --vpn <n>           VPN 동글 번호 (16, 17, 18, 19)
  --thread-index <n>  쓰레드 인덱스 오프셋 (기본: 0)
  --threads <n>       VPN당 쓰레드 수 (기본: 1, 배치 모드 시 2~4 권장)
  --once              1회만 실행 후 종료
  --keep-browser      에러 시 브라우저 유지 (디버깅용)
  --no-gpu            GPU 비활성화
  --chrome <version>  Chrome 버전 지정 (예: 138, 140)
  --status            상태 모니터링 서버 활성화 (포트 3303)
  --work-type <type>  작업 타입 (rank, click, idle, product_info)
  --help              도움말 표시

배치 모드:
  --threads=2 이상 지정 시 배치 모드가 활성화됩니다.
  배치 모드에서는 N개 쓰레드가 동시에 작업을 수행하고,
  모든 쓰레드가 완료된 후 실패가 1개 이상이면 IP를 토글합니다.

폴더 구조:
  browser-data/vpn_동글번호/쓰레드번호/크롬버전
  예: browser-data/vpn_16/01/137

VPN 네임스페이스 (vpn-16 ~ vpn-23)가 미리 설정되어 있어야 합니다.
`);
}

/**
 * 브라우저 프로필 초기화
 * VPN 모드: browser-data/vpn_동글번호/쓰레드번호 폴더 초기화
 */
function cleanBrowserProfile(vpnNumber, threadIndex) {
  const browserDataDir = path.join(__dirname, 'browser-data');
  const folderName = String(threadIndex + 1).padStart(2, '0');
  const vpnFolder = `vpn_${vpnNumber}`;
  const profilePath = path.join(browserDataDir, vpnFolder, folderName);

  if (fs.existsSync(profilePath)) {
    try {
      fs.rmSync(profilePath, { recursive: true, force: true });
      console.log(`[VPN] 프로필 초기화 완료: ${vpnFolder}/${folderName}`);
    } catch (e) {
      // 무시
    }
  }
}

// 메인 실행 함수
async function main() {
  const options = parseVPNArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const vpnNamespace = process.env.VPN_NAMESPACE || `vpn-${options.vpnNumber}`;
  const vpnNumber = options.vpnNumber || parseInt(vpnNamespace.replace('vpn-', ''));
  const threadCount = options.threadCount || 1;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  [VPN ${vpnNumber}] 쿠팡 에이전트`);
  console.log(`  네임스페이스: ${vpnNamespace}`);
  console.log(`  쓰레드 수: ${threadCount}개 ${threadCount > 1 ? '(배치 모드)' : '(단일 모드)'}`);
  console.log(`  프로필 폴더: browser-data/vpn_${vpnNumber}/01~${String(threadCount).padStart(2, '0')}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  try {
    // Ubuntu 환경 체크
    if (process.platform === 'linux') {
      console.log('[VPN] Ubuntu 환경 점검 중...');
      const ubuntuCheck = await UbuntuSetup.checkSystemResources();
      if (!ubuntuCheck.success) {
        console.log('[VPN] Ubuntu 환경 설정 문제가 감지되었습니다.');
      }
    }

    // 브라우저 프로필 초기화 (각 쓰레드별로)
    for (let i = 0; i < threadCount; i++) {
      cleanBrowserProfile(vpnNumber, i);
    }

    // API 모드 옵션 설정
    const apiOptions = {
      threadCount: threadCount,  // 배치 모드: VPN당 N개 쓰레드
      once: options.once,
      keepBrowser: options.keepBrowser,
      noGpu: options.noGpu,
      chromeVersion: options.chromeVersion,
      directUrl: options.directUrl,
      status: options.status,
      workType: options.workType,
      // VPN 모드 특수 옵션
      vpnMode: true,
      vpnNamespace: vpnNamespace,
      vpnThreadIndex: 0  // 쓰레드 인덱스 오프셋 (VPN별로 0부터 시작)
    };

    if (threadCount > 1) {
      console.log(`[VPN] 배치 모드 실행 시작 (쓰레드 ${threadCount}개)`);
      console.log(`[VPN] 모든 쓰레드 완료 후 실패 시 IP 토글`);
    } else {
      console.log(`[VPN] API 모드 실행 시작 (쓰레드 1개)`);
    }
    console.log('');

    // 기존 API 모드 실행 (네트워크는 자동으로 VPN을 통과)
    await runApiMode(apiOptions);

    console.log('[VPN] 프로그램 종료');
    process.exit(0);

  } catch (error) {
    console.error('[VPN] 프로그램 오류:', error.message);
    process.exit(1);
  }
}

// 실행
if (require.main === module) {
  main().catch(console.error);
}
