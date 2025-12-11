#!/bin/bash
#
# VPN 연결 스크립트 (네트워크 네임스페이스 사용)
# 사용법: sudo ./vpn-up.sh [동글번호]
# 예: sudo ./vpn-up.sh 16
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[VPN]${NC} $1"; }
warn() { echo -e "${YELLOW}[VPN]${NC} $1"; }
error() { echo -e "${RED}[VPN]${NC} $1"; exit 1; }

[ "$EUID" -ne 0 ] && error "root 권한 필요. sudo 사용하세요."

# 동글 번호 (기본값: 16)
DONGLE=${1:-16}

# 동글별 네임스페이스와 인터페이스
NAMESPACE="vpn-$DONGLE"
WG_INTERFACE="wg-$DONGLE"

# 동글별 설정 (동글번호 -> PrivateKey, Address)
# ⚠️ 실제 배포 시 이 값들을 환경에 맞게 수정해야 합니다
case $DONGLE in
    16)
        PRIVATE_KEY="YOUR_PRIVATE_KEY_16"
        ADDRESS="10.8.0.32/24"
        ;;
    17)
        PRIVATE_KEY="YOUR_PRIVATE_KEY_17"
        ADDRESS="10.8.0.34/24"
        ;;
    18)
        PRIVATE_KEY="YOUR_PRIVATE_KEY_18"
        ADDRESS="10.8.0.36/24"
        ;;
    19)
        PRIVATE_KEY="YOUR_PRIVATE_KEY_19"
        ADDRESS="10.8.0.38/24"
        ;;
    20)
        PRIVATE_KEY="YOUR_PRIVATE_KEY_20"
        ADDRESS="10.8.0.40/24"
        ;;
    21)
        PRIVATE_KEY="YOUR_PRIVATE_KEY_21"
        ADDRESS="10.8.0.42/24"
        ;;
    22)
        PRIVATE_KEY="YOUR_PRIVATE_KEY_22"
        ADDRESS="10.8.0.44/24"
        ;;
    23)
        PRIVATE_KEY="YOUR_PRIVATE_KEY_23"
        ADDRESS="10.8.0.46/24"
        ;;
    *)
        error "지원하지 않는 동글 번호: $DONGLE (16-23 사용 가능)"
        ;;
esac

# WireGuard 서버 설정 (환경에 맞게 수정)
WG_SERVER_PUBKEY="YOUR_SERVER_PUBLIC_KEY"
WG_SERVER_ENDPOINT="YOUR_SERVER_IP:55555"

log "============================================"
log "VPN 연결 시작 - Dongle $DONGLE"
log "============================================"

# 기존 정리 (해당 동글만)
if ip netns list 2>/dev/null | grep -q "^$NAMESPACE"; then
    warn "기존 네임스페이스 정리 중: $NAMESPACE"
    ip -n "$NAMESPACE" link del "$WG_INTERFACE" 2>/dev/null || true
    ip netns del "$NAMESPACE" 2>/dev/null || true
    sleep 1
fi

# 네임스페이스 생성
log "네임스페이스 생성: $NAMESPACE"
ip netns add "$NAMESPACE"
ip netns exec "$NAMESPACE" ip link set lo up

# WireGuard 인터페이스 생성 및 네임스페이스로 이동
log "WireGuard 인터페이스 생성: $WG_INTERFACE"
ip link add "$WG_INTERFACE" type wireguard
ip link set "$WG_INTERFACE" netns "$NAMESPACE"

# WireGuard 설정
log "WireGuard 설정 적용 (Dongle $DONGLE)"

TEMP_CONF=$(mktemp)
cat > "$TEMP_CONF" << EOF
[Interface]
PrivateKey = $PRIVATE_KEY

[Peer]
PublicKey = $WG_SERVER_PUBKEY
Endpoint = $WG_SERVER_ENDPOINT
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
EOF

ip netns exec "$NAMESPACE" wg setconf "$WG_INTERFACE" "$TEMP_CONF"
rm -f "$TEMP_CONF"

# IP 할당 및 활성화
log "IP 주소 할당: $ADDRESS"
ip netns exec "$NAMESPACE" ip addr add "$ADDRESS" dev "$WG_INTERFACE"
ip netns exec "$NAMESPACE" ip link set "$WG_INTERFACE" up

# 라우팅 설정
log "라우팅 설정"
ip netns exec "$NAMESPACE" ip route add default dev "$WG_INTERFACE"

# DNS 설정
log "DNS 설정"
mkdir -p /etc/netns/"$NAMESPACE"
echo -e "nameserver 1.1.1.1\nnameserver 8.8.8.8" > /etc/netns/"$NAMESPACE"/resolv.conf

log "============================================"
log "VPN 연결 완료! (Dongle $DONGLE)"
log "============================================"

echo ""
log "WireGuard 상태:"
ip netns exec "$NAMESPACE" wg show

echo ""
log "공인 IP 확인 중..."
VPN_IP=$(ip netns exec "$NAMESPACE" curl -s --max-time 10 https://api.ipify.org 2>/dev/null || echo "확인 실패")
log "VPN 공인 IP: $VPN_IP (Dongle $DONGLE)"

MAIN_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "확인 실패")
log "메인 공인 IP: $MAIN_IP"

echo ""
log "============================================"
log "네임스페이스에서 실행: sudo ip netns exec $NAMESPACE <command>"
log "종료: sudo ./vpn-down.sh $DONGLE"
log "============================================"
