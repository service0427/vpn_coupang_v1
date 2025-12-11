/**
 * VPN 모드 전용 상태 모니터링 서버
 * - 8개 VPN 동글 상태 실시간 확인
 * - 배치 라운드, IP, 성공/실패 추적
 * - IP 토글 이력 표시
 * - 파일 기반 상태 공유 (각 VPN 인스턴스가 독립 프로세스로 실행됨)
 *
 * Created: 2025-12-11
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// 상태 파일 경로
const STATUS_DIR = './browser-data/vpn-status';
const STATUS_FILE = (dongle) => `${STATUS_DIR}/vpn_${dongle}.json`;
const TOGGLE_HISTORY_FILE = `${STATUS_DIR}/toggle-history.json`;

class VpnStatusServer {
  constructor(port = 3304) {
    this.port = port;
    this.server = null;
    this.statusDir = STATUS_DIR;
    this.startTime = new Date();

    // 상태 디렉토리 생성
    this._ensureDir(this.statusDir);
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 파일에서 VPN 상태 읽기
   */
  _readVpnStatus(dongle) {
    try {
      const filePath = STATUS_FILE(dongle);
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data);
      }
    } catch (e) {
      // 읽기 실패 무시
    }
    return {
      dongle,
      ip: '-',
      status: 'offline',
      batchRound: 0,
      threads: {},
      stats: { success: 0, failed: 0, blocked: 0, noWork: 0 },
      lastToggle: null,
      toggleCount: 0,
      lastUpdate: null
    };
  }

  /**
   * 파일에 VPN 상태 쓰기 (각 VPN 인스턴스에서 호출)
   */
  writeVpnStatus(dongle, data) {
    try {
      this._ensureDir(this.statusDir);
      const filePath = STATUS_FILE(dongle);
      const current = this._readVpnStatus(dongle);
      const updated = { ...current, ...data, lastUpdate: new Date().toISOString() };
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
    } catch (e) {
      // 쓰기 실패 무시
    }
  }

  /**
   * 토글 이력 읽기
   */
  _readToggleHistory() {
    try {
      if (fs.existsSync(TOGGLE_HISTORY_FILE)) {
        const data = fs.readFileSync(TOGGLE_HISTORY_FILE, 'utf-8');
        return JSON.parse(data);
      }
    } catch (e) {
      // 읽기 실패 무시
    }
    return [];
  }

  /**
   * 토글 이력 추가 (각 VPN 인스턴스에서 호출)
   */
  appendToggleHistory(entry) {
    try {
      this._ensureDir(this.statusDir);
      const history = this._readToggleHistory();
      history.unshift({ ...entry, time: new Date().toISOString() });
      // 최대 50개 유지
      if (history.length > 50) history.length = 50;
      fs.writeFileSync(TOGGLE_HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (e) {
      // 쓰기 실패 무시
    }
  }

  // ===== API 호환용 메서드 (api-mode.js에서 호출) =====

  updateVpn(dongle, data) {
    this.writeVpnStatus(dongle, data);
  }

  updateThread(dongle, threadIndex, status) {
    const current = this._readVpnStatus(dongle);
    current.threads = current.threads || {};
    current.threads[threadIndex] = { ...status, updatedAt: new Date().toISOString() };
    this.writeVpnStatus(dongle, current);
  }

  recordBatchComplete(dongle, round, results) {
    const current = this._readVpnStatus(dongle);
    current.batchRound = round;
    current.stats = current.stats || { success: 0, failed: 0, blocked: 0, noWork: 0 };
    current.stats.success += results.success || 0;
    current.stats.failed += results.failed || 0;
    current.stats.blocked += results.blocked || 0;
    current.stats.noWork += results.noWork || 0;
    this.writeVpnStatus(dongle, current);
  }

  recordToggle(dongle, oldIp, newIp, reason) {
    const current = this._readVpnStatus(dongle);
    current.lastToggle = new Date().toISOString();
    current.toggleCount = (current.toggleCount || 0) + 1;
    current.ip = newIp || current.ip;
    this.writeVpnStatus(dongle, current);

    this.appendToggleHistory({ dongle, oldIp, newIp, reason });
  }

  // ===== 서버 관련 메서드 =====

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
      console.log(`📊 VPN 상태 모니터링 서버 시작: http://localhost:${this.port}/status`);
    });

    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`⚠️ 포트 ${this.port} 사용 중 - VPN 상태 서버 비활성화`);
      }
    });
  }

  async handleStatus(req, res) {
    const uptime = Math.floor((new Date() - this.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeStr = `${hours}시간 ${minutes}분`;

    // CPU/메모리 정보
    const cpuCount = os.cpus().length;
    const loadAvg = os.loadavg()[0];
    const cpuPercent = Math.round((loadAvg / cpuCount) * 100);
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

    // 모든 VPN 상태 읽기 및 통계 계산
    let totalSuccess = 0, totalFailed = 0, totalBlocked = 0;
    let vpnCards = '';

    for (let dongle = 16; dongle <= 23; dongle++) {
      const vpn = this._readVpnStatus(dongle);

      // 마지막 업데이트 시간 체크 (30초 이상 없으면 offline)
      let status = vpn.status || 'offline';
      if (vpn.lastUpdate) {
        const lastUpdate = new Date(vpn.lastUpdate);
        const elapsed = (Date.now() - lastUpdate.getTime()) / 1000;
        if (elapsed > 30) status = 'offline';
      }

      const statusClass = status === 'running' ? 'running' :
                          status === 'idle' ? 'idle' :
                          status === 'error' ? 'error' : 'offline';

      // 통계 합산
      const stats = vpn.stats || { success: 0, failed: 0, blocked: 0 };
      totalSuccess += stats.success || 0;
      totalFailed += stats.failed || 0;
      totalBlocked += stats.blocked || 0;

      const totalTasks = (stats.success || 0) + (stats.failed || 0) + (stats.blocked || 0);
      const vpnSuccessRate = totalTasks > 0 ? Math.round((stats.success / totalTasks) * 100) : 0;

      // 쓰레드 상태 표시
      let threadDots = '';
      const threads = vpn.threads || {};
      for (const [idx, t] of Object.entries(threads)) {
        const tClass = t.status === 'running' ? 'dot-running' :
                       t.status === 'success' ? 'dot-success' :
                       t.status === 'failed' ? 'dot-failed' : 'dot-idle';
        threadDots += `<span class="thread-dot ${tClass}" title="T${parseInt(idx)+1}: ${t.status}"></span>`;
      }
      if (!threadDots) threadDots = '<span class="thread-dot dot-offline"></span>';

      // 마지막 토글 시간
      const lastToggleStr = vpn.lastToggle
        ? this._formatTimeAgo(new Date(vpn.lastToggle))
        : '-';

      vpnCards += `
        <div class="vpn-card ${statusClass}">
          <div class="vpn-header">
            <span class="vpn-title">VPN ${dongle}</span>
            <span class="vpn-status">${status}</span>
          </div>
          <div class="vpn-ip">${vpn.ip || '-'}</div>
          <div class="vpn-threads">${threadDots}</div>
          <div class="vpn-stats">
            <div class="stat-row">
              <span class="label">라운드</span>
              <span class="value">${vpn.batchRound || 0}</span>
            </div>
            <div class="stat-row">
              <span class="label">성공</span>
              <span class="value success">${stats.success || 0}</span>
            </div>
            <div class="stat-row">
              <span class="label">실패</span>
              <span class="value failed">${stats.failed || 0}</span>
            </div>
            <div class="stat-row">
              <span class="label">성공률</span>
              <span class="value rate">${vpnSuccessRate}%</span>
            </div>
          </div>
          <div class="vpn-toggle">
            <span>토글: ${vpn.toggleCount || 0}회</span>
            <span>최근: ${lastToggleStr}</span>
          </div>
        </div>
      `;
    }

    // 전체 통계
    const totalTasks = totalSuccess + totalFailed + totalBlocked;
    const successRate = totalTasks > 0 ? Math.round((totalSuccess / totalTasks) * 100) : 0;

    // 토글 이력 테이블
    const toggleHistory = this._readToggleHistory();
    let toggleRows = '';
    for (const t of toggleHistory.slice(0, 10)) {
      const timeStr = this._formatTime(new Date(t.time));
      toggleRows += `
        <tr>
          <td>${timeStr}</td>
          <td>VPN ${t.dongle}</td>
          <td>${t.oldIp || '-'}</td>
          <td>${t.newIp || '-'}</td>
          <td>${t.reason || '-'}</td>
        </tr>
      `;
    }

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="3">
  <title>VPN 상태 모니터</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Malgun Gothic', sans-serif; font-size: 13px; background: #1a1a1a; color: #e0e0e0; padding: 15px; }

    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding: 10px 15px; background: #252525; border-radius: 8px; }
    .header-title { font-size: 16px; font-weight: 600; color: #4CAF50; }
    .header-stats { display: flex; gap: 20px; font-size: 12px; }
    .header-stat { color: #888; }
    .header-stat span { font-weight: 600; }
    .header-stat .success { color: #4CAF50; }
    .header-stat .failed { color: #f44336; }
    .header-stat .rate { color: #9C27B0; }

    .sys-info { display: flex; gap: 15px; margin-bottom: 15px; font-size: 12px; color: #888; }
    .sys-info span { color: #4CAF50; font-weight: 600; }
    .sys-info .warn span { color: #FF9800; }
    .sys-info .danger span { color: #f44336; }

    .vpn-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }

    .vpn-card { background: #252525; border-radius: 8px; padding: 12px; border-left: 4px solid #666; }
    .vpn-card.running { border-left-color: #4CAF50; }
    .vpn-card.idle { border-left-color: #FF9800; }
    .vpn-card.error { border-left-color: #f44336; }
    .vpn-card.offline { border-left-color: #666; opacity: 0.6; }

    .vpn-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .vpn-title { font-size: 14px; font-weight: 600; }
    .vpn-status { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #333; }
    .vpn-card.running .vpn-status { background: #1B5E20; color: #81C784; }
    .vpn-card.idle .vpn-status { background: #E65100; color: #FFB74D; }
    .vpn-card.error .vpn-status { background: #B71C1C; color: #EF9A9A; }

    .vpn-ip { font-family: monospace; font-size: 13px; color: #81D4FA; margin-bottom: 8px; }

    .vpn-threads { display: flex; gap: 4px; margin-bottom: 10px; }
    .thread-dot { width: 10px; height: 10px; border-radius: 50%; background: #444; }
    .dot-running { background: #4CAF50; animation: pulse 1s infinite; }
    .dot-success { background: #2196F3; }
    .dot-failed { background: #f44336; }
    .dot-idle { background: #666; }
    .dot-offline { background: #333; }

    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

    .vpn-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 11px; margin-bottom: 8px; }
    .stat-row { display: flex; justify-content: space-between; padding: 2px 0; }
    .stat-row .label { color: #888; }
    .stat-row .value { font-weight: 600; }
    .stat-row .value.success { color: #4CAF50; }
    .stat-row .value.failed { color: #f44336; }
    .stat-row .value.rate { color: #9C27B0; }

    .vpn-toggle { font-size: 10px; color: #666; display: flex; justify-content: space-between; border-top: 1px solid #333; padding-top: 6px; margin-top: 4px; }

    .toggle-section { margin-top: 15px; }
    .toggle-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; color: #888; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; background: #252525; border-radius: 8px; overflow: hidden; }
    th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #333; }
    th { background: #2a2a2a; font-weight: 600; color: #888; }
    tr:hover { background: #2a2a2a; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-title">VPN 상태 모니터</div>
    <div class="header-stats">
      <div class="header-stat">가동시간: <span>${uptimeStr}</span></div>
      <div class="header-stat">전체: <span>${totalTasks}</span></div>
      <div class="header-stat">성공: <span class="success">${totalSuccess}</span></div>
      <div class="header-stat">실패: <span class="failed">${totalFailed}</span></div>
      <div class="header-stat">성공률: <span class="rate">${successRate}%</span></div>
    </div>
  </div>

  <div class="sys-info">
    <div class="${cpuPercent > 80 ? 'danger' : cpuPercent > 60 ? 'warn' : ''}">CPU <span>${cpuPercent}%</span></div>
    <div class="${memPercent > 85 ? 'danger' : memPercent > 70 ? 'warn' : ''}">MEM <span>${memPercent}%</span></div>
  </div>

  <div class="vpn-grid">
    ${vpnCards}
  </div>

  <div class="toggle-section">
    <div class="toggle-title">IP 토글 이력 (최근 10건)</div>
    <table>
      <thead>
        <tr><th>시간</th><th>VPN</th><th>이전 IP</th><th>새 IP</th><th>사유</th></tr>
      </thead>
      <tbody>
        ${toggleRows || '<tr><td colspan="5" style="text-align:center;color:#666;">토글 이력 없음</td></tr>'}
      </tbody>
    </table>
  </div>
</body>
</html>
    `;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  handleApiStatus(req, res) {
    const vpns = {};
    for (let dongle = 16; dongle <= 23; dongle++) {
      vpns[dongle] = this._readVpnStatus(dongle);
    }

    const data = {
      uptime: Math.floor((new Date() - this.startTime) / 1000),
      vpns,
      toggleHistory: this._readToggleHistory().slice(0, 20)
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  _formatTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return `${seconds}초 전`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
    return `${Math.floor(seconds / 86400)}일 전`;
  }

  _formatTime(date) {
    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  stop() {
    if (this.server) {
      this.server.close();
      console.log('📊 VPN 상태 모니터링 서버 종료');
    }
  }
}

// 싱글톤 인스턴스
let vpnStatusServerInstance = null;

function getVpnStatusServer(port = 3304) {
  if (!vpnStatusServerInstance) {
    vpnStatusServerInstance = new VpnStatusServer(port);
  }
  return vpnStatusServerInstance;
}

module.exports = {
  VpnStatusServer,
  getVpnStatusServer
};
