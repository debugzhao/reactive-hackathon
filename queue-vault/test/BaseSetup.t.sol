// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { MockUSDC } from "../src/MockUSDC.sol";
import { MockPool } from "../src/MockPool.sol";
import { QueueVault } from "../src/QueueVault.sol";

/// @dev 共享夹具：和部署脚本相同的拓扑——金库 + 共享池 + 借款人 + 对手
abstract contract BaseSetup is Test {
    uint256 internal constant USDC = 1e6;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    MockUSDC internal usdc;
    MockPool internal pool;
    QueueVault internal vault;

    address internal borrower = makeAddr("borrower");
    address internal competitor = makeAddr("competitor");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        pool = new MockPool(usdc, 800);
        pool.setBorrower(borrower);
        vault = new QueueVault(usdc, IERC4626(address(pool)), 1 * USDC, 500);

        // 种子存款：份额给 0xdEaD，让首次存款不发生在空金库上（防通胀攻击的第二层）
        _seed(address(pool));
        _seed(address(vault));
    }

    function _seed(address v) internal {
        usdc.mint(address(this), 1 * USDC);
        usdc.approve(v, 1 * USDC);
        IERC4626(v).deposit(1 * USDC, DEAD);
    }

    function _depositVault(address user, uint256 assets) internal returns (uint256 shares) {
        usdc.mint(user, assets);
        vm.startPrank(user);
        usdc.approve(address(vault), assets);
        shares = vault.deposit(assets, user);
        vm.stopPrank();
    }

    function _depositPool(address user, uint256 assets) internal {
        usdc.mint(user, assets);
        vm.startPrank(user);
        usdc.approve(address(pool), assets);
        pool.deposit(assets, user);
        vm.stopPrank();
    }

    /// @dev 演示状态：金库 10,000（配置 9,500 到池子，留约 500 缓冲），对手 9,500，借款人借空池子
    function _setupUtilized() internal {
        _depositVault(alice, 4_000 * USDC);
        _depositVault(bob, 3_000 * USDC);
        _depositVault(carol, 3_000 * USDC);
        vault.allocate(9_500 * USDC);
        _depositPool(competitor, 9_500 * USDC);
        uint256 liq = pool.liquidity(); // 先算好：vm.prank 只作用于下一次外部调用
        vm.prank(borrower);
        pool.borrow(liq);
    }

    function _repay(uint256 amount) internal {
        usdc.mint(borrower, amount);
        vm.startPrank(borrower);
        usdc.approve(address(pool), amount);
        pool.repay(amount);
        vm.stopPrank();
    }

    function _request(address user, uint256 assets) internal returns (uint256 id) {
        uint256 shares = vault.previewWithdraw(assets);
        vm.prank(user);
        id = vault.requestRedeem(shares, user, user);
    }

    /// @dev 单位份额价格（1e12 份额对应的资产），用于检查 PPS 不下降
    function _pps() internal view returns (uint256) {
        return vault.convertToAssets(1e12);
    }
}
