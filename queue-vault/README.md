# ⚡ queue-vault｜即时结算提款队列

Reactive Omni Buildathon · 赛道 1 Every Second Counts。设计文档见 [`../docs/即时结算提款队列-产品与技术方案.md`](../docs/即时结算提款队列-产品与技术方案.md)。

一个 ERC4626 金库把大部分资金存进**共享借贷池**生息。提款时现金不够就进入 FIFO 队列。借款人一还款，池里出现流动性，**Reactive 就在秒级把它从池里抢回来并按 FIFO 兑付**；池里的流动性是先到先得的，慢了就会被其他存款人取走。

```
Base Sepolia  MockPool.repay()          ① emit Repaid(availableLiquidity)       ← 还款进的是池子，金库代码不执行
                    │ Reactive 按订阅投递
                    ▼
Lasna         QueueReactive.react()     ② 可兑付现金 = 闲置现金 + min(池流动性, 持仓, 缺口) ≥ 门槛？
                    │ requestCallbackV_1_0
                    ▼
Base Sepolia  QueueSettler.onSettle()   ③ vault.settleQueue(N)：抢回缺口 → FIFO 兑付 → emit ReactiveSettled
```

## 目录

| 路径 | 内容 |
|---|---|
| [`src/`](src/) | 5 个合约（见下表） |
| [`test/`](test/) | 单元、fuzz、集成（真实事件喂给 react）、不变量（I1–I12） |
| [`script/Deploy.s.sol`](script/Deploy.s.sol) | 部署与演示步骤，地址读写 `deployments/*.json` |
| [`bin/`](bin/) | `deploy.sh` `loop.sh` `status.sh` `trace.sh` `verify.sh` `devnet.sh` |
| [`bench/`](bench/) | TypeScript + viem：延迟基准、抢流动性实验、轮询对照组、报告、演示看板 |
| [`web/`](web/) | QueueVault Scan：只读实时看板（Vite + React + viem），演示视频主画面 |

| 合约 | 链 | 作用 |
|---|---|---|
| [`MockUSDC`](src/MockUSDC.sol) | Base Sepolia | 6 位小数测试币，mint 不设权限（仅限测试网） |
| [`MockPool`](src/MockPool.sol) | Base Sepolia | 精简版 Aave：多存款人份额、单一借款人、按时间戳线性计息、**提款受流动性限制（先到先得）** |
| [`QueueVault`](src/QueueVault.sol) | Base Sepolia | ERC4626 + FIFO 队列：锁价排队、立即销毁份额；`settleQueue` 先取回缺口再兑付，任何人可调用 |
| [`QueueSettler`](src/QueueSettler.sol) | Base Sepolia | 回调落点，`onlyServiceProvider` + `onlyCallbackSender` 双重鉴权 |
| [`QueueReactive`](src/QueueReactive.sol) | Lasna | 订阅金库快照和池子还款，维护队列镜像，判断阈值，管理回调预算和熔断 |

## 1. 本地测试（不用联网、不用测试币）

```bash
cd queue-vault
forge install         # 新 clone 时拉取 forge-std / reactive-lib-omni / openzeppelin-contracts
forge test            # 42 个测试，约 10 秒
```

| 套件 | 覆盖 |
|---|---|
| `MockPool.t.sol`（7） | 线性计息、还款不改变 PPS、先到先得、权限 |
| `QueueVault.t.sol`（19） | 舍入四件套、通胀攻击模拟、锁价排队 PPS 不降（fuzz）、插队防护、部分兑付、对手抢先时取回 0 且不 revert、幂等、坏接收者转 claimable |
| `Integration.t.sol`（15） | `vm.recordLogs` 捕获**真实 emit 的事件**交给 `react()`，MockProxy 替换首参后投递回调；全链路、事件自续、预算耗尽、熔断、鉴权、最坏情况 gas |
| `invariant/`（I1–I12） | 11 种动作随机交错，256 轮 × 100 步；偿付能力、FIFO、不多付、PPS 不降、settle 永不 revert 等 |

## 2. 上链（Base Sepolia ↔ Lasna）

**准备资金**（同一个测试钱包；做实验还需要第二个“对手”钱包）：

| 链 | 只跑演示 | 还要跑实验 | 怎么拿 |
|---|---|---|---|
| Base Sepolia（主钱包） | ≥ 0.01 ETH | ≥ 0.02 ETH | Base Sepolia faucet（Coinbase CDP / Alchemy 等） |
| Base Sepolia（对手钱包） | — | ≥ 0.005 ETH | `cast wallet new` 生成，从主钱包转一点 |
| Lasna | ≥ 1.5 lREACT | ≥ 10 lREACT | 在 Ethereum Sepolia 上给 `0x9b9BB25f1A81078C544C829c5EB7822d747Cf434` 转 ETH，1 ETH → 100 lREACT，见[速查表](../docs/cheatsheet.md) |

> 💰 react 计费约为 `(gas_used + 100k) × gasprice`。本地实测单次 react 的 gas 是 2 万到 48 万，按 100 gwei 算，每次约 0.012–0.058 lREACT（🔎 以链上实测为准）。延迟基准每轮约 3 次 react。

```bash
cp .env.example .env      # 填 PRIVATE_KEY（可复用 starter/.env 的同一个测试私钥）

# 只跑演示：
bash bin/deploy.sh

# 演示 + 实验（建议）：池中持仓要够跑几十轮，回调预算也要够
DEMO_DEPOSIT=50000000000 CALLBACK_BUDGET=300 REACTIVE_FUND=10000000000000000000 bash bin/deploy.sh

bash bin/loop.sh          # 排队 2,000 → 还款 2,500 → Reactive 抢回 → 打印三段交易和延迟
bash bin/status.sh        # 队列、池子、Reactive 预算与欠费、Settler 余额与欠费
bash bin/trace.sh <tx>    # 给定 Base 上的触发交易，找出 Lasna react 和 Base 回调
bash bin/verify.sh        # Sourcify 开源验证（Base Sepolia 是否支持 Sourcify 🔎 待核实，备选 Basescan）
```

地址写在 `deployments/testnet.json`（入库），后续步骤都从这里读。

### 链上实测记录

> 待上链后填写：Repaid → react → ReactiveSettled 三笔交易的浏览器链接。

## 3. 实验（方案文档第 9 节）

```bash
cd bench && npm install
npm run watch                                   # 演示看板：以还款为 0 点，实时显示三段交易
npm run bench -- --rounds 30 --amount 100       # 延迟基准（不开对手）
# 抢流动性：需要 .env 里的 COMPETITOR_KEY
npm run race -- --mode reactive --delays 3,10,30 --rounds 10
npm run race -- --mode poll --poll-interval 15 --delays 3,10,30 --rounds 10   # 自动暂停/恢复 QueueReactive
npm run report -- --k 2                          # 生成 results/REPORT.md（含旧版 7s 出块推算）
```

| 脚本 | 做什么 | 关键口径 |
|---|---|---|
| `bench.ts` | 排队 → 还款(T0) → Lasna react(T1) → Base 回调(T2)，按 `originTxHash` 把三段关联起来 | 链上时间戳（整秒）+ 链下毫秒 |
| `race.ts` | 对手在还款 T 秒后取走池中全部流动性；统计金库抢到的比例；每轮清场，恢复满利用率 | 抢到率 = 金库从池里取回 ÷ 还款金额 |
| `poller.ts` | 对照组：每 P 秒检查一次，**和 QueueReactive 用同一条判定规则** | 运行时 Reactive 必须暂停 |
| `report.ts` | 中位数 / P95（nearest-rank）、抢到率表、旧版推算、Mermaid 图 | 推算明确标注“推算” |
| `devnet-relay.ts` | ⚠️ 只用于本地：模拟 Reactive 网络，验证脚本本身能跑通 | 延迟是人为设定的，没有实验意义 |

**本地冒烟测试**：`bash bin/devnet.sh` 一条命令拉起 anvil（chainId 84532）、在 `0x8888…` 放 MockSystem、部署整套合约、运行 devnet-relay，然后按提示跑 bench / race。地址写入 `deployments/devnet.json`，数据写入 `bench/results/devnet/`，都不入库，也不会碰测试网地址。

## 4. 前端看板（QueueVault Scan）

只读实时看板，不接钱包、不发交易。页面上的数字全部来自 RPC 实时读取；唯一的静态数据是构建时打包进来的 `bench/results/**/*.csv`。

| 区块 | 内容 |
|---|---|
| Live pipeline | 最近一次还款 → Lasna react → Base 回调，三个节点显示相对 T0 的耗时；进行中的节点实时计秒；下方列出这笔还款之后池子流动性被谁取走 |
| Settlement latency | 链上 E2E 中位数 / P95（nearest-rank）+ 最近 60 条链路的堆叠柱状图 |
| Queue heatmap | 最近 120 个赎回请求的状态 |
| Latest events | 两条链的事件合并，按链和类型筛选 |
| Contracts & health | 5 个合约地址、lREACT 余额、熔断窗口、订阅状态、镜像 seq 一致性 |
| Experiments | 延迟统计、抢到率表、旧版 7s 出块推算（标注「推算」） |

```bash
cd web && npm install
npm run dev            # 读 deployments/testnet.json（没有时自动退回 devnet.json），http://localhost:5174
npm run dev:devnet     # 本地：先在另一个终端跑 bash bin/devnet.sh
npm run build          # tsc 类型检查 + 打包到 web/dist（纯静态）
npm run check:abi      # 把 src/abi.ts 每个签名与 forge inspect 的输出对照
```

| 环境变量（构建时） | 默认 | 说明 |
|---|---|---|
| `VITE_NETWORK` | 有 testnet.json 用 testnet，否则 devnet | 读哪个部署文件 |
| `VITE_BASE_RPC_URL` | `https://sepolia.base.org`（devnet：`http://127.0.0.1:8546`） | 测试网上 view 调用经 Multicall3 合并 |
| `VITE_LASNA_RPC_URL` | `https://lasna-rpc.rnk.dev/` | 浏览器跨域是否放行 🔎 待核实；不放行就换一个支持 CORS 的 RPC |
| `VITE_POLL_MS` | `2000` | 增量轮询间隔；录演示视频时可以设成 `1000`，节点状态切换更跟手 |
| `VITE_LOG_CHUNK` | `5000` | 单次 getLogs 的区块跨度，公共 RPC 报范围过大时调小 |
| `VITE_LOOKBACK_BLOCKS` | `20000` | 部署文件没有 `baseBlock` / `lasnaBlock` 时往回扫的区块数 |
| `VITE_LEGACY_K` | `2` | 旧版推算 L' = L + k × 6s 里的 k |
| `VITE_REPO_URL` | 本仓库 GitHub 地址 | 页脚链接 |

**部署**：`npm run build` 之后把 `web/dist` 当静态站点发布（`base: "./"`，子路径也能用）。
- Vercel：Root Directory 选 `queue-vault/web`，Build Command 用 `npm run build`，Output 用 `dist`，在项目设置里填 `VITE_*` 变量。
- GitHub Pages：把 `dist` 推到 `gh-pages` 分支。

> 地址和实验数据都在**构建时**打包：重新部署合约或跑完实验后要重新 build。开发模式下 `deployments/` 和 `bench/results/` 有变化时页面会自动刷新。
>
> 浏览器链接：Base 用 `sepolia.basescan.org`，Lasna 用 `lasna.reactscan.net/tx/`（地址页路径 🔎 待核实）；devnet 下不生成链接。

## 5. 关键参数

| 参数 | 默认 | 依据 |
|---|---|---|
| `MAX_PER_CALLBACK`（N） | 10 | 本地实测：1 次取回 + 10 笔兑付约 36 万 gas |
| `CALLBACK_GAS_LIMIT` | 1,500,000 | 大于 100k 下限；为冷存储访问和 Proxy 记账留足余量 |
| `MIN_SETTLE_ASSETS` | 100 USDC | 触发门槛 = min(队首剩余, 100)，避免为零碎流动性付回调费 |
| `CALLBACK_BUDGET` | 30 | 回调次数上限，用完自动退订；做实验时调到 300 |
| 熔断 | 60 秒内超过 30 次 react | 自动暂停并退订，防止被刷事件耗尽 lREACT；`resume()` 手动恢复 |
| 金库缓冲 | 5% | `allocate` 后至少保留的闲置现金 |

## 6. 常见问题

| 现象 | 排查 |
|---|---|
| `trace.sh` 显示 react 未找到 | `status.sh` 看 `subscribed`、`paused`（可能熔断了）、`剩余回调次数`、`debt`；确认可兑付现金 ≥ 门槛 |
| react 有了，回调没有 | Settler 的 ETH 余额和 `proxy debt`；`CALLBACK_PROXY` 是否为当前地址 |
| 回调 revert `CallbackNotAuthorized` | Settler 构造时填的 reactive 地址不对，只能重新部署 Settler 再 `SetSettler` |
| 队首残留几 wei 一直不结清 | 正常现象：池子按秒计息，PPS 每秒都在涨，排队时锁定的金额会比报价多几 wei；下一次出现流动性时会先付清。脚本里排队用 `convertToShares`（Floor）报价，并预留 1 USDC 零头来吸收漂移 |
| 队列卡住 | 任何人都能兜底：`cast send <vault> "settleQueue(uint256)" 10` |

## 7. 局限（诚实说明）

- MockPool 是测试网模拟，只保留“流动性先到先得”这个特性，没有清算和坏账。
- Base Sepolia 的 `block.timestamp` 是整秒（约 5 个区块共用一个时间戳），链上延迟的精度是 ±1s，所以同时报告链下毫秒口径。
- 抢流动性实验里对手的延迟 T 是人为设定的，只能证明相对的时间窗口，不能代表真实市场的胜率。
- 同一区块内抢跑的 MEV 机器人比任何跨链自动化都快，不在本项目的竞争范围内。
- 金库把现金存进池子、或从池子取回时，有 1–2 wei 的舍入尘埃（ERC4626 嵌套 ERC4626 的固有现象，由不变量测试发现并量化）。
