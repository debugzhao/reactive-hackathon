// Experiments：唯一的静态数据，来自构建时打包的 bench/results/**/*.csv。口径与 bench/src/report.ts 一致。
import { useState } from "react";
import { type Dataset, datasets, median, nums, percentile } from "../experiments";
import { Badge, GlassCard, Pill } from "./ui";

const K = Number(import.meta.env.VITE_LEGACY_K ?? 2); // 链路经过的 Reactive 区块数（方案文档 9.5）
const OLD_BLOCK_S = 7;
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");

export function Experiments() {
  const [tab, setTab] = useState(datasets[0]?.label);
  const ds = datasets.find((d) => d.label === tab);

  return (
    <GlassCard
      id="experiments"
      title="Experiments"
      sub="Bundled at build time from bench/results/**/*.csv — the only static data on this page"
      right={
        datasets.length > 0 && (
          <div className="filters">
            {datasets.map((d) => (
              <Pill key={d.label} small active={d.label === tab} onClick={() => setTab(d.label)}>
                {d.label}
              </Pill>
            ))}
          </div>
        )
      }
    >
      {!ds ? <EmptyState /> : <DatasetView ds={ds} />}
      <div className="note">
        Limitations: the competitor delay T is set by us, so results show relative time windows, not real-market win rates. Same-block
        MEV searchers are faster than any cross-chain automation and are out of scope.
      </div>
    </GlassCard>
  );
}

function EmptyState() {
  return (
    <div className="grid grid-2-even">
      <div className="empty" style={{ textAlign: "left" }}>
        <b style={{ color: "var(--text-strong)", fontWeight: 500 }}>Latency benchmark</b> — repay → react → callback, joined by originTxHash
        <code className="code">cd queue-vault/bench{"\n"}npm run bench -- --rounds 30 --amount 100</code>
      </div>
      <div className="empty" style={{ textAlign: "left" }}>
        <b style={{ color: "var(--text-strong)", fontWeight: 500 }}>Liquidity race</b> — a competitor withdraws T seconds after repayment
        <code className="code">npm run race -- --mode reactive --delays 3,10,30 --rounds 10{"\n"}npm run race -- --mode poll --poll-interval 15 --delays 3,10,30 --rounds 10</code>
      </div>
    </div>
  );
}

function DatasetView({ ds }: { ds: Dataset }) {
  const ok = ds.latency.filter((r) => r.status === "ok");
  const modes = [...new Set(ds.race.map((r) => r.mode))];
  const delays = [...new Set(ds.race.map((r) => Number(r.delay_s)))].sort((a, b) => a - b);
  const cell = (m: string, d: number) => ds.race.filter((r) => r.mode === m && Number(r.delay_s) === d);
  const capture = (rows: Record<string, string>[]) => nums(rows, "capture").reduce((a, b) => a + b, 0) / Math.max(1, rows.length);
  const L = nums(ok, "offchain_e2e_ms").map((x) => x / 1000);

  return (
    <>
      {ds.devnet && (
        <div style={{ marginBottom: 14 }}>
          <Badge tone="warn">LOCAL SIMULATION — delays injected by devnet-relay, not experimental results</Badge>
        </div>
      )}

      <div className="subhead">
        End-to-end latency · n={ok.length}
        {ds.latency.length > ok.length ? ` (${ds.latency.length - ok.length} timed out)` : ""}
      </div>
      {ok.length === 0 ? (
        <div className="empty">
          No latency samples. <code className="code">npm run bench -- --rounds 30 --amount 100</code>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Metric</th>
                <th className="r">Median</th>
                <th className="r">P95</th>
                <th className="r">Min</th>
                <th className="r">Max</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["On-chain E2E (s, ±1s)", "e2e_s"],
                  ["Base → Lasna (s)", "baseToLasna_s"],
                  ["Lasna → Base (s)", "lasnaToBase_s"],
                  ["Off-chain E2E (ms, incl. RPC)", "offchain_e2e_ms"],
                ] as const
              ).map(([name, key]) => {
                const xs = nums(ok, key);
                return (
                  <tr key={key}>
                    <td>{name}</td>
                    <td className="r num">{f1(median(xs))}</td>
                    <td className="r num">{f1(percentile(xs, 95))}</td>
                    <td className="r num">{xs.length ? f1(Math.min(...xs)) : "—"}</td>
                    <td className="r num">{xs.length ? f1(Math.max(...xs)) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="subhead">Liquidity race · average capture rate (vault recalled ÷ repaid)</div>
      {ds.race.length === 0 ? (
        <div className="empty">
          No race samples. <code className="code">npm run race -- --mode reactive --delays 3,10,30 --rounds 10</code>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Strategy</th>
                {delays.map((d) => (
                  <th key={d} className="r">
                    Competitor T={d}s
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modes.map((m) => (
                <tr key={m}>
                  <td>
                    {m} <span className="faint">measured</span>
                  </td>
                  {delays.map((d) => {
                    const rows = cell(m, d);
                    const c = capture(rows);
                    return (
                      <td key={d} className="r num" style={{ background: `rgba(125, 211, 192, ${rows.length ? 0.04 + c * 0.26 : 0.03})` }}>
                        {rows.length ? `${(c * 100).toFixed(0)}%` : "—"} <span className="faint">({rows.length})</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {L.length > 0 && (
                <tr>
                  <td>
                    Legacy ~7s blocks <Badge tone="warn">projected</Badge>
                  </td>
                  {delays.map((d) => {
                    const est = L.filter((x) => x + K * (OLD_BLOCK_S - 1) < d).length / L.length;
                    return (
                      <td key={d} className="r num" style={{ background: `rgba(252, 211, 77, ${0.03 + est * 0.15})` }}>
                        {(est * 100).toFixed(0)}% <span className="faint">(est.)</span>
                      </td>
                    );
                  })}
                </tr>
              )}
            </tbody>
          </table>
          {L.length > 0 && (
            <div className="note">
              Projection: L′ = L + k × ({OLD_BLOCK_S} − 1)s with k={K}, using the measured off-chain latency distribution L; L′ &lt; T counts as
              captured. This row is an estimate, not a measurement.
            </div>
          )}
        </div>
      )}
    </>
  );
}
