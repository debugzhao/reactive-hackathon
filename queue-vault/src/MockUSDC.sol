// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC — 测试网专用的 6 位小数稳定币
/// @notice mint 不设权限：借款人用它补足利息、演示脚本用它给账户发币。仅限测试网。
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
