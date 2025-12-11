#!/bin/bash
#
# VPN 네임스페이스에서 명령 실행
# Playwright/Patchright가 VPN을 통해 실행되도록 하는 래퍼 스크립트
#
# 사용법:
#   sudo ./vpn/run-in-vpn.sh [동글번호] <명령>
#   sudo ./vpn/run-in-vpn.sh 16 node index-vpn.js --vpn=16 --thread-index=0
#   (동글번호 생략 시 기본값 16)
#

# 첫 번째 인자가 숫자인지 확인
if [[ "$1" =~ ^[0-9]+$ ]]; then
    DONGLE="$1"
    shift  # 동글번호 제거하고 나머지가 명령어
else
    DONGLE="16"  # 기본값
fi

NAMESPACE="vpn-$DONGLE"

# 색상 출력
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[VPN-RUN]${NC} $1"
}

error() {
    echo -e "${RED}[VPN-RUN]${NC} $1"
    exit 1
}

# Root 권한 확인
if [ "$EUID" -ne 0 ]; then
    error "이 스크립트는 root 권한이 필요합니다. sudo를 사용하세요."
fi

# 인자 확인
if [ $# -eq 0 ]; then
    error "실행할 명령을 지정하세요. 예: sudo ./vpn/run-in-vpn.sh 16 node index-vpn.js --vpn=16"
fi

# 네임스페이스 존재 확인
if ! ip netns list | grep -q "^$NAMESPACE"; then
    error "VPN 네임스페이스가 없습니다. 먼저 '/home/tech/naver/shop/vpn/vpn-up.sh'를 실행하세요."
fi

# 원래 사용자 정보 (sudo 실행 시에도 유지)
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)

# 현재 VPN IP 확인 (실패해도 계속 진행)
VPN_IP=$(ip netns exec "$NAMESPACE" curl -s --max-time 3 http://mkt.techb.kr/ip 2>/dev/null || echo "")
if [ -n "$VPN_IP" ]; then
    log "VPN IP: $VPN_IP"
else
    log "VPN IP 확인 건너뜀 (첫 연결 시 정상)"
fi

# 명령 실행
log "VPN 네임스페이스에서 실행: $1"
log "============================================"

# X 서버 접근 권한 부여 (GUI 표시용)
if [ -n "$DISPLAY" ]; then
    # 모든 로컬 접근 허용
    xhost +local: >/dev/null 2>&1 || true
    xhost +SI:localuser:root >/dev/null 2>&1 || true
    xhost + >/dev/null 2>&1 || true
    log "X 서버 접근 권한 부여됨"
fi

# Xauthority 파일 경로
XAUTH_FILE="${XAUTHORITY:-$REAL_HOME/.Xauthority}"
REAL_UID=$(id -u "$REAL_USER")
REAL_GID=$(id -g "$REAL_USER")

# 환경 변수 유지하면서 실행 (DISPLAY 포함)
# 핵심: ip netns exec로 네임스페이스 진입 후, sudo -u로 원래 사용자로 전환
# 현재 디렉토리와 node_modules/.bin을 PATH에 추가
CURRENT_DIR="$(pwd)"
NODE_BIN="$CURRENT_DIR/node_modules/.bin"
EXTENDED_PATH="$NODE_BIN:$PATH"

# 이렇게 해야 X 서버 소켓 권한 문제가 해결됨
exec ip netns exec "$NAMESPACE" \
    sudo -u "$REAL_USER" \
    env HOME="$REAL_HOME" \
    USER="$REAL_USER" \
    DISPLAY="${DISPLAY:-:0}" \
    XAUTHORITY="$XAUTH_FILE" \
    XDG_RUNTIME_DIR="/run/user/$REAL_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$REAL_UID/bus" \
    GTK_IM_MODULE="${GTK_IM_MODULE:-ibus}" \
    QT_IM_MODULE="${QT_IM_MODULE:-ibus}" \
    XMODIFIERS="${XMODIFIERS:-@im=ibus}" \
    PATH="$EXTENDED_PATH" \
    NODE_PATH="$NODE_PATH" \
    VPN_NAMESPACE="$NAMESPACE" \
    "$@"
