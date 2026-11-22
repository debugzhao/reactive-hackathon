// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";

/// @title QueueReactive — Reactive 侧的决策合约（部署在 Lasna）
/// @notice 订阅两类 Base Sepolia 事件：
///         1. QueueVault.LiquiditySnapshot（只收 queueActive = true）→ 更新本地镜像
///         2. MockPool.Repaid → 池子出现流动性
///         在 react() 里算出「可兑付现金 = 闲置现金 + min(池流动性, 持仓, 缺口)」，
///         达到门槛就请求回调 QueueSettler.onSettle。
/// @dev   Omni 写法：SYSTEM = 0x8888…8888，react() 加 onlySystem，回调用 requestCallbackV_1_0，
///        payload 首参 address(0) 由网络替换成本合约地址。react() 绝不 revert（revert 照样扣费）。
contract QueueReactive is AbstractReactive {
    error NotOwner();
    error ZeroAddress();
    error GasLimitTooLow(uint64 gasLimit);

    struct Mirror {
        uint256 seq;
        uint256 queueCash;
        uint256 poolPosition;
        uint256 headId;
        uint256 headRemaining;
        uint256 totalQueued;
        uint256 pendingCount;
    }

    uint8 public constant SRC_SNAPSHOT = 1;
    uint8 public constant SRC_REPAID = 2;
    uint64 public constant MIN_CALLBACK_GAS = 100_000;
    uint256 internal constant SNAPSHOT_DATA_LEN = 10 * 32;
    uint256 internal constant REPAID_DATA_LEN = 3 * 32;

    address public immutable OWNER;
    uint256 public immutable CHAIN_ID;
    address public immutable VAULT;
    address public immutable POOL;
    uint256 public immutable SNAPSHOT_TOPIC_0;
    uint256 public immutable REPAID_TOPIC_0;

    address public settler;
    uint256 public maxPerCallback;
    uint64 public callbackGasLimit;
    uint256 public minSettleAssets;
    uint256 public remainingCallbacks;
    bool public subscribed;
    bool public paused;

    /// @notice Base 队列状态在 Lasna 上的镜像（react 读不到 Base 的状态，只能靠事件维护）
    Mirror public mirror;
    uint256 public reactCount;
    uint256 public callbackCount;

    /// @notice 熔断：windowSeconds 内 react 次数超过 maxReactsPerWindow 就自动暂停并退订。
    ///         防的是「经济型骚扰」：攻击者在 Base 上用很便宜的 gas 刷事件，消耗我们的 lREACT。
    ///         四个字段打包进一个存储槽，每次 react 只多一次 SSTORE。
    uint64 public windowStart;
    uint32 public windowCount;
    uint32 public maxReactsPerWindow;
    uint32 public windowSeconds;

    event SettleRequested(
        uint256 indexed originTxHash,
        uint8 source,
        uint256 seq,
        uint256 cashForQueue,
        uint256 headRemaining,
        uint256 maxCount
    );
    /// @notice reason：1 = 现金不够门槛，2 = 预算耗尽或未设置 settler
    event Skipped(uint256 indexed originTxHash, uint8 reason);
    event BudgetExhausted(uint256 callbackCount);
    event SubscriptionChanged(bool subscribed);
    event CircuitBreak(uint256 reactsInWindow, uint256 windowSeconds);

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner();
        _;
    }

    constructor(
        uint256 chainId_,
        address vault_,
        address pool_,
        uint256 snapshotTopic0_,
        uint256 repaidTopic0_,
        uint256 maxPerCallback_,
        uint64 callbackGasLimit_,
        uint256 minSettleAssets_,
        uint256 budget_
    ) payable {
        if (vault_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        if (callbackGasLimit_ < MIN_CALLBACK_GAS) revert GasLimitTooLow(callbackGasLimit_);
        OWNER = msg.sender;
        CHAIN_ID = chainId_;
        VAULT = vault_;
        POOL = pool_;
        SNAPSHOT_TOPIC_0 = snapshotTopic0_;
        REPAID_TOPIC_0 = repaidTopic0_;
        maxPerCallback = maxPerCallback_;
        callbackGasLimit = callbackGasLimit_;
        minSettleAssets = minSettleAssets_;
        remainingCallbacks = budget_;
        maxReactsPerWindow = 30;
        windowSeconds = 60;
        if (budget_ > 0) _subscribeAll();
    }

    // ───────────────────────── 核心 ─────────────────────────

    function react(LogRecord calldata log_) external onlySystem {
        reactCount++;
        if (paused) return;
        if (_tripBreaker()) return;
        if (log_.chainId != CHAIN_ID) return;

        uint256 poolLiquidity;
        uint8 source;
        if (log_.contractAddress == VAULT && log_.topic0 == SNAPSHOT_TOPIC_0) {
            if (log_.data.length != SNAPSHOT_DATA_LEN) return; // 畸形数据：abi.decode 会 revert，先挡掉
            if (!_applySnapshot(log_.data)) return; // 过期或重复的快照
            poolLiquidity = _snapshotPoolLiquidity(log_.data);
            source = SRC_SNAPSHOT;
        } else if (log_.contractAddress == POOL && log_.topic0 == REPAID_TOPIC_0) {
            if (log_.data.length != REPAID_DATA_LEN) return;
            (, poolLiquidity,) = abi.decode(log_.data, (uint256, uint256, uint64));
            source = SRC_REPAID;
        } else {
            return;
        }

        Mirror memory m = mirror;
        if (m.pendingCount == 0) return; // 队列为空

        uint256 cashForQueue = m.queueCash + recallable(poolLiquidity);
        uint256 threshold = m.headRemaining < minSettleAssets ? m.headRemaining : minSettleAssets;
        if (cashForQueue < threshold) {
            emit Skipped(log_.txHash, 1);
            return;
        }
        if (remainingCallbacks == 0 || settler == address(0)) {
            emit Skipped(log_.txHash, 2);
            return;
        }

        remainingCallbacks--;
        callbackCount++;
        if (remainingCallbacks == 0) {
            _unsubscribeAll();
            emit BudgetExhausted(callbackCount);
        }

        // 首参 address(0) 是占位符，Callback Proxy 会替换成本合约地址，供 Settler 鉴权
        bytes memory payload = abi.encodeWithSignature(
            "onSettle(address,uint8,uint256,uint256,uint256)",
            address(0),
            source,
            m.seq,
            log_.txHash,
            maxPerCallback
        );
        emit SettleRequested(log_.txHash, source, m.seq, cashForQueue, m.headRemaining, maxPerCallback);
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: CHAIN_ID, recipient: settler, gasLimit: callbackGasLimit, payload: payload
            })
        );
    }

    /// @notice 能从池里抢回的金额 = min(池流动性, 金库在池中的持仓, 队列缺口)
    function recallable(uint256 poolLiquidity) public view returns (uint256) {
        Mirror memory m = mirror;
        uint256 shortfall = m.totalQueued > m.queueCash ? m.totalQueued - m.queueCash : 0;
        uint256 r = poolLiquidity < m.poolPosition ? poolLiquidity : m.poolPosition;
        return r < shortfall ? r : shortfall;
    }

    // ───────────────────────── 管理 ─────────────────────────

    function setSettler(address settler_) external onlyOwner {
        if (settler_ == address(0)) revert ZeroAddress();
        settler = settler_;
    }

    function setParams(uint256 maxPerCallback_, uint64 callbackGasLimit_, uint256 minSettleAssets_) external onlyOwner {
        if (callbackGasLimit_ < MIN_CALLBACK_GAS) revert GasLimitTooLow(callbackGasLimit_);
        maxPerCallback = maxPerCallback_;
        callbackGasLimit = callbackGasLimit_;
        minSettleAssets = minSettleAssets_;
    }

    /// @notice maxReacts = 0 表示关闭熔断（只建议在受控实验里用）
    function setBreaker(uint32 maxReacts_, uint32 windowSeconds_) external onlyOwner {
        maxReactsPerWindow = maxReacts_;
        windowSeconds = windowSeconds_;
    }

    /// @notice 补预算：可随交易附带 lREACT，先还欠费再重新订阅
    function topUp(uint256 budget_) external payable onlyOwner {
        remainingCallbacks = budget_;
        _coverDebt();
        if (!paused && budget_ > 0) _subscribeAll();
    }

    /// @notice 跑轮询对照组时必须先暂停，避免 Reactive 和机器人互相抢
    function pause() external onlyOwner {
        paused = true;
        _unsubscribeAll();
    }

    function resume() external onlyOwner {
        paused = false;
        windowStart = uint64(block.timestamp);
        windowCount = 0;
        if (remainingCallbacks > 0) _subscribeAll();
    }

    function coverDebt() external {
        _coverDebt();
    }

    // ───────────────────────── 内部 ─────────────────────────

    /// @dev 用 Lasna 的 block.timestamp 计窗口，不用区块数
    function _tripBreaker() internal returns (bool tripped) {
        if (maxReactsPerWindow == 0) return false;
        if (block.timestamp >= uint256(windowStart) + windowSeconds) {
            windowStart = uint64(block.timestamp);
            windowCount = 0;
        }
        windowCount++;
        if (windowCount <= maxReactsPerWindow) return false;
        paused = true;
        _unsubscribeAll();
        emit CircuitBreak(windowCount, windowSeconds);
        return true;
    }

    /// @dev data = (seq, queueCash, poolPosition, poolLiquidity, headId, headRemaining,
    ///             totalQueued, totalClaimable, pendingCount, timestamp)
    function _applySnapshot(bytes calldata data) internal returns (bool fresh) {
        (
            uint256 seq,
            uint256 queueCash,
            uint256 poolPosition,
            ,
            uint256 headId,
            uint256 headRemaining,
            uint256 totalQueued,
            ,
            uint256 pendingCount,
        ) = abi.decode(
            data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint64)
        );
        if (seq <= mirror.seq) return false;
        mirror = Mirror(seq, queueCash, poolPosition, headId, headRemaining, totalQueued, pendingCount);
        return true;
    }

    function _snapshotPoolLiquidity(bytes calldata data) internal pure returns (uint256 liq) {
        // 第 4 个字（下标 3）是 poolLiquidity
        liq = abi.decode(data[96:128], (uint256));
    }

    /// @dev 订阅参数必须和退订时完全一致，否则退订静默失败
    function _subscribeAll() internal {
        if (subscribed) return;
        subscribed = true;
        SYSTEM.subscribe(CHAIN_ID, VAULT, SNAPSHOT_TOPIC_0, 1, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(CHAIN_ID, POOL, REPAID_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit SubscriptionChanged(true);
    }

    function _unsubscribeAll() internal {
        if (!subscribed) return;
        subscribed = false;
        SYSTEM.unsubscribe(CHAIN_ID, VAULT, SNAPSHOT_TOPIC_0, 1, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.unsubscribe(CHAIN_ID, POOL, REPAID_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit SubscriptionChanged(false);
    }
}
