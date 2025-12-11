#!/bin/bash
#
# VPN 상태 확인 스크립트
# 사용법: ./vpn-status.sh
#

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[VPN]${NC} $1"; }

echo ""
log "============================================"
log "VPN 네임스페이스 상태"
log "============================================"
echo ""

ACTIVE=0
INACTIVE=0

for DONGLE in 16 17 18 19 20 21 22 23; do
    NAMESPACE="vpn-$DONGLE"

    if ip netns list 2>/dev/null | grep -q "^$NAMESPACE"; then
        # 네임스페이스 존재 - IP 확인
        VPN_IP=$(sudo ip netns exec "$NAMESPACE" curl -s --max-time 3 https://api.ipify.org 2>/dev/null || echo "")

        if [ -n "$VPN_IP" ]; then
            echo -e "${GREEN}[VPN $DONGLE]${NC} ● 연결됨 → $VPN_IP"
        else
            echo -e "${YELLOW}[VPN $DONGLE]${NC} ◐ 네임스페이스 존재 (IP 확인 실패)"
        fi
        ACTIVE=$((ACTIVE + 1))
    else
        echo -e "${RED}[VPN $DONGLE]${NC} ○ 연결 안됨"
        INACTIVE=$((INACTIVE + 1))
    fi
done

echo ""
log "============================================"
log "요약: 활성 $ACTIVE개, 비활성 $INACTIVE개"
log "============================================"

echo ""
MAIN_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "확인 실패")
log "메인 공인 IP: $MAIN_IP"
echo ""
