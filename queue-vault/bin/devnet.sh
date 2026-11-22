#!/usr/bin/env bash
# 本地冒烟测试环境：anvil（chainId 84532）+ 0x8888 上放 MockSystem + 整套合约 + devnet-relay 模拟 Reactive。
# 只用来验证脚本能跑通；产生的延迟是人为设定的，没有实验意义。地址写入 deployments/devnet.json，不碰测试网地址。
# 用法：bash bin/devnet.sh        然后按提示在另一个终端跑 bench / race / watch
set -euo pipefail
cd "$(dirname "$0")/.."
RPC=http://127.0.0.1:8546
MNEMONIC="test test test test test test test test test test test junk"   # anvil 公开的测试助记词，只用于本地链

pkill -f "[a]nvil --chain-id 84532 --port 8546" 2>/dev/null || true
anvil --chain-id 84532 --port 8546 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null; pkill -f "[d]evnet-relay.ts" 2>/dev/null || true' EXIT
sleep 2
cast rpc anvil_setCode 0x8888888888888888888888888888888888888888 \
  "$(forge inspect test/Integration.t.sol:MockSystem deployedBytecode)" -r "$RPC" >/dev/null

export PRIVATE_KEY=$(cast wallet private-key "$MNEMONIC" 0)
export BASE_RPC_URL=$RPC LASNA_RPC_URL=$RPC DEPLOYMENTS_FILE=deployments/devnet.json DEMO_DEPOSIT=50000000000
for s in DeployBase DeployReactive DeploySettler SetSettler SetupDemo; do
  forge script "script/Deploy.s.sol:$s" --rpc-url "$RPC" --broadcast --slow >/dev/null && echo "✅ $s"
done

cat <<MSG

🧪 本地链已就绪。另开一个终端，在 queue-vault/bench 下执行：
   export BASE_RPC_URL=$RPC LASNA_RPC_URL=$RPC DEPLOYMENTS=deployments/devnet.json RESULTS_DIR=results/devnet
   export PRIVATE_KEY=$PRIVATE_KEY COMPETITOR_KEY=$(cast wallet private-key "$MNEMONIC" 1)
   npm run bench -- --rounds 3 --gap 1
   npm run race -- --mode reactive --delays 1,6 --rounds 2
   npm run race -- --mode poll --poll-interval 4 --delays 1,6 --rounds 2
   npm run report

devnet-relay 在前台运行（Ctrl+C 结束并关闭 anvil）…
MSG
cd bench && DEPLOYMENTS=deployments/devnet.json npx tsx src/devnet-relay.ts
