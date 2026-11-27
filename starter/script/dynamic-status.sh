#!/usr/bin/env bash
# 练习 B 核验：打印 DynamicWatcher 的状态，并列出 Lasna 上每次 react 的交易和它对应的源链交易。
# 用法：bash script/dynamic-status.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

LASNA=${LASNA_RPC_URL:-https://lasna-rpc.rnk.dev/}
ORIGIN_RPC=${DYN_ORIGIN_RPC_URL:-https://sepolia.base.org}
ORIGIN_EXPLORER=${DYN_ORIGIN_EXPLORER:-https://sepolia.basescan.org}
SYSTEM=0x8888888888888888888888888888888888888888
W=$WATCHER_ADDR

echo "== DynamicWatcher (Lasna) $W"
echo "   浏览器         : https://lasna.reactscan.net/address/$W"
echo "   controlSubscribed: $(cast call -r "$LASNA" "$W" 'controlSubscribed()(bool)')"
echo "   targets()      : $(cast call -r "$LASNA" "$W" 'targets()(address[])')"
echo "   remaining(target): $(cast call -r "$LASNA" "$W" 'remaining(address)(uint256)' "$TARGET_ADDR")"
echo "   seen(target)   : $(cast call -r "$LASNA" "$W" 'seen(address)(uint256)' "$TARGET_ADDR")"
echo "   reactCount     : $(cast call -r "$LASNA" "$W" 'reactCount()(uint256)')"
echo "   balance        : $(cast balance -r "$LASNA" "$W" -e) lREACT"
echo "   debt           : $(cast call -r "$LASNA" $SYSTEM 'debt(address)(uint256)' "$W")"

# Lasna 的 eth_getLogs 每次最多跨 30,000 个区块（约 8 小时），这里查最近 20,000 个
LATEST=$(cast block-number -r "$LASNA")
FROM=$(( LATEST - ${DYN_LOOKBACK:-20000} ))

echo
echo "== 最近的 react 记录（Lasna 交易 ← 触发它的源链交易）"
for sig in \
  "Watching(address,uint256,uint256)" \
  "PingSeen(address,address,uint256,uint256,uint256)" \
  "Unwatched(address,uint8,uint256,uint256)" \
  "Ignored(address,uint8,uint256)"; do
  name=${sig%%(*}
  cast logs -r "$LASNA" --from-block "$FROM" --to-block "$LATEST" --address "$W" "$sig" --json \
    | jq -r --arg n "$name" --arg ox "$ORIGIN_EXPLORER" '.[] |
        "\(.blockNumber)\t\($n)\thttps://lasna.reactscan.net/tx/\(.transactionHash)\t← \($ox)/tx/0x\(.data[-64:])"'
done | while IFS=$'\t' read -r blk rest; do
  # blockNumber 是十六进制，转成十进制后按区块排序
  printf '%d\t%s\n' "$blk" "$rest"
done | sort -n | cut -f2-
