# 🛠️ forge 与 cast：区别与常用命令

> 💡 **一句话区别：forge 管"写合约"：编译、测试、部署；cast 管"和链打交道"：查数据、发交易、做格式转换。**
>
> 用 Java / TS 来类比：**forge ≈ Maven/Gradle + JUnit**（构建、测试、发布），**cast ≈ curl/Postman + 一堆小工具**（直接调用链上接口、做编码转换）。

整理于 2026-11-21 ・ 命令已在本机 Foundry 1.9.0 上核对 ・ 示例尽量使用本项目的真实地址

---

## 0️⃣ Foundry 四件套

| 工具 | 作用 | Java / TS 类比 |
|---|---|---|
| **forge** | 项目级：编译、测试、部署、验证合约 | `mvn` / `gradle` + JUnit |
| **cast** | 命令行和链交互：读状态、发交易、编码解码 | `curl` / Postman + `jq` |
| anvil | 本地启动一条测试链 | 本地 Docker 起一个数据库 |
| chisel | Solidity 交互式命令行（REPL） | `jshell` / `node` |

**判断用哪个：** 和 `src/`、`test/`、`script/` 这些**项目文件**有关的，用 forge；和**某个链上地址或交易**有关的，用 cast。

---

## 1️⃣ forge 常用命令

### 项目和依赖

| 命令 | 作用 | 示例 |
|---|---|---|
| `forge init` | 新建项目骨架 | `forge init my-project` |
| `forge install` | 安装依赖（以 git 子模块的形式放进 `lib/`） | `forge install foundry-rs/forge-std` |
| `forge update` | 更新依赖 | `forge update lib/forge-std` |
| `forge remappings` | 查看 import 路径别名 | 输出中能看到 `@reactive/=lib/reactive-lib-omni/` |
| `forge tree` | 查看依赖树 | `forge tree` |

### 编译和测试（最常用）

| 命令 | 作用 | 示例 |
|---|---|---|
| `forge build` | 编译 `src/` 下的合约，产物放在 `out/` | `forge build` |
| `forge test` | 运行 `test/` 下的所有测试 | `forge test` |
| 只跑某个测试合约 | 类似 JUnit 只跑一个类 | `forge test --match-contract TransferMonitorTest` |
| 只跑某个测试方法 | 类似只跑一个 `@Test` | `forge test --match-test test_reactOnlySystem` |
| 看详细日志 | `-v` 越多越详细，`-vvvv` 会打印完整调用栈 | `forge test -vvv` |
| `--gas-report` | 每个函数消耗多少 gas | `forge test --gas-report` |
| `forge coverage` | 测试覆盖率 | `forge coverage` |
| `forge snapshot` | 记录 gas 基线，方便对比优化前后 | `forge snapshot` |
| `forge fmt` | 格式化代码，类似 Prettier | `forge fmt` |
| `forge clean` | 清除编译缓存 | `forge clean` |

### 部署和验证

| 命令 | 作用 | 示例 |
|---|---|---|
| `forge create` | **部署单个合约**，适合一次性部署 | 见下面的示例 1 |
| `forge script` | **执行部署脚本**，可以一次做多步，适合正式流程 | 见下面的示例 2 |
| `forge verify-contract` | 在浏览器上公开源码（验证合约） | 见下面的示例 3 |
| `forge inspect` | 查看合约的 ABI、存储布局等 | `forge inspect CampCallback abi` |

**示例 1：用 `forge create` 部署（部署 TransferMonitor 时用的就是它）**

```bash
forge create src/TransferMonitor.sol:TransferMonitor --rpc-url https://lasna-rpc.rnk.dev/ --interactive --broadcast --value 0.2ether --constructor-args 0x0000000000000000000000000000000000000000 5
```

| 参数 | 含义 |
|---|---|
| `src/TransferMonitor.sol:TransferMonitor` | 文件路径:合约名 |
| `--interactive` | 运行时在终端里输入私钥 |
| `--broadcast` | 真正发上链；不加只是模拟 |
| `--value` | 部署时附带的金额（构造函数必须是 `payable`） |
| `--constructor-args` | 构造函数参数，**必须放在最后** |

**示例 2：用 `forge script` 执行部署脚本（三段链路那五步）**

```bash
forge script script/Deploy.s.sol:DeployReactive --rpc-url $LASNA_RPC_URL --broadcast
```

脚本本身是一个 Solidity 合约（`Deploy.s.sol`），里面用 `vm.startBroadcast()` 包住要发出的交易。适合"部署 + 初始化 + 设置参数"这种多步骤流程，相当于把部署过程写成代码。

**`forge create` 和 `forge script` 怎么选：**

| | `forge create` | `forge script` |
|---|---|---|
| 适合 | 一次部署一个合约 | 多步部署、部署后还要调用函数 |
| 参数怎么传 | 命令行 | 脚本里读环境变量 |
| 可重复执行 | 每次都要手敲 | 写一次，反复执行 |

**示例 3：验证合约源码（Sourcify）**

```bash
forge verify-contract --verifier sourcify --chain-id 5318007 0xE8d67702EA8674b573c845a7B70B99c4762239e7 src/CampReactive.sol:CampReactive
```

---

## 2️⃣ cast 常用命令

### 读链上数据（不花钱、不需要私钥）

| 命令 | 作用 | 示例 |
|---|---|---|
| `cast call` | **调用 view 函数读合约状态** | `cast call $REACTIVE_ADDR "remaining()(uint256)" --rpc-url $LASNA_RPC_URL` → `4` |
| `cast balance` | 查余额（`-e` 表示按 ETH 单位显示） | `cast balance 0xe946…c95eb -r https://lasna-rpc.rnk.dev/ -e` |
| `cast nonce` | 查账户已经发过多少笔交易 | `cast nonce 0xe946…c95eb -r $SEPOLIA_RPC_URL` |
| `cast code` | 查地址上的合约字节码；返回 `0x` 表示不是合约 | `cast code $CALLBACK_ADDR -r $SEPOLIA_RPC_URL` |
| `cast receipt` | 查交易回执（成功还是失败、消耗多少 gas） | `cast receipt 0x73174efb…7c35 status -r $SEPOLIA_RPC_URL` → `true` |
| `cast tx` | 查交易详情 | `cast tx 0x73174efb…7c35 -r $SEPOLIA_RPC_URL` |
| `cast logs` | 按事件签名查日志 | `cast logs --address $ORIGIN_ADDR "Ping(address indexed who, uint256 value)" -r $SEPOLIA_RPC_URL` |
| `cast block-number` | 当前区块高度 | `cast block-number -r https://lasna-rpc.rnk.dev/` |
| `cast chain-id` | 确认 RPC 连的是哪条链 | `cast chain-id -r https://lasna-rpc.rnk.dev/` → `5318007` |
| `cast gas-price` | 当前 gas 价格 | `cast gas-price -r https://lasna-rpc.rnk.dev/` → `100000000000` |
| `cast storage` | 直接读某个存储槽（不需要 getter） | `cast storage $CALLBACK_ADDR 0 -r $SEPOLIA_RPC_URL` |

📌 **`cast call` 的签名写法：** `"函数名(参数类型)(返回类型)"`。写上返回类型，cast 会自动帮你解码；不写的话返回的是一串十六进制。

```bash
# 读取：返回 4
cast call $REACTIVE_ADDR "remaining()(uint256)" --rpc-url $LASNA_RPC_URL

# 带参数：查欠费
cast call 0x8888888888888888888888888888888888888888 "debt(address)(uint256)" $REACTIVE_ADDR --rpc-url $LASNA_RPC_URL
```

### 写链上数据（要签名、要花 gas）

| 命令 | 作用 | 示例 |
|---|---|---|
| `cast send` | **发交易**：调用会修改状态的函数，或者转账 | 见下面 |

```bash
# 调用合约函数（失败实验）
cast send $CALLBACK_ADDR "onEvent(address,uint256,uint256,uint256)" $REACTIVE_ADDR 11155111 0 500 --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY

# 纯转账（换 lREACT）
cast send 0x9b9BB25f1A81078C544C829c5EB7822d747Cf434 --value 0.01ether --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY

# 给 Reactive 合约充值
cast send 0x8888888888888888888888888888888888888888 "depositTo(address)" $REACTIVE_ADDR --value 0.1ether --rpc-url $LASNA_RPC_URL --private-key $PRIVATE_KEY
```

**`call` 和 `send` 的区别（最容易搞混）：**

| | `cast call` | `cast send` |
|---|---|---|
| 类比 | HTTP GET | HTTP POST |
| 修改链上状态 | ❌ | ✅ |
| 花钱 | ❌ | ✅ 要付 gas |
| 需要私钥 | ❌ | ✅ |
| 会不会上链 | 不会，只在节点本地模拟执行 | 会，生成一笔交易 |

### 编码、转换、调试工具（离线可用）

| 命令 | 作用 | 示例 → 结果 |
|---|---|---|
| `cast keccak` | 算事件或函数签名的哈希（topic0 就是这么来的） | `cast keccak "Transfer(address,address,uint256)"` → `0xddf252ad…b3ef` |
| `cast sig` | 算函数或错误的 4 字节选择器 | `cast sig "NotAuthorized(address,address)"` → `0xc55ddc97` |
| `cast decode-error` | 把 revert 返回的数据解码成可读形式 | `cast decode-error 0xc55ddc97… --sig "NotAuthorized(address,address)"` → 两个地址 |
| `cast to-dec` / `cast to-hex` | 十六进制和十进制互转 | `cast to-hex 8890742` |
| `cast to-wei` / `cast from-wei` | ETH 和 wei 互转 | `cast to-wei 0.2` → `200000000000000000` |
| `cast calldata` | 生成调用某个函数的 calldata | `cast calldata "ping(uint256)" 500` |
| `cast abi-encode` | 只编码参数（不带选择器） | `cast abi-encode "f(uint256)" 500` |
| `cast 4byte` | 根据选择器反查函数名 | `cast 4byte 0xa9059cbb` → `transfer(address,uint256)` |
| `cast compute-address` | 根据部署者和 nonce 算出合约地址 | `cast compute-address 0xe946…c95eb --nonce 2` → `0x203C…C62b`（回调合约） |
| `cast run` | 在本地重放一笔已上链的交易，打印完整调用栈 | `cast run 0xe3cd390e…b175 -r https://lasna-rpc.rnk.dev/` |
| `cast wallet new` | 新建一个钱包（地址 + 私钥） | `cast wallet new` |
| `cast wallet address` | 根据私钥算出地址 | `cast wallet address --private-key $PRIVATE_KEY` |

💡 `cast compute-address` 解释了一个现象：CampOrigin（Sepolia）和 CampReactive（Lasna）的地址一模一样。因为合约地址只由"部署者地址 + nonce"决定，两条链上都是用 nonce 1 部署的，所以算出来的地址相同。

---

## 3️⃣ 通用参数速记

| 参数 | 含义 | 用在哪 |
|---|---|---|
| `--rpc-url` / `-r` | 连接哪条链的节点 | 几乎所有命令 |
| `--private-key` | 用哪个私钥签名 | `cast send`、`forge create` |
| `--interactive` / `-i` | 运行时在终端里输入私钥，更安全 | `forge create`、`cast send` |
| `--broadcast` | 真正发上链 | `forge create`、`forge script` |
| `--value` | 附带转账金额，例如 `0.1ether` | `cast send`、`forge create` |
| `-e` / `--ether` | 按 ETH 单位显示 | `cast balance` |

`--rpc-url` 除了填完整网址，也可以填 `foundry.toml` 里 `[rpc_endpoints]` 配置的别名，比如 `--rpc-url lasna`。

---

## 🎯 记忆口诀

> **forge 对项目，cast 对链。**
>
> 写完代码用 `forge build` 编译、`forge test` 测试、`forge create` 或 `forge script` 部署；
> 部署之后用 `cast call` 查状态、`cast send` 发交易、`cast keccak` / `cast sig` / `cast decode-error` 做编码和调试。

---

## 🔗 参考链接

- Foundry 官方文档：https://getfoundry.sh/
- forge 命令参考：https://getfoundry.sh/forge/overview
- cast 命令参考：https://getfoundry.sh/cast/overview
