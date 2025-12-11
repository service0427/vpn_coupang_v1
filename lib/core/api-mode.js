/**
 * API 모드 실행 모듈
 * 허브 API를 통한 작업 할당/결과 제출 방식
 */

const fs = require('fs');
const path = require('path');
const { executeKeywordSearch } = require('../core/search-executor');
const { executeProductDetailExtraction } = require('../modules/product-detail-handler');
const { browserManager } = require('../modules/browser-service');
const { HubApiClient } = require('../modules/api-service');
const { SharedCacheManager } = require('../modules/browser-service');
const { cleanChromeProfile, calculateWindowPosition, setTotalThreadCount, initializeScreenResolution } = require('../utils/browser-helpers');
const { getRandomChromeVersion } = require('./api/chrome-manager');
const { buildErrorMessage, buildErrorResponse, buildProxyErrorResponse, buildGeneralErrorResponse } = require('./api/error-handler');
const { collectProductData, buildSuccessResponse } = require('./api/result-builder');
const { getStatusServer } = require('../modules/status-server');  // 상태 모니터링 서버
const { getVpnStatusServer } = require('../modules/vpn-status-server');  // VPN 상태 모니터링 서버

// 세션 재사용 파일 경로 (VPN 모드에서는 동적으로 설정됨)
const SESSION_REUSE_FILE_BASE = './browser-data/session-reuse.json';
const SESSION_REUSE_FILE_VPN = (dongle) => `./browser-data/vpn_${dongle}/session-reuse.json`;

class ApiModeRunner {
  constructor(config = {}) {
    this.options = config; // 전체 옵션 저장
    this.threadCount = config.threadCount || 4; // 동시 실행 쓰레드 수
    this.pollInterval = config.pollInterval || 5000; // 5초
    this.isRunning = false;
    this.completedThreads = 0; // --once 모드에서 완료된 쓰레드 수

    // VPN 모드: 쓰레드 인덱스 오프셋 (병렬 실행 시 각 인스턴스가 다른 번호 사용)
    this.vpnMode = config.vpnMode || false;
    this.vpnThreadOffset = config.vpnThreadIndex || 0;  // VPN 모드에서 쓰레드 번호 오프셋
    this.vpnNamespace = config.vpnNamespace || null;
    // VPN 동글 번호 추출 (vpn-16 -> 16)
    this.vpnDongle = this.vpnNamespace ? parseInt(this.vpnNamespace.replace('vpn-', '')) : null;
    // VPN IP 토글 쿨다운 (최소 30초 간격)
    this.lastVpnToggleTime = 0;
    this.VPN_TOGGLE_COOLDOWN = 30000;  // 30초
    this.VPN_TOGGLE_URL = 'http://112.161.54.7/toggle';

    // 브라우저 레이아웃을 위해 전체 스레드 수 설정
    // VPN 모드: 각 VPN 인스턴스가 독립적으로 threadCount개 관리
    setTotalThreadCount(this.threadCount);

    // 화면 해상도 초기화 (비동기로 처리)
    initializeScreenResolution().catch(err => {
      console.log('⚠️ 화면 해상도 초기화 실패, 기본값 사용');
    });

    // 쓰레드별 허브 클라이언트 생성
    this.hubApiClients = new Map();

    // 쓰레드 수만큼 클라이언트 생성
    for (let i = 0; i < this.threadCount; i++) {
      // VPN 모드: VPN 동글별로 독립적인 쓰레드 번호
      // 예: VPN-16 쓰레드 1~4, VPN-17 쓰레드 1~4 (각각 독립적)
      // API 호출 시 동글 번호 + 쓰레드 번호로 구분
      const actualThreadNumber = i + 1;

      // 각 쓰레드별 허브 클라이언트
      this.hubApiClients.set(i, new HubApiClient({
        hubBaseUrl: config.hubBaseUrl,
        threadNumber: actualThreadNumber,  // 쓰레드 번호
        workType: config.workType,  // work_type 파라미터 전달
        vpnDongle: this.vpnDongle  // VPN 동글 번호 (API 호출 시 구분용)
      }));
    }
    
    // 쓰레드 관리
    this.activeThreads = new Map(); // threadId -> threadInfo
    this.threadFirstRun = new Set(); // 첫 실행 추적 (브라우저 시작 지연용)
    
    // 통계
    this.stats = {
      totalAssigned: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      startTime: new Date(),
      activeThreadCount: 0
    };
    
    // 간소화된 통계
    this.threadStats = new Map(); // 쓰레드별 사용 추적

    // 세션 재사용 파일 경로 설정 (VPN 모드별로 분리)
    this.sessionReuseFile = this.vpnMode && this.vpnDongle
      ? SESSION_REUSE_FILE_VPN(this.vpnDongle)
      : SESSION_REUSE_FILE_BASE;

    // 세션 재사용 관리 (파일 기반)
    // { folderKey: { count, lastProductId, lastResult, resetTime, lastTime } }
    this.sessionReuse = this.loadSessionReuse();

    // SharedCache 초기화 (VPN 모드별로 분리)
    const sharedCacheBasePath = this.vpnMode && this.vpnDongle
      ? `./browser-data/vpn_${this.vpnDongle}`
      : (config.basePath || './browser-data');
    this.sharedCacheManager = new SharedCacheManager({ basePath: sharedCacheBasePath });

    // 상태 모니터링 서버 초기화
    this.statusServer = getStatusServer(3303);

    // VPN 상태 모니터링 서버 초기화 (VPN 모드에서만 활성화)
    this.vpnStatusServer = this.vpnMode ? getVpnStatusServer(3304) : null;

    // 좀비 프로세스 정리 인터벌
    this.cleanupInterval = null;

    // 자동 재시작 타이머 (6시간)
    this.autoRestartTimer = null;
    this.AUTO_RESTART_INTERVAL = 6 * 60 * 60 * 1000; // 6시간

    // VPN 배치 모드: 모든 쓰레드 작업 완료 후 실패 여부에 따라 IP 토글
    this.batchResults = new Map();  // threadIndex -> { success, error }
    this.batchRound = 0;  // 현재 배치 라운드

    // 현재 VPN IP (VPN 모드에서 사용)
    this.currentVpnIp = null;

    console.log(`🤖 ApiModeRunner 초기화 (쓰레드: ${this.threadCount}개)`);
  }

  /**
   * API 모드 시작
   */
  async start() {
    if (this.isRunning) {
      console.log('⚠️ API 모드가 이미 실행 중입니다');
      return;
    }

    console.log(`🚀 API 모드 시작 (쓰레드: ${this.threadCount}개)`);
    
    try {
      // SharedCache 초기화
      await this.sharedCacheManager.initialize();

      // 상태 모니터링 서버 시작 (--status 옵션 시에만)
      if (this.options.status) {
        this.statusServer.start();
        // VPN 모드에서는 VPN 상태 서버도 시작
        if (this.vpnStatusServer) {
          this.vpnStatusServer.start();
        }
      }

      // VPN 모드: 현재 IP 확인 및 상태 업데이트
      if (this.vpnMode && this.vpnDongle) {
        await this.updateVpnIp();
        if (this.vpnStatusServer) {
          this.vpnStatusServer.updateVpn(this.vpnDongle, {
            ip: this.currentVpnIp || '-',
            status: 'running',
            batchRound: 0
          });
        }
      }

      // 좀비 프로세스 정리 인터벌 시작 (10분마다)
      this.startCleanupInterval();

      // 자동 재시작 타이머 시작 (6시간마다)
      this.startAutoRestartTimer();

      // 모든 허브 클라이언트의 서버 연결 확인 (VPN 모드: 실패 시 IP 토글 후 재시도)
      let healthCheckSuccess = false;
      const maxRetries = this.vpnMode ? 5 : 1;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const healthChecks = Array.from(this.hubApiClients.values()).map(client => client.checkHealth());
          await Promise.all(healthChecks);
          healthCheckSuccess = true;
          break;
        } catch (healthError) {
          console.error(`❌ 허브 서버 연결 실패 (${attempt}/${maxRetries}): ${healthError.message}`);

          if (this.vpnMode && attempt < maxRetries) {
            console.log(`🔄 VPN IP 변경 후 재시도...`);
            await this.toggleVpnIp();
          } else if (attempt >= maxRetries) {
            throw healthError;
          }
        }
      }

      this.isRunning = true;
      this.stats.startTime = new Date();

      // 메인 워크플로우 루프 시작
      this.startWorkflowLoop();

      console.log(`✅ API 모드 시작 완료 (쓰레드: ${this.threadCount}개)`);

    } catch (error) {
      console.error('❌ API 모드 시작 실패:', error.message);
      throw error;
    }
  }

  /**
   * 워크플로우 루프
   */
  async startWorkflowLoop() {
    console.log(`🔄 워크플로우 시작 (쓰레드: ${this.threadCount}개, 폴링 간격: ${this.pollInterval}ms)`);

    // VPN 배치 모드: 모든 쓰레드가 배치로 동기화되어 실행
    if (this.vpnMode && this.threadCount > 1) {
      await this.startBatchWorkLoop();
    } else {
      // 기존 방식: 각 쓰레드가 독립적으로 실행
      for (let i = 0; i < this.threadCount; i++) {
        this.startThreadWorkLoop(i);
      }
    }
  }

  /**
   * VPN 배치 모드: N개 쓰레드가 동시에 작업 후 모두 완료되면 실패 여부 확인 후 IP 토글
   */
  async startBatchWorkLoop() {
    console.log(`🔄 [VPN 배치 모드] ${this.threadCount}개 쓰레드 동기화 실행`);

    while (this.isRunning) {
      this.batchRound++;
      console.log(`\n═══════════════════════════════════════════════════════════`);
      console.log(`🔄 [VPN 배치 모드] 라운드 ${this.batchRound} 시작 (쓰레드 ${this.threadCount}개)`);
      console.log(`═══════════════════════════════════════════════════════════`);

      // VPN 상태 서버 업데이트 - 라운드 시작
      if (this.vpnStatusServer && this.vpnDongle) {
        this.vpnStatusServer.updateVpn(this.vpnDongle, {
          status: 'running',
          batchRound: this.batchRound
        });
      }

      // 배치 결과 초기화
      this.batchResults.clear();

      // 모든 쓰레드에서 동시에 작업 실행
      const workPromises = [];
      for (let i = 0; i < this.threadCount; i++) {
        // 쓰레드별 0.5초 시차 시작
        const delay = i * 500;
        workPromises.push(this.executeBatchWork(i, delay));
      }

      // 모든 쓰레드 작업 완료 대기
      await Promise.all(workPromises);

      // 배치 결과 분석
      let successCount = 0;
      let failCount = 0;
      let noWorkCount = 0;
      let blockedCount = 0;

      for (const [threadIndex, result] of this.batchResults) {
        if (result.noWork) {
          noWorkCount++;
        } else if (result.success) {
          successCount++;
        } else if (result.blocked) {
          blockedCount++;
          failCount++;  // blocked도 실패로 카운트
        } else {
          failCount++;
        }
      }

      console.log(`\n───────────────────────────────────────────────────────────`);
      console.log(`📊 [VPN 배치 모드] 라운드 ${this.batchRound} 완료`);
      console.log(`   ✅ 성공: ${successCount}개, ❌ 실패: ${failCount}개, ⏳ 작업없음: ${noWorkCount}개`);
      console.log(`───────────────────────────────────────────────────────────`);

      // VPN 상태 서버에 배치 완료 기록
      if (this.vpnStatusServer && this.vpnDongle) {
        this.vpnStatusServer.recordBatchComplete(this.vpnDongle, this.batchRound, {
          success: successCount,
          failed: failCount - blockedCount,
          blocked: blockedCount,
          noWork: noWorkCount
        });
      }

      // --once 모드: 한 번만 실행하고 종료
      if (this.options.once) {
        console.log(`🛑 --once 모드: 배치 완료 후 종료`);
        this.stop();
        process.exit(0);
      }

      // 실패가 1개 이상이면 IP 토글
      if (failCount > 0) {
        console.log(`🔄 [VPN 배치 모드] ${failCount}개 실패 발생 → IP 변경`);
        await this.toggleVpnIp(`라운드 ${this.batchRound}: ${failCount}개 실패`);
      } else if (noWorkCount === this.threadCount) {
        // 모든 쓰레드가 작업이 없으면 30초 대기
        console.log(`⏳ [VPN 배치 모드] 모든 쓰레드 작업 없음. 30초 대기...`);
        if (this.vpnStatusServer && this.vpnDongle) {
          this.vpnStatusServer.updateVpn(this.vpnDongle, { status: 'idle' });
        }
        await new Promise(resolve => setTimeout(resolve, 30000));
      } else {
        // 성공 시 짧은 대기
        const delay = 3000 + Math.random() * 2000;
        console.log(`⏳ [VPN 배치 모드] ${(delay/1000).toFixed(1)}초 후 다음 라운드...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * 배치 모드에서 개별 쓰레드 작업 실행
   */
  async executeBatchWork(threadIndex, delayMs = 0) {
    const threadNumber = threadIndex + 1;

    // 시차 적용
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    // VPN 상태 서버에 쓰레드 상태 업데이트
    if (this.vpnStatusServer && this.vpnDongle) {
      this.vpnStatusServer.updateThread(this.vpnDongle, threadIndex, { status: 'running' });
    }

    try {
      // 작업 실행 (결과 제출 포함)
      const result = await this.processBatchWork(threadIndex);
      this.batchResults.set(threadIndex, result);

      // VPN 상태 서버에 쓰레드 결과 업데이트
      if (this.vpnStatusServer && this.vpnDongle) {
        const status = result.noWork ? 'idle' : (result.success ? 'success' : 'failed');
        this.vpnStatusServer.updateThread(this.vpnDongle, threadIndex, { status });
      }
    } catch (error) {
      console.error(`🔥 [쓰레드 ${threadNumber}] 배치 작업 오류: ${error.message}`);
      this.batchResults.set(threadIndex, { success: false, error: error.message });

      if (this.vpnStatusServer && this.vpnDongle) {
        this.vpnStatusServer.updateThread(this.vpnDongle, threadIndex, { status: 'failed' });
      }
    }
  }

  /**
   * 배치 모드용 작업 처리 (IP 토글 없이 결과만 반환)
   */
  async processBatchWork(threadIndex) {
    const threadNumber = threadIndex + 1;
    const hubApiClient = this.hubApiClients.get(threadIndex);

    try {
      // 쓰레드 상태 업데이트
      this.updateThreadStatus(threadIndex, 'requesting_work');

      // 1. 작업 할당 요청
      const workAllocation = await hubApiClient.allocateWork();

      if (!workAllocation) {
        this.updateThreadStatus(threadIndex, 'idle');
        console.log(`⏳ [쓰레드 ${threadNumber}] 작업이 없음`);
        return { success: true, noWork: true };
      }

      this.stats.totalAssigned++;
      console.log(`🎯 [쓰레드 ${threadNumber}] 작업 할당됨: ${workAllocation.work.keyword} (${workAllocation.allocationKey})`);

      // 2. 작업 실행
      this.updateThreadStatus(threadIndex, 'executing', workAllocation);
      const result = await this.executeWork(workAllocation, threadIndex);

      // 3. 결과 제출 (배치 모드: IP 토글 없이)
      this.updateThreadStatus(threadIndex, 'submitting');
      await this.submitBatchResult(result, threadIndex);

      // 4. 쓰레드 상태 초기화
      this.updateThreadStatus(threadIndex, 'completed');

      return { success: result.success, error: result.success ? null : result.error_message };

    } catch (error) {
      console.error(`❌ [쓰레드 ${threadNumber}] ${error.message}`);
      this.updateThreadStatus(threadIndex, 'error', null, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 배치 모드용 결과 제출 (IP 토글 없이)
   */
  async submitBatchResult(result, threadIndex) {
    const threadNumber = threadIndex + 1;
    const hubApiClient = this.hubApiClients.get(threadIndex);

    try {
      console.log(`📤 [쓰레드 ${threadNumber}] 결과 제출: ${result.allocation_key}`);
      await hubApiClient.submitResult(result);

      if (result.success) {
        console.log(`✅ [쓰레드 ${threadNumber}] 작업 성공적으로 완료 및 제출`);
      } else {
        console.log(`⚠️ [쓰레드 ${threadNumber}] 작업 실패로 제출됨: ${result.error_message}`);
        // 배치 모드: 여기서는 IP 토글하지 않음 (배치 완료 후 일괄 처리)
      }
    } catch (error) {
      console.error(`❌ [쓰레드 ${threadNumber}] 결과 제출 실패: ${error.message}`);
      throw error;
    }
  }

  /**
   * 개별 쓰레드 워크 루프 (기존 방식, 비-VPN 또는 단일 쓰레드)
   */
  async startThreadWorkLoop(threadIndex) {
    const threadNumber = threadIndex + 1; // 쓰레드 번호 (1부터 시작)
    console.log(`🔧 쓰레드 ${threadNumber} 시작`);

    const threadWorkLoop = async () => {
      if (!this.isRunning) {
        return;
      }

      try {
        await this.processNextWork(threadIndex);
      } catch (error) {
        console.error(`🔥 쓰레드 ${threadNumber} 워크플로우 오류:`, error.message);
      }

      // 다음 폴링 스케줄 (쓰레드별 독립적)
      if (this.isRunning) {
        // --once 옵션이 활성화되면 한 번만 실행하고 종료
        if (this.options.once) {
          // completedThreads는 processNextWork 내부에서 증가됨
          // 여기서는 루프만 종료
          return;
        }
        setTimeout(threadWorkLoop, this.pollInterval + (Math.random() * 500)); // 약간의 지연 추가로 동시 요청 방지
      }
    };

    // 쓰레드별 시차 시작 (0.5초씩 간격)
    setTimeout(() => {
      if (this.isRunning) {
        threadWorkLoop();
      }
    }, threadIndex * 500);
  }

  /**
   * 다음 작업 처리 (쓰레드별)
   */
  async processNextWork(threadIndex) {
    const threadNumber = threadIndex + 1;
    const hubApiClient = this.hubApiClients.get(threadIndex);
    
    try {
      // 쓰레드 상태 업데이트
      this.updateThreadStatus(threadIndex, 'requesting_work');
      
      // 1. 작업 할당 요청 (각 쓰레드가 고유한 번호로 요청)
      const workAllocation = await hubApiClient.allocateWork();
      
      if (!workAllocation) {
        this.updateThreadStatus(threadIndex, 'idle');
        
        // --once 모드에서 작업이 없으면 해당 쓰레드 종료
        if (this.options.once) {
          console.log(`📍 [쓰레드 ${threadNumber}] 작업이 없음. --once 모드로 종료`);
          this.completedThreads++;
          
          // 모든 쓰레드가 완료되면 프로그램 종료
          if (this.completedThreads >= this.threadCount) {
            console.log(`\n✅ 모든 쓰레드 완료 (${this.completedThreads}/${this.threadCount})`);
            console.log(`🛑 --once 모드: 프로그램 종료`);
            this.stop();
            process.exit(0);
          }
          return;
        }
        
        console.log(`⏳ [쓰레드 ${threadNumber}] 작업이 없음. 30초 후 재시도...`);
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30초 대기
        return;
      }

      this.stats.totalAssigned++;
      
      console.log(`🎯 [쓰레드 ${threadNumber}] 작업 할당됨: ${workAllocation.work.keyword} (${workAllocation.allocationKey})`);
      
      // 2. 작업 실행
      this.updateThreadStatus(threadIndex, 'executing', workAllocation);
      const result = await this.executeWork(workAllocation, threadIndex);
      
      // 3. 결과 제출 (해당 쓰레드의 허브 클라이언트 사용)
      this.updateThreadStatus(threadIndex, 'submitting');
      await this.submitResult(result, threadIndex);
      
      // 4. 쓰레드 상태 초기화
      this.updateThreadStatus(threadIndex, 'completed');
      
    } catch (error) {
      // 서버 메시지를 그대로 표시
      console.error(`❌ [쓰레드 ${threadNumber}] ${error.message}`);
      this.updateThreadStatus(threadIndex, 'error', null, error.message);
      
      // 작업 할당 관련 에러인 경우
      if (error.message.includes('No proxies available') || 
          error.message.includes('No keywords') ||
          error.message.includes('No active keywords')) {
        
        // --once 모드에서는 에러 발생 시에도 종료
        if (this.options.once) {
          console.log(`📍 [쓰레드 ${threadNumber}] 작업 할당 불가. --once 모드로 종료`);
          this.completedThreads++;
          
          // 모든 쓰레드가 완료되면 프로그램 종료
          if (this.completedThreads >= this.threadCount) {
            console.log(`\n✅ 모든 쓰레드 완료 (${this.completedThreads}/${this.threadCount})`);
            console.log(`🛑 --once 모드: 프로그램 종료`);
            this.stop();
            process.exit(0);
          }
          return;
        }
        
        console.log(`⏳ [쓰레드 ${threadNumber}] 10초 후 재시도...`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10초 대기
      }
    }
  }

  /**
   * 쓰레드 상태 업데이트
   */
  updateThreadStatus(threadIndex, status, workAllocation = null, error = null) {
    const threadNumber = threadIndex + 1;
    const threadInfo = {
      index: threadIndex,
      threadNumber: threadNumber,
      status: status, // idle, requesting_work, executing, submitting, completed, error, waiting_proxy, waiting_work, waiting_limit
      workAllocation: workAllocation,
      error: error,
      lastUpdate: new Date()
    };
    
    this.activeThreads.set(threadIndex, threadInfo);
    
    // 활성 쓰레드 수 업데이트
    this.stats.activeThreadCount = Array.from(this.activeThreads.values())
      .filter(i => ['requesting_work', 'executing', 'submitting'].includes(i.status)).length;
  }

  /**
   * 작업 실행
   */
  async executeWork(workAllocation, threadIndex) {
    // VPN 모드: 쓰레드 번호는 단순히 threadIndex + 1 (폴더 구조가 vpn_동글/쓰레드번호/크롬버전이므로)
    const threadNumber = threadIndex + 1;
    const startTime = new Date();
    const MAX_EXECUTION_TIME = 180000; // 최대 3분 (rank 모드 10페이지 체크 고려)
    const modeLabel = this.vpnMode ? `VPN ${this.vpnNamespace}` : `쓰레드 ${threadNumber}`;
    console.log(`▶️ [${modeLabel}] 작업 실행 시작: ${workAllocation.work.keyword}`);

    // 상태 서버 업데이트 - 작업 시작
    const proxyHost = this.vpnMode
      ? this.vpnNamespace  // VPN 모드에서는 네임스페이스 표시
      : (workAllocation.proxy.url ? new URL(workAllocation.proxy.url).hostname : '-');
    this.statusServer.updateThread(threadNumber, {
      status: 'running',
      keyword: workAllocation.work.keyword,
      workType: workAllocation.work.workType || '-',
      page: 1,
      proxy: proxyHost,
      chrome: '-'
    });

    let browser = null;
    let page = null;
    let actualChromeVersion = null;  // 실제 사용된 Chrome 버전 (catch 블록에서도 접근 가능하도록 밖으로 이동)
    let cleanup = null;  // 브라우저 cleanup 함수

    // V2 시스템을 위한 키워드 데이터 구성 (catch 블록에서도 접근 가능하도록 밖으로 이동)
    const keywordData = {
        id: null, // API 모드에서는 DB ID 없음
        allocation_key: workAllocation.allocationKey, // 멀티쓰레드 세션 구분용
        keyword: workAllocation.work.keyword,
        product_code: workAllocation.work.code,
        search_url: workAllocation.work.searchUrl, // 서버 제공 검색 URL (필터 포함)
        work_type: workAllocation.work.workType, // work_type 추가 ("rank" 등)
        item_id: workAllocation.work.itemId, // item_id 추가
        vendor_item_id: workAllocation.work.vendorItemId, // vendor_item_id 추가
        agent: `api_instance_${threadNumber}`,
        cart_click_enabled: true, // 항상 활성화 (고정)
        proxy_server: this.options.forceProxy || workAllocation.proxy.url,  // CLI 프록시 우선
        // V2 최적화 설정 적용 (모든 차단 활성화)
        optimize: true,
        coupang_main_allow: '["document"]'
      };

    // 세션 재사용 추적 변수 (catch 블록에서도 접근 가능)
    let folderKey = null;
    let currentProductId = workAllocation.work.code || '';
    let needClean = false;

    try {
      // 쓰레드별 폴더 번호 (Chrome 버전별 서브폴더는 Chrome 선택 후 설정)
      const folderNumber = String(threadNumber).padStart(2, '0'); // 1 -> 01, 10 -> 10

      // userFolderPath는 Chrome 버전 선택 후 설정됨 (PROFILE_SETUP 섹션 참조)
      let userFolderPath = null;
      
      // 브라우저 옵션 구성 (최적화된 프로필 사용)
      let proxyConfig = null;

      // VPN 모드에서는 프록시를 사용하지 않음 (네트워크가 이미 VPN 터널을 통과)
      if (this.vpnMode) {
        console.log(`   🌐 [${modeLabel}] VPN 모드 - 프록시 없이 직접 연결`);
        proxyConfig = null;
      } else if (this.options.forceProxy) {
        // CLI에서 강제 프록시가 지정된 경우 우선 사용
        console.log(`   🔄 [쓰레드 ${threadNumber}] CLI 강제 프록시 사용: ${this.options.forceProxy}`);
        const [host, port, username, password] = this.options.forceProxy.split(':');
        proxyConfig = {
          server: `http://${host}:${port}`,
          username: username || undefined,
          password: password || undefined
        };
      } else {
        // 허브에서 할당받은 프록시 사용
        proxyConfig = this.parseProxyUrl(workAllocation.proxy.url);
      }
      
      // 브라우저 위치와 크기 계산 (스레드 수에 따라 자동 배치)
      // VPN 모드: 오프셋을 적용하여 각 인스턴스가 다른 위치에 배치되도록
      const { calculateViewportSize } = require('../utils/browser-helpers');
      const layoutIndex = this.vpnMode ? this.vpnThreadOffset : threadIndex;
      const windowPosition = calculateWindowPosition(layoutIndex);
      const viewportSize = calculateViewportSize(layoutIndex);
      
      // 위치와 크기 정보 합치기
      const browserLayout = {
        x: windowPosition.x,
        y: windowPosition.y,
        width: viewportSize.width,
        height: viewportSize.height
      };
      
      console.log(`   📐 [쓰레드 ${threadNumber}] 브라우저 배치: (${browserLayout.x}, ${browserLayout.y}) 크기: ${browserLayout.width}x${browserLayout.height}`);

      // Chrome 버전 선택 처리
      let executablePath = null;

      // Chrome 버전이 지정되지 않았으면 랜덤 선택 (제외 목록 적용)
      if (!this.options.chromeVersion) {
        const excludedBuilds = workAllocation.work.excludedChromeBuilds || [];
        const randomChrome = getRandomChromeVersion(excludedBuilds);
        if (randomChrome) {
          executablePath = randomChrome.path;
          actualChromeVersion = randomChrome.version;
          console.log(`   🎲 [쓰레드 ${threadNumber}] 랜덤 Chrome 선택: ${actualChromeVersion} (${randomChrome.dir})`);
        } else {
          console.log(`   ⚠️ [쓰레드 ${threadNumber}] 설치된 Chrome 버전이 없습니다. 기본 Chrome 사용`);
        }
      } else {
        // 특정 버전이 지정된 경우 기존 로직 사용
        const version = String(this.options.chromeVersion);
        const fs = require('fs');
        const path = require('path');
        const homeDir = require('os').homedir();
        const chromeBaseDir = path.join(homeDir, 'chrome-versions');

        // chrome-versions 디렉토리 존재 확인
        if (!fs.existsSync(chromeBaseDir)) {
          console.log(`   ⚠️ [쓰레드 ${threadNumber}] Chrome 버전 디렉토리가 없습니다.`);
          console.log(`   📦 Chrome ${version} 설치가 필요합니다.`);
          console.log(`   ────────────────────────────────────────────`);
          console.log(`   설치 방법:`);
          console.log(`     ./install-chrome.sh ${version}`);
          console.log(`   ────────────────────────────────────────────`);
          console.log(`   모든 버전 설치:`);
          console.log(`     ./install-chrome.sh all`);
          console.log(`   ────────────────────────────────────────────`);
          throw new Error(`Chrome ${version} 버전이 설치되지 않음. 위 명령으로 설치 후 재실행하세요.`);
        }

        // 버전 디렉토리 찾기
        let dirs = [];

        // 전체 빌드 번호가 지정된 경우 (예: 140.0.7339.207 또는 140.207)
        if (version.includes('.')) {
          // 다양한 형식으로 시도
          const versionParts = version.split('.');

          // 전체 버전 형식 (140.0.7339.207 → chrome-140-0-7339-207)
          const fullDir = `chrome-${version.replace(/\./g, '-')}`;

          // 짧은 버전 형식 (140.207 → chrome-140-207)
          const shortDir = versionParts.length === 2 ?
            `chrome-${versionParts[0]}-${versionParts[1]}` :
            null;

          // 중간 버전 형식 (140.0.7339.207 → chrome-140-207)
          const compactDir = versionParts.length >= 4 ?
            `chrome-${versionParts[0]}-${versionParts[3]}` :
            null;

          // 모든 형식 시도
          dirs = fs.readdirSync(chromeBaseDir).filter(dir => {
            return dir === fullDir ||
                   dir === shortDir ||
                   dir === compactDir ||
                   (dir.startsWith(`chrome-${versionParts[0]}-`) &&
                    dir.includes(versionParts[versionParts.length - 1]));
          });

          if (dirs.length === 0) {
            console.log(`   ⚠️ [쓰레드 ${threadNumber}] Chrome ${version} 정확한 버전을 찾을 수 없습니다.`);
            // 메이저 버전으로 폴백
            const majorVersion = versionParts[0];
            console.log(`   🔄 Chrome ${majorVersion} 메이저 버전에서 최신 빌드를 찾습니다...`);
            dirs = fs.readdirSync(chromeBaseDir).filter(dir => {
              return dir.startsWith(`chrome-${majorVersion}-`) || dir === `chrome-${majorVersion}`;
            });
          }
        } else {
          // 메이저 버전만 지정된 경우 (예: 140)
          // 해당 메이저 버전의 모든 빌드 찾기
          dirs = fs.readdirSync(chromeBaseDir).filter(dir => {
            return dir.startsWith(`chrome-${version}-`) || dir === `chrome-${version}`;
          });
        }

        if (dirs.length > 0) {
          // 버전 번호 기준으로 정렬하여 최신 버전 선택
          const selectedDir = dirs.sort((a, b) => {
            // chrome-140-0-7339-207 형식에서 버전 번호 추출
            const getVersionParts = (dir) => {
              const parts = dir.replace('chrome-', '').split('-');
              return parts.map(p => parseInt(p) || 0);
            };

            const aParts = getVersionParts(a);
            const bParts = getVersionParts(b);

            // 각 부분을 순서대로 비교
            for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
              const aVal = aParts[i] || 0;
              const bVal = bParts[i] || 0;
              if (aVal !== bVal) return aVal - bVal;
            }
            return 0;
          }).pop();  // 가장 최신 버전 선택

          executablePath = path.join(chromeBaseDir, selectedDir, 'opt/google/chrome/chrome');

          if (fs.existsSync(executablePath)) {
            // VERSION 파일에서 정확한 버전 읽기
            const versionFile = path.join(chromeBaseDir, selectedDir, 'VERSION');
            if (fs.existsSync(versionFile)) {
              actualChromeVersion = fs.readFileSync(versionFile, 'utf8').trim();
              if (version.includes('.') && version.split('.').length >= 4) {
                // 전체 버전이 지정되었을 때
                console.log(`   🎯 [쓰레드 ${threadNumber}] Chrome ${actualChromeVersion} 사용 (요청: ${version})`);
              } else {
                // 메이저 버전만 지정되었을 때
                console.log(`   🎯 [쓰레드 ${threadNumber}] Chrome ${actualChromeVersion} 사용 (메이저 ${version}의 최신 빌드)`);
              }
            } else {
              actualChromeVersion = version;
              console.log(`   🎯 [쓰레드 ${threadNumber}] Chrome ${version} 사용: ${selectedDir}`);
            }
          } else {
            console.log(`   ⚠️ [쓰레드 ${threadNumber}] Chrome ${version} 실행 파일을 찾을 수 없음`);
            executablePath = null;
          }
        } else {
          console.log(`   ⚠️ [쓰레드 ${threadNumber}] Chrome ${version} 버전을 찾을 수 없음`);
          console.log(`   📦 Chrome ${version} 설치가 필요합니다.`);
          console.log(`   ────────────────────────────────────────────`);
          console.log(`   설치 방법:`);
          console.log(`     ./install-chrome.sh ${version}`);
          console.log(`   ────────────────────────────────────────────`);
          console.log(`   설치 가능한 버전 확인:`);
          console.log(`     ./install-chrome.sh list`);
          console.log(`   ────────────────────────────────────────────`);
          throw new Error(`Chrome ${version} 버전이 설치되지 않음. 위 명령으로 설치 후 재실행하세요.`);
        }
      }

      // ===== PROFILE_SETUP: Chrome 버전 선택 후 프로필 경로 설정 =====
      // Chrome 메이저 버전 추출 (예: 137.0.7151.119 → 137)
      const chromeMajorVersion = actualChromeVersion ? actualChromeVersion.split('.')[0] : 'default';

      // 프로필 경로 설정
      // VPN 모드: browser-data/vpn_동글번호/쓰레드번호/Chrome메이저버전
      // 일반 모드: browser-data/쓰레드번호/Chrome메이저버전
      if (this.vpnMode && this.vpnDongle) {
        userFolderPath = `/home/tech/coupang_agent_v2/browser-data/vpn_${this.vpnDongle}/${folderNumber}/${chromeMajorVersion}`;
        console.log(`   📁 [${modeLabel}] 프로필 폴더: vpn_${this.vpnDongle}/${folderNumber}/${chromeMajorVersion}`);
      } else {
        userFolderPath = `/home/tech/coupang_agent_v2/browser-data/${folderNumber}/${chromeMajorVersion}`;
        console.log(`   📁 [쓰레드 ${threadNumber}] 프로필 폴더: ${folderNumber}/${chromeMajorVersion}`);
      }

      // 프로필 디렉토리 생성
      const fs = require('fs');
      try {
        fs.mkdirSync(userFolderPath, { recursive: true });
      } catch (e) {
        // 이미 존재하면 무시
      }

      // 캐시 공유 설정
      try {
        const isFirstRun = await this.sharedCacheManager.isFirstRun(userFolderPath);
        await this.sharedCacheManager.setupUserFolderCache(userFolderPath, isFirstRun, false);
        console.log(`   🔗 [쓰레드 ${threadNumber}] 캐시 공유 설정 완료`);
      } catch (cacheError) {
        // 캐시 설정 실패는 무시
      }

      // 세션 재사용 로직 (파일 기반 영구 저장)
      // - 이전 성공한 product_id 목록에 있으면 clean (같은 상품 재검색 방지)
      // - 10회 초과하면 clean (세션 노후화 방지)
      // - 그 외에는 재사용
      folderKey = `${folderNumber}/${chromeMajorVersion}`;
      const sessionInfo = this.sessionReuse.get(folderKey) || { count: 0, successProducts: [] };

      const successProducts = sessionInfo.successProducts || [];
      const isRepeatedProduct = currentProductId && successProducts.includes(currentProductId);
      const isOverLimit = sessionInfo.count >= 10;
      needClean = isRepeatedProduct || isOverLimit;

      if (needClean) {
        const reason = isRepeatedProduct ? '이전 성공 상품' : '10회 초과';
        const lastResult = sessionInfo.lastResult || '-';
        console.log(`   🧹 [쓰레드 ${threadNumber}] 세션 초기화 (${reason}, 이전: ${sessionInfo.count}회, 마지막: ${lastResult})`);
        try {
          await cleanChromeProfile(userFolderPath);
        } catch (prefError) {
          // Preferences 정리 실패는 무시
        }
      } else {
        const newCount = sessionInfo.count + 1;
        const resetTime = sessionInfo.resetTime || '-';
        console.log(`   🔄 [쓰레드 ${threadNumber}] 세션 재사용 (${newCount}/10회, 시작: ${resetTime})`);
      }
      // ===== PROFILE_SETUP 끝 =====

      // 브라우저 실행 (항상 GUI 모드)
      // 첫 실행 시에만 동시 브라우저 시작으로 인한 크래시 방지 - 쓰레드별 1초 지연
      if (!this.threadFirstRun.has(threadNumber)) {
        const browserStartDelay = (threadNumber - 1) * 1000;
        if (browserStartDelay > 0) {
          console.log(`   ⏳ [쓰레드 ${threadNumber}] 브라우저 시작 대기 ${browserStartDelay/1000}초...`);
          await new Promise(resolve => setTimeout(resolve, browserStartDelay));
        }
        this.threadFirstRun.add(threadNumber);
      }

      console.log(`   🚀 [쓰레드 ${threadNumber}] 브라우저 실행 중... (쓰레드별 고정 폴더, GUI 모드)`);

      // 브라우저 시작 재시도 로직 (최대 2회)
      let browserInfo = null;
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          browserInfo = await browserManager.getBrowser({
            proxyConfig,
            usePersistent: true,
            profileName: `${folderNumber}/${chromeMajorVersion}`,  // 01/137, 02/143... 형식
            userDataDir: userFolderPath, // 쓰레드별 + Chrome버전별 폴더
            clearSession: needClean, // 동일상품 또는 10회 초과시만 세션 정리
            headless: false,     // 항상 GUI 모드
            windowPosition: browserLayout,  // 위치와 크기 정보 전달
            gpuDisabled: this.options.noGpu || false,  // GPU 비활성화 옵션
            executablePath: executablePath,  // Chrome 버전 경로
            stealth: this.options.stealth || false  // 스텔스 모드 옵션
          });
          break; // 성공하면 루프 종료
        } catch (err) {
          lastError = err;
          if (attempt < 2) {
            console.log(`   ⚠️ [쓰레드 ${threadNumber}] 브라우저 시작 실패, 2초 후 재시도... (${attempt}/2)`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      if (!browserInfo) {
        throw lastError || new Error('브라우저 시작 실패');
      }

      browser = browserInfo.browser;
      page = browserInfo.page;
      cleanup = browserInfo.cleanup;

      // Chrome 버전 자동 감지 (--chrome 옵션 없어도 동작)
      if (!actualChromeVersion || actualChromeVersion === null) {
        try {
          // browser.version()에서 전체 빌드 번호 가져오기
          const browserVersion = await browser.version();

          // Chromium: "131.0.6778.86" 형식
          // Chrome: "140.0.7339.207" 형식으로 직접 반환
          if (browserVersion && !browserVersion.includes('/')) {
            actualChromeVersion = browserVersion;
            console.log(`   📱 [쓰레드 ${threadNumber}] 감지된 Chrome 버전: ${actualChromeVersion}`);
          } else {
            // 다른 형식일 경우 파싱
            const versionMatch = browserVersion.match(/\/([\d.]+)/);
            if (versionMatch) {
              actualChromeVersion = versionMatch[1];
              console.log(`   📱 [쓰레드 ${threadNumber}] 감지된 Chrome 버전: ${actualChromeVersion}`);
            }
          }

        } catch (e) {
          console.log(`   ⚠️ Chrome 버전 자동 감지 실패: ${e.message}`);
          actualChromeVersion = 'unknown';
        }
      }

      // 상태 서버 업데이트 - Chrome 버전
      this.statusServer.updateThread(threadNumber, {
        status: 'running',
        keyword: workAllocation.work.keyword,
        workType: workAllocation.work.workType || '-',
        page: 1,
        proxy: proxyHost,
        chrome: actualChromeVersion ? actualChromeVersion.split('.')[0] : '?'
      });

      // work_type에 따른 작업 실행 분기
      let automationPromise;
      
      if (keywordData.work_type === 'product_info') {
        // 상품 상세 정보 추출 작업
        console.log(`   📄 [쓰레드 ${threadNumber}] 상품 정보 추출 모드 (product_info)`);
        
        // product_id를 keywordData에 추가 (code에서 복사)
        keywordData.product_id = keywordData.product_code;
        
        automationPromise = executeProductDetailExtraction(
          page,
          keywordData,
          { 
            threadNumber: threadNumber  // 쓰레드 번호 추가
          }
        );
      } else {
        // 기존 키워드 검색 작업 (rank 등)
        console.log(`   🔍 [쓰레드 ${threadNumber}] 키워드 검색 모드 (${keywordData.work_type || 'rank'})`);
        
        automationPromise = executeKeywordSearch(
          page,
          keywordData,
          {
            // checkCookies 옵션 제거됨
            // monitor 옵션 제거됨
            threadNumber: threadNumber,  // 쓰레드 번호 추가
            directUrl: this.options.directUrl || (keywordData.search_url ? true : false),  // search_url이 있으면 자동으로 URL 직접 모드
            once: this.options.once || false  // --once 모드 전달 (Akamai 로깅용)
          }
        );
      }
      
      let timeoutId;
      const timeoutPromise = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Maximum execution time (${MAX_EXECUTION_TIME/1000}s) exceeded`));
        }, MAX_EXECUTION_TIME);
      });

      let automationResult;
      let isTimeout = false;
      try {
        automationResult = await Promise.race([automationPromise, timeoutPromise]);
        clearTimeout(timeoutId);  // 성공 시 타이머 정리
      } catch (timeoutError) {
        clearTimeout(timeoutId);  // 에러 시에도 타이머 정리
        console.log(`⏱️ [쓰레드 ${threadNumber}] 최대 실행 시간(${MAX_EXECUTION_TIME/1000}s) 초과 - 브라우저 강제 종료`);
        isTimeout = true;

        // 브라우저 즉시 강제 종료 (추가 작업 시도하지 않음)
        try {
          if (browser) {
            // 브라우저 강제 종료
            await browser.close().catch(() => {});

            // 잔존 Chrome 프로세스 정리 (해당 프로필)
            const { exec } = require('child_process');
            const profilePath = `browser-data/thread-${threadNumber}`;
            exec(`pkill -9 -f "${profilePath}" 2>/dev/null || true`);

            // 프로필 락 파일 정리
            exec(`rm -f "${profilePath}/SingletonLock" "${profilePath}/SingletonCookie" "${profilePath}/SingletonSocket" 2>/dev/null || true`);

            console.log(`   🔪 [쓰레드 ${threadNumber}] 브라우저 및 잔존 프로세스 정리 완료`);
            browser = null;
            page = null;
          }
        } catch (killError) {
          console.log(`   ⚠️ [쓰레드 ${threadNumber}] 브라우저 강제 종료 중 에러: ${killError.message}`);
        }

        // 타임아웃 결과 설정
        automationResult = {
          success: false,
          errorMessage: `Maximum execution time (${MAX_EXECUTION_TIME/1000}s) exceeded - browser force killed`,
          errorType: 'timeout_force_kill'
        };
      }

      const endTime = new Date();
      const executionTime = endTime.getTime() - startTime.getTime();
      
      // 타임아웃 발생 시 특수 처리
      if (isTimeout) {
        // rank 모드에서 타임아웃 발생 시 부분 성공 처리 가능성 확인
        if (workAllocation.work.workType === 'rank') {
          // automationResult가 없어도 기본 결과 구조 생성
          if (!automationResult) {
            // 브라우저가 살아있으면 현재 페이지 정보 추출 시도
            let currentPage = Math.floor(MAX_EXECUTION_TIME / 1000 / 10);  // 기본 추정치 (9)

            try {
              const currentUrl = await page.url();
              const pageMatch = currentUrl.match(/[&?]page=(\d+)/);
              if (pageMatch) {
                currentPage = parseInt(pageMatch[1]);
                console.log(`   📊 [쓰레드 ${threadNumber}] 타임아웃 시 현재 페이지: ${currentPage}`);
              } else {
                // page 파라미터 없으면 1페이지
                if (currentUrl.includes('coupang.com/np/search')) {
                  currentPage = 1;
                  console.log(`   📊 [쓰레드 ${threadNumber}] 타임아웃 시 현재 페이지: 1 (검색 페이지)`);
                }
              }
            } catch (e) {
              // 브라우저 종료됨 - 추정치 사용
              console.log(`   ⚠️ [쓰레드 ${threadNumber}] 브라우저 종료로 페이지 정보 추출 실패 - 추정치 사용: ${currentPage}`);
            }

            automationResult = {
              success: false,
              productFound: false,
              pagesSearched: currentPage,  // 실제 페이지 또는 추정치
              errorMessage: 'Timeout occurred',
              errorType: 'timeout'
            };
          }
          
          // 5페이지 이상 검색했으면 부분 성공으로 처리
          const pagesCompleted = automationResult.pagesSearched || 0;
          if (pagesCompleted >= 5) {
            console.log(`   ✅ [쓰레드 ${threadNumber}] rank 모드 타임아웃 부분 성공 (${pagesCompleted}페이지 완료)`);
            automationResult.success = true;
            automationResult.partialSuccess = true;
            automationResult.errorType = 'timeout_partial';
            automationResult.errorMessage = `${pagesCompleted}페이지 검색 후 타임아웃 (부분 성공)`;
          } else {
            console.log(`   ❌ [쓰레드 ${threadNumber}] rank 모드 타임아웃 실패 (${pagesCompleted}페이지만 완료)`);
            automationResult.success = false;
            automationResult.errorType = 'timeout';
            automationResult.errorMessage = `타임아웃 발생 (${pagesCompleted}페이지 완료)`;
          }
        } else {
          // rank 모드가 아닌 경우 타임아웃은 실패
          console.log(`   ❌ [쓰레드 ${threadNumber}] 타임아웃으로 작업 실패`);
          if (!automationResult) {
            automationResult = {
              success: false,
              errorMessage: 'Maximum execution time exceeded',
              errorType: 'timeout'
            };
          }
        }
      }
      
      // 결과 분석 - 상품을 찾고 클릭 성공하거나, 정상적으로 검색을 완료한 경우 성공
      const productFound = automationResult && automationResult.productFound;
      const clickSuccess = automationResult && !automationResult.error && automationResult.success && automationResult.productFound;
      const errorMessage = automationResult?.error || automationResult?.errorMessage;
      const productFoundButFailed = automationResult?.productFound && !clickSuccess;  // 상품은 찾았지만 클릭 실패
      
      // 에러 타입 및 성공 여부 결정 - 차단(blocked)인 경우만 실패
      let errorType = automationResult?.errorType || null;
      let isBlocked = false;
      
      // 먼저 차단 여부 확인 (타임아웃이 아닌 경우에만)
      if (!isTimeout && errorMessage) {
        const lowerMessage = errorMessage.toLowerCase();
        
        if (lowerMessage.includes('err_http2_protocol_error') || 
            errorMessage.includes('쿠팡 접속 차단') ||
            lowerMessage.includes('captcha')) {
          errorType = 'blocked';
          isBlocked = true;
        }
      }
      
      // 최종 성공 여부 결정: 차단이 아니고 타임아웃 부분 성공이 아니면 실패
      const isSuccess = isTimeout ? (automationResult?.success || false) : !isBlocked;
      
      // referer 검증 - 추가 차단 상황 감지
      let actualPageNumber = 0;
      
      if (!isBlocked && automationResult?.referer) {
        const refererUrl = automationResult.referer;
        console.log(`   📍 [쓰레드 ${threadNumber}] Referer 검증: ${refererUrl}`);
        
        // work_type별로 다른 검증 로직 적용
        if (keywordData.work_type === 'product_info') {
          // 상품 상세 페이지 검증
          if (!refererUrl.includes('coupang.com/vp/products/') && !refererUrl.includes('coupang.com')) {
            console.log(`   ⚠️ [쓰레드 ${threadNumber}] 비정상 Referer - 쿠팡 상품 페이지가 아님`);
            errorType = 'blocked';
            isBlocked = true;
          } else {
            console.log(`   ✅ [쓰레드 ${threadNumber}] 정상 상품 페이지 접근`);
          }
        } else {
          // 기존 키워드 검색 검증 로직
          if (!refererUrl.includes('coupang.com/np/search')) {
            console.log(`   ⚠️ [쓰레드 ${threadNumber}] 비정상 Referer - 검색 페이지가 아님`);
            errorType = 'blocked';
            isBlocked = true;
          } else {
            // URL에서 page 파라미터 추출
            const pageMatch = refererUrl.match(/[&?]page=(\d+)/);
            actualPageNumber = pageMatch ? parseInt(pageMatch[1]) : 1;
            
            // work_type별 예상 최대 페이지 수
            const expectedMaxPages = (() => {
              switch(keywordData.work_type) {
                case 'rank':
                  return 10;
                case 'idle':
                  return 1;  // idle은 쿠키 워밍업용, 1페이지만
                case 'click':
                  return 3;  // 3페이지로 증가
                case 'product_info':
                  return 1;
                default:
                  return 10;
              }
            })();
            
            // pagesSearched가 100 이상이면 검색 결과 없음으로 정상 처리
            const isNoResults = automationResult?.pagesSearched >= 100;

            // 1페이지 차단 체크: cookieState가 search_blocked_1page이면 검색 직후 차단
            const isFirstPageBlocked = automationResult?.cookieState === 'search_blocked_1page' ||
              (actualPageNumber === 1 && !productFound && !isNoResults && expectedMaxPages > 1);

            // 상품을 찾지 못했고 예상 최대 페이지보다 적게 검색한 경우만 차단 의심
            if (isFirstPageBlocked) {
              // 1페이지 차단 - 검색하자마자 차단됨
              console.log(`   ⚠️ [쓰레드 ${threadNumber}] 1페이지 차단: 검색 직후 차단됨`);
              errorType = 'blocked';
              isBlocked = true;
            } else if (!productFound && actualPageNumber < expectedMaxPages && actualPageNumber > 1 && !isNoResults) {
              // 예상보다 일찍 종료는 비정상 (검색 결과 없음 제외)
              console.log(`   ⚠️ [쓰레드 ${threadNumber}] 비정상 종료: ${actualPageNumber}페이지에서 중단됨 (${expectedMaxPages}페이지 미도달)`);
              errorType = 'blocked';
              isBlocked = true;
            } else if (isNoResults) {
              console.log(`   ✅ [쓰레드 ${threadNumber}] 검색 결과 없음 (페이지: ${automationResult?.pagesSearched})`);
            } else {
              console.log(`   ✅ [쓰레드 ${threadNumber}] 정상 검색: ${actualPageNumber}페이지까지 검색 완료`);
            }
          }
        }
      } else if (!isBlocked && !automationResult?.referer) {
        // work_type별로 다른 referer 검증
        if (keywordData.work_type === 'product_info') {
          // 상품 상세 페이지에서는 referer 없음을 덜 엄격하게 처리
          console.log(`   ⚠️ [쓰레드 ${threadNumber}] Referer 없음 - 상품 페이지 직접 접근 가능성`);
        } else {
          // 키워드 검색에서는 referer 없음을 비정상으로 처리
          console.log(`   ⚠️ [쓰레드 ${threadNumber}] Referer 없음 - 비정상 종료 의심`);
          errorType = 'blocked';
          isBlocked = true;
        }
      }
      
      // 최종 성공 여부 재결정 (referer 검증 후 및 타임아웃 부분 성공 고려)
      const finalSuccess = isTimeout ? (automationResult?.success || false) : !isBlocked;
      
      // 통계 업데이트 (referer 검증 후)
      if (finalSuccess) {
        this.stats.completed++;
        this.statusServer.updateStats('success');
        this.statusServer.updateThread(threadNumber, { status: 'idle', keyword: '-', workType: '-', page: '-', proxy: proxyHost, chrome: actualChromeVersion?.split('.')[0] || '?' });
        this.statusServer.logTask(threadNumber, { status: 'success', keyword: workAllocation.work.keyword, proxy: proxyHost, chrome: actualChromeVersion?.split('.')[0] || '?', executionTime });
        if (productFound && clickSuccess) {
          console.log(`✅ [쓰레드 ${threadNumber}] 작업 성공 완료 (상품 발견 및 클릭): ${executionTime}ms`);
        } else if (productFound) {
          console.log(`✅ [쓰레드 ${threadNumber}] 작업 성공 완료 (상품 발견했지만 클릭 실패): ${executionTime}ms`);
        } else {
          console.log(`✅ [쓰레드 ${threadNumber}] 작업 성공 완료 (상품 미발견, 순위 0): ${executionTime}ms`);
        }
      } else {
        // 실패 처리 (차단 또는 타임아웃)
        if (isTimeout && !finalSuccess) {
          // 타임아웃 실패
          this.stats.failed++;
          this.statusServer.updateStats('failed');
          this.statusServer.updateThread(threadNumber, { status: 'idle', keyword: '-', workType: '-', page: '-', proxy: proxyHost, chrome: actualChromeVersion?.split('.')[0] || '?' });
          this.statusServer.logTask(threadNumber, { status: 'failed', keyword: workAllocation.work.keyword, proxy: proxyHost, chrome: actualChromeVersion?.split('.')[0] || '?', executionTime });
          console.log(`⏱️ [쓰레드 ${threadNumber}] 타임아웃 실패: ${executionTime}ms`);
          console.log(`   ❌ rank 모드 조기 타임아웃 (${automationResult?.pagesSearched || 0}페이지만 완료)`);
        } else {
          // 차단된 경우
          this.stats.blocked++;
          this.statusServer.updateStats('blocked');
          this.statusServer.updateThread(threadNumber, { status: 'idle', keyword: '-', workType: '-', page: '-', proxy: proxyHost, chrome: actualChromeVersion?.split('.')[0] || '?' });
          this.statusServer.logTask(threadNumber, { status: 'blocked', keyword: workAllocation.work.keyword, proxy: proxyHost, chrome: actualChromeVersion?.split('.')[0] || '?', executionTime });
          console.log(`🚫 [쓰레드 ${threadNumber}] 쿠팡 차단 감지: ${executionTime}ms`);

          // 디버깅: searchMode 확인
          console.log(`   🔍 [DEBUG] searchMode: ${automationResult?.searchMode || 'undefined'}`);

          // 차단 상세 정보 표시
          if (errorMessage && errorMessage.includes('HTTP2_PROTOCOL_ERROR')) {
            console.log(`   🔴 HTTP2 프로토콜 에러 - 명확한 차단 신호`);
          } else if (actualPageNumber > 0 && actualPageNumber < 10) {
            console.log(`   🔴 ${actualPageNumber}페이지에서 비정상 종료 - 차단 가능성 높음`);
          } else if (!automationResult?.referer) {
            console.log(`   🔴 Referer 없음 - 초기 차단 의심`);
          }
          console.log(`   💡 대응: 프록시 변경 또는 대기 시간 필요`);
        }
      }
      
      // 간소화된 결과 반환 (work_type에 따라 다른 응답 구조)
      if (finalSuccess) {
        // 세션 정보 업데이트 (성공)
        this.updateSessionInfo(folderKey, currentProductId, 'success', needClean);

        // 성공 시 응답 생성
        return buildSuccessResponse(
          keywordData.work_type,
          workAllocation.allocationKey,
          workAllocation.proxyId,
          automationResult,
          actualChromeVersion || 'default'
        );
      } else {
        // 프록시 오류 체크 (차단과 구분)
        const isProxyError = automationResult?.executionStatus === 'ERROR_PROXY' ||
                            automationResult?.errorType === 'proxy_failure' ||
                            (errorMessage && errorMessage.includes('프록시 오류'));

        if (isProxyError) {
          // 세션 정보 업데이트 (프록시 에러)
          this.updateSessionInfo(folderKey, currentProductId, 'proxy_error', needClean);

          // 프록시 오류 응답 생성
          return buildProxyErrorResponse(
            keywordData.work_type,
            workAllocation.allocationKey,
            workAllocation.proxyId,
            automationResult,
            errorMessage || '프록시 연결 실패',
            actualChromeVersion || 'default'
          );
        }

        // work_type별 예상 최대 페이지 수
        const expectedMaxPages = (() => {
          switch(keywordData.work_type) {
            case 'rank':
              return 10;
            case 'idle':
              return 1;  // idle은 쿠키 워밍업용, 1페이지만
            case 'click':
              return 3;
            case 'product_info':
              return 1;
            default:
              return 10;
          }
        })();

        // 차단 메시지 생성
        const finalErrorMessage = buildErrorMessage(
          automationResult,
          errorMessage,
          actualPageNumber,
          expectedMaxPages
        );

        // 세션 정보 업데이트 (차단)
        this.updateSessionInfo(folderKey, currentProductId, 'blocked', needClean);

        // 차단 실패 응답 생성
        return buildErrorResponse(
          keywordData.work_type,
          workAllocation.allocationKey,
          workAllocation.proxyId,
          automationResult,
          finalErrorMessage,
          actualChromeVersion || 'default'
        );
      }

    } catch (error) {
      const endTime = new Date();
      const executionTime = endTime.getTime() - startTime.getTime();

      console.error(`❌ [쓰레드 ${threadNumber}] 작업 실행 실패: ${error.message}`);
      this.stats.failed++;
      this.statusServer.updateStats('failed');
      this.statusServer.updateThread(threadNumber, { status: 'error', keyword: workAllocation.work.keyword, workType: '-', page: '-', proxy: '-', chrome: '-' });
      this.statusServer.logTask(threadNumber, { status: 'error', keyword: workAllocation.work.keyword, proxy: '-', chrome: '-', executionTime });

      // 세션 정보 업데이트 (에러) - folderKey가 설정되지 않았을 수 있음
      if (folderKey) {
        this.updateSessionInfo(folderKey, currentProductId, 'failed', needClean);
      }

      // 일반 에러 응답 생성
      return buildGeneralErrorResponse(
        keywordData.work_type,
        workAllocation.allocationKey,
        workAllocation.proxyId,
        error,
        actualChromeVersion || 'default'
      );
    } finally {
      // 브라우저 정리 - 항상 프로세스 강제 종료 시도
      const { exec } = require('child_process');
      const folderNumber = String(threadNumber).padStart(2, '0');

      try {
        // --keep-browser 옵션이 활성화된 경우 브라우저를 유지하고 사용자 입력 대기
        if (this.options.keepBrowser && browser) {
          console.log(`   🔍 [쓰레드 ${threadNumber}] --keep-browser 옵션: 브라우저 분석을 위해 열어둡니다`);
          console.log(`   ⌨️  브라우저를 닫으려면 Enter를 누르세요...`);

          // 사용자 입력 대기
          await new Promise(resolve => {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once('data', () => {
              process.stdin.setRawMode(false);
              process.stdin.pause();
              resolve();
            });
          });
        }

        // 이벤트 리스너 해제
        if (cleanup) {
          cleanup();
        }

        // 브라우저 종료 시도
        if (browser) {
          try {
            await browser.close();
          } catch (e) {
            // 이미 닫힌 경우 무시
          }
        }

        // /tmp 임시파일 정리 (5번 작업마다)
        if (this.threadStats[threadIndex] && this.threadStats[threadIndex].total % 5 === 0) {
          await browserManager.cleanTempFiles();
        }

        // 캐시 크기 관리 (50번 작업마다)
        if (this.threadStats[threadIndex] && this.threadStats[threadIndex].total % 50 === 0) {
          await this.sharedCacheManager.manageCacheSize(2);  // 2GB 제한
        }

      } catch (closeError) {
        console.warn(`   ⚠️ 브라우저 정리 실패: ${closeError.message}`);
      } finally {
        // 항상 해당 프로필의 잔존 프로세스 강제 종료
        exec(`pkill -9 -f "browser-data/${folderNumber}" 2>/dev/null || true`);
        console.log(`   ✅ [쓰레드 ${threadNumber}] 브라우저 정리 완료`);
      }
    }
  }

  /**
   * 작업 결과 제출
   */
  async submitResult(result, threadIndex) {
    const threadNumber = threadIndex + 1;
    const hubApiClient = this.hubApiClients.get(threadIndex);

    try {
      // 간소화된 제출 결과 로그
      console.log(`📤 [쓰레드 ${threadNumber}] 결과 제출: ${result.allocation_key}`);

      await hubApiClient.submitResult(result);
      
      if (result.success) {
        console.log(`✅ [쓰레드 ${threadNumber}] 작업 성공적으로 완료 및 제출`);
      } else {
        console.log(`⚠️ [쓰레드 ${threadNumber}] 작업 실패로 제출됨: ${result.error_message}`);

        // VPN 모드: 실패 시에만 IP 토글
        if (this.vpnMode) {
          console.log(`🔄 [쓰레드 ${threadNumber}] 실패로 인해 IP 변경 진행...`);
          await this.toggleVpnIp();
        }
      }

      // --once 모드: 작업 완료 카운트
      if (this.options.once) {
        console.log(`🏁 [쓰레드 ${threadNumber}] --once 모드: 작업 완료 후 종료`);
        this.completedThreads++;

        // 모든 쓰레드가 완료되면 프로그램 종료
        if (this.completedThreads >= this.threadCount) {
          console.log(`\n✅ 모든 쓰레드 완료 (${this.completedThreads}/${this.threadCount})`);
          console.log(`🛑 --once 모드: 프로그램 종료`);
          this.stop();
          process.exit(0);
        }
      } else {
        // 무한 반복 모드: 다음 작업 전 대기
        const delay = 3000 + Math.random() * 2000;  // 3~5초
        console.log(`⏳ [쓰레드 ${threadNumber}] ${(delay/1000).toFixed(1)}초 후 다음 작업...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

    } catch (error) {
      console.error(`❌ [쓰레드 ${threadNumber}] 결과 제출 실패: ${error.message}`);
      throw error;
    }
  }

  /**
   * VPN IP 확인 및 업데이트
   */
  async updateVpnIp() {
    if (!this.vpnMode) return;

    try {
      const http = require('http');
      const response = await new Promise((resolve, reject) => {
        const req = http.get('http://mkt.techb.kr/ip', { timeout: 5000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });

      const ipData = JSON.parse(response);
      this.currentVpnIp = ipData.ip || '-';
      console.log(`🌐 [VPN ${this.vpnDongle}] 현재 IP: ${this.currentVpnIp}`);
    } catch (e) {
      console.log(`⚠️ [VPN] IP 확인 실패: ${e.message}`);
    }
  }

  /**
   * VPN IP 토글 (사이클 완료 후 새 IP로 변경)
   * 쿨다운: 최소 30초 간격 유지
   */
  async toggleVpnIp(reason = '실패 발생') {
    if (!this.vpnMode || !this.vpnDongle) {
      return;
    }

    // 쿨다운 체크
    const now = Date.now();
    const elapsed = now - this.lastVpnToggleTime;
    if (elapsed < this.VPN_TOGGLE_COOLDOWN) {
      const waitTime = this.VPN_TOGGLE_COOLDOWN - elapsed;
      console.log(`🔄 [VPN] 쿨다운 대기 중... (${Math.ceil(waitTime / 1000)}초 후 토글 가능)`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    const oldIp = this.currentVpnIp;
    const toggleUrl = `${this.VPN_TOGGLE_URL}/${this.vpnDongle}`;

    try {
      console.log(`🔄 [VPN] IP 변경 요청 중... (동글 ${this.vpnDongle})`);

      const http = require('http');
      const response = await new Promise((resolve, reject) => {
        const req = http.get(toggleUrl, { timeout: 10000 }, (res) => {
          resolve(res);
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });

      // 토글 시간 기록 (성공/실패 무관)
      this.lastVpnToggleTime = Date.now();

      if (response.statusCode === 200) {
        console.log(`✅ [VPN] IP 변경 완료 (동글 ${this.vpnDongle})`);
        // IP 변경 후 안정화 대기
        console.log(`⏳ [VPN] IP 안정화 대기 중... (5초)`);
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 새 IP 확인
        await this.updateVpnIp();

        // VPN 상태 서버에 토글 기록
        if (this.vpnStatusServer) {
          this.vpnStatusServer.recordToggle(this.vpnDongle, oldIp, this.currentVpnIp, reason);
          this.vpnStatusServer.updateVpn(this.vpnDongle, { ip: this.currentVpnIp });
        }
      } else {
        console.log(`⚠️ [VPN] IP 변경 실패: ${response.statusCode}`);
      }
    } catch (e) {
      // 실패해도 토글 시간 기록 (모뎀 보호 목적)
      this.lastVpnToggleTime = Date.now();
      console.log(`⚠️ [VPN] IP 변경 요청 실패: ${e.message}`);
    }
  }

  /**
   * 좀비 프로세스 정리 인터벌 시작
   */
  startCleanupInterval() {
    const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10분

    this.cleanupInterval = setInterval(async () => {
      await this.cleanupZombieProcesses();
    }, CLEANUP_INTERVAL);

    console.log('🧹 좀비 프로세스 정리 인터벌 시작 (10분마다)');
  }

  /**
   * 좀비 Chrome 프로세스 정리
   */
  async cleanupZombieProcesses() {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    try {
      // 현재 Chrome 프로세스 수 확인
      const { stdout: countBefore } = await execAsync('ps aux | grep chrome | grep -v grep | wc -l');
      const processesBefore = parseInt(countBefore.trim()) || 0;

      // 예상 프로세스 수 계산 (쓰레드당 약 15개 프로세스)
      const expectedMax = this.threadCount * 20;

      if (processesBefore > expectedMax) {
        console.log(`🧹 좀비 프로세스 정리 시작: ${processesBefore}개 감지 (예상 최대: ${expectedMax}개)`);

        // 오래된 Chrome 프로세스 강제 종료 (10분 이상 실행된 것, status 창 제외)
        await execAsync(`
          ps aux | grep chrome | grep -v grep | grep -v "app=http://localhost:3303" | awk '{if ($10 ~ /[0-9]+:[0-9]+/ && $10 > "10:00") print $2}' | xargs -r kill -9 2>/dev/null || true
        `);

        // crashpad_handler 정리 (status 창 관련 제외)
        await execAsync(`
          ps aux | grep chrome_crashpad_handler | grep -v grep | grep -v "status" | awk '{print $2}' | head -50 | xargs -r kill -9 2>/dev/null || true
        `);

        // /tmp 임시 파일 정리
        await browserManager.cleanTempFiles();

        // 정리 후 프로세스 수 확인
        const { stdout: countAfter } = await execAsync('ps aux | grep chrome | grep -v grep | wc -l');
        const processesAfter = parseInt(countAfter.trim()) || 0;

        console.log(`🧹 좀비 프로세스 정리 완료: ${processesBefore} → ${processesAfter}개 (${processesBefore - processesAfter}개 정리)`);
      } else {
        console.log(`✅ Chrome 프로세스 정상: ${processesBefore}개`);
      }
    } catch (error) {
      console.error('⚠️ 좀비 프로세스 정리 실패:', error.message);
    }
  }

  /**
   * 자동 재시작 타이머 시작
   */
  startAutoRestartTimer() {
    this.autoRestartTimer = setTimeout(async () => {
      console.log('\n🔄 6시간 자동 재시작 시작...');

      try {
        // 현재 통계 출력
        this.printStats();

        // 모든 Chrome 프로세스 강제 종료
        const { exec, spawn } = require('child_process');
        exec('pkill -9 -f chrome 2>/dev/null || true');

        console.log('🔄 3초 후 재시작...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 동일한 인자로 프로세스 재시작
        console.log('🚀 프로그램 재시작 중...');
        const args = process.argv.slice(1);
        const child = spawn(process.argv[0], args, {
          detached: true,
          stdio: 'inherit'
        });
        child.unref();

        // 현재 프로세스 종료
        process.exit(0);
      } catch (error) {
        console.error('❌ 자동 재시작 실패:', error.message);
      }
    }, this.AUTO_RESTART_INTERVAL);

    const hours = this.AUTO_RESTART_INTERVAL / (60 * 60 * 1000);
    console.log(`⏰ 자동 재시작 타이머 시작 (${hours}시간 후)`);
  }

  /**
   * 프록시 URL 파싱
   */
  parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    
    try {
      const url = new URL(proxyUrl);
      const proxyConfig = {
        server: `${url.protocol}//${url.host}`
      };
      
      // username과 password가 있는 경우에만 추가
      if (url.username && url.password) {
        proxyConfig.username = url.username;
        proxyConfig.password = url.password;
      }
      
      return proxyConfig;
    } catch (error) {
      console.warn('⚠️ 프록시 URL 파싱 실패:', error.message);
      return null;
    }
  }

  /**
   * API 모드 중단
   */
  async stop() {
    if (!this.isRunning) {
      console.log('⚠️ API 모드가 실행 중이 아닙니다');
      return;
    }

    console.log('🛑 API 모드 정리 중...');
    this.isRunning = false;

    // 인터벌 및 타이머 정리
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.autoRestartTimer) {
      clearTimeout(this.autoRestartTimer);
      this.autoRestartTimer = null;
    }

    const uptime = (Date.now() - this.stats.startTime.getTime()) / 1000;
    console.log(`✅ API 모드 정상 종료 (가동시간: ${uptime.toFixed(1)}초)`);

    this.printStats();
  }

  /**
   * 통계 출력
   */
  printStats() {
    const uptime = (Date.now() - this.stats.startTime.getTime()) / 1000;
    const successRate = this.stats.totalAssigned > 0 ? 
      (this.stats.completed / this.stats.totalAssigned * 100).toFixed(1) : 0;
    
    console.log('\n📊 실행 통계');
    console.log('─'.repeat(60));
    console.log(`⏱️ 총 가동 시간: ${(uptime / 60).toFixed(1)}분`);
    console.log(`🔧 쓰레드 설정: ${this.threadCount}개`);
    console.log(`⚡ 활성 상태: ${this.isRunning ? '작동중' : '정지'}`);
    console.log(`📋 할당된 작업: ${this.stats.totalAssigned}개`);
    console.log(`✅ 완료된 작업: ${this.stats.completed}개`);
    console.log(`❌ 실패한 작업: ${this.stats.failed}개`);
    console.log(`🚫 차단된 작업: ${this.stats.blocked}개`);
    console.log(`📈 성공률: ${successRate}%`);
    if (uptime > 0) {
      console.log(`⚡ 처리량: ${(this.stats.completed / (uptime / 60)).toFixed(1)} 작업/분`);
    }
    
    // 간소화된 쓰레드 사용 통계
    if (this.threadStats && this.threadStats.size > 0) {
      console.log(`\n📡 쓰레드 사용 통계: ${this.threadStats.size}개 쓰레드 사용됨`);
    }
    
    // 모든 쓰레드 상태 표시
    console.log('\n🤖 쓰레드 상태:');
    for (let i = 0; i < this.threadCount; i++) {
      const threadInfo = this.activeThreads.get(i);
      const threadNumber = i + 1;
      if (threadInfo) {
        const statusIcon = this.getStatusIcon(threadInfo.status);
        const keyword = threadInfo.workAllocation?.work?.keyword || '-';
        console.log(`   쓰레드 ${threadNumber}: ${statusIcon} ${threadInfo.status} (${keyword})`);
      } else {
        console.log(`   쓰레드 ${threadNumber}: 💤 idle`);
      }
    }
    console.log('─'.repeat(60));
  }

  /**
   * 상태 아이콘 반환
   */
  getStatusIcon(status) {
    const icons = {
      idle: '💤',
      requesting_work: '📋',
      executing: '🚀',
      submitting: '📤',
      completed: '✅',
      error: '❌'
    };
    return icons[status] || '❓';
  }

  /**
   * 세션 재사용 파일 로드
   */
  loadSessionReuse() {
    try {
      if (fs.existsSync(this.sessionReuseFile)) {
        const data = fs.readFileSync(this.sessionReuseFile, 'utf-8');
        const parsed = JSON.parse(data);
        console.log(`📂 세션 재사용 정보 로드: ${Object.keys(parsed).length}개 프로필 (${this.sessionReuseFile})`);
        return new Map(Object.entries(parsed));
      }
    } catch (error) {
      console.log(`⚠️ 세션 재사용 파일 로드 실패: ${error.message}`);
    }
    return new Map();
  }

  /**
   * 세션 재사용 파일 저장
   */
  saveSessionReuse() {
    try {
      // 폴더 확인 및 생성
      const dir = path.dirname(this.sessionReuseFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = Object.fromEntries(this.sessionReuse);
      fs.writeFileSync(this.sessionReuseFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.log(`⚠️ 세션 재사용 파일 저장 실패: ${error.message}`);
    }
  }

  /**
   * 세션 정보 업데이트
   * @param {string} folderKey - 프로필 키 (예: "01/140")
   * @param {string} productId - 상품 코드
   * @param {string} result - 결과 (success, blocked, failed)
   * @param {boolean} isReset - 세션 초기화 여부
   */
  updateSessionInfo(folderKey, productId, result, isReset = false) {
    // 한국 시간대로 저장
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const current = this.sessionReuse.get(folderKey) || {};

    if (isReset) {
      // 초기화 시 새로운 정보로 시작
      const newSuccessProducts = (result === 'success' && productId) ? [productId] : [];
      this.sessionReuse.set(folderKey, {
        count: 1,
        successProducts: newSuccessProducts,
        lastResult: result,
        resetTime: now,
        lastTime: now
      });
    } else {
      // 기존 정보 업데이트
      const currentProducts = current.successProducts || [];
      // 성공 시에만 상품 ID 추가 (중복 방지)
      const newSuccessProducts = (result === 'success' && productId && !currentProducts.includes(productId))
        ? [...currentProducts, productId]
        : currentProducts;

      this.sessionReuse.set(folderKey, {
        count: (current.count || 0) + 1,
        successProducts: newSuccessProducts,
        lastResult: result,
        resetTime: current.resetTime || now,
        lastTime: now
      });
    }

    // 파일에 저장
    this.saveSessionReuse();
  }
}

/**
 * API 모드 실행
 */
async function runApiMode(options) {
  const runner = new ApiModeRunner({
    threadCount: options.threadCount || 4,
    hubBaseUrl: 'http://61.84.75.37:3302',  // 고정 허브 서버 (IP 직접 사용)
    basePath: options.basePath,
    pollInterval: 5000,  // 고정 5초 폴링
    // checkCookies 옵션 제거됨
    // monitor 옵션 제거됨
    once: options.once || false,
    keepBrowser: options.keepBrowser || false,
    noGpu: options.noGpu || false,
    forceProxy: options.proxy || null,  // CLI에서 강제 지정한 프록시
    chromeVersion: options.chromeVersion || null,  // Chrome 버전 선택
    directUrl: options.directUrl || false,  // URL 직접 모드
    status: options.status || false,  // 상태 모니터링 서버
    workType: options.workType || null,  // 작업 타입
    // VPN 모드 옵션
    vpnMode: options.vpnMode || false,
    vpnNamespace: options.vpnNamespace || null,
    vpnThreadIndex: options.vpnThreadIndex || 0
  });

  // 우아한 종료 설정 (통합 핸들러 - 중복 등록 방지)
  let isShuttingDown = false;
  let forceExitCount = 0;

  const gracefulShutdown = async (signal) => {
    if (isShuttingDown) {
      forceExitCount++;
      if (forceExitCount >= 2) {
        console.log('\n⚠️ 강제 종료합니다.');
        process.exit(1);
      }
      console.log('\n⚠️ 이미 종료 중입니다. 강제 종료하려면 다시 한 번 누르세요.');
      return;
    }

    isShuttingDown = true;
    console.log(`\n🚨 ${signal} 신호 수신 - 우아한 종료 시작...`);

    // 타임아웃 설정 (10초 후 강제 종료)
    const forceExitTimeout = setTimeout(() => {
      console.log('\n⚠️ 종료 타임아웃 - 강제 종료합니다.');
      process.exit(1);
    }, 10000);

    try {
      await runner.stop();
      await browserManager.shutdown();
      clearTimeout(forceExitTimeout);
      console.log('✅ 종료 완료');
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExitTimeout);
      console.error('❌ 우아한 종료 실패:', error.message);
      process.exit(1);
    }
  };

  // 기존 핸들러 제거 후 새로 등록 (중복 방지)
  const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
  signals.forEach(signal => {
    process.removeAllListeners(signal);
    process.on(signal, () => gracefulShutdown(signal));
  });

  await runner.start();

  // 무한 대기 (SIGINT로 종료될 때까지)
  // setInterval로 변경하여 이벤트 루프가 막히지 않도록 함
  await new Promise((resolve) => {
    const keepAlive = setInterval(() => {
      if (!runner.isRunning) {
        clearInterval(keepAlive);
        resolve();
      }
    }, 1000);
  });
}

module.exports = { runApiMode, ApiModeRunner };