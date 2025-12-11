/**
 * Chrome 버전 관리
 * - 설치된 Chrome 버전 수집
 * - 랜덤 Chrome 버전 선택
 *
 * Updated: 2025-10-09 - api-mode.js에서 분리
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Chrome 버전 풀 관리
let availableChromeVersions = null;

/**
 * 설치된 Chrome 버전들을 수집
 * @returns {Array} 설치된 Chrome 버전 정보 배열
 */
function collectInstalledChromeVersions() {
  // sudo 실행 시에도 tech 사용자의 chrome-versions 사용
  const chromeBaseDir = '/home/tech/chrome-versions';

  if (!fs.existsSync(chromeBaseDir)) {
    console.log('⚠️ Chrome 버전 디렉토리가 없습니다. 기본 Chrome 사용.');
    return [];
  }

  const versions = [];
  const dirs = fs.readdirSync(chromeBaseDir).filter(dir => {
    if (!dir.startsWith('chrome-')) return false;

    // Chrome for Testing 구조: chrome-linux64/chrome
    const newPath = path.join(chromeBaseDir, dir, 'chrome-linux64/chrome');
    // 기존 apt 구조: opt/google/chrome/chrome
    const legacyPath = path.join(chromeBaseDir, dir, 'opt/google/chrome/chrome');

    return fs.existsSync(newPath) || fs.existsSync(legacyPath);
  });

  for (const dir of dirs) {
    // Chrome for Testing 구조 우선 확인
    const newPath = path.join(chromeBaseDir, dir, 'chrome-linux64/chrome');
    const legacyPath = path.join(chromeBaseDir, dir, 'opt/google/chrome/chrome');
    const execPath = fs.existsSync(newPath) ? newPath : legacyPath;

    const versionFile = path.join(chromeBaseDir, dir, 'VERSION');

    let version = null;
    if (fs.existsSync(versionFile)) {
      version = fs.readFileSync(versionFile, 'utf8').trim();
    } else {
      // 디렉토리 이름에서 버전 추출
      const parts = dir.replace('chrome-', '').split('-');
      if (parts.length >= 4) {
        version = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
      } else {
        version = parts.join('.');
      }
    }

    versions.push({
      dir: dir,
      path: execPath,
      version: version,
      majorVersion: version ? version.split('.')[0] : null
    });
  }

  console.log(`\n🎯 설치된 Chrome 버전 수집 완료: ${versions.length}개`);
  if (versions.length > 0) {
    const majorGroups = {};
    versions.forEach(v => {
      const major = v.majorVersion || 'unknown';
      if (!majorGroups[major]) majorGroups[major] = 0;
      majorGroups[major]++;
    });

    // console.log('   버전 분포:');
    // Object.keys(majorGroups).sort().forEach(major => {
    //   console.log(`   - Chrome ${major}: ${majorGroups[major]}개`);
    // });
  }

  return versions;
}

/**
 * 랜덤하게 Chrome 버전 선택
 * @param {Array<string>} excludedBuilds - 제외할 빌드 번호 목록
 * @returns {Object|null} 선택된 Chrome 버전 정보
 */
function getRandomChromeVersion(excludedBuilds = []) {
  // 첫 실행 시 Chrome 버전 수집
  if (availableChromeVersions === null) {
    availableChromeVersions = collectInstalledChromeVersions();
  }

  if (availableChromeVersions.length === 0) {
    return null;
  }

  // 제외할 빌드 필터링
  let filteredVersions = availableChromeVersions;
  if (excludedBuilds && excludedBuilds.length > 0) {
    filteredVersions = availableChromeVersions.filter(chromeInfo => {
      return !excludedBuilds.includes(chromeInfo.version);
    });

    console.log(`🚫 제외된 Chrome 빌드: ${excludedBuilds.length}개`);
    console.log(`✅ 사용 가능한 Chrome 빌드: ${filteredVersions.length}개 (전체: ${availableChromeVersions.length}개)`);
  }

  // 필터링 후 선택 가능한 버전이 없으면 전체에서 선택
  if (filteredVersions.length === 0) {
    console.log(`⚠️ 제외 후 사용 가능한 Chrome이 없어 전체 목록에서 선택합니다.`);
    filteredVersions = availableChromeVersions;
  }

  const selected = filteredVersions[Math.floor(Math.random() * filteredVersions.length)];
  return selected;
}

/**
 * 인덱스 기반 Chrome 버전 선택 (멀티 VPN 모드용)
 * 동글 번호와 쓰레드 번호를 조합해서 고유한 Chrome 버전 할당
 * @param {number} dongle - VPN 동글 번호 (11~20)
 * @param {number} threadNum - 쓰레드 번호 (1~N)
 * @param {number} threadsPerVpn - VPN당 쓰레드 수
 * @param {Array<string>} excludedBuilds - 제외할 빌드 번호 목록
 * @returns {Object|null} 선택된 Chrome 버전 정보
 */
function getChromeVersionByIndex(dongle, threadNum, threadsPerVpn = 2, excludedBuilds = []) {
  // 첫 실행 시 Chrome 버전 수집
  if (availableChromeVersions === null) {
    availableChromeVersions = collectInstalledChromeVersions();
  }

  if (availableChromeVersions.length === 0) {
    return null;
  }

  // 제외할 빌드 필터링
  let filteredVersions = availableChromeVersions;
  if (excludedBuilds && excludedBuilds.length > 0) {
    filteredVersions = availableChromeVersions.filter(chromeInfo => {
      return !excludedBuilds.includes(chromeInfo.version);
    });
  }

  if (filteredVersions.length === 0) {
    filteredVersions = availableChromeVersions;
  }

  // 버전 정렬 (메이저 버전 기준)
  filteredVersions.sort((a, b) => {
    const aMajor = parseInt(a.majorVersion) || 0;
    const bMajor = parseInt(b.majorVersion) || 0;
    return aMajor - bMajor;
  });

  // 고유 인덱스 계산: (동글-11) * threadsPerVpn + (쓰레드-1)
  // 예: 동글11 쓰레드1 = 0, 동글11 쓰레드2 = 1, 동글12 쓰레드1 = 2, ...
  const uniqueIndex = ((dongle - 11) * threadsPerVpn + (threadNum - 1)) % filteredVersions.length;

  const selected = filteredVersions[uniqueIndex];
  console.log(`🎯 [VPN-${dongle}/쓰레드${threadNum}] Chrome 할당: ${selected.majorVersion} (인덱스: ${uniqueIndex}/${filteredVersions.length})`);

  return selected;
}

module.exports = {
  collectInstalledChromeVersions,
  getRandomChromeVersion,
  getChromeVersionByIndex
};
