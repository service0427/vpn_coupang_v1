/**
 * 쿠팡 검색 페이지 네비게이션
 * - 다음 페이지 이동
 * - 점검 페이지 감지 및 재시도
 *
 * Updated: 2025-10-09 - coupang-handler.js에서 분리
 * Updated: 2025-10-09 - human-behavior 통합 (Akamai 차단 개선)
 * Updated: 2025-12-13 - Access Denied 로깅 통합
 */

const humanBehavior = require('../../utils/human-behavior');
const accessDeniedLogger = require('../../utils/access-denied-logger');

/**
 * 다음 페이지로 이동 (URL 기반)
 * @param {Page} page - Playwright 페이지 객체
 * @param {number} currentPageNum - 현재 페이지 번호 (1부터 시작)
 * @param {string} threadPrefix - 쓰레드 프리픽스
 * @returns {Object} 이동 결과 { success: boolean, error?: string }
 */
async function moveToNextPage(page, currentPageNum = 1, threadPrefix = '') {
  try {
    const currentUrl = page.url();

    // 프록시 리다이렉트 감지
    if (currentUrl.includes('192.168.') || currentUrl.includes('localhost') || currentUrl.includes('127.0.0.1')) {
      console.log(`${threadPrefix}   ⚠️ 프록시 리다이렉트 감지됨`);
      return { success: false, error: 'proxy_redirect', isLastPage: false };
    }

    // 다음 페이지 번호 계산
    const nextPageNum = currentPageNum + 1;
    console.log(`${threadPrefix}   🔄 페이지 ${currentPageNum} → ${nextPageNum} 이동 (URL 직접 방식)`);

    // 현재 URL에서 다음 페이지 URL 생성
    let nextPageUrl;
    if (currentUrl.includes('&page=') || currentUrl.includes('?page=')) {
      // 기존에 page 파라미터가 있는 경우 교체
      nextPageUrl = currentUrl.replace(/([&?])page=\d+/, `$1page=${nextPageNum}`);
    } else {
      // page 파라미터가 없는 경우 추가
      const separator = currentUrl.includes('?') ? '&' : '?';
      nextPageUrl = currentUrl + `${separator}page=${nextPageNum}`;
    }

    console.log(`${threadPrefix}   📍 이동할 URL: ${nextPageUrl}`);

    // 페이지 이동 전 짧은 대기 (사람처럼)
    await humanBehavior.randomDelay(page, 'BEFORE_CLICK');

    // 다음 페이지로 직접 이동
    await page.goto(nextPageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // 페이지 로드 후 자연스러운 대기
    await humanBehavior.randomDelay(page, 'AFTER_LOAD');

    // Access Denied 감지 및 재시도
    const maxRetries = 3;
    const retryDelay = 5000;

    // 동글/쓰레드 번호 추출
    const vpnMatch = threadPrefix.match(/\[vpn-(\d+)\]/i);
    const dongle = vpnMatch ? vpnMatch[1] : (process.env.VPN_DONGLE || 'standard');
    const threadMatch = threadPrefix.match(/\[(\d+)\]/);
    const threadNum = threadMatch ? parseInt(threadMatch[1]) : 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const pageTitle = await page.title();
      if (pageTitle.toLowerCase().includes('access denied')) {
        console.log(`${threadPrefix}   🚫 Access Denied 감지 (${attempt}/${maxRetries})`);

        // 첫 번째 시도에서만 감지 로깅
        if (attempt === 1) {
          accessDeniedLogger.logDetected({
            location: 'pagination',
            threadNum,
            dongle,
            keywordId: null,
            url: nextPageUrl,
            pageTitle,
          });
        }

        // 새로고침 시도 로깅
        accessDeniedLogger.logRefreshAttempt({
          attemptNum: attempt,
          threadNum,
          dongle,
          keywordId: null,
        });

        if (attempt < maxRetries) {
          console.log(`${threadPrefix}   ⏳ ${retryDelay/1000}초 후 재시도...`);
          await page.waitForTimeout(retryDelay);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await humanBehavior.randomDelay(page, 'AFTER_LOAD');
          continue;
        } else {
          // 복구 실패 로깅
          accessDeniedLogger.logFailed({
            threadNum,
            dongle,
            keywordId: null,
            finalError: 'Access Denied - 페이지네이션 재시도 초과',
          });

          console.log(`${threadPrefix}   ❌ Access Denied 재시도 초과 - 페이지 이동 실패`);
          return { success: false, error: 'access_denied', isLastPage: false };
        }
      }

      // Access Denied가 아니고 재시도 후 성공한 경우
      if (attempt > 1) {
        accessDeniedLogger.logRecovered({
          attemptNum: attempt,
          threadNum,
          dongle,
          keywordId: null,
          recoveryTimeMs: (attempt - 1) * retryDelay,
        });
      }
      break;  // Access Denied가 아니면 루프 종료
    }

    // 이동 후 URL 확인
    const newUrl = page.url();

    // 프록시 리다이렉트 재확인
    if (newUrl.includes('192.168.') || newUrl.includes('localhost') || newUrl.includes('127.0.0.1')) {
      console.log(`${threadPrefix}   ⚠️ 페이지 이동 중 프록시 리다이렉트 발생`);
      return { success: false, error: 'proxy_redirect', isLastPage: false };
    }

    // 점검 페이지 감지
    try {
      const pageContent = await page.content();
      if (pageContent.includes('더 나은 서비스를 위해 점검 중입니다') ||
          pageContent.includes('점검 중입니다') ||
          pageContent.includes('잠시만 기다려') ||
          pageContent.includes('서비스 점검')) {

        console.log(`${threadPrefix}   ⚠️ 페이지 이동 후 점검 페이지 감지, 최대 3회 새로고침 시도...`);

        // 최대 3회 새로고침 시도
        let retryCount = 0;
        const maxRetries = 3;
        let pageFixed = false;

        while (retryCount < maxRetries) {
          retryCount++;
          console.log(`${threadPrefix}   🔄 페이지 이동 후 새로고침 ${retryCount}/${maxRetries}...`);

          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await humanBehavior.randomDelay(page, 'AFTER_LOAD');

          // 다시 점검 페이지인지 확인
          const retryContent = await page.content();
          if (!retryContent.includes('점검 중') && !retryContent.includes('서비스 점검')) {
            pageFixed = true;
            console.log(`${threadPrefix}   ✅ ${retryCount}번째 새로고침으로 정상 페이지 로드`);
            break;
          }
        }

        if (!pageFixed) {
          console.log(`${threadPrefix}   ❌ ${maxRetries}회 새로고침 후에도 점검 페이지 지속`);
          return { success: false, error: 'maintenance_page', isLastPage: false };
        }
      }
    } catch (e) {
      // 점검 페이지 확인 실패는 무시하고 계속 진행
    }

    // 실제로 다음 페이지인지 확인 (URL의 page 파라미터 체크)
    const urlPageMatch = newUrl.match(/[&?]page=(\d+)/);
    const actualPageNum = urlPageMatch ? parseInt(urlPageMatch[1]) : 1;

    if (actualPageNum === nextPageNum) {
      console.log(`${threadPrefix}   ✅ 페이지 ${nextPageNum} 이동 성공`);
      return { success: true };
    } else if (actualPageNum < nextPageNum) {
      // 요청한 페이지보다 낮은 페이지로 리다이렉트된 경우 (마지막 페이지)
      console.log(`${threadPrefix}   ℹ️ 페이지 ${nextPageNum} 요청 → 페이지 ${actualPageNum}로 리다이렉트 (마지막 페이지)`);
      return { success: false, isLastPage: true };
    } else {
      console.log(`${threadPrefix}   ⚠️ 예상치 못한 페이지 번호: 요청 ${nextPageNum} → 실제 ${actualPageNum}`);
      return { success: false, isLastPage: false };
    }

  } catch (error) {
    console.log(`${threadPrefix}   ❌ 페이지 이동 중 오류: ${error.message}`);

    // 타임아웃이나 네트워크 오류의 경우 마지막 페이지일 가능성
    if (error.message.includes('timeout') || error.message.includes('net::')) {
      console.log(`${threadPrefix}   ℹ️ 네트워크 오류로 인한 실패 - 마지막 페이지 가능성`);
      return { success: false, isLastPage: true };
    }

    return { success: false, error: error.message, isLastPage: false };
  }
}

module.exports = {
  moveToNextPage
};
