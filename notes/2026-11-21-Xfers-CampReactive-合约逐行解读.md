# 📜 Xfers 与 CampReactive 合约逐行解读（Java/TS 对照）

> 💡 **一句话：** 这两个合约可以理解成部署在链上的"事件监听器类"。就像 Java 里实现了 `MessageListener` 的类：部署一次之后，每当 Sepolia 上发生 Transfer 事件，Reactive 的系统合约就会调用它的 `react()` 方法。**Xfers 只负责记账，CampReactive 在记账之外还会发起跨链回调。**

来源：[Xfers.sol（omni 分支）](https://github.com/Reactive-Network/reactive-smart-contract-demos/blob/omni/src/micro-demos/Xfers.sol) ・ [CampReactive.sol（训练营模板）](https://github.com/ethpanda-org/reactive-builder-camp/blob/main/starter/src/CampReactive.sol) ・ 整理于 2026-11-21 ・ 同步自 Notion「Web3」空间

---

## 0️⃣ Solidity 速查：用 Java / TS 来理解

| Solidity | Java / TS 里的近似 | 关键区别 |
| --- | --- | --- |
| `contract A is B` | `class A extends B` | 部署后会有一个**地址**，相当于一个永远在线的单例服务 |
| 状态变量 `uint256 public x;` | 类的成员字段 | **永久保存在链上**，相当于自动持久化到数据库；每次写入都要花 gas |
| `constant` | `static final`（编译期常量） | 不占存储 |
| `immutable` | `final` 字段，在构造函数里赋值 | 部署后就不能再改 |
| `public` 状态变量 | 字段 + 自动生成的 getter | 例如 `_limit` 会自动生成 `_limit()` 方法 |
| `uint256` | 无符号的 `BigInteger` | **没有小数**；溢出或下溢会直接报错（Java 会静默回绕） |
| `address` | 20 字节的 ID 类型 | 代表一个账户或合约 |
| `mapping(address => uint256)` | `HashMap<Address, BigInteger>` | 不存在的 key 读出来是 0；**不能遍历** |
| `struct` | DTO / TS 的 `interface` / Java 的 `record` | — |
| `event` + `emit` | 写日志、发 Kafka 消息 | 链外（浏览器、前端）可以读，**合约自己读不到** |
| `modifier` | Spring 的 `@PreAuthorize`、Express 中间件 | 里面的 `_;` 相当于 `next()`，表示"继续执行方法体" |
| `require` / `revert` | `throw new Exception()` | **整笔交易回滚**，像数据库事务 rollback；但 gas 照样要付 |
| `error NotOwner()` | 自定义异常类 | 比字符串错误信息更省 gas |
| `external` / `public` / `internal` / `private` | 只能外部调用 / public / protected / private | `external` 就是"对外暴露的 API" |
| `payable` | — | 只有带这个关键字的函数，调用时才能带钱 |
| `msg.sender` | 当前登录用户 | 谁调用的这个方法，无法伪造 |
| `msg.value` | — | 这次调用带了多少钱 |
| `block.number` | — | 当前区块高度，可以当作时间戳用 |
| `memory` / `calldata` | 方法内的局部对象 / 只读参数 | `calldata` 是只读的，更省 gas |
| `constructor` | 构造函数 | **只在部署时执行一次** |
| `import { X } from "@reactive/..."` | TS 的 import；`@reactive` 是路径别名，类似 tsconfig 的 `paths` | 别名在 `foundry.toml` 的 `remappings` 里定义 |

---

## 1️⃣ 运行模型：谁在什么时候调用什么

```txt
① 你部署合约（forge create，带 --value 充值）
      → 执行 constructor：记录参数 + 向系统合约订阅事件

② Sepolia 上有人转账 ERC-20 → 产生一条 Transfer 日志
      → Reactive 网络匹配到你的订阅
      → 系统合约 0x8888…8888 调用你的 react(log)，并从你的余额里扣手续费

③ 你（owner）随时可以调用管理方法：调整次数、充值、暂停
```

和 Java 服务相比，有三个最需要转变的认知：

| 认知 | 说明 |
| --- | --- |
| 🔇 **合约不会自己运行** | 没有后台线程，也没有定时器。只有被人调用时才执行，这正是需要 Reactive 来"唤醒"它的原因 |
| 💸 **每次执行都要花钱** | 哪怕执行失败（revert）也一样收费 |
| 🔁 **每次调用都是一个事务** | 中途报错时，状态变更全部回滚 |

---

## 2️⃣ Xfers.sol 逐行解释

### 文件头和类声明

```solidity
// SPDX-License-Identifier: UNLICENSED   // 开源许可证声明，不写的话编译器会警告
pragma solidity ^0.8.29;                 // 编译器版本要求：>=0.8.29 且 <0.9.0，类似 package.json 的 "engines"

import { IReactive } from "@reactive/src/interfaces/IReactive.sol";          // 接口，定义了 react() 和 LogRecord 结构体
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";  // 抽象基类

contract Xfers is AbstractReactive {     // ≈ class Xfers extends AbstractReactive
```

**继承 `AbstractReactive` 能拿到什么（相当于父类提供的工具）：**

| 继承来的成员 | 作用 |
| --- | --- |
| `SYSTEM` | 系统合约 `0x8888…8888` 的引用，用来订阅、退订、请求回调 |
| `REACTIVE_IGNORE` | "这个 topic 我不关心"的通配值 |
| `onlySystem` | 修饰符：只允许系统合约调用，相当于 `@PreAuthorize("isSystem()")` |
| `pay()`、`_coverDebt()`、`receive()` | 付费相关：系统合约要钱时调 `pay()`；`_coverDebt()` 是手动还债；`receive()` 让合约能收钱 |

### 事件和 DTO

```solidity
event Turnover(address indexed token_, uint256 indexed volume_);
// 声明一种"日志格式"，类似定义一个 Kafka 消息类型
// indexed = 建索引，链外可以按这个字段过滤查询（最多 3 个）

struct Transfer {
    uint256 tokens;
}
// 解码用的 DTO。ERC-20 的 Transfer(from, to, value) 里 from、to 是 indexed，存在 topic 里；
// 只有 value 不是 indexed，存在 data 里，所以这个 DTO 只有一个字段
```

### 常量和状态变量

```solidity
uint256 private constant SEPOLIA_CHAIN_ID = 11155111;   // private static final：Sepolia 的链 ID

uint256 private constant ERC20_TRANSFER_TOPIC_0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;
// keccak256("Transfer(address,address,uint256)")
// topic0 就是"事件类型 ID"，相当于消息的 type 字段

uint256 public constant PING_TOPIC_0 = 0xca6e822df923f741dfe968d15d80a18abd25bd1e748bcb9ad81fea5bbb7386af;
// ⚠️ 没有用到，复制粘贴的残留

address public immutable _OWNER;      // final 字段，在构造函数里赋值为部署者；public 会自动生成 getter
uint256 public _limit;                // 还剩多少次可以处理（会持久化到链上）
uint256 public _lastTxHash;           // 最近一次处理的 Sepolia 交易哈希，调试用
uint256 public _lastReactBlockNumber; // 最近一次 react 时 Lasna 的区块号

mapping(address => uint256) public _turnovers;
// HashMap<代币地址, 累计转账额>；public 会自动生成 _turnovers(address) 查询方法
```

💡 命名习惯：Reactive 团队习惯给状态变量加 `_` 前缀，给参数加 `_` 后缀（比如 `limit_`）。这只是风格，不是语法要求。

### 构造函数

```solidity
constructor(uint256 limit_) payable {   // payable：部署时可以带 lREACT 充值（forge create --value 0.1ether）
    _OWNER = msg.sender;                 // 记下部署者，后面用来做权限校验
    _limit = limit_;                     // 初始的处理次数上限
    _sub();                              // ⭐ 在构造函数里完成订阅（任务要求 #1）
}
```

### 管理方法 updateLimit

```solidity
function updateLimit(uint256 limit_) external payable {
    require(msg.sender == _OWNER);       // 权限校验：不是 owner 就抛异常，整笔交易回滚

    _limit = limit_;

    if (limit_ == 0) {
        _unsub();                        // 设成 0 等于"暂停"：取消订阅
    } else {
        _coverDebt();                    // 先用合约余额（包括这次随交易带来的钱）还清欠费
        _sub();                          // 再重新订阅
    }
}
```

用 Java 类比，大致相当于 `@PreAuthorize("isOwner()") public void updateLimit(BigInteger limit)`。

⚠️ 如果合约当前还在订阅中，再调用一次就会重复执行 `_sub()`，可能产生重复订阅。

### 核心方法 react：事件回调

```solidity
function react(LogRecord memory log_) external onlySystem {
// ≈ @KafkaListener public void onMessage(LogRecord log)
// onlySystem：只有系统合约能调用，防止别人伪造事件喂给你（任务要求 #2）

    if (log_.opCode == 3) {
    // opCode = 这条日志有几个 topic。ERC-20 Transfer 有 3 个（topic0 + from + to），即 LOG3
    // ERC-721 的 Transfer 也是同一个 topic0，但有 4 个 topic，这里会被过滤掉

        _lastTxHash = log_.txHash;            // 记下源链交易哈希
        _lastReactBlockNumber = block.number; // 记下当前 Lasna 区块号，方便到浏览器里找这笔交易

        Transfer memory xfer = abi.decode(log_.data, ( Transfer ));
        // ≈ objectMapper.readValue(bytes, Transfer.class)，把原始字节反序列化成 DTO

        _turnovers[log_.contractAddress] += xfer.tokens;
        // log_.contractAddress = 发出这条日志的代币合约
        // ≈ map.merge(token, amount, BigInteger::add)

        emit Turnover(log_.contractAddress, xfer.tokens);  // 写一条日志，在 Reactscan 上能看到

        if (--_limit == 0) {   // 和 Java 的前置自减一样
            _unsub();          // ⭐ 次数用完，自动退订（任务要求 #3）
        }
    }
    // opCode 不是 3：什么都不做，直接结束（不 revert，因为 revert 也照样收费）
}
```

`LogRecord` 是系统合约传进来的"事件信封"，主要字段如下：

| 字段 | 含义 | 在 Transfer 事件里是 |
| --- | --- | --- |
| `chainId` | 事件发生在哪条链 | 11155111（Sepolia） |
| `contractAddress` | 哪个合约发出的事件 | 代币合约地址 |
| `topic0` | 事件类型 | `0xddf252ad…` |
| `topic1` / `topic2` / `topic3` | indexed 参数 | from / to / 无 |
| `data` | 非 indexed 参数，经过 ABI 编码的字节 | value（转账金额） |
| `opCode` | topic 的个数 | 3 |
| `txHash` | 源链交易哈希 | 可以去 Etherscan 查 |

### 订阅和退订

```solidity
function _sub() internal {          // internal ≈ protected，只能内部或子类调用
    SYSTEM.subscribe(
        SEPOLIA_CHAIN_ID,           // 哪条链
        address(0),                 // 哪个合约：address(0) = 通配，所有合约都要
        ERC20_TRANSFER_TOPIC_0,     // 什么事件：Transfer
        REACTIVE_IGNORE,            // topic1（from）：不关心
        REACTIVE_IGNORE,            // topic2（to）：不关心
        REACTIVE_IGNORE             // topic3：不关心
    );
}
// _unsub() 参数完全一样，调用的是 SYSTEM.unsubscribe(...)
```

用 SQL 类比这条订阅：

```sql
SELECT * FROM logs
WHERE chain = Sepolia AND topic0 = Transfer   -- 合约不限，from/to 不限
```

至少要有一个条件是具体值，这里由 topic0 满足。

---

## 3️⃣ CampReactive.sol 逐个方法解释

它和 Xfers 骨架相同，多了三件事：**参数化**、**阈值判断**、**跨链回调**。

### 声明部分

```solidity
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
// 多导入了这个接口，因为要用到它里面的回调配置结构体

contract CampReactive is AbstractReactive {
    error NotOwner();       // 自定义异常 ≈ class NotOwnerException extends RuntimeException
    error ZeroAddress();

    event Seen(uint256 indexed originChainId, address indexed originContract, uint256 txHash, uint256 value);
    // 每次 react 都 emit：用来在 Reactscan 上证明 react() 被调用过
    event CallbackRequested(uint256 indexed destChainId, address indexed recipient, uint256 value);

    address public immutable OWNER;
    uint256 public immutable ORIGIN_CHAIN_ID;    // 和 Xfers 不同：源链、合约、事件类型都不写死，
    address public immutable ORIGIN_CONTRACT;    // 而是从构造函数传入（类似依赖注入），
    uint256 public immutable ORIGIN_TOPIC_0;     // 一份代码可以监听任何事件
    uint256 public immutable DEST_CHAIN_ID;      // 回调发往哪条链
    uint64 public constant CALLBACK_GAS_LIMIT = 1_000_000;  // 回调最多用多少 gas；数字里的下划线和 Java 一样

    address public recipient;   // 目标链上的回调合约地址（部署后再设置）
    uint256 public threshold;   // 金额 ≥ 阈值才发回调
    uint256 public remaining;   // 剩余可用次数
    uint256 public lastTxHash;
    uint256 public lastReactBlock;
```

### modifier onlyOwner：权限中间件

```solidity
modifier onlyOwner() {
    if (msg.sender != OWNER) revert NotOwner();   // 不是 owner 就抛异常
    _;                                            // ≈ next()：校验通过，继续执行被修饰的方法体
}
```

类比 Express 中间件：

```ts
const onlyOwner = (req, res, next) => {
  if (req.user !== OWNER) throw new NotOwner();
  next();
};
```

### 构造函数

```solidity
constructor(
    uint256 originChainId_, address originContract_, uint256 originTopic0_,
    uint256 destChainId_, uint256 threshold_, uint256 limit_
) payable {
    OWNER = msg.sender;
    ORIGIN_CHAIN_ID = originChainId_;
    // …把参数逐个保存到字段…
    remaining = limit_;

    SYSTEM.subscribe(originChainId_, originContract_, originTopic0_,
                     REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    // ⭐ 在构造函数里订阅，监听的是"某一个指定合约"，不是通配
}
```

### 三个管理方法（setter）

```solidity
function setRecipient(address recipient_) external onlyOwner {
    if (recipient_ == address(0)) revert ZeroAddress();   // 参数校验
    recipient = recipient_;
}
// 为什么要单独设置？因为有"先有鸡还是先有蛋"的问题：
// 回调合约的构造函数需要知道 Reactive 合约的地址，所以必须先部署本合约，
// 再部署回调合约，最后回来调用 setRecipient

function setThreshold(uint256 threshold_) external onlyOwner { threshold = threshold_; }

function topUp(uint256 limit_) external payable onlyOwner { remaining = limit_; }
// 充值并重置次数。⚠️ 但它既不重新订阅，也不还债
```

### 核心方法 react

```solidity
function react(LogRecord calldata log_) external onlySystem {
    if (log_.topic0 != ORIGIN_TOPIC_0) return;   // 防御性检查：不是我要的事件就返回
    if (remaining == 0) return;                  // 次数用完就返回

    uint256 value = log_.data.length >= 32 ? abi.decode(log_.data, (uint256)) : 0;
    // 三元表达式，和 Java/TS 一样。data 不足 32 字节就当作 0，避免解码失败导致 revert

    lastTxHash = log_.txHash;
    lastReactBlock = block.number;
    emit Seen(log_.chainId, log_.contractAddress, log_.txHash, value);
    // ⭐ 不管满不满足条件，都先留下"我被调用过"的证据

    if (value < threshold || recipient == address(0)) return;
    // 过滤：金额不够，或者还没设置回调地址，就到此为止
    // 用 return，不用 revert，因为 revert 也收费

    remaining -= 1;                              // ⚠️ 只有走到这里才会计数
    if (remaining == 0) {
        SYSTEM.unsubscribe(ORIGIN_CHAIN_ID, ORIGIN_CONTRACT, ORIGIN_TOPIC_0,
                           REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);   // 用完次数就退订
    }

    bytes memory payload = abi.encodeWithSignature(
        "onEvent(address,uint256,uint256,uint256)",
        address(0), log_.chainId, log_.txHash, value
    );
    // 构造一个"远程方法调用请求"，类似把 RPC 请求序列化成字节：
    // 方法名是 onEvent，参数依次是 address(0)（占位，Proxy 会替换成本合约地址，
    // 供目标链做鉴权）、源链 ID、交易哈希、金额

    emit CallbackRequested(DEST_CHAIN_ID, recipient, value);

    SYSTEM.requestCallbackV_1_0(
        ISystemContract.CallbackConfiguration_V_1_0({
            chainId: DEST_CHAIN_ID,          // 发往哪条链
            recipient: recipient,            // 调用哪个合约
            gasLimit: CALLBACK_GAS_LIMIT,    // 最多用多少 gas
            payload: payload                 // 调用什么方法、传什么参数
        })
    );
    // 结构体字面量的写法，和 TS 的对象字面量很像
    // 本质上是让系统合约"帮我去目标链调用 recipient.onEvent(...)"
}
```

---

## 4️⃣ 两个合约的关键区别

| 方面 | Xfers | CampReactive |
| --- | --- | --- |
| 监听范围 | 写死为 Sepolia 上**所有代币**的 Transfer | 参数化，监听**某一个指定合约**的某个事件 |
| 主要动作 | 在 Lasna 上累计转账额 | 发跨链回调 |
| **什么时候计数** | **每处理一条事件** | **只有发了回调才计数** |
| 解码保护 | 检查 `opCode == 3` | 检查 `data.length >= 32` |
| 充值后恢复 | `updateLimit`：先还债，再重新订阅 | `topUp`：只重置次数 |
| 权限写法 | `require(...)` | 自定义 `error` + `modifier` |

> ⚠️ **CampReactive 用在这次任务上有个坑：** 这次任务不需要回调，`recipient` 一直是空的，于是每次都在"过滤"那一行就 return 了，`remaining` 永远不减、永远不退订，但每次 `react()` 都照样扣钱。这违反了任务要求 #3。

---

## 💬 答疑：为什么要计数？为什么次数 = 0 就退订？

> 💡 **计数 = 预算，退订 = 关水龙头，`if (remaining == 0) return` = 兜底。** 在 Reactive 里，被唤醒本身就要花钱，所以"不再需要时尽快退订"比"把 react() 写得多省 gas"重要得多。

**① 为什么要计数：订阅是"无限期的自动扣费"**

- 只要还在订阅，每来一条匹配的事件就调用一次 `react()`，每次至少扣 **0.01 lREACT**（正常处理约 0.015）。
- 充 0.2 lREACT 大约只够 13 次；像 Xfers 这样监听全部 ERC-20，钱可能几分钟就烧光了。
- 没有上限的结局：余额耗尽 → `pay()` 失败 → 产生 debt → 合约被拉黑，静默停止。
- 类比：`maxRetries`、AWS 预算上限、熔断器。计数本质上就是**给自动化设预算**。

**② 为什么到 0 要退订，而不是继续 return：return 也要付钱**

| 做法 | 事件还会送过来吗？ | 还扣钱吗？ |
| --- | --- | --- |
| 次数到 0 后每次 `return` | ✅ 继续送 | ✅ 每次至少 0.01 lREACT |
| 次数到 0 时 `unsubscribe` | ❌ 不再送 | ❌ 不再扣费 |

扣费发生在代码执行之后，并且有 10 万 gas 的"起步价"，立刻 return 也逃不掉。用 Kafka 类比：`return` 是拉下每条消息再丢掉（每条都付钱），`unsubscribe` 是直接退出 topic。

**③ 既然已经退订，为什么还要 `if (remaining == 0) return;`：防止退订前还在路上的事件出错**

退订生效前，可能还有已经在投递中的事件。如果没有这行保护，Xfers 的 `--_limit` 会从 0 下溢并 revert，白白扣一次费。所以保险丝有两层：**退订止血，return 兜底**。

**④ CampReactive 的计数保护的是"回调次数"，不是"react 次数"**

| 合约 | 计数位置 | 保护的是什么 |
| --- | --- | --- |
| CampReactive | 发回调前 | 目标链上的回调费用（用目标链 ETH 支付，比 react 更贵） |
| Xfers / TransferMonitor | 每条事件 | Lasna 上的 react 费用（lREACT） |

CampReactive 在"满足条件就回调"的场景下没问题；但这次任务没有回调，每个事件都会在过滤那一行 return，计数永远不变、永远不退订。所以 TransferMonitor 采用 Xfers 的方式：**每处理一条事件就计数**。

---

## 5️⃣ 对照黑客松任务

| 任务要求 | 在代码里对应哪里 | 我们的 TransferMonitor |
| --- | --- | --- |
| 构造函数里完成订阅，用 `REACTIVE_IGNORE` 处理不关心的 topic | 两个合约的构造函数里都有 `SYSTEM.subscribe(…, REACTIVE_IGNORE ×3)` | ✅ |
| `react()` 带 `onlySystem` | `function react(...) external onlySystem` | ✅ |
| 处理次数上限，到了自动退订 | Xfers 的写法是对的（每条事件都计数） | ✅ 采用 Xfers 的计数方式 |
| 部署时充值 | 构造函数 `payable` + `forge create --value` | ✅ |

**提交时需要的三样东西，分别从哪里来：**

| 提交物 | 怎么拿到 |
| --- | --- |
| ① 合约地址（Reactscan 链接） | `forge create` 输出的 `Deployed to: 0x…`，拼成 `https://lasna.reactscan.net/address/0x…` |
| ② 一笔 `react()` 被调用的交易 | 在合约的 Reactscan 页面看交易列表；或者读出 `lastReactBlock`，到浏览器里找那个区块 |
| ③ 一句话说明过滤条件 | 例如："订阅 Sepolia 上所有 ERC-20 合约的 Transfer 事件（合约地址通配，topic1–3 用 `REACTIVE_IGNORE`），只处理 LOG3，最多处理 5 次后自动退订" |

> 🎯 **一句话总结：** 这次任务的骨架用 **Xfers**（纯监控、每条事件都计数），代码风格参考 **CampReactive**（参数化、自定义错误、`modifier`）。我们写好的 TransferMonitor 正是这样结合的。

---

## 🔗 参考链接

- Xfers.sol（omni 分支）：https://github.com/Reactive-Network/reactive-smart-contract-demos/blob/omni/src/micro-demos/Xfers.sol
- CampReactive.sol（训练营模板）：https://github.com/ethpanda-org/reactive-builder-camp/blob/main/starter/src/CampReactive.sol
- Notion 原文：https://app.notion.com/p/41f95506c1a781788c70c4a7da7b0e88
