// 实验数据：构建时把 bench/results 下的 CSV 打包进来（npm run bench / race 生成）。没有就显示空状态，绝不填假数据。
const raw = import.meta.glob<string>("../../bench/results/**/*.csv", { eager: true, query: "?raw", import: "default" });

type Row = Record<string, string>;
export type Dataset = { label: string; devnet: boolean; latency: Row[]; race: Row[] };

function parse(text: string): Row[] {
  const [head, ...rows] = text.trim().split("\n");
  if (!head) return [];
  const keys = head.split(",");
  return rows.filter(Boolean).map((r) => Object.fromEntries(r.split(",").map((v, i) => [keys[i], v])));
}

/** results/*.csv 是测试网实测；results/devnet/*.csv 是本地冒烟测试（延迟人为设定，没有实验意义） */
export const datasets: Dataset[] = (() => {
  const groups = new Map<string, Dataset>();
  for (const [path, text] of Object.entries(raw)) {
    const rel = path.split("/bench/results/")[1];
    const devnet = rel.startsWith("devnet/");
    const label = devnet ? "devnet" : "testnet";
    const g = groups.get(label) ?? { label, devnet, latency: [], race: [] };
    const file = rel.split("/").pop()!;
    if (file.startsWith("latency-")) g.latency.push(...parse(text));
    if (file.startsWith("race-")) g.race.push(...parse(text));
    groups.set(label, g);
  }
  return [...groups.values()].sort((a) => (a.devnet ? 1 : -1));
})();

export const nums = (rows: Row[], key: string) =>
  rows.map((r) => (r[key] === "" || r[key] === undefined ? NaN : Number(r[key]))).filter(Number.isFinite);

export function median(xs: number[]) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** nearest-rank，与 bench/src/report.ts 口径一致 */
export function percentile(xs: number[], p: number) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}
