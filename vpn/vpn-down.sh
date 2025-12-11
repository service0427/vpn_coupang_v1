#!/bin/bash
#
# VPN 연결 해제 스크립트
# 사용법: sudo ./vpn-down.sh [동글번호]
# 예: sudo ./vpn-down.sh 16
# 인자 없으면 모든 VPN 종료
#

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[VPN]${NC} $1"; }
warn() { echo -e "${YELLOW}[VPN]${NC} $1"; }
error() { echo -e "${RED}[VPN]${NC} $1"; }

[ "$EUID" -ne 0 ] && { error "root 권한 필요. sudo 사용하세요."; exit 1; }

# 특정 동글 종료 함수
stop_dongle() {
    local DONGLE=$1
    local NAMESPACE="vpn-$DONGLE"
    local WG_INTERFACE="wg-$DONGLE"

    if ip netns list 2>/dev/null | grep -q "^$NAMESPACE"; then
        log "Dongle $DONGLE 종료 중..."
        ip netns exec "$NAMESPACE" ip link set "$WG_INTERFACE" down 2>/dev/null || true
        ip netns exec "$NAMESPACE" ip link del "$WG_INTERFACE" 2>/dev/null || true
        ip netns del "$NAMESPACE" 2>/dev/null || true
        [ -d "/etc/netns/$NAMESPACE" ] && rm -rf "/etc/netns/$NAMESPACE"
        log "Dongle $DONGLE 종료 완료"
        return 0
    else
        warn "Dongle $DONGLE: 연결되어 있지 않음"
        return 1
    fi
}

# 인자가 있으면 해당 동글만 종료
if [ -n "$1" ]; then
    log "============================================"
    log "VPN 종료 - Dongle $1"
    log "============================================"
    stop_dongle "$1"
else
    # 인자가 없으면 모든 VPN 종료
    log "============================================"
    log "모든 VPN 종료"
    log "============================================"

    for DONGLE in 16 17 18 19 20 21 22 23; do
        stop_dongle "$DONGLE"
    done
fi

echo ""
log "현재 활성 VPN:"
ACTIVE=$(ip netns list 2>/dev/null | grep "^vpn-" || echo "없음")
if [ "$ACTIVE" = "없음" ]; then
    log "  (없음)"
else
    echo "$ACTIVE" | while read ns; do
        DONGLE_NUM=$(echo "$ns" | sed 's/vpn-//')
        VPN_IP=$(ip netns exec "$ns" curl -s --max-time 3 https://api.ipify.org 2>/dev/null || echo "확인 실패")
        log "  $ns → $VPN_IP"
    done
fi

echo ""
MAIN_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "확인 실패")
log "메인 공인 IP: $MAIN_IP"
log "============================================"
