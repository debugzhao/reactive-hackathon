#!/usr/bin/env bash
# 一条命令看清三个合约是否「活着」：队列状态、池子流动性、Reactive 预算与欠费、Settler 余额与欠费
# 用法：bash bin/status.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
D=${DEPLOYMENTS_FILE:-deployments/testnet.json}
VAULT=$(jq -r .vault $D); POOL=$(jq -r .pool $D); REACTIVE=$(jq -r .reactive $D); SETTLER=$(jq -r .settler $D)
SYSTEM=0x8888888888888888888888888888888888888888
b() { cast call "$1" "$2" -r "$BASE_RPC_URL" | awk '{print $1}'; }
l() { cast call "$1" "$2" -r "$LASNA_RPC_URL" | awk '{print $1}'; }
u() { echo "scale=2; $1 / 1000000" | bc; }

echo "== Base  QueueVault $VAULT"
echo "   head / tail      : $(b "$VAULT" 'head()(uint256)') / $(b "$VAULT" 'tail()(uint256)')"
echo "   排队负债 (USDC)  : $(u "$(b "$VAULT" 'totalQueuedAssets()(uint256)')")"
echo "   可兑付现金       : $(u "$(b "$VAULT" 'queueCash()(uint256)')")"
echo "   池中持仓         : $(u "$(b "$VAULT" 'poolPosition()(uint256)')")"
echo "== Base  MockPool   $POOL"
echo "   池内流动性       : $(u "$(b "$POOL" 'liquidity()(uint256)')")"
echo "   借款人欠款       : $(u "$(b "$POOL" 'owed()(uint256)')")"
echo "== Lasna QueueReactive $REACTIVE"
echo "   subscribed/paused: $(l "$REACTIVE" 'subscribed()(bool)') / $(l "$REACTIVE" 'paused()(bool)')"
echo "   剩余回调次数     : $(l "$REACTIVE" 'remainingCallbacks()(uint256)')"
echo "   react / callback : $(l "$REACTIVE" 'reactCount()(uint256)') / $(l "$REACTIVE" 'callbackCount()(uint256)')"
echo "   余额 (lREACT)    : $(cast balance "$REACTIVE" -r "$LASNA_RPC_URL" -e)"
echo "   debt             : $(cast call "$SYSTEM" 'debt(address)(uint256)' "$REACTIVE" -r "$LASNA_RPC_URL" | awk '{print $1}')"
echo "   浏览器           : https://lasna.reactscan.net/address/$REACTIVE"
echo "== Base  QueueSettler $SETTLER"
echo "   余额 (ETH)       : $(cast balance "$SETTLER" -r "$BASE_RPC_URL" -e)"
echo "   proxy debt       : $(cast call "$CALLBACK_PROXY" 'debt(address)(uint256)' "$SETTLER" -r "$BASE_RPC_URL" | awk '{print $1}')"
