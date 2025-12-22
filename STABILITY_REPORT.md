# 365일 무중단 운영 안정성 평가 보고서

> 작성일: 2024-12-16
> 대상 시스템: 쿠팡 자동화 에이전트 V2
> 평가 목적: 장기 무중단 운영 가능성 검토

---

## 1. 현재 상태 요약

### 1.1 시스템 개요

| 항목 | 현재 설정 |
|------|----------|
| 실행 방식 | `npm start` (직접 실행) |
| 프로세스 매니저 | 미사용 |
| 자동 재시작 | 6시간 주기 내부 로직 |
| 로그 로테이션 | 미적용 |

### 1.2 디스크 사용량 현황 (2024-12-16 기준)

```
logs/          5.2 GB (5일 누적)
browser-data/  3.4 GB
```

**예상 연간 디스크 사용량:**
- 로그: 약 **380 GB/년** (일평균 1.04GB)
- 브라우저 데이터: 약 **50-100 GB** (프로필 누적)

---

## 2. 안정성 평가 결과

### 2.1 위험도 매트릭스

| 항목 | 현재 상태 | 위험도 | 365일 운영 영향 |
|------|----------|--------|----------------|
| 디스크 관리 (로그) | 로테이션 없음 | 🔴 심각 | 1-3개월 내 디스크 풀 |
| 디스크 관리 (프로필) | 자동 정리 없음 | 🟡 중간 | 6개월 내 누적 문제 |
| 프로세스 복구 | 자동 복구 없음 | 🔴 심각 | 크래시 시 서비스 중단 |
| 에러 핸들링 | Global 핸들러 없음 | 🔴 심각 | 예상치 못한 종료 위험 |
| 메모리 관리 | 6시간 재시작으로 대응 | 🟢 양호 | 장기 운영 가능 |
| 브라우저 정리 | 좀비 프로세스 10분 주기 정리 | 🟢 양호 | 안정적 |

### 2.2 잘 구현된 부분

- ✅ **Graceful Shutdown**: SIGINT/SIGTERM 시그널 처리 (`api-mode.js:1813-1851`)
- ✅ **브라우저 인스턴스 재사용**: `activeBrowsers` Map 캐싱
- ✅ **좀비 프로세스 정리**: 10분 주기 자동 정리 (`cleanupZombieProcesses()`)
- ✅ **작업 타임아웃**: 180초 제한으로 무한 실행 방지
- ✅ **Chrome 프로필 정리**: 쿠키, 세션, 캐시 매 실행 시 삭제

### 2.3 최종 평가

```
현재 상태: ❌ 365일 무중단 운영 부적합
예상 장애 시점: 1-3개월 내 (디스크 풀 또는 크래시)
개선 후 예상: ✅ 안정적 운영 가능
```

---

## 3. 문제점 상세 분석

### 3.1 🔴 디스크 관리 문제 (1순위)

#### 3.1.1 로그 파일 무한 증가

**현재 상황:**
```
logs/
├── akamai_YYYYMMDD.csv     # 일별 2-3MB씩 증가
├── access-denied/          # 접근 거부 로그
├── browser-state/          # 브라우저 상태 로그
├── multi-YYYY-MM-DD*/      # 멀티 실행 로그 (폴더별 수MB)
└── vpn/                    # VPN 로그
```

**문제점:**
- 로그 로테이션 없음
- 오래된 로그 자동 삭제 없음
- 동기 I/O 사용 (`fs.appendFileSync`)

**위치:** `lib/modules/api-service.js:61`
```javascript
fs.appendFileSync(logFile, logEntry);  // 매번 블로킹 I/O
```

#### 3.1.2 브라우저 프로필 누적

**현재 상황:**
```
browser-data/
├── vpn_16/
│   ├── 1/
│   │   └── 131.0.6778.204/  # Chrome 버전별 프로필
│   └── 2/
├── vpn_17/
...
```

**문제점:**
- 미사용 프로필 자동 삭제 없음
- Chrome 버전 업데이트 시 구버전 프로필 잔존
- `browser-data/` 전체 크기 제한 없음

### 3.2 🔴 프로세스 관리 문제

#### 3.2.1 Global 에러 핸들러 부재

**현재 상황:**
```javascript
// 아래 핸들러가 없음
process.on('uncaughtException', ...)
process.on('unhandledRejection', ...)
```

**영향:**
- 동기 코드 에러 → 즉시 프로세스 종료
- 미처리 Promise 거부 → Node.js 15+ 에서 프로세스 종료

#### 3.2.2 프로세스 매니저 미사용

**현재 상황:**
- `npm start`로 직접 실행
- PM2, systemd, forever 미사용

**영향:**
- 프로세스 크래시 시 자동 복구 불가
- 서버 재부팅 시 수동 시작 필요
- 리소스 모니터링 불가

### 3.3 🟡 기타 문제

#### HTTP 연결 정리
- axios keep-alive 연결 누적 가능성
- 위치: `lib/modules/api-service.js`

#### 타이머 관리
- `cleanupInterval`, `autoRestartTimer` 정리 로직 불완전
- 위치: `lib/core/api-mode.js:1579-1587`

---

## 4. 개선 방안

### 4.1 1순위: 디스크 관리

#### 4.1.1 로그 로테이션 구현

**방법 A: logrotate 설정 (Linux 시스템 도구)**

```bash
# /etc/logrotate.d/coupang-agent
/home/tech/vpn_coupang_v1/logs/*.csv
/home/tech/vpn_coupang_v1/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 tech tech
    dateext
    dateformat -%Y%m%d
}

/home/tech/vpn_coupang_v1/logs/multi-* {
    daily
    rotate 3
    compress
    missingok
    notifempty
}
```

**방법 B: 자체 정리 스크립트**

```bash
#!/bin/bash
# scripts/cleanup-logs.sh

LOG_DIR="/home/tech/vpn_coupang_v1/logs"
RETENTION_DAYS=7

# 7일 이상 된 로그 파일 삭제
find "$LOG_DIR" -name "*.csv" -mtime +$RETENTION_DAYS -delete
find "$LOG_DIR" -name "*.log" -mtime +$RETENTION_DAYS -delete

# 3일 이상 된 multi-* 폴더 삭제
find "$LOG_DIR" -maxdepth 1 -type d -name "multi-*" -mtime +3 -exec rm -rf {} \;

# 로그 디렉토리 크기 확인
du -sh "$LOG_DIR"
```

**crontab 등록:**
```bash
# crontab -e
0 3 * * * /home/tech/vpn_coupang_v1/scripts/cleanup-logs.sh >> /var/log/coupang-cleanup.log 2>&1
```

#### 4.1.2 브라우저 프로필 정리

```bash
#!/bin/bash
# scripts/cleanup-profiles.sh

BROWSER_DATA="/home/tech/vpn_coupang_v1/browser-data"
RETENTION_DAYS=7

# 7일 이상 미사용 프로필 삭제
find "$BROWSER_DATA" -maxdepth 3 -type d -name "*.0.*" -atime +$RETENTION_DAYS -exec rm -rf {} \; 2>/dev/null

# 전체 크기가 20GB 초과 시 가장 오래된 프로필부터 삭제
MAX_SIZE_GB=20
CURRENT_SIZE=$(du -s "$BROWSER_DATA" | awk '{print int($1/1024/1024)}')

if [ "$CURRENT_SIZE" -gt "$MAX_SIZE_GB" ]; then
    echo "browser-data 크기 초과: ${CURRENT_SIZE}GB > ${MAX_SIZE_GB}GB"
    # 가장 오래된 프로필 폴더 삭제
    find "$BROWSER_DATA" -maxdepth 3 -type d -name "*.0.*" -printf '%T+ %p\n' | \
        sort | head -10 | cut -d' ' -f2- | xargs rm -rf
fi

du -sh "$BROWSER_DATA"
```

#### 4.1.3 디스크 모니터링 알림

```bash
#!/bin/bash
# scripts/disk-monitor.sh

THRESHOLD=80
USAGE=$(df /home | tail -1 | awk '{print $5}' | sed 's/%//')

if [ "$USAGE" -gt "$THRESHOLD" ]; then
    echo "[경고] 디스크 사용량 ${USAGE}% - 임계치 ${THRESHOLD}% 초과"
    # 선택: 알림 전송 (Slack, Discord 등)
fi
```

### 4.2 2순위: 프로세스 관리

#### 4.2.1 Global 에러 핸들러 추가

**수정 파일:** `index.js` (상단에 추가)

```javascript
// ===== Global Error Handlers =====
process.on('uncaughtException', (error) => {
    console.error('❌ [FATAL] Uncaught Exception:', error);
    // 로그 파일에 기록
    const fs = require('fs');
    const logEntry = `[${new Date().toISOString()}] UNCAUGHT_EXCEPTION: ${error.stack}\n`;
    fs.appendFileSync('logs/fatal-errors.log', logEntry);
    process.exit(1);  // PM2가 자동 재시작
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ [ERROR] Unhandled Rejection:', reason);
    const fs = require('fs');
    const logEntry = `[${new Date().toISOString()}] UNHANDLED_REJECTION: ${reason}\n`;
    fs.appendFileSync('logs/fatal-errors.log', logEntry);
    // 치명적이지 않으면 계속 실행, 필요시 process.exit(1)
});

process.on('warning', (warning) => {
    console.warn('⚠️ [WARN]', warning.name, warning.message);
});
// ===== End Global Error Handlers =====
```

#### 4.2.2 PM2 도입

**설치 및 설정:**
```bash
# PM2 설치
npm install -g pm2

# ecosystem 설정 파일 생성
```

**ecosystem.config.js:**
```javascript
module.exports = {
    apps: [{
        name: 'coupang-agent',
        script: 'index.js',
        args: '--threads 4',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '2G',
        env: {
            NODE_ENV: 'production'
        },
        error_file: 'logs/pm2-error.log',
        out_file: 'logs/pm2-out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        merge_logs: true,
        // 6시간마다 재시작 (내부 로직과 별개로 PM2에서도 관리)
        cron_restart: '0 */6 * * *'
    }]
};
```

**PM2 실행:**
```bash
# 시작
pm2 start ecosystem.config.js

# 상태 확인
pm2 status
pm2 logs coupang-agent

# 시스템 시작 시 자동 실행
pm2 startup
pm2 save

# 로그 로테이션 (PM2 플러그인)
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

### 4.3 3순위: 코드 개선

#### 4.3.1 비동기 로깅으로 전환

**현재 (동기):**
```javascript
fs.appendFileSync(logFile, logEntry);
```

**개선 (비동기):**
```javascript
const fs = require('fs').promises;

async function appendLog(logFile, logEntry) {
    try {
        await fs.appendFile(logFile, logEntry);
    } catch (err) {
        console.error('로그 기록 실패:', err.message);
    }
}
```

#### 4.3.2 HTTP 연결 정리 강화

**api-service.js 수정:**
```javascript
const axios = require('axios');

const httpClient = axios.create({
    timeout: 30000,
    httpAgent: new require('http').Agent({
        keepAlive: false  // 연결 재사용 비활성화
    }),
    httpsAgent: new require('https').Agent({
        keepAlive: false
    })
});
```

---

## 5. 구현 체크리스트

### Phase 1: 디스크 관리 (즉시)

- [ ] `scripts/cleanup-logs.sh` 생성
- [ ] `scripts/cleanup-profiles.sh` 생성
- [ ] crontab 등록 (매일 03:00)
- [ ] 현재 로그 정리 (7일 이상 삭제)
- [ ] 디스크 사용량 모니터링 설정

### Phase 2: 프로세스 관리 (1주 내)

- [ ] Global 에러 핸들러 추가 (`index.js`)
- [ ] PM2 설치 및 설정
- [ ] `ecosystem.config.js` 생성
- [ ] PM2 startup 등록
- [ ] pm2-logrotate 설정

### Phase 3: 코드 개선 (2주 내)

- [ ] 비동기 로깅 전환
- [ ] HTTP 연결 정리 강화
- [ ] 메모리 모니터링 로직 추가

---

## 6. 예상 효과

### 개선 전 vs 개선 후

| 항목 | 개선 전 | 개선 후 |
|------|--------|--------|
| 디스크 사용량/년 | ~400GB | ~10GB (로테이션) |
| 크래시 복구 | 수동 개입 필요 | 자동 (PM2) |
| 로그 보관 | 무기한 | 7일 |
| 프로필 정리 | 없음 | 7일 미사용 시 삭제 |
| 서버 재부팅 후 | 수동 시작 | 자동 시작 |

### 365일 운영 예상 안정성

```
개선 전: ❌ 1-3개월 내 장애 예상
개선 후: ✅ 안정적 연속 운영 가능
```

---

## 7. 참고: 빠른 시작 명령어

```bash
# 1. 정리 스크립트 생성 및 실행
mkdir -p scripts
# (스크립트 파일 생성 후)
chmod +x scripts/*.sh
./scripts/cleanup-logs.sh

# 2. crontab 등록
(crontab -l 2>/dev/null; echo "0 3 * * * /home/tech/vpn_coupang_v1/scripts/cleanup-logs.sh") | crontab -

# 3. PM2 설치 및 시작
npm install -g pm2
pm2 start ecosystem.config.js
pm2 startup
pm2 save

# 4. 상태 확인
pm2 status
df -h /home
du -sh logs/ browser-data/
```

---

*이 문서는 시스템 분석을 기반으로 작성되었으며, 실제 적용 시 테스트 환경에서 먼저 검증하는 것을 권장합니다.*
