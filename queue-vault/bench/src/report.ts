// 读 results/ 下所有 CSV，生成 results/REPORT.md：延迟表、抢流动性表、旧版 7s 出块推算、Mermaid 图。
// 用法：npm run report -- --k 2      （k = 链路经过的 Reactive 区块数，用于旧版推算，见方案文档 9.5）
//
// 口径说明（为什么主指标用「Base 区块差」）：
// - Base Sepolia 每 200ms 一个区块，但 block.timestamp 是整秒，整秒相减只有 ±1s 精度；
// - 跨链时间戳相减（Base→Lasna、Lasna→Base）会受两条链各自取整和时钟偏差影响，实测出现负数，单段没有意义；
// - 链下毫秒是「脚本通过公共 RPC 看到交易」的时间，包含 RPC 往返和轮询间隔，实测比链上慢约 4 秒，只能作参考。
// 所以端到端和「我方取回耗时」都以同一条链上的区块号之差 × 200ms 为主。
import { readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { type Hex, createPublicClient, http } from "viem";
import { RESULTS_DIR, ROOT, arg, csvRead, env, median, percentile } from "./lib.js";

const k = Number(arg("k", "2"));
const OLD_BLOCK_S = 7;
/** Base Sepolia 出块间隔：实测 815 个区块跨 163 秒（2026-11-28 延迟基准数据） */
const BASE_BLOCK_S = 0.2;

const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".csv"));
const rows = (prefix: string) => files.filter((f) => f.startsWith(prefix)).flatMap((f) => csvRead(resolve(RESULTS_DIR, f)));
// 空字符串表示「没有发生」（例如没抢到时没有取回交易），不能当成 0
const num = (xs: Record<string, string>[], key: string) =>
  xs.map((r) => (r[key] === "" || r[key] === undefined ? NaN : Number(r[key]))).filter((x) => Number.isFinite(x));
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const statRow = (name: string, xs: number[], fmt = f1) =>
  `| ${name} | ${fmt(median(xs))} | ${fmt(percentile(xs, 95))} | ${fmt(Math.min(...xs))} | ${fmt(Math.max(...xs))} |`;

const out: string[] = [];
out.push("# 📊 实验报告（自动生成，请勿手改）", "");
out.push(`> 生成时间：${new Date().toISOString()} · 数据目录：\`${relative(ROOT, RESULTS_DIR)}\``);
out.push(
  `> **主指标 = Base 区块差 × ${BASE_BLOCK_S * 1000}ms**（同一条链、精度 0.2s）。整秒时间戳精度 ±1s；跨链单段受两条链时钟偏差影响，可能为负，仅供参考；链下毫秒含公共 RPC 往返，只作参考。`,
  "",
);

// ───────────── 延迟 ─────────────
const lat = rows("latency-").filter((r) => r.status === "ok");
const all = rows("latency-");
const e2eBlocks = lat.map((r) => Number(r.baseBlock2) - Number(r.baseBlock0)).filter(Number.isFinite);
const e2eBlockS = e2eBlocks.map((b) => b * BASE_BLOCK_S);
out.push("## 1. 端到端延迟（Reactive Omni）：还款 → Lasna react → Base 回调", "");
if (lat.length === 0) out.push("_还没有数据：运行 `npm run bench`_", "");
else {
  out.push(`样本 ${lat.length} 个（超时 ${all.length - lat.length} 个）。P95 用 nearest-rank，n 较小时不稳定。`, "");
  out.push("| 指标 | 中位数 | P95 | 最小 | 最大 |", "|---|---|---|---|---|");
  out.push(statRow("⭐ Base 区块差（块）", e2eBlocks, (x) => (Number.isFinite(x) ? String(x) : "—")));
  out.push(statRow("⭐ 链上 E2E ≈ 区块差 × 0.2（秒）", e2eBlockS));
  out.push(statRow("链上 E2E，整秒时间戳（秒，±1s）", num(lat, "e2e_s")));
  out.push(statRow("Base → Lasna，跨链时间戳（秒，仅参考）", num(lat, "baseToLasna_s")));
  out.push(statRow("Lasna → Base，跨链时间戳（秒，仅参考）", num(lat, "lasnaToBase_s")));
  out.push(statRow("链下 E2E，脚本观察（毫秒，含 RPC）", num(lat, "offchain_e2e_ms")));
  const missing = lat.filter((r) => r.lasnaTx === "").length;
  if (missing)
    out.push(
      "",
      `> ${missing} 个样本缺 Lasna 段：脚本看到回调后只查了一次 Lasna，公共 RPC 当时还没索引到日志（react 本身存在）。不影响 E2E。`,
    );
  out.push("", "前 3 个样本的浏览器链接：", "");
  for (const r of lat.slice(0, 3))
    out.push(
      `- 还款 [${r.repayTx.slice(0, 10)}…](https://sepolia.basescan.org/tx/${r.repayTx}) → react [${r.lasnaTx.slice(0, 10)}…](https://lasna.reactscan.net/tx/${r.lasnaTx}) → 回调 [${r.callbackTx.slice(0, 10)}…](https://sepolia.basescan.org/tx/${r.callbackTx})（${Number(r.baseBlock2) - Number(r.baseBlock0)} 块）`,
    );
  out.push("");
}

// ───────────── 抢流动性 ─────────────
const race = rows("race-");
const modes = [...new Set(race.map((r) => r.mode))].sort((a) => (a === "reactive" ? -1 : 1));
const delays = [...new Set(race.map((r) => Number(r.delay_s)))].sort((a, b) => a - b);
out.push("## 2. 抢流动性实验：还款后，金库和对手谁先从池子取走这笔流动性", "");
if (race.length === 0) out.push("_还没有数据：运行 `npm run race`_", "");
else {
  // 金库取回交易与还款交易的区块差：链上口径的「我方取回耗时」
  const base = createPublicClient({ transport: http(env("BASE_RPC_URL")) });
  const blockOf = new Map<string, bigint>();
  const txs = [...new Set(race.flatMap((r) => [r.repayTx, r.vaultRecallTx]).filter(Boolean))];
  for (let i = 0; i < txs.length; i += 8)
    await Promise.all(
      txs.slice(i, i + 8).map(async (h) => blockOf.set(h, (await base.getTransactionReceipt({ hash: h as Hex })).blockNumber)),
    );
  const recallBlocks = (xs: Record<string, string>[]) =>
    xs.filter((r) => r.vaultRecallTx).map((r) => Number(blockOf.get(r.vaultRecallTx)! - blockOf.get(r.repayTx)!));

  const cell = (m: string, d: number) => race.filter((r) => r.mode === m && Number(r.delay_s) === d);
  const capture = (xs: Record<string, string>[]) => num(xs, "capture").reduce((a, b) => a + b, 0) / xs.length;
  const pct = (xs: Record<string, string>[]) => (xs.length ? `${(capture(xs) * 100).toFixed(0)}%（${xs.length}）` : "—（0）");

  out.push("**平均抢到率**（金库取回 ÷ 还款金额；括号内为样本数，「—」表示还没跑）", "");
  out.push(`| 方案 | ${delays.map((d) => `对手 T=${d}s`).join(" | ")} |`, `|---|${delays.map(() => "---").join("|")}|`);
  for (const m of modes) out.push(`| ${m}（实测） | ${delays.map((d) => pct(cell(m, d))).join(" | ")} |`);

  // 推算：用实测的链上 E2E 分布 L（区块差口径），旧版 L' = L + k × (7 − 1) 秒，L' < T 记为抢到
  if (e2eBlockS.length) {
    const est = (d: number) => (e2eBlockS.filter((x) => x + k * (OLD_BLOCK_S - 1) < d).length / e2eBlockS.length) * 100;
    out.push(`| 旧版约 7s 出块（**推算**，k=${k}） | ${delays.map((d) => `${est(d).toFixed(0)}%`).join(" | ")} |`);
    out.push(
      "",
      `> 推算方法：实测链上 E2E（区块差口径）每个样本加上 k × (7 − 1) = ${k * (OLD_BLOCK_S - 1)} 秒，小于 T 记为抢到。是推算，不是实测。`,
    );
  }

  out.push("", "**我方取回耗时**（还款交易 → 金库从池子取回交易，⭐ 链上区块差；中位数）", "");
  out.push(`| 方案 | ${delays.map((d) => `T=${d}s`).join(" | ")} |`, `|---|${delays.map(() => "---").join("|")}|`);
  for (const m of modes)
    out.push(
      `| ${m} | ${delays
        .map((d) => {
          const b = recallBlocks(cell(m, d));
          return b.length ? `${median(b)} 块 ≈ ${f2(median(b) * BASE_BLOCK_S)}s（n=${b.length}）` : "—";
        })
        .join(" | ")} |`,
    );
  out.push("", "参考：脚本通过公共 RPC 看到取回交易的链下耗时中位数（毫秒，含 RPC 往返，比链上慢约 4 秒）", "");
  out.push(`| 方案 | ${delays.map((d) => `T=${d}s`).join(" | ")} |`, `|---|${delays.map(() => "---").join("|")}|`);
  for (const m of modes) out.push(`| ${m} | ${delays.map((d) => f1(median(num(cell(m, d), "vaultSeen_ms")))).join(" | ")} |`);

  // 轮询组：按「还款时距下一次轮询还有多久」分桶，证明相位是随机的，并解释输赢
  const poll = race.filter((r) => r.mode.startsWith("poll") && r.poll_wait_ms !== undefined && r.poll_wait_ms !== "");
  if (poll.length) {
    const buckets = [0, 3, 6, 9, 12, 15];
    out.push("", "**轮询组：抢到率 × 还款时距下一次轮询的等待时间**（相位已随机化）", "");
    out.push(`| T | ${buckets.slice(0, -1).map((b, i) => `${b}–${buckets[i + 1]}s`).join(" | ")} |`, `|---|${buckets.slice(0, -1).map(() => "---").join("|")}|`);
    for (const d of delays) {
      const xs = poll.filter((r) => Number(r.delay_s) === d);
      if (!xs.length) continue;
      out.push(
        `| ${d}s | ${buckets
          .slice(0, -1)
          .map((b, i) => {
            const inB = xs.filter((r) => Number(r.poll_wait_ms) / 1000 >= b && Number(r.poll_wait_ms) / 1000 < buckets[i + 1]);
            return inB.length ? `${(capture(inB) * 100).toFixed(0)}%（${inB.length}）` : "—";
          })
          .join(" | ")} |`,
      );
    }
  }

  for (const d of delays) {
    const ms = modes.filter((m) => cell(m, d).length);
    out.push("", "```mermaid", "xychart-beta", `    title "对手 T=${d}s 时的平均抢到率（%）"`);
    out.push(`    x-axis [${ms.map((m) => `"${m}"`).join(", ")}]`, '    y-axis "抢到率 %" 0 --> 100');
    out.push(`    bar [${ms.map((m) => (capture(cell(m, d)) * 100).toFixed(0)).join(", ")}]`, "```");
  }
  out.push("");
}

out.push("## 3. 解读规则（实验前写定，见方案文档 9.5）", "");
out.push("- Omni 在 T ≥ X 秒时稳定抢到，而旧版推算和轮询在同样的 T 下抢不到 → 证明存在只有 Omni 级速度能进入的时间窗口。");
out.push("- Omni 与轮询 15s 差别不大 → 如实报告，把 T 调小再测，或分析瓶颈在哪一段。");
out.push("- 局限：对手延迟 T 是人为设定的，只证明相对时间窗口；同区块 MEV 抢跑不在比较范围内。");

writeFileSync(resolve(RESULTS_DIR, "REPORT.md"), out.join("\n") + "\n");
console.log(`📝 已生成 ${resolve(RESULTS_DIR, "REPORT.md")}`);
