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
  getEvents,
  poll,
  poolAbi,
  reactiveAbi,
  read,
  send,
  sleep,
  stamp,
  vaultAbi,
} from "./lib.js";
import { lastTickMs, startPoller } from "./poller.js";

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
  const logs = await getEvents<{ args: { lender: `0x${string}`; amount: bigint }; transactionHash: `0x${string}` }>(
    c.base,
    { address: c.d.pool, abi: poolAbi, eventName: "LiquidityTaken" },
    fromBlock,
  );
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
// Ctrl+C 时 finally 不会执行：在这里兜底恢复 Reactive，避免它一直停在暂停状态
process.once("SIGINT", async () => {
  console.log("\n  收到 Ctrl+C，正在收尾…");
  stopPoller();
  if (mode === "poll") await setReactivePaused(false).catch((e) => console.error("  恢复失败，请手动 resume():", e.message));
  process.exit(130);
});
await restoreUtilization(ctx);
await drainBuffer(ctx);

try {
  for (const delay of delays) {
    for (let i = 1; i <= rounds; i++) {
      if (!(await waitQueueEmpty(ctx, 30_000))) await manualSettle(ctx);
      await restoreUtilization(ctx);
      await request(ctx, amount);
      await sleep(1_000);

      // 轮询组：随机等待 0~P 秒再还款，让还款时刻相对轮询节拍均匀分布。
      // 否则每轮的起点由上一轮清场时那次轮询结算决定，还款会被锁在节拍的固定相位上（实测总是刚错过一次检查），结果系统性偏向某一方。
      if (mode === "poll") await sleep(Math.random() * intervalS * 1000);

      const r0 = await repay(ctx, amount);
      const t0 = r0.seenMs;
      // 还款回执到手时，离轮询机器人下一次检查还有多久（只有轮询组有意义）
      const pollWait = mode === "poll" ? intervalS * 1000 - ((t0 - lastTickMs) % (intervalS * 1000)) : "";
      const b0 = r0.receipt.blockNumber;

      // 对手：看到还款后等 delay 秒，把自己能取的全部取走
      const compDone = (async () => {
        await sleep(Math.max(0, t0 + delay * 1000 - Date.now()));
        const can = await read<bigint>(ctx.base, ctx.d.pool, poolAbi, "maxWithdraw", [competitor.address]);
        if (can === 0n) return { tx: "", atMs: Date.now() - t0 };
        try {
          const { hash, seenMs } = await send(ctx.base, competitor, ctx.d.pool, poolAbi, "withdraw", [can, competitor.address, competitor.address]);
          return { tx: hash, atMs: seenMs - t0 };
        } catch (e) {
          // 读到 maxWithdraw > 0 之后、交易执行之前，金库先把流动性取走了 → ERC4626ExceededMaxWithdraw (0xfe9cceec)。
          // 这就是「对手输了这一轮」，不是脚本错误；实际拿到多少以链上 LiquidityTaken 为准
          console.log(`    对手取款 revert（池子已被先取走）：${(e as Error).message.split("\n")[0].slice(0, 80)}`);
          return { tx: "", atMs: Date.now() - t0 };
        }
      })();
      compDone.catch(() => {}); // 兜底：避免未处理的 rejection 直接杀掉进程（那样 finally 不执行，Reactive 会停在暂停状态）

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
        poll_wait_ms: pollWait,
      };
      csvAppend(file, row);
      console.log(
        `  T=${delay}s #${i}  金库抢到 ${(row.capture * 100).toFixed(0)}%（${vaultSeen ?? "—"}ms）  对手 ${Number(taken.comp) / 1e6} USDC（${comp.atMs}ms）${pollWait === "" ? "" : `  距下次轮询 ${pollWait}ms`}`,
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
