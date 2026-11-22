// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { MockUSDC } from "../../src/MockUSDC.sol";
import { MockPool } from "../../src/MockPool.sol";
import { QueueVault } from "../../src/QueueVault.sol";
import { Handler } from "./Handler.sol";

/// @notice 方案文档第 10.3 节的不变量清单 I1–I12
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 100
/// forge-config: default.invariant.fail-on-revert = true
contract QueueInvariantTest is Test {
    uint256 internal constant USDC = 1e6;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    MockUSDC internal usdc;
    MockPool internal pool;
    QueueVault internal vault;
    Handler internal handler;
    address internal competitor = makeAddr("competitor");

    function setUp() public {
        vm.warp(1_700_000_000);
        address borrower = makeAddr("borrower");
        usdc = new MockUSDC();
        pool = new MockPool(usdc, 800);
        pool.setBorrower(borrower);
        vault = new QueueVault(usdc, IERC4626(address(pool)), 1 * USDC, 500);

        usdc.mint(address(this), 2 * USDC);
        usdc.approve(address(pool), 1 * USDC);
        pool.deposit(1 * USDC, DEAD);
        usdc.approve(address(vault), 1 * USDC);
        vault.deposit(1 * USDC, DEAD);

        handler = new Handler(usdc, pool, vault, borrower, competitor);
        vault.transferOwnership(address(handler));
        targetContract(address(handler));
    }

    function _cash() internal view returns (uint256) {
        return usdc.balanceOf(address(vault));
    }

    /// I1 偿付能力：金库资产（现金 + 池中持仓）覆盖排队负债和待领余额
    function invariant_I1_solvency() public view {
        assertGe(_cash() + vault.poolPosition(), vault.totalQueuedAssets() + vault.totalClaimable());
    }

    /// I2 已确认待领的钱一定在金库里
    function invariant_I2_claimableBacked() public view {
        assertGe(_cash(), vault.totalClaimable());
    }

    /// I3 队列账目一致：totalQueuedAssets = Σ remaining，i ∈ [head, tail)
    /// I5 严格 FIFO：head 之前全部付清，head 之后完全未动
    /// I6 不多付也不少付：每个请求累计付款 + remaining = assetsTotal
    function invariant_I3_I5_I6_queueAccounting() public view {
        uint256 head = vault.head();
        uint256 tail = vault.tail();
        uint256 sum;
        for (uint256 id = 1; id < tail; ++id) {
            QueueVault.RedeemRequest memory r = vault.getRequest(id);
            assertEq(handler.ghostPaid(id) + r.assetsRemaining, r.assetsTotal, "I6 paid + remaining == total");
            if (id < head) assertEq(r.assetsRemaining, 0, "I5 settled before head");
            if (id > head) assertEq(r.assetsRemaining, r.assetsTotal, "I5 untouched after head");
            if (id >= head) sum += r.assetsRemaining;
        }
        assertEq(vault.totalQueuedAssets(), sum, "I3");
    }

    /// I4 head ≤ tail 且 head 单调不减
    function invariant_I4_pointers() public view {
        assertLe(vault.head(), vault.tail());
        assertEq(handler.headViolations(), 0);
    }

    /// I7 pull 账目一致（参与者只有 3 个用户）
    function invariant_I7_claimableSum() public view {
        uint256 sum;
        for (uint256 i; i < handler.actorCount(); ++i) {
            sum += vault.claimable(handler.actors(i));
        }
        assertEq(sum, vault.totalClaimable());
    }

    /// I8 任何动作后金库 PPS 不下降（允许 1e-9 相对误差）
    function invariant_I8_ppsNeverDrops() public view {
        assertEq(handler.ppsViolations(), 0);
    }

    /// I9 settleQueue 在任何状态下都不 revert
    function invariant_I9_settleNeverReverts() public view {
        assertEq(handler.settleReverts(), 0);
    }

    /// I10 即时提款不会挪用排队资金
    function invariant_I10_instantCashExcludesQueue() public view {
        uint256 liabilities = vault.totalQueuedAssets() + vault.totalClaimable();
        uint256 expected = _cash() > liabilities ? _cash() - liabilities : 0;
        assertLe(vault.instantCash(), expected);
    }

    /// I11 单次取回不超过调用前的缺口
    function invariant_I11_recallBounded() public view {
        assertEq(handler.recallViolations(), 0);
    }

    /// I12 池子自身账目：所有存款人可赎回资产之和不超过池子总资产
    function invariant_I12_poolAccounting() public view {
        uint256 sum = pool.previewRedeem(pool.balanceOf(address(vault))) + pool.previewRedeem(pool.balanceOf(competitor))
            + pool.previewRedeem(pool.balanceOf(DEAD));
        assertLe(sum, pool.totalAssets());
    }

    function afterInvariant() public view {
        // 便于在 -vv 下看到各动作被调用了多少次，确认 handler 没有「空转」
        handler.calls("settle");
    }
}
