/**
 * browser-data 자동 정리 유틸리티
 * - 현재 프로필 폴더 내 3일 초과된 파일만 삭제 (폴더 구조 유지)
 * - shared-cache 내 오래된 파일 정리
 *
 * 24시간 무한 구동 환경에 최적화 — 각 사이클에서 프로필 셋업 시 호출
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_AGE_DAYS = 3;

/**
 * 현재 프로필 폴더 내 오래된 파일 정리
 * 폴더 구조는 유지하고, 3일 초과된 파일만 삭제
 *
 * @param {string} profilePath - 프로필 경로 (예: browser-data/vpn_01/01/137)
 * @param {Object} options
 * @param {number} options.maxAgeDays - 보관 기간 (일), 기본 3일
 */
function cleanOldFiles(profilePath, options = {}) {
    const maxAgeDays = options.maxAgeDays || DEFAULT_MAX_AGE_DAYS;
    const cutoffTime = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

    if (!profilePath || !fs.existsSync(profilePath)) return;

    // 1. 현재 프로필 폴더 내 오래된 파일 삭제
    const profileCleaned = cleanFilesRecursive(profilePath, cutoffTime);
    if (profileCleaned > 0) {
        console.log(`   🧹 프로필 정리: ${profileCleaned}개 오래된 파일 삭제`);
    }

    // 2. 형제 프로필 폴더들도 파일 정리 (폴더 구조 유지)
    const parentDir = path.dirname(profilePath);
    const currentBaseName = path.basename(profilePath);

    if (fs.existsSync(parentDir)) {
        try {
            const entries = fs.readdirSync(parentDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === currentBaseName) continue;
                if (!entry.isDirectory()) continue;

                const siblingPath = path.join(parentDir, entry.name);
                const siblingCleaned = cleanFilesRecursive(siblingPath, cutoffTime);
                if (siblingCleaned > 0) {
                    console.log(`   🧹 형제 프로필 정리: ${entry.name} (${siblingCleaned}개 파일)`);
                }
            }
        } catch (e) {
            // 무시
        }
    }

    // 3. shared-cache 오래된 파일 정리
    cleanSharedCacheFiles(profilePath, cutoffTime);
}

/**
 * shared-cache 내 오래된 파일 정리 (디렉토리 구조 유지)
 */
function cleanSharedCacheFiles(profilePath, cutoffTime) {
    // browser-data 루트 찾기
    let dir = profilePath;
    while (dir && path.basename(dir) !== 'browser-data') {
        const parent = path.dirname(dir);
        if (parent === dir) return;
        dir = parent;
    }
    if (path.basename(dir) !== 'browser-data') return;

    const sharedCachePath = path.join(dir, 'shared-cache');
    if (!fs.existsSync(sharedCachePath)) return;

    const cleaned = cleanFilesRecursive(sharedCachePath, cutoffTime);
    if (cleaned > 0) {
        console.log(`   🔗 shared-cache 정리: ${cleaned}개 오래된 파일 삭제`);
    }
}

/**
 * 재귀적으로 오래된 파일 삭제 (디렉토리 구조 유지, 파일만 삭제)
 */
function cleanFilesRecursive(dirPath, cutoffTime) {
    let cleaned = 0;

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            try {
                if (entry.isSymbolicLink()) {
                    // 심볼릭 링크는 건드리지 않음
                    continue;
                } else if (entry.isDirectory()) {
                    cleaned += cleanFilesRecursive(entryPath, cutoffTime);
                } else if (entry.isFile()) {
                    const stat = fs.statSync(entryPath);
                    if (stat.mtimeMs < cutoffTime) {
                        fs.unlinkSync(entryPath);
                        cleaned++;
                    }
                }
            } catch (e) {
                // 개별 항목 오류 무시
            }
        }
    } catch (e) {
        // 디렉토리 접근 오류 무시
    }

    return cleaned;
}

module.exports = { cleanOldFiles };
