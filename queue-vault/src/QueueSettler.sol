// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";
import { IQueueVault } from "./interfaces/IQueueVault.sol";

/// @title QueueSettler — 目标链回调合约（部署在 Base Sepolia）
/// @notice Reactive 回调的落点：两道校验通过后调用 vault.settleQueue，并 emit ReactiveSettled 供延迟测量。
/// @dev   为什么不让金库自己当回调合约：回调手续费（ETH）和用户资产（USDC）隔离；
///        换 Reactive 合约时只需要重新部署 Settler（_CALLBACK_SENDER 是 immutable），金库不动。
contract QueueSettler is AbstractCallback {
    IQueueVault public immutable VAULT;

    /// @notice originTxHash 是 Base 上触发事件的交易哈希，三段延迟靠它 join
    event ReactiveSettled(
        uint256 indexed originTxHash,
        uint8 source,
        uint256 seq,
        uint256 recalled,
        uint256 processed,
        uint256 paid,
        uint256 newHead,
        uint64 timestamp
    );

    /// @param proxy_    本链 Callback Proxy（Base Sepolia: 0x476F44b11F5C942c58f4c8E3d0300E5710743585）
    /// @param reactive_ Lasna 上的 QueueReactive 地址，填错只能重新部署
    constructor(IPayable proxy_, address reactive_, IQueueVault vault_)
        payable
        AbstractCallback(proxy_, reactive_)
    {
        VAULT = vault_;
    }

    /// @notice 只接受「本链 Proxy 调用」且「Proxy 注入的首参等于我们的 Reactive 合约」
    function onSettle(address rvm, uint8 source, uint256 seq, uint256 originTxHash, uint256 maxCount)
        external
        onlyServiceProvider
        onlyCallbackSender(rvm)
    {
        (uint256 recalled, uint256 processed, uint256 paid) = VAULT.settleQueue(maxCount);
        emit ReactiveSettled(originTxHash, source, seq, recalled, processed, paid, VAULT.head(), uint64(block.timestamp));
    }

    /// @notice 欠费后用合约余额还债（基类只提供 internal 版本）
    function coverDebt() external {
        _coverDebt();
    }
}
