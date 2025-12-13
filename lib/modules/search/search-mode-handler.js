/**
 * 쿠팡 검색 모드 처리
 * - URL 직접 모드
 * - 메인 페이지 검색 모드
 *
 * Updated: 2025-10-09 - coupang-handler.js에서 분리
 * Updated: 2025-10-09 - human-behavior 통합 (Akamai 차단 개선)
 * Updated: 2025-12-13 - Access Denied 로깅 통합
 */

const { errorLogger } = require('../api-service');
const humanBehavior = require('../../utils/human-behavior');
const accessDeniedLogger = require('../../utils/access-denied-logger');

/**
 * 검색 페이지로 이동 (두 가지 모드 지원)
 */
async function executeDirectMode(page, searchQuery, options = {}) {
  const idPrefix = options.keywordId ? `[ID:${options.keywordId}] ` : '';
  const threadPrefix = options.threadPrefix || '';

  // URL 직접 모드 vs 메인 페이지 검색 모드
  if (options.directUrl) {
    // ==================== URL 직접 모드 ====================
    console.log(`${threadPrefix} ${idPrefix}🌐 검색 결과 페이지 직접 접속 중... (URL 직접 모드)`);

    // 검색 URL 결정 (서버 제공 URL 우선, 없으면 기본 URL 생성)
    let searchUrl;

    if (options.searchUrl && typeof options.searchUrl === 'string' && options.searchUrl.includes('coupang.com/np/search')) {
      // 서버에서 제공한 URL이 유효한 경우 사용
      searchUrl = options.searchUrl;
      console.log(`${threadPrefix} ${idPrefix}📌 서버 제공 URL 사용`);
    } else {
      // 기본 URL 생성
      const encodedQuery = encodeURIComponent(searchQuery);
      searchUrl = `https://www.coupang.com/np/search?q=${encodedQuery}&channel=auto&listSize=72`;
      console.log(`${threadPrefix} ${idPrefix}📌 기본 URL 생성`);
    }

    try {
      // 메인 페이지 먼저 접속 (쿠키 생성 및 자연스러운 패턴)
      console.log(`${threadPrefix} ${idPrefix}🏠 쿠팡 메인 페이지 먼저 접속...`);
      await page.goto('https://www.coupang.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      console.log(`${threadPrefix} ${idPrefix}✅ 메인 페이지 접속 완료`);

      // 자연스러운 메인 페이지 탐색 (스크롤)
      console.log(`${threadPrefix} ${idPrefix}🔍 메인 페이지 둘러보는 중...`);
      const viewport = page.viewportSize();
      const scrollDown = viewport.height * (0.5 + Math.random() * 0.5);  // 화면 0.5~1배
      await page.evaluate((dist) => {
        window.scrollBy({ top: dist, behavior: 'smooth' });
      }, scrollDown);
      await page.waitForTimeout(800 + Math.random() * 400);

      // 다시 위로
      await page.evaluate(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      await page.waitForTimeout(400 + Math.random() * 300);

      console.log(`${threadPrefix} ${idPrefix}📍 URL: ${searchUrl}`);

      // Access Denied 재시도 설정
      const maxRetries = 3;
      const retryDelay = 5000;
      let lastError = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // 차단 감지를 위한 빠른 타임아웃 설정
          const gotoPromise = page.goto(searchUrl, {
            waitUntil: 'load',
            timeout: 40000
          });

          // ERR_HTTP2_PROTOCOL_ERROR 차단 에러 조기 감지 (3초 타임아웃)
          const earlyErrorDetection = new Promise((resolve, reject) => {
            let isResolved = false;

            // HTTP2_PROTOCOL_ERROR 즉시 감지
            const requestFailedHandler = (request) => {
              if (isResolved) return;
              const failure = request.failure();
              if (failure && failure.errorText.includes('HTTP2_PROTOCOL_ERROR')) {
                console.log(`${threadPrefix} ${idPrefix}🚫 차단 감지! 즉시 에러 처리`);
                isResolved = true;
                reject(new Error('쿠팡 접속 차단 감지됨'));
              }
            };
            page.on('requestfailed', requestFailedHandler);

            // 3초 내에 HTTP2_PROTOCOL_ERROR 패턴 감지시 즉시 실패
            const quickFailTimer = setTimeout(() => {
              if (!isResolved) {
                // 3초 후에도 로딩 중이면 차단 가능성 체크
                const currentUrl = page.url();
                if (currentUrl === 'about:blank' || currentUrl.includes('chrome-error://')) {
                  console.log(`${threadPrefix} ${idPrefix}🚫 3초 내 로딩 실패 - 차단 추정`);
                  isResolved = true;
                  reject(new Error('쿠팡 접속 차단 감지됨'));
                }
              }
            }, 3000);

            // 정상 로딩 완료시 resolve
            gotoPromise.then((result) => {
              if (!isResolved) {
                clearTimeout(quickFailTimer);
                page.off('requestfailed', requestFailedHandler);
                isResolved = true;
                resolve(result);
              }
            }).catch((error) => {
              if (!isResolved) {
                clearTimeout(quickFailTimer);
                page.off('requestfailed', requestFailedHandler);
                isResolved = true;
                reject(error);
              }
            });
          });

          // gotoPromise가 먼저 완료되거나 에러가 먼저 발생하면 즉시 반환
          await Promise.race([
            gotoPromise,
            earlyErrorDetection
          ]);

          // Access Denied 즉시 감지 (페이지 로드 후)
          const pageTitle = await page.title();
          if (pageTitle.toLowerCase().includes('access denied')) {
            console.log(`${threadPrefix} ${idPrefix}🚫 Access Denied 감지 (${attempt}/${maxRetries})`);

            // 동글 번호 추출
            const vpnMatch = threadPrefix.match(/\[vpn-(\d+)\]/i);
            const dongle = vpnMatch ? vpnMatch[1] : (process.env.VPN_DONGLE || 'standard');
            const threadMatch = threadPrefix.match(/\[(\d+)\]/);
            const threadNum = threadMatch ? parseInt(threadMatch[1]) : 0;

            // Access Denied 감지 로깅 (첫 번째 시도에서만)
            if (attempt === 1) {
              accessDeniedLogger.logDetected({
                location: 'page_load',
                threadNum,
                dongle,
                keywordId: options.keywordId,
                url: searchUrl,
                pageTitle,
              });
            }

            // 새로고침 시도 로깅
            accessDeniedLogger.logRefreshAttempt({
              attemptNum: attempt,
              threadNum,
              dongle,
              keywordId: options.keywordId,
            });

            if (attempt < maxRetries) {
              console.log(`${threadPrefix} ${idPrefix}⏳ ${retryDelay/1000}초 후 재시도...`);
              await page.waitForTimeout(retryDelay);
              continue;  // 다음 시도
            } else {
              // 복구 실패 로깅
              accessDeniedLogger.logFailed({
                threadNum,
                dongle,
                keywordId: options.keywordId,
                finalError: 'Access Denied - 페이지 로드 재시도 초과',
              });

              const blockError = new Error('쿠팡 접속 차단 감지됨 (Access Denied) - 재시도 초과');
              blockError.searchMode = 'direct';
              throw blockError;
            }
          }

          // 성공 - 재시도 후 성공한 경우 복구 로깅
          if (attempt > 1) {
            const vpnMatch = threadPrefix.match(/\[vpn-(\d+)\]/i);
            const dongle = vpnMatch ? vpnMatch[1] : (process.env.VPN_DONGLE || 'standard');
            const threadMatch = threadPrefix.match(/\[(\d+)\]/);
            const threadNum = threadMatch ? parseInt(threadMatch[1]) : 0;

            accessDeniedLogger.logRecovered({
              attemptNum: attempt,
              threadNum,
              dongle,
              keywordId: options.keywordId,
              recoveryTimeMs: attempt * retryDelay,  // 대략적인 복구 시간
            });
          }

          console.log(`${threadPrefix} ${idPrefix}✅ 검색 결과 페이지 도달`);
          break;  // 루프 종료

        } catch (retryError) {
          lastError = retryError;

          // HTTP2_PROTOCOL_ERROR는 재시도 불가
          if (retryError.message.includes('HTTP2_PROTOCOL_ERROR') ||
              retryError.message.includes('쿠팡 접속 차단 감지됨')) {
            throw retryError;
          }

          // 다른 에러는 재시도
          if (attempt < maxRetries) {
            console.log(`${threadPrefix} ${idPrefix}⚠️ 에러 발생 (${attempt}/${maxRetries}): ${retryError.message}`);
            console.log(`${threadPrefix} ${idPrefix}⏳ ${retryDelay/1000}초 후 재시도...`);
            await page.waitForTimeout(retryDelay);
          } else {
            throw retryError;
          }
        }
      }

      return {
        success: true,
        message: 'URL 직접 모드 실행 성공',
        searchMode: 'direct'
      };

    } catch (error) {
      // 프록시 연결 실패 시 즉시 종료
      if (error.message.includes('ERR_PROXY_CONNECTION_FAILED') ||
          error.message.includes('ERR_CONNECTION_REFUSED') ||
          error.message.includes('ERR_NETWORK_CHANGED')) {
        console.log(`${threadPrefix} ${idPrefix}🚨 프록시 연결 실패 - 즉시 종료`);
        console.log(`${threadPrefix} ${idPrefix}   에러: ${error.message}`);
        const proxyError = new Error('PROXY_FAILED: ' + error.message);
        proxyError.searchMode = 'direct';
        throw proxyError;
      }

      // HTTP2_PROTOCOL_ERROR 즉시 처리
      if (error.message.includes('HTTP2_PROTOCOL_ERROR')) {
        console.log(`${threadPrefix} ${idPrefix}🚫 차단으로 인한 즉시 실패`);
        const blockError = new Error('쿠팡 접속 차단 감지됨');
        blockError.searchMode = 'direct';
        throw blockError;
      }

      console.log(`${threadPrefix} ${idPrefix}❌ URL 직접 모드 실행 실패: ${error.message}`);

      await errorLogger.logError({
        errorMessage: `URL 직접 모드 실행 실패: ${error.message}`,
        pageUrl: page.url(),
        keywordId: options.keywordId,
        agent: options.agent
      });

      return {
        success: false,
        errorMessage: error.message,
        searchMode: 'direct'  // URL 직접 모드
      };
    }

  } else {
    // ==================== 메인 페이지 검색 모드 ====================
    console.log(`${threadPrefix} ${idPrefix}🏠 쿠팡 메인 페이지 접속 중...`);

    try {
      // 1. 메인 페이지 접속 (완전 로드 불필요, 검색창만 있으면 됨)
      const mainUrl = 'https://www.coupang.com/';
      console.log(`${threadPrefix} ${idPrefix}📍 URL: ${mainUrl}`);

      // 페이지 접속 시작 (완전 로드를 기다리지 않음)
      page.goto(mainUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      }).catch(err => {
        // 타임아웃 에러는 무시 (검색창이 있으면 계속 진행)
        console.log(`${threadPrefix} ${idPrefix}⚠️ 페이지 로드 타임아웃 (무시)`);
      });

      // 2. 점검 페이지 감지 및 새로고침 처리
      console.log(`${threadPrefix} ${idPrefix}🔍 페이지 상태 확인 중...`);

      try {
        const pageContent = await page.content();
        if (pageContent.includes('더 나은 서비스를 위해 점검 중입니다') ||
            pageContent.includes('점검 중입니다') ||
            pageContent.includes('잠시만 기다려') ||
            pageContent.includes('서비스 점검')) {

          console.log(`${threadPrefix} ${idPrefix}⚠️ 점검 페이지 감지, 최대 3회 새로고침 시도...`);

          // 최대 3회 새로고침 시도
          let retryCount = 0;
          const maxRetries = 3;
          let pageFixed = false;

          while (retryCount < maxRetries) {
            retryCount++;
            console.log(`${threadPrefix} ${idPrefix}🔄 새로고침 ${retryCount}/${maxRetries}...`);

            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            // 다시 점검 페이지인지 확인
            const retryContent = await page.content();
            if (!retryContent.includes('점검 중') && !retryContent.includes('서비스 점검')) {
              pageFixed = true;
              console.log(`${threadPrefix} ${idPrefix}✅ ${retryCount}번째 새로고침으로 정상 페이지 로드`);
              break;
            }
          }

          if (!pageFixed) {
            console.log(`${threadPrefix} ${idPrefix}❌ ${maxRetries}회 새로고침 후에도 점검 페이지 지속`);
            throw new Error('쿠팡 점검 중 - 메인 페이지 접근 불가');
          }
        }
      } catch (e) {
        // 점검 페이지 체크 실패는 무시하고 계속 진행 (에러 던지기 제외)
        if (e.message.includes('점검')) {
          throw e;
        }
      }

      // 3. 검색창 찾기 (최대 20초)
      console.log(`${threadPrefix} ${idPrefix}🔍 검색창 찾는 중 (최대 20초)...`);
      const searchInputSelector = 'input.headerSearchKeyword.coupang-search.is-speech';

      try {
        await page.waitForSelector(searchInputSelector, { timeout: 20000 });
        console.log(`${threadPrefix} ${idPrefix}✅ 검색창 발견 - 페이지 준비 완료`);
      } catch (error) {
        // 검색창을 찾지 못하면 에러
        console.log(`${threadPrefix} ${idPrefix}❌ 검색창을 찾을 수 없음`);
        throw new Error('메인 페이지 검색창을 찾을 수 없음');
      }

      // 4. 자연스러운 메인 페이지 탐색 (스크롤)
      console.log(`${threadPrefix} ${idPrefix}🔍 메인 페이지 둘러보는 중...`);
      const mainViewport = page.viewportSize();
      const mainScrollDown = mainViewport.height * (0.5 + Math.random() * 0.5);  // 화면 0.5~1배
      await page.evaluate((dist) => {
        window.scrollBy({ top: dist, behavior: 'smooth' });
      }, mainScrollDown);
      await page.waitForTimeout(800 + Math.random() * 400);

      // 다시 위로
      await page.evaluate(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      await page.waitForTimeout(400 + Math.random() * 300);

      // 5. 페이지 로드 후 자연스러운 행동 (생각하는 시간 + 마우스 움직임)
      console.log(`${threadPrefix} ${idPrefix}⏳ 페이지 확인 중...`);
      await humanBehavior.afterPageLoad(page);

      // 6. 검색 전 자연스러운 행동
      await humanBehavior.beforeSearch(page);

      // 검색창 클릭 (포커스)
      console.log(`${threadPrefix} ${idPrefix}🖱️ 검색창 클릭...`);
      await page.click(searchInputSelector);

      // 6. 검색어 자연스럽게 타이핑 (글자별 랜덤 속도)
      console.log(`${threadPrefix} ${idPrefix}⌨️ 검색어 타이핑 중: "${searchQuery}"`);
      await humanBehavior.naturalTyping(page, searchInputSelector, searchQuery);

      // 7. 타이핑 후 짧은 대기
      await humanBehavior.randomDelay(page, 'BEFORE_CLICK');

      // 8. 엔터키로 검색 실행
      console.log(`${threadPrefix} ${idPrefix}⏎ 엔터키로 검색 실행...`);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 40000 }),
        page.press(searchInputSelector, 'Enter')
      ]);

      console.log(`${threadPrefix} ${idPrefix}✅ 검색 결과 페이지 도달`);
      console.log(`${threadPrefix} ${idPrefix}📍 현재 URL: ${page.url()}`);

      return {
        success: true,
        message: '메인 페이지에서 검색 실행 성공',
        searchMode: 'main'
      };

    } catch (error) {
      // 프록시 연결 실패 시 즉시 종료
      if (error.message.includes('ERR_PROXY_CONNECTION_FAILED') ||
          error.message.includes('ERR_CONNECTION_REFUSED') ||
          error.message.includes('ERR_NETWORK_CHANGED')) {
        console.log(`${threadPrefix} ${idPrefix}🚨 프록시 연결 실패 - 즉시 종료`);
        console.log(`${threadPrefix} ${idPrefix}   에러: ${error.message}`);
        const proxyError = new Error('PROXY_FAILED: ' + error.message);
        proxyError.searchMode = 'main';
        throw proxyError;
      }

      // HTTP2_PROTOCOL_ERROR 즉시 처리
      if (error.message.includes('HTTP2_PROTOCOL_ERROR')) {
        console.log(`${threadPrefix} ${idPrefix}🚫 차단으로 인한 즉시 실패`);
        const blockError = new Error('쿠팡 접속 차단 감지됨');
        blockError.searchMode = 'main';
        throw blockError;
      }

      console.log(`${threadPrefix} ${idPrefix}❌ 메인 페이지 검색 모드 실행 실패: ${error.message}`);

      await errorLogger.logError({
        errorMessage: `메인 페이지 검색 모드 실행 실패: ${error.message}`,
        pageUrl: page.url(),
        keywordId: options.keywordId,
        agent: options.agent
      });

      return {
        success: false,
        errorMessage: error.message,
        searchMode: 'main'  // 메인 페이지 검색 모드
      };
    }
  }
}

module.exports = {
  executeDirectMode
};
