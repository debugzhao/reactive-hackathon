#!/usr/bin/env bash
# 跑一遍演示链路：排队 2,000 → 等缓冲兑付 → 还款 2,500 → 等 Reactive 抢回并兑付 → 打印三段交易
# 用法：bash bin/loop.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

forge script script/Deploy.s.sol:RequestRedeem --rpc-url "$BASE_RPC_URL" --broadcast --slow
echo "⏳ 等 30 秒，让 Reactive 先用缓冲现金部分兑付…"; sleep 30
bash bin/status.sh

forge script script/Deploy.s.sol:Repay --rpc-url "$BASE_RPC_URL" --broadcast --slow
REPAY_TX=$(jq -r '.transactions[] | select(.function=="repay(uint256)") | .hash' broadcast/Deploy.s.sol/84532/run-latest.json)
echo "💸 还款交易：$REPAY_TX"
echo "⏳ 等 30 秒，让 Reactive 抢回流动性…"; sleep 30
bash bin/trace.sh "$REPAY_TX"
bash bin/status.sh
