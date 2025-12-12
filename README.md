# Coupang Agent V2

쿠팡 자동화 도구 V2 - 완전히 리팩토링된 최적화 버전

## 특징

- **경량화**: 파일 수 67% 감소 (71개 → 23개)
- **모듈화**: 단일 책임 원칙 기반 모듈 분리
- **최적화**: 불필요한 기능 제거, 성능 개선
- **안정성**: Headless 모드 차단으로 TLS 오류 방지

## 설치

### 자동 설치 (권장)

```bash
# 모든 의존성 자동 설치 (Ubuntu/Debian)
./install.sh
```

### 수동 설치

```bash
# 1. Node.js 패키지 설치 (Patchright Chromium 자동 포함)
npm install

# 2. Chrome 시스템 의존성 (Ubuntu/Debian)
sudo apt-get update
sudo apt-get install -y \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
  libcairo2 libasound2
```

**참고**:
- `npm install` 실행 시 `postinstall` 스크립트가 자동으로 **Patchright Chromium**을 설치합니다
- Patchright는 안티봇 감지 우회를 위한 Playwright 패치 버전입니다

## 실행

### VPN 멀티 모드 (권장)

```bash
# 기본 실행: VPN 10개, 쓰레드 3개 (총 30개)
sudo npm start

# VPN 개수 조정
sudo npm start -- -v 5           # VPN 5개

# VPN + 쓰레드 조정
sudo npm start -- -v 5 -t 2      # VPN 5개, 쓰레드 2개

# 디버깅 (콘솔 로그 파일 저장)
sudo npm start -- --debug 2>&1 | tee "logs/multi_$(date +%Y%m%d_%H%M%S).log"
```

### 일반 모드 (VPN 없이)

```bash
node index.js --threads 4          # 연속 실행
node index.js --threads 4 --once   # 1회 실행
```

## 구조

```
lib/
├── core/                    # 핵심 로직
│   ├── api-mode.js         # API 모드 멀티쓰레드 실행
│   ├── browser-core.js     # 브라우저 관리
│   ├── search-executor.js  # 검색 실행
│   ├── optimizer.js        # 트래픽 최적화
│   └── api/                # API 모드 헬퍼
│       ├── chrome-manager.js
│       ├── error-handler.js
│       └── result-builder.js
├── modules/                 # 비즈니스 로직
│   ├── api-service.js      # 허브 API 클라이언트
│   ├── browser-service.js  # 브라우저 서비스
│   ├── coupang-handler.js  # 재수출 레이어
│   ├── product/            # 상품 처리
│   └── search/             # 검색 처리
└── utils/                   # 유틸리티
    ├── browser-helpers.js
    ├── cli-parser.js
    ├── common-helpers.js
    ├── human-click.js
    ├── human-simulation.js  # Akamai 우회용 자연스러운 행동
    └── ubuntu-setup.js
```

## 주요 개선사항

### V1 → V2 변경점

1. **구조 단순화**
   - 8개 폴더 → 3개 폴더
   - 복잡한 의존성 제거

2. **코드 최적화**
   - BrowserCore 클래스로 브라우저 관리 통합
   - 중복 코드 제거
   - Chrome 인자 최소화 (2개만 사용)

3. **기능 정리**
   - 사용하지 않는 쿠키/네트워크 모니터링 제거
   - 필수 기능만 유지

## 라이센스

Private
