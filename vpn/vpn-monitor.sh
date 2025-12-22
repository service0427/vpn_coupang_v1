#!/bin/bash
# VPN 상태 + 브라우저 진단 모니터링 스크립트
#
# 사용법:
#   ./vpn/vpn-monitor.sh           # 기본 상태
#   ./vpn/vpn-monitor.sh --watch   # 실시간 모니터링 (2초 갱신)
#   ./vpn/vpn-monitor.sh --diag    # 브라우저 미구동 진단 포함

STATUS_DIR="./browser-data/vpn-status"
WATCH_MODE=false
DIAG_MODE=false

# 옵션 파싱
while [[ $# -gt 0 ]]; do
  case $1 in
    -w|--watch)
      WATCH_MODE=true
      shift
      ;;
    -d|--diag)
      DIAG_MODE=true
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

show_status() {
  clear
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}                   VPN 에이전트 상태 모니터                      ${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""

  if [ ! -d "$STATUS_DIR" ]; then
    echo -e "${YELLOW}⚠️  상태 디렉토리가 없습니다: $STATUS_DIR${NC}"
    echo "   VPN 에이전트가 한 번이라도 실행되어야 생성됩니다."
    return
  fi

  local total_success=0
  local total_fail=0
  local total_blocked=0
  local active_count=0

  # Python으로 에이전트별 최신 상태 파싱 및 출력
  local result=$(python3 << 'PYEOF'
import os, json, glob
from datetime import datetime, timezone

status_dir = "./browser-data/vpn-status"
agents = {}

# 각 에이전트의 최신 상태 파일 찾기
for f in glob.glob(f"{status_dir}/*.json"):
    try:
        with open(f) as fp:
            d = json.load(fp)
        agent_id = d.get('agentId', '')
        updated = d.get('updatedAt', '')
        if agent_id and updated:
            if agent_id not in agents or updated > agents[agent_id]['updated']:
                agents[agent_id] = {
                    'file': f,
                    'updated': updated,
                    'data': d
                }
    except:
        pass

# 통계
total_success = 0
total_fail = 0
total_blocked = 0
active_count = 0

# 출력
for agent_id in sorted(agents.keys()):
    d = agents[agent_id]['data']
    t = d.get('totalStats', {})

    dongle = d.get('dongle', '?')
    ip = d.get('ip', 'unknown')
    status = d.get('status', 'unknown')
    success = t.get('success', 0)
    fail = t.get('fail', 0)
    blocked = t.get('blocked', 0)

    # 시간 계산
    updated = d.get('updatedAt', '')
    age = 0
    try:
        ut = datetime.fromisoformat(updated.replace('Z', '+00:00'))
        age = int((datetime.now(timezone.utc) - ut).total_seconds())
    except:
        pass

    # 상태 색상 코드
    if status == 'working':
        status_color = '\033[0;32m'  # GREEN
        active_count += 1
    elif status == 'toggling':
        status_color = '\033[0;33m'  # YELLOW
    else:
        status_color = '\033[0m'

    # 오래된 상태 (2분 이상)
    stale = ""
    if age > 120:
        stale = f" ({age}s ago)"
        status_color = '\033[0m'

    NC = '\033[0m'
    CYAN = '\033[0;36m'
    GREEN = '\033[0;32m'
    RED = '\033[0;31m'
    YELLOW = '\033[0;33m'

    print(f"{CYAN}[{agent_id:9}]{NC} 동글:{dongle:2} IP: {ip:15} 상태: {status_color}{status:8}{NC} 성공: {GREEN}{success:5}{NC} 실패: {RED}{fail:4}{NC} 차단: {YELLOW}{blocked:3}{NC}{stale}")

    total_success += success
    total_fail += fail
    total_blocked += blocked

# 합계 출력 (마지막 줄에 특수 포맷)
print(f"__TOTALS__:{active_count}:{total_success}:{total_fail}:{total_blocked}")
PYEOF
)

  # Python 출력에서 합계 추출
  echo "$result" | grep -v "^__TOTALS__"
  local totals=$(echo "$result" | grep "^__TOTALS__" | cut -d: -f2-)
  active_count=$(echo "$totals" | cut -d: -f1)
  total_success=$(echo "$totals" | cut -d: -f2)
  total_fail=$(echo "$totals" | cut -d: -f3)
  total_blocked=$(echo "$totals" | cut -d: -f4)

  if [ $total_success -eq 0 ] && [ $total_fail -eq 0 ]; then
    echo -e "${YELLOW}📭 실행 중인 에이전트가 없습니다.${NC}"
  else
    echo ""
    echo -e "${CYAN}───────────────────────────────────────────────────────────────${NC}"
    printf "합계: 활성 ${GREEN}%d${NC}개 | " "$active_count"
    printf "성공 ${GREEN}%d${NC} | " "$total_success"
    printf "실패 ${RED}%d${NC} | " "$total_fail"
    printf "차단 ${YELLOW}%d${NC}\n" "$total_blocked"
  fi

  echo ""

  # 브라우저 진단 모드
  if $DIAG_MODE; then
    echo -e "${CYAN}───────────────────────────────────────────────────────────────${NC}"
    echo -e "${YELLOW}[프로세스 진단]${NC}"

    local runner_count=$(ps aux | grep "single-task-runner" | grep -v grep | wc -l)
    local chrome_count=$(ps aux | grep -E "chrome|chromium" | grep -v grep | wc -l)
    local ns_count=$(ip netns list 2>/dev/null | grep -c "U22" || echo 0)

    printf "  Task Runner:  %3d 개\n" "$runner_count"
    printf "  Chrome 브라우저: %3d 개\n" "$chrome_count"
    printf "  VPN 네임스페이스: %3d 개\n" "$ns_count"

    # 문제 진단
    echo ""
    echo -e "${YELLOW}[진단 결과]${NC}"

    if [ "$runner_count" -gt 0 ] && [ "$chrome_count" -eq 0 ]; then
      echo -e "  ${RED}⚠️  심각: Runner($runner_count)는 있지만 Chrome이 없음!${NC}"
      echo -e "  ${RED}     → 브라우저 시작 실패 또는 VPN 연결 문제${NC}"
    elif [ "$runner_count" -gt "$chrome_count" ]; then
      local missing=$((runner_count - chrome_count))
      echo -e "  ${YELLOW}⚠️  경고: Chrome이 $missing 개 부족${NC}"
      echo -e "  ${YELLOW}     → 일부 브라우저 시작 지연 또는 실패${NC}"
    else
      echo -e "  ${GREEN}✓ 정상: Runner와 Chrome 수 일치${NC}"
    fi

    # 토글 중인 에이전트 수 (오래된 JSON 제외)
    local toggling_count=$(grep -l '"status": "toggling"' "$STATUS_DIR"/*.json 2>/dev/null | wc -l)
    if [ "$toggling_count" -gt 3 ]; then
      echo -e "  ${YELLOW}⚠️  참고: 오래된 JSON 파일 $toggling_count 개 (무시해도 됨)${NC}"
    fi

    # VPN 연결 성공률 (핵심 지표)
    echo ""
    echo -e "${YELLOW}[VPN 연결 성공률]${NC}"
    local avg_rate=0
    local rate_count=0
    for f in logs/vpn/2025-12-18_U22-01-*.log; do
      if [ -f "$f" ]; then
        local name=$(basename "$f" .log | sed 's/2025-12-18_//')
        local rate=$(tail -c 10000 "$f" | grep -oP '"connectSuccessRate": "\K[^"]+' | tail -1)
        if [ -n "$rate" ]; then
          # 성공률이 50% 미만이면 경고
          local rate_int=${rate%.*}
          if [ "$rate_int" -lt 50 ] 2>/dev/null; then
            echo -e "  ${RED}$name: ${rate}% (낮음!)${NC}"
          else
            echo -e "  ${GREEN}$name: ${rate}%${NC}"
          fi
        fi
      fi
    done

    # 최근 로그에서 에러 패턴 확인
    local log_dir=$(ls -td logs/multi-* 2>/dev/null | head -1)
    if [ -d "$log_dir" ]; then
      echo ""
      echo -e "${YELLOW}[최근 에러 (로그)]${NC}"
      local error_found=false

      for f in "$log_dir"/*.log; do
        local name=$(basename "$f" .log)
        local recent=$(tail -30 "$f" 2>/dev/null)

        # 브라우저 시작 실패
        local browser_err=$(echo "$recent" | grep -E "브라우저.*실패|launch.*fail|Chrome.*error" | tail -1)
        if [ -n "$browser_err" ]; then
          echo -e "  ${RED}$name: $browser_err${NC}"
          error_found=true
        fi

        # IP 체크 실패
        local ip_err=$(echo "$recent" | grep -E "IP 체크 실패|ipCheckFailed" | tail -1)
        if [ -n "$ip_err" ]; then
          echo -e "  ${YELLOW}$name: IP 체크 실패${NC}"
          error_found=true
        fi

        # VPN 연결 실패
        local vpn_err=$(echo "$recent" | grep -E "VPN.*실패|네임스페이스.*실패|동글.*실패" | tail -1)
        if [ -n "$vpn_err" ]; then
          echo -e "  ${RED}$name: $vpn_err${NC}"
          error_found=true
        fi
      done

      if [ "$error_found" = false ]; then
        echo -e "  ${GREEN}✓ 최근 심각한 에러 없음${NC}"
      fi
    fi

    # VPN 상세 로그에서 연결 실패 확인
    echo ""
    echo -e "${YELLOW}[VPN 연결 로그 (최근)]${NC}"
    local today=$(date +%Y-%m-%d)
    local vpn_errors=0

    # 최근 1시간 내 VPN 로그에서 연결 실패 확인
    vpn_errors=$(tail -500 logs/vpn/2025-12-18_*.log 2>/dev/null | grep -c "연결 실패\|IP 확인 실패" 2>/dev/null | tr -d '\n' || echo 0)
    vpn_errors=${vpn_errors:-0}

    if [ "$vpn_errors" -gt 0 ] 2>/dev/null; then
      echo -e "  ${YELLOW}최근 VPN 연결/IP 실패: $vpn_errors 회${NC}"
    else
      echo -e "  ${GREEN}✓ VPN 연결 정상${NC}"
    fi
  fi

  echo ""
  echo -e "${CYAN}마지막 업데이트: $(date '+%Y-%m-%d %H:%M:%S')${NC}"

  if $WATCH_MODE; then
    echo -e "${CYAN}(Ctrl+C로 종료, 2초마다 갱신)${NC}"
  fi
}

# 실행
if $WATCH_MODE; then
  while true; do
    show_status
    sleep 2
  done
else
  show_status
fi
