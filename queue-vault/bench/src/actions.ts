// 实验用的链上动作：排队、还款、等队列清空、清空缓冲现金、恢复池子满利用率
import { type Ctx, USDC, ensureAllowance, ensureBalance, poll, poolAbi, read, send, vaultAbi } from "./lib.js";

/** 份额按 Floor 换算（convertToShares），保证锁定的应付金额 ≤ assets。
 *  用 previewWithdraw（Ceil）会多锁几 wei，现金刚好够时队首会残留几 wei、只能等下一次还款。 */
export async function request(ctx: Ctx, assets: bigint) {
  const shares = await read<bigint>(ctx.base, ctx.d.vault, vaultAbi, "convertToShares", [assets]);
  return send(ctx.base, ctx.main, ctx.d.vault, vaultAbi, "requestRedeem", [shares, ctx.main.address, ctx.main.address]);
}

/** 借款人还款。授权和余额在调用前准备好，这笔交易本身就是 T0 */
export async function repay(ctx: Ctx, assets: bigint) {
  return send(ctx.base, ctx.main, ctx.d.pool, poolAbi, "repay", [assets]);
}

export async function prepareBorrower(ctx: Ctx, totalRepay: bigint) {
  await ensureBalance(ctx, ctx.main, totalRepay);
  await ensureAllowance(ctx, ctx.main, ctx.d.pool, totalRepay);
}

export const pending = (ctx: Ctx) => read<bigint>(ctx.base, ctx.d.vault, vaultAbi, "pendingCount");
export const queueCash = (ctx: Ctx) => read<bigint>(ctx.base, ctx.d.vault, vaultAbi, "queueCash");
export const poolLiquidity = (ctx: Ctx) => read<bigint>(ctx.base, ctx.d.pool, poolAbi, "liquidity");

export async function waitQueueEmpty(ctx: Ctx, timeoutMs: number) {
  return poll(async () => ((await pending(ctx)) === 0n ? true : undefined), timeoutMs, 500);
}

/** 兜底：任何人都能调 settleQueue（这里用 bot 账户），保证下一轮从干净状态开始 */
export async function manualSettle(ctx: Ctx) {
  return send(ctx.base, ctx.bot, ctx.d.vault, vaultAbi, "settleQueue", [10n]);
}

/**
 * 实验前把金库的缓冲现金用掉：否则「排队」那一刻就会被缓冲兑付，测到的不是「还款 → 抢回」这条链路。
 * 做法：排队一笔等于缓冲的赎回，等 Reactive（或兜底）兑付掉。
 */
export async function drainBuffer(ctx: Ctx) {
  const cash = await queueCash(ctx);
  if (cash < 2n * USDC) return;
  // 少取 1 USDC：池子按秒计息，金库 PPS 每秒都在涨，报价到上链之间锁定金额会多出几 wei。
  // 留下的零头吸收这部分漂移，又低于触发门槛（100 USDC），不会让后续的排队立即触发回调。
  const target = cash - 1n * USDC;
  console.log(`  清空缓冲现金 ${Number(target) / 1e6} USDC（保留 1 USDC 零头）…`);
  await request(ctx, target);
  if (!(await waitQueueEmpty(ctx, 60_000))) await manualSettle(ctx);
}

/** 池子里还有剩余流动性就让借款人借走，恢复约 100% 利用率 */
export async function restoreUtilization(ctx: Ctx) {
  const liq = await poolLiquidity(ctx);
  if (liq > 0n) await send(ctx.base, ctx.main, ctx.d.pool, poolAbi, "borrow", [liq]);
}

export async function preflight(ctx: Ctx, needPosition: bigint, needDebt: bigint) {
  const position = await read<bigint>(ctx.base, ctx.d.vault, vaultAbi, "poolPosition");
  const owed = await read<bigint>(ctx.base, ctx.d.pool, poolAbi, "owed");
  const shares = await read<bigint>(ctx.base, ctx.d.vault, vaultAbi, "balanceOf", [ctx.main.address]);
  console.log(`  金库池中持仓 ${Number(position) / 1e6}，借款人欠款 ${Number(owed) / 1e6}，部署者份额 ${shares}`);
  if (position < needPosition)
    throw new Error(`金库池中持仓不足：需要 ${Number(needPosition) / 1e6} USDC。用更大的 DEMO_DEPOSIT 重新跑 SetupDemo`);
  if (owed < needDebt) throw new Error(`借款人欠款不足：需要 ${Number(needDebt) / 1e6} USDC`);
}
