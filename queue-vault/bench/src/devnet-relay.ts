// ⚠️ 仅用于本地 anvil 冒烟测试：模拟 Reactive 网络，验证 bench / race / watch 脚本本身能跑通。
// 它产生的「延迟」是人为设定的，没有任何实验意义；数据写在 results/devnet/，不入库。
// 前提：anvil 上已用 anvil_setCode 把 MockSystem 放到 0x8888…，并用部署脚本部署了整套合约。
// 做的事：① 把订阅命中的日志以 SYSTEM 身份喂给 react()；② 把 MockSystem 记下的回调请求以 Proxy 身份投递给 Settler。
import { type Address, type Hex, concat, createWalletClient, http, keccak256, parseAbi, slice, toHex } from "viem";
import { connect, sleep } from "./lib.js";

const SYSTEM: Address = "0x8888888888888888888888888888888888888888";
const REACT_DELAY = Number(process.env.DEVNET_REACT_DELAY_MS ?? 800);
const CALLBACK_DELAY = Number(process.env.DEVNET_CALLBACK_DELAY_MS ?? 800);

const ctx = await connect();
const pub = ctx.base.pub;
if ((await pub.getChainId()) !== 84532 || !ctx.base.rpc.includes("127.0.0.1")) throw new Error("devnet-relay 只能连本地 anvil");

const sysAbi = parseAbi([
  "function requestCount() view returns (uint256)",
  "function request(uint256 i) view returns ((uint256 chainId, address recipient, uint64 gasLimit, bytes payload))",
]);
const reactAbi = parseAbi([
  "function react((uint256 chainId, address contractAddress, uint256 topic0, uint256 topic1, uint256 topic2, uint256 topic3, bytes data, uint256 blockNumber, uint256 opCode, uint256 blockHash, uint256 txHash, uint256 logIndex) log_)",
]);
const proxy = (await pub.readContract({
  address: ctx.d.settler,
  abi: parseAbi(["function _SERVICE_PROVIDER() view returns (address)"]),
  functionName: "_SERVICE_PROVIDER",
})) as Address;

const snapTopic = keccak256(
  toHex("LiquiditySnapshot(bool,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint64)"),
);
const repaidTopic = keccak256(toHex("Repaid(address,uint256,uint256,uint64)"));

async function impersonate(a: Address) {
  await pub.request({ method: "anvil_impersonateAccount" as never, params: [a] as never });
  await pub.request({ method: "anvil_setBalance" as never, params: [a, "0x56BC75E2D63100000"] as never });
  return createWalletClient({ account: a, chain: ctx.base.chain, transport: http(ctx.base.rpc) });
}
const asSystem = await impersonate(SYSTEM);
const asProxy = await impersonate(proxy);

let cursor = await pub.getBlockNumber();
let delivered = (await pub.readContract({ address: SYSTEM, abi: sysAbi, functionName: "requestCount" })) as bigint;
console.log(`🧪 devnet-relay 运行中（react 延迟 ${REACT_DELAY}ms，回调延迟 ${CALLBACK_DELAY}ms）`);

for (;;) {
  const head = await pub.getBlockNumber();
  if (head >= cursor) {
    const logs = await pub.getLogs({ address: [ctx.d.vault, ctx.d.pool], fromBlock: cursor, toBlock: head });
    cursor = head + 1n;
    for (const l of logs) {
      const hit =
        (l.address.toLowerCase() === ctx.d.vault.toLowerCase() && l.topics[0] === snapTopic && BigInt(l.topics[1]!) === 1n) ||
        (l.address.toLowerCase() === ctx.d.pool.toLowerCase() && l.topics[0] === repaidTopic);
      if (!hit) continue;
      await sleep(REACT_DELAY);
      const t = (i: number) => (l.topics[i] ? BigInt(l.topics[i]!) : 0n);
      await asSystem.writeContract({
        address: ctx.d.reactive,
        abi: reactAbi,
        functionName: "react",
        args: [
          {
            chainId: 84532n,
            contractAddress: l.address,
            topic0: t(0),
            topic1: t(1),
            topic2: t(2),
            topic3: t(3),
            data: l.data,
            blockNumber: l.blockNumber!,
            opCode: BigInt(l.topics.length + 1),
            blockHash: BigInt(l.blockHash!),
            txHash: BigInt(l.transactionHash!),
            logIndex: BigInt(l.logIndex!),
          },
        ],
        chain: ctx.base.chain,
        account: SYSTEM,
      });
    }
  }
  const count = (await pub.readContract({ address: SYSTEM, abi: sysAbi, functionName: "requestCount" })) as bigint;
  for (; delivered < count; delivered++) {
    const cfg = (await pub.readContract({ address: SYSTEM, abi: sysAbi, functionName: "request", args: [delivered] })) as {
      recipient: Address;
      gasLimit: bigint;
      payload: Hex;
    };
    await sleep(CALLBACK_DELAY);
    // 和真实 Proxy 一样：把 payload 的首个 address 参数替换成 Reactive 合约地址
    const data = concat([slice(cfg.payload, 0, 4), toHex(BigInt(ctx.d.reactive), { size: 32 }), slice(cfg.payload, 36)]);
    await asProxy.sendTransaction({ to: cfg.recipient, data, gas: cfg.gasLimit, chain: ctx.base.chain, account: proxy });
  }
  await sleep(200);
}
