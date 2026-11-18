# Reactive Contracts 文档摘要

> 📅 整理日期：2026-11-18 ｜ 适用版本：Reactive **Omni**（2026-10-28 主网迁移后）｜ 依赖：`reactive-lib-omni` v0.1.0、Solidity `^0.8.29`
>
> 文中示例代码为便于理解自行编写，接口签名已对照 `starter/lib/reactive-lib-omni` 源码核实。

---

## 🎯 一句话结论

**Reactive 合约 = 普通 Solidity 合约 + 订阅任意链事件的能力。** 事件命中订阅后，系统合约 `SYSTEM`（`0x8888…8888`）调用你的 `react()`；你在里面可以更新状态、增删订阅、或请求一笔发往其他链的回调（callback）。

### 五条核心规则

| # | 规则 | 不遵守的后果 |
|---|---|---|
| 1 | 继承 `AbstractReactive` | 拿不到 `SYSTEM` / `REACTIVE_IGNORE` / `onlySystem` |
| 2 | `react()` 必须加 `onlySystem` | 任何人都能塞给你伪造的日志 |
| 3 | 合约要有余额（构造函数 `payable` 部署时充值） | 欠费（debt > 0）后**静默停止**，收不到任何事件 |
| 4 | 过滤事件用 `return`，不要 `revert` | revert 照样扣费 |
| 5 | 回调 payload 第一个参数必须是 `address(0)` 占位 | 回调鉴权失败，最常见的出错点 |

---

## 1️⃣ 运行流程

```
源链合约 emit Event
      │  Reactive 节点按订阅条件匹配日志
      ▼
SYSTEM(0x8888…8888) ──检查欠费──► 调用 react(LogRecord)   ← 一笔普通的 Reactive 交易
      │                                   │
      │                                   ├─ 更新状态
      │                                   ├─ subscribe / unsubscribe
      │                                   └─ SYSTEM.requestCallbackV_1_0(...)
      ▼                                                │
按实际 gas 扣费（失败也扣）                              ▼
                                       目标链 Callback Proxy → 回调合约（由接收方付费）
```

---

## 2️⃣ 继承与最小骨架

### 三个 import 各管什么

| import | 作用 | 是否必需 |
|---|---|---|
| `AbstractReactive` | 基类，提供 `SYSTEM`、`REACTIVE_IGNORE`、`onlySystem`，并带上 `AbstractPayer` | ✅ 必需 |
| `IReactive` | 只为写 `/// @inheritdoc IReactive` 注释；`LogRecord` 已通过继承获得 | 可选 |
| `ISystemContract` | 需要写出回调配置结构体 `CallbackConfiguration_V_1_0` 时用 | 实际项目基本都要 |

### 最小可编译骨架

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";

contract MinimalReactive is AbstractReactive {
    uint256 private immutable ORIGIN_CHAIN_ID;
    address private immutable ORIGIN_CONTRACT;
    uint256 private immutable TOPIC_0;

    // payable：部署时可直接带 REACT / lREACT 充值（基类构造函数不是 payable）
    constructor(uint256 originChainId_, address originContract_, uint256 topic0_) payable {
        ORIGIN_CHAIN_ID = originChainId_;
        ORIGIN_CONTRACT = originContract_;
        TOPIC_0 = topic0_;

        SYSTEM.subscribe(
            originChainId_, originContract_, topic0_,
            REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE
        );
    }

    /// @inheritdoc IReactive
    function react(LogRecord calldata log_) external onlySystem {
        if (log_.topic0 != TOPIC_0) return; // 不匹配就 return，别 revert
        // 你的业务逻辑
    }
}
```

> 接口里声明的是 `react(LogRecord calldata)`；官方文档示例写 `memory` 也能编译，两者都可以。

### 继承后可直接使用的成员

| 名称 | 来自 | 用途 |
|---|---|---|
| `SYSTEM` | AbstractReactive | 系统合约 `0x8888…8888`，订阅 / 请求回调都调它 |
| `REACTIVE_IGNORE` | AbstractReactive | topic 位置的通配符 |
| `onlySystem` | AbstractReactive | 只允许 SYSTEM 调用 `react()`，否则 `NotAuthorized` |
| `LogRecord` | IReactive | `react()` 收到的结构体 |
| `_SERVICE_PROVIDER` | AbstractPayer | 有权向你收费的合约（Reactive 侧就是 SYSTEM） |
| `onlyServiceProvider` | AbstractPayer | 与 `onlySystem` 是同一个检查，换了个名字 |
| `pay(uint256)` | AbstractPayer | 已实现且校验调用方，**不要自己重写** |
| `_coverDebt()` | AbstractPayer | 用合约余额还欠款；`internal`，需要外部调用得自己包一层 |
| `receive()` | AbstractPayer | 接收转账，`virtual` 可覆盖 |

---

## 3️⃣ 订阅（Subscriptions）

### 接口

```solidity
// subscribe 与 unsubscribe 参数完全相同
function subscribe(
    uint256 chainId_, address contract_,
    uint256 topic0_, uint256 topic1_, uint256 topic2_, uint256 topic3_
) external;
```

### 通配符与常见组合

| 参数 | 通配值 | 含义 |
|---|---|---|
| `chainId_` | `0` | 任意链 |
| `contract_` | `address(0)` | 该链上任意合约 |
| `topic0_`~`topic3_` | `REACTIVE_IGNORE` | 该位置任意值 |

| 想订阅 | chainId_ | contract_ | topic0_ |
|---|---|---|---|
| 某合约的**所有**事件 | 具体 | 具体 | `REACTIVE_IGNORE` |
| 整条链上的**某类**事件（如所有 ERC-20 Transfer） | 具体 | `address(0)` | 具体 |
| 某合约的**某个**事件 | 具体 | 具体 | 具体 |

### ⚠️ 限制

- **至少一个条件是具体值**，不能订阅"所有链所有合约所有事件"。
- **只支持等值匹配**：没有范围、比较、位运算过滤 → 数值条件放到 `react()` 里判断。
- **一次订阅只能表达一组条件（没有 OR）**：要监听多个合约 / 多种事件，就多次调用 `subscribe()`。
- 重复订阅等同一次，但两次调用都收 gas。
- **订阅存在节点里，不在合约存储里**：合约读不回自己的订阅，需要的话自己记录。

### 运行时增删订阅（推荐封装）

`unsubscribe()` 必须与订阅时 6 个参数**完全一致**才会生效，否则**静默失败**。把两个调用封装成内部函数，参数只写一处：

```solidity
function _subscribe() internal {
    SYSTEM.subscribe(ORIGIN_CHAIN_ID, ORIGIN_CONTRACT, TOPIC_0,
        REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
}

function _unsubscribe() internal {
    SYSTEM.unsubscribe(ORIGIN_CHAIN_ID, ORIGIN_CONTRACT, TOPIC_0,
        REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
}
```

**暂停 / 恢复模式**：恢复前先还清欠款，因为欠费的合约收不到任何事件。

```solidity
// onlyOwner 需自行实现（基类不提供）
function setActive(bool active_) external payable onlyOwner {
    if (active_) {
        _coverDebt();   // 先用余额（含本次 msg.value）还债
        _subscribe();
    } else {
        _unsubscribe();
    }
}
```

> 订阅也可以在 `react()` 内部增删，例如"处理满 N 次后自动退订"（模板 `CampReactive` 的 `remaining` 就是这么做的）。

---

## 4️⃣ Cron 定时订阅

Cron 事件由旧系统合约 `0x0000000000000000000000000000000000fffFfF` 按区块间隔发出，只有验证者能触发，用来实现**无需链下机器人的定时执行**。**这是 `0x…fffFfF` 唯一的用途**。

| 事件 | 间隔 | 约等于 | topic0 |
|---|---|---|---|
| Cron1 | 每块 | ~1 秒 | `0xf02d6ea5c22a71cffe930a4523fcb4f129be6c804db50e4202fb4e0b07ccb514` |
| Cron10 | 10 块 | ~10 秒 | `0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687` |
| Cron100 | 100 块 | ~2 分钟 | `0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70` |
| Cron1000 | 1000 块 | ~17 分钟 | `0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4` |
| Cron10000 | 10000 块 | ~3 小时 | `0xd214e1d84db704ed42d37f538ea9bf71e44ba28bc1cc088b2f5deca654677a56` |

```solidity
address internal constant CRON_EMITTER = 0x0000000000000000000000000000000000fffFfF;
uint256 internal constant CRON100_TOPIC_0 =
    0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;

function _subscribeCron() internal {
    SYSTEM.subscribe(block.chainid, CRON_EMITTER, CRON100_TOPIC_0,
        REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
}
```

要点：
- Cron 事件和其他事件进同一个 `react()`，**按 `topic0` 区分**。
- 唯一参数 `number`（触发的区块号）不是 indexed，在 `log_.data` 里；通常直接用 `block.number` 即可。
- 一个区块能被多个间隔整除时会同时触发多个事件：同时订阅 Cron1 和 Cron10，每第 10 块会收到**两笔**交易、扣**两次**费。
- 💸 **每个 tick 都扣费，不管 `react()` 做没做事** → 选够用的最长间隔，并提供暂停开关（退订 = 暂停，重新订阅 = 恢复）。
- 想把工作放到一笔新交易里执行，可以回调 Reactive 自己：`chainId: block.chainid`、`recipient: address(this)`；接收方法仍需按回调合约的规则做鉴权。

---

## 5️⃣ 处理事件：`react()`

### LogRecord 结构

```solidity
struct LogRecord {
    uint256 chainId;          // 源链 ID
    address contractAddress;  // 发出事件的合约
    uint256 topic0;           // 一般是事件签名哈希
    uint256 topic1;           // indexed 参数 1
    uint256 topic2;           // indexed 参数 2
    uint256 topic3;           // indexed 参数 3
    bytes   data;             // 仅包含【非 indexed】参数的 ABI 编码
    uint256 blockNumber;
    uint256 opCode;           // 原日志的 topic 数量：LOG3 → 3
    uint256 blockHash;        // 注意是 uint256，不是 bytes32
    uint256 txHash;           // 同上
    uint256 logIndex;
}
```

### 三个容易误解的字段

| 字段 | 要点 |
|---|---|
| `data` | 只有非 indexed 参数；多个参数按声明顺序作为 tuple 解码 |
| `opCode` | **判断 topic 个数的唯一可靠依据**。topic 为 0 不代表不存在（例如 ERC-20 mint 的 `from` 就是 `address(0)`） |
| `blockHash` / `txHash` | 是 `uint256`，和外部 `bytes32` 比较时要转换 |

### 多订阅时的路由写法

```solidity
// ERC-20: Transfer(address indexed from, address indexed to, uint256 value)
// → LOG3：topic1=from，topic2=to，data=abi.encode(value)
uint256 private constant ERC20_TRANSFER_TOPIC_0 =
    0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

function react(LogRecord calldata log_) external onlySystem {
    if (log_.topic0 == ERC20_TRANSFER_TOPIC_0 && log_.opCode == 3) {
        address to = address(uint160(log_.topic2));
        uint256 amount = abi.decode(log_.data, (uint256));
        // 处理转账……
    } else if (log_.topic0 == CRON100_TOPIC_0) {
        // 定时任务……
    }
    // 其他情况自然落空：不花额外费用
}
```

> 同一个 `Transfer` 如果参数都没加 indexed，会以 LOG1 到达，三个值全部打包在 `data` 里 —— 所以解码前先看 `opCode`。

### ❌ 不要用 revert 过滤

`react()` revert 时，系统合约会捕获它、发出 `ReactiveContractReverted` 事件，**并照样按已消耗的 gas 收费**。

### `react()` 能做什么

它就是一笔普通的 Reactive Network 交易，不是受限上下文：可以改状态、订阅 / 退订、请求回调。

---

## 6️⃣ 请求回调（Callbacks）

### 接口

```solidity
// ISystemContract
enum CallbackVersion { V_1_0 }

struct CallbackConfiguration_V_1_0 {
    uint256 chainId;    // 目标链
    address recipient;  // 目标链上的回调合约
    uint64  gasLimit;   // 目标调用的 gas 上限
    bytes   payload;    // ABI 编码的函数调用
}

function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config_) external; // ✅ 推荐
function requestCallback(CallbackVersion version_, bytes memory config_) external; // 通用入口，运行时选版本
```

- 优先用 `requestCallbackV_1_0()`：直接传结构体，不用手动编码和版本号。
- `requestCallback()` 遇到不认识的版本会 revert `InvalidCallbackVersion`；目前只有 `V_1_0`。
- 旧的 `emit Callback(...)` 仍兼容，但**已废弃**，新代码不要用。

### 🔑 payload 第一个参数必须预留

网络会把 payload 中**第一个参数的位置（前 160 位）替换成发起请求的 Reactive 合约地址**，供目标链鉴权。所以函数签名第一个参数必须是 `address`，编码时填 `address(0)`。

```solidity
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";

uint64 private constant CALLBACK_GAS_LIMIT = 1_000_000;

function _requestCallback(uint256 destChainId_, address recipient_, uint256 value_) internal {
    bytes memory payload = abi.encodeWithSignature(
        "onEvent(address,uint256)",
        address(0),   // ← 占位，网络会替换成本合约地址
        value_
    );

    SYSTEM.requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0({
        chainId: destChainId_,
        recipient: recipient_,
        gasLimit: CALLBACK_GAS_LIMIT,
        payload: payload
    }));
}
```

对应的目标链接收方法（详见 Callback Contracts 文档）：

```solidity
function onEvent(address reactive_, uint256 value_)
    external
    onlyServiceProvider          // msg.sender 必须是本链 Callback Proxy
    onlyCallbackSender(reactive_) // 注入的地址必须是你授权的 Reactive 合约
{ /* ... */ }
```

### 回调相关要点

| 主题 | 要点 |
|---|---|
| 触发方式 | 不一定要事件触发，任何外部方法都能调 `SYSTEM.requestCallbackV_1_0`，只是大多数在 `react()` 里发起 |
| 谁付费 | **目标链上的接收合约**，用该链原生币（如 ETH）支付，不是 Reactive 合约；接收方欠费就收不到；回调失败也收费 |
| gasLimit | 要覆盖目标调用；Proxy 还会额外预留记账开销；设太小表现为目标链上的 `CallbackFailure` 事件，而不是你能捕获的 revert |
| 部署顺序 | ① 部署 Reactive 合约 → ② 部署回调合约（传入 ① 的地址）→ ③ 通过 owner-only setter 把 ② 的地址设回 ① |
| 链上痕迹 | 每次请求，SYSTEM 都会发出 `CallbackRequest` 事件，三个 indexed 字段方便浏览器和链下设施过滤 |

```solidity
event CallbackRequest(
    uint256 indexed chainId,    // 目标链
    address indexed sender,     // 发起请求的 Reactive 合约
    address indexed recipient,  // 回调接收方
    CallbackVersion version,
    bytes configuration
);
```

---

## 7️⃣ 欠费与按需还款

- **欠费 = 停摆**：只要 debt > 0，SYSTEM 就不再投递任何 Reactive 交易。
- 平时扣费先用 reserves（预存），不够时 `AbstractPayer` 会通过 `pay()` 自动从合约余额补齐，所以只有**预存和余额都耗尽**才会真正停摆。
- `_coverDebt()` 是 `internal`，想让外部触发还款需要自己暴露：

```solidity
/// @notice 用合约自身余额结清欠款
function coverDebt() external {
    _coverDebt();
}
```

> 源码行为（`AbstractPayer._coverDebt`）：向服务方查询欠款并转账；欠款为 0 时什么也不做；**余额不足以还清时 revert `InsufficientFunds`**。

| 选择 | 适用场景 |
|---|---|
| 不加权限，任何人可调 | 服务他人的合约：第三方可以充值并"复活"它 |
| 加 `onlyOwner` | 合约余额另有用途 |
| 不暴露，只用 `depositTo()` | 也可以；从外部通过 SYSTEM 的 `depositTo(合约地址)` 充值并自动先还债 |

---

## 8️⃣ 合约验证（Sourcify）

| 网络 | chainId | RPC |
|---|---|---|
| Reactive Mainnet | `1597` | `https://mainnet-rpc.rnk.dev/` |
| Lasna Testnet | `5318007` | `https://lasna-rpc.rnk.dev/` |

部署后验证：

```bash
forge verify-contract \
  --verifier sourcify \
  --chain-id 5318007 \
  $CONTRACT_ADDR src/MyReactive.sol:MyReactive
```

部署时一并验证（带 `--value` 充值，并传入构造参数）：

```bash
forge create \
  --broadcast \
  --rpc-url https://lasna-rpc.rnk.dev/ \
  --private-key $PRIVATE_KEY \
  --chain-id 5318007 \
  --value 0.01ether \
  --verify --verifier sourcify \
  src/MyReactive.sol:MyReactive \
  --constructor-args $ARG_1 $ARG_2 $ARG_3
```

---

## ✅ 写 Reactive 合约自查清单

- [ ] 继承 `AbstractReactive`，Solidity `^0.8.29`，import 路径 `@reactive/src/...`
- [ ] `react()` 带 `onlySystem`
- [ ] 构造函数 `payable`，部署时已充值
- [ ] 订阅参数至少一个具体值；`topic0` 用 `cast keccak "Event(type,type)"` 算（签名里无参数名、无空格）
- [ ] `_subscribe` / `_unsubscribe` 封装，参数只写一处
- [ ] 多订阅时按 `topic0` 路由，解码前检查 `opCode`
- [ ] 不满足条件用 `return`，不用 `revert`
- [ ] 回调 payload 第一个参数是 `address(0)`
- [ ] 回调 `gasLimit` ≥ 100,000 且足够覆盖目标调用
- [ ] 按"Reactive → 回调合约 → setRecipient"顺序部署，并给两边都充值
- [ ] 需要时暴露 `coverDebt()`
- [ ] Cron 选最长可用间隔，并有暂停开关
- [ ] 不使用 `vm` 修饰符、ReactVM、`emit Callback`；`0x…fffFfF` 只用于 Cron 订阅

---

## 🔗 参考链接

- Reactive Contracts 官方文档：https://dev.reactive.network/reactive-contracts
