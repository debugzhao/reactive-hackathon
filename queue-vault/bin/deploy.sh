#!/usr/bin/env bash
# 一条命令部署整条链路：Base（金库 + 池子）→ Lasna（Reactive）→ Base（Settler）→ Lasna（绑定）→ Base（演示状态）
# 用法：bash bin/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

run() {
  echo; echo "══════ $1  ($2)"
  forge script "script/Deploy.s.sol:$1" --rpc-url "$2" --broadcast --slow
}

run DeployBase     "$BASE_RPC_URL"
run DeployReactive "$LASNA_RPC_URL"
run DeploySettler  "$BASE_RPC_URL"
run SetSettler     "$LASNA_RPC_URL"
run SetupDemo      "$BASE_RPC_URL"

echo; echo "✅ 部署完成，地址已写入 deployments/testnet.json："
cat "${DEPLOYMENTS_FILE:-deployments/testnet.json}"
