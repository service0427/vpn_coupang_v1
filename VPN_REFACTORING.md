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

## 결과 제출 안정화 계획 (2024-12)

### 문제 시나리오

```
[시나리오 1: VPN 타임아웃]
작업 실행 (VPN) → 120초 타임아웃 → 브라우저 강제 종료
→ 결과 제출 시도 (로컬) → 성공 ✅
→ 하지만 VPN 상태 불명확 → 다음 작업 실패 가능

[시나리오 2: VPN 중간 끊김]
작업 실행 중 VPN 끊김 → 작업 실패 (네트워크 오류)
→ 결과 제출 시도 (로컬) → 성공 ✅
→ VPN 복구 필요

[시나리오 3: 결과 제출 실패]
작업 완료 → 결과 제출 실패 (서버 오류)
→ allocation_key 있으면 재시도, 없으면 무시
```

### 제안하는 흐름

```
[배치 사이클]
1. VPN 상태 확인 (getVpnPublicIp)
   - 실패 시 → VPN 재연결 후 계속

2. 작업 할당 (allocateBatch)
   - external_ip = 현재 VPN IP

3. 작업 실행 (executeTaskInNamespace)
   - 타임아웃 120초
   - 성공/실패 결과 수집

4. 결과 제출 (submitResult)
   - 1차 시도 (즉시)
   - 실패 시 → VPN 정리 후 2차 시도 (로컬 네트워크 확실히)
   - allocation_key 없으면 무시

5. VPN 상태 재확인
   - IP 체크 실패 → 토글 + 재연결
   - 정상 → heartbeat 후 계속
```

### 핵심 변경사항

1. **결과 제출 재시도 로직**
```javascript
async submitResultWithRetry(result) {
  try {
    // 1차 시도
    await this.allocator.submitResult(result);
  } catch (err) {
    // 2차 시도: VPN 정리 후 로컬 네트워크로
    if (result.allocationKey) {
      cleanupVpn(this.namespace, this.wgInterface);
      await new Promise(r => setTimeout(r, 500));
      await this.allocator.submitResult(result);
    }
    // allocation_key 없으면 무시
  }
}
```

2. **배치 사이클 후 VPN 상태 확인**
```javascript
// 작업 완료 후 VPN 상태 확인
const vpnStillAlive = getVpnPublicIp(this.namespace);
if (!vpnStillAlive) {
  vpnLog(this.agentId, `⚠️ VPN 끊김 감지 → 재연결`);
  await this.reconnect();
}
```

3. **타임아웃 후 자동 VPN 체크**
```javascript
// 타임아웃 발생 시
if (result.errorType === 'TIMEOUT') {
  // VPN 상태 의심 → 다음 사이클에서 확인
  this.needsVpnCheck = true;
}
```

---

## 파일 분리 계획

### 현재 구조
```
index-vpn-multi.js (1200줄) - 모든 것이 한 파일에
├── VpnInstance 클래스
├── cleanupVpn(), cleanupAllVpns()
├── setupVpnNamespace()
├── getVpnPublicIp()
└── main()
```

### 제안하는 구조
```
lib/
├── vpn/
│   ├── index.js              # 모듈 export
│   ├── VpnManager.js         # VPN 연결 상태 머신 (핵심)
│   ├── WireGuardHelper.js    # WireGuard/네임스페이스 관리
│   ├── TogglePolicy.js       # 토글 조건 정책
│   └── VpnAgent.js           # 작업 실행 에이전트 (현재 VpnInstance)
│
├── modules/
│   └── api-service.js        # 기존 (DongleAllocator, BatchAllocator)
│
index-vpn-multi.js            # 진입점만 (100줄 이하)
```

### 각 모듈 책임

#### 1. VpnManager.js (상태 머신)
```javascript
/**
 * VPN 연결 상태를 관리하는 상태 머신
 *
 * 상태: DISCONNECTED → CONNECTING → CONNECTED → NEEDS_TOGGLE
 */
class VpnManager extends EventEmitter {
  constructor(agentId, dongleAllocator) {
    this.state = 'DISCONNECTED';
    this.dongleInfo = null;
    this.namespace = null;
    this.vpnIp = null;

    this.wireguard = new WireGuardHelper();
    this.togglePolicy = new TogglePolicy();
  }

  // 상태 전이 메서드
  async connect() { }      // DISCONNECTED → CONNECTED
  async disconnect() { }   // * → DISCONNECTED
  async reconnect() { }    // * → DISCONNECTED → CONNECTED
  async toggle() { }       // CONNECTED → NEEDS_TOGGLE → CONNECTED

  // 상태 조회
  isConnected() { return this.state === 'CONNECTED'; }
  getPublicIp() { return this.vpnIp; }

  // 이벤트: 'connected', 'disconnected', 'error', 'ip_changed'
}
```

#### 2. WireGuardHelper.js (시스템 명령어)
```javascript
/**
 * WireGuard와 네트워크 네임스페이스 관리
 * execSync 호출을 캡슐화
 */
class WireGuardHelper {
  // 네임스페이스 관리
  setupNamespace(namespace, wgInterface, config) { }
  cleanupNamespace(namespace, wgInterface) { }
  cleanupAllNamespaces(hostnamePrefix) { }

  // IP 확인
  getPublicIp(namespace, timeout = 10) { }

  // 유틸리티
  namespaceExists(namespace) { }
  getNamespaceList() { }
}
```

#### 3. TogglePolicy.js (조건 중앙화)
```javascript
/**
 * 토글이 필요한 조건을 한 곳에서 관리
 */
class TogglePolicy {
  constructor(options = {}) {
    this.maxNoWorkStreak = options.maxNoWorkStreak || 3;
    this.blockThreshold = options.blockThreshold || -2;
    this.preventiveToggleAt = options.preventiveToggleAt || 50;
  }

  shouldToggle(context) {
    const { ipCheckFailed, noWorkCount, score, successCount } = context;

    if (ipCheckFailed) {
      return { toggle: true, reason: 'IP_CHECK_FAILED' };
    }
    if (noWorkCount >= this.maxNoWorkStreak) {
      return { toggle: true, reason: 'NO_WORK_STREAK' };
    }
    if (score <= this.blockThreshold) {
      return { toggle: true, reason: 'BLOCKED' };
    }
    if (successCount >= this.preventiveToggleAt) {
      return { toggle: true, reason: 'PREVENTIVE' };
    }
    return { toggle: false };
  }
}
```

#### 4. VpnAgent.js (작업 실행)
```javascript
/**
 * VPN 연결을 사용해 작업을 실행하는 에이전트
 * 현재 VpnInstance의 작업 실행 부분
 */
class VpnAgent {
  constructor(agentId, vpnManager, batchAllocator) {
    this.vpnManager = vpnManager;
    this.allocator = batchAllocator;
    this.stats = { success: 0, fail: 0, blocked: 0 };
  }

  // 배치 사이클
  async runBatchCycle() {
    // 1. VPN 상태 확인
    if (!this.vpnManager.isConnected()) {
      await this.vpnManager.connect();
    }

    // 2. 작업 할당
    const tasks = await this.allocator.allocateBatch();

    // 3. 작업 실행
    const results = await this.executeTasks(tasks);

    // 4. 결과 제출 (재시도 로직 포함)
    await this.submitResults(results);

    // 5. 토글 필요 여부 확인
    const toggleCheck = this.vpnManager.togglePolicy.shouldToggle({
      score: this.calculateScore(),
      successCount: this.stats.success,
      // ...
    });

    if (toggleCheck.toggle) {
      await this.vpnManager.reconnect();
    }
  }

  async submitResults(results) {
    for (const result of results) {
      await this.submitResultWithRetry(result);
    }
  }

  async submitResultWithRetry(result) {
    try {
      await this.allocator.submitResult(result);
    } catch (err) {
      // VPN 정리 후 재시도
      if (result.allocationKey) {
        this.vpnManager.disconnect();
        await new Promise(r => setTimeout(r, 500));
        await this.allocator.submitResult(result);
      }
    }
  }
}
```

#### 5. index-vpn-multi.js (진입점)
```javascript
/**
 * 멀티 VPN 모드 진입점
 * 설정 파싱, 에이전트 생성, 메인 루프만 담당
 */
const { VpnManager, VpnAgent, WireGuardHelper } = require('./lib/vpn');
const { DongleAllocator, BatchAllocator } = require('./lib/modules/api-service');

async function main() {
  const options = parseArgs();

  // 기존 VPN 정리
  const wireguard = new WireGuardHelper();
  wireguard.cleanupAllNamespaces(HOSTNAME);

  // 에이전트 생성
  const agents = [];
  for (let i = 1; i <= options.vpnCount; i++) {
    const agentId = `${HOSTNAME}-${String(i).padStart(2, '0')}`;
    const vpnManager = new VpnManager(agentId, dongleAllocator);
    const agent = new VpnAgent(agentId, vpnManager, batchAllocator);
    agents.push(agent);
  }

  // 연결 및 실행
  await Promise.all(agents.map(a => a.vpnManager.connect()));
  await Promise.all(agents.map(a => a.runIndependentLoop()));
}
```

### 마이그레이션 단계

#### Phase 1: WireGuardHelper 분리 ✅ 완료 (2024-12)
1. ✅ `lib/vpn/WireGuardHelper.js` 생성
2. ✅ `setupVpnNamespace`, `cleanupVpn`, `cleanupAllVpns`, `getVpnPublicIp` 이동
3. ✅ `index-vpn-multi.js`에서 import하여 사용
4. ✅ 테스트

#### Phase 2: TogglePolicy 분리 ✅ 완료 (2024-12)
1. ✅ `lib/vpn/TogglePolicy.js` 생성
2. ✅ 토글 조건을 정책 클래스로 이동
3. ✅ `VpnInstance`에서 `togglePolicy.shouldToggle()` 호출
4. ✅ 테스트

#### Phase 3: VpnManager 분리 (위험도: 중간) - 미완료
1. `lib/vpn/VpnManager.js` 생성
2. `connect`, `disconnect`, `reconnect`, `toggle` 메서드 이동
3. 상태 머신 패턴 적용
4. 이벤트 기반으로 변경
5. 테스트

#### Phase 4: VpnAgent 분리 (위험도: 높음) - 미완료
1. `lib/vpn/VpnAgent.js` 생성
2. `runBatchCycle`, `executeTaskInNamespace` 이동
3. `submitResultWithRetry` 구현
4. `index-vpn-multi.js`를 진입점만 남기고 정리
5. 전체 테스트

---

## 현재 파일 구조 (Phase 2 완료 후)

```
lib/
├── vpn/
│   ├── index.js              # 모듈 export
│   ├── WireGuardHelper.js    # ✅ WireGuard/네임스페이스 관리
│   └── TogglePolicy.js       # ✅ 토글 조건 정책
│
├── modules/
│   └── api-service.js        # DongleAllocator, BatchAllocator
│
index-vpn-multi.js            # VpnInstance 클래스 (다음 단계에서 분리 예정)
```

### 변경된 코드 줄 수
- `index-vpn-multi.js`: 1283줄 → 약 870줄 (WireGuard 함수 300줄 분리)
- `lib/vpn/WireGuardHelper.js`: 약 270줄
- `lib/vpn/TogglePolicy.js`: 약 130줄

---

## 결론

현재 코드의 주요 문제는 **토글 조건이 분산**되어 있고 **상태 관리가 암시적**이라는 점입니다.

리팩토링을 통해:
1. 토글 조건을 `TogglePolicy`로 중앙화
2. VPN 연결 상태를 명시적 상태 머신으로 관리
3. API 통신과 시스템 명령어를 별도 클래스로 분리
4. **파일 분리로 유지보수성 향상** (1200줄 → 각 200줄 이하)

이렇게 하면 "언제 토글해야 하는지"가 명확해지고, 새로운 조건 추가/수정이 쉬워집니다.
