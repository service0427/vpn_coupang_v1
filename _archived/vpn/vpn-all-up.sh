#!/bin/bash
#
# 모든 VPN 동글 연결 (16~23)
# 사용법: sudo ./vpn-all-up.sh
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[VPN-ALL]${NC} $1"; }
warn() { echo -e "${YELLOW}[VPN-ALL]${NC} $1"; }

[ "$EUID" -ne 0 ] && { echo -e "${RED}[ERROR]${NC} root 권한 필요. sudo 사용하세요."; exit 1; }

log "============================================"
log "모든 VPN 동글 연결 시작 (16~23)"
log "============================================"
echo ""

SUCCESS=0
FAILED=0

for DONGLE in 16 17 18 19 20 21 22 23; do
    echo -e "${CYAN}[Dongle $DONGLE]${NC} 연결 시작..."

    if "$SCRIPT_DIR/vpn-up.sh" "$DONGLE" > /dev/null 2>&1; then
        VPN_IP=$(ip netns exec "vpn-$DONGLE" curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "확인 실패")
        echo -e "${GREEN}[Dongle $DONGLE]${NC} 연결 완료 → $VPN_IP"
        SUCCESS=$((SUCCESS + 1))
    else
        echo -e "${RED}[Dongle $DONGLE]${NC} 연결 실패"
        FAILED=$((FAILED + 1))
    fi

    sleep 1  # 연결 간 간격
done

echo ""
log "============================================"
log "완료: 성공 $SUCCESS개, 실패 $FAILED개"
log "============================================"

echo ""
log "활성 VPN 목록:"
for DONGLE in 16 17 18 19 20 21 22 23; do
    NAMESPACE="vpn-$DONGLE"
    if ip netns list 2>/dev/null | grep -q "^$NAMESPACE"; then
        VPN_IP=$(ip netns exec "$NAMESPACE" curl -s --max-time 3 https://api.ipify.org 2>/dev/null || echo "확인 실패")
        log "  $NAMESPACE → $VPN_IP"
    fi
done

MAIN_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "확인 실패")
echo ""
log "메인 공인 IP: $MAIN_IP"
