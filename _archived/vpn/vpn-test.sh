#!/bin/bash
#
# VPN 연결 테스트 스크립트
# 사용법: sudo ./vpn-test.sh
#
# ⚠️ 메인 이더넷 연결에 영향 없이 네임스페이스 내에서만 VPN 연결
#

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[VPN-TEST]${NC} $1"; }
warn() { echo -e "${YELLOW}[VPN-TEST]${NC} $1"; }
error() { echo -e "${RED}[VPN-TEST]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[VPN-TEST]${NC} $1"; }

[ "$EUID" -ne 0 ] && error "root 권한 필요. sudo 사용하세요."

# 테스트용 설정
NAMESPACE="vpn-test"
WG_INTERFACE="wg-test"

# VPN 키 서버에서 가져온 설정
PRIVATE_KEY="+D+I3Q/Be2raRZIfSMIJTNHltCfjIv9DHAtwjeT4ImQ="
ADDRESS="10.8.11.1/24"
SERVER_PUBKEY="3V5Ji10xLRa5/5bwvMFH4PcTvGuNz8af7nwxI0AmpG0="
SERVER_ENDPOINT="49.171.88.233:55555"

log "============================================"
log "VPN 연결 테스트 시작"
log "============================================"

# 1. 메인 IP 먼저 확인
info "현재 메인 IP 확인 중..."
MAIN_IP_BEFORE=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "확인 실패")
log "메인 IP (테스트 전): $MAIN_IP_BEFORE"

# 2. 기존 테스트 네임스페이스 정리
if ip netns list 2>/dev/null | grep -q "^$NAMESPACE"; then
    warn "기존 테스트 네임스페이스 정리 중..."
    ip -n "$NAMESPACE" link del "$WG_INTERFACE" 2>/dev/null || true
    ip netns del "$NAMESPACE" 2>/dev/null || true
    sleep 1
fi

# 3. 네임스페이스 생성
log "네임스페이스 생성: $NAMESPACE"
ip netns add "$NAMESPACE"
ip netns exec "$NAMESPACE" ip link set lo up

# 4. WireGuard 인터페이스 생성
log "WireGuard 인터페이스 생성: $WG_INTERFACE"
ip link add "$WG_INTERFACE" type wireguard
ip link set "$WG_INTERFACE" netns "$NAMESPACE"

# 5. WireGuard 설정 적용
log "WireGuard 설정 적용..."
TEMP_CONF=$(mktemp)
cat > "$TEMP_CONF" << EOF
[Interface]
PrivateKey = $PRIVATE_KEY

[Peer]
PublicKey = $SERVER_PUBKEY
Endpoint = $SERVER_ENDPOINT
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
EOF

ip netns exec "$NAMESPACE" wg setconf "$WG_INTERFACE" "$TEMP_CONF"
rm -f "$TEMP_CONF"

# 6. IP 할당 및 활성화
log "IP 주소 할당: $ADDRESS"
ip netns exec "$NAMESPACE" ip addr add "$ADDRESS" dev "$WG_INTERFACE"
ip netns exec "$NAMESPACE" ip link set "$WG_INTERFACE" up

# 7. 라우팅 설정
log "라우팅 설정"
ip netns exec "$NAMESPACE" ip route add default dev "$WG_INTERFACE"

# 8. DNS 설정
log "DNS 설정"
mkdir -p /etc/netns/"$NAMESPACE"
echo -e "nameserver 1.1.1.1\nnameserver 8.8.8.8" > /etc/netns/"$NAMESPACE"/resolv.conf

log "============================================"
log "VPN 설정 완료! 연결 테스트 중..."
log "============================================"

echo ""
info "WireGuard 상태:"
ip netns exec "$NAMESPACE" wg show

echo ""
info "VPN 네임스페이스 내 IP 확인 중..."
VPN_IP=$(ip netns exec "$NAMESPACE" curl -s --max-time 10 https://api.ipify.org 2>/dev/null || echo "연결 실패")

echo ""
info "메인 네트워크 IP 재확인 중..."
MAIN_IP_AFTER=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "확인 실패")

echo ""
log "============================================"
log "테스트 결과"
log "============================================"
log "메인 IP (테스트 전): $MAIN_IP_BEFORE"
log "메인 IP (테스트 후): $MAIN_IP_AFTER"
log "VPN IP (네임스페이스): $VPN_IP"

if [ "$MAIN_IP_BEFORE" == "$MAIN_IP_AFTER" ]; then
    log "✅ 메인 연결 유지됨 - 정상"
else
    warn "⚠️ 메인 IP 변경됨 - 확인 필요"
fi

if [ "$VPN_IP" != "연결 실패" ] && [ "$VPN_IP" != "$MAIN_IP_BEFORE" ]; then
    log "✅ VPN 연결 성공 - IP: $VPN_IP"
else
    warn "⚠️ VPN 연결 실패 또는 IP 동일"
fi

echo ""
log "============================================"
log "정리 명령어: sudo ip netns del $NAMESPACE"
log "네임스페이스 내 실행: sudo ip netns exec $NAMESPACE <command>"
log "============================================"
