/**
 * 공통 헬퍼 함수들
 * 핸들러들에서 반복적으로 사용되는 기능들을 중앙화
 *
 * Updated: 2025-12-13 - Access Denied 로깅 통합
 */

const accessDeniedLogger = require('./access-denied-logger');

/**
 * 타임스탬프 생성 (HH:mm:ss.SSS 형식)
 * @returns {string} 타임스탬프 문자열
 */
function getTimestamp() {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  const ms = now.getMilliseconds().toString().padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${ms}`;
}

/**
 * 쓰레드 접두사 생성 (타임스탬프 포함)
 * @param {number} threadNumber - 쓰레드 번호
 * @returns {string} 쓰레드 접두사 문자열
 */
function createThreadPrefix(threadNumber) {
  return `[${getTimestamp()}][${threadNumber.toString().padStart(2, '0')}]`;
}

/**
 * ID 접두사 생성
 * @param {number|null} keywordId - 키워드 ID
 * @returns {string} ID 접두사 문자열
 */
function createIdPrefix(keywordId) {
  return keywordId ? `[ID:${keywordId}] ` : '';
}

/**
 * 페이지 차단 상태 확인
 * @param {Object} page - Playwright page 객체
 * @returns {boolean} 차단 여부
 */
async function isPageBlocked(page) {
  try {
    const currentUrl = page.url();
    const title = await page.title();
    
    // 차단 관련 키워드 확인
    const blockIndicators = [
      'access denied',
      'blocked',
      'forbidden',
      '차단',
      '접근 거부',
      'ERR_HTTP2_PROTOCOL_ERROR',
      'ERR_HTTP2_PROTOCCOL_ERROR'
    ];
    
    const urlOrTitle = `${currentUrl} ${title}`.toLowerCase();
    return blockIndicators.some(indicator => 
      urlOrTitle.includes(indicator.toLowerCase())
    );
  } catch (error) {
    return false;
  }
}

/**
 * 안전한 대기 함수 (페이지 상태 확인 포함)
 * @param {Object} page - Playwright page 객체
 * @param {number} timeout - 대기 시간 (밀리초)
 * @param {number|null} keywordId - 키워드 ID (로깅용)
 */
async function safeWait(page, timeout, keywordId = null) {
  const idPrefix = createIdPrefix(keywordId);
  
  try {
    await page.waitForTimeout(timeout);
    
    // 대기 중 차단 확인
    if (await isPageBlocked(page)) {
      console.log(`${idPrefix}⚠️ 대기 중 차단 감지됨`);
      throw new Error('페이지 차단 감지');
    }
  } catch (error) {
    if (error.message.includes('차단')) {
      throw error;
    }
    // 일반적인 대기 오류는 무시
  }
}

/**
 * 선택자 대기 (대체 선택자 지원)
 * @param {Object} page - Playwright page 객체
 * @param {string|Array} selector - 선택자 또는 선택자 배열
 * @param {Object} options - 대기 옵션
 * @param {number|null} keywordId - 키워드 ID (로깅용)
 * @returns {Object} 찾은 요소
 */
async function waitForSelectorWithFallback(page, selector, options = {}, keywordId = null) {
  const idPrefix = createIdPrefix(keywordId);
  const selectors = Array.isArray(selector) ? selector : [selector];
  const { timeout = 10000, silent = false } = options;  // silent 옵션 추가

  for (let i = 0; i < selectors.length; i++) {
    const currentSelector = selectors[i];

    try {
      if (!silent) {
        console.log(`${idPrefix}🔍 선택자 대기 중 (${i + 1}/${selectors.length}): ${currentSelector}`);
      }

      // Access Denied 동시 감지 (Promise.race)
      const checkInterval = 1000;  // 1초마다 체크
      let accessDeniedDetected = false;

      const accessDeniedCheck = (async () => {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
          await page.waitForTimeout(checkInterval);
          const pageTitle = await page.title().catch(() => '');
          if (pageTitle.toLowerCase().includes('access denied')) {
            accessDeniedDetected = true;
            const error = new Error('Access Denied 감지됨');
            error.errorType = 'access_denied';
            throw error;
          }
        }
      })();

      const selectorWait = page.waitForSelector(currentSelector, { timeout });

      const element = await Promise.race([selectorWait, accessDeniedCheck]);

      if (accessDeniedDetected) {
        const error = new Error('Access Denied 감지됨');
        error.errorType = 'access_denied';
        throw error;
      }

      if (!silent) {
        console.log(`${idPrefix}✅ 선택자 발견: ${currentSelector}`);
      }
      return element;
    } catch (error) {
      // Access Denied 에러는 즉시 전파
      if (error.errorType === 'access_denied') {
        console.log(`${idPrefix}🚫 Access Denied 감지 - 셀렉터 대기 중단`);
        throw error;
      }

      if (i === selectors.length - 1) {
        // 마지막 선택자도 실패
        console.log(`${idPrefix}❌ 모든 선택자 대기 실패`);
        throw new Error(`선택자를 찾을 수 없음: ${selectors.join(', ')}`);
      } else {
        console.log(`${idPrefix}⚠️ 선택자 실패, 다음 시도: ${currentSelector}`);
      }
    }
  }
}

/**
 * 안전한 클릭 (여러 방법 시도)
 * @param {Object} page - Playwright page 객체
 * @param {Object|string} elementOrSelector - 요소 또는 선택자
 * @param {Object} options - 클릭 옵션
 * @param {number|null} keywordId - 키워드 ID (로깅용)
 * @returns {boolean} 클릭 성공 여부
 */
async function safeClick(page, elementOrSelector, options = {}, keywordId = null) {
  const idPrefix = createIdPrefix(keywordId);
  const { delay = 100, retries = 3 } = options;
  
  let element;
  if (typeof elementOrSelector === 'string') {
    try {
      element = await page.$(elementOrSelector);
      if (!element) {
        console.log(`${idPrefix}❌ 요소를 찾을 수 없음: ${elementOrSelector}`);
        return false;
      }
    } catch (error) {
      console.log(`${idPrefix}❌ 선택자 오류: ${error.message}`);
      return false;
    }
  } else {
    element = elementOrSelector;
  }
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`${idPrefix}🖱️ 클릭 시도 (${attempt}/${retries})...`);
      
      // 요소가 보이는지 확인
      const isVisible = await element.isVisible();
      if (!isVisible) {
        console.log(`${idPrefix}⚠️ 요소가 보이지 않음, 대기 중...`);
        await page.waitForTimeout(1000);
        continue;
      }
      
      // 클릭 실행
      await element.click({ delay });
      console.log(`${idPrefix}✅ 클릭 성공`);
      return true;
      
    } catch (error) {
      console.log(`${idPrefix}⚠️ 클릭 실패 (시도 ${attempt}): ${error.message}`);
      
      if (attempt === retries) {
        // JavaScript 클릭으로 대체 시도
        try {
          console.log(`${idPrefix}🔄 JavaScript 클릭 시도...`);
          await element.evaluate(el => el.click());
          console.log(`${idPrefix}✅ JavaScript 클릭 성공`);
          return true;
        } catch (jsError) {
          console.log(`${idPrefix}❌ JavaScript 클릭도 실패: ${jsError.message}`);
          return false;
        }
      } else {
        await page.waitForTimeout(1000);
      }
    }
  }
  
  return false;
}

/**
 * 페이지 네비게이션 대기 (타임아웃 허용)
 * @param {Object} page - Playwright page 객체
 * @param {Function} action - 네비게이션을 발생시키는 액션
 * @param {Object} options - 네비게이션 옵션
 * @param {number|null} keywordId - 키워드 ID (로깅용)
 * @returns {boolean} 네비게이션 성공 여부
 */
async function safeNavigate(page, action, options = {}, keywordId = null) {
  const idPrefix = createIdPrefix(keywordId);
  const { timeout = 30000, waitUntil = 'load' } = options;
  
  try {
    console.log(`${idPrefix}🌐 네비게이션 시작...`);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil, timeout }),
      action()
    ]);
    
    console.log(`${idPrefix}✅ 네비게이션 성공`);
    return true;
    
  } catch (error) {
    console.log(`${idPrefix}⚠️ 네비게이션 타임아웃: ${error.message}`);
    
    // 실제로 페이지가 변경되었는지 확인
    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    console.log(`${idPrefix}📍 현재 URL: ${currentUrl}`);
    
    // URL 변경이 있었다면 성공으로 처리
    if (currentUrl && currentUrl !== 'about:blank') {
      console.log(`${idPrefix}✅ URL 변경 확인됨, 계속 진행`);
      return true;
    }
    
    return false;
  }
}

/**
 * 에러 메시지 정규화
 * @param {string} errorMessage - 원본 에러 메시지
 * @returns {string} 정규화된 에러 메시지
 */
function normalizeErrorMessage(errorMessage) {
  if (!errorMessage) return '알 수 없는 오류';
  
  // 공통 에러 패턴 매핑
  const errorMappings = [
    { pattern: /ERR_HTTP2_PROTOCOL_ERROR|ERR_HTTP2_PROTOCCOL_ERROR/i, message: '쿠팡 접속 차단 (HTTP/2 프로토콜 오류)' },
    { pattern: /ERR_CONNECTION_REFUSED/i, message: '연결 거부됨' },
    { pattern: /ERR_NETWORK_CHANGED/i, message: '네트워크 변경 감지' },
    { pattern: /timeout/i, message: '시간 초과' },
    { pattern: /navigation/i, message: '페이지 이동 실패' },
    { pattern: /blocked|forbidden|access denied/i, message: '접근 차단됨' }
  ];
  
  for (const mapping of errorMappings) {
    if (mapping.pattern.test(errorMessage)) {
      return mapping.message;
    }
  }
  
  return errorMessage;
}

/**
 * 성능 메트릭 수집
 * @param {Object} page - Playwright page 객체
 * @returns {Object} 성능 메트릭
 */
async function collectPerformanceMetrics(page) {
  try {
    const metrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      if (!navigation) return null;
      
      return {
        loadTime: Math.round(navigation.loadEventEnd - navigation.fetchStart),
        domContentLoaded: Math.round(navigation.domContentLoadedEventEnd - navigation.fetchStart),
        firstPaint: Math.round(navigation.fetchStart),
        networkRequests: performance.getEntriesByType('resource').length
      };
    });
    
    return metrics || {};
  } catch (error) {
    return {};
  }
}

module.exports = {
  getTimestamp,
  createThreadPrefix,
  createIdPrefix,
  isPageBlocked,
  safeWait,
  waitForSelectorWithFallback,
  safeClick,
  safeNavigate,
  normalizeErrorMessage,
  collectPerformanceMetrics
};