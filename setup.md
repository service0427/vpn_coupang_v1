# Ubuntu 22.04 자동화 서버 초기 설정

> 쿠팡 자동화 에이전트 실행을 위한 Ubuntu 22.04 LTS 최적화 가이드

## 요구사항

- **OS**: Ubuntu 22.04 LTS (24.04는 자동 로그아웃 이슈 있음)
- **RAM**: 32GB 권장 (최소 16GB)
- **스토리지**: SSD 256GB 이상 (스왑용)
- **GUI**: GNOME Desktop (headless 모드 불가)

## 빠른 설치

```bash
# 1. GUI에서 SSH 먼저 설치 후 원격 접속
sudo apt install openssh-server -y

# 2. 스크립트 실행
chmod +x setup.sh
sudo ./setup.sh

# 3. 재부팅
sudo reboot
```

## 설치 항목

| 항목 | 설명 |
|------|------|
| Node.js 22.x (N\|Solid) | 자동화 런타임 |
| Google Chrome | Playwright/Patchright 브라우저 |
| AnyDesk | 원격 데스크톱 |
| fcitx5-hangul | 한글 입력기 |

## 최적화 항목

| 항목 | 효과 |
|------|------|
| Snap 완전 제거 | 5GB 디스크 절약, 부팅 속도 향상 |
| CUPS 비활성화 | 22MB RAM 절약, 불필요 서비스 제거 |
| CPU Governor → Performance | 일관된 최대 클럭 유지 |
| swappiness=10 | RAM 우선 사용 |
| nofile 65536 | Chrome 다중 인스턴스 지원 |

## 시스템 최적화

### 자동 업데이트 비활성화
```bash
sudo systemctl disable --now unattended-upgrades.service
sudo systemctl disable --now apt-daily.service apt-daily.timer
sudo systemctl disable --now apt-daily-upgrade.service apt-daily-upgrade.timer
```

### 버전 업그레이드 차단
```bash
sudo sed -i 's/Prompt=lts/Prompt=never/g' /etc/update-manager/release-upgrades
sudo sed -i 's/Prompt=normal/Prompt=never/g' /etc/update-manager/release-upgrades
```

### 스왑 파일 생성 (32GB)
```bash
sudo fallocate -l 32G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Snap 완전 제거
```bash
# 설치된 Snap 패키지 제거
for pkg in $(snap list | awk '!/^Name|^bare|^core|^snapd/{print $1}'); do
    sudo snap remove --purge "$pkg"
done

# snapd 서비스 중지 및 제거
sudo systemctl stop snapd.service snapd.socket
sudo systemctl disable snapd.service snapd.socket
sudo apt autoremove --purge snapd -y

# 잔여 폴더 제거
rm -rf ~/snap
sudo rm -rf /snap /var/snap /var/lib/snapd /var/cache/snapd
```

### CUPS (프린터) 비활성화
```bash
sudo systemctl stop cups.service cups-browsed.service
sudo systemctl disable cups.service cups-browsed.service
```

### CPU Governor → Performance
```bash
# cpufrequtils 설치
sudo apt install -y cpufrequtils

# performance 모드 설정
echo 'GOVERNOR="performance"' | sudo tee /etc/default/cpufrequtils

# 서비스 재시작
sudo systemctl restart cpufrequtils
```

### 성능 튜닝
```bash
# swappiness 낮추기 (RAM 우선 사용)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf

# 파일 디스크립터 한도 증가
echo '* soft nofile 65536' | sudo tee -a /etc/security/limits.conf
echo '* hard nofile 65536' | sudo tee -a /etc/security/limits.conf

sudo sysctl -p
```

### GUI 설정 (GNOME)
```bash
# 화면 꺼짐 방지
gsettings set org.gnome.desktop.session idle-delay 0

# 다크모드
gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'

# 애니메이션 비활성화 (성능 향상)
gsettings set org.gnome.desktop.interface enable-animations false
```

## 수동 설치 (단계별)

<details>
<summary>펼쳐서 보기</summary>

### 1. 기본 패키지
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git openssh-server htop wget gnupg ca-certificates apt-transport-https
```

### 2. Node.js 22.x
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nsolid
```

### 3. Google Chrome
```bash
sudo install -d -m 0755 /etc/apt/keyrings
wget -qO- https://dl.google.com/linux/linux_signing_key.pub | sudo tee /etc/apt/keyrings/google.asc >/dev/null
sudo chmod a+r /etc/apt/keyrings/google.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google.asc] http://dl.google.com/linux/chrome/deb/ stable main" | \
    sudo tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
sudo apt update && sudo apt install -y google-chrome-stable
```

### 4. AnyDesk
```bash
curl -fsSL https://keys.anydesk.com/repos/DEB-GPG-KEY | sudo tee /etc/apt/keyrings/keys.anydesk.com.asc >/dev/null
sudo chmod a+r /etc/apt/keyrings/keys.anydesk.com.asc
echo 'deb [signed-by=/etc/apt/keyrings/keys.anydesk.com.asc] https://deb.anydesk.com all main' | \
    sudo tee /etc/apt/sources.list.d/anydesk-stable.list >/dev/null
sudo apt update && sudo apt install -y anydesk
sudo systemctl enable --now anydesk
```

### 5. 한글 입력기
```bash
sudo apt install -y fcitx5 fcitx5-hangul
im-config -n fcitx5
```

</details>

## 설치 확인

```bash
# 버전 확인
nsolid -v
google-chrome --version
anydesk --version

# 시스템 상태
htop
swapon --show
cat /proc/sys/vm/swappiness
```

## 문제 해결

### Chrome이 실행되지 않는 경우
- `headless: false` 설정 확인 (TLS 오류 방지)
- X11 디스플레이 확인: `echo $DISPLAY`

### 스왑 부족
```bash
# 스왑 사용량 확인
free -h

# 추가 스왑 필요시 크기 조절
sudo swapoff /swapfile
sudo fallocate -l 64G /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```
