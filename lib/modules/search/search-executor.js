/**
 * 쿠팡 상품 검색 및 클릭 실행
 * - 검색 오케스트레이션
 * - 상품 찾기 및 클릭
 * - 장바구니 처리
 *
 * Updated: 2025-10-09 - coupang-handler.js에서 분리
 */

const { errorLogger } = require('../api-service');
const { ExecutionStatus } = require('../../constants');
const { checkIP, checkIP_Packet, checkWebDriverStatus } = require('../../utils/browser-helpers');
const { setActualIp } = require('../../core/optimizer');
const { extractProductList } = require('../product/product-list-extractor');
const { findTargetProduct, clickProduct } = require('../product/product-click-handler');
const { handleCart } = require('../product/cart-handler');
const { executeDirectMode } = require('./search-mode-handler');
const { moveToNextPage } = require('./pagination-handler');

/**
 * Result 객체 초기화 헬퍼
 */
function initializeResult() {
  return {
    success: false,
    successLevel: 0,
    currentPage: 0,
    productsFound: 0,
    actualIp: null,
    errorMessage: null,
    errorType: null,
    executionStatus: ExecutionStatus.UNKNOWN,
    productFound: false,
    productRank: null,
    pagesSearched: 0,
    cartClicked: false,
    durationMs: 0,
    urlRank: null,
    realRank: null,
    itemId: null,
    vendorItemId: null
  };
}

/**
 * Result 객체에 공통 필드 설정 헬퍼
 */
function setCommonResultFields(result, actualIp, startTime) {
  result.actualIp = actualIp;
  result.durationMs = Date.now() - startTime;
  return result;
}

/**
 * 특정 상품 코드 검색 및 클릭
 * @param {Page} page - Playwright 페이지 객체
 * @param {Object} options - 검색 옵션
 * @returns {Object} 실행 결과
 */
async function searchAndClickProduct(page, options = {}) {
  const {
    keyword = '노트북',
    suffix = '',
    productId = '',
    searchUrl = null,  // 서버에서 제공하는 검색 URL
    cartClickEnabled = false,
    maxPages = 10,  // 기본값 10페이지로 제한
    proxyConfig = null,
    keywordId = null,
    agent = null,
    threadPrefix = ''
  } = options;

  const startTime = Date.now();
  const result = initializeResult();

  let actualIp = null;
  let totalProductsSearched = 0; // 전체 함수 스코프로 이동
  let lastSearchPageUrl = null; // 마지막 검색 페이지 URL 추적 - catch 블록에서도 접근 가능하도록 이동
  let latestCookies = null; // 페이지 로드 시마다 갱신되는 쿠키

  try {
    // IP 확인 단계 - 브라우저 시작 후 실행
    console.log(`${threadPrefix} 🌐 IP 확인 중...`);
    const ipCheckResult = await checkIP(page, threadPrefix);
    actualIp = ipCheckResult?.ip || null;

    // Akamai CSV 로깅용 IP 설정 (allocation_key로 세션 구분)
    const allocationKey = options.keywordData?.allocation_key;
    if (allocationKey) {
      setActualIp(allocationKey, actualIp);
    }

    // 프록시 실패 처리
    if (ipCheckResult && !ipCheckResult.success) {
      // SSL 차단 감지 - 새로운 에러 타입들 처리
      if (ipCheckResult.errorType && ipCheckResult.errorType.startsWith('error_ssl_')) {
        const sslErrorMessage = `SSL/TLS 차단: ${ipCheckResult.error}`;
        console.log(`${threadPrefix} 🔒 ${sslErrorMessage}`);

        result.errorMessage = sslErrorMessage;
        result.errorType = ipCheckResult.errorType; // 세분화된 SSL 에러 타입 사용
        result.executionStatus = ExecutionStatus.ERROR_BLOCKED;
        setCommonResultFields(result, actualIp, startTime);

        console.log(`${threadPrefix} ❌ SSL 차단으로 인한 실패`)

        return result;
      }

      const proxyErrorMessage = ipCheckResult.error;  // 이미 간결한 메시지
      console.log(`${threadPrefix} ❌ 프록시 오류: ${proxyErrorMessage}`);

      result.errorMessage = proxyErrorMessage;
      result.errorType = ipCheckResult.errorType || 'proxy_failure'; // 세분화된 에러 타입 사용
      result.executionStatus = ExecutionStatus.ERROR_PROXY;
      setCommonResultFields(result, actualIp, startTime);

      console.log(`${threadPrefix} ❌ 프록시 실패: ${proxyErrorMessage}`)

      return result;
    }

    console.log(`${threadPrefix} ✅ 프록시 정상 - 외부 IP: ${actualIp}`);

    // 검색어 조합
    const searchQuery = suffix ? `${keyword} ${suffix}` : keyword;
    const keywordInfo = options.keywordId ? `[ID: ${options.keywordId}] ` : '';
    console.log(`${threadPrefix} 🔍 ${keywordInfo}검색어: "${searchQuery}"`);
    console.log(`${threadPrefix} 🎯 ${keywordInfo}찾을 상품 코드: ${productId || '없음 (필수)'}`);
    console.log(`${threadPrefix} `);

    // URL 직접 모드로만 페이지 접근
    const directOptions = {
      ...options,
      threadPrefix
    };

    let directResult;
    try {
      directResult = await executeDirectMode(page, searchQuery, directOptions);
      result.searchMode = directResult.searchMode;  // 검색 모드 저장 (성공/실패 모두)
    } catch (error) {
      // throw된 에러에서도 searchMode 가져오기
      result.searchMode = error.searchMode || 'unknown';
      result.errorMessage = error.message;
      console.log(`${threadPrefix} ❌ 페이지 접근 실패 (예외): ${error.message}`);
      throw error;  // 상위로 전파
    }

    if (!directResult.success) {
      result.errorMessage = directResult.errorMessage;
      console.log(`${threadPrefix} ❌ 페이지 접근 실패: ${directResult.errorMessage}`);
      await page.waitForTimeout(5000);
      return result;
    }

    // 페이지 도달 로그
    // 페이지 도달 확인

    await page.waitForTimeout(3000);

    // 검색 페이지 로드 성공 - 쿠키 저장
    try {
      latestCookies = await page.context().cookies();
    } catch (e) {
      // 쿠키 조회 실패는 무시
    }

    // 프록시 리다이렉트 체크 (192.168.x.x, localhost 감지)
    const currentUrl = page.url();
    if (currentUrl.includes('192.168.') || currentUrl.includes('localhost') || currentUrl.includes('127.0.0.1')) {
      console.log(`${threadPrefix} ⚠️ 프록시 리다이렉트 감지: ${currentUrl}`);
      console.log(`${threadPrefix} ❌ 네트워크 연결 문제로 검색 중단`);

      // 리다이렉트된 탭들 닫기
      const pages = await page.context().pages();
      if (pages.length > 1) {
        for (const p of pages) {
          const url = p.url();
          if (url.includes('192.168.') || url.includes('localhost') || url.includes('127.0.0.1')) {
            console.log(`${threadPrefix} 🔧 리다이렉트 탭 닫기: ${url}`);
            await p.close().catch(() => {});
          }
        }
      }

      result.errorMessage = '프록시 리다이렉트 발생 - 네트워크 연결 문제';
      result.errorType = 'proxy_redirect';
      result.executionStatus = ExecutionStatus.ERROR_NETWORK;
      return result;
    }

    // WebDriver 상태 확인 (네비게이션 중 오류 방지)
    try {
      await checkWebDriverStatus(page);
    } catch (error) {
      if (error.message.includes('Execution context was destroyed')) {
        console.log(`${threadPrefix} ⚠️ WebDriver 상태 확인 중 페이지 전환 감지 - 정상 진행`);
      } else {
        console.log(`${threadPrefix} ⚠️ WebDriver 상태 확인 실패: ${error.message}`);
      }
    }

    // 상품 검색 시작
    let productFound = false;
    let totalNonAdProducts = 0; // 전체 비광고 제품 누적 카운터

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      // pagesSearched는 완료된 페이지만 카운트 (나중에 설정)

      console.log(`${threadPrefix} 📄 ${keywordInfo}페이지 ${pageNum} 검색 중...`);

      // 현재 검색 페이지 URL 저장 (referer로 사용)
      lastSearchPageUrl = page.url();

      // 각 페이지 진입 시 프록시 리다이렉트 체크
      const pageUrl = page.url();
      if (pageUrl.includes('192.168.') || pageUrl.includes('localhost') || pageUrl.includes('127.0.0.1')) {
        console.log(`${threadPrefix} ⚠️ 페이지 ${pageNum}에서 프록시 리다이렉트 감지: ${pageUrl}`);
        console.log(`${threadPrefix} ❌ 네트워크 연결 문제로 검색 중단`);

        result.errorMessage = '검색 중 프록시 리다이렉트 발생';
        result.errorType = 'proxy_redirect';
        result.referer = lastSearchPageUrl;
        break;
      }

      // 상품 목록 추출
      let products;
      try {
        products = await extractProductList(page, productId, options.keywordId, threadPrefix, pageNum);
        totalProductsSearched += products.length;
        // console.log(`${threadPrefix} ✅ 상품 목록 추출 성공 (${products.length}개)`);

        // 상품 목록 추출 성공 - 쿠키 갱신
        try {
          latestCookies = await page.context().cookies();
        } catch (e) {
          // 쿠키 조회 실패는 무시
        }
      } catch (error) {
        // 검색 결과 없음 특별 처리 (에러가 아님)
        if (error.errorType === 'no_results') {
          console.log(`${threadPrefix} 📭 검색 결과 없음 - 정상 처리`);
          console.log(`${threadPrefix}    에러 발생 페이지: ${error.currentPage || pageNum}페이지`);
          console.log(`${threadPrefix}    ⛔ 페이지 반복 중단 - 더 이상 다음 페이지로 이동하지 않음`);

          // rank나 click 모드에서도 성공으로 처리
          result.success = true;
          result.productFound = false;
          result.productRank = 0;
          result.urlRank = 0;
          result.realRank = 0;

          // 페이지를 100 + 현재페이지로 설정 (로그 분석용)
          result.pagesSearched = 100 + pageNum;

          // 특별한 메시지 설정 (에러 메시지가 아닌 정보성 메시지)
          result.errorMessage = null; // 에러가 아니므로 null
          result.errorType = null; // 에러가 아니므로 null
          result.referer = lastSearchPageUrl;

          // productFound를 true로 설정하여 for 루프 조건을 만족시켜 종료
          productFound = true; // 루프 종료를 위해 추가

          // 에러 로깅하지 않고 루프 종료
          break;
        }

        // 실제 에러인 경우만 에러 로그 출력
        console.log(`${threadPrefix} ❌ ${error.message}`);
        result.errorMessage = error.message;

        // 에러 로깅
        await errorLogger.logError({
          errorMessage: error.message,
          pageUrl: page.url(),
          proxyUsed: proxyConfig?.server,
          actualIp: actualIp,
          keywordId: options.keywordId,
          agent: options.agent
        });

        // Access Denied 에러 처리 (3회 새로고침 실패 후)
        if (error.errorType === 'access_denied') {
          console.log(`${threadPrefix} 🚫 Access Denied로 검색 중단`);
          result.errorType = 'access_denied';
          result.errorMessage = error.message;
          result.referer = lastSearchPageUrl;
          break;  // 페이지 반복 중단
        }

        // 차단 에러인지 확인
        if (error.errorType === 'blocked' ||
            error.message.includes('ERR_HTTP2_PROTOCOL_ERROR') ||
            error.message.includes('쿠팡 접속 차단')) {

          // rank 모드에서 5페이지 이상 검색했으면 부분 성공으로 처리
          if (options.workType === 'rank' && result.pagesSearched >= 5) {
            console.log(`${threadPrefix} ⚠️ HTTP2 차단 감지 - ${pageNum}페이지에서 차단되었지만 충분한 데이터 수집`);
            console.log(`${threadPrefix}    ✅ rank 모드 부분 성공으로 처리 (${result.pagesSearched}페이지 완료)`);

            // 현재까지의 결과를 성공으로 처리
            result.success = true;
            result.partialSuccess = true;
            result.errorType = 'partial_blocked';
            result.errorMessage = `${result.pagesSearched}페이지 검색 후 차단 (부분 성공)`;
            result.referer = lastSearchPageUrl;

            // 정상적으로 루프를 종료 (에러를 throw하지 않음)
            break;
          } else {
            // 기존 차단 처리 (1~4페이지 또는 rank가 아닌 경우)
            console.log(`${threadPrefix} 🚫 HTTP2 차단 감지 - 페이지 ${pageNum}에서 검색 중단`);
            console.log(`${threadPrefix}    🔴 ERR_HTTP2_PROTOCOL_ERROR - 명확한 차단 신호`);
            if (options.workType === 'rank') {
              console.log(`${threadPrefix}    ⚠️ rank 모드 조기 차단 (완료: ${result.pagesSearched}페이지, 시도: ${pageNum}페이지) - 실패 처리`);
            }
            console.log(`${threadPrefix}    💡 프록시 변경 필요`);

            result.errorType = 'blocked';
            result.errorMessage = '쿠팡 접속 차단 (HTTP2_PROTOCOL_ERROR)';
            result.referer = lastSearchPageUrl;

            // 차단 에러는 상위로 전파하여 즉시 종료
            const blockError = new Error('쿠팡 접속 차단 (HTTP2_PROTOCOL_ERROR)');
            blockError.errorType = 'blocked';
            throw blockError;
          }
        }

        // 심각한 페이지 오류인지 확인
        const isPageAccessible = !error.message.includes('사이트에 연결할 수 없음') &&
                                 !error.message.includes('net::ERR_');

        if (!isPageAccessible) {
          console.log(`${threadPrefix} 🚫 페이지 접근 불가능, 검색 중단`);
          result.referer = lastSearchPageUrl;
          break;
        }

        // 상품 목록 추출 실패시에도 다음 페이지 시도
        products = [];
        console.log(`${threadPrefix} ⚠️ 이 페이지에서 상품을 찾을 수 없음, 다음 페이지 시도...`);
      }

      // 현재 페이지의 비광고 제품 수 계산 (타겟 상품 찾기 전에)
      const currentPageNonAdCount = products.filter(p => !p.isAd).length;

      // 타겟 상품 찾기
      const targetProduct = findTargetProduct(products, productId, options.keywordId, threadPrefix, options.itemId, options.vendorItemId);

      if (targetProduct) {
        const urlRank = targetProduct.urlRank ?? ((pageNum - 1) * 72 + targetProduct.rank);
        console.log(`${threadPrefix} ✅ 상품 발견 (${pageNum}페이지, 순위: ${urlRank})`);

        // 타겟 상품의 실제 누적 순위 계산
        targetProduct.cumulativeRealRank = totalNonAdProducts + targetProduct.realRank;

        // work_type이 "rank" 또는 "idle"인 경우 클릭 없이 리스트 정보만 사용
        if (options.workType === 'rank' || options.workType === 'idle') {
          console.log(`${threadPrefix} 📊 순위 확인 모드 - 상품 클릭 생략`);

          // 이미 수집된 리스트 정보로 결과 구성
          result.success = true;
          result.productFound = true;
          result.productRank = ((pageNum - 1) * products.length) + targetProduct.rank;
          result.urlRank = targetProduct.urlRank || result.productRank;
          result.realRank = targetProduct.cumulativeRealRank;
          result.itemId = targetProduct.itemId || null;
          result.vendorItemId = targetProduct.vendorItemId || null;
          result.productInfo = {
            name: targetProduct.productName || '',
            rating: targetProduct.rating || null,
            reviewCount: targetProduct.reviewCount || null,
            productId: targetProduct.productId || '',
            url: targetProduct.href
          };
          result.referer = page.url();  // 현재 검색 페이지 URL
          result.targetProduct = targetProduct;
          result.cartClicked = false;

          console.log(`${threadPrefix} ✅ 순위 확인 완료: ${result.productRank}위`);
          console.log(`${threadPrefix}    평점: ${targetProduct.rating || 'N/A'}, 리뷰: ${targetProduct.reviewCount || 0}개`);

          productFound = true;
          break;

        } else {
          // work_type에 'click'이 포함된 경우만 클릭 수행
          try {
            const allocationKey = options.keywordData?.allocation_key || null;
            const clickResult = await clickProduct(page, targetProduct, productId, pageNum, products.length, options.keywordId, threadPrefix, products, options.workType, allocationKey);

            result.success = true;
            result.productFound = true;
            result.productRank = clickResult.productRank;
            result.urlRank = clickResult.urlRank;
            result.realRank = targetProduct.cumulativeRealRank;
            result.itemId = clickResult.itemId;
            result.vendorItemId = clickResult.vendorItemId;
            result.productInfo = clickResult.productInfo;
            result.referer = clickResult.referer;
            result.targetProduct = targetProduct;  // 추가 데이터 포함

            console.log(`${threadPrefix} ✅ 상품 클릭 성공`);

            // 장바구니 처리
            const cartResult = await handleCart(page, cartClickEnabled, options.keywordId, threadPrefix);
            result.cartClicked = cartResult.cartClicked;

            if (cartClickEnabled) {
              console.log(`${threadPrefix} 🛒 장바구니 클릭: ${cartResult.cartClicked ? '성공' : '실패'}`);
            }

            productFound = true;
            break;

          } catch (error) {
            console.log(`${threadPrefix} ❌ ${keywordInfo}[상품 처리 오류]`);
            console.log(`${threadPrefix}    ${keywordInfo}발생 위치: ${error.stack ? error.stack.split('\n')[1].trim() : '알 수 없음'}`);
            console.log(`${threadPrefix}    ${keywordInfo}에러 메시지: ${error.message}`);

            // 상품은 찾았지만 클릭만 실패한 경우 부분 성공으로 처리
            if (targetProduct) {
              result.productFound = true;  // 상품은 찾았음
              result.productRank = targetProduct.rank;
              result.urlRank = targetProduct.urlRank ?? targetProduct.rank;
              result.realRank = targetProduct.cumulativeRealRank || targetProduct.realRank;
              result.errorMessage = `상품 발견 but 클릭 실패: ${error.message}`;

              // referer 보존 (error 객체에 있으면 사용, 없으면 현재 페이지 URL)
              result.referer = error.referer || lastSearchPageUrl;

              console.log(`${threadPrefix}    ⚠️ 상품은 발견했으나 클릭 실패 (${pageNum}페이지, ${targetProduct.rank}순위)`);
            } else {
              result.errorMessage = error.message;
              result.referer = error.referer || lastSearchPageUrl;
            }

            break;
          }
        }
      } else {
        // 상품 미발견 - 1페이지이고 메인 페이지 검색 모드이면 72개로 확장 재검색
        if (pageNum === 1 && result.searchMode === 'main') {
          const currentUrl = page.url();

          // 이미 72개가 아니면 확장
          if (!currentUrl.includes('listSize=72')) {
            console.log(`${threadPrefix} 🔍 ${keywordInfo}1페이지 상품 미발견 - listSize=72로 확장 재검색`);

            // URL 수정
            let expandedUrl;
            if (currentUrl.includes('listSize=')) {
              expandedUrl = currentUrl.replace(/listSize=\d+/, 'listSize=72');
            } else {
              const separator = currentUrl.includes('?') ? '&' : '?';
              expandedUrl = currentUrl + `${separator}listSize=72`;
            }

            console.log(`${threadPrefix} 📍 확장 URL: ${expandedUrl}`);

            // 페이지 이동
            await page.goto(expandedUrl, { waitUntil: 'load', timeout: 40000 });
            await page.waitForTimeout(2000);

            // 쿠키 갱신
            try {
              latestCookies = await page.context().cookies();
            } catch (e) {
              // 쿠키 조회 실패는 무시
            }

            // 72개 확장 후 재검색
            try {
              products = await extractProductList(page, productId, options.keywordId, threadPrefix, pageNum);
              totalProductsSearched += products.length;
              console.log(`${threadPrefix} ✅ 72개 확장 후 재추출 (${products.length}개)`);

              // 쿠키 갱신
              try {
                latestCookies = await page.context().cookies();
              } catch (e) {}

              // 비광고 제품 수 재계산
              const expandedNonAdCount = products.filter(p => !p.isAd).length;

              // 타겟 상품 재검색
              const expandedTarget = findTargetProduct(products, productId, options.keywordId, threadPrefix, options.itemId, options.vendorItemId);

              if (expandedTarget) {
                const urlRank = expandedTarget.urlRank ?? ((pageNum - 1) * 72 + expandedTarget.rank);
                console.log(`${threadPrefix} ✅ 72개 확장 후 상품 발견 (${pageNum}페이지, 순위: ${urlRank})`);

                expandedTarget.cumulativeRealRank = totalNonAdProducts + expandedTarget.realRank;

                // work_type별 처리
                if (options.workType === 'rank' || options.workType === 'idle') {
                  result.success = true;
                  result.productFound = true;
                  result.productRank = ((pageNum - 1) * products.length) + expandedTarget.rank;
                  result.urlRank = expandedTarget.urlRank || result.productRank;
                  result.realRank = expandedTarget.cumulativeRealRank;
                  result.itemId = expandedTarget.itemId || null;
                  result.vendorItemId = expandedTarget.vendorItemId || null;
                  result.productInfo = {
                    name: expandedTarget.productName || '',
                    rating: expandedTarget.rating || null,
                    reviewCount: expandedTarget.reviewCount || null,
                    productId: expandedTarget.productId || '',
                    url: expandedTarget.href
                  };
                  result.referer = page.url();
                  result.targetProduct = expandedTarget;
                  result.cartClicked = false;

                  console.log(`${threadPrefix} ✅ 순위 확인 완료: ${result.productRank}위`);
                  console.log(`${threadPrefix}    평점: ${expandedTarget.rating || 'N/A'}, 리뷰: ${expandedTarget.reviewCount || 0}개`);

                  productFound = true;
                  break;
                } else {
                  // click 모드
                  try {
                    const allocationKey2 = options.keywordData?.allocation_key || null;
                    const clickResult = await clickProduct(page, expandedTarget, productId, pageNum, products.length, options.keywordId, threadPrefix, products, options.workType, allocationKey2);

                    result.success = true;
                    result.productFound = true;
                    result.productRank = clickResult.productRank;
                    result.urlRank = clickResult.urlRank;
                    result.realRank = expandedTarget.cumulativeRealRank;
                    result.itemId = clickResult.itemId;
                    result.vendorItemId = clickResult.vendorItemId;
                    result.productInfo = clickResult.productInfo;
                    result.referer = clickResult.referer;
                    result.targetProduct = expandedTarget;

                    console.log(`${threadPrefix} ✅ 상품 클릭 성공`);

                    const cartResult = await handleCart(page, cartClickEnabled, options.keywordId, threadPrefix);
                    result.cartClicked = cartResult.cartClicked;

                    if (cartClickEnabled) {
                      console.log(`${threadPrefix} 🛒 장바구니 클릭: ${cartResult.cartClicked ? '성공' : '실패'}`);
                    }

                    productFound = true;
                    break;
                  } catch (error) {
                    console.log(`${threadPrefix} ❌ ${keywordInfo}[72개 확장 후 상품 클릭 실패]`);
                    console.log(`${threadPrefix}    ${keywordInfo}에러 메시지: ${error.message}`);

                    if (expandedTarget) {
                      result.productFound = true;
                      result.productRank = expandedTarget.rank;
                      result.urlRank = expandedTarget.urlRank ?? expandedTarget.rank;
                      result.realRank = expandedTarget.cumulativeRealRank || expandedTarget.realRank;
                      result.errorMessage = `상품 발견 but 클릭 실패: ${error.message}`;
                      result.referer = error.referer || lastSearchPageUrl;

                      console.log(`${threadPrefix}    ⚠️ 상품은 발견했으나 클릭 실패 (${pageNum}페이지, ${expandedTarget.rank}순위)`);
                    } else {
                      result.errorMessage = error.message;
                      result.referer = error.referer || lastSearchPageUrl;
                    }

                    break;
                  }
                }
              } else {
                console.log(`${threadPrefix} ℹ️ 72개 확장 후에도 상품 미발견 - 다음 페이지로 이동`);
              }
            } catch (error) {
              console.log(`${threadPrefix} ⚠️ 72개 확장 후 재검색 실패: ${error.message}`);
              // 에러 발생 시 다음 페이지로 계속 진행
            }
          }
        }
      }

      // 다음 페이지로 이동하기 전에 현재 페이지의 비광고 제품 수 누적
      totalNonAdProducts += currentPageNonAdCount;

      // 페이지 처리가 성공적으로 완료되었으므로 카운트 증가
      result.pagesSearched = pageNum;

      // 마지막 페이지가 아니면 다음 페이지로
      if (pageNum < maxPages && !productFound) {
        const nextPageResult = await moveToNextPage(page, pageNum, threadPrefix);

        // 페이지 이동 성공 시 쿠키 갱신
        if (nextPageResult.success) {
          try {
            latestCookies = await page.context().cookies();
          } catch (e) {
            // 쿠키 조회 실패는 무시
          }
        }

        if (!nextPageResult.success) {
          console.log(`${threadPrefix} ⚠️ ${keywordInfo}다음 페이지로 이동 실패`);

          // 점검 페이지로 인한 실패인 경우
          if (nextPageResult.error === 'maintenance_page') {
            console.log(`${threadPrefix} 🔧 ${keywordInfo}쿠팡 점검 페이지로 인해 검색 중단`);
            result.errorType = 'maintenance';
            result.errorMessage = '쿠팡 점검 페이지';
            result.referer = lastSearchPageUrl;
            throw new Error('쿠팡 점검 페이지로 인한 검색 중단');
          }

          // 프록시 리다이렉트로 인한 실패
          if (nextPageResult.error === 'proxy_redirect') {
            console.log(`${threadPrefix} 🚫 ${keywordInfo}프록시 문제로 검색 중단`);
            result.errorType = 'proxy_error';
            result.errorMessage = '프록시 리다이렉트';
            result.referer = lastSearchPageUrl;
            throw new Error('프록시 리다이렉트로 인한 검색 중단');
          }

          // Access Denied로 인한 실패
          if (nextPageResult.error === 'access_denied') {
            console.log(`${threadPrefix} 🚫 ${keywordInfo}Access Denied로 검색 중단 (3회 재시도 실패)`);
            result.errorType = 'access_denied';
            result.errorMessage = 'Access Denied - 3회 재시도 실패';
            result.referer = lastSearchPageUrl;
            throw new Error('Access Denied로 인한 검색 중단');
          }

          // isLastPage 플래그 확인
          if (nextPageResult.isLastPage) {
            console.log(`${threadPrefix} ℹ️ ${keywordInfo}마지막 페이지로 판단하고 검색 종료`);
          } else {
            console.log(`${threadPrefix} ⚠️ ${keywordInfo}페이지 이동 실패 - 원인 불명`);
          }
          break;
        }
        await page.waitForTimeout(3000);
      }
    }

    if (!productFound) {
      // 검색은 성공했으나 상품이 없는 경우 → success: true, errorType: not_found
      result.success = true;
      result.errorType = 'not_found';
      console.log(`${threadPrefix} 📊 ${keywordInfo}총 ${totalProductsSearched}개 상품 검색 완료`);

      console.log(`${threadPrefix} 📭 ${keywordInfo}상품을 찾을 수 없습니다. (검색 성공, 상품 없음)`);
      console.log(`${threadPrefix}    ${keywordInfo}검색한 페이지 수: ${result.pagesSearched}`);
      result.errorMessage = '상품을 찾을 수 없음';
      result.referer = lastSearchPageUrl; // 마지막 검색 페이지 URL
    }

  } catch (error) {
    console.error(`❌ 오류 발생:`, error.message);
    result.errorMessage = error.message;
    result.referer = lastSearchPageUrl; // 에러 발생시에도 마지막 검색 페이지 URL 포함

    // DOM 불안정성 에러 감지
    if (error.errorType === 'dom_instability') {
      console.log(`${threadPrefix} ⚠️ DOM 엘리먼트 분리 에러 감지 - 페이지 상태 불안정`);
      result.errorType = 'dom_instability';
    }
    // 차단 감지
    else if (error.errorType === 'blocked' ||
             error.message.includes('ERR_HTTP2_PROTOCOL_ERROR') ||
             error.message.includes('쿠팡 접속 차단') ||
             error.message.includes('net::ERR_HTTP2_PROTOCOL_ERROR')) {

      // rank 모드에서 5페이지 이상 검색했으면 부분 성공으로 처리
      if (options.workType === 'rank' && result.pagesSearched >= 5) {
        console.log(`${threadPrefix} ⚠️ ${result.pagesSearched}페이지에서 차단되었지만 충분한 데이터 수집 완료`);
        console.log(`${threadPrefix} ✅ rank 모드 부분 성공 (${result.pagesSearched}페이지 검색, ${totalProductsSearched}개 상품)`);
        result.success = true;  // 성공으로 처리
        result.partialSuccess = true;  // 부분 성공 플래그
        result.errorMessage = `${result.pagesSearched}페이지 검색 후 차단 (부분 성공)`;
        result.errorType = 'partial_blocked';  // 부분 차단 타입
      } else {
        // 기존 차단 처리 로직 (1~4페이지 또는 rank가 아닌 경우)
        console.log(`${threadPrefix} 🚫 차단 감지`);
        if (options.workType === 'rank') {
          console.log(`${threadPrefix}    조기 차단 (${result.pagesSearched}페이지) - 실패 처리`);
        }
        console.log(`${threadPrefix} 💡 [Info] 공유 캐시 사용 중 - 다음 실행시 독립 캐시로 자동 전환됨`);
        result.errorType = 'blocked';  // errorType 설정 추가
      }
    }

    // 점검 페이지 감지
    if (error.errorType === 'maintenance' || error.message.includes('점검 페이지')) {
      console.log(`${threadPrefix} 🔧 쿠팡 점검 중 - 상품 페이지 접근 불가`);
      result.errorType = 'maintenance';
    }

    // 에러 로깅
    const errorCode = errorLogger.extractErrorCode(error);
    await errorLogger.logError({
      errorCode: errorCode,
      errorMessage: error.message,
      pageUrl: page.url(),
      proxyUsed: proxyConfig?.server,
      actualIp: actualIp,
      keywordId: options.keywordId,
      agent: options.agent,
      requireErrorCode: false
    });

  } finally {
    setCommonResultFields(result, actualIp, startTime);
    // 검색된 상품 수 설정
    result.productsFound = totalProductsSearched;
    const keywordInfo = options.keywordId ? `[ID:${options.keywordId}] ` : '';
    console.log(`${threadPrefix} ${keywordInfo}⏱️ 소요 시간: ${(result.durationMs / 1000).toFixed(2)}초`);

    // Akamai 쿠키(_abck)가 있는 경우에만 cookies와 cookie_state 저장
    if (latestCookies && latestCookies.length > 0) {
      // _abck 쿠키 존재 여부 확인
      const hasAbck = latestCookies.some(c => c.name === '_abck');

      if (hasAbck) {
        try {
          // JSON 직렬화 (안전하게)
          const cookiesJson = JSON.stringify(latestCookies, null, 0);

          // UTF-8로 인코딩 후 Base64 변환
          const cookiesBase64 = Buffer.from(cookiesJson, 'utf-8').toString('base64');

          // 결과 저장
          result.cookies = cookiesBase64;

          // cookie_state 결정
          // - success: 상품 찾음
          // - not_found: 10페이지 검색했으나 상품 없음
          // - no_results: 검색 결과 자체가 없음 (page >= 100)
          // - search_blocked: 검색 중 차단
          // - initial_blocked: 초기 접속 차단
          if (result.success) {
            if (result.productFound) {
              result.cookieState = 'success';
            } else if (result.pagesSearched >= 100) {
              result.cookieState = 'no_results';
            } else {
              result.cookieState = 'not_found';
            }
          } else {
            // 실패 시 - referer 유무로 초기/검색 중 차단 구분
            if (result.referer) {
              // 검색 중 차단 - 몇 페이지에서 차단됐는지 표시
              const blockedPage = result.pagesSearched || 1;
              result.cookieState = `search_blocked_${blockedPage}page`;
            } else {
              result.cookieState = 'initial_blocked';
            }
          }

          console.log(`${threadPrefix} 🍪 쿠키 저장 완료 (_abck 포함, state: ${result.cookieState}, ${latestCookies.length}개)`);
        } catch (error) {
          console.log(`${threadPrefix} ⚠️ 쿠키 인코딩 실패: ${error.message}`);
        }
      } else {
        console.log(`${threadPrefix} 🍪 _abck 쿠키 없음 - 쿠키 저장 생략`);
      }
    } else {
      console.log(`${threadPrefix} 🍪 저장할 쿠키 없음 (페이지 로드 실패 또는 초기 차단)`);
    }
  }

  // 에러 타입 설정
  if (result.errorMessage && !result.success) {
    if (result.errorType === 'dom_instability') {
      result.errorType = 'DOM_INSTABILITY';
    } else if (result.errorMessage.includes('ERR_HTTP2_PROTOCOL_ERROR') ||
        result.errorMessage.includes('net::ERR_HTTP2_PROTOCOL_ERROR') ||
        result.errorMessage.includes('쿠팡 접속 차단')) {
      result.errorType = 'BLOCKED';
    } else {
      result.errorType = 'GENERAL';
    }
  }

  return result;
}

module.exports = {
  searchAndClickProduct
};
