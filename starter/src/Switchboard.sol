// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title Switchboard — 源链上的「控制台」（练习 B：动态订阅）
/// @notice 只有 owner 能发控制事件。DynamicWatcher 在 Lasna 上订阅这两个事件，
///         收到 Start 就订阅 target 的 Ping，收到 Stop 就退订。
/// @dev    控制通道必须有权限：否则任何人都能刷 Start，让 Reactive 合约替他付 react 费。
contract Switchboard {
    error NotOwner();

    /// @dev topic0 = keccak256("Start(address,uint256)")；target → topic1，limit 在 data 里
    event Start(address indexed target, uint256 limit);
    /// @dev topic0 = keccak256("Stop(address)")；target → topic1，data 为空
    event Stop(address indexed target);

    address public immutable OWNER;

    constructor() {
        OWNER = msg.sender;
    }

    /// @param target 要开始监听的合约（它发出的 Ping 会被 DynamicWatcher 处理）
    /// @param limit  最多处理多少条 Ping，到量自动退订（Reactive 侧还会再封顶）
    function start(address target, uint256 limit) external {
        if (msg.sender != OWNER) revert NotOwner();
        emit Start(target, limit);
    }

    function stop(address target) external {
        if (msg.sender != OWNER) revert NotOwner();
        emit Stop(target);
    }
}
