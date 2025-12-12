/**
 * TaskResultLogger - 작업 결과 상세 로깅
 *
 * DB 장애 대비 로컬 백업 + 디버깅용 상세 로그
 * - 일별 JSONL 파일로 저장 (logs/tasks/YYYY-MM-DD.jsonl)
 * - 30일 자동 정리
 * - grep으로 쉽게 필터링 가능
 *
 * 사용법:
 *   const logger = new TaskResultLogger();
 *   logger.logResult({ agentId, keyword, productId, result, errorType, ... });
 */

const fs = require('fs');
const path = require('path');

class TaskResultLogger {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(process.cwd(), 'logs', 'tasks');
    this.retentionDays = options.retentionDays || 30;
    this.enabled = options.enabled !== false;

    // 디렉토리 생성
    if (this.enabled && !fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // 시작 시 오래된 파일 정리
    if (this.enabled) {
      this.cleanup();
    }
  }

  /**
   * 오늘 날짜 파일 경로
   */
  getTodayFilePath() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.logDir, `${today}.jsonl`);
  }

  /**
   * 작업 결과 로깅
   * @param {Object} data - 로그 데이터
   */
  logResult(data) {
    if (!this.enabled) return;

    const now = new Date();
    const logEntry = {
      time: now.toISOString(),
      ts: now.getTime(),
      ...data
    };

    try {
      const filePath = this.getTodayFilePath();
      fs.appendFileSync(filePath, JSON.stringify(logEntry) + '\n');
    } catch (err) {
      // 로깅 실패는 무시 (메인 작업에 영향 없음)
      console.error(`[TaskResultLogger] 로깅 실패: ${err.message}`);
    }
  }

  /**
   * 성공 로그
   */
  logSuccess(agentId, task, extras = {}) {
    this.logResult({
      agentId,
      status: 'SUCCESS',
      keyword: task.keyword,
      productId: task.productId,
      itemId: task.itemId,
      vendorItemId: task.vendorItemId,
      workType: task.workType,
      vpnIp: extras.vpnIp,
      elapsed: extras.elapsed,
      chromeVersion: extras.chromeVersion
    });
  }

  /**
   * 실패 로그
   */
  logFailure(agentId, task, errorType, errorMessage, extras = {}) {
    this.logResult({
      agentId,
      status: errorType === 'BLOCKED' ? 'BLOCKED' : 'FAIL',
      keyword: task.keyword,
      productId: task.productId,
      itemId: task.itemId,
      vendorItemId: task.vendorItemId,
      workType: task.workType,
      errorType,
      errorMessage: (errorMessage || '').substring(0, 200),
      vpnIp: extras.vpnIp,
      elapsed: extras.elapsed
    });
  }

  /**
   * 30일 이상 오래된 파일 정리
   */
  cleanup() {
    if (!this.enabled) return;

    try {
      const files = fs.readdirSync(this.logDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);
      const cutoff = cutoffDate.toISOString().split('T')[0];

      let deletedCount = 0;
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          const fileDate = file.replace('.jsonl', '');
          if (fileDate < cutoff) {
            fs.unlinkSync(path.join(this.logDir, file));
            deletedCount++;
          }
        }
      }

      if (deletedCount > 0) {
        console.log(`[TaskResultLogger] ${deletedCount}개 오래된 로그 파일 삭제됨`);
      }
    } catch (err) {
      // 정리 실패는 무시
    }
  }

  /**
   * 오늘 통계 요약
   */
  getTodayStats() {
    if (!this.enabled) return null;

    try {
      const filePath = this.getTodayFilePath();
      if (!fs.existsSync(filePath)) return { success: 0, fail: 0, blocked: 0 };

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      let success = 0, fail = 0, blocked = 0;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.status === 'SUCCESS') success++;
          else if (entry.status === 'BLOCKED') blocked++;
          else fail++;
        } catch {}
      }

      return { success, fail, blocked, total: lines.length };
    } catch {
      return null;
    }
  }
}

// 싱글톤 인스턴스
let instance = null;

function getTaskResultLogger(options) {
  if (!instance) {
    instance = new TaskResultLogger(options);
  }
  return instance;
}

module.exports = { TaskResultLogger, getTaskResultLogger };
