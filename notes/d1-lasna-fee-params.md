# D1 Lasna 系统合约费用参数与计费机制

> 📅 2026-11-18 ｜ 网络：Reactive **Lasna** 测试网（Chain ID `5318007`）｜ 系统合约：`0x8888888888888888888888888888888888888888`

---

## 🎯 结论

Lasna 用的都是默认值：系数 **1000**（即 C = 1）、固定附加 **100,000 gas**、`pay()` gas 上限 **50,000**；当前 gas 价格 **100 gwei**。

**每次 `react()` 至少花 0.01 lREACT，哪怕什么都没做；欠一点费就静默停止；revert 照样全额收费。**

---

## 🖥️ 执行的命令与结果

```bash
❯ cast call 0x8888888888888888888888888888888888888888 "_gasPriceCoeffPer1000()" --rpc-url https://lasna-rpc.rnk.dev/ | cast to-dec
1000

❯ cast call 0x8888888888888888888888888888888888888888 "_extraGas()" --rpc-url https://lasna-rpc.rnk.dev/ | cast to-dec
100000

❯ cast call 0x8888888888888888888888888888888888888888 "_maxChargeGas()" --rpc-url https://lasna-rpc.rnk.dev/ | cast to-dec
50000

❯ cast gas-price --rpc-url https://lasna-rpc.rnk.dev/
100000000000
```

| 参数 | 值 | 含义 |
|---|---|---|
| `_gasPriceCoeffPer1000()` | **1000** | 价格系数 C = 1000 / 1000 = **1**，不加价 |
| `_extraGas()` | **100,000** | 每次固定多收的 gas，即公式里的 K |
| `_maxChargeGas()` | **50,000** | 系统合约调用你合约的 `pay()` 要钱时最多给的 gas，**不计入费用** |
| gas price | **100 gwei** | 公式里的基础 gas 价格 |

> 💡 `cast to-dec` 把返回的十六进制转成十进制。如果在非交互 shell 里报 `command not found: cast`，说明 PATH 只写进了 `~/.zshrc`，可以把 `export PATH="$PATH:$HOME/.foundry/bin"` 加到 `~/.zshenv`。

---

## 1️⃣ 一次 react() 的费用怎么算？

```
fee = 基础 gas 价格 × 系数 × (实际消耗 gas + 固定附加 gas)
    = max(gasprice, basefee) × (_gasPriceCoeffPer1000 / 1000) × (gas_used + _extraGas)
```

代入 Lasna 当前的值：

```
fee = 100 gwei × 1 × (gas_used + 100,000)
```

| react() 实际消耗 | 计费 gas | 费用 |
|---|---|---|
| 0（立刻 return） | 100,000 | **0.01 lREACT** |
| 约 50,000（TransferMonitor 大概这个量级） | 150,000 | **0.015 lREACT** |
| 900,000（单笔上限） | 1,000,000 | 0.1 lREACT |

**用自己的话说：** 每次触发先交 10 万 gas 的"起步价"，再按实际跑了多少 gas 计价，单价就是当前 gas 价格。起步价占了大头，所以**省钱的关键是少被触发，而不是把 react() 写得多省 gas**。

📌 **用真实数据验证：** 官方 Xfers 示例的 trace 里，`react()` 本身用了 34,421 gas，实际被扣了 0.0143904 REACT。反推回去，计费的 `gas_used` 大约是 43,904，比 react() 自己的 trace 多约 9,500，可以理解为系统合约调用你时的额外开销。结论和公式对得上：**1 lREACT 大约够触发 60～70 次**。

---

## 2️⃣ balance、reserves、debt 分别是什么？为什么有一点 debt 就停？

| 名称 | 放在哪 | 用自己的话说 |
|---|---|---|
| **balance** | 你的合约自己的余额 | 合约口袋里的钱，合约可以自由支配 |
| **reserves** | 记在系统合约账上 | 预存的话费，**只能用来交手续费** |
| **debt** | 记在系统合约账上 | 欠的话费 |

- **扣费顺序：** 先从 reserves 扣 → 不够就调用合约的 `pay()`，从 balance 里要钱 → 还不够才记成 debt
- **充值顺序：** `depositTo()` 先还 debt，剩下的才进 reserves，所以 reserves 和 debt 不会同时存在

**为什么有一点 debt 就停：**

1. **检查放在最前面：** 系统合约处理每个事件的第一步就是查 debt，只要大于 0，直接跳过，根本不会调用你的 react()
2. **费用是事后结算的：** 必须执行完才知道花了多少 gas。如果允许欠费的合约继续跑，就是先干活后付钱，欠费会越滚越大，没人能保证收回
3. **钱是付给验证者的：** 每笔手续费直接转给发出这笔交易的验证者（`tx.origin`）。欠费合约等于让验证者白干活，所以网络会把它拉黑（`BlacklistContract`），直到债务清零才恢复（`WhitelistContract`）

⚠️ **停止时不会报错**，合约只是突然不再响应。排查"为什么没触发"时，第一步就是查 debt：

```bash
cast call 0x8888888888888888888888888888888888888888 "debt(address)" <合约地址> --rpc-url https://lasna-rpc.rnk.dev/ | cast to-dec
```

---

## 3️⃣ react() 回滚了还收费吗？对合约设计意味着什么？

**收费，而且全额收。** 系统合约会捕获 revert，记一个 `ReactiveContractReverted` 事件，然后照常按实际消耗的 gas 加 10 万固定附加来扣费，不退款。原因：验证者已经替你执行了这笔交易，gas 已经花掉了，revert 是你代码的问题，不是验证者的问题。

| 设计原则 | 原因 | TransferMonitor 的做法 |
|---|---|---|
| **过滤条件一律用 `return`，不用 `revert` / `require`** | 两者都收费，revert 还不留下任何状态，日志里全是失败记录 | 链 ID、topic0、opCode 不匹配时直接 `return` |
| **先做便宜的检查** | 越早 return，gas 消耗越少 | 先判断 `remaining == 0`，再解码 |
| **防止注定会失败的操作** | 比如计数器下溢会 revert，每来一个事件就白付一次钱 | `if (remaining == 0) return;`，防止退订后还在路上的事件导致下溢 |
| **订阅范围要窄，并设次数上限** | 每次触发至少 0.01 lREACT，订阅太宽会很快把钱烧光 | `remaining` 计数，到 0 自动退订 |
| **不要在 react() 里用 `assert`** | assert 失败一样全额收费 | 官方止损单示例的 `assert(!done)` 在 d1-use-case 里改成了 `return` |
| **留足余额，并提供恢复手段** | 一次 `pay()` 失败就会被拉黑 | 构造函数 `payable`，暴露了 `coverDebt()` 和 `setLimit()` |

**一句话总结：** 在 Reactive 里，**每次被唤醒都要花钱，失败也照付**。合约的目标是：不该处理的事件尽快、便宜地 return，绝不 revert；同时用订阅范围和次数上限，从源头上减少被唤醒的次数。

---

## 🔗 参考链接

- Economy & System Interactions：https://dev.reactive.network/economy
- 本仓库笔记：[Economy 文档摘要](./2026-11-18-Economy-文档摘要.md)、[D1 用例分析](./d1-use-case.md)
