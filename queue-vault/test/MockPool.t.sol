// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { BaseSetup } from "./BaseSetup.t.sol";
import { MockPool } from "../src/MockPool.sol";

contract MockPoolTest is BaseSetup {
    function test_setBorrowerOnlyOnce() public {
        vm.expectRevert(MockPool.BorrowerAlreadySet.selector);
        pool.setBorrower(alice);
    }

    function test_onlyBorrowerCanBorrow() public {
        _depositPool(competitor, 100 * USDC);
        vm.prank(alice);
        vm.expectRevert(MockPool.NotBorrower.selector);
        pool.borrow(1 * USDC);
    }

    function test_interestAccruesLinearlyByTimestamp() public {
        _depositPool(competitor, 10_000 * USDC);
        vm.prank(borrower);
        pool.borrow(10_000 * USDC);
        vm.warp(block.timestamp + 365 days);
        // 8% APR → 一年后欠 10,800
        assertEq(pool.owed(), 10_800 * USDC);
    }

    function test_repayKeepsSharePrice() public {
        _depositPool(competitor, 10_000 * USDC);
        vm.prank(borrower);
        pool.borrow(10_000 * USDC);
        vm.warp(block.timestamp + 30 days);
        uint256 before = pool.convertToAssets(1e12);
        _repay(2_000 * USDC);
        assertApproxEqAbs(pool.convertToAssets(1e12), before, 1, "repay must not move PPS");
    }

    function test_repayExceedingDebtReverts() public {
        _depositPool(competitor, 100 * USDC);
        vm.prank(borrower);
        pool.borrow(100 * USDC);
        usdc.mint(borrower, 200 * USDC);
        vm.startPrank(borrower);
        usdc.approve(address(pool), 200 * USDC);
        vm.expectRevert();
        pool.repay(200 * USDC);
        vm.stopPrank();
    }

    function test_withdrawLimitedByLiquidity_firstComeFirstServed() public {
        _setupUtilized();
        assertEq(pool.maxWithdraw(competitor), 0, "fully utilized");

        _repay(2_000 * USDC);
        assertEq(pool.maxWithdraw(competitor), 2_000 * USDC);
        assertEq(pool.maxWithdraw(address(vault)), 2_000 * USDC);

        // 对手先到，拿走全部流动性
        vm.prank(competitor);
        pool.withdraw(2_000 * USDC, competitor, competitor);
        assertEq(pool.maxWithdraw(address(vault)), 0, "vault came too late");
    }

    function test_repayEmitsAvailableLiquidity() public {
        _setupUtilized();
        uint256 liqBefore = pool.liquidity();
        usdc.mint(borrower, 2_500 * USDC);
        vm.startPrank(borrower);
        usdc.approve(address(pool), 2_500 * USDC);
        vm.expectEmit(true, false, false, true, address(pool));
        emit MockPool.Repaid(borrower, 2_500 * USDC, liqBefore + 2_500 * USDC, uint64(block.timestamp));
        pool.repay(2_500 * USDC);
        vm.stopPrank();
    }
}
