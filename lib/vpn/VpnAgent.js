/**
 * VpnAgent - VPN 작업 실행 에이전트
 *
 * 책임:
 * - 배치 사이클 실행 (작업 할당 → 실행 → 결과 제출)
 * - 독립 루프 (연속 실행, 토글 정책 적용)
 * - 작업 실행 (네임스페이스 격리, spawn)
 *
 * 사용법:
 *   const agent = new VpnAgent(vpnManager, {
 *     vpnIndex: 1,
 *     maxThreads: 5,
 *     onceMode: false,
 *     logger: vpnLog,
 *     logDir: '/path/to/logs'
 *   });
 *   await agent.runIndependentLoop();
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { TogglePolicy, ToggleReason } = require('./TogglePolicy');
const { BatchAllocator } = require('../modules/api-service');
const { getTaskResultLogger } = require('./TaskResultLogger');

class VpnAgent {
  /**
   * @param {VpnManager} vpnManager - VPN 연결 관리자
   * @param {Object} options
   * @param {number} options.vpnIndex - VPN 순번 (1~10)
   * @param {number} options.maxThreads - 최대 쓰레드 수
   * @param {boolean} options.onceMode - 1회 실행 모드
   * @param {Function} options.logger - 로깅 함수
   * @param {Function} options.getLogDir - 로그 디렉토리 getter
   * @param {boolean} options.debugMode - 디버그 모드
   */
  constructor(vpnManager, options) {
    this.vpnManager = vpnManager;
    this.agentId = vpnManager.agentId;
    this.vpnIndex = options.vpnIndex;
    this.maxThreads = options.maxThreads || 5;
    this.onceMode = options.onceMode || false;
    this.logger = options.logger || ((id, msg) => console.log(`[${id}] ${msg}`));
    this.getLogDir = options.getLogDir || (() => './logs');
    this.debugMode = options.debugMode || false;

    // 통계
    this.score = 0;
    this.stats = { success: 0, fail: 0, blocked: 0 };
    this.totalStats = { success: 0, fail: 0, blocked: 0, toggleCount: 0, runCount: 0, taskCount: 0 };

    // 상태
    this.running = false;
    this.shouldStop = false;
    this.process = null;

    // 토글 관련 카운터
    this.successSinceToggle = 0;  // 토글 이후 성공 횟수
    this.noWorkCount = 0;         // 연속 작업없음 횟수

    // 토글 정책
    this.togglePolicy = new TogglePolicy();

    // 작업 결과 로거 (싱글톤)
    this.taskResultLogger = getTaskResultLogger();
  }

  /**
   * 로그 출력
   */
  log(msg) {
    this.logger(this.agentId, msg);
  }

  /**
   * 단일 작업을 자식 프로세스로 실행 (네임스페이스 격리)
   * @param {Object} task - 할당된 작업
   * @param {number} threadNum - 쓰레드 번호
   * @returns {Promise<Object>} 실행 결과
   */
  async executeTaskInNamespace(task, threadNum) {
    const TASK_TIMEOUT = 180000;  // 180초 하드 타임아웃 (표준 모드와 동일)
    const startTime = Date.now();
    const allocationKey = task.allocation_key;
    const keywordShort = task.keyword.length > 20 ? task.keyword.substring(0, 20) + '...' : task.keyword;

    this.log(`[T${threadNum}] 작업 시작: ${keywordShort} (${task.product_id})`);

    const namespace = this.vpnManager.getNamespace();
    const dongleNumber = this.vpnManager.getDongleNumber();
    const vpnIp = this.vpnManager.getVpnIp();

    return new Promise((resolve) => {
      // 단일 작업용 스크립트 실행
      const scriptPath = path.join(__dirname, '..', '..', 'lib', 'core', 'single-task-runner.js');

      // 작업 데이터를 환경변수로 전달
      const taskEnv = {
        ...process.env,
        VPN_NAMESPACE: namespace,
        VPN_MODE: 'true',
        VPN_DONGLE: String(dongleNumber),
        VPN_INDEX: String(this.vpnIndex),
        VPN_IP: vpnIp || '',
        AGENT_ID: this.agentId,
        TASK_ALLOCATION_KEY: task.allocation_key,
        TASK_KEYWORD: task.keyword,
        TASK_PRODUCT_ID: task.product_id || '',
        TASK_ITEM_ID: task.item_id || '',
        TASK_VENDOR_ITEM_ID: task.vendor_item_id || '',
        TASK_WORK_TYPE: task.work_type || 'click',
        THREAD_NUMBER: String(threadNum),
        DISPLAY: ':0',
        HOME: '/home/tech',
        USER: 'tech',
        XAUTHORITY: '/home/tech/.Xauthority',
      };

      // VPN 네임스페이스 내에서 node 실행
      const cmd = 'ip';
      const cmdArgs = ['netns', 'exec', namespace, 'node', scriptPath];

      const proc = spawn(cmd, cmdArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: taskEnv
      });

      let stdout = '';
      let stderr = '';
      let isTimedOut = false;
      let isResolved = false;

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        // 디버그 모드: 실시간 출력
        if (this.debugMode) {
          text.split('\n').filter(l => l.trim() && !l.startsWith('__RESULT__:')).forEach(line => {
            this.log(`[T${threadNum}] ${line}`);
          });
        }
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        if (this.debugMode) {
          text.split('\n').filter(l => l.trim()).forEach(line => {
            this.log(`[T${threadNum}] ⚠️ ${line}`);
          });
        }
      });

      // 120초 하드 타임아웃 처리
      const timeoutId = setTimeout(() => {
        if (isResolved) return;
        isTimedOut = true;
        const elapsed = Date.now() - startTime;
        this.log(`[T${threadNum}] ⏰ 하드 타임아웃 (120초 초과) - 강제 종료`);

        try {
          proc.kill('SIGKILL');
        } catch (e) {}

        // 좀비 Chrome 프로세스 정리
        try {
          const profilePath = `vpn_${dongleNumber}`;
          execSync(`pkill -9 -f "${profilePath}" 2>/dev/null || true`);
        } catch (e) {}

        isResolved = true;
        resolve({
          success: false,
          blocked: false,
          allocationKey,
          elapsed,
          errorType: 'TIMEOUT',
          errorMessage: `작업 시간 초과 (120초)`
        });
      }, TASK_TIMEOUT);

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        if (isResolved) return;
        isResolved = true;

        const elapsed = Date.now() - startTime;

        if (isTimedOut || code === null) {
          this.log(`[T${threadNum}] ⏰ 타임아웃 종료 (${elapsed}ms)`);
          resolve({
            success: false,
            blocked: false,
            allocationKey,
            elapsed,
            errorType: 'TIMEOUT',
            errorMessage: `프로세스 타임아웃 (${Math.round(elapsed / 1000)}초)`
          });
          return;
        }

        // 결과 파싱 (stdout에서 __RESULT__: 마커 찾기)
        try {
          const lines = stdout.trim().split('\n');
          let jsonLine = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('__RESULT__:')) {
              jsonLine = line.substring('__RESULT__:'.length);
              break;
            }
          }

          if (jsonLine) {
            const result = JSON.parse(jsonLine);

            if (result.success) {
              this.log(`[T${threadNum}] ✅ 성공: ${keywordShort} (${elapsed}ms)`);

              const extras = {};
              if (result.cookies) extras.cookies = result.cookies;
              if (result.chrome_version) extras.chrome_version = result.chrome_version;
              if (result.vpn_ip) extras.vpn_ip = result.vpn_ip;

              resolve({ success: true, blocked: false, allocationKey, elapsed, extras });
            } else {
              const isBlocked = result.error_type === 'BLOCKED' || result.error_type === 'AKAMAI';
              const emoji = isBlocked ? '🚫' : '❌';
              this.log(`[T${threadNum}] ${emoji} 실패: ${result.error_type} (${elapsed}ms)`);
              resolve({
                success: false,
                blocked: isBlocked,
                allocationKey,
                elapsed,
                errorType: result.error_type,
                errorMessage: result.error_message
              });
            }
            return;
          }
        } catch (parseErr) {
          // JSON 파싱 실패
        }

        // 프로세스 종료 코드로 판단
        if (code === 0) {
          this.log(`[T${threadNum}] ✅ 완료 (${elapsed}ms)`);
          resolve({ success: true, blocked: false, allocationKey, elapsed });
        } else {
          const isBlocked = stderr.includes('HTTP2') || stderr.includes('Akamai') || stderr.includes('403');
          this.log(`[T${threadNum}] ❌ 종료코드 ${code} (${elapsed}ms)`);
          resolve({
            success: false,
            blocked: isBlocked,
            allocationKey,
            elapsed,
            errorType: 'EXIT_ERROR',
            errorMessage: stderr.substring(0, 200) || `Exit code: ${code}`
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        if (isResolved) return;
        isResolved = true;

        const elapsed = Date.now() - startTime;
        this.log(`[T${threadNum}] 💥 프로세스 에러: ${err.message} (${elapsed}ms)`);
        resolve({
          success: false,
          blocked: false,
          allocationKey,
          elapsed,
          errorType: 'SPAWN_ERROR',
          errorMessage: err.message
        });
      });
    });
  }

  /**
   * 배치 사이클 실행 (1회)
   * @returns {Promise<Object>} 사이클 결과
   */
  async runBatchCycle() {
    const runNum = this.totalStats.runCount + 1;
    this.log(`━━━ 배치 사이클 #${runNum} 시작 ━━━`);

    // 0. 작업 할당 전 IP 상태 체크 (빠른 실패)
    const currentIp = this.vpnManager.checkIp();
    if (!currentIp) {
      this.log(`❌ IP 체크 실패 → 작업 할당 전 토글 필요`);
      return {
        agentId: this.agentId,
        score: -10,
        stats: this.stats,
        ipCheckFailed: true
      };
    }

    // 1. 배치 할당 전 IP 재확인 (허브 서버 자동 토글 대응)
    const allocator = this.vpnManager.getAllocator();
    if (!allocator) {
      this.log(`❌ BatchAllocator가 초기화되지 않음`);
      return { agentId: this.agentId, score: 0, stats: this.stats, shouldToggle: false };
    }

    // IP 변경 감지 및 allocator 업데이트
    if (currentIp && currentIp !== this.vpnManager.getVpnIp()) {
      this.log(`🔄 IP 변경 감지: ${this.vpnManager.getVpnIp()} → ${currentIp}`);
      this.vpnManager.vpnIp = currentIp;
      allocator.setExternalIp(currentIp);
    }

    // heartbeat (동글 타임아웃 방지)
    await this.vpnManager.heartbeat();

    const allocResult = await allocator.allocateBatch(this.maxThreads);

    // 새로운 응답 구조 처리: { tasks, success, reason, message }
    const tasks = allocResult?.tasks || (Array.isArray(allocResult) ? allocResult : []);
    const allocReason = allocResult?.reason || null;

    if (!tasks || tasks.length === 0) {
      this.log(`📭 할당된 작업 없음 - 대기 후 재시도`);
      this.totalStats.runCount++;

      // IP_ALL_USED: 토글 필요, 그 외: 60초 대기
      const needsToggle = allocReason === 'IP_ALL_USED';
      const waitSeconds = needsToggle ? 0 : 60;

      return {
        agentId: this.agentId,
        score: 0,
        stats: this.stats,
        shouldToggle: needsToggle,
        noWorkReason: allocReason,
        noWorkWaitSeconds: waitSeconds
      };
    }

    const taskCount = tasks.length;
    this.log(`📋 ${taskCount}개 작업 할당됨 → 순차 시작 (1초 간격)`);

    // 2. 순차 시작 후 병렬 실행
    this.stats = { success: 0, fail: 0, blocked: 0 };

    // 로그 파일 설정
    const logDir = this.getLogDir();
    const logFile = path.join(logDir, `${this.agentId}.log`);
    const headerTime = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    fs.appendFileSync(logFile, `\n${'─'.repeat(50)}\n[${headerTime}] 사이클 #${runNum} - ${taskCount}개 작업\n${'─'.repeat(50)}\n`);

    // 브라우저 시작 간격 (1초)
    const BROWSER_START_INTERVAL = 1000;

    // 순차 시작 후 병렬 대기 (브라우저 동시 시작으로 인한 렉 방지)
    const results = await Promise.all(
      tasks.map(async (task, idx) => {
        const threadNum = idx + 1;

        // 1초 간격으로 브라우저 시작 (첫 번째는 즉시)
        if (idx > 0) {
          await new Promise(r => setTimeout(r, idx * BROWSER_START_INTERVAL));
        }

        const result = await this.executeTaskInNamespace(task, threadNum);

        // 작업 결과 로그 기록 (로컬 백업)
        try {
          const vpnIp = this.vpnManager?.vpnIp;
          if (result.success) {
            this.taskResultLogger.logSuccess(this.agentId, task, {
              vpnIp,
              elapsed: result.elapsed,
              chromeVersion: result.extras?.chrome_version
            });
          } else {
            this.taskResultLogger.logFailure(this.agentId, task, result.errorType, result.errorMessage, {
              vpnIp,
              elapsed: result.elapsed
            });
          }
        } catch (logErr) {
          // 로깅 실패는 무시
        }

        // 결과 즉시 제출
        try {
          if (result.success) {
            // extras에 duration_ms 추가
            const extras = { ...(result.extras || {}), duration_ms: result.elapsed };
            await allocator.submitResult(
              BatchAllocator.createClickSuccess(result.allocationKey, extras)
            );
          } else {
            await allocator.submitResult(
              BatchAllocator.createClickFailure(
                result.allocationKey,
                result.errorType || 'UNKNOWN',
                result.errorMessage || 'Unknown error',
                { duration_ms: result.elapsed }
              )
            );
          }

          // heartbeat (동글 타임아웃 방지)
          await this.vpnManager.heartbeat();
        } catch (submitErr) {
          this.log(`[T${threadNum}] ⚠️ 결과 제출 실패: ${submitErr.message}`);
        }

        return result;
      })
    );

    // 통계 집계
    for (const result of results) {
      if (result.success) {
        this.stats.success++;
      } else if (result.blocked) {
        this.stats.blocked++;
      } else {
        this.stats.fail++;
      }
    }

    // 스코어 계산
    this.score = TogglePolicy.calculateScore(this.stats);

    // 누적 통계
    this.totalStats.success += this.stats.success;
    this.totalStats.fail += this.stats.fail;
    this.totalStats.blocked += this.stats.blocked;
    this.totalStats.taskCount += taskCount;
    this.totalStats.runCount++;

    // 상태 요약
    const statusSummary = this.togglePolicy.getStatusSummary({
      score: this.score,
      noWorkCount: this.noWorkCount,
      successCount: this.successSinceToggle + this.stats.success
    });
    this.log(`사이클 #${runNum} 완료 - 성공:${this.stats.success} 실패:${this.stats.fail} 차단:${this.stats.blocked} → ${statusSummary}`);

    return {
      agentId: this.agentId,
      score: this.score,
      stats: { ...this.stats }
    };
  }

  /**
   * 독립 루프 실행 (연속 모드)
   * @returns {Promise<Object>} 최종 통계
   */
  async runIndependentLoop() {
    this.running = true;

    while (!this.shouldStop) {
      const result = await this.runBatchCycle();

      if (this.shouldStop) break;

      const hasWork = result.stats.success + result.stats.fail + result.stats.blocked > 0;

      // 작업 없음 처리: IP_ALL_USED는 즉시 토글, 나머지는 VPN 반납 후 60초 대기
      if (!hasWork && result.noWorkReason) {
        if (result.noWorkReason === 'IP_ALL_USED') {
          // IP_ALL_USED: 현재 IP로 처리 가능한 상품 없음 → 즉시 토글 (실패 아님)
          this.log(`🔄 IP_ALL_USED - 즉시 IP 변경`);

          // IP 토글
          await this.vpnManager.toggleIp('IP_ALL_USED');

          // VPN 재연결
          const reconnected = await this.vpnManager.reconnect();
          if (!reconnected) {
            this.log('❌ VPN 재연결 실패 → 10초 후 재시도');
            await new Promise(r => setTimeout(r, 10000));
          }
          continue;  // 바로 다음 사이클 (실패 카운트 증가 없음)
        } else {
          // 그 외 (ALL_QUOTA_REACHED, NO_ACTIVE_TASKS, NETWORK_ERROR 등)
          // VPN 종료 + 동글 반납 → 60초 대기 → 새로 연결
          const waitSec = result.noWorkWaitSeconds || 60;
          this.log(`⏳ 작업 없음 (${result.noWorkReason}) - VPN 반납 후 ${waitSec}초 대기...`);

          // VPN 종료 및 동글 반납
          await this.vpnManager.cleanup();

          // 60초 대기
          await new Promise(r => setTimeout(r, waitSec * 1000));

          // 새로 VPN 연결
          this.log(`🔄 ${waitSec}초 대기 완료 - VPN 재연결 시도...`);
          const reconnected = await this.vpnManager.connect();
          if (!reconnected) {
            this.log('❌ VPN 재연결 실패 → 10초 후 재시도');
            await new Promise(r => setTimeout(r, 10000));
          }
          continue;
        }
      } else if (hasWork) {
        this.noWorkCount = 0;
      }

      // 성공 카운터 업데이트
      this.successSinceToggle += result.stats.success;

      // 10회마다 진행 상황 기록
      if (this.vpnManager.fileLogger) {
        this.vpnManager.fileLogger.successProgress(this.successSinceToggle);
      }

      // 토글 조건 확인
      const toggleCheck = this.togglePolicy.shouldToggle({
        ipCheckFailed: result.ipCheckFailed || false,
        noWorkCount: this.noWorkCount,
        score: this.score,
        successCount: this.successSinceToggle
      });

      if (toggleCheck.toggle) {
        const emoji = toggleCheck.reason === ToggleReason.IP_CHECK_FAILED ? '🔌' :
                     toggleCheck.reason === ToggleReason.PREVENTIVE ? '✨' :
                     toggleCheck.reason === ToggleReason.NO_WORK_STREAK ? '📭' : '🔄';

        // 정책 토글 로그 기록 (파일에 상세 기록)
        if (this.vpnManager.fileLogger) {
          this.vpnManager.fileLogger.policyToggle(toggleCheck.reason, toggleCheck.message, {
            successCount: this.successSinceToggle,
            score: this.score,
            noWorkCount: this.noWorkCount
          });
        }

        // 예방적 토글 (성공 50회 초과): 토글 후 반납하고 종료
        if (toggleCheck.reason === ToggleReason.PREVENTIVE) {
          this.log(`${emoji} ${toggleCheck.message} → 토글 후 반납 (임무 완료)`);
          this.totalStats.toggleCount++;

          // 50회 달성 마일스톤 기록
          if (this.vpnManager.fileLogger) {
            this.vpnManager.fileLogger.milestone50(this.successSinceToggle, this.totalStats);
          }

          // 1. IP 토글 (다음 사용자를 위해)
          await this.vpnManager.toggleIp('PREVENTIVE');

          // 2. 동글 반납 및 VPN 정리
          await this.vpnManager.cleanup();

          this.log(`🎉 성공 ${this.successSinceToggle}회 달성 - 정상 종료`);
          break;
        }

        this.log(`${emoji} ${toggleCheck.message} → IP 토글 후 재할당`);
        this.totalStats.toggleCount++;

        // 카운터 리셋
        if (toggleCheck.reason === ToggleReason.NO_WORK_STREAK) {
          this.noWorkCount = 0;
        }

        // 1. IP 토글 (사유 전달)
        const toggleReason = toggleCheck.reason === ToggleReason.BLOCKED ? 'BLOCKED' :
                            toggleCheck.reason === ToggleReason.NO_WORK_STREAK ? 'NO_WORK' : 'MANUAL';
        await this.vpnManager.toggleIp(toggleReason);

        // 2. VPN 재연결
        let reconnected = false;
        const maxAttempts = toggleCheck.reason === ToggleReason.BLOCKED ? 3 : 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          reconnected = await this.vpnManager.reconnect();
          if (reconnected) break;
          this.log(`VPN 재연결 실패 (${attempt}/${maxAttempts}) → ${attempt < maxAttempts ? '10초 후 재시도' : '포기'}`);
          if (attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, 10000));
          }
        }

        if (!reconnected && toggleCheck.reason === ToggleReason.BLOCKED) {
          this.log('❌ VPN 재연결 실패 → 루프 종료');
          break;
        } else if (!reconnected) {
          this.log('❌ VPN 재연결 실패 → 10초 후 재시도');
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }

        this.successSinceToggle = 0;
      }

      // onceMode면 1회 실행 후 종료
      if (this.onceMode) {
        this.log('--once 모드: 1회 실행 완료');
        break;
      }

      // 대기
      const waitTime = hasWork ? 2000 : 10000;
      await new Promise(r => setTimeout(r, waitTime));
    }

    this.running = false;
    return this.totalStats;
  }

  /**
   * 중지
   */
  stop() {
    this.shouldStop = true;
    if (this.process) {
      this.process.kill('SIGTERM');
    }
  }

  /**
   * 총 통계 반환
   */
  getTotalStats() {
    return this.totalStats;
  }
}

module.exports = VpnAgent;
