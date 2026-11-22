// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { BaseSetup } from "./BaseSetup.t.sol";
import { MockUSDC } from "../src/MockUSDC.sol";
import { MockPool } from "../src/MockPool.sol";
import { QueueVault } from "../src/QueueVault.sol";

/// @dev 可以拉黑接收者的代币，用来测试「坏接收者不能卡住队列」
contract BlacklistUSDC is MockUSDC {
    mapping(address => bool) public blocked;

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, value);
    }
}

contract QueueVaultTest is BaseSetup {
    // ───────────── ERC4626 基础与舍入 ─────────────

    function test_depositUsesDecimalsOffset() public {
        uint256 shares = _depositVault(alice, 100 * USDC);
        // offset = 6：1 USDC（1e6）≈ 1e12 份额
        assertApproxEqRel(shares, 100 * USDC * 1e6, 1e12);
    }

    function testFuzz_depositThenRedeemNeverProfits(uint256 assets) public {
        assets = bound(assets, 1, 1e15);
        uint256 shares = _depositVault(alice, assets);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertLe(out, assets, "rounding must favor the vault");
    }

    function test_inflationAttackIsUnprofitable() public {
        // 不做种子存款的新金库，模拟最坏情况
        QueueVault fresh = new QueueVault(usdc, IERC4626(address(pool)), 1 * USDC, 500);
        address attacker = makeAddr("attacker");
        usdc.mint(attacker, 10_000 * USDC + 1);
        vm.startPrank(attacker);
        usdc.approve(address(fresh), 1);
        fresh.deposit(1, attacker);
        usdc.transfer(address(fresh), 10_000 * USDC); // 捐赠抬高 PPS
        vm.stopPrank();

        usdc.mint(alice, 10_000 * USDC);
        vm.startPrank(alice);
        usdc.approve(address(fresh), 10_000 * USDC);
        uint256 shares = fresh.deposit(10_000 * USDC, alice);
        vm.stopPrank();

        assertGt(shares, 0, "victim must get shares");
        // 受害者的资产价值几乎无损（误差 < 0.01%）
        assertApproxEqRel(fresh.previewRedeem(shares), 10_000 * USDC, 1e14);
    }

    // ───────────── 排队 ─────────────

    function test_requestRedeem_burnsSharesAndLocksAssets() public {
        _setupUtilized();
        uint256 sharesBefore = vault.balanceOf(alice);
        uint256 id = _request(alice, 2_000 * USDC);

        QueueVault.RedeemRequest memory r = vault.getRequest(id);
        assertEq(r.owner, alice);
        assertGe(r.assetsTotal, 2_000 * USDC);
        assertEq(r.assetsRemaining, r.assetsTotal);
        assertLt(vault.balanceOf(alice), sharesBefore);
        assertEq(vault.totalQueuedAssets(), r.assetsTotal);
        assertEq(vault.pendingCount(), 1);
    }

    function testFuzz_requestRedeemNeverLowersPPS(uint256 assets) public {
        _setupUtilized();
        assets = bound(assets, 1 * USDC, 3_900 * USDC);
        uint256 before = _pps();
        _request(alice, assets);
        assertGe(_pps(), before, "queueing must not hurt remaining holders");
    }

    function test_requestTooSmallReverts() public {
        _depositVault(alice, 100 * USDC);
        uint256 shares = vault.previewWithdraw(USDC / 2);
        vm.prank(alice);
        vm.expectRevert();
        vault.requestRedeem(shares, alice, alice);
    }

    function test_requestRedeemByOperatorNeedsAllowance() public {
        _depositVault(alice, 100 * USDC);
        uint256 shares = vault.previewWithdraw(10 * USDC);
        vm.prank(bob);
        vm.expectRevert();
        vault.requestRedeem(shares, bob, alice);

        vm.prank(alice);
        vault.approve(bob, shares);
        vm.prank(bob);
        vault.requestRedeem(shares, bob, alice);
        assertEq(vault.getRequest(1).receiver, bob);
    }

    function test_instantWithdrawCannotJumpTheQueue() public {
        _setupUtilized();
        _request(alice, 2_000 * USDC);
        // 缓冲约 500，全部被排队负债占用
        assertEq(vault.instantCash(), 0);
        assertEq(vault.maxWithdraw(bob), 0);
        assertEq(vault.maxRedeem(bob), 0);
    }

    // ───────────── 兑付 ─────────────

    function test_settle_paysBufferPartiallyThenRecallsAfterRepay() public {
        _setupUtilized();
        uint256 idA = _request(alice, 2_000 * USDC);
        uint256 idB = _request(bob, 1_000 * USDC);
        uint256 aliceBefore = usdc.balanceOf(alice);

        // 第一次：只有约 501 的缓冲，部分兑付 Alice
        (uint256 recalled, uint256 processed, uint256 paid) = vault.settleQueue(10);
        assertEq(recalled, 0, "pool has no liquidity yet");
        assertEq(processed, 1);
        assertApproxEqAbs(paid, 501 * USDC, 1 * USDC);
        assertEq(vault.head(), idA, "Alice still at head, partially paid");

        // 借款人还款 2,500，池子出现流动性
        _repay(2_500 * USDC);
        (recalled, processed, paid) = vault.settleQueue(10);
        uint256 shortfall = vault.getRequest(idA).assetsTotal + vault.getRequest(idB).assetsTotal - 501 * USDC;
        assertApproxEqAbs(recalled, shortfall, 2 * USDC);
        assertEq(processed, 2);
        assertEq(vault.head(), idB + 1, "queue drained");
        assertEq(vault.totalQueuedAssets(), 0);
        assertEq(usdc.balanceOf(alice) - aliceBefore, vault.getRequest(idA).assetsTotal);
        assertEq(vault.getRequest(idB).assetsRemaining, 0);
    }

    function test_settle_competitorFirst_recallsNothingWithoutRevert() public {
        _setupUtilized();
        _request(alice, 2_000 * USDC);
        vault.settleQueue(10); // 先用掉缓冲

        _repay(2_000 * USDC);
        vm.prank(competitor);
        pool.withdraw(2_000 * USDC, competitor, competitor); // 对手抢先

        (uint256 recalled, uint256 processed,) = vault.settleQueue(10);
        assertEq(recalled, 0);
        assertEq(processed, 0);
        assertEq(vault.pendingCount(), 1, "Alice keeps waiting");
    }

    function test_settle_noWorkDoesNotRevert() public {
        (uint256 recalled, uint256 processed, uint256 paid) = vault.settleQueue(10);
        assertEq(recalled + processed + paid, 0);
    }

    function test_settle_recallsWholeShortfallButPaysAtMostMaxCount() public {
        _setupUtilized();
        for (uint256 i; i < 5; ++i) {
            _request(alice, 200 * USDC);
        }
        vault.settleQueue(10); // 用掉缓冲
        _repay(5_000 * USDC);

        (uint256 recalled, uint256 processed,) = vault.settleQueue(2);
        assertGt(recalled, 0);
        assertEq(processed, 2, "payouts capped by maxCount");
        assertEq(vault.totalQueuedAssets() <= vault.queueCash(), true, "whole shortfall already recalled");

        // 下一轮不需要再取回，只继续兑付
        (recalled, processed,) = vault.settleQueue(10);
        assertEq(recalled, 0);
        assertEq(vault.pendingCount(), 0);
    }

    function test_settle_isIdempotent() public {
        _setupUtilized();
        _request(alice, 300 * USDC);
        vault.settleQueue(10);
        uint256 bal = usdc.balanceOf(alice);
        vault.settleQueue(10);
        vault.settleQueue(10);
        assertEq(usdc.balanceOf(alice), bal, "never pays twice");
    }

    function test_settle_neverPaysMoreThanLocked() public {
        _setupUtilized();
        uint256 id = _request(alice, 2_000 * USDC);
        uint256 locked = vault.getRequest(id).assetsTotal;
        uint256 before = usdc.balanceOf(alice);
        vault.settleQueue(10);
        _repay(9_000 * USDC);
        vault.settleQueue(10);
        assertEq(usdc.balanceOf(alice) - before, locked);
    }

    function test_settle_badReceiverMovesToClaimable() public {
        BlacklistUSDC token = new BlacklistUSDC();
        MockPool p = new MockPool(token, 800);
        QueueVault v = new QueueVault(token, IERC4626(address(p)), 1 * USDC, 500);
        token.mint(alice, 1_000 * USDC);
        vm.startPrank(alice);
        token.approve(address(v), 1_000 * USDC);
        uint256 shares = v.deposit(1_000 * USDC, alice);
        uint256 id = v.requestRedeem(shares / 2, alice, alice);
        vm.stopPrank();

        token.setBlocked(alice, true);
        (, uint256 processed,) = v.settleQueue(10);
        assertEq(processed, 1, "queue still advances");
        uint256 owedAmount = v.getRequest(id).assetsTotal;
        assertEq(v.claimable(alice), owedAmount);
        assertEq(v.totalClaimable(), owedAmount);

        token.setBlocked(alice, false);
        vm.prank(alice);
        v.claim();
        assertEq(v.totalClaimable(), 0);
        assertEq(token.balanceOf(alice), owedAmount);
    }

    // ───────────── 管理人 ─────────────

    function test_allocateRespectsBuffer() public {
        _depositVault(alice, 1_000 * USDC);
        vm.expectRevert();
        vault.allocate(990 * USDC); // 超过 95%
        vault.allocate(900 * USDC);
    }

    function test_allocateBlockedWhileQueueNonEmpty() public {
        _setupUtilized();
        _request(alice, 2_000 * USDC);
        vm.expectRevert();
        vault.allocate(1 * USDC);
    }

    function test_onlyOwnerCanAllocate() public {
        _depositVault(alice, 1_000 * USDC);
        vm.prank(alice);
        vm.expectRevert();
        vault.allocate(100 * USDC);
    }

    // ───────────── 账目 ─────────────

    function test_solvencyAfterFullCycle() public {
        _setupUtilized();
        _request(alice, 2_000 * USDC);
        _request(bob, 1_000 * USDC);
        vault.settleQueue(10);
        vm.warp(block.timestamp + 7 days);
        _repay(1_000 * USDC);
        vault.settleQueue(10);
        assertGe(
            usdc.balanceOf(address(vault)) + vault.poolPosition(),
            vault.totalQueuedAssets() + vault.totalClaimable(),
            "assets cover liabilities"
        );
    }
}
