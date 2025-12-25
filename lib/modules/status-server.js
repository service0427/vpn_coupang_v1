/**
 * HTTP 상태 모니터링 서버
 * - 실시간 쓰레드 상태 확인
 * - 삭제 가능한 모듈 (api-mode.js에서 import 제거하면 됨)
 *
 * Created: 2025-11-21
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

class StatusServer {
  constructor(port = 3303) {
    this.port = port;
    this.server = null;

    // 쓰레드 상태
    this.threads = new Map();

    // 전체 통계
    this.stats = {
      startTime: new Date(),
      totalTasks: 0,
      success: 0,
      failed: 0,
      blocked: 0
    };

    // 작업 시간 기록 (평균 계산용)
    this.taskTimes = [];
    this.maxTaskTimeHistory = 100;  // 최근 100개 작업만 유지

    // 네트워크 초기값 (시작 시점)
    this.initialNetworkRx = this._getNetworkRx();

    // 로그 디렉토리
    this.logDir = path.join(process.cwd(), 'logs', 'monitor');
    this.ensureLogDir();
    this.cleanOldLogs(30);  // 30일 이상 된 로그 삭제
  }

  /**
   * 로그 디렉토리 생성
   */
  ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * 오래된 로그 삭제 (days일 이상)
   */
  cleanOldLogs(days) {
    try {
      const files = fs.readdirSync(this.logDir);
      const now = Date.now();
      const maxAge = days * 24 * 60 * 60 * 1000;

      files.forEach(file => {
        const filePath = path.join(this.logDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
          console.log(`🗑️ 오래된 로그 삭제: ${file}`);
        }
      });
    } catch (e) {
      // 삭제 실패 무시
    }
  }

  /**
   * 작업 결과 로그 저장
   */
  logTask(threadNumber, result) {
    // DEBUG 모드가 아니면 파일 저장 안 함
    if (process.env.LOG_DEBUG !== 'true') return;

    try {
      const today = new Date().toISOString().split('T')[0];  // 2025-11-21
      const logFile = path.join(this.logDir, `${today}.json`);

      const logEntry = {
        timestamp: new Date().toISOString(),
        thread: threadNumber,
        status: result.status,
        keyword: result.keyword || '-',
        proxy: result.proxy || '-',
        chrome: result.chrome || '-',
        executionTime: result.executionTime || 0
      };

      // 파일에 append (줄바꿈으로 구분된 JSON)
      fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
    } catch (e) {
      // 로그 저장 실패 무시
    }
  }

  /**
   * 서버 시작
   */
  start() {
    this.server = http.createServer((req, res) => {
      if (req.url === '/status' || req.url === '/') {
        this.handleStatus(req, res);
      } else if (req.url === '/api/status') {
        this.handleApiStatus(req, res);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    this.server.listen(this.port, () => {
      console.log(`📊 상태 모니터링 서버 시작: http://localhost:${this.port}/status`);

      // 브라우저에서 자동으로 열기 (우측 하단, 작은 창)
      const url = `http://localhost:${this.port}/status`;

      if (process.platform === 'linux') {
        // 화면 해상도 감지 후 우측 하단에 배치
        exec('xrandr | grep "\\*" | head -1', (err, stdout) => {
          let screenWidth = 1920, screenHeight = 1080;
          if (!err && stdout) {
            const match = stdout.match(/(\d+)x(\d+)/);
            if (match) {
              screenWidth = parseInt(match[1]);
              screenHeight = parseInt(match[2]);
            }
          }

          // 창 크기
          const winWidth = 580;
          const winHeight = 900;
          const posX = screenWidth - winWidth - 10;  // 우측 여백 10px
          const posY = screenHeight - winHeight - 10;  // 하단 여백 10px

          // Chrome으로 열기 (위치/크기 지정)
          const chromeCmd = `google-chrome --app=${url} --window-size=${winWidth},${winHeight} --window-position=${posX},${posY} 2>/dev/null || chromium-browser --app=${url} --window-size=${winWidth},${winHeight} --window-position=${posX},${posY} 2>/dev/null`;
          exec(chromeCmd, (err) => {
            if (err) {
              console.log(`   ℹ️ 브라우저에서 직접 열어주세요: ${url}`);
            }
          });
        });
      } else {
        const openCommand = process.platform === 'darwin' ? 'open' : 'start';
        exec(`${openCommand} ${url}`, (err) => {
          if (err) {
            console.log(`   ℹ️ 브라우저에서 직접 열어주세요: ${url}`);
          }
        });
      }
    });

    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`⚠️ 포트 ${this.port} 사용 중 - 상태 서버 비활성화`);
      }
    });

    // 6시간마다 자동 재시작 (메모리 정리)
    this.restartInterval = setInterval(() => {
      this.restart();
    }, 6 * 60 * 60 * 1000);  // 6시간

    // 프로세스 종료 시 서버 정리 (exit 이벤트만 사용)
    // 주의: SIGINT/SIGTERM은 api-mode.js에서 통합 관리 - 중복 등록 금지
    process.on('exit', () => this.stop());
  }

  /**
   * 서버 재시작 (메모리 정리)
   */
  restart() {
    console.log('🔄 상태 서버 재시작 (메모리 정리)...');

    // 통계는 유지, 쓰레드 상태만 초기화
    this.threads.clear();

    // 서버 종료 후 재시작
    if (this.server) {
      this.server.close(() => {
        // close 완료 후 재시작
        this._createAndStartServer();
      });
    } else {
      this._createAndStartServer();
    }
  }

  /**
   * 서버 생성 및 시작 (내부 헬퍼)
   */
  _createAndStartServer() {
    this.server = http.createServer((req, res) => {
      if (req.url === '/status' || req.url === '/') {
        this.handleStatus(req, res);
      } else if (req.url === '/api/status') {
        this.handleApiStatus(req, res);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    // 에러 핸들러 추가 (EADDRINUSE 등)
    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`⚠️ 포트 ${this.port} 사용 중 - 1초 후 재시도...`);
        setTimeout(() => {
          this._createAndStartServer();
        }, 1000);
      } else {
        console.error(`⚠️ 상태 서버 에러: ${err.message}`);
      }
    });

    this.server.listen(this.port, () => {
      console.log(`📊 상태 서버 재시작 완료: http://localhost:${this.port}/status`);
    });
  }

  /**
   * 서버 종료
   */
  stop() {
    if (this.restartInterval) {
      clearInterval(this.restartInterval);
    }
    if (this.server) {
      this.server.close();
      console.log('📊 상태 모니터링 서버 종료');
    }
  }

  /**
   * 쓰레드 상태 업데이트
   */
  updateThread(threadNumber, status) {
    this.threads.set(threadNumber, {
      ...status,
      updatedAt: new Date()
    });
  }

  /**
   * 통계 업데이트
   */
  updateStats(type, executionTime = 0) {
    this.stats.totalTasks++;
    if (type === 'success') this.stats.success++;
    else if (type === 'failed') this.stats.failed++;
    else if (type === 'blocked') this.stats.blocked++;

    // 작업 시간 기록
    if (executionTime > 0) {
      this.taskTimes.push(executionTime);
      if (this.taskTimes.length > this.maxTaskTimeHistory) {
        this.taskTimes.shift();
      }
    }
  }

  /**
   * 네트워크 수신량 (bytes) - /proc/net/dev에서 읽기
   */
  _getNetworkRx() {
    try {
      const data = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = data.split('\n');
      let totalRx = 0;
      for (const line of lines) {
        // eth0, ens 등 실제 네트워크 인터페이스만
        if (line.includes(':') && !line.includes('lo:')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            const rx = parseInt(parts[1], 10);
            if (!isNaN(rx)) totalRx += rx;
          }
        }
      }
      return totalRx;
    } catch (e) {
      return 0;
    }
  }

  /**
   * GPU 사용률 (nvidia-smi)
   */
  _getGpuUsage() {
    return new Promise((resolve) => {
      exec('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null', (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);  // GPU 없거나 에러
        } else {
          resolve(parseInt(stdout.trim(), 10));
        }
      });
    });
  }

  /**
   * 스왑 사용률
   */
  _getSwapUsage() {
    try {
      const data = fs.readFileSync('/proc/meminfo', 'utf8');
      const swapTotal = parseInt(data.match(/SwapTotal:\s+(\d+)/)?.[1] || '0', 10);
      const swapFree = parseInt(data.match(/SwapFree:\s+(\d+)/)?.[1] || '0', 10);
      if (swapTotal === 0) return 0;
      return Math.round(((swapTotal - swapFree) / swapTotal) * 100);
    } catch (e) {
      return 0;
    }
  }

  /**
   * 디스크 사용률 (루트 파티션)
   */
  _getDiskUsage() {
    return new Promise((resolve) => {
      exec("df / | tail -1 | awk '{print $5}' | tr -d '%'", (err, stdout) => {
        if (err) {
          resolve(0);
        } else {
          resolve(parseInt(stdout.trim(), 10) || 0);
        }
      });
    });
  }

  /**
   * 평균 작업 시간 (초)
   */
  _getAvgTaskTime() {
    if (this.taskTimes.length === 0) return 0;
    const sum = this.taskTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.taskTimes.length);
  }

  /**
   * 시간당 처리량
   */
  _getTasksPerHour() {
    const uptimeHours = (Date.now() - this.stats.startTime.getTime()) / (1000 * 60 * 60);
    if (uptimeHours < 0.01) return 0;  // 최소 36초 경과 후 계산
    return Math.round(this.stats.totalTasks / uptimeHours);
  }

  /**
   * HTML 상태 페이지
   */
  async handleStatus(req, res) {
    const uptime = Math.floor((new Date() - this.stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeStr = `${hours}시간 ${minutes}분`;

    // CPU 로드 (1분 평균 / 코어 수 = 사용률)
    const cpuCount = os.cpus().length;
    const loadAvg = os.loadavg()[0];
    const cpuPercent = Math.round((loadAvg / cpuCount) * 100);

    // 메모리 사용률
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

    // 스왑 사용률
    const swapPercent = this._getSwapUsage();

    // GPU 사용률
    const gpuPercent = await this._getGpuUsage();

    // 디스크 사용률
    const diskPercent = await this._getDiskUsage();

    // 네트워크 수신량 (세션 시작 이후)
    const currentRx = this._getNetworkRx();
    const networkRxBytes = currentRx - this.initialNetworkRx;
    const networkRxGB = (networkRxBytes / (1024 * 1024 * 1024)).toFixed(1);

    // 작업 통계
    const avgTaskTime = this._getAvgTaskTime();
    const tasksPerHour = this._getTasksPerHour();

    // 성공률
    const successRate = this.stats.totalTasks > 0
      ? Math.round((this.stats.success / this.stats.totalTasks) * 100)
      : 0;

    // 쓰레드 테이블
    let threadRows = '';
    for (let i = 1; i <= this.threads.size; i++) {
      const t = this.threads.get(i);
      if (t) {
        const statusClass = t.status === 'running' ? 'running' :
                           t.status === 'idle' ? 'idle' : 'error';
        const keyword = t.keyword && t.keyword.length > 15 ? t.keyword.substring(0, 15) + '..' : (t.keyword || '-');
        const proxy = t.proxy && t.proxy.length > 15 ? t.proxy.substring(0, 15) + '..' : (t.proxy || '-');
        const workType = t.workType || '-';
        threadRows += `
          <tr>
            <td>${i}</td>
            <td class="${statusClass}">${t.status || '-'}</td>
            <td class="wt-${workType}">${workType}</td>
            <td>${keyword}</td>
            <td>${proxy}</td>
            <td>${t.chrome || '-'}</td>
          </tr>
        `;
      }
    }

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="5">
  <title>상태 모니터</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Malgun Gothic', sans-serif; font-size: 13px; background: #1a1a1a; color: #e0e0e0; padding: 10px; }
    .sys-info { background: #252525; border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; font-size: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
    .sys-item { color: #888; }
    .sys-item span { color: #4CAF50; font-weight: 600; }
    .sys-item.warn span { color: #FF9800; }
    .sys-item.danger span { color: #f44336; }
    .task-stats { background: #252525; border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; font-size: 12px; display: flex; gap: 15px; align-items: center; }
    .task-stat { display: flex; align-items: center; gap: 4px; }
    .task-stat .label { color: #888; }
    .task-stat .value { font-weight: 600; }
    .task-stat .value.total { color: #2196F3; }
    .task-stat .value.success { color: #4CAF50; }
    .task-stat .value.failed { color: #f44336; }
    .task-stat .value.blocked { color: #FF9800; }
    .task-stat .value.rate { color: #9C27B0; }
    .task-stat .value.time { color: #00BCD4; }
    .task-stat .value.tph { color: #8BC34A; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #333; }
    th { background: #2a2a2a; font-weight: 600; color: #888; font-size: 11px; }
    .running { color: #4CAF50; }
    .idle { color: #666; }
    .error { color: #f44336; }
    .wt-rank { color: #2196F3; }
    .wt-click { color: #FF9800; }
    .wt-idle { color: #9E9E9E; }
    tr:hover { background: #2a2a2a; }
  </style>
</head>
<body>
  <div class="sys-info">
    <div class="sys-item">${uptimeStr}</div>
    <div class="sys-item ${cpuPercent > 80 ? 'danger' : cpuPercent > 60 ? 'warn' : ''}">CPU <span>${cpuPercent}%</span></div>
    <div class="sys-item ${memPercent > 85 ? 'danger' : memPercent > 70 ? 'warn' : ''}">MEM <span>${memPercent}%</span></div>
    <div class="sys-item ${swapPercent > 50 ? 'warn' : ''}">SWAP <span>${swapPercent}%</span></div>
    ${gpuPercent !== null ? `<div class="sys-item">GPU <span>${gpuPercent}%</span></div>` : ''}
    <div class="sys-item">DISK <span>${diskPercent}%</span></div>
    <div class="sys-item">↓<span>${networkRxGB}GB</span></div>
  </div>
  <div class="task-stats">
    <div class="task-stat"><span class="label">전체</span><span class="value total">${this.stats.totalTasks}</span></div>
    <div class="task-stat"><span class="label">성공</span><span class="value success">${this.stats.success}</span></div>
    <div class="task-stat"><span class="label">실패</span><span class="value failed">${this.stats.failed}</span></div>
    <div class="task-stat"><span class="label">차단</span><span class="value blocked">${this.stats.blocked}</span></div>
    <div class="task-stat"><span class="label">성공률</span><span class="value rate">${successRate}%</span></div>
    <div class="task-stat"><span class="label">평균</span><span class="value time">${avgTaskTime}초</span></div>
    <div class="task-stat"><span class="label">처리량</span><span class="value tph">${tasksPerHour}/h</span></div>
  </div>
  <table>
    <thead>
      <tr><th>T</th><th>상태</th><th>타입</th><th>키워드</th><th>프록시</th><th>Chr</th></tr>
    </thead>
    <tbody>
      ${threadRows || '<tr><td colspan="6" style="text-align:center;color:#666;">대기중</td></tr>'}
    </tbody>
  </table>
</body>
</html>
    `;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * JSON API
   */
  handleApiStatus(req, res) {
    const data = {
      uptime: Math.floor((new Date() - this.stats.startTime) / 1000),
      stats: this.stats,
      threads: Object.fromEntries(this.threads)
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }
}

// 싱글톤 인스턴스
let statusServerInstance = null;

function getStatusServer(port = 3303) {
  if (!statusServerInstance) {
    statusServerInstance = new StatusServer(port);
  }
  return statusServerInstance;
}

module.exports = {
  StatusServer,
  getStatusServer
};
