# Origins & Destinations 文档摘要

> 📅 整理日期：2026-11-18 ｜ 适用版本：Reactive **Omni**（2026-10-28 主网迁移后）｜ 依赖：`reactive-lib-omni` v0.1.0、Solidity `^0.8.29`
>
> 链表与地址摘自官方文档（2026-11-18 抓取）；回调校验相关代码已对照 `starter/lib/reactive-lib-omni` 源码核实。地址以官方页面为准，部署前请再核对一次。

---

## 🎯 一句话结论

**Origin 是"听事件"的链，Destination 是"收回调"的链；回调必须经由该链的 Callback Proxy 送达，且主网和测试网不能混用。** 黑客松阶段只用测试网：源链/目标链选 Ethereum Sepolia、Base Sepolia、Unichain Sepolia 之一，Reactive 合约部署在 Lasna。

### 四条核心规则

| # | 规则 | 不遵守的后果 |
|---|---|---|
| 1 | 主网只配主网，测试网只配测试网 | 订阅收不到事件 / 回调无法送达 |
| 2 | 回调合约构造函数传入**目标链**对应的 Callback Proxy 地址 | `onlyServiceProvider` 校验失败，回调全部 revert（且照样扣费） |
| 3 | Proxy 地址只看官方 origins-and-destinations 页面 | 用错地址（如 demo 里的开发分叉地址）等于没部署 |
| 4 | 回调目标是 Reactive 链自身时，"Proxy" 就是系统合约 `0x8888…8888` | — |

---

## 1️⃣ 两个角色

| 角色 | 含义 | 在代码里体现为 |
|---|---|---|
| **Origin（源链）** | 事件发生、日志被读取的链 | `SYSTEM.subscribe(chainId, contract, topic0..3)` 里的 `chainId` |
| **Destination（目标链）** | Reactive Network 投递回调交易、发生状态变更的链 | `CallbackConfiguration_V_1_0.chainId` |

要点：

- Origin 和 Destination **可以是同一条链，也可以不同**。
- 一个 Reactive 合约可以**同时订阅多条源链**，也可以**向多条目标链**发回调。
- 目标链可以在 Solidity 里**按条件动态决定**（例如按事件里的参数选择发往哪条链）。

```
   Origin A ─┐                               ┌─► Destination X（Callback Proxy X → 回调合约）
   Origin B ─┼─► Reactive 合约（Lasna/主网）─┤
   Origin C ─┘      react() 里按条件选择      └─► Destination Y（Callback Proxy Y → 回调合约）
```

---

## 2️⃣ Callback Proxy：回调是怎么被"认证"的

回调交易由 **Reactive Signer** 发到目标链，并且**必须经过该链的 Callback Proxy 合约**转发。这让目标链上的合约可以验证"这笔调用确实来自 Reactive Network"。

目标合约做**两层校验**：

| 校验 | 检查什么 | 库里的实现 |
|---|---|---|
| ① 谁在调用我 | `msg.sender` == 本链的 Callback Proxy | `AbstractPayer.onlyServiceProvider` |
| ② 谁请求的回调 | payload 第一个参数（Proxy 填入的发起方）== 我信任的 Reactive 合约 | `AbstractCallback.onlyCallbackSender(sender)` |

源码（`reactive-lib-omni/src/base/AbstractCallback.sol`，节选）：

```solidity
abstract contract AbstractCallback is AbstractPayer {
    address public immutable _CALLBACK_SENDER;

    // callbackProxy_ 就是本文链表里"目标链"那一列的 Callback Proxy 地址
    constructor(IPayable callbackProxy_, address callbackSender_) AbstractPayer(callbackProxy_) {
        _CALLBACK_SENDER = callbackSender_;
    }

    modifier onlyCallbackSender(address callbackSender_) {
        _onlyCallbackSender(callbackSender_);
        _;
    }
}
```

回调合约最小示例（示意代码）：

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";

contract MyCallback is AbstractCallback {
    event Handled(uint256 value);

    // Sepolia 上部署时：proxy = 0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4
    constructor(address proxy, address reactive)
        payable
        AbstractCallback(IPayable(payable(proxy)), reactive)
    {}

    // 第一个参数由 Proxy 填入发起回调的 Reactive 合约地址
    // （Reactive 侧 payload 里这里写 address(0) 占位）
    function onEvent(address sender, uint256 value)
        external
        onlyServiceProvider          // 校验 ①：msg.sender 是本链 Proxy
        onlyCallbackSender(sender)   // 校验 ②：发起方是我信任的 Reactive 合约
    {
        emit Handled(value);
    }
}
```

> ⚠️ 回调合约部署在哪条链，构造函数就传**那条链**的 Proxy。Sepolia 的地址拿到 Base Sepolia 上用，所有回调都会 `NotAuthorized`。

---

## 3️⃣ 测试网链表（🏁 黑客松用这张）

| 链 | 可作 Origin / Destination | Chain ID | Callback Proxy | RPC / 浏览器 |
|---|---|---|---|---|
| **Reactive Lasna** | ✅ | `5318007` | `0x8888888888888888888888888888888888888888` | RPC：https://lasna-rpc.rnk.dev/ ・ 浏览器：https://lasna.reactscan.net |
| Ethereum Sepolia | ✅ | `11155111` | `0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4` | [Chainlist](https://chainlist.org/chain/11155111) ・ https://sepolia.etherscan.io |
| Base Sepolia | ✅ | `84532` | `0x476F44b11F5C942c58f4c8E3d0300E5710743585` | [Chainlist](https://chainlist.org/chain/84532) ・ https://sepolia.basescan.org |
| Unichain Sepolia | ✅ | `1301` | `0x775c9B990ADe401060B78D0e98684eEf8d2466C1` | [Chainlist](https://chainlist.org/chain/1301) ・ https://sepolia.uniscan.xyz |

## 4️⃣ 主网链表（仅供了解，黑客松不要碰）

| 链 | 可作 Origin / Destination | Chain ID | Callback Proxy | 浏览器 |
|---|---|---|---|---|
| **Reactive** | ✅ | `1597` | `0x8888888888888888888888888888888888888888` | RPC：https://mainnet-rpc.rnk.dev/ ・ https://reactscan.net |
| Ethereum | ✅ | `1` | `0xFCE1F192F489c988392aBC16E91e359d540d94Fe` | https://etherscan.io |
| Arbitrum | ✅ | `42161` | `0xaee8d2deBaB5bE353bfec167C58a549923892e11` | https://www.arbiscan.io |
| Avalanche | ✅ | `43114` | `0x8bdfC7e564B90b31c49Cf1079d4c44400F4e14B4` | https://avascan.info |
| Base | ✅ | `8453` | `0xCc780DdE33f56f55dE778D42c930959374a4a068` | https://basescan.org |
| BSC | ✅ | `56` | `0xfc41eE9d3A836b41399BEcce83b06B3e5650f3BB` | https://bscscan.com |
| HyperEVM | ✅ | `999` | `0x754120EC7a6eF81E4c5c835AA603C63Da64693E6` | https://hyperevmscan.io |
| Robinhood | ✅ | `4663` | `0x476F44b11F5C942c58f4c8E3d0300E5710743585` | https://robinhoodchain.blockscout.com |
| Unichain | ✅ | `130` | `0x754120EC7a6eF81E4c5c835AA603C63Da64693E6` | https://uniscan.xyz |

> 💡 **同一个 Proxy 地址会出现在不同链上**：HyperEVM 与 Unichain 主网都是 `0x7541…93E6`，Base Sepolia 与 Robinhood 主网都是 `0x476F…3585`。所以**不能靠地址判断是哪条链**，一定要按"链 → 地址"查表。

---

## 5️⃣ 在代码里怎么用

### 5.1 把链表写成常量（示意）

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice 测试网链 ID 与 Callback Proxy（来源：dev.reactive.network/origins-and-destinations）
library TestnetChains {
    uint256 internal constant LASNA            = 5318007;
    uint256 internal constant SEPOLIA          = 11155111;
    uint256 internal constant BASE_SEPOLIA     = 84532;
    uint256 internal constant UNICHAIN_SEPOLIA = 1301;

    address internal constant PROXY_SEPOLIA          = 0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4;
    address internal constant PROXY_BASE_SEPOLIA     = 0x476F44b11F5C942c58f4c8E3d0300E5710743585;
    address internal constant PROXY_UNICHAIN_SEPOLIA = 0x775c9B990ADe401060B78D0e98684eEf8d2466C1;
    address internal constant SYSTEM                 = 0x8888888888888888888888888888888888888888; // Lasna 自身
}
```

### 5.2 Reactive 合约：订阅源链 + 回调目标链（示意片段）

```solidity
// 构造函数里：订阅 Sepolia 上某合约的事件（Origin = Sepolia）
SYSTEM.subscribe(TestnetChains.SEPOLIA, originContract, TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);

// react() 里：把回调发到 Base Sepolia（Destination = Base Sepolia）
SYSTEM.requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0({
    chainId:   TestnetChains.BASE_SEPOLIA,
    recipient: callbackOnBaseSepolia,   // 部署在 Base Sepolia、构造函数传了 PROXY_BASE_SEPOLIA 的回调合约
    gasLimit:  200_000,                 // ≥ 100,000，否则请求被忽略
    payload:   abi.encodeWithSignature("onEvent(address,uint256)", address(0), value)
}));
```

### 5.3 部署前用 cast 核对 Proxy 确实存在

```bash
# 返回非 0x 的字节码说明该地址在这条链上确实有合约
cast code 0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4 --rpc-url $SEPOLIA_RPC | head -c 20

# 确认 RPC 连的是你以为的那条链
cast chain-id --rpc-url $SEPOLIA_RPC   # 期望 11155111
cast chain-id --rpc-url https://lasna-rpc.rnk.dev/   # 期望 5318007
```

---

## 6️⃣ 常见坑

| 现象 | 原因 | 解决 |
|---|---|---|
| 回调交易在目标链 revert `NotAuthorized` | 构造函数里的 Proxy 不是这条链的 | 按"部署链"查表重新部署回调合约 |
| 回调 revert `CallbackNotAuthorized` | `_CALLBACK_SENDER` 填错，或 payload 第一个参数没留 `address(0)` 占位 | 填 Reactive 合约地址；payload 首参写 `address(0)` |
| 源链发了事件，Lasna 上没反应 | 订阅的 `chainId` 写错，或混用了主网/测试网 | 核对 Chain ID 表 |
| 用了 micro-demos `CALLBACK.md` 里的 `0x082caF…` | 那是开发分叉环境的地址 | 只用本文链表中的官方地址 |

---

## ✅ 自查清单

- [ ] 确定 Origin 和 Destination，并且**全部是测试网**
- [ ] Reactive 合约部署在 Lasna（Chain ID `5318007`）
- [ ] 订阅里的 `chainId` = 源链 Chain ID
- [ ] 回调配置里的 `chainId` = 目标链 Chain ID，`recipient` = 部署在目标链上的回调合约
- [ ] 回调合约构造函数的 Proxy = **目标链**那一行的地址
- [ ] 用 `cast chain-id` / `cast code` 核对 RPC 和 Proxy
- [ ] 在 lasna.reactscan.net 和目标链浏览器上分别能看到 reaction 与 callback 交易

---

## 🔗 参考链接

- Origins & Destinations 官方文档：https://dev.reactive.network/origins-and-destinations
