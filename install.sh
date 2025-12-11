#!/bin/bash

# Coupang Agent V2 자동 설치 스크립트
# Ubuntu/Debian 기반 시스템용

set -e  # 에러 발생 시 중단

echo "=========================================="
echo "Coupang Agent V2 자동 설치 시작"
echo "=========================================="
echo ""

# 1. Node.js 버전 확인
echo "1️⃣ Node.js 버전 확인..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js가 설치되지 않았습니다."
    echo "   다음 명령어로 Node.js 18+ 설치:"
    echo "   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
    echo "   sudo apt-get install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
    echo "❌ Node.js 버전이 너무 낮습니다 (현재: $(node -v), 필요: v16+)"
    exit 1
fi

echo "✅ Node.js $(node -v)"
echo ""

# 2. Chrome 시스템 의존성 설치 (Ubuntu/Debian)
if command -v apt-get &> /dev/null; then
    echo "2️⃣ Chrome 시스템 의존성 설치 중..."

    # sudo 권한 확인
    if [ "$EUID" -ne 0 ]; then
        echo "   ⚠️ sudo 권한이 필요합니다. 비밀번호를 입력해주세요."
        sudo apt-get update
        sudo apt-get install -y \
            libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
            libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
            libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
            libcairo2 libasound2 \
            fonts-liberation libappindicator3-1 \
            xdg-utils wget ca-certificates \
            wireguard wireguard-tools
    else
        apt-get update
        apt-get install -y \
            libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
            libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
            libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
            libcairo2 libasound2 \
            fonts-liberation libappindicator3-1 \
            xdg-utils wget ca-certificates \
            wireguard wireguard-tools
    fi

    echo "✅ Chrome 의존성 및 WireGuard 설치 완료"

    # WireGuard 커널 모듈 로드
    echo "   WireGuard 커널 모듈 로드 중..."
    sudo modprobe wireguard 2>/dev/null || true

    # 부팅 시 자동 로드 설정
    if [ ! -f /etc/modules-load.d/wireguard.conf ]; then
        echo wireguard | sudo tee /etc/modules-load.d/wireguard.conf > /dev/null
        echo "   ✅ WireGuard 자동 로드 설정 완료"
    fi
    echo ""
fi

# 3. npm 패키지 설치 (postinstall로 Patchright Chromium 자동 설치됨)
echo "3️⃣ npm 패키지 설치 중 (Patchright Chromium 포함)..."
npm install
echo "✅ 패키지 설치 완료"
echo ""

# 4. 설치 확인
echo "4️⃣ 설치 확인 중..."
if [ -d "node_modules" ]; then
    echo "✅ node_modules 디렉토리 확인"
fi

if [ -d "$HOME/.cache/ms-playwright" ] || [ -d "$HOME/Library/Caches/ms-playwright" ]; then
    echo "✅ Patchright 브라우저 바이너리 확인"
fi

echo ""
echo "=========================================="
echo "✅ 설치 완료!"
echo "=========================================="
echo ""
echo "다음 명령어로 실행:"
echo "  node index.js --threads 4 --status"
echo ""
echo "도움말:"
echo "  node index.js --help"
echo ""

# VPN 모드 사용 시 sudoers 설정 필요
# node와 ip 명령어를 비밀번호 없이 실행하기 위함
# sudo bash -c 'echo "tech ALL=(ALL) NOPASSWD: /usr/bin/node, /usr/sbin/ip, /sbin/ip" > /etc/sudoers.d/tech-nopasswd && chmod 440 /etc/sudoers.d/tech-nopasswd'

echo "=========================================="
echo "⚠️  VPN 모드 사용 시 추가 설정 필요:"
echo "=========================================="
echo ""
echo "다음 명령어로 sudoers 설정 (비밀번호 없이 실행 허용):"
echo ""
echo "  sudo bash -c 'echo \"\$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/node, /usr/sbin/ip, /sbin/ip\" > /etc/sudoers.d/\$(whoami)-nopasswd && chmod 440 /etc/sudoers.d/\$(whoami)-nopasswd'"
echo ""
