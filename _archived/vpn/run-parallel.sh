#!/bin/bash
#
# 8개 VPN 동글 병렬 실행 (쿠팡 에이전트)
# 마스터 프로세스가 8개 자식 프로세스를 관리
#
# 사용법:
#   sudo ./vpn/run-parallel.sh                  # 8개 동글 동시 실행 (연속, VPN당 1쓰레드)
#   sudo ./vpn/run-parallel.sh --threads=2      # 8개 동글, VPN당 2쓰레드 (배치 모드)
#   sudo ./vpn/run-parallel.sh --once           # 8개 동글 동시 실행 (1회)
#   sudo ./vpn/run-parallel.sh --status         # 상태 모니터링 활성화
#
# 배치 모드:
#   --threads=N 옵션으로 VPN당 N개 쓰레드를 실행합니다.
#   배치 모드에서는 N개 쓰레드가 동시에 작업을 수행하고,
#   모든 쓰레드가 완료된 후 실패가 1개 이상이면 IP를 토글합니다.
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DONGLES=(16 17 18 19 20 21 22 23)

# 색상
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Root 권한 확인
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[ERROR]${NC} sudo로 실행하세요: sudo ./vpn/run-parallel.sh"
    exit 1
fi

# 원래 사용자 정보
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)
REAL_UID=$(id -u "$REAL_USER")

# 옵션 파싱
EXTRA_OPTS=""
for arg in "$@"; do
    EXTRA_OPTS="$EXTRA_OPTS $arg"
done

# --threads 옵션 파싱
THREADS=1
for arg in $EXTRA_OPTS; do
    if [[ "$arg" =~ ^--threads=([0-9]+)$ ]]; then
        THREADS="${BASH_REMATCH[1]}"
    fi
done

echo -e "${GREEN}[PARALLEL]${NC} ========================================"
echo -e "${GREEN}[PARALLEL]${NC} 쿠팡 에이전트 - 8개 VPN 동글 병렬 실행"
echo -e "${GREEN}[PARALLEL]${NC} 동글: ${DONGLES[*]}"
echo -e "${GREEN}[PARALLEL]${NC} VPN당 쓰레드 수: ${THREADS}개"
if [ "$THREADS" -gt 1 ]; then
    echo -e "${GREEN}[PARALLEL]${NC} 모드: 배치 모드 (실패 시에만 IP 토글)"
fi
echo -e "${GREEN}[PARALLEL]${NC} 옵션: $EXTRA_OPTS"
echo -e "${GREEN}[PARALLEL]${NC} ========================================"
echo ""

# X 서버 접근 권한
if [ -n "$DISPLAY" ]; then
    xhost +local: >/dev/null 2>&1 || true
    xhost + >/dev/null 2>&1 || true
fi

# 실제 IP 조회 (VPN 연결 전에 조회)
echo -e "${GREEN}[PARALLEL]${NC} 실제 IP 조회 중..."
REAL_IP=$(curl -s --connect-timeout 5 http://mkt.techb.kr/ip 2>/dev/null || echo "")
if [ -z "$REAL_IP" ]; then
    REAL_IP=$(curl -s --connect-timeout 5 http://ifconfig.me 2>/dev/null || echo "unknown")
fi
echo -e "${GREEN}[PARALLEL]${NC} 실제 IP: ${REAL_IP}"

# PID 저장 배열
declare -A PIDS

# 종료 시 모든 자식 프로세스 정리
cleanup() {
    echo ""
    echo -e "${YELLOW}[PARALLEL]${NC} 종료 중... 자식 프로세스 정리"
    for DONGLE in "${!PIDS[@]}"; do
        if kill -0 "${PIDS[$DONGLE]}" 2>/dev/null; then
            kill "${PIDS[$DONGLE]}" 2>/dev/null
            echo -e "${YELLOW}[VPN $DONGLE]${NC} 종료됨"
        fi
    done
    # Chrome 프로세스 정리
    pkill -9 -f "browser-data" 2>/dev/null || true
    wait
    echo -e "${GREEN}[PARALLEL]${NC} 완료"
    exit 0
}
trap cleanup SIGINT SIGTERM

# 각 동글별로 백그라운드 실행
INDEX=0
for DONGLE in "${DONGLES[@]}"; do
    NAMESPACE="vpn-$DONGLE"

    # 네임스페이스 확인
    if ! ip netns list | grep -q "^$NAMESPACE"; then
        echo -e "${RED}[VPN $DONGLE]${NC} 네임스페이스 없음 - 건너뜀"
        continue
    fi

    echo -e "${CYAN}[VPN $DONGLE]${NC} 시작..."

    # VPN 네임스페이스에서 실행 (백그라운드)
    (
        cd "$PROJECT_DIR"
        XAUTH_FILE="${XAUTHORITY:-$REAL_HOME/.Xauthority}"

        ip netns exec "$NAMESPACE" \
            sudo -u "$REAL_USER" \
            env HOME="$REAL_HOME" \
            USER="$REAL_USER" \
            DISPLAY="${DISPLAY:-:0}" \
            XAUTHORITY="$XAUTH_FILE" \
            XDG_RUNTIME_DIR="/run/user/$REAL_UID" \
            DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$REAL_UID/bus" \
            PATH="$PATH" \
            VPN_NAMESPACE="$NAMESPACE" \
            VPN_INDEX="$INDEX" \
            REAL_IP="$REAL_IP" \
            node index-vpn.js --vpn=$DONGLE --thread-index=$INDEX $EXTRA_OPTS 2>&1 | \
            while IFS= read -r line; do
                echo -e "${CYAN}[VPN $DONGLE]${NC} $line"
            done
    ) &

    PIDS[$DONGLE]=$!
    INDEX=$((INDEX + 1))
    sleep 1  # 시작 간격
done

echo ""
echo -e "${GREEN}[PARALLEL]${NC} ${#PIDS[@]}개 프로세스 실행 중 (Ctrl+C로 종료)"
echo ""

# 모든 자식 프로세스 대기
wait

echo ""
echo -e "${GREEN}[PARALLEL]${NC} 모든 프로세스 완료!"
