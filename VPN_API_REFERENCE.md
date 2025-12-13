# VPN 동글 API 레퍼런스

## 개요

VPN 동글 관리를 위한 REST API 문서입니다.

- **동글 서버**: `http://61.84.75.37:10001`
- **작업 할당 서버**: `http://61.84.75.37:10001`
- **결과 제출 서버**: `http://61.84.75.37:10002`

---

## 1. 동글 할당 (Allocate)

### 요청
```
POST /dongle/allocate
Content-Type: application/json

{
  "agent_id": "U22-01-01"
}
```

### 성공 응답 (신규 할당)
```json
{
  "success": true,
  "renewed": false,
  "dongle": {
    "id": 26,
    "server_ip": "115.21.112.42",
    "dongle": 17,
    "private_key": "uEJ70f...",
    "public_key": "yIrGEm..."
  }
}
```

### 성공 응답 (기존 할당 재사용)
```json
{
  "success": true,
  "renewed": true,
  "dongle": {
    "id": 26,
    "server_ip": "115.21.112.42",
    "dongle": 17,
    "private_key": "uEJ70f...",
    "public_key": "yIrGEm..."
  }
}
```

### 실패 응답
```json
{
  "success": false,
  "message": "No available dongle"
}
```

### 필드 설명
| 필드 | 타입 | 설명 |
|------|------|------|
| `id` | number | 동글 레코드 ID (반납/연장 시 사용) |
| `dongle` | number | 동글 번호 (16~31) |
| `server_ip` | string | VPN 서버 IP |
| `private_key` | string | WireGuard 클라이언트 Private Key |
| `public_key` | string | WireGuard 서버 Public Key |
| `renewed` | boolean | 기존 할당 재사용 여부 |

---

## 2. 동글 반납 (Release)

### 요청
```
POST /dongle/release/{dongle_id}
Content-Type: application/json

{
  "agent_id": "U22-01-01",
  "session_duration_ms": 20894000,
  "toggle_count": 416,
  "toggle_reasons": {
    "BLOCKED": 0,
    "PREVENTIVE": 409,
    "NO_WORK": 0,
    "IP_CHECK_FAILED": 7,
    "MANUAL": 0
  },
  "connect_attempts": 432,
  "connect_successes": 416,
  "avg_connect_time_ms": 3029,
  "release_reason": "세션 종료"
}
```

### 성공 응답
```json
{
  "success": true,
  "message": "Dongle released successfully"
}
```

### 실패 응답
```json
{
  "success": false,
  "message": "Dongle not found or already released"
}
```

### 통계 필드 설명
| 필드 | 타입 | 설명 |
|------|------|------|
| `session_duration_ms` | number | 세션 유지 시간 (밀리초) |
| `toggle_count` | number | IP 토글 총 횟수 |
| `toggle_reasons` | object | 토글 사유별 횟수 |
| `connect_attempts` | number | VPN 연결 시도 횟수 |
| `connect_successes` | number | VPN 연결 성공 횟수 |
| `avg_connect_time_ms` | number | 평균 연결 소요 시간 (밀리초) |
| `release_reason` | string | 반납 사유 |

---

## 3. 동글 연장 (Heartbeat)

동글 타임아웃 방지를 위해 주기적으로 호출합니다.

### 요청
```
GET /dongle/heartbeat/{dongle_id}
```

### 성공 응답
```json
{
  "success": true,
  "message": "Heartbeat received"
}
```

### 실패 응답
```json
{
  "success": false,
  "message": "Dongle not found"
}
```

---

## 4. IP 토글 (Toggle)

동글의 LTE IP를 변경합니다. VPN 서버에 직접 요청합니다.

### 요청
```
GET http://{server_ip}/toggle/{dongle_number}
```

예시:
```
GET http://115.21.112.42/toggle/17
```

### 성공 응답
```json
{
  "success": true,
  "ip": "175.223.44.204"
}
```

### 실패 응답 (409 Conflict)
```json
{
  "success": false,
  "message": "Toggle in progress"
}
```

### 실패 응답 (500 Error)
```json
{
  "success": false,
  "message": "Toggle failed"
}
```

---

## 5. 작업 할당 (Allocate Work)

### 요청
```
POST /allocate
Content-Type: application/json

{
  "agent_ip": "121.173.150.131",
  "vpn": "115.21.112.42_17",
  "external_ip": "175.223.44.204",
  "count": 3
}
```

### 성공 응답
```json
{
  "success": true,
  "work_type": "click",
  "count": 3,
  "tasks": [
    {
      "allocation_key": "uuid-1234-5678",
      "keyword": "키워드1",
      "product_id": "123456",
      "item_id": "",
      "vendor_item_id": "",
      "work_type": "click"
    },
    {
      "allocation_key": "uuid-2345-6789",
      "keyword": "키워드2",
      "product_id": "234567",
      "item_id": "",
      "vendor_item_id": "",
      "work_type": "click"
    }
  ]
}
```

### 실패 응답

| reason | message | 설명 | 권장 처리 |
|--------|---------|------|-----------|
| `MISSING_PARAMS` | agent_ip and external_ip are required | 필수 파라미터 누락 | 파라미터 확인 |
| `NO_ACTIVE_TASKS` | No active tasks available | 활성 태스크 없음 | 60초 대기 후 재시도 |
| `ALL_QUOTA_REACHED` | All tasks have reached their daily click quota... | 모든 태스크 일일 쿼터 달성 | 60초 대기 후 재시도 |
| `NO_PRODUCT_DATA` | Tasks exist but product_data is missing | 상품 데이터 없음 | 60초 대기 후 재시도 |
| `IP_ALL_USED` | This IP has been used for all available products | 해당 IP로 모든 상품 처리 완료 | **즉시 IP 토글** |
| `NO_DONGLE` | (동글 관련) | VPN 동글 없음 | 60초 대기 후 재시도 |
| `PROXY_NOT_READY` | Proxy is ip_null... | 프록시 준비 안됨 | 60초 대기 후 재시도 |
| `SERVER_ERROR` | (에러 메시지) | 서버 오류 | 60초 대기 후 재시도 |
| `UNKNOWN` | Tasks should be available but... | 알 수 없는 오류 | 60초 대기 후 재시도 |

#### 실패 응답 예시
```json
{
  "success": false,
  "reason": "ALL_QUOTA_REACHED",
  "message": "All tasks have reached their daily click quota or failed too many times",
  "details": {
    "active_tasks": 159,
    "quota_ok_tasks": 0
  }
}
```

```json
{
  "success": false,
  "reason": "IP_ALL_USED",
  "message": "This IP (175.223.44.204) has been used for all available products"
}
```

---

## 6. 작업 결과 제출 (Submit Result)

### 요청 (성공)
```
POST /result
Content-Type: application/json

{
  "allocation_key": "uuid-1234-5678",
  "success": true,
  "extras": {
    "chrome_version": "136.0.0.0",
    "duration_ms": 15234
  }
}
```

### 요청 (실패)
```
POST /result
Content-Type: application/json

{
  "allocation_key": "uuid-1234-5678",
  "success": false,
  "error_type": "PRODUCT_NOT_FOUND",
  "error_message": "상품을 찾을 수 없습니다"
}
```

### 응답
```json
{
  "success": true,
  "message": "Result submitted"
}
```

---

## WireGuard 설정

동글 할당 응답을 기반으로 WireGuard 설정을 생성합니다:

```ini
[Interface]
PrivateKey = {dongle.private_key}
Address = 10.8.{dongle.dongle}.0/24

[Peer]
PublicKey = {dongle.public_key}
Endpoint = {dongle.server_ip}:55555
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

---

## 에러 처리 가이드

### IP_ALL_USED
```
현재 IP로 처리 가능한 상품이 없음 → 즉시 IP 토글 후 재시도
```

### ALL_QUOTA_REACHED / NO_ACTIVE_TASKS
```
서버에 할당할 작업이 없음 → VPN 반납 + 60초 대기 → 재연결
```

### NETWORK_ERROR
```
네트워크 오류 → VPN 반납 + 60초 대기 → 재연결
```

### 토글 실패 (409 Conflict)
```
이미 토글 진행 중 → 잠시 대기 후 재시도
```
