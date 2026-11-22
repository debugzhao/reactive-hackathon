// Settlement Latency：已完成链路的链上 E2E 中位数 / P95 + 最近 60 条堆叠柱状图（Base→Lasna / Lasna→Base）
import type { Trace } from "../chain";
import { median, percentile } from "../experiments";
import { clock, secs } from "../format";
import { useI18n } from "../i18n";
import type { ScanState } from "../useScan";
import { GlassCard, Tooltip, TxLink, useTooltip } from "./ui";

type Done = Trace & { t0: number; t1: number; t2: number };
const BAR_H = 200;

export function Latency({ scan }: { scan: ScanState }) {
  const { t } = useI18n();
  const done = scan.traces
    .filter((t): t is Done => t.status === "SETTLED" && t.t0 !== undefined && t.t1 !== undefined && t.t2 !== undefined)
    .slice(0, 60)
    .reverse(); // 旧 → 新，从左往右
  const e2e = done.map((t) => t.t2 - t.t0);
  const med = median(e2e);
  const p95 = percentile(e2e, 95);
  const max = Math.max(1, ...e2e);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const tt = useTooltip<Done>();

  return (
    <GlassCard
      title={t("lat.title")}
      sub={t("lat.sub")}
      error={scan.errors.base ?? scan.errors.lasna}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
        <span className="big-num num gradient-text">{Number.isFinite(med) ? `${med.toFixed(1)}s` : "—"}</span>
        <span className="dim num">{t("lat.median", { p95: Number.isFinite(p95) ? `${p95.toFixed(1)}s` : "—", n: done.length })}</span>
      </div>

      {done.length === 0 ? (
        <div className="empty" style={{ marginTop: 22 }}>
          {t("lat.empty")}
          <code className="code">cd bench && npm run bench -- --rounds 30 --amount 100</code>
        </div>
      ) : (
        <div className="chart" ref={tt.ref} onMouseLeave={tt.hide}>
          {ticks.map((v) => (
            <div key={v} className="gridline" style={{ bottom: (v / top) * BAR_H + 1 }}>
              <span className="num">{v}s</span>
            </div>
          ))}
          <div className="bars">
            {done.map((t) => {
              const a = Math.max(0, t.t1 - t.t0);
              const b = Math.max(0, t.t2 - t.t1);
              const h = (x: number) => Math.max(x > 0 ? 3 : 0, (x / top) * BAR_H);
              return (
                <div key={t.origin} className="bar-col" onMouseMove={(e) => tt.show(e, t)}>
                  <i className="seg-l" style={{ height: h(a) }} />
                  <i className="seg-b" style={{ height: h(b) }} />
                  {a + b === 0 && <i className="seg-b" style={{ height: 2 }} />}
                </div>
              );
            })}
          </div>
          {tt.tip && (
            <Tooltip x={tt.tip.x} y={tt.tip.y} width={tt.ref.current?.clientWidth ?? 600}>
              <div className="row">
                <span className="dim">T0 {clock(tt.tip.data.t0)}</span>
                <b className="num">{t("lat.e2e", { s: secs(tt.tip.data.t2 - tt.tip.data.t0, false) })}</b>
              </div>
              <div className="row">
                <span style={{ color: "var(--lasna)" }}>Base → Lasna</span>
                <span className="num">{secs(tt.tip.data.t1 - tt.tip.data.t0, false)}</span>
              </div>
              <div className="row">
                <span style={{ color: "var(--mint)" }}>Lasna → Base</span>
                <span className="num">{secs(tt.tip.data.t2 - tt.tip.data.t1, false)}</span>
              </div>
              <div className="row">
                <span className="dim">{t("lat.trigger")}</span>
                <TxLink chain="base" hash={tt.tip.data.origin} head={6} tail={4} />
              </div>
              <div className="row">
                <span className="dim">{t("lat.react")}</span>
                <TxLink chain="lasna" hash={tt.tip.data.react?.tx} head={6} tail={4} />
              </div>
              <div className="row">
                <span className="dim">{t("lat.callback")}</span>
                <TxLink chain="base" hash={tt.tip.data.callback?.tx} head={6} tail={4} />
              </div>
            </Tooltip>
          )}
        </div>
      )}

      <div className="legend">
        <span>
          <i style={{ background: "var(--lasna)" }} />
          Base → Lasna (T1 − T0)
        </span>
        <span>
          <i style={{ background: "var(--mint)" }} />
          Lasna → Base (T2 − T1)
        </span>
      </div>
      <div className="note">{t("lat.note", { n: done.length || 60 })}</div>
    </GlassCard>
  );
}

function niceTicks(max: number): number[] {
  const step = max <= 4 ? 1 : max <= 10 ? 2 : max <= 30 ? 5 : max <= 60 ? 10 : 30;
  const out: number[] = [];
  for (let v = step; v < max + step; v += step) out.push(v);
  return out;
}
