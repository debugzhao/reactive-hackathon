// 读 results/ 下所有 CSV，生成 results/REPORT.md：延迟表（中位数 / P95）、抢流动性表、旧版 7s 出块推算、Mermaid 图。
// 用法：npm run report -- --k 2      （k = 链路经过的 Reactive 区块数，用于旧版推算，见方案文档 9.5）
import { readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RESULTS_DIR, arg, csvRead, median, percentile } from "./lib.js";

const k = Number(arg("k", "2"));
const OLD_BLOCK_S = 7;
const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".csv"));
const rows = (prefix: string) => files.filter((f) => f.startsWith(prefix)).flatMap((f) => csvRead(resolve(RESULTS_DIR, f)));
// 空字符串表示「没有发生」（例如没抢到时没有取回耗时），不能当成 0
const num = (xs: Record<string, string>[], key: string) =>
  xs.map((r) => (r[key] === "" || r[key] === undefined ? NaN : Number(r[key]))).filter((x) => Number.isFinite(x));
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");

const out: string[] = [];
out.push("# 📊 实验报告（自动生成，请勿手改）", "");
out.push(`> 生成时间：${new Date().toISOString()} · 数据目录：\`bench/${RESULTS_DIR.split("/bench/")[1]}\``);
out.push("> 链上时间戳为整秒（Base Sepolia 约 5 个区块共用一个时间戳），精度 ±1s；链下口径为脚本轮询看到日志的本机时间，包含 RPC 延迟。", "");

// ───────────── 延迟 ─────────────
const lat = rows("latency-").filter((r) => r.status === "ok");
const all = rows("latency-");
out.push("## 1. 端到端延迟（Reactive Omni）", "");
if (lat.length === 0) out.push("_还没有数据：运行 `npm run bench`_", "");
else {
  out.push(`样本 ${lat.length} 个（超时 ${all.length - lat.length} 个）。P95 用 nearest-rank，n 较小时不稳定。`, "");
  out.push("| 指标 | 中位数 | P95 | 最小 | 最大 |", "|---|---|---|---|---|");
  for (const [name, key] of [
    ["链上 E2E（秒）", "e2e_s"],
    ["Base → Lasna（秒）", "baseToLasna_s"],
    ["Lasna → Base（秒）", "lasnaToBase_s"],
    ["链下 E2E（毫秒）", "offchain_e2e_ms"],
  ] as const) {
    const xs = num(lat, key);
    out.push(`| ${name} | ${f1(median(xs))} | ${f1(percentile(xs, 95))} | ${f1(Math.min(...xs))} | ${f1(Math.max(...xs))} |`);
  }
  out.push("", "前 3 个样本的浏览器链接：", "");
  for (const r of lat.slice(0, 3))
    out.push(
      `- 还款 [${r.repayTx.slice(0, 10)}…](https://sepolia.basescan.org/tx/${r.repayTx}) → react [${r.lasnaTx.slice(0, 10)}…](https://lasna.reactscan.net/tx/${r.lasnaTx}) → 回调 [${r.callbackTx.slice(0, 10)}…](https://sepolia.basescan.org/tx/${r.callbackTx})（${r.e2e_s}s）`,
    );
  out.push("");
}

// ───────────── 抢流动性 ─────────────
const race = rows("race-");
const modes = [...new Set(race.map((r) => r.mode))];
const delays = [...new Set(race.map((r) => Number(r.delay_s)))].sort((a, b) => a - b);
out.push("## 2. 抢流动性实验", "");
if (race.length === 0) out.push("_还没有数据：运行 `npm run race`_", "");
else {
  const cell = (m: string, d: number) => race.filter((r) => r.mode === m && Number(r.delay_s) === d);
  const capture = (xs: Record<string, string>[]) => num(xs, "capture").reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  out.push("**平均抢到率**（金库取回 ÷ 还款金额；括号内为样本数）", "");
  out.push(`| 方案 | ${delays.map((d) => `对手 T=${d}s`).join(" | ")} |`, `|---|${delays.map(() => "---").join("|")}|`);
  for (const m of modes) out.push(`| ${m}（实测） | ${delays.map((d) => `${(capture(cell(m, d)) * 100).toFixed(0)}%（${cell(m, d).length}）`).join(" | ")} |`);

  // 推算：用实测的链下延迟分布 L，旧版 L' = L + k × (7 − 1) 秒，L' < T 记为抢到
  const L = num(lat, "offchain_e2e_ms").map((x) => x / 1000);
  if (L.length) {
    const est = (d: number, extra: number) => (L.filter((x) => x + extra < d).length / L.length) * 100;
    out.push(`| 旧版约 7s 出块（**推算**，k=${k}） | ${delays.map((d) => `${est(d, k * (OLD_BLOCK_S - 1)).toFixed(0)}%`).join(" | ")} |`);
  }
  out.push("", "**我方取回耗时中位数**（从看到还款回执起，毫秒）", "");
  out.push(`| 方案 | ${delays.map((d) => `T=${d}s`).join(" | ")} |`, `|---|${delays.map(() => "---").join("|")}|`);
  for (const m of modes) out.push(`| ${m} | ${delays.map((d) => f1(median(num(cell(m, d), "vaultSeen_ms")))).join(" | ")} |`);

  for (const d of delays) {
    out.push("", "```mermaid", "xychart-beta", `    title "对手 T=${d}s 时的平均抢到率（%）"`);
    out.push(`    x-axis [${modes.map((m) => `"${m}"`).join(", ")}]`, '    y-axis "抢到率 %" 0 --> 100');
    out.push(`    bar [${modes.map((m) => (capture(cell(m, d)) * 100).toFixed(0)).join(", ")}]`, "```");
  }
  out.push("");
}

out.push("## 3. 解读规则（实验前写定，见方案文档 9.5）", "");
out.push("- Omni 在 T ≥ X 秒时稳定抢到，而旧版推算和轮询在同样的 T 下抢不到 → 证明存在只有 Omni 级速度能进入的时间窗口。");
out.push("- Omni 与轮询 15s 差别不大 → 如实报告，把 T 调小再测，或分析瓶颈在哪一段。");
out.push("- 局限：对手延迟 T 是人为设定的，只证明相对时间窗口；同区块 MEV 抢跑不在比较范围内。");

writeFileSync(resolve(RESULTS_DIR, "REPORT.md"), out.join("\n") + "\n");
console.log(`📝 已生成 ${resolve(RESULTS_DIR, "REPORT.md")}`);
