/**
 * VPN 모듈 - lib/vpn/
 *
 * WireGuard VPN과 네트워크 네임스페이스 관리를 위한 모듈입니다.
 *
 * 구성:
 * - WireGuardHelper: 네임스페이스/WireGuard 설정 관리
 * - TogglePolicy: VPN 토글 조건 중앙 관리
 *
 * 사용법:
 *   const { WireGuardHelper, TogglePolicy, ToggleReason } = require('./lib/vpn');
 *
 *   // WireGuard 설정
 *   const wgHelper = new WireGuardHelper({ debug: true });
 *   wgHelper.setupNamespace('ns-001', 'wg-16', config, 'agent-01');
 *
 *   // 토글 정책
 *   const policy = new TogglePolicy();
 *   const { toggle, reason } = policy.shouldToggle({ score: -3 });
 */

const WireGuardHelper = require('./WireGuardHelper');
const { TogglePolicy, ToggleReason } = require('./TogglePolicy');

module.exports = {
  WireGuardHelper,
  TogglePolicy,
  ToggleReason,
};
