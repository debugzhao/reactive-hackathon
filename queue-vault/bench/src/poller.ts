// 轮询机器人（对照组）：每 P 秒查一次「有没有可兑付的现金或可抢回的流动性」，有就调 settleQueue。
// 这就是传统 keeper 的做法：需要服务器常驻、需要热钱包私钥。
// 单独运行：npm run poller -- --interval 15     （记得先在 Lasna 上 pause QueueReactive，避免两边互抢）
import { fileURLToPath } from "node:url";
import { type Ctx, USDC, arg, connect, poolAbi, read, send, vaultAbi } from "./lib.js";

const MIN_SETTLE = BigInt(process.env.MIN_SETTLE_ASSETS ?? String(100n * USDC));

export type PollerEvent = { tx: `0x${string}`; atMs: number };

export function startPoller(ctx: Ctx, intervalMs: number, onSettle?: (e: PollerEvent) => void) {
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const pending = await read<bigint>(ctx.base, ctx.d.vault, vaultAbi, "pendingCount");
      if (pending === 0n) return;
      const cash = await read<bigint>(ctx.base, ctx.d.vault, vaultAbi, "queueCash");
      const recallable = await read<bigint>(ctx.base, ctx.d.pool, poolAbi, "maxWithdraw", [ctx.d.vault]);
      // 和 QueueReactive 用同一条判定规则，对照才公平：可兑付现金 ≥ min(队首剩余, 门槛)
      const head = await read<bigint>(ctx.base, ctx.d.vault, vaultAbi, "head");
      const req = await read<{ assetsRemaining: bigint }>(ctx.base, ctx.d.vault, vaultAbi, "getRequest", [head]);
      const threshold = req.assetsRemaining < MIN_SETTLE ? req.assetsRemaining : MIN_SETTLE;
      if (cash + recallable < threshold) return;
      const { hash, seenMs } = await send(ctx.base, ctx.bot, ctx.d.vault, vaultAbi, "settleQueue", [10n]);
      onSettle?.({ tx: hash, atMs: seenMs });
    } catch (e) {
      console.error("  poller:", (e as Error).message.split("\n")[0]);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const intervalMs = Number(arg("interval", "15")) * 1000;
  const ctx = await connect();
  console.log(`🤖 轮询机器人：每 ${intervalMs / 1000}s 检查一次（Ctrl+C 退出）`);
  startPoller(ctx, intervalMs, (e) => console.log(`  ${new Date(e.atMs).toISOString()} settleQueue ${e.tx}`));
}
