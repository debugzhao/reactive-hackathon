// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { MockUSDC } from "../../src/MockUSDC.sol";
import { MockPool } from "../../src/MockPool.sol";
import { QueueVault } from "../../src/QueueVault.sol";

/// @dev 不变量测试的动作集合：存款、排队、即时赎回、配置、借款、还款、对手抢流动性、结算、捐赠、时间推进。
///      所有「过程中」才能检查的性质（PPS 不降、settle 不 revert、取回不超过缺口、head 单调）
///      在动作里检查并记入违规计数，由不变量函数断言计数为 0。
contract Handler is Test {
    uint256 internal constant USDC = 1e6;
    bytes32 internal constant SETTLED_SIG = keccak256("RedeemSettled(uint256,address,uint256,uint256,bool)");

    MockUSDC public usdc;
    MockPool public pool;
    QueueVault public vault;
    address public borrower;
    address public competitor;
    address[] public actors;

    // ── ghost 变量 ──
    mapping(uint256 id => uint256) public ghostPaid;
    uint256 public lastHead;
    uint256 public lastPps;
    uint256 public ppsViolations;
    uint256 public settleReverts;
    uint256 public recallViolations;
    uint256 public headViolations;
    mapping(bytes32 => uint256) public calls;

    constructor(MockUSDC usdc_, MockPool pool_, QueueVault vault_, address borrower_, address competitor_) {
        usdc = usdc_;
        pool = pool_;
        vault = vault_;
        borrower = borrower_;
        competitor = competitor_;
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
        lastHead = vault.head();
        lastPps = _pps();
    }

    modifier track(bytes32 name) {
        calls[name]++;
        _;
        _checkPps();
        _checkHead();
    }

    // ───────────── 用户 ─────────────

    function deposit(uint256 actorSeed, uint256 assets) external track("deposit") {
        address a = _actor(actorSeed);
        assets = bound(assets, 1 * USDC, 50_000 * USDC);
        usdc.mint(a, assets);
        vm.startPrank(a);
        usdc.approve(address(vault), assets);
        vault.deposit(assets, a);
        vm.stopPrank();
    }

    function requestRedeem(uint256 actorSeed, uint256 pct) external track("requestRedeem") {
        address a = _actor(actorSeed);
        uint256 shares = vault.balanceOf(a) * bound(pct, 1, 100) / 100;
        if (shares == 0 || vault.previewRedeem(shares) < vault.MIN_REQUEST_ASSETS()) return;
        vm.prank(a);
        vault.requestRedeem(shares, a, a);
    }

    function instantRedeem(uint256 actorSeed, uint256 pct) external track("instantRedeem") {
        address a = _actor(actorSeed);
        uint256 shares = vault.maxRedeem(a) * bound(pct, 1, 100) / 100;
        if (shares == 0 || vault.previewRedeem(shares) == 0) return;
        vm.prank(a);
        vault.redeem(shares, a, a);
    }

    // ───────────── 管理人 / 借款人 / 对手 ─────────────

    function allocate(uint256 pct) external track("allocate") {
        uint256 floor = vault.totalAssets() * vault.BUFFER_BPS() / 10_000;
        uint256 ic = vault.instantCash();
        if (ic <= floor) return;
        uint256 amount = (ic - floor) * bound(pct, 1, 100) / 100;
        if (amount == 0) return;
        vault.allocate(amount); // handler 是金库 owner
    }

    function borrow(uint256 pct) external track("borrow") {
        uint256 amount = pool.liquidity() * bound(pct, 1, 100) / 100;
        if (amount == 0) return;
        vm.prank(borrower);
        pool.borrow(amount);
    }

    function repay(uint256 pct) external track("repay") {
        // 先结一次利息，拿到准确的债务上限
        uint256 debt = pool.owed();
        uint256 amount = debt * bound(pct, 1, 100) / 100;
        if (amount == 0) return;
        usdc.mint(borrower, amount);
        vm.startPrank(borrower);
        usdc.approve(address(pool), amount);
        pool.repay(amount);
        vm.stopPrank();
    }

    function competitorSupply(uint256 assets) external track("competitorSupply") {
        assets = bound(assets, 1 * USDC, 50_000 * USDC);
        usdc.mint(competitor, assets);
        vm.startPrank(competitor);
        usdc.approve(address(pool), assets);
        pool.deposit(assets, competitor);
        vm.stopPrank();
    }

    function competitorGrab() external track("competitorGrab") {
        uint256 amount = pool.maxWithdraw(competitor);
        if (amount == 0) return;
        vm.prank(competitor);
        pool.withdraw(amount, competitor, competitor);
    }

    // ───────────── 结算（任何人） ─────────────

    function settle(uint256 maxCount) external track("settle") {
        maxCount = bound(maxCount, 0, 60);
        uint256 qc = vault.queueCash();
        uint256 queued = vault.totalQueuedAssets();
        uint256 shortfall = queued > qc ? queued - qc : 0;

        vm.recordLogs();
        try vault.settleQueue(maxCount) returns (uint256 recalled, uint256, uint256) {
            if (recalled > shortfall) recallViolations++;
        } catch {
            settleReverts++;
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == SETTLED_SIG) {
                (uint256 paid,,) = abi.decode(logs[i].data, (uint256, uint256, bool));
                ghostPaid[uint256(logs[i].topics[1])] += paid;
            }
        }
    }

    function donate(uint256 assets) external track("donate") {
        assets = bound(assets, 1, 10_000 * USDC);
        usdc.mint(address(vault), assets);
    }

    function warp(uint256 secs) external track("warp") {
        vm.warp(block.timestamp + bound(secs, 1, 30 days));
    }

    // ───────────── 内部 ─────────────

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    /// @dev 1e18 份额对应的资产
    function _pps() internal view returns (uint256) {
        return vault.convertToAssets(1e18);
    }

    /// @dev 允许的下降 = 「金库总资产损失 2 wei」折算到 PPS 上。
    ///      来源：金库把现金存进池子（池子铸份额 Floor）或从池子取回（池子烧份额 Ceil），
    ///      再按 previewRedeem（Floor）估值，ERC4626 嵌套 ERC4626 必然有 1–2 wei 舍入尘埃。
    ///      不变量测试最初用 1e-9 相对容差，在「金库几乎为空 + 池子已计息」时被这 1–2 wei 触发，故改为绝对口径。
    function _checkPps() internal {
        uint256 p = _pps();
        uint256 ta = vault.totalAssets();
        uint256 tolerance = (ta == 0 ? lastPps : lastPps * 2 / ta) + 1;
        if (p + tolerance < lastPps) ppsViolations++;
        lastPps = p;
    }

    function _checkHead() internal {
        uint256 h = vault.head();
        if (h < lastHead) headViolations++;
        lastHead = h;
    }
}
