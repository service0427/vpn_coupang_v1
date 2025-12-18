#!/bin/bash
#
# Google Chrome Stable - 다중 빌드 동기화 스크립트
# NDViet/google-chrome-stable GitHub 릴리즈 기준 (최신 30개 빌드)
#
# 핑거프린트 다양화를 위해 여러 빌드를 동시 관리
# --sync: GitHub 릴리즈와 동기화 (신규 추가 + 없어진 버전 제거)
#

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 설정
GITHUB_API="https://api.github.com/repos/NDViet/google-chrome-stable/releases"
GITHUB_RELEASES="https://github.com/NDViet/google-chrome-stable/releases/download"
INSTALL_DIR="$HOME/chrome-versions"
TEMP_DIR="/tmp/chrome-deb-downloads"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Google Chrome Stable - Build Sync${NC}"
echo -e "${BLUE}(NDViet GitHub Releases)${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 사용법
show_usage() {
    echo -e "${GREEN}Chrome 빌드 동기화 스크립트${NC}"
    echo
    echo "사용법:"
    echo "  $0 --sync      # GitHub 릴리즈와 동기화 (권장)"
    echo "                 # - 신규 빌드 설치"
    echo "                 # - 없어진 빌드 제거"
    echo "                 # - 약 30개 빌드 유지"
    echo
    echo "  $0 list        # 설치된 빌드 목록"
    echo "  $0 available   # GitHub에서 다운로드 가능한 빌드 목록"
    echo "  $0 <버전>      # 특정 빌드 설치 (예: 143.0.7499.146-1)"
    echo
    echo "예시:"
    echo "  $0 --sync                  # 전체 동기화"
    echo "  $0 143.0.7499.146-1        # 특정 빌드만 설치"
    echo
    exit 0
}

# 설치된 빌드 목록 (버전 문자열 배열로 반환)
get_installed_builds() {
    local builds=()
    if [ -d "$INSTALL_DIR" ]; then
        for dir in $(ls -d $INSTALL_DIR/chrome-* 2>/dev/null); do
            if [ -f "$dir/opt/google/chrome/chrome" ]; then
                dirname=$(basename "$dir")
                # chrome-137-0-7151-55 → 137.0.7151.55-1
                version=$(echo "${dirname#chrome-}" | tr '-' '.')
                version="${version}-1"
                builds+=("$version")
            fi
        done
    fi
    echo "${builds[@]}"
}

# GitHub 릴리즈에서 사용 가능한 빌드 목록 가져오기
get_available_builds() {
    curl -s "$GITHUB_API" 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if isinstance(data, list):
        for r in data:
            print(r['tag_name'])
except:
    pass
" 2>/dev/null
}

# list 명령 처리
if [ "$1" = "list" ]; then
    echo -e "${BLUE}=== 설치된 Chrome 빌드 ===${NC}"
    echo

    if [ -d "$INSTALL_DIR" ]; then
        installed_count=0
        for dir in $(ls -d $INSTALL_DIR/chrome-* 2>/dev/null | sort -V); do
            if [ -f "$dir/opt/google/chrome/chrome" ]; then
                dirname=$(basename "$dir")
                version=${dirname#chrome-}
                # 메이저 버전 추출
                major=$(echo "$version" | cut -d'-' -f1)
                echo -e "  ${GREEN}✓${NC} Chrome $version (major: $major)"
                ((installed_count++))
            fi
        done
        echo
        echo -e "${BLUE}총 ${installed_count}개 빌드 설치됨${NC}"
    else
        echo "  설치된 빌드 없음"
    fi
    exit 0
fi

# available 명령 처리
if [ "$1" = "available" ]; then
    echo -e "${BLUE}=== GitHub에서 다운로드 가능한 빌드 ===${NC}"
    echo

    builds=$(get_available_builds)
    count=0
    while IFS= read -r build; do
        [ -z "$build" ] && continue
        major=$(echo "$build" | cut -d'.' -f1)
        echo -e "  ${CYAN}$build${NC} (Chrome $major)"
        ((count++))
    done <<< "$builds"

    echo
    echo -e "${BLUE}총 ${count}개 빌드 다운로드 가능${NC}"
    exit 0
fi

# help 명령 처리
if [ "$1" = "help" ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    show_usage
fi

# 인자 없으면 사용법 표시
if [ -z "$1" ]; then
    show_usage
fi

# 디렉토리 생성
mkdir -p "$INSTALL_DIR"
mkdir -p "$TEMP_DIR"

# 단일 빌드 설치 함수
install_build() {
    local version="$1"
    local version_hyphen=$(echo "$version" | tr '.' '-' | sed 's/-1$//')
    local install_path="$INSTALL_DIR/chrome-$version_hyphen"
    local chrome_binary="$install_path/opt/google/chrome/chrome"

    # 이미 설치되어 있는지 확인
    if [ -f "$chrome_binary" ]; then
        echo -e "  ${YELLOW}Already installed${NC}"
        return 1
    fi

    # 다운로드 URL
    local download_url="$GITHUB_RELEASES/$version/google-chrome-stable_${version}_amd64.deb"
    local deb_path="$TEMP_DIR/chrome-$version.deb"

    # 다운로드
    echo "  Downloading..."
    if ! curl -L -s -o "$deb_path" "$download_url"; then
        echo -e "  ${RED}✗ Download failed${NC}"
        return 2
    fi

    # 파일 크기 확인 (최소 50MB)
    local file_size=$(stat -c%s "$deb_path" 2>/dev/null || echo 0)
    if [ "$file_size" -lt 50000000 ]; then
        echo -e "  ${RED}✗ Invalid file (size: $file_size bytes)${NC}"
        rm -f "$deb_path"
        return 2
    fi

    # deb 패키지 압축 해제
    echo "  Extracting..."
    mkdir -p "$install_path"

    cd "$TEMP_DIR"
    ar x "$deb_path" 2>/dev/null

    if [ -f "data.tar.xz" ]; then
        tar -xf data.tar.xz -C "$install_path"
        rm -f data.tar.xz control.tar.* debian-binary
    elif [ -f "data.tar.zst" ]; then
        zstd -d data.tar.zst -o data.tar 2>/dev/null
        tar -xf data.tar -C "$install_path"
        rm -f data.tar.zst data.tar control.tar.* debian-binary
    else
        echo -e "  ${RED}✗ Unknown deb format${NC}"
        rm -f "$deb_path"
        cd - > /dev/null
        return 2
    fi

    rm -f "$deb_path"
    cd - > /dev/null

    # 설치 확인
    if [ -f "$chrome_binary" ]; then
        local installed_version=$("$chrome_binary" --version 2>/dev/null | awk '{print $NF}' || echo "$version")
        echo -e "  ${GREEN}✓ Installed: Chrome $installed_version${NC}"
        return 0
    else
        echo -e "  ${RED}✗ Installation failed${NC}"
        rm -rf "$install_path"
        return 2
    fi
}

# 빌드 제거 함수
remove_build() {
    local version="$1"
    local version_hyphen=$(echo "$version" | tr '.' '-' | sed 's/-1$//')
    local install_path="$INSTALL_DIR/chrome-$version_hyphen"

    if [ -d "$install_path" ]; then
        rm -rf "$install_path"
        echo -e "  ${YELLOW}Removed: $version${NC}"
        return 0
    fi
    return 1
}

# --sync 모드
if [ "$1" = "--sync" ] || [ "$1" = "sync" ]; then
    echo -e "${YELLOW}Fetching available builds from GitHub...${NC}"

    # GitHub에서 사용 가능한 빌드 목록
    available_builds=$(get_available_builds)
    if [ -z "$available_builds" ]; then
        echo -e "${RED}GitHub API에서 빌드 목록을 가져올 수 없습니다${NC}"
        exit 1
    fi

    # 배열로 변환
    declare -a AVAILABLE=()
    while IFS= read -r build; do
        [ -n "$build" ] && AVAILABLE+=("$build")
    done <<< "$available_builds"

    AVAILABLE_COUNT=${#AVAILABLE[@]}
    echo -e "  ${GREEN}GitHub 빌드: ${AVAILABLE_COUNT}개${NC}"

    # 현재 설치된 빌드
    installed_str=$(get_installed_builds)
    declare -a INSTALLED=($installed_str)
    INSTALLED_COUNT=${#INSTALLED[@]}
    echo -e "  ${GREEN}설치된 빌드: ${INSTALLED_COUNT}개${NC}"
    echo

    # 1. 제거할 빌드 찾기 (GitHub에 없는 것)
    declare -a TO_REMOVE=()
    for installed in "${INSTALLED[@]}"; do
        found=0
        for available in "${AVAILABLE[@]}"; do
            if [ "$installed" = "$available" ]; then
                found=1
                break
            fi
        done
        if [ $found -eq 0 ]; then
            TO_REMOVE+=("$installed")
        fi
    done

    # 2. 설치할 빌드 찾기 (설치되지 않은 것)
    declare -a TO_INSTALL=()
    for available in "${AVAILABLE[@]}"; do
        found=0
        for installed in "${INSTALLED[@]}"; do
            if [ "$available" = "$installed" ]; then
                found=1
                break
            fi
        done
        if [ $found -eq 0 ]; then
            TO_INSTALL+=("$available")
        fi
    done

    REMOVE_COUNT=${#TO_REMOVE[@]}
    INSTALL_COUNT=${#TO_INSTALL[@]}

    # 변경 사항 요약
    echo -e "${BLUE}=== 동기화 계획 ===${NC}"
    echo -e "  제거 예정: ${REMOVE_COUNT}개"
    echo -e "  설치 예정: ${INSTALL_COUNT}개"
    echo

    # 제거할 것이 없고 설치할 것도 없으면
    if [ $REMOVE_COUNT -eq 0 ] && [ $INSTALL_COUNT -eq 0 ]; then
        echo -e "${GREEN}이미 동기화되어 있습니다!${NC}"
        exit 0
    fi

    # 제거 실행
    REMOVED=0
    if [ $REMOVE_COUNT -gt 0 ]; then
        echo -e "${BLUE}=== 오래된 빌드 제거 ===${NC}"
        for build in "${TO_REMOVE[@]}"; do
            echo -e "${CYAN}[$((REMOVED+1))/$REMOVE_COUNT] $build${NC}"
            if remove_build "$build"; then
                ((REMOVED++))
            fi
        done
        echo
    fi

    # 설치 실행
    SUCCESS=0
    FAILED=0
    SKIPPED=0
    if [ $INSTALL_COUNT -gt 0 ]; then
        echo -e "${BLUE}=== 신규 빌드 설치 ===${NC}"
        idx=0
        for build in "${TO_INSTALL[@]}"; do
            ((idx++))
            major=$(echo "$build" | cut -d'.' -f1)
            echo -e "${CYAN}[$idx/$INSTALL_COUNT] $build (Chrome $major)${NC}"

            result=$(install_build "$build")
            exit_code=$?
            echo "$result"

            if [ $exit_code -eq 0 ]; then
                ((SUCCESS++))
            elif [ $exit_code -eq 1 ]; then
                ((SKIPPED++))
            else
                ((FAILED++))
            fi
        done
        echo
    fi

    # 결과 요약
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}동기화 완료${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo -e "  제거됨: $REMOVED"
    echo -e "  설치됨: $SUCCESS"
    echo -e "  스킵됨: $SKIPPED"
    echo -e "  실패: $FAILED"
    echo

    # 최종 상태
    final_installed=$(get_installed_builds)
    final_count=$(echo "$final_installed" | wc -w)
    echo -e "${BLUE}현재 설치된 빌드: ${final_count}개${NC}"
    echo -e "${BLUE}확인: $0 list${NC}"

    exit 0
fi

# 특정 빌드 설치
if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+-1$ ]]; then
    version="$1"
    major=$(echo "$version" | cut -d'.' -f1)
    echo -e "${BLUE}Installing Chrome $major ($version)${NC}"
    install_build "$version"
    exit $?
fi

# 알 수 없는 명령
echo -e "${RED}알 수 없는 명령: $1${NC}"
echo
show_usage
