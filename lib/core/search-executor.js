/**
 * 검색 실행 공통 모듈 V2 (성능 메트릭 제거 버전)
 * id-mode와 multi-mode에서 공통으로 사용하는 검색 로직
 */

const { applyStaticOptimization, initSessionEvents, finalizeSessionEvents } = require('./optimizer');
const { searchAndClickProduct } = require('../modules/coupang-handler');

/**
 * 실행 결과 초기화
 * @returns {Object} 초기 결과 객체
 */
function createInitialResult() {
  return {
    success: false,
    productFound: false,
    productRank: null,
    urlRank: null,
    realRank: null,
    pagesSearched: 0,
    cartClicked: false,
    errorMessage: null,
    durationMs: 0,
    actualTrafficMb: null,
    actualIp: null,
    itemId: null,
    vendorItemId: null
  };
}

/**
 * 실행 조건 로그 출력
 * @param {Object} keywordData - 키워드 데이터
 * @param {boolean} finalSearchMode - 최종 검색 모드
 * @param {string} threadPrefix - 쓰레드 프리픽스
 */
function logExecutionConditions(keywordData, finalSearchMode, threadPrefix = '') {
  console.log(`${threadPrefix}📋 실행 조건:`);
  console.log(`${threadPrefix}   장바구니 클릭: ✅`);
}

/**
 * 키워드 검색 및 실행 (성능 메트릭 제거 버전)
 * @param {Object} page - Playwright page 객체
 * @param {Object} keywordData - 데이터베이스에서 가져온 키워드 정보
 * @param {Object} options - 실행 옵션
 * @returns {Object} 실행 결과
 */
async function executeKeywordSearch(page, keywordData, options) {
  const result = createInitialResult();
  const proxyConfig = keywordData.proxy_server ? { server: keywordData.proxy_server } : null;
  
  // 쓰레드 번호 추출 (로깅용)
  const threadNumber = options.threadNumber || 0;
  const threadPrefix = `[${threadNumber.toString().padStart(2, '0')}]`;
  
  // V2 로깅을 위한 keywordData 준비
  const keywordDataForV2 = {
    ...keywordData,
    // V2 테이블 구조에 맞는 필드 추가/변환
    coupang_main_allow: keywordData.coupang_main_allow || '["document"]',
    mercury_allow: keywordData.mercury_allow || null,
    ljc_allow: keywordData.ljc_allow || null,
    assets_cdn_allow: keywordData.assets_cdn_allow || null,
    front_cdn_allow: keywordData.front_cdn_allow || null,
    image_cdn_allow: keywordData.image_cdn_allow || null,
    static_cdn_allow: keywordData.static_cdn_allow || null,
    img1a_cdn_allow: keywordData.img1a_cdn_allow || null,
    thumbnail_cdn_allow: keywordData.thumbnail_cdn_allow || null
  };
  
  try {
    const finalSearchMode = false; // V2: 동적으로 결정 (기본값 goto, 차단시 search)

    // Akamai 이벤트 추적 초기화 (allocation_key로 세션 구분)
    initSessionEvents(
      keywordData.allocation_key,
      keywordData.keyword,
      keywordData.product_id,  // 상품 ID
      keywordData.item_id,
      keywordData.vendor_item_id,
      keywordData.work_type,
      keywordData.proxy_server
    );

    // 실행 조건 로그 출력
    logExecutionConditions(keywordData, finalSearchMode, threadPrefix);
    
    // 최적화 적용
    disableOptimization = await applyOptimization(page, keywordData, options, threadPrefix);
    
    // 최적화 컨텍스트 설정 (실제 키워드 설정 반영)
    const isImageBlocked = (
      (!keywordData.image_cdn_allow || keywordData.image_cdn_allow.length === 0 || keywordData.image_cdn_allow[0] === '') &&
      (!keywordData.img1a_cdn_allow || keywordData.img1a_cdn_allow.length === 0 || keywordData.img1a_cdn_allow[0] === '') &&
      (!keywordData.thumbnail_cdn_allow || keywordData.thumbnail_cdn_allow.length === 0 || keywordData.thumbnail_cdn_allow[0] === '')
    );
    
    optimizationContext = {
      optimizationActive: keywordData.optimize === true,
      imageBlocked: isImageBlocked,
      keywordOptimizeEnabled: keywordData.optimize === true,
      keywordSettings: {
        imageCdnAllowed: keywordData.image_cdn_allow || [],
        img1aCdnAllowed: keywordData.img1a_cdn_allow || [],
        thumbnailCdnAllowed: keywordData.thumbnail_cdn_allow || []
      }
    };
    
    console.log(`${threadPrefix}`);
    
    // 검색 및 클릭 실행
    const searchResult = await executeSearch(page, keywordDataForV2, options, finalSearchMode, optimizationContext, threadPrefix);
    Object.assign(result, searchResult);

    // Akamai 이벤트 로그 저장
    finalizeSessionEvents(keywordData.allocation_key);

    return result;

  } catch (error) {
    // 에러 발생시 적절한 상태 설정
    console.error(`${threadPrefix}❌ 검색 실행 중 오류: ${error.message}`);
    
    // 에러 타입에 따른 executionStatus 결정
    const { ExecutionStatus } = require('../constants');
    let executionStatus = ExecutionStatus.ERROR_UNKNOWN;
    
    if (error.message.includes('ERR_HTTP2_PROTOCOL_ERROR') || 
        error.message.includes('net::ERR_HTTP2_PROTOCOL_ERROR')) {
      executionStatus = ExecutionStatus.ERROR_BLOCKED;
    } else if (error.message.includes('timeout')) {
      executionStatus = ExecutionStatus.ERROR_TIMEOUT;
    }
    
    result.errorMessage = error.message;
    result.executionStatus = executionStatus;

    // 에러 시에도 Akamai 이벤트 로그 저장
    finalizeSessionEvents(keywordData.allocation_key);

    return result;
  }
}

/**
 * 최적화 적용 (V2는 항상 활성 + 키워드별 설정)
 * @param {Object} page - Playwright page 객체
 * @param {Object} keywordData - 키워드 데이터
 * @param {Object} options - 실행 옵션
 * @param {string} threadPrefix - 쓰레드 프리픽스
 * @returns {Function|null} 최적화 해제 함수
 */
async function applyOptimization(page, keywordData, options = {}, threadPrefix = '') {
  const workType = keywordData.work_type || null;

  if (workType === 'click') {
    console.log(`${threadPrefix}🔓 최적화 비활성화 (work_type: click)`);
    console.log(`${threadPrefix}   모든 리소스 오리지널 로드`);
  } else {
    console.log(`${threadPrefix}🚀 V2 최적화 활성화 (work_type: ${workType || 'null'})`);
    console.log(`${threadPrefix}   필수 도메인만 허용 | 모든 정적 리소스 차단`);
  }

  // 최적화 옵션 (work_type, once, targetProductId, allocationKey 전달)
  const optimizationOptions = {
    workType: workType,
    once: options.once || false,  // --once 모드 전달 (Akamai 로깅용)
    targetProductId: keywordData.product_id || null,  // 타겟 상품 ID (노출 추적용)
    allocationKey: keywordData.allocation_key || null  // 멀티쓰레드 세션 구분용
  };

  // 정적 최적화 적용 (DB 없이)
  return await applyStaticOptimization(page, keywordData.agent, optimizationOptions);
}

/**
 * 검색 실행 (성능 메트릭 제거 버전)
 * @param {Object} page - Playwright page 객체
 * @param {Object} keywordData - 키워드 데이터
 * @param {Object} options - 실행 옵션
 * @param {boolean} finalSearchMode - 검색 모드
 * @param {Object} optimizationContext - 최적화 컨텍스트
 * @param {string} threadPrefix - 쓰레드 프리픽스
 * @returns {Object} 검색 결과
 */
async function executeSearch(page, keywordData, options, finalSearchMode, optimizationContext = null, threadPrefix = '') {
  try {
    // 검색 옵션 구성
    // work_type이 'click'이면 클릭 활성화
    // 'rank'는 순위만 확인, 'product_info'는 상품 정보 추출
    const shouldEnableClick = keywordData.work_type === 'click';
    
    // maxPages 계산 먼저 수행
    const maxPages = (() => {
      switch(keywordData.work_type) {
        case 'rank':
          return 10;  // rank는 순위 확인용, 10페이지
        case 'idle':
          return 1;   // idle은 쿠키 워밍업용, 1페이지만
        case 'click':
          return 5;   // click은 빠른 클릭용, 5페이지로 증가
        case 'product_info':
          return 1;   // product_info는 상품 정보만, 1페이지
        default:
          return 10;  // 기본값 10페이지
      }
    })();
    
    if (threadPrefix) {
      console.log(`${threadPrefix}📋 work_type: ${keywordData.work_type || 'null'}, 최대 ${maxPages}페이지, 장바구니: ${shouldEnableClick ? '활성화' : '비활성화'}`);
    }
    
    const searchOptions = {
      keyword: keywordData.keyword,
      suffix: keywordData.suffix || '',
      productId: keywordData.product_id,
      searchUrl: keywordData.search_url || null,  // 서버에서 제공하는 검색 URL
      workType: keywordData.work_type || null,  // work_type 추가
      itemId: keywordData.item_id || null,  // item_id 추가
      vendorItemId: keywordData.vendor_item_id || null,  // vendor_item_id 추가
      cartClickEnabled: shouldEnableClick, // work_type에 따라 동적 설정
      maxPages: maxPages,  // 위에서 계산된 work_type별 페이지 제한
      proxyConfig: keywordData.proxy_server ? { server: keywordData.proxy_server } : null,
      optimizationLevel: 'balanced', // V2는 항상 최적화
      keywordId: keywordData.id,
      agent: keywordData.agent,
      // checkCookies, monitor 옵션 제거됨
      keywordData: keywordData,
      optimizationContext: optimizationContext,
      threadPrefix: threadPrefix,
      directUrl: options.directUrl || false  // URL 직접 모드 옵션 전달
    };
    
    // 검색 및 클릭 실행
    const searchResult = await searchAndClickProduct(page, searchOptions);
    
    return searchResult;
    
  } catch (error) {
    // 프록시 실패를 위한 특수 처리
    if (error.actualIp) {
      // checkIP에서 IP 정보가 포함된 에러
      console.log(`${threadPrefix}🔍 IP 정보 포함 에러: ${error.actualIp}`);
    }
    
    // 차단 감지
    const blockedAfterMs = error.blockedAfterMs;
    
    // ExecutionStatus 가져오기 (여기서만 사용)
    const { ExecutionStatus } = require('../constants');
    
    let executionStatus = ExecutionStatus.ERROR_UNKNOWN;
    
    if (error.message.includes('ERR_HTTP2_PROTOCOL_ERROR') || 
        error.message.includes('net::ERR_HTTP2_PROTOCOL_ERROR') ||
        error.message.includes('쿠팡 접속 차단')) {
      executionStatus = ExecutionStatus.ERROR_BLOCKED;
    } else if (error.message.includes('timeout')) {
      executionStatus = ExecutionStatus.ERROR_TIMEOUT;
    } else if (error.message.includes('프록시')) {
      executionStatus = ExecutionStatus.ERROR_PROXY;
    }
    
    const errorResult = {
      success: false,
      error: error.message,
      errorMessage: error.message,
      executionStatus: executionStatus,
      actualIp: error.actualIp || null // IP 정보 포함
    };
    
    return errorResult;
  }
}

module.exports = {
  executeKeywordSearch
};