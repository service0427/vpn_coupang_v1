# VPN 동글 생명주기 리팩토링 가이드

## 현재 상태 (문제점)

현재 `index-vpn-multi.js`의 VPN 관련 로직이 여러 곳에 분산되어 있어 유지보수가 어렵습니다:

1. **토글 조건이 4곳에 분산됨**:
   - `connect()`: IP 체크 실패 시 토글
   - `runBatchCycle()`: 연속 3회 작업 없음 시 토글
   - `runBatchCycle()`: score <= -2 (차단) 시 토글
   - `runBatchCycle()`: success >= 50 시 토글

2. **상태 관리가 복잡함**:
   - `this.connected`, `this.vpnIp`, `this.dongleInfo` 등 여러 상태 변수
   - 상태 전이가 명시적이지 않음

3. **에러 처리가 중복됨**:
   - IP 체크 실패, 연결 실패, 태스크 실패 등 각각 다르게 처리

4. **재시도 로직 불일치** (2024-12 수정됨):
   - `connect()`의 try 블록 내 IP 체크 실패: 재시도 있음 ✓
   - `connect()`의 catch 블록 (할당 실패, 토글 실패 등): ~~재시도 없음~~ → 수정됨
   - 문제: 동글 할당 실패 시 catch로 빠지면 `return false`만 하고 에이전트가 영구 비활성화됨
   - 해결: catch 블록에도 재시도 로직 추가 (3초→5초→7초 간격, 최대 3회)

5. **네임스페이스 정리 불완전** (2024-12 수정됨):
   - 문제: `cleanupVpn()`, `cleanupAllVpns()` 함수가 에러를 무시하고 조용히 실패
   - 문제: 네임스페이스 내 프로세스가 실행 중이면 삭제 실패 (busy)
   - 결과: 기존 네임스페이스가 남아있는 상태에서 새 연결 시도 → 충돌 → 먹통
   - 해결:
     - `ip netns pids`로 내부 프로세스 확인 후 `kill -9`로 강제 종료
     - 모든 wg 인터페이스 삭제 후 네임스페이스 삭제
     - 삭제 결과 확인 및 실패 시 경고 로그 출력

---

## 리팩토링 방향

### 1. 상태 머신 패턴 도입

```javascript
// VPN 연결 상태
const VpnState = {
  DISCONNECTED: 'DISCONNECTED',   // 연결 안됨
  CONNECTING: 'CONNECTING',       // 연결 중
  CONNECTED: 'CONNECTED',         // 정상 연결
  NEEDS_TOGGLE: 'NEEDS_TOGGLE',   // 토글 필요 (IP 변경 필요)
  NEEDS_RECONNECT: 'NEEDS_RECONNECT'  // 재연결 필요 (동글 교체)
};
```

### 2. 토글/재연결 조건 중앙화

```javascript
// 토글이 필요한 조건들을 한 곳에서 관리
class TogglePolicy {
  shouldToggle(context) {
    const { ipCheckFailed, noWorkCount, score, successCount } = context;

    // 조건 1: IP 체크 실패
    if (ipCheckFailed) {
      return { toggle: true, reason: 'IP_CHECK_FAILED' };
    }

    // 조건 2: 연속 3회 작업 없음
    if (noWorkCount >= 3) {
      return { toggle: true, reason: 'NO_WORK_STREAK' };
    }

    // 조건 3: 차단됨 (score <= -2)
    if (score <= -2) {
      return { toggle: true, reason: 'BLOCKED' };
    }

    // 조건 4: 50회 성공 (예방적 교체)
    if (successCount >= 50) {
      return { toggle: true, reason: 'PREVENTIVE' };
    }

    return { toggle: false };
  }
}
```

### 3. 분리된 클래스 구조

```
lib/
├── vpn/
│   ├── VpnManager.js         # VPN 연결 상태 머신
│   ├── DongleClient.js       # 동글 API 통신 (allocate/release/heartbeat/toggle)
│   ├── WireGuardHelper.js    # WireGuard/네임스페이스 설정
│   └── TogglePolicy.js       # 토글 조건 정책
└── core/
    └── VpnTaskRunner.js      # 태스크 실행 (현재 VpnAgent 역할)
```

---

## 상세 설계

### VpnManager 클래스

```javascript
class VpnManager extends EventEmitter {
  constructor(agentId) {
    this.agentId = agentId;
    this.state = VpnState.DISCONNECTED;
    this.dongle = null;         // { id, serverIp, dongleNumber }
    this.vpnIp = null;
    this.namespace = null;
    this.wgInterface = null;

    // 정책
    this.togglePolicy = new TogglePolicy();
    this.dongleClient = new DongleClient();
    this.wireguard = new WireGuardHelper();
  }

  // 상태 전이
  async connect() { ... }
  async disconnect() { ... }
  async toggle() { ... }
  async reconnect() { ... }

  // 이벤트 발생
  // - 'connected': 연결 성공
  // - 'disconnected': 연결 해제
  // - 'ip_changed': IP 변경됨
  // - 'error': 에러 발생
}
```

### DongleClient 클래스

```javascript
class DongleClient {
  constructor(baseUrl = 'http://61.84.75.37:10001') {
    this.baseUrl = baseUrl;
  }

  // 동글 할당
  async allocate(agentId) {
    // POST /dongle/allocate { agent_id }
    // Returns: { id, serverIp, dongleNumber, wgPrivateKey, wgPublicKey }
  }

  // 동글 반납
  async release(dongleId) {
    // GET /dongle/release/{dongleId}
  }

  // 하트비트 (타임아웃 연장)
  async heartbeat(dongleId) {
    // GET /dongle/heartbeat/{dongleId}
  }

  // IP 토글 (90초 타임아웃)
  async toggle(serverIp, dongleNumber) {
    // GET http://{serverIp}/toggle/{dongleNumber}
    // 20~60초 소요
  }
}
```

### WireGuardHelper 클래스

```javascript
class WireGuardHelper {
  // 네임스페이스 생성 및 WireGuard 설정
  setup(config) {
    // config: { namespace, interface, privateKey, publicKey, serverIp, dongleNumber }
  }

  // 네임스페이스 정리
  cleanup(namespace, wgInterface) {
    // 1. 네임스페이스 내 wg 인터페이스 삭제
    // 2. 전역 wg 인터페이스 삭제
    // 3. 네임스페이스 삭제
  }

  // 공인 IP 확인
  getPublicIp(namespace) {
    // ip netns exec {namespace} curl -s https://api.ipify.org
  }
}
```

---

## 상태 전이 다이어그램

```
┌─────────────────────────────────────────────────────────────────┐
│                         상태 전이 다이어그램                      │
└─────────────────────────────────────────────────────────────────┘

    ┌──────────────┐
    │ DISCONNECTED │
    └──────┬───────┘
           │ connect()
           ▼
    ┌──────────────┐
    │  CONNECTING  │◄──────────────────────────────┐
    └──────┬───────┘                               │
           │ success                               │
           ▼                                       │
    ┌──────────────┐                               │
    │  CONNECTED   │───────────────────────────────┤
    └──────┬───────┘                               │
           │                                       │
     ┌─────┴─────┬─────────────┬────────────┐     │
     │           │             │            │     │
     │ IP fail   │ noWork>=3   │ score<=-2  │ success>=50
     │           │             │            │     │
     ▼           ▼             ▼            ▼     │
    ┌──────────────────────────────────────────┐  │
    │            NEEDS_TOGGLE                  │  │
    └──────────────┬───────────────────────────┘  │
                   │ toggle() + release()         │
                   │ + allocate()                 │
                   └──────────────────────────────┘
```

---

## 마이그레이션 계획

### Phase 1: 클래스 분리 (위험도: 낮음)
1. `DongleClient` 클래스 생성 - API 호출만 분리
2. `WireGuardHelper` 클래스 생성 - 시스템 명령어만 분리
3. 기존 코드에서 새 클래스 사용

### Phase 2: 정책 분리 (위험도: 중간)
1. `TogglePolicy` 클래스 생성
2. 토글 조건을 한 곳에서 관리
3. 기존 조건문을 정책 호출로 대체

### Phase 3: 상태 머신 적용 (위험도: 높음)
1. `VpnManager` 상태 머신 구현
2. `VpnAgent` → `VpnTaskRunner`로 역할 명확화
3. 전체 플로우 리팩토링

---

## 테스트 전략

### 단위 테스트
```javascript
describe('TogglePolicy', () => {
  it('IP 체크 실패 시 토글 필요', () => {
    const policy = new TogglePolicy();
    const result = policy.shouldToggle({ ipCheckFailed: true });
    expect(result.toggle).toBe(true);
    expect(result.reason).toBe('IP_CHECK_FAILED');
  });

  it('noWorkCount가 3 미만이면 토글 불필요', () => {
    const policy = new TogglePolicy();
    const result = policy.shouldToggle({ noWorkCount: 2 });
    expect(result.toggle).toBe(false);
  });
});
```

### 통합 테스트
```bash
# 단일 에이전트 테스트
node index-vpn-multi.js --agents 1 --once

# 멀티 에이전트 테스트
node index-vpn-multi.js --agents 3 --once

# 장시간 테스트 (토글 조건 트리거)
node index-vpn-multi.js --agents 1
```

---

## 참고: 현재 API 엔드포인트

| 기능 | 메서드 | 엔드포인트 | 타임아웃 |
|------|--------|------------|----------|
| 동글 할당 | POST | `/dongle/allocate` | 10s |
| 동글 반납 | GET | `/dongle/release/{id}` | 10s |
| 하트비트 | GET | `/dongle/heartbeat/{id}` | 10s |
| IP 토글 | GET | `http://{serverIp}/toggle/{dongleNumber}` | 90s |

### 응답 예시

#### 할당 응답
```json
{
  "id": 53,
  "serverIp": "49.171.88.233",
  "dongleNumber": 16,
  "wgPrivateKey": "...",
  "wgPublicKey": "..."
}
```

#### 토글 응답
```json
{
  "ip": "새로운_공인_IP"
}
```

---

## 결론

현재 코드의 주요 문제는 **토글 조건이 분산**되어 있고 **상태 관리가 암시적**이라는 점입니다.

리팩토링을 통해:
1. 토글 조건을 `TogglePolicy`로 중앙화
2. VPN 연결 상태를 명시적 상태 머신으로 관리
3. API 통신과 시스템 명령어를 별도 클래스로 분리

이렇게 하면 "언제 토글해야 하는지"가 명확해지고, 새로운 조건 추가/수정이 쉬워집니다.
