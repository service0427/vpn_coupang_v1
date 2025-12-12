/**
 * VPN 모듈 - lib/vpn/
 *
 * WireGuard VPN과 네트워크 네임스페이스 관리를 위한 모듈입니다.
 *
 * 구성:
 * - WireGuardHelper: 네임스페이스/WireGuard 설정 관리
 * - TogglePolicy: VPN 토글 조건 중앙 관리
 * - VpnManager: VPN 연결 상태 관리 (동글 할당/반납, 연결/재연결)
 * - VpnAgent: 작업 실행 에이전트 (배치 사이클, 독립 루프)
 *
 * 사용법:
 *   const { WireGuardHelper, TogglePolicy, VpnManager, VpnAgent } = require('./lib/vpn');
 *
 *   // VPN 연결 관리
 *   const manager = new VpnManager({ agentId, dongleAllocator, wgHelper, logger });
 *   await manager.connect();
 *
 *   // 작업 실행
 *   const agent = new VpnAgent(manager, { vpnIndex, maxThreads, onceMode, logger });
 *   await agent.runIndependentLoop();
 */

const WireGuardHelper = require('./WireGuardHelper');
const { TogglePolicy, ToggleReason } = require('./TogglePolicy');
const VpnManager = require('./VpnManager');
const VpnAgent = require('./VpnAgent');
const VpnLogger = require('./VpnLogger');

module.exports = {
  WireGuardHelper,
  TogglePolicy,
  ToggleReason,
  VpnManager,
  VpnAgent,
  VpnLogger,
};
