// 延迟基准（不开对手）：排队 → 还款(T0) → Lasna react(T1) → Base 回调(T2)，循环 N 轮，写 CSV。
// 用法：npm run bench -- --rounds 30 --amount 100 --gap 5
import { drainBuffer, preflight, prepareBorrower, repay, request, restoreUtilization, waitQueueEmpty } from "./actions.js";
import {
  USDC,
  blockTs,
  connect,
  csvAppend,
  findByOrigin,
  arg,
  poll,
  reactiveAbi,
  read,
  settlerAbi,
  sleep,
  stamp,
} from "./lib.js";

const rounds = Number(arg("rounds", "30"));
const amount = BigInt(arg("amount", "100")) * USDC;
const gapMs = Number(arg("gap", "5")) * 1000;
const timeoutMs = Number(arg("timeout", "120")) * 1000;
const file = `latency-reactive-${stamp()}.csv`;

const ctx = await connect();
console.log(`⚡ 延迟基准：${rounds} 轮，每轮 ${Number(amount) / 1e6} USDC → ${file}`);
if (await read<boolean>(ctx.lasna, ctx.d.reactive, reactiveAbi, "paused")) throw new Error("QueueReactive 处于暂停状态，先 resume");

await preflight(ctx, amount * BigInt(rounds), amount * BigInt(rounds));
await prepareBorrower(ctx, amount * BigInt(rounds + 1));
await restoreUtilization(ctx);
await drainBuffer(ctx);

for (let i = 1; i <= rounds; i++) {
  if (!(await waitQueueEmpty(ctx, 30_000))) throw new Error("上一轮的队列没清空，停止（用 status.sh 排查）");
  await request(ctx, amount);
  await sleep(1_000);

  const lasnaFrom = await ctx.lasna.pub.getBlockNumber();
  const sentMs = Date.now();
  const r0 = await repay(ctx, amount); // T0
  const b0 = r0.receipt.blockNumber;

  const cb = await poll(
    () => findByOrigin(ctx.base, ctx.d.settler, settlerAbi, "ReactiveSettled", r0.hash, b0),
    timeoutMs,
  );
  const cbSeenMs = Date.now();
  const lr = await findByOrigin(ctx.lasna, ctx.d.reactive, reactiveAbi, "SettleRequested", r0.hash, lasnaFrom);

  const t0 = await blockTs(ctx.base, b0);
  const t1 = lr ? await blockTs(ctx.lasna, lr.blockNumber) : NaN;
  const t2 = cb ? await blockTs(ctx.base, cb.blockNumber) : NaN;
  const row = {
    round: i,
    status: cb ? "ok" : "timeout",
    repayTx: r0.hash,
    baseBlock0: b0,
    ts0: t0,
    lasnaTx: lr?.transactionHash ?? "",
    lasnaBlock: lr?.blockNumber ?? "",
    ts1: t1,
    callbackTx: cb?.transactionHash ?? "",
    baseBlock2: cb?.blockNumber ?? "",
    ts2: t2,
    e2e_s: t2 - t0,
    baseToLasna_s: t1 - t0,
    lasnaToBase_s: t2 - t1,
    offchain_e2e_ms: cb ? cbSeenMs - r0.seenMs : NaN,
    offchain_send_to_callback_ms: cb ? cbSeenMs - sentMs : NaN,
    recalled: cb?.args.recalled ?? 0n,
  };
  csvAppend(file, row);
  console.log(
    `  #${i} ${row.status}  链上 E2E ${row.e2e_s}s（Base→Lasna ${row.baseToLasna_s}s / Lasna→Base ${row.lasnaToBase_s}s）  链下 ${row.offchain_e2e_ms}ms`,
  );
  if (!cb) await waitQueueEmpty(ctx, 30_000);
  await sleep(gapMs);
}
console.log(`✅ 完成，运行 npm run report 生成报告`);
