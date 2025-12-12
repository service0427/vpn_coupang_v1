/**
 * 단일 작업 실행기 (Single Task Runner)
 *
 * 환경변수로 전달된 단일 작업을 실행하고 JSON 결과를 stdout으로 출력
 * index-vpn-multi.js에서 VPN 네임스페이스 내에서 호출됨
 *
 * 환경변수:
 *   TASK_ALLOCATION_KEY - 작업 할당 키
 *   TASK_KEYWORD - 검색 키워드
 *   TASK_PRODUCT_ID - 상품 ID
 *   TASK_ITEM_ID - 아이템 ID (optional)
 *   TASK_VENDOR_ITEM_ID - 벤더 아이템 ID (optional)
 *   THREAD_NUMBER - 쓰레드 번호 (1~5)
 *   VPN_DONGLE - VPN 동글 번호
 *   VPN_MODE - VPN 모드 여부
 */

const fs = require('fs');
const path = require('path');

// 타임스탬프 생성
const getTimestamp = () => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
};

const log = (msg) => console.log(`[${getTimestamp()}] ${msg}`);
const errorLog = (msg) => console.error(`[${getTimestamp()}] ${msg}`);

// 필수 모듈 로드
const { executeKeywordSearch } = require('./search-executor');
const { cleanChromeProfile, calculateWindowPosition, calculateViewportSize, initializeScreenResolution } = require('../utils/browser-helpers');
const { getRandomChromeVersion } = require('./api/chrome-manager');
const { BrowserCore } = require('./browser-core');

/**
 * 환경변수에서 작업 정보 추출
 */
function getTaskFromEnv() {
  const allocationKey = process.env.TASK_ALLOCATION_KEY;
  const keyword = process.env.TASK_KEYWORD;
  const productId = process.env.TASK_PRODUCT_ID;
  const itemId = process.env.TASK_ITEM_ID || null;
  const vendorItemId = process.env.TASK_VENDOR_ITEM_ID || null;
  const workType = process.env.TASK_WORK_TYPE || 'click';
  const threadNumber = parseInt(process.env.THREAD_NUMBER) || 1;
  const vpnDongle = parseInt(process.env.VPN_DONGLE) || null;

  if (!allocationKey || !keyword) {
    throw new Error('필수 환경변수 누락: TASK_ALLOCATION_KEY, TASK_KEYWORD');
  }

  return {
    allocationKey,
    keyword,
    productId,
    itemId,
    vendorItemId,
    workType,
    threadNumber,
    vpnDongle
  };
}

/**
 * 결과 출력 (JSON 형식)
 */
function outputResult(result) {
  // 가독성용 출력 (jq 스타일, cookies는 길이만)
  const displayResult = { ...result };
  if (displayResult.cookies) {
    displayResult.cookies = `[${displayResult.cookies.length} chars]`;
  }
  console.log(JSON.stringify(displayResult, null, 2));

  // 파싱용 JSON (마커로 구분, 로그에 안 섞임)
  console.log(`__RESULT__:${JSON.stringify(result)}`);
}

/**
 * 성공 결과 생성
 * @param {string} allocationKey - 할당 키
 * @param {Object} extras - 추가 정보 { cookies, chromeVersion, vpnIp }
 */
function createSuccessResult(allocationKey, extras = {}) {
  const result = {
    success: true,
    allocation_key: allocationKey
  };

  // Chrome 버전
  if (extras.chromeVersion) {
    result.chrome_version = extras.chromeVersion;
  }

  // VPN IP
  if (extras.vpnIp) {
    result.vpn_ip = extras.vpnIp;
  }

  // 쿠키 (base64 인코딩)
  if (extras.cookies && extras.cookies.length > 0) {
    // _abck 쿠키가 있는 경우에만 저장
    const hasAbck = extras.cookies.some(c => c.name === '_abck');
    if (hasAbck) {
      try {
        const cookiesJson = JSON.stringify(extras.cookies, null, 0);
        result.cookies = Buffer.from(cookiesJson, 'utf-8').toString('base64');
      } catch (e) {
        // 쿠키 직렬화 실패 시 무시
      }
    }
  }

  return result;
}

/**
 * 실패 결과 생성
 */
function createFailureResult(allocationKey, errorType, errorMessage) {
  return {
    success: false,
    allocation_key: allocationKey,
    error_type: errorType,
    error_message: errorMessage
  };
}

/**
 * 메인 실행 함수
 */
async function main() {
  let task;
  let browserCore = null;
  let browserInfo = null;

  try {
    // 1. 환경변수에서 작업 정보 추출
    task = getTaskFromEnv();
    log(`작업 시작: ${task.keyword} (${task.productId})`);

    // 2. 화면 해상도 초기화
    await initializeScreenResolution().catch(() => {});

    // 3. Chrome 버전 및 프로필 설정
    const chromeVersionInfo = getRandomChromeVersion([]);
    const chromeMajorVersion = chromeVersionInfo.version.split('.')[0];

    // 프로필 경로 설정
    const folderNumber = String(task.threadNumber).padStart(2, '0');
    const folderKey = task.vpnDongle
      ? `vpn_${task.vpnDongle}/${folderNumber}/${chromeMajorVersion}`
      : `${folderNumber}/${chromeMajorVersion}`;

    const userFolderPath = path.join(process.cwd(), 'browser-data', folderKey);

    // 4. 프로필 디렉토리 생성
    if (!fs.existsSync(userFolderPath)) {
      fs.mkdirSync(userFolderPath, { recursive: true });
    }

    // 기존 프로필 정리 (5% 확률)
    if (Math.random() < 0.05) {
      log(`🧹 프로필 정리: ${folderKey}`);
      await cleanChromeProfile(userFolderPath);
    }

    // 5. 창 위치 및 크기 계산
    const windowPos = calculateWindowPosition(task.threadNumber - 1);
    const viewportSize = calculateViewportSize(task.threadNumber - 1);

    // windowPosition에 크기 정보 포함
    const windowPosition = {
      x: windowPos.x,
      y: windowPos.y,
      width: viewportSize.width,
      height: viewportSize.height
    };

    // 6. BrowserCore 초기화
    browserCore = new BrowserCore();

    // 7. 브라우저 시작
    log(`브라우저 시작 중... (Chrome ${chromeMajorVersion}, ${viewportSize.width}x${viewportSize.height})`);
    browserInfo = await browserCore.getBrowser({
      usePersistent: true,
      profileName: folderKey,
      userDataDir: userFolderPath,
      windowPosition: windowPosition,
      clearSession: false  // 세션 유지하여 빠른 시작
    });

    const page = browserInfo.page;

    // 8. 검색 실행 (executeKeywordSearch 내부에서 IP 체크 후 검색 페이지로 이동)
    log(`검색 실행: ${task.keyword} (work_type: ${task.workType})`);

    const searchResult = await executeKeywordSearch(page, {
      keyword: task.keyword,
      product_id: task.productId,
      item_id: task.itemId,
      vendor_item_id: task.vendorItemId,
      work_type: task.workType,
      allocation_key: task.allocationKey
    }, {
      // 검색 설정 - work_type에 따라 내부에서 maxPages 결정됨
      timeout: 60000
    });

    // 10. 결과 처리
    // searchAndClickProduct는 success, productFound, errorType, errorMessage 필드를 반환
    if (searchResult.success && searchResult.productFound) {
      log(`✅ 상품 발견 및 클릭 완료`);

      // 상품 상세 페이지 대기
      await page.waitForTimeout(3000);

      // 성공 시 extras 수집
      const extras = {
        chromeVersion: chromeVersionInfo.version
      };

      // VPN IP 가져오기 (환경변수에서)
      if (process.env.VPN_IP) {
        extras.vpnIp = process.env.VPN_IP;
      }

      // 쿠키 수집
      try {
        const cookies = await page.context().cookies();
        if (cookies && cookies.length > 0) {
          extras.cookies = cookies;
          log(`🍪 쿠키 수집: ${cookies.length}개`);
        }
      } catch (cookieErr) {
        // 쿠키 수집 실패 시 무시
      }

      outputResult(createSuccessResult(task.allocationKey, extras));
    } else {
      // errorType 매핑: searchResult.errorType + errorMessage 분석
      const errorMessage = searchResult.errorMessage || '알 수 없는 오류';
      const errType = searchResult.errorType?.toLowerCase() || '';
      const errMsg = errorMessage.toLowerCase();

      let errorType;

      // 1. BLOCKED: 차단 관련
      if (errType === 'blocked' || errType.includes('block') ||
          errType === 'access_denied' || errType.includes('denied') ||
          errMsg.includes('akamai') || errMsg.includes('403') ||
          errMsg.includes('access denied') || errMsg.includes('denied') ||
          errMsg.includes('차단')) {
        errorType = 'BLOCKED';
      }
      // 2. TIMEOUT: 타임아웃 관련
      else if (errType === 'timeout' || errType.includes('timeout') ||
               errMsg.includes('timeout') || errMsg.includes('exceeded') ||
               errMsg.includes('ip_check')) {
        errorType = 'TIMEOUT';
      }
      // 3. NOT_FOUND: 검색은 성공했으나 상품이 없는 경우만
      else if (errMsg.includes('상품을 찾을 수 없') ||
               errMsg.includes('not found') ||
               errMsg.includes('no results') ||
               errType === 'not_found') {
        errorType = 'NOT_FOUND';
      }
      // 4. DOM_ERROR: DOM 불안정
      else if (errType === 'dom_instability' || errMsg.includes('dom')) {
        errorType = 'DOM_ERROR';
      }
      // 5. EXCEPTION: 그 외 모든 에러
      else {
        errorType = 'EXCEPTION';
      }

      log(`❌ 검색 실패: ${errorType} - ${errorMessage}`);
      outputResult(createFailureResult(task.allocationKey, errorType, errorMessage));
    }

  } catch (error) {
    errorLog(`예외 발생: ${error.message}`);

    // 에러 타입 분류 (메시지 기반)
    const errMsg = error.message.toLowerCase();
    let errorType = 'EXCEPTION';

    if (errMsg.includes('http2') || errMsg.includes('net::err_http2_protocol_error')) {
      errorType = 'BLOCKED';
    } else if (errMsg.includes('access denied') || errMsg.includes('denied')) {
      errorType = 'BLOCKED';
    } else if (errMsg.includes('akamai') || errMsg.includes('403')) {
      errorType = 'BLOCKED';
    } else if (errMsg.includes('timeout') || errMsg.includes('exceeded') || errMsg.includes('ip_check')) {
      errorType = 'TIMEOUT';
    } else if (errMsg.includes('navigation') && !errMsg.includes('timeout')) {
      errorType = 'NAVIGATION_ERROR';
    } else if (errMsg.includes('target closed') || errMsg.includes('target crashed')) {
      errorType = 'BROWSER_CRASH';
    }

    outputResult(createFailureResult(
      task?.allocationKey || 'unknown',
      errorType,
      error.message.substring(0, 500)
    ));

    process.exitCode = 1;
  } finally {
    // 브라우저 정리 (타임아웃 5초)
    if (browserInfo && browserInfo.browser) {
      try {
        log(`브라우저 종료 중...`);
        // 5초 타임아웃으로 브라우저 종료
        await Promise.race([
          browserInfo.browser.close(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Browser close timeout')), 5000))
        ]);
        log(`브라우저 종료 완료`);
      } catch (e) {
        errorLog(`브라우저 종료 실패: ${e.message}`);
        // 강제 종료 시도
        try {
          browserInfo.browser.process()?.kill('SIGKILL');
        } catch (killErr) {
          // 무시
        }
      }
    }
  }
}

// 실행
main().catch(err => {
  errorLog(`치명적 오류: ${err.message}`);
  outputResult(createFailureResult('unknown', 'FATAL', err.message));
  process.exit(1);
});
