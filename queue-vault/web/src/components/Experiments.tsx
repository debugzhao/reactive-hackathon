// Experiments：唯一的静态数据，来自构建时打包的 bench/results/**/*.csv。口径与 bench/src/report.ts 一致。
import { useState } from "react";
import { type Dataset, datasets, median, nums, percentile } from "../experiments";
import { useI18n } from "../i18n";
import { Badge, GlassCard, Pill } from "./ui";

const K = Number(import.meta.env.VITE_LEGACY_K ?? 2); // 链路经过的 Reactive 区块数（方案文档 9.5）
const OLD_BLOCK_S = 7;
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");

export function Experiments() {
  const { t } = useI18n();
  const [tab, setTab] = useState(datasets[0]?.label);
  const ds = datasets.find((d) => d.label === tab);

  return (
    <GlassCard
      id="experiments"
      title={t("x.title")}
      sub={t("x.sub")}
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
      <div className="note">{t("x.limits")}</div>
    </GlassCard>
  );
}

function EmptyState() {
  const { t } = useI18n();
  return (
    <div className="grid grid-2-even">
      <div className="empty" style={{ textAlign: "left" }}>
        <b style={{ color: "var(--text-strong)", fontWeight: 500 }}>{t("x.latTitle")}</b> {t("x.latDesc")}
        <code className="code">cd queue-vault/bench{"\n"}npm run bench -- --rounds 30 --amount 100</code>
      </div>
      <div className="empty" style={{ textAlign: "left" }}>
        <b style={{ color: "var(--text-strong)", fontWeight: 500 }}>{t("x.raceTitle")}</b> {t("x.raceDesc")}
        <code className="code">npm run race -- --mode reactive --delays 3,10,30 --rounds 10{"\n"}npm run race -- --mode poll --poll-interval 15 --delays 3,10,30 --rounds 10</code>
      </div>
    </div>
  );
}

function DatasetView({ ds }: { ds: Dataset }) {
  const { t } = useI18n();
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
          <Badge tone="warn">{t("x.devnet")}</Badge>
        </div>
      )}

      <div className="subhead">
        {t("x.e2eHead", { n: ok.length })}
        {ds.latency.length > ok.length ? t("x.timedOut", { n: ds.latency.length - ok.length }) : ""}
      </div>
      {ok.length === 0 ? (
        <div className="empty">
          {t("x.noLat")} <code className="code">npm run bench -- --rounds 30 --amount 100</code>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("x.metric")}</th>
                <th className="r">{t("x.median")}</th>
                <th className="r">P95</th>
                <th className="r">{t("x.min")}</th>
                <th className="r">{t("x.max")}</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  [t("x.mE2e"), "e2e_s"],
                  [t("x.mB2l"), "baseToLasna_s"],
                  [t("x.mL2b"), "lasnaToBase_s"],
                  [t("x.mOff"), "offchain_e2e_ms"],
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

      <div className="subhead">{t("x.raceHead")}</div>
      {ds.race.length === 0 ? (
        <div className="empty">
          {t("x.noRace")} <code className="code">npm run race -- --mode reactive --delays 3,10,30 --rounds 10</code>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("x.strategy")}</th>
                {delays.map((d) => (
                  <th key={d} className="r">
                    {t("x.competitorT", { d })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modes.map((m) => (
                <tr key={m}>
                  <td>
                    {m} <span className="faint">{t("x.measured")}</span>
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
                    {t("x.legacy")} <Badge tone="warn">{t("x.projected")}</Badge>
                  </td>
                  {delays.map((d) => {
                    const est = L.filter((x) => x + K * (OLD_BLOCK_S - 1) < d).length / L.length;
                    return (
                      <td key={d} className="r num" style={{ background: `rgba(252, 211, 77, ${0.03 + est * 0.15})` }}>
                        {(est * 100).toFixed(0)}% <span className="faint">({t("x.est")})</span>
                      </td>
                    );
                  })}
                </tr>
              )}
            </tbody>
          </table>
          {L.length > 0 && (
            <div className="note">{t("x.projNote", { b: OLD_BLOCK_S, k: K })}</div>
          )}
        </div>
      )}
    </>
  );
}
