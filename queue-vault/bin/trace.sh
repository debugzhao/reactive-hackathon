#!/usr/bin/env bash
# 给定 Base 上触发事件的交易哈希，找出 Lasna 上的 react 和 Base 上的回调，打印三段时间戳和延迟
# 用法：bash bin/trace.sh <base 交易哈希>
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
TX=${1:?usage: trace.sh <base tx hash>}
D=${DEPLOYMENTS_FILE:-deployments/testnet.json}
REACTIVE=$(jq -r .reactive $D); SETTLER=$(jq -r .settler $D)

ts() { cast block "$1" --field timestamp -r "$2"; }

B0=$(cast receipt "$TX" blockNumber -r "$BASE_RPC_URL"); T0=$(ts "$B0" "$BASE_RPC_URL")
echo "① Base   源事件     block $B0  ts $T0  https://sepolia.basescan.org/tx/$TX"

LASNA_HEAD=$(cast block-number -r "$LASNA_RPC_URL")
L=$(cast logs --json -r "$LASNA_RPC_URL" --from-block $(( LASNA_HEAD > 3000 ? LASNA_HEAD - 3000 : 0 )) --address "$REACTIVE" \
    "SettleRequested(uint256 indexed,uint8,uint256,uint256,uint256,uint256)" "$TX" | jq -r '.[0] // empty')
if [ -z "$L" ]; then echo "② Lasna  react      未找到（还没执行，或者现金没达到门槛）"; exit 0; fi
L_TX=$(jq -r .transactionHash <<<"$L"); B1=$(cast to-dec "$(jq -r .blockNumber <<<"$L")"); T1=$(ts "$B1" "$LASNA_RPC_URL")
echo "② Lasna  react      block $B1  ts $T1  https://lasna.reactscan.net/tx/$L_TX"

BASE_HEAD=$(cast block-number -r "$BASE_RPC_URL")
S=$(cast logs --json -r "$BASE_RPC_URL" --from-block "$B0" --to-block "$BASE_HEAD" --address "$SETTLER" \
    "ReactiveSettled(uint256 indexed,uint8,uint256,uint256,uint256,uint256,uint256,uint64)" "$TX" | jq -r '.[0] // empty')
if [ -z "$S" ]; then echo "③ Base   回调       未找到（还在投递，或者 Settler 欠费）"; exit 0; fi
S_TX=$(jq -r .transactionHash <<<"$S"); B2=$(cast to-dec "$(jq -r .blockNumber <<<"$S")"); T2=$(ts "$B2" "$BASE_RPC_URL")
echo "③ Base   回调落地   block $B2  ts $T2  https://sepolia.basescan.org/tx/$S_TX"
echo "⏱  Base→Lasna $((T1 - T0))s · Lasna→Base $((T2 - T1))s · 端到端 $((T2 - T0))s（链上时间戳为整秒，精度 ±1s）"
