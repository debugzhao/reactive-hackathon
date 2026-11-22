# ⚡ QueueVault Scan

Read-only live dashboard for **queue-vault**, an instant-settle withdrawal queue built on Reactive Network (Reactive Omni Buildathon · Track 1 "Every Second Counts").
只读实时看板，配合合约仓库 [reactive-hackathon](https://github.com/debugzhao/reactive-hackathon) 使用。

- 不接钱包、不发交易，所有数字都通过 RPC 实时读取自链上
- 唯一的静态数据是构建时打包进来的实验 CSV
- 中英文切换：右上角切换，或在 URL 上加 `?lang=zh` / `?lang=en`

## 仓库关系

本仓库以 git submodule 的形式挂在合约仓库的 `queue-vault/web` 下，并在**构建时**读取上一级目录的数据：

| 路径（相对本仓库） | 内容 | 缺失时 |
|---|---|---|
| `../deployments/{testnet,devnet}.json` | 合约地址 + 起始区块（部署脚本写入） | 页面显示「未找到部署」 |
| `../bench/results/**/*.csv` | 延迟基准、抢流动性实验数据 | 实验卡片显示生成命令 |
| `../src/*.sol` | `npm run check:abi` 对照用 | 该脚本无法运行 |

所以请在合约仓库里使用：

```bash
git clone --recursive https://github.com/debugzhao/reactive-hackathon.git
cd reactive-hackathon/queue-vault/web && npm install
```

已经 clone 过合约仓库的话：

```bash
git submodule update --init queue-vault/web
```

## 启动

```bash
npm run dev            # 读 ../deployments/testnet.json（没有时自动退回 devnet.json）
npm run dev:devnet     # 本地链：先在 queue-vault/ 下运行 bash bin/devnet.sh
npm run build          # 类型检查 + 打包到 dist/（纯静态，可部署到 Vercel / GitHub Pages）
npm run check:abi      # 对照 src/abi.ts 与 forge inspect 的输出（需要 foundry）
```

环境变量（`VITE_NETWORK`、`VITE_BASE_RPC_URL`、`VITE_LASNA_RPC_URL`、`VITE_POLL_MS` 等）见合约仓库 `queue-vault/README.md` 的「前端看板」一节。
