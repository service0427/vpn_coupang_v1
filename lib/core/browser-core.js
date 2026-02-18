/**
 * 브라우저 코어 모듈 - 완성형 통합 모듈 (클래스 기반)
 * BrowserManager + chrome-launcher + session-cleaner + browser-helpers 통합
 * 
 * ⚠️⚠️⚠️ 절대 수정 금지 ⚠️⚠️⚠️
 * HEADLESS 모드는 절대 사용하면 안됨!!!
 * Ubuntu 서버에서 headless=true 시 TLS 오류로 즉시 차단됨
 * 이 파일의 headless 관련 코드를 절대 수정하지 마시오
 * ⚠️⚠️⚠️ 절대 수정 금지 ⚠️⚠️⚠️
 */

const { chromium } = require('patchright');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const environment = require('../../environment');
const browserStateManager = require('../utils/browser-state-manager');

// 타임스탬프 생성 (밀리초 3자리 포함)
const getTimestamp = () => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
};

// 타임스탬프 포함 로그
const tsLog = (msg) => console.log(`[${getTimestamp()}] ${msg}`);

/**
 * 브라우저 코어 클래스 - 상속 가능한 완성형 기본 클래스
 * BrowserManager 기능 포함
 */
class BrowserCore {
  constructor(options = {}) {
    // ⚠️ HEADLESS는 항상 FALSE - 절대 수정 금지
    this.defaultOptions = {
      clearSession: true,
      headless: false,  // ⚠️ 절대 true로 변경 금지 - TLS 차단
      gpuDisabled: false,
      profileName: 'chrome'
    };
    this.options = { ...this.defaultOptions, ...options };
    // headless 강제 false 처리 (실수 방지)
    this.options.headless = false;

    // BrowserManager 기능
    this.activeBrowsers = new Map(); // profileName -> browser 매핑
    this.browserStats = {
      created: 0,
      closed: 0,
      reused: 0,
      active: 0
    };
  }

  /**
   * 브라우저 인스턴스 생성 또는 재사용 (BrowserManager 통합)
   * @param {Object} options - 브라우저 옵션
   * @returns {Object} 브라우저 정보
   */
  async getBrowser(options = {}) {
    const {
      proxyConfig = null,
      usePersistent = true,
      profileName = 'default',
      clearSession = true,
      gpuDisabled = false,
      windowPosition = null,
      userDataDir = null,
      executablePath = null,
      stealth = false
    } = options;

    const browserKey = this.generateBrowserKey(options);

    // 캐시 최적화: Chrome 프로세스 정리 후 프로필 재사용
    if (usePersistent) {
      const actualUserDataDir = userDataDir || `browser-data/${profileName}`;

      console.log(`💾 [캐시 최적화] 영구 프로필 모드: ${browserKey}`);
      console.log(`   - 실제 프로필 디렉토리: ${actualUserDataDir}`);
      console.log(`   - Chrome 프로세스 정리 후 프로필 재사용`);

      // Chrome Preferences 정리
      await this.cleanChromeProfile(actualUserDataDir);

      // 특정 프로필의 Chrome 프로세스만 정리
      await this.killSpecificChromeProcesses(actualUserDataDir);
    }

    // 기존 브라우저 재사용 확인 (메모리 내 활성 브라우저만)
    if (this.activeBrowsers.has(browserKey) && !clearSession) {
      const existingBrowser = this.activeBrowsers.get(browserKey);

      if (await this.isBrowserAlive(existingBrowser.browser)) {
        console.log(`🔄 [브라우저 관리] 기존 브라우저 재사용: ${browserKey}`);
        this.browserStats.reused++;
        return existingBrowser;
      } else {
        // 죽은 브라우저 정리
        this.activeBrowsers.delete(browserKey);
        this.browserStats.active--;
      }
    }

    // 새로운 브라우저 생성
    console.log(`🚀 [브라우저 관리] 새 브라우저 생성: ${browserKey}`);

    const browserInfo = await this.launch({
      proxy: proxyConfig,  // 서버 할당 프록시 사용
      profileName,
      clearSession,
      gpuDisabled,
      windowPosition,
      customUserDataDir: userDataDir,
      executablePath,
      stealth
    });

    // 브라우저 정보 저장
    const managedBrowserInfo = {
      ...browserInfo,
      createdAt: new Date(),
      lastUsed: new Date(),
      profileName,
      options
    };

    this.activeBrowsers.set(browserKey, managedBrowserInfo);
    this.browserStats.created++;
    this.browserStats.active++;

    // 브라우저 상태 관리자에 등록 (VPN 모드용)
    try {
      const userDataDirPath = options.userDataDir || '';
      // browser-data/vpn_{동글}/{쓰레드}/{버전} 형식에서 정보 추출
      const vpnMatch = userDataDirPath.match(/vpn_(\d+)[\/\\](\d+)/);
      if (vpnMatch) {
        const vpn = parseInt(vpnMatch[1]);
        const thread = parseInt(vpnMatch[2]);
        browserStateManager.registerBrowser({
          vpn,
          thread,
          pid: process.pid,
          userDataDir: userDataDirPath
        });
      }
    } catch (e) {
      // 상태 관리자 오류는 무시 (핵심 기능 아님)
    }

    return managedBrowserInfo;
  }

  /**
   * 브라우저 키 생성
   */
  generateBrowserKey(options) {
    const {
      proxyConfig,
      profileName = 'default',
      gpuDisabled = false
    } = options;

    const proxyKey = proxyConfig ? proxyConfig.server : 'no-proxy';
    // headless는 항상 false이므로 키에서 제거
    return `${profileName}_${proxyKey}_${gpuDisabled ? 'gpu-off' : 'gpu-on'}`;
  }

  /**
   * 브라우저 생존 확인
   */
  async isBrowserAlive(browser) {
    try {
      if (!browser || !browser.isConnected()) {
        return false;
      }

      const pages = await browser.pages();
      return pages.length >= 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Chrome 프로세스 종료
   */
  async killSpecificChromeProcesses(userDataDir) {
    if (os.platform() !== 'linux') return;

    let killedCount = 0;
    try {
      const { stdout } = await execAsync('pgrep -f chrome || true');
      if (!stdout.trim()) return;

      const pids = stdout.trim().split('\n');
      for (const pid of pids) {
        try {
          const { stdout: cmdline } = await execAsync(`cat /proc/${pid}/cmdline 2>/dev/null || true`);
          if (cmdline.includes(userDataDir)) {
            await execAsync(`kill -9 ${pid} 2>/dev/null || true`);
            console.log(`   ✅ Chrome 프로세스 종료: PID ${pid}`);
            killedCount++;
          }
        } catch (e) {
          // 프로세스가 이미 종료됨
        }
      }

      // 프로세스 종료 후 파일 잠금 해제 대기
      if (killedCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      // pgrep 실패 무시
    }
  }

  /**
   * Chrome 프로필 정리
   * - 쿠키/세션 파일 삭제 (Akamai 쿠키 초기화)
   * - Preferences/Local State 정리
   */
  async cleanChromeProfile(userDataDir) {
    try {
      const defaultPath = path.join(userDataDir, 'Default');

      // 1. 쿠키/세션 관련 파일 삭제 (매 실행 시 새로운 Akamai 세션)
      const filesToDelete = [
        'Cookies',           // 쿠키 DB (Akamai _abck 쿠키 포함)
        'Cookies-journal',   // 쿠키 저널
        'Session Storage',   // 세션 스토리지 (폴더)
        'Local Storage',     // 로컬 스토리지 (폴더)
        'IndexedDB',         // IndexedDB (폴더)
        'Service Worker',    // 서비스 워커 (폴더)
      ];

      for (const file of filesToDelete) {
        const filePath = path.join(defaultPath, file);
        try {
          const stat = await fs.stat(filePath);
          if (stat.isDirectory()) {
            await fs.rm(filePath, { recursive: true, force: true });
          } else {
            await fs.unlink(filePath);
          }
        } catch (e) {
          // 파일이 없으면 무시
        }
      }

      // 2. Preferences 정리
      const prefsPath = path.join(defaultPath, 'Preferences');
      try {
        const prefsData = await fs.readFile(prefsPath, 'utf8');
        const prefs = JSON.parse(prefsData);

        // 복구 관련 설정 제거
        if (prefs.profile) {
          delete prefs.profile.exit_type;
          delete prefs.profile.exited_cleanly;
        }

        // 세션 복구 비활성화
        if (prefs.session) {
          prefs.session.restore_on_startup = 5;  // 새 탭 페이지
          delete prefs.session.startup_urls;
        }

        await fs.writeFile(prefsPath, JSON.stringify(prefs, null, 2));
      } catch (e) {
        // Preferences 파일이 없거나 파싱 실패 - 무시
      }

      // 3. Local State 삭제 (Akamai 핑거프린트 리셋)
      // - client_id, installation_date, entropy_source 등 고유 식별자 포함
      // - 삭제 시 Chrome이 새 값으로 자동 생성
      const localStatePath = path.join(userDataDir, 'Local State');
      try {
        await fs.unlink(localStatePath);
      } catch (e) {
        // 파일이 없으면 무시
      }

      // 4. BrowsingTopicsState 삭제 (HMAC 키 리셋)
      const browsingTopicsPath = path.join(defaultPath, 'BrowsingTopicsState');
      try {
        await fs.unlink(browsingTopicsPath);
      } catch (e) {
        // 파일이 없으면 무시
      }

      // 5. Level 2: History + Trust Tokens 삭제
      const historyFiles = ['History', 'History-journal', 'Trust Tokens', 'Trust Tokens-journal'];
      for (const file of historyFiles) {
        try {
          await fs.unlink(path.join(defaultPath, file));
        } catch (e) { }
      }

      // 6. Level 3: DIPS + Network Action Predictor 삭제
      const level3Files = ['DIPS', 'DIPS-wal', 'DIPS-shm', 'Network Action Predictor', 'Network Action Predictor-journal'];
      for (const file of level3Files) {
        try {
          await fs.unlink(path.join(defaultPath, file));
        } catch (e) { }
      }
    } catch (error) {
      // 전체 프로필 정리 실패 - 무시
    }
  }

  /**
   * 사용자 데이터 디렉토리 경로 생성
   */
  async getUserDataDir(profileName = 'chrome') {
    const platform = os.platform();
    let baseDir;

    if (platform === 'linux') {
      baseDir = path.join(os.homedir(), '.coupang-agent', 'profiles');
    } else if (platform === 'darwin') {
      baseDir = path.join(os.homedir(), 'Library', 'Application Support', 'CoupangAgent', 'profiles');
    } else {
      baseDir = path.join(os.homedir(), 'AppData', 'Local', 'CoupangAgent', 'profiles');
    }

    const profileDir = path.join(baseDir, profileName);

    try {
      await fs.mkdir(profileDir, { recursive: true });
    } catch (e) {
      // 이미 존재하면 무시
    }

    return profileDir;
  }

  /**
   * 랜덤 뷰포트 크기 생성
   */
  getRandomViewportSize(screenWidth = 1920, screenHeight = 1080) {
    const viewports = [
      { width: Math.floor(screenWidth * 0.9), height: Math.floor(screenHeight * 0.85) },
      { width: Math.floor(screenWidth * 0.85), height: Math.floor(screenHeight * 0.8) },
      { width: Math.floor(screenWidth * 0.8), height: Math.floor(screenHeight * 0.75) }
    ];

    return viewports[Math.floor(Math.random() * viewports.length)];
  }

  /**
   * Chrome 실행 인자 생성 (최소 인자만 사용)
   */
  getChromeArgs(options = {}) {
    const { viewport, windowPosition, gpuDisabled } = options;
    // ⚠️ headless 파라미터 무시 - 항상 GUI 모드

    // 최소 인자만 사용 (Chrome 121~142 호환)
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--test-type',
      '--lang=ko-KR',
      '--disable-translate',
      '--disable-popup-blocking',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--no-restore-session-state',  // 이전 세션 창 위치 복원 방지
      '--no-first-run'
    ];

    // 창 위치 설정
    if (windowPosition) {
      args.push(`--window-position=${windowPosition.x},${windowPosition.y}`);

      // windowPosition에 크기가 있으면 우선 사용
      if (windowPosition.width && windowPosition.height) {
        args.push(`--window-size=${windowPosition.width},${windowPosition.height}`);
      } else if (viewport) {
        // 없으면 viewport 사용
        args.push(`--window-size=${viewport.width},${viewport.height}`);
      }
    } else if (viewport) {
      // windowPosition이 없으면 viewport만 사용
      args.push(`--window-size=${viewport.width},${viewport.height}`);
    }

    // GPU 비활성화
    if (gpuDisabled) {
      args.push('--disable-gpu');
    }

    return args;
  }

  /**
   * CDP를 통한 세션 초기화
   */
  async clearSessionWithCDP(page, clearSession = true) {
    if (!clearSession) {
      console.log('🔒 세션 데이터 유지');
      return;
    }

    try {
      const client = await page.context().newCDPSession(page);

      console.log('🧹 세션 초기화 시작...');

      // 1. 쿠키 삭제
      await client.send('Network.clearBrowserCookies');
      console.log('   ✅ 쿠키 삭제 완료');

      // 2. 스토리지 삭제
      await client.send('Storage.clearDataForOrigin', {
        origin: '*',
        storageTypes: 'all'
      });

      // 쿠팡 도메인 스토리지 명시적 삭제
      const coupangOrigins = [
        'https://www.coupang.com',
        'https://coupang.com',
        'https://login.coupang.com',
        'https://m.coupang.com'
      ];

      for (const origin of coupangOrigins) {
        try {
          await client.send('Storage.clearDataForOrigin', {
            origin: origin,
            storageTypes: 'all'
          });
        } catch (e) {
          // 도메인이 아직 방문되지 않았을 수 있음
        }
      }
      console.log('   ✅ 스토리지 삭제 완료');

      // 3. Service Workers 제거
      try {
        const { registrations } = await client.send('ServiceWorker.getRegistrations');
        for (const registration of registrations || []) {
          await client.send('ServiceWorker.unregister', {
            scopeURL: registration.scopeURL
          });
        }
        console.log('   ✅ Service Workers 제거 완료');
      } catch (e) {
        // Service Worker가 없을 수 있음
      }

      // 4. 권한 초기화
      await client.send('Browser.resetPermissions');
      console.log('   ✅ 권한 초기화 완료');

      console.log('🧹 초기화 완료\n');

    } catch (error) {
      console.error('⚠️ CDP 초기화 중 오류:', error.message);
    }
  }

  /**
   * Chrome 브라우저 실행 메소드
   */
  async launch(options = {}) {
    const {
      proxy = null,
      profileName = null,
      clearSession = true,
      gpuDisabled = false,
      windowPosition = null,
      customUserDataDir = null,
      executablePath = null,
      stealth = false
    } = options;

    // ⚠️ HEADLESS 강제 비활성화 - TLS 차단 방지
    const headless = environment.FORCE_HEADLESS_FALSE ? false : false;  // 이중 안전장치
    if (headless === true) {
      throw new Error('⚠️ HEADLESS 모드 감지! Ubuntu에서 TLS 차단됨. 즉시 중단.');
    }

    let browser;
    let page;
    let context;

    console.log('🔧 브라우저 설정:');
    console.log(`   - 세션 초기화: ${clearSession ? '✅ 활성' : '❌ 비활성'}`);

    const proxyConfig = proxy || undefined;

    // 브라우저 창 크기 설정
    let viewport;
    if (windowPosition && windowPosition.width && windowPosition.height) {
      viewport = {
        width: windowPosition.width,
        height: windowPosition.height
      };
    } else {
      viewport = this.getRandomViewportSize(environment.screenWidth, environment.screenHeight);
    }

    // Chrome 실행 인자 생성
    const chromeArgs = this.getChromeArgs({
      viewport,
      windowPosition,
      gpuDisabled
    });

    // 프로필 경로 설정
    const actualProfileName = profileName || 'chrome';
    const userDataDir = customUserDataDir || await this.getUserDataDir(actualProfileName);

    try {
      await fs.mkdir(userDataDir, { recursive: true });
    } catch (e) {
      // 디렉토리가 이미 존재하면 무시
    }

    tsLog(`🚀 Chrome 시작...`);
    tsLog(`📁 프로필 경로: ${userDataDir}`);
    if (executablePath) {
      tsLog(`🎯 Chrome 경로: ${executablePath}`);
    }

    tsLog(`⏳ launchPersistentContext 호출 시작...`);
    const launchStart = Date.now();
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,  // ⚠️ 절대 수정 금지 - TLS 차단
      channel: executablePath ? undefined : 'chrome',  // executablePath 사용시 channel 무시
      executablePath: executablePath || undefined,  // 커스텀 Chrome 경로
      args: chromeArgs,
      viewport: viewport,
      acceptDownloads: true,
      proxy: proxyConfig,
      timeout: 60000  // 브라우저 시작 타임아웃 60초
    });
    tsLog(`✅ launchPersistentContext 완료 (${Date.now() - launchStart}ms)`);

    browser = context.browser();
    tsLog(`📱 browser 객체 획득`);

    // 페이지 가져오기 또는 생성
    const pages = context.pages();
    tsLog(`📄 기존 페이지 수: ${pages.length}`);
    page = pages.length > 0 ? pages[0] : await context.newPage();
    tsLog(`📄 페이지 준비 완료 (URL: ${page.url()})`);

    // 다이얼로그 자동 처리 (핸들러 저장)
    const dialogHandler = async dialog => {
      try {
        console.log(`📢 다이얼로그 감지: ${dialog.type()}`);
        await dialog.dismiss();
      } catch (error) {
        if (!error.message.includes('session closed')) {
          console.error('다이얼로그 처리 오류:', error.message);
        }
      }
    };
    page.on('dialog', dialogHandler);

    // 세션 초기화
    if (clearSession) {
      await this.clearSessionWithCDP(page, true);
    }

    if (proxyConfig) {
      console.log(`🔐 프록시: ${proxyConfig.server}`);
    }

    console.log('✅ Chrome 브라우저 준비 완료\n');

    // cleanup 함수 제공
    const cleanup = () => {
      try {
        page.off('dialog', dialogHandler);
      } catch (e) {
        // 이미 닫힌 경우 무시
      }
    };

    return { browser, page, context, cleanup };
  }

  /**
   * 모든 브라우저 종료
   */
  async shutdown() {
    console.log('🔽 [브라우저 관리] 모든 브라우저 종료 중...');

    const closePromises = [];
    for (const [browserKey, browserInfo] of this.activeBrowsers) {
      closePromises.push(this.closeBrowser(browserKey));
    }

    await Promise.all(closePromises);

    console.log(`📊 [브라우저 통계]`);
    console.log(`   - 생성: ${this.browserStats.created}`);
    console.log(`   - 재사용: ${this.browserStats.reused}`);
    console.log(`   - 종료: ${this.browserStats.closed}`);
    console.log(`   - 활성: ${this.browserStats.active}`);
  }

  /**
   * 특정 브라우저 종료
   */
  async closeBrowser(browserKey) {
    if (!this.activeBrowsers.has(browserKey)) {
      return;
    }

    const browserInfo = this.activeBrowsers.get(browserKey);

    try {
      if (await this.isBrowserAlive(browserInfo.browser)) {
        await browserInfo.browser.close();
        console.log(`🔽 [브라우저 관리] 브라우저 종료: ${browserKey}`);
      }
    } catch (error) {
      console.error(`❌ [브라우저 관리] 브라우저 종료 실패 (${browserKey}):`, error.message);
    } finally {
      // 브라우저 상태 관리자에서 해제 (VPN 모드용)
      try {
        const userDataDirPath = browserInfo.options?.userDataDir || '';
        const vpnMatch = userDataDirPath.match(/vpn_(\d+)[\/\\](\d+)/);
        if (vpnMatch) {
          const vpn = parseInt(vpnMatch[1]);
          const thread = parseInt(vpnMatch[2]);
          browserStateManager.unregisterBrowser({ vpn, thread });
        }
      } catch (e) {
        // 상태 관리자 오류는 무시
      }

      this.activeBrowsers.delete(browserKey);
      this.browserStats.closed++;
      this.browserStats.active--;
    }
  }

  /**
   * /tmp 임시파일 정리
   */
  async cleanTempFiles() {
    if (os.platform() !== 'linux') return;

    try {
      // playwright-artifacts-* 정리 (10분 이상 된 것만)
      const { stdout: playwrightFiles } = await execAsync(
        'find /tmp -maxdepth 1 -name "playwright-artifacts-*" -type d -mmin +10 2>/dev/null || true'
      );

      if (playwrightFiles.trim()) {
        const files = playwrightFiles.trim().split('\n');
        for (const file of files) {
          if (file) {
            await execAsync(`rm -rf "${file}" 2>/dev/null || true`);
          }
        }
        console.log(`🧹 /tmp playwright 임시파일 ${files.length}개 정리`);
      }

      // .com.google.Chrome.* 정리 (10분 이상 된 것만)
      const { stdout: chromeFiles } = await execAsync(
        'find /tmp -maxdepth 1 -name ".com.google.Chrome.*" -type d -mmin +10 2>/dev/null || true'
      );

      if (chromeFiles.trim()) {
        const files = chromeFiles.trim().split('\n');
        for (const file of files) {
          if (file) {
            await execAsync(`rm -rf "${file}" 2>/dev/null || true`);
          }
        }
        console.log(`🧹 /tmp Chrome 임시파일 ${files.length}개 정리`);
      }
    } catch (error) {
      // 정리 실패 무시
    }
  }
}

// =====================================================
// 하위 호환성을 위한 함수형 래퍼
// =====================================================

/**
 * Chrome 브라우저 실행 함수 (하위 호환성)
 */
async function launchChrome(proxy = null, usePersistent = true, profileName = null, clearSession = true, headless = false, gpuDisabled = false, windowPosition = null, trafficMonitor = false, customUserDataDir = null) {
  // ⚠️ headless 파라미터는 무시됨 - 항상 false 사용
  const browserCore = new BrowserCore();
  return await browserCore.launch({
    proxy,
    profileName,
    clearSession,
    headless: false,  // ⚠️ 강제 false - 절대 수정 금지
    gpuDisabled,
    windowPosition,
    customUserDataDir
  });
}

// BrowserManager 싱글톤 인스턴스 (하위 호환성)
const browserManager = new BrowserCore();

// =====================================================
// 모듈 Export
// =====================================================

module.exports = {
  // 클래스 export (상속용)
  BrowserCore,

  // BrowserManager 싱글톤 (하위 호환성)
  browserManager,

  // 하위 호환성을 위한 함수들
  launchChrome,

  // 헬퍼 함수들 (필요시 개별 사용)
  getUserDataDir: async (profileName) => {
    const core = new BrowserCore();
    return await core.getUserDataDir(profileName);
  },
  getRandomViewportSize: (screenWidth, screenHeight) => {
    const core = new BrowserCore();
    return core.getRandomViewportSize(screenWidth, screenHeight);
  },
  getChromeArgs: (options) => {
    const core = new BrowserCore();
    return core.getChromeArgs(options);
  },
  clearSessionWithCDP: async (page, clearSession) => {
    const core = new BrowserCore();
    return await core.clearSessionWithCDP(page, clearSession);
  }
};