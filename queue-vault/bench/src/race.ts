// 抢流动性实验：还款后，对手在 T 秒后取走池中全部流动性；看我方（Reactive 或轮询机器人）抢到多少。
// 用法：
//   npm run race -- --mode reactive --delays 3,10,30 --rounds 10 --amount 100
//   npm run race -- --mode poll --poll-interval 15 --delays 3,10,30 --rounds 10 --amount 100
// 需要 COMPETITOR_KEY（另一个测试 EOA，在 Base Sepolia 上有少量 ETH）。
// 判定标准在实验前写好（方案文档 9.5）：抢到率 = 金库本轮从池里取回的金额 ÷ 还款金额。
import { manualSettle, pending, prepareBorrower, preflight, repay, request, restoreUtilization, waitQueueEmpty, drainBuffer } from "./actions.js";
import {
  type Ctx,
  USDC,
  arg,
  connect,
  csvAppend,
  ensureAllowance,
  ensureBalance,
  poll,
  poolAbi,
  reactiveAbi,
  read,
  send,
  sleep,
  stamp,
  vaultAbi,
} from "./lib.js";
import { startPoller } from "./poller.js";

const mode = arg("mode", "reactive");
const intervalS = Number(arg("poll-interval", "15"));
const delays = arg("delays", "3,10,30").split(",").map(Number);
const rounds = Number(arg("rounds", "10"));
const amount = BigInt(arg("amount", "100")) * USDC;
const label = mode === "poll" ? `poll${intervalS}s` : "reactive";
const file = `race-${label}-${stamp()}.csv`;

const ctx = await connect();
if (!ctx.competitor) throw new Error("缺少 COMPETITOR_KEY：对手需要一个独立的测试 EOA");
const competitor = ctx.competitor;

async function setReactivePaused(want: boolean) {
  const paused = await read<boolean>(ctx.lasna, ctx.d.reactive, reactiveAbi, "paused");
  if (paused === want) return;
  console.log(want ? "  ⏸  暂停 QueueReactive（对照组期间不让 Reactive 参与）" : "  ▶️  恢复 QueueReactive");
  await send(ctx.lasna, ctx.main, ctx.d.reactive, reactiveAbi, want ? "pause" : "resume");
}

async function takenSince(c: Ctx, fromBlock: bigint) {
  const logs = (await c.base.pub.getContractEvents({
    address: c.d.pool,
    abi: poolAbi,
    eventName: "LiquidityTaken",
    fromBlock,
    toBlock: "latest",
  })) as unknown as { args: { lender: `0x${string}`; amount: bigint }; transactionHash: `0x${string}` }[];
  let vault = 0n;
  let comp = 0n;
  let vaultTx = "";
  for (const l of logs) {
    if (l.args.lender.toLowerCase() === c.d.vault.toLowerCase()) {
      vault += l.args.amount;
      vaultTx ||= l.transactionHash;
    } else if (l.args.lender.toLowerCase() === competitor.address.toLowerCase()) comp += l.args.amount;
  }
  return { vault, comp, vaultTx };
}

console.log(`🏁 抢流动性实验：${label}，对手延迟 ${delays.join("/")}s，每格 ${rounds} 轮 → ${file}`);
const total = amount * BigInt(delays.length * rounds);
await preflight(ctx, total, total);
await prepareBorrower(ctx, total * 2n);
// 对手在池里要有足够仓位，才能每轮都「想要全部」
await ensureBalance(ctx, competitor, amount * 20n);
await ensureAllowance(ctx, competitor, ctx.d.pool, amount * 20n);
const compPos = await read<bigint>(ctx.base, ctx.d.pool, poolAbi, "maxWithdraw", [competitor.address]);
if (compPos === 0n) await send(ctx.base, competitor, ctx.d.pool, poolAbi, "deposit", [amount * 10n, competitor.address]);

await setReactivePaused(mode === "poll");
const stopPoller = mode === "poll" ? startPoller(ctx, intervalS * 1000) : () => {};
await restoreUtilization(ctx);
await drainBuffer(ctx);

try {
  for (const delay of delays) {
    for (let i = 1; i <= rounds; i++) {
      if (!(await waitQueueEmpty(ctx, 30_000))) await manualSettle(ctx);
      await restoreUtilization(ctx);
      await request(ctx, amount);
      await sleep(1_000);

      const r0 = await repay(ctx, amount);
      const t0 = r0.seenMs;
      const b0 = r0.receipt.blockNumber;

      // 对手：看到还款后等 delay 秒，把自己能取的全部取走
      const compDone = (async () => {
        await sleep(Math.max(0, t0 + delay * 1000 - Date.now()));
        const can = await read<bigint>(ctx.base, ctx.d.pool, poolAbi, "maxWithdraw", [competitor.address]);
        if (can === 0n) return { tx: "", atMs: Date.now() - t0 };
        const { hash, seenMs } = await send(ctx.base, competitor, ctx.d.pool, poolAbi, "withdraw", [can, competitor.address, competitor.address]);
        return { tx: hash, atMs: seenMs - t0 };
      })();

      // 我方：等到金库从池里取回（或窗口结束）
      const windowMs = delay * 1000 + (mode === "poll" ? intervalS * 1000 : 0) + 30_000;
      const vaultSeen = await poll(async () => {
        const t = await takenSince(ctx, b0);
        return t.vault > 0n ? Date.now() - t0 : undefined;
      }, windowMs);
      const comp = await compDone;
      const taken = await takenSince(ctx, b0);

      const row = {
        mode: label,
        delay_s: delay,
        round: i,
        repayTx: r0.hash,
        amount: amount,
        vaultGot: taken.vault,
        competitorGot: taken.comp,
        capture: Number(taken.vault) / Number(amount),
        vaultRecallTx: taken.vaultTx,
        vaultSeen_ms: vaultSeen ?? "",
        competitorTx: comp.tx,
        competitor_ms: comp.atMs,
      };
      csvAppend(file, row);
      console.log(
        `  T=${delay}s #${i}  金库抢到 ${(row.capture * 100).toFixed(0)}%（${vaultSeen ?? "—"}ms）  对手 ${Number(taken.comp) / 1e6} USDC（${comp.atMs}ms）`,
      );

      // 清场：没抢到的部分由借款人补还、兜底结算；对手把拿到的钱存回去，保持仓位不变
      if ((await pending(ctx)) > 0n) {
        const queued = await read<bigint>(ctx.base, ctx.d.vault, vaultAbi, "totalQueuedAssets");
        const cash = await read<bigint>(ctx.base, ctx.d.vault, vaultAbi, "queueCash");
        if (queued > cash) await repay(ctx, queued - cash);
        if (!(await waitQueueEmpty(ctx, 15_000))) await manualSettle(ctx);
      }
      if (taken.comp > 0n) await send(ctx.base, competitor, ctx.d.pool, poolAbi, "deposit", [taken.comp, competitor.address]);
      await sleep(3_000);
    }
  }
} finally {
  stopPoller();
  if (mode === "poll") await setReactivePaused(false);
}
console.log(`✅ 完成，运行 npm run report 生成报告`);
