#!/bin/bash
#
# VPN 설정 정보 추출 스크립트
# 프록시 상태 API에서 서버 목록을 가져와 VPN 키 정보 조회
#
# 사용법:
#   ./fetch-vpn-config.sh                    # 모든 프록시의 VPN 설정 조회
#   ./fetch-vpn-config.sh 49.171.88.233 18   # 특정 서버/동글의 설정 조회
#   ./fetch-vpn-config.sh --list             # 사용 가능한 서버/동글 목록만 출력
#

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[VPN-CONFIG]${NC} $1"; }
info() { echo -e "${CYAN}[VPN-CONFIG]${NC} $1"; }
warn() { echo -e "${YELLOW}[VPN-CONFIG]${NC} $1"; }

PROXY_STATUS_URL="http://mkt.techb.kr:3001/api/proxy/status"

# 특정 서버/동글 설정 조회
fetch_single_config() {
    local server_ip=$1
    local dongle=$2
    local slot=${3:-random}

    # 슬롯이 random이면 0~9 중 랜덤 선택
    if [ "$slot" = "random" ]; then
        slot=$((RANDOM % 10))
    fi

    local url="http://${server_ip}:8080/vpnkeys_tech/${dongle}/${slot}/conf"
    info "조회: $url (슬롯: $slot)"

    local config=$(curl -s --max-time 5 "$url" 2>/dev/null)

    if [ -n "$config" ] && [[ "$config" == *"[Interface]"* ]]; then
        echo ""
        echo "$config"
        echo ""
    else
        warn "설정 조회 실패: $url"
    fi
}

# 프록시 목록에서 고유한 서버/동글 조합 추출
get_unique_servers() {
    curl -s "$PROXY_STATUS_URL" 2>/dev/null | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
seen = set()
for p in data.get('proxies', []):
    proxy = p['proxy']
    ip, port = proxy.rsplit(':', 1)
    dongle = int(port) - 10000  # 10018 -> 18
    key = (ip, dongle)
    if key not in seen:
        seen.add(key)
        print(f'{ip} {dongle}')
" | sort -t' ' -k1,1 -k2,2n
}

# 목록만 출력
list_servers() {
    log "사용 가능한 VPN 서버/동글 목록:"
    echo ""
    printf "%-20s %-10s %-50s\n" "서버 IP" "동글" "VPN 키 URL"
    printf "%-20s %-10s %-50s\n" "--------" "----" "----------"

    get_unique_servers | while read ip dongle; do
        url="http://${ip}:8080/vpnkeys_tech/${dongle}/0/conf"
        printf "%-20s %-10s %-50s\n" "$ip" "$dongle" "$url"
    done

    echo ""
    log "총 $(get_unique_servers | wc -l)개 서버/동글 조합"
}

# 모든 설정 조회
fetch_all_configs() {
    log "모든 VPN 설정 조회 중..."
    echo ""

    get_unique_servers | while read ip dongle; do
        echo "========================================"
        info "서버: $ip / 동글: $dongle"
        echo "========================================"

        # 슬롯 0만 조회 (필요시 0~9 루프 가능)
        fetch_single_config "$ip" "$dongle" 0
    done
}

# JSON 형식으로 출력
fetch_all_json() {
    echo "["
    local first=true

    get_unique_servers | while read ip dongle; do
        local url="http://${ip}:8080/vpnkeys_tech/${dongle}/0/conf"
        local config=$(curl -s --max-time 5 "$url" 2>/dev/null)

        if [ -n "$config" ] && [[ "$config" == *"[Interface]"* ]]; then
            # WireGuard 설정 파싱
            local private_key=$(echo "$config" | grep "PrivateKey" | cut -d'=' -f2 | tr -d ' ')
            local address=$(echo "$config" | grep "Address" | cut -d'=' -f2 | tr -d ' ')
            local public_key=$(echo "$config" | grep "PublicKey" | cut -d'=' -f2 | tr -d ' ')
            local endpoint=$(echo "$config" | grep "Endpoint" | cut -d'=' -f2 | tr -d ' ')

            if [ "$first" = true ]; then
                first=false
            else
                echo ","
            fi

            cat << EOF
  {
    "server_ip": "$ip",
    "dongle": $dongle,
    "private_key": "$private_key",
    "address": "$address",
    "public_key": "$public_key",
    "endpoint": "$endpoint"
  }
EOF
        fi
    done

    echo ""
    echo "]"
}

# 메인
case "${1:-}" in
    --list|-l)
        list_servers
        ;;
    --json|-j)
        fetch_all_json
        ;;
    --help|-h)
        echo "사용법:"
        echo "  $0                      # 모든 VPN 설정 조회"
        echo "  $0 --list               # 서버/동글 목록만 출력"
        echo "  $0 --json               # JSON 형식으로 출력"
        echo "  $0 <서버IP> <동글번호>  # 특정 설정 조회"
        echo ""
        echo "예시:"
        echo "  $0 49.171.88.233 18     # 특정 서버/동글 설정"
        echo "  $0 49.171.88.233 18 5   # 특정 서버/동글/슬롯 설정"
        ;;
    "")
        fetch_all_configs
        ;;
    *)
        if [ -n "$1" ] && [ -n "$2" ]; then
            fetch_single_config "$1" "$2" "${3:-0}"
        else
            warn "잘못된 인자. --help 참조"
        fi
        ;;
esac
