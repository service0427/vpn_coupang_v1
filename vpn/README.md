# VPN 네임스페이스 설정 가이드

쿠팡 에이전트를 VPN 네임스페이스 모드로 실행하기 위한 설정 가이드입니다.

## 개요

이 프로젝트는 Linux 네트워크 네임스페이스를 사용하여 각 VPN 연결을 격리합니다.
- 8개 VPN 동글 지원 (16~23)
- 각 VPN 동글당 N개 쓰레드 병렬 실행
- WireGuard 기반 VPN 연결

## 사전 요구사항

### 1. 시스템 요구사항
- Ubuntu 20.04 이상 (또는 동등한 Linux 배포판)
- root 권한 (sudo)
- 충분한 RAM (VPN당 최소 2GB 권장)

### 2. 필수 패키지 설치

```bash
# WireGuard 설치
sudo apt update
sudo apt install -y wireguard wireguard-tools

# iproute2 (네트워크 네임스페이스용)
sudo apt install -y iproute2

# curl (IP 확인용)
sudo apt install -y curl

# Node.js 18+ 설치
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Chrome/Chromium 설치 (자동화용)
sudo apt install -y chromium-browser
# 또는
# wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
# sudo dpkg -i google-chrome-stable_current_amd64.deb
```

### 3. WireGuard 키 생성 (서버 측)

각 동글에 대한 키페어가 필요합니다:

```bash
# 클라이언트 키 생성 (동글당 1회)
wg genkey | tee privatekey | wg pubkey > publickey
```

## VPN 설정

### 1. vpn-up.sh 수정

`vpn/vpn-up.sh` 파일을 열어 환경에 맞게 수정합니다:

```bash
# 동글별 Private Key 설정
case $DONGLE in
    16)
        PRIVATE_KEY="실제_프라이빗_키_16"
        ADDRESS="10.8.0.32/24"
        ;;
    17)
        PRIVATE_KEY="실제_프라이빗_키_17"
        ADDRESS="10.8.0.34/24"
        ;;
    # ... 계속
esac

# WireGuard 서버 설정
WG_SERVER_PUBKEY="서버_퍼블릭_키"
WG_SERVER_ENDPOINT="서버_IP:55555"
```

### 2. 단일 VPN 연결

```bash
# Dongle 16 연결
sudo ./vpn/vpn-up.sh 16

# 연결 확인
sudo ip netns exec vpn-16 curl https://api.ipify.org
```

### 3. 모든 VPN 연결

```bash
# 모든 동글 (16~23) 연결
sudo ./vpn/vpn-all-up.sh
```

### 4. VPN 상태 확인

```bash
./vpn/vpn-status.sh
```

출력 예시:
```
[VPN 16] ● 연결됨 → 123.45.67.89
[VPN 17] ● 연결됨 → 123.45.67.90
[VPN 18] ○ 연결 안됨
...
```

### 5. VPN 종료

```bash
# 특정 동글 종료
sudo ./vpn/vpn-down.sh 16

# 모든 VPN 종료
sudo ./vpn/vpn-down.sh
```

## 에이전트 실행

### 1. VPN 네임스페이스 먼저 연결

```bash
# 모든 VPN 연결
sudo ./vpn/vpn-all-up.sh

# 상태 확인
./vpn/vpn-status.sh
```

### 2. 에이전트 병렬 실행

```bash
# 8개 VPN 동시 실행 (VPN당 1쓰레드)
sudo ./vpn/run-parallel.sh

# 8개 VPN, VPN당 2쓰레드 (배치 모드)
sudo ./vpn/run-parallel.sh --threads=2

# 상태 모니터링 활성화
sudo ./vpn/run-parallel.sh --status

# 1회만 실행
sudo ./vpn/run-parallel.sh --once
```

### 3. 단일 VPN 실행 (테스트용)

```bash
# VPN 네임스페이스 내에서 직접 실행
sudo ip netns exec vpn-16 sudo -u $USER node index-vpn.js --vpn=16

# 또는 헬퍼 스크립트 사용
sudo ./vpn/run-in-vpn.sh 16 node index-vpn.js --vpn=16 --once
```

## 폴더 구조

```
browser-data/
├── vpn_16/           # VPN 16 전용
│   ├── 01/           # 쓰레드 1
│   │   └── 137/      # Chrome 버전
│   └── 02/           # 쓰레드 2
├── vpn_17/           # VPN 17 전용
│   └── ...
└── vpn-status/       # 상태 모니터링 파일
    ├── vpn_16.json
    └── toggle-history.json
```

## 상태 모니터링

`--status` 옵션으로 실행하면 웹 대시보드 제공:
- URL: http://localhost:3304/status
- 8개 VPN 상태 실시간 확인
- IP 토글 이력 표시

## 트러블슈팅

### 1. 네임스페이스 생성 실패

```bash
# 기존 네임스페이스 정리
sudo ./vpn/vpn-down.sh

# 인터페이스 정리
sudo ip link del wg-16 2>/dev/null
```

### 2. DNS 해상도 실패

```bash
# 네임스페이스 DNS 설정 확인
cat /etc/netns/vpn-16/resolv.conf

# 수동 설정
sudo mkdir -p /etc/netns/vpn-16
echo -e "nameserver 1.1.1.1\nnameserver 8.8.8.8" | sudo tee /etc/netns/vpn-16/resolv.conf
```

### 3. Chrome 권한 문제

```bash
# X 서버 접근 권한
xhost +local:

# 디스플레이 환경변수
export DISPLAY=:0
```

### 4. WireGuard 연결 안됨

```bash
# WireGuard 상태 확인
sudo ip netns exec vpn-16 wg show

# 핸드셰이크 확인 (latest handshake가 있어야 함)
# 없으면: 서버 설정 / 방화벽 / 키 확인
```

## 시스템 서비스 등록 (선택)

부팅 시 자동 VPN 연결을 위한 systemd 서비스:

```bash
# /etc/systemd/system/vpn-all.service
[Unit]
Description=VPN All Dongles
After=network.target

[Service]
Type=oneshot
ExecStart=/home/tech/coupang_agent_v2/vpn/vpn-all-up.sh
RemainAfterExit=yes
ExecStop=/home/tech/coupang_agent_v2/vpn/vpn-down.sh

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable vpn-all
sudo systemctl start vpn-all
```

## 참고

- WireGuard 공식 문서: https://www.wireguard.com/
- Linux 네트워크 네임스페이스: https://man7.org/linux/man-pages/man7/network_namespaces.7.html
