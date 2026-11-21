// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";

/// @title 场景 1：监控 Sepolia 上的 ERC-20 转账（第一个 Reactive 合约）
/// @notice 参考 omni 分支 micro-demos/Xfers.sol 改写：
///         构造函数订阅 → react() 按 opCode 解码 → 按代币累计转账额 → 处理满 N 条后自动退订。
///         只在 Reactive 侧运行，不发回调。
contract TransferMonitor is AbstractReactive {
    error NotOwner();

    /// @notice 每处理一条转账 emit 一次，在 Lasna 浏览器里就能看到 react() 干了什么
    event TransferSeen(
        address indexed token,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 originTxHash
    );
    event Subscribed(address token, uint256 limit);
    event Unsubscribed(uint256 processed);

    uint256 public constant SEPOLIA_CHAIN_ID = 11155111;
    /// @dev keccak256("Transfer(address,address,uint256)")
    uint256 public constant TRANSFER_TOPIC_0 =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

    address public immutable OWNER;
    /// @notice 监听的代币；address(0) = 通配，监听 Sepolia 上所有 ERC-20
    address public immutable TOKEN;

    /// @notice 还能处理多少条事件（自动化次数上限，防止订阅过宽把钱烧光）
    uint256 public remaining;
    uint256 public processed;
    bool public subscribed;

    uint256 public lastTxHash;
    uint256 public lastReactBlock;
    mapping(address token => uint256 total) public turnover;

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner();
        _;
    }

    /// @param token_ 要监听的代币，传 address(0) 监听全部
    /// @param limit_ 最多处理多少条事件后自动退订
    /// @dev payable：基类构造函数不是 payable，不加这个关键字部署时带 --value 会 revert
    constructor(address token_, uint256 limit_) payable {
        OWNER = msg.sender;
        TOKEN = token_;
        remaining = limit_;
        if (limit_ > 0) _sub();
    }

    /// @notice 由系统合约 0x8888…8888 调用；onlySystem 防止任何人伪造日志
    function react(LogRecord calldata log_) external onlySystem {
        // 过滤一律用 return：revert 照样扣费
        if (remaining == 0) return; // 退订前已在路上的事件，避免 --remaining 下溢
        if (log_.chainId != SEPOLIA_CHAIN_ID || log_.topic0 != TRANSFER_TOPIC_0) return;
        // ERC-20 Transfer 是 LOG3（topic0 + from + to）；ERC-721 Transfer 是 LOG4，data 为空，必须挡掉
        if (log_.opCode != 3) return;

        // indexed 参数在 topic 里，非 indexed 的 value 在 data 里
        address from = address(uint160(log_.topic1));
        address to = address(uint160(log_.topic2));
        uint256 amount = abi.decode(log_.data, (uint256));

        turnover[log_.contractAddress] += amount;
        lastTxHash = log_.txHash;
        lastReactBlock = block.number;
        processed++;

        emit TransferSeen(log_.contractAddress, from, to, amount, log_.txHash);

        if (--remaining == 0) _unsub();
    }

    /// @notice 调整次数上限：0 = 暂停；>0 = 恢复。可随交易附带 lREACT 先还欠费
    function setLimit(uint256 limit_) external payable onlyOwner {
        remaining = limit_;
        if (limit_ == 0) {
            _unsub();
        } else {
            _coverDebt(); // 无欠费时什么都不做；余额不够还债会 revert
            _sub();
        }
    }

    /// @notice 用合约余额结清欠费（基类只提供 internal 的 _coverDebt）
    function coverDebt() external {
        _coverDebt();
    }

    function _sub() internal {
        if (subscribed) return; // 避免重复订阅
        subscribed = true;
        // contract 参数传 address(0) 即通配；topic0 是具体值，满足"至少一个具体条件"
        SYSTEM.subscribe(SEPOLIA_CHAIN_ID, TOKEN, TRANSFER_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit Subscribed(TOKEN, remaining);
    }

    function _unsub() internal {
        if (!subscribed) return;
        subscribed = false;
        SYSTEM.unsubscribe(SEPOLIA_CHAIN_ID, TOKEN, TRANSFER_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit Unsubscribed(processed);
    }
}
