// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice QueueSettler 调用金库所需的最小接口
interface IQueueVault {
    function settleQueue(uint256 maxCount) external returns (uint256 recalled, uint256 processed, uint256 paid);
    function head() external view returns (uint256);
}
