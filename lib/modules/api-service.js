/**
 * 통합 API 서비스
 * hub-api-client.js + error-logger.js
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 이더넷(로컬) IP 주소 추출
 * eth0, enp, ens 등 이더넷 인터페이스에서 IPv4 주소를 가져옴
 */
function getEthernetIp() {
  try {
    const interfaces = os.networkInterfaces();

    // 우선순위: eth0 > enp* > ens* > 기타
    const priorities = ['eth0', 'enp', 'ens', 'en'];

    for (const prefix of priorities) {
      for (const [name, addrs] of Object.entries(interfaces)) {
        if (name.startsWith(prefix) || name === prefix) {
          const ipv4 = addrs?.find(addr => addr.family === 'IPv4' && !addr.internal);
          if (ipv4) {
            return ipv4.address;
          }
        }
      }
    }

    // 못 찾으면 아무 외부 IPv4라도 반환
    for (const addrs of Object.values(interfaces)) {
      const ipv4 = addrs?.find(addr => addr.family === 'IPv4' && !addr.internal);
      if (ipv4) {
        return ipv4.address;
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

// 에러 로그 파일에 기록
function logErrorToFile(message, data = {}) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const logDir = path.join(process.cwd(), 'logs');
  const logFile = path.join(logDir, `error-${today}.log`);

  // logs 폴더 생성
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n${JSON.stringify(data, null, 2)}\n\n`;

  fs.appendFileSync(logFile, logEntry);
}

// =====================================================
// hub-api-client.js
// =====================================================

class HubApiClient {
  constructor(config = {}) {
    this.hubBaseUrl = config.hubBaseUrl || 'http://61.84.75.37:3302';
    this.threadNumber = config.threadNumber || 1;
    this.timeout = config.timeout || 30000;
    this.retryCount = config.retryCount || 3;

    // VPN 모드 관련 설정
    this.vpnDongle = config.vpnDongle || null;  // VPN 동글 번호 (16~23)
    this.realServerIp = config.realServerIp || null;  // 실제 서버 IP (외부)

    // 이더넷 IP (로컬 네트워크 IP - 에이전트 식별용)
    this.agentIp = getEthernetIp();

    // HTTP 클라이언트 설정
    this.httpClient = axios.create({
      baseURL: this.hubBaseUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CoupangAutomation/2.0'
      }
    });

    // 요청/응답 인터셉터
    this.setupInterceptors();

    const vpnInfo = this.vpnDongle ? ` VPN-${this.vpnDongle}` : '';
    console.log(`🔗 HubApiClient 초기화: ${this.hubBaseUrl} (쓰레드: ${this.threadNumber}${vpnInfo}, IP: ${this.agentIp})`);
  }

  setupInterceptors() {
    // 요청 인터셉터
    this.httpClient.interceptors.request.use(
      (config) => {
        console.log(`🌐 [API 요청] ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        console.error('❌ [API 요청 오류]', error.message);
        return Promise.reject(error);
      }
    );

    // 응답 인터셉터
    this.httpClient.interceptors.response.use(
      (response) => {
        console.log(`✅ [API 응답] ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        const status = error.response?.status || 'Network';
        const url = error.config?.url || 'Unknown';
        console.error(`❌ [API 오류] ${status} ${url}:`, error.message);
        return Promise.reject(error);
      }
    );
  }

  /**
   * 실제 서버 IP 설정 (VPN 모드에서 동적 업데이트용)
   */
  setRealServerIp(ip) {
    this.realServerIp = ip;
  }

  /**
   * 작업 할당 요청 (새로운 API 구조)
   */
  async allocateWork() {
    console.log(`📋 작업 할당 요청: 쓰레드 ${this.threadNumber}`);

    // user_folder 파라미터 추가 (01, 02, 03... 형식)
    const userFolder = String(this.threadNumber).padStart(2, '0');

    // URL 파라미터 구성
    const params = new URLSearchParams();
    params.append('user_folder', userFolder);

    // agent_ip: 이더넷 IP (에이전트 식별용)
    if (this.agentIp) {
      params.append('agent_ip', this.agentIp);
    }
    
    try {
      const response = await this.retryRequest(async () => {
        return await this.httpClient.get(`/api/work/allocate?${params.toString()}`);
      });
      
      const allocation = response.data;

      // API 응답 로그 - 원본 JSON 그대로 표시
      console.log(`\n📥 [허브 서버 응답] work/allocate:`);
      console.log(JSON.stringify(allocation, null, 2));
      console.log(`📊 [응답 타입]: ${typeof allocation}`);
      console.log(`📊 [응답 값]: ${allocation}`);

      // 빈 문자열이나 null 체크
      if (!allocation || allocation === "" || typeof allocation !== 'object') {
        console.log(`❌ 잘못된 응답 형식 - allocation:`, allocation);
        throw new Error(`작업 할당 실패: 서버 응답이 비어있거나 잘못됨`);
      }

      if (!allocation.success) {
        const reason = allocation.reason || 'UNKNOWN';
        const message = allocation.message || '알 수 없는 오류';

        // NO_TASK는 정상 응답 (작업 없음)
        if (reason === 'NO_TASK') {
          console.log(`📭 작업 없음: ${message}`);
          return null;  // 에러가 아닌 null 반환
        }

        // 그 외는 에러로 처리 (NO_PROXY, INVALID_WORK_TYPE, SERVER_ERROR 등)
        console.log(`❌ 작업 할당 실패: [${reason}] ${message}`);
        throw new Error(`[${reason}] ${message}`);
      }

      console.log(`✅ 작업 할당 성공: ${allocation.allocation_key}`);

      // 프록시는 이제 문자열로 직접 전달됨 (socks5://ip:port)
      const proxyString = allocation.proxy;
      console.log(`   프록시: ${proxyString || 'none'}`);

      // 프록시 URL 파싱
      let proxyConfig = null;
      if (proxyString) {
        try {
          const proxyUrl = new URL(proxyString);
          proxyConfig = {
            protocol: proxyUrl.protocol.replace(':', ''),
            server: `${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username || null,
            password: proxyUrl.password || null,
            url: proxyString
          };
        } catch (parseError) {
          console.error('⚠️ 프록시 URL 파싱 실패:', parseError.message);
          console.error('   프록시 데이터:', JSON.stringify(allocation.proxy));
        }
      }

      // speed_limit 로깅
      if (allocation.speed_limit) {
        console.log(`⚠️ 네트워크 속도 제한 모드 활성화 (향후 타임아웃 조정 예정)`);
      }

      return {
        allocationKey: allocation.allocation_key,
        work: {
          keyword: allocation.keyword,
          code: allocation.product_id,  // product_id를 code로 매핑
          searchUrl: allocation.search_url || null,  // search_url 추가
          workType: allocation.work_type || null,  // work_type 추가
          itemId: allocation.item_id || null,  // item_id 추가
          vendorItemId: allocation.vendor_item_id || null,  // vendor_item_id 추가
          excludedChromeBuilds: allocation.excluded_chrome_builds || []  // 제외할 Chrome 빌드 목록
        },
        proxy: proxyConfig,
        proxyId: allocation.proxy_id,  // proxy_id 추가
        userFolder: allocation.user_folder || userFolder,  // user_folder 추가
        speedLimit: allocation.speed_limit || false,  // speed_limit 추가
        settings: {
          // 모든 최적화 설정을 true로 하드코딩 (기존 요구사항)
          cartClickEnabled: true,
          blockMercury: true,
          blockImageCdn: true,
          blockImg1aCdn: true,
          blockThumbnailCdn: true
        },
        threadNumber: this.threadNumber
      };
        
    } catch (error) {
      console.error(`❌ 작업 할당 실패:`, error.message);
      
      // HTTP 응답 오류 상세 정보
      if (error.response) {
        const status = error.response.status;
        const responseData = error.response.data;
        
        if (status === 503) {
          // 서버 메시지를 그대로 출력
          const serverMessage = responseData?.message || responseData?.error || 'Unknown 503 error';
          console.log(`   📍 503 서비스 이용불가: ${serverMessage}`);
        }
      }
      
      // 작업이 없는 경우 null 반환
      if (error.message.includes('No keywords') || 
          error.message.includes('No active keywords') ||
          error.message.includes('completed today')) {
        return null;
      }
      
      throw error;
    }
  }

  /**
   * 작업 결과 제출 (간소화된 구조)
   */
  async submitResult(resultData) {
    console.log(`📤 결과 제출: ${resultData.allocation_key}`);

    try {
      // 간소화된 payload 구조
      const payload = { ...resultData };

      // agent_ip: 이더넷 IP (에이전트 식별용)
      if (this.agentIp) {
        payload.agent_ip = this.agentIp;
      }

      // POST 요청 데이터 로그 (cookies는 유무만 표시)
      const logPayload = { ...payload };
      if (logPayload.cookies) {
        logPayload.cookies = `[${logPayload.cookies.length} chars]`;
      }
      console.log(`\n📤 [POST 데이터] result:`);
      console.log(JSON.stringify(logPayload, null, 2));
      
      const response = await this.retryRequest(async () => {
        return await this.httpClient.post('/api/work/result', payload);
      });

      // API 응답 로그 (상태 코드별 처리)
      console.log(`\n📥 [허브 서버 응답] result:`);
      console.log(`   status: ${response.status}`);
      console.log(`   success: ${response.data.success}`);
      console.log(`   message: ${response.data.message}`);
      
      // HTTP 200 - 성공 (success: true/false 모두 정상 응답)
      if (response.status === 200) {
        if (response.data.success) {
          console.log(`   ✅ 결과가 정상적으로 저장되었습니다`);
        } else {
          console.log(`   ⚠️ 에러 결과가 정상적으로 저장되었습니다`);
        }
      }
      return response.data;

    } catch (error) {
      console.error(`❌ 결과 제출 실패:`, error.message);
      
      // HTTP 응답 오류인 경우 상세 정보 출력
      if (error.response) {
        const status = error.response.status;
        const data = error.response.data;
        
        console.error(`🔍 [HTTP 오류 ${status}] 상세 정보:`);
        
        // 상태 코드별 구체적인 메시지
        if (status === 400) {
          console.error(`   ❌ 잘못된 요청: ${data?.message || 'allocation_key is required'}`);
          console.error(`   📍 원인: 필수 파라미터 누락`);
        } else if (status === 404) {
          console.error(`   ❌ 찾을 수 없음: ${data?.message || 'Invalid allocation_key'}`);
          console.error(`   📍 원인: 유효하지 않은 allocation_key`);
        } else if (status === 500) {
          console.error(`   ❌ 서버 오류: ${data?.message || 'Database error'}`);
          console.error(`   📍 원인: 서버 측 데이터베이스 문제`);
        } else {
          console.error(`   ❌ 알 수 없는 오류: ${data?.message || 'Unknown error'}`);
        }
        
        console.error(`   📍 서버 응답:`, JSON.stringify(data, null, 2));
        
        // 500 오류인 경우 제출한 데이터 확인
        if (status === 500) {
          console.error(`\n🔍 [500 오류] 제출한 데이터 확인:`);
          console.error(`   - allocation_key: ${payload.allocation_key || '❌ 없음'}`);
          console.error(`   - success: ${payload.success}`);
          console.error(`   - execution_time_ms: ${payload.execution_time_ms}ms`);
        }
        
      } else if (error.request) {
        // 네트워크 오류 (요청은 보냈지만 응답 없음) - 파일에 로그
        console.error(`🔍 [네트워크 오류] 요청 전송됐지만 응답 없음`);
        logErrorToFile('네트워크 오류 - 응답 없음', {
          allocation_key: payload.allocation_key,
          error_message: error.message,
          url: error.config?.url,
          timeout: error.config?.timeout,
          request: payload
        });

      } else {
        // 요청 설정 오류 - 파일에 로그
        console.error(`🔍 [요청 설정 오류]:`, error.message);
        logErrorToFile('요청 설정 오류', {
          allocation_key: payload.allocation_key,
          error_message: error.message,
          request: payload
        });
      }
      
      throw error;
    }
  }

  /**
   * 허브 서버 상태 확인
   */
  async checkHealth() {
    try {
      const response = await this.httpClient.get('/health');
      
      // API 응답 로그
      console.log(`\n📥 [허브 서버 응답] health:`);
      console.log(`   status: ${response.data.status || 'ok'}`);
      console.log(`   message: ${response.data.message || 'Server is healthy'}`);
      console.log('');
      
      console.log(`💚 허브 서버 상태 양호`);
      return response.data;
    } catch (error) {
      console.error(`❤️ 허브 서버 상태 확인 실패:`, error.message);
      throw error;
    }
  }

  /**
   * 재시도 로직
   */
  async retryRequest(requestFunc) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.retryCount; attempt++) {
      try {
        return await requestFunc();
      } catch (error) {
        lastError = error;
        
        if (attempt === this.retryCount) {
          break;
        }

        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        const status = lastError.response?.status;
        const errorData = lastError.response?.data;
        
        // 서버 메시지와 함께 재시도 정보 출력
        if (status === 503 && errorData?.message) {
          console.warn(`⚠️ ${errorData.message} - 재시도 (${attempt}/${this.retryCount}), ${delay}ms 후...`);
        } else {
          console.warn(`⚠️ API 요청 실패 (${attempt}/${this.retryCount}), ${delay}ms 후 재시도...`);
        }
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError;
  }

  /**
   * 클라이언트 상태 조회
   */
  getStatus() {
    return {
      hubBaseUrl: this.hubBaseUrl,
      threadNumber: this.threadNumber,
      timeout: this.timeout,
      retryCount: this.retryCount,
      isHealthy: true
    };
  }
}

// =====================================================
// error-logger.js
// =====================================================

/**
 * 에러 코드 추출 함수 (유지)
 */
function extractErrorCode(error) {
  if (!error) return null;
  
  const message = error.message || error.toString();
  
  // 일반적인 에러 코드 패턴
  const patterns = [
    /ERR_[A-Z0-9_]+/,           // ERR_HTTP2_PROTOCOL_ERROR
    /NS_ERROR_[A-Z0-9_]+/,      // NS_ERROR_FAILURE
    /net::[A-Z0-9_]+/,          // net::ERR_FAILED
    /[A-Z]+_ERROR/,             // PROTOCOL_ERROR
    /Error:\s*([A-Z0-9_]+)/,    // Error: TIMEOUT
    /code:\s*['"]?([A-Z0-9_]+)/i, // code: 'ECONNRESET'
  ];
  
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      return match[0];
    }
  }
  
  // 특정 에러 메시지에서 코드 추출
  if (message.includes('Stream error')) return 'STREAM_ERROR';
  if (message.includes('Protocol error')) return 'PROTOCOL_ERROR';
  if (message.includes('Timeout')) return 'TIMEOUT_ERROR';
  if (message.includes('Navigation')) return 'NAVIGATION_ERROR';
  if (message.includes('Execution context was destroyed')) return 'CONTEXT_DESTROYED';
  if (message.includes('Target crashed')) return 'TARGET_CRASHED';
  
  return null;
}

/**
 * 에러 로깅 스텁 서비스
 */
class ErrorLoggerStub {
  /**
   * 에러 로그 저장 (스텁)
   */
  async logError(errorData) {
    // API 모드에서는 허브 서버가 에러 로깅 처리
    return null;
  }
  
  /**
   * 에러 통계 조회 (스텁)
   */
  async getErrorStats(options = {}) {
    // API 모드에서는 허브 서버가 통계 처리
    return { stats: [], totalErrors: 0 };
  }

  // extractErrorCode 함수는 유지
  extractErrorCode(error) {
    return extractErrorCode(error);
  }
}

// =====================================================
// BatchAllocator - 새로운 배치 할당 API 클라이언트
// =====================================================

/**
 * 배치 할당 클라이언트
 * - 한 번에 여러 작업을 할당받음 (기본 5개)
 * - VPN 모드 전용
 */
class BatchAllocator {
  constructor(config = {}) {
    this.allocateUrl = config.allocateUrl || 'http://61.84.75.37:10001';  // 할당 서버
    this.resultUrl = config.resultUrl || 'http://61.84.75.37:10002';      // 결과 서버
    this.agentIp = config.agentIp || getEthernetIp();
    this.vpnId = config.vpnId || null;  // 예: "121.173.150.131_11"
    this.externalIp = config.externalIp || null;  // VPN 외부 IP
    this.batchSize = config.batchSize || 5;  // 기본 5개 작업
    this.timeout = config.timeout || 30000;

    // 작업 큐 (할당받은 작업들)
    this.workQueue = [];

    // 할당용 HTTP 클라이언트 (포트 10001)
    this.allocateClient = axios.create({
      baseURL: this.allocateUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CoupangVPN/2.0'
      }
    });

    // 결과 제출용 HTTP 클라이언트 (포트 10002)
    this.resultClient = axios.create({
      baseURL: this.resultUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CoupangVPN/2.0'
      }
    });

    console.log(`🔗 BatchAllocator 초기화`);
    console.log(`   할당: ${this.allocateUrl}, 결과: ${this.resultUrl}`);
    console.log(`   agent_ip: ${this.agentIp}, vpn: ${this.vpnId}, external_ip: ${this.externalIp}`);
  }

  /**
   * VPN 외부 IP 업데이트 (VPN 연결/토글 후 호출)
   */
  setExternalIp(ip) {
    this.externalIp = ip;
    console.log(`📍 BatchAllocator external_ip 업데이트: ${ip}`);
  }

  /**
   * VPN ID 설정
   */
  setVpnId(vpnId) {
    this.vpnId = vpnId;
    console.log(`📍 BatchAllocator vpn 업데이트: ${vpnId}`);
  }

  /**
   * 배치 작업 할당 요청
   *
   * 요청:
   *   POST /allocate
   *   { agent_ip, vpn, external_ip }
   *
   * 응답:
   *   {
   *     success: true,
   *     count: 5,
   *     tasks: [
   *       { allocation_key, keyword, product_id, item_id, vendor_item_id },
   *       ...
   *     ]
   *   }
   *
   * @returns {Array} 할당된 작업 배열
   */
  async allocateBatch() {
    const requestBody = {
      agent_ip: this.agentIp,
      vpn: this.vpnId,
      external_ip: this.externalIp
    };

    console.log(`📋 배치 할당 요청: POST ${this.allocateUrl}/allocate`);
    console.log(`   [DEBUG] payload: ${JSON.stringify(requestBody)}`);

    try {
      const response = await this.allocateClient.post('/allocate', requestBody);
      const data = response.data;

      // 응답 구조 확인
      if (!data || !data.success) {
        // 실패 응답 전체를 콘솔에 출력 (사유, 상세 정보 포함)
        console.log(`❌ 할당 실패 응답:`);
        console.log(JSON.stringify(data, null, 2));
        return [];
      }

      // tasks 배열 추출
      const tasks = data.tasks || [];

      // 서버 응답 원본 그대로 출력 (jq 형식)
      console.log(JSON.stringify(data, null, 2));

      // 작업 큐에 추가
      this.workQueue.push(...tasks);

      return tasks;

    } catch (error) {
      console.error(`❌ 배치 할당 실패: ${error.message}`);

      if (error.response) {
        console.error(`   상태: ${error.response.status}`);
        console.error(`   응답: ${JSON.stringify(error.response.data)}`);
      }

      return [];
    }
  }

  /**
   * 큐에서 다음 작업 가져오기
   * @returns {Object|null} 다음 작업 또는 null
   */
  getNextWork() {
    return this.workQueue.shift() || null;
  }

  /**
   * 큐에 남은 작업 수
   */
  getQueueSize() {
    return this.workQueue.length;
  }

  /**
   * 큐 비우기
   */
  clearQueue() {
    const count = this.workQueue.length;
    this.workQueue = [];
    console.log(`🗑️ 작업 큐 비움: ${count}개 작업 폐기`);
  }

  /**
   * 작업 결과 제출
   *
   * Click 작업 성공:
   *   { allocation_key, success: true }
   *
   * Click 작업 실패:
   *   { allocation_key, success: false, error_type, error_message }
   *
   * Rank 작업 성공:
   *   { allocation_key, success: true, rank_result, page_result }
   *
   * Rank 작업 실패:
   *   { allocation_key, success: false, error_type: "NOT_FOUND", error_message }
   *
   * @param {Object} result - 작업 결과
   */
  async submitResult(result) {
    const allocationKey = result.allocation_key || result.allocationKey;
    const isSuccess = result.success;

    // 로그 출력
    if (isSuccess) {
      if (result.rank_result !== undefined) {
        console.log(`📤 결과 제출: ${allocationKey} ✅ 순위 ${result.rank_result} (${result.page_result}페이지)`);
      } else {
        console.log(`📤 결과 제출: ${allocationKey} ✅ 성공`);
      }
    } else {
      console.log(`📤 결과 제출: ${allocationKey} ❌ ${result.error_type}: ${result.error_message}`);
    }

    try {
      const response = await this.resultClient.post('/result', result);

      if (response.data?.success) {
        console.log(`   → 서버 응답: ${response.data.message || 'OK'}`);
      }

      return response.data;
    } catch (error) {
      console.error(`❌ 결과 제출 실패: ${error.message}`);
      throw error;
    }
  }

  /**
   * Click 작업 성공 결과 생성
   * @param {string} allocationKey - 할당 키
   * @param {Object} extras - 추가 정보 (선택)
   *   - cookies: base64 인코딩된 쿠키 문자열
   *   - chrome_version: Chrome 버전
   *   - vpn_ip: VPN 외부 IP
   */
  static createClickSuccess(allocationKey, extras = {}) {
    const result = {
      allocation_key: allocationKey,
      success: true
    };

    // 추가 정보 병합
    if (extras.cookies) {
      result.cookies = extras.cookies;
    }
    if (extras.chrome_version) {
      result.chrome_version = extras.chrome_version;
    }
    if (extras.vpn_ip) {
      result.vpn_ip = extras.vpn_ip;
    }

    return result;
  }

  /**
   * Click 작업 실패 결과 생성
   */
  static createClickFailure(allocationKey, errorType, errorMessage) {
    return {
      allocation_key: allocationKey,
      success: false,
      error_type: errorType,  // BLOCKED, TIMEOUT, PROXY_ERROR, etc.
      error_message: errorMessage
    };
  }

  /**
   * Rank 작업 성공 결과 생성
   */
  static createRankSuccess(allocationKey, rank, page) {
    return {
      allocation_key: allocationKey,
      success: true,
      rank_result: rank,
      page_result: page
    };
  }

  /**
   * Rank 작업 실패 결과 생성
   */
  static createRankFailure(allocationKey, errorType, errorMessage) {
    return {
      allocation_key: allocationKey,
      success: false,
      error_type: errorType,  // NOT_FOUND, BLOCKED, TIMEOUT, etc.
      error_message: errorMessage
    };
  }

  /**
   * 상태 조회
   */
  getStatus() {
    return {
      baseUrl: this.baseUrl,
      agentIp: this.agentIp,
      vpnId: this.vpnId,
      externalIp: this.externalIp,
      queueSize: this.workQueue.length,
      batchSize: this.batchSize
    };
  }
}

// =====================================================
// DongleAllocator - 동글 할당/반납 API 클라이언트
// =====================================================

/**
 * 동글 할당 클라이언트
 * - /dongle/allocate: 동글 할당받기
 * - /dongle/release: 동글 반납하기
 *
 * agent_id 형식: {hostname}-{vpn순번}
 * 예: "U22-01-01", "U22-01-02", ...
 */
class DongleAllocator {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || 'http://61.84.75.37:10001';
    this.timeout = config.timeout || 30000;

    // HTTP 클라이언트
    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CoupangVPN/2.0'
      }
    });

    console.log(`🔗 DongleAllocator 초기화: ${this.baseUrl}`);
  }

  /**
   * 동글 할당 요청
   *
   * @param {string} agentId - 에이전트 ID (예: "U22-01-01")
   * @returns {Object|null} 할당된 동글 정보 또는 null
   *
   * 응답 예시:
   * {
   *   success: true,
   *   renewed: false,
   *   dongle: {
   *     id: 26,
   *     server_ip: "115.21.112.42",
   *     dongle: 17,
   *     private_key: "uEJ70f...",
   *     public_key: "yIrGEm..."
   *   }
   * }
   */
  async allocate(agentId) {
    console.log(`📋 동글 할당 요청: agent_id=${agentId}`);

    try {
      const response = await this.httpClient.post('/dongle/allocate', {
        agent_id: agentId
      });

      const data = response.data;

      if (!data || !data.success) {
        console.log(`❌ 동글 할당 실패: ${data?.message || '응답 없음'}`);
        return null;
      }

      const dongle = data.dongle;
      const renewedStatus = data.renewed ? '(기존 할당 재사용)' : '(신규 할당)';

      console.log(`✅ 동글 할당 성공 ${renewedStatus}`);
      console.log(`   id: ${dongle.id}, dongle: ${dongle.dongle}`);
      console.log(`   server_ip: ${dongle.server_ip}`);

      return {
        id: dongle.id,
        dongleNumber: dongle.dongle,
        serverIp: dongle.server_ip,
        privateKey: dongle.private_key,
        publicKey: dongle.public_key,
        renewed: data.renewed
      };

    } catch (error) {
      console.error(`❌ 동글 할당 실패: ${error.message}`);
      if (error.response) {
        console.error(`   상태: ${error.response.status}`);
        console.error(`   응답: ${JSON.stringify(error.response.data)}`);
      }
      return null;
    }
  }

  /**
   * 동글 반납 요청
   * GET /dongle/release/{dongle_id}
   *
   * @param {string} agentId - 에이전트 ID (로깅용)
   * @param {number} dongleId - 동글 ID
   * @returns {boolean} 성공 여부
   */
  async release(agentId, dongleId) {
    console.log(`[DEBUG] release 호출: agentId=${agentId}, dongleId=${dongleId}, type=${typeof dongleId}`);

    if (!dongleId) {
      console.log(`⚠️ 동글 반납 스킵: dongle_id 없음`);
      return false;
    }

    const url = `/dongle/release/${dongleId}`;
    console.log(`📋 동글 반납 요청: GET ${this.baseUrl}${url}`);

    try {
      const response = await this.httpClient.get(`/dongle/release/${dongleId}`);

      if (response.status === 200) {
        console.log(`✅ 동글 반납 성공: dongle_id=${dongleId}`);
        return true;
      } else {
        console.log(`⚠️ 동글 반납 응답: ${response.status}`);
        return false;
      }

    } catch (error) {
      console.error(`❌ 동글 반납 실패: ${error.message}`);
      return false;
    }
  }

  /**
   * 동글 사용 연장 (heartbeat)
   * 작업 완료 후 호출하여 타임아웃 방지
   *
   * @param {number} dongleId - 동글 ID
   * @returns {boolean} 성공 여부
   */
  async heartbeat(dongleId) {
    console.log(`[DEBUG] heartbeat 호출: dongleId=${dongleId}, type=${typeof dongleId}`);
    try {
      // GET /dongle/heartbeat/{dongle_id}
      const url = `/dongle/heartbeat/${dongleId}`;
      console.log(`💓 동글 연장 요청: GET ${this.baseUrl}${url}`);
      const response = await this.httpClient.get(url);
      if (response.status === 200) {
        console.log(`💓 동글 연장 성공: dongle_id=${dongleId}`);
        return true;
      }
      console.log(`⚠️ 동글 연장 응답: ${response.status}`);
      return false;
    } catch (error) {
      console.log(`⚠️ 동글 연장 실패: ${error.message}`);
      return false;
    }
  }

  /**
   * 동글 IP 토글 요청
   * GET http://{serverIp}/toggle/{dongleNumber}
   *
   * @param {string} serverIp - VPN 서버 IP
   * @param {number} dongleNumber - 동글 번호 (16~23)
   * @returns {boolean} 성공 여부
   */
  async toggle(serverIp, dongleNumber) {
    console.log(`🔄 동글 IP 토글 요청: http://${serverIp}/toggle/${dongleNumber} (백그라운드)`);

    try {
      const axios = require('axios');
      // 백그라운드로 토글 요청 - 응답 기다리지 않음
      // VPN 끊긴 상태에서 호출되므로 백그라운드 OK
      // 토글 완료 후 반납되므로 다른 에이전트가 새 IP로 사용
      axios.get(`http://${serverIp}/toggle/${dongleNumber}`, {
        timeout: 90000
      }).then(response => {
        const newIp = response.data?.ip || 'unknown';
        console.log(`✅ [백그라운드] 동글 ${dongleNumber} 토글 완료 → 새 IP: ${newIp}`);
      }).catch(error => {
        console.log(`⚠️ [백그라운드] 동글 ${dongleNumber} 토글: ${error.message}`);
      });

      return true;
    } catch (error) {
      console.log(`⚠️ 동글 ${dongleNumber} 토글 요청 실패: ${error.message}`);
      return false;
    }
  }

  /**
   * WireGuard 설정 생성 헬퍼
   *
   * @param {Object} dongle - allocate()에서 받은 동글 정보
   * @returns {Object} WireGuard 설정
   */
  static createWgConfig(dongle) {
    return {
      privateKey: dongle.privateKey,
      publicKey: dongle.publicKey,
      endpoint: `${dongle.serverIp}:55555`,  // 포트 고정
      address: `10.8.${dongle.dongleNumber}.0/24`  // 서버에서 지정한 클라이언트 IP
    };
  }
}

// =====================================================
// Exports
// =====================================================

// 싱글톤 인스턴스
const errorLogger = new ErrorLoggerStub();

module.exports = {
  HubApiClient,
  BatchAllocator,
  DongleAllocator,
  errorLogger,
  extractErrorCode,
  getEthernetIp
};