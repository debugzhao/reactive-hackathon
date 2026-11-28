// 把实验期的链上事件导出成 results/history.json，前端构建时打包进去，评委打开页面就能看到完整链路和延迟图。
// 为什么需要：看板在浏览器里从新往旧回填历史，Base 每 200ms 一个块、公共 RPC 每次只能查 200 块，
// 离实验越久回填越慢（1 天约 6 分钟，1 周约 40 分钟），评委打开时延迟图多半还是空的。
//
// 导出范围：
// - Base：实验 CSV 里每笔还款所在区块附近（只扫这些区间，几百次请求就够），外加部署后第一组演示链路；
// - Lasna：QueueReactive 从部署区块到最新区块整段（每段 5,000 块，约一百次请求）。
// 导出的是原始日志（topics / data），前端用和实时扫描同一套 ABI 解码，口径完全一致；时间戳是逐块查询的精确值。
// 用法：npm run history
import { readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Hex, type Log, type PublicClient, createPublicClient, http, keccak256, toHex } from "viem";
import { RESULTS_DIR, csvRead, deployments, env } from "./lib.js";

const base = createPublicClient({ transport: http(env("BASE_RPC_URL")) }) as PublicClient;
const lasna = createPublicClient({ transport: http(env("LASNA_RPC_URL")) }) as PublicClient;
const d = deployments as typeof deployments & { baseBlock?: number; lasnaBlock?: number };

/** 看板展示的事件（与 web/src/abi.ts 一致）；其余事件（Transfer、LiquiditySnapshot 等）不导出，控制文件体积 */
const SIGS = [
  "RedeemRequested(uint256,address,address,uint256,uint256,uint64)",
  "Recalled(uint256,uint256,uint256)",
  "RecallFailed(bytes)",
  "RedeemSettled(uint256,address,uint256,uint256,bool)",
  "PayoutDeferred(uint256,address,uint256)",
  "Claimed(address,uint256)",
  "SettleSkipped(uint256,uint256)",
  "Allocated(uint256,uint256)",
  "Deposit(address,address,uint256,uint256)",
  "Repaid(address,uint256,uint256,uint64)",
  "Borrowed(address,uint256,uint256,uint64)",
  "LiquidityTaken(address,uint256,uint256,uint64)",
  "ReactiveSettled(uint256,uint8,uint256,uint256,uint256,uint256,uint256,uint64)",
  "SettleRequested(uint256,uint8,uint256,uint256,uint256,uint256)",
  "Skipped(uint256,uint8)",
  "BudgetExhausted(uint256)",
  "SubscriptionChanged(bool)",
  "CircuitBreak(uint256,uint256)",
];
const TOPICS = new Set(SIGS.map((s) => keccak256(toHex(s))));

const BASE_SPAN = 199n; // sepolia.base.org：eth_getLogs 最多 200 个区块
const LASNA_SPAN = 4_999n;

/** 简单并发池：最多 n 个请求同时在途，避免公共 RPC 429 */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        for (let attempt = 0; ; attempt++) {
          try {
            out[i] = await fn(items[i]);
            break;
          } catch (e) {
            if (attempt >= 4) throw e;
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); // 429 等临时错误：指数退避重试
          }
        }
      }
    }),
  );
  return out;
}

function chunks(from: bigint, to: bigint, span: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let f = from; f <= to; f += span + 1n) out.push([f, f + span < to ? f + span : to]);
  return out;
}

// ───────────── ① Base：从实验 CSV 定位区块区间 ─────────────
const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".csv"));
const rows = files.flatMap((f) => csvRead(resolve(RESULTS_DIR, f)));
const anchors: bigint[] = [];
for (const r of rows) {
  if (r.baseBlock0) anchors.push(BigInt(r.baseBlock0)); // 延迟基准 CSV 直接带区块号
}
const repayTxs = rows.filter((r) => !r.baseBlock0 && r.repayTx).map((r) => r.repayTx as Hex);
console.log(`📄 ${files.length} 个 CSV：${anchors.length} 个已知区块，${repayTxs.length} 笔还款待查区块…`);
anchors.push(...(await pool(repayTxs, 6, async (h) => (await base.getTransactionReceipt({ hash: h })).blockNumber)));
// 部署后第一组演示链路（README「完整链路 #1」）
if (d.baseBlock) anchors.push(BigInt(d.baseBlock) + 1_000n);

// 每个锚点前后各留余量（排队在还款前约 1 秒，回调和清场在还款后几十个区块内），相近的合并成一个区间
const PAD_BEFORE = 100n;
const PAD_AFTER = 400n;
const ranges: [bigint, bigint][] = [];
for (const b of [...anchors].sort((a, b) => (a < b ? -1 : 1))) {
  const [f, t] = [b - PAD_BEFORE, b + PAD_AFTER];
  const last = ranges[ranges.length - 1];
  if (last && f <= last[1] + 1n) last[1] = t > last[1] ? t : last[1];
  else ranges.push([f, t]);
}
if (d.baseBlock) ranges[0][0] = ranges[0][0] < BigInt(d.baseBlock) ? ranges[0][0] : BigInt(d.baseBlock);
const baseChunks = ranges.flatMap(([f, t]) => chunks(f, t, BASE_SPAN));
console.log(`🔎 Base：${ranges.length} 个区间，${baseChunks.length} 次 getLogs…`);
const baseLogs = (
  await pool(baseChunks, 4, ([f, t]) =>
    base.getLogs({ address: [d.vault, d.pool, d.settler], fromBlock: f, toBlock: t }),
  )
).flat();

// ───────────── ② Lasna：整段 ─────────────
const lasnaHead = await lasna.getBlockNumber();
const lasnaFrom = BigInt(d.lasnaBlock ?? 0);
const lasnaChunks = chunks(lasnaFrom, lasnaHead, LASNA_SPAN);
console.log(`🔎 Lasna：${lasnaFrom} → ${lasnaHead}，${lasnaChunks.length} 次 getLogs…`);
const lasnaLogs = (await pool(lasnaChunks, 4, ([f, t]) => lasna.getLogs({ address: d.reactive, fromBlock: f, toBlock: t }))).flat();

// ───────────── ③ 过滤 + 精确时间戳 ─────────────
const keep = (ls: Log[]) => ls.filter((l) => l.topics[0] && TOPICS.has(l.topics[0]));
const kept = { base: keep(baseLogs), lasna: keep(lasnaLogs) };
const tsOf = { base: new Map<bigint, number>(), lasna: new Map<bigint, number>() };
for (const [chain, client] of [
  ["base", base],
  ["lasna", lasna],
] as const) {
  const blocks = [...new Set(kept[chain].map((l) => l.blockNumber!))];
  console.log(`⏱  ${chain}：${kept[chain].length} 条事件，${blocks.length} 个区块查时间戳…`);
  const ts = await pool(blocks, 6, async (b) => Number((await client.getBlock({ blockNumber: b })).timestamp));
  blocks.forEach((b, i) => tsOf[chain].set(b, ts[i]));
}

const pack = (chain: "base" | "lasna", l: Log) => ({
  c: chain,
  a: l.address,
  t: l.topics,
  d: l.data,
  h: l.transactionHash,
  b: Number(l.blockNumber),
  i: l.logIndex,
  s: tsOf[chain].get(l.blockNumber!),
});

const out = {
  generatedAt: new Date().toISOString(),
  // 覆盖范围：前端据此只回填导出之后的区块
  coverage: {
    base: { ranges: ranges.map(([f, t]) => [Number(f), Number(t)]), to: Number(ranges[ranges.length - 1][1]) },
    lasna: { from: Number(lasnaFrom), to: Number(lasnaHead) },
  },
  logs: [...kept.base.map((l) => pack("base", l)), ...kept.lasna.map((l) => pack("lasna", l))],
};
const path = resolve(RESULTS_DIR, "history.json");
writeFileSync(path, JSON.stringify(out));
const count = (name: string) => out.logs.filter((l) => l.t[0] === keccak256(toHex(SIGS.find((s) => s.startsWith(name + "("))!))).length;
console.log(
  `✅ 已写入 ${path}：${out.logs.length} 条（Repaid ${count("Repaid")}，SettleRequested ${count("SettleRequested")}，ReactiveSettled ${count("ReactiveSettled")}）`,
);
