// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";

/// @title DynamicWatcher — 练习 B：运行中按事件增减订阅（部署在 Lasna）
/// @notice 构造时只订阅「控制通道」（Switchboard 的 Start / Stop）。
///         收到 Start(target, limit) → 在 react() 里订阅 target 的 Ping；
///         收到 Stop(target)         → 在 react() 里退订；
///         target 的 Ping 处理满 limit 条 → 自动退订。
/// @dev    Omni 是单一执行环境，react() 里可以直接调用 SYSTEM.subscribe / unsubscribe，
///         不需要像旧版 ReactVM 那样绕一圈回调。本合约不发回调，所以不存在「回调又触发自己」的循环。
contract DynamicWatcher is AbstractReactive {
    error NotOwner();

    /// @notice 开始监听某个 target
    event Watching(address indexed target, uint256 limit, uint256 originTxHash);
    /// @notice 退订某个 target；reason：1=收到 Stop，2=次数用完，3=owner 紧急停止
    event Unwatched(address indexed target, uint8 indexed reason, uint256 seen, uint256 originTxHash);
    /// @notice 处理了一条 Ping
    event PingSeen(address indexed target, address indexed who, uint256 value, uint256 remaining, uint256 originTxHash);
    /// @notice 控制事件被拒绝；reason：1=已在监听，2=监听数已满，3=非法 target，4=limit 为 0，5=本来就没在监听
    event Ignored(address indexed target, uint8 indexed reason, uint256 originTxHash);

    uint8 internal constant UNWATCH_STOP = 1;
    uint8 internal constant UNWATCH_LIMIT = 2;
    uint8 internal constant UNWATCH_OWNER = 3;

    uint8 internal constant IGNORE_ALREADY = 1;
    uint8 internal constant IGNORE_FULL = 2;
    uint8 internal constant IGNORE_BAD_TARGET = 3;
    uint8 internal constant IGNORE_ZERO_LIMIT = 4;
    uint8 internal constant IGNORE_NOT_WATCHING = 5;

    /// @notice 同时最多监听几个 target（每个 target 一条订阅）
    uint256 public constant MAX_TARGETS = 3;
    /// @notice 单个 target 最多处理多少条 Ping，Start 里传得再大也会被封顶
    uint256 public constant MAX_LIMIT = 10;

    uint256 public constant START_TOPIC_0 = uint256(keccak256("Start(address,uint256)"));
    uint256 public constant STOP_TOPIC_0 = uint256(keccak256("Stop(address)"));
    uint256 public constant PING_TOPIC_0 = uint256(keccak256("Ping(address,uint256)"));

    address public immutable OWNER;
    uint256 public immutable ORIGIN_CHAIN_ID;
    address public immutable SWITCHBOARD;

    /// @notice 控制通道是否还在订阅（owner 紧急停止后为 false）
    bool public controlSubscribed;
    /// @notice target 还能处理多少条 Ping；> 0 即「正在监听」
    mapping(address target => uint256 left) public remaining;
    /// @notice target 累计处理了多少条 Ping
    mapping(address target => uint256 count) public seen;
    /// @dev 正在监听的 target 列表（最多 MAX_TARGETS 个），紧急停止时逐个退订
    address[] internal _targets;

    uint256 public reactCount;
    uint256 public lastReactBlock;
    uint256 public lastTxHash;

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner();
        _;
    }

    /// @param originChainId_ 源链 chainId（Base Sepolia 84532）
    /// @param switchboard_   源链上的 Switchboard 地址
    /// @dev payable：部署时带 lREACT 作为 react 的预付款
    constructor(uint256 originChainId_, address switchboard_) payable {
        OWNER = msg.sender;
        ORIGIN_CHAIN_ID = originChainId_;
        SWITCHBOARD = switchboard_;
        _subscribeControl();
    }

    // ───────────────────────── react ─────────────────────────

    /// @notice 由系统合约 0x8888…8888 调用。过滤一律用 return：revert 照样扣费。
    function react(LogRecord calldata log_) external onlySystem {
        if (log_.chainId != ORIGIN_CHAIN_ID) return;
        reactCount++;
        lastReactBlock = block.number;
        lastTxHash = log_.txHash;

        // ① 控制通道：只认 Switchboard 发的事件
        if (log_.contractAddress == SWITCHBOARD) {
            address target = address(uint160(log_.topic1));
            if (log_.topic0 == START_TOPIC_0) {
                _start(target, log_.data, log_.txHash);
            } else if (log_.topic0 == STOP_TOPIC_0) {
                if (remaining[target] == 0) {
                    emit Ignored(target, IGNORE_NOT_WATCHING, log_.txHash);
                    return;
                }
                _unwatch(target, UNWATCH_STOP, log_.txHash);
            }
            return;
        }

        // ② 数据通道：只处理正在监听的 target 的 Ping
        if (log_.topic0 != PING_TOPIC_0) return;
        address t = log_.contractAddress;
        uint256 left = remaining[t];
        if (left == 0) return; // 退订前已经在路上的事件，直接丢弃

        uint256 value = log_.data.length >= 32 ? abi.decode(log_.data, (uint256)) : 0;
        left -= 1;
        remaining[t] = left;
        seen[t] += 1;
        emit PingSeen(t, address(uint160(log_.topic1)), value, left, log_.txHash);

        if (left == 0) _unwatch(t, UNWATCH_LIMIT, log_.txHash);
    }

    // ───────────────────────── owner ─────────────────────────

    /// @notice 紧急停止：退订所有 target 和控制通道，合约从此不再收到任何事件
    function stopAll() external onlyOwner {
        while (_targets.length > 0) {
            _unwatch(_targets[_targets.length - 1], UNWATCH_OWNER, 0);
        }
        if (controlSubscribed) {
            controlSubscribed = false;
            SYSTEM.unsubscribe(ORIGIN_CHAIN_ID, SWITCHBOARD, START_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
            SYSTEM.unsubscribe(ORIGIN_CHAIN_ID, SWITCHBOARD, STOP_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
    }

    /// @notice 紧急停止后恢复控制通道；可随交易附带 lREACT，先还欠费
    function resumeControl() external payable onlyOwner {
        _coverDebt();
        _subscribeControl();
    }

    /// @notice 用合约余额结清欠费。基类只给了 internal 的 _coverDebt，不包一层的话欠费后救不回来
    function coverDebt() external {
        _coverDebt();
    }

    function targets() external view returns (address[] memory) {
        return _targets;
    }

    // ───────────────────────── internal ─────────────────────────

    function _start(address target, bytes calldata data, uint256 txHash) internal {
        // target = 0 会变成「订阅这条链上所有合约的 Ping」，费用无法控制，必须拒绝
        if (target == address(0) || target == SWITCHBOARD) {
            emit Ignored(target, IGNORE_BAD_TARGET, txHash);
            return;
        }
        if (remaining[target] > 0) {
            emit Ignored(target, IGNORE_ALREADY, txHash); // 重复订阅会多收一份事件
            return;
        }
        if (_targets.length >= MAX_TARGETS) {
            emit Ignored(target, IGNORE_FULL, txHash);
            return;
        }
        uint256 limit = data.length >= 32 ? abi.decode(data, (uint256)) : 0;
        if (limit == 0) {
            emit Ignored(target, IGNORE_ZERO_LIMIT, txHash);
            return;
        }
        if (limit > MAX_LIMIT) limit = MAX_LIMIT;

        remaining[target] = limit;
        _targets.push(target);
        SYSTEM.subscribe(ORIGIN_CHAIN_ID, target, PING_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit Watching(target, limit, txHash);
    }

    /// @dev 退订参数必须和订阅时完全一致，否则静默失败；这里和 _start 用同一组参数
    function _unwatch(address target, uint8 reason, uint256 txHash) internal {
        remaining[target] = 0;
        uint256 n = _targets.length;
        for (uint256 i = 0; i < n; i++) {
            if (_targets[i] == target) {
                _targets[i] = _targets[n - 1];
                _targets.pop();
                break;
            }
        }
        SYSTEM.unsubscribe(ORIGIN_CHAIN_ID, target, PING_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit Unwatched(target, reason, seen[target], txHash);
    }

    function _subscribeControl() internal {
        if (controlSubscribed) return;
        controlSubscribed = true;
        SYSTEM.subscribe(ORIGIN_CHAIN_ID, SWITCHBOARD, START_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(ORIGIN_CHAIN_ID, SWITCHBOARD, STOP_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }
}
