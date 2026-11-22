#!/usr/bin/env bash
# 合约开源验证：Base Sepolia 与 Lasna 都走 Sourcify（Lasna 的做法见 docs/cheatsheet.md）。
# 构造参数用 --guess-constructor-args 从链上创建交易里还原，不用手抄。
# 如果 Sourcify 不支持 Base Sepolia，可设 ETHERSCAN_API_KEY 后改用：--verifier etherscan
# 用法：bash bin/verify.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
D=${DEPLOYMENTS_FILE:-deployments/testnet.json}

v() { # v <链ID> <RPC> <地址> <合约路径:名称>
  echo "── $4 @ $3"
  forge verify-contract --verifier sourcify --chain-id "$1" --rpc-url "$2" --guess-constructor-args \
    --watch "$3" "$4" || echo "   ⚠️ 验证失败，见上方输出"
}

v 84532   "$BASE_RPC_URL"  "$(jq -r .usdc $D)"     src/MockUSDC.sol:MockUSDC
v 84532   "$BASE_RPC_URL"  "$(jq -r .pool $D)"     src/MockPool.sol:MockPool
v 84532   "$BASE_RPC_URL"  "$(jq -r .vault $D)"    src/QueueVault.sol:QueueVault
v 84532   "$BASE_RPC_URL"  "$(jq -r .settler $D)"  src/QueueSettler.sol:QueueSettler
v 5318007 "$LASNA_RPC_URL" "$(jq -r .reactive $D)" src/QueueReactive.sol:QueueReactive
