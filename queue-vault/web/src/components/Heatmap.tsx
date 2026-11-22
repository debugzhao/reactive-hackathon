// Queue Heatmap：最近 120 个赎回请求的状态（已结清 / 部分兑付 / 待兑付 / 转入 claimable）
import type { RedeemRequest } from "../chain";
import { clock, short, usdc } from "../format";
import type { ScanState } from "../useScan";
import { HEATMAP_CELLS } from "../useScan";
import { Badge, GlassCard, Pill, Tooltip, useTooltip } from "./ui";

type Status = "settled" | "partial" | "pending" | "claimable";

export function Heatmap({ scan, selected, highlight }: { scan: ScanState; selected?: number; highlight: boolean }) {
  const deferred = new Set(scan.events.filter((e) => e.name === "PayoutDeferred").map((e) => Number(e.args.id)));
  const status = (r: RedeemRequest): Status =>
    deferred.has(r.id) ? "claimable" : r.assetsRemaining === 0n ? "settled" : r.assetsRemaining < r.assetsTotal ? "partial" : "pending";
  const waits = scan.requests.filter((r) => r.assetsRemaining === 0n && r.settledAt > 0).map((r) => r.settledAt - r.requestedAt);
  const maxWait = Math.max(1, ...waits);
  const tt = useTooltip<RedeemRequest>();
  const head = scan.snap?.vault.head;

  return (
    <GlassCard
      id="heatmap"
      title="Queue heatmap"
      sub={`Last ${HEATMAP_CELLS} redemption requests · brighter = settled faster`}
      highlight={highlight}
      error={scan.errors.base}
      right={<Pill small>Head #{head?.toString() ?? "—"}</Pill>}
    >
      {scan.requests.length === 0 ? (
        <div className="empty">No redemption requests yet.</div>
      ) : (
        <div className="heat" ref={tt.ref} onMouseLeave={tt.hide}>
          {scan.requests.map((r) => {
            const st = status(r);
            const wait = r.settledAt > 0 ? r.settledAt - r.requestedAt : 0;
            const alpha = st === "settled" ? 0.85 - 0.6 * Math.min(1, wait / maxWait) : undefined;
            return (
              <div
                key={r.id}
                className={`cell ${st} ${selected === r.id ? "selected" : ""}`}
                style={alpha !== undefined ? ({ ["--a" as string]: alpha.toFixed(2) } as React.CSSProperties) : undefined}
                onMouseMove={(e) => tt.show(e, r)}
              />
            );
          })}
          {tt.tip && (
            <Tooltip x={tt.tip.x} y={tt.tip.y} width={tt.ref.current?.clientWidth ?? 500}>
              <RequestTip r={tt.tip.data} st={status(tt.tip.data)} />
            </Tooltip>
          )}
        </div>
      )}
      <div className="legend">
        <span>
          <i style={{ background: "rgba(147,197,253,0.75)" }} />
          Settled
        </span>
        <span>
          <i style={{ background: "rgba(252,211,77,0.55)" }} />
          Partially paid
        </span>
        <span>
          <i style={{ border: "1px solid rgba(191,212,250,0.7)" }} />
          Pending
        </span>
        <span>
          <i style={{ background: "rgba(252,165,165,0.6)" }} />
          Moved to claimable
        </span>
      </div>
    </GlassCard>
  );
}

function RequestTip({ r, st }: { r: RedeemRequest; st: Status }) {
  const tone = st === "settled" ? "mint" : st === "partial" ? "warn" : st === "claimable" ? "bad" : "base";
  return (
    <>
      <div className="row">
        <b>Request #{r.id}</b>
        <Badge tone={tone}>{st}</Badge>
      </div>
      <div className="row">
        <span className="dim">Locked</span>
        <span className="num">{usdc(r.assetsTotal)} USDC</span>
      </div>
      <div className="row">
        <span className="dim">Remaining</span>
        <span className="num">{usdc(r.assetsRemaining, { digits: 6 })} USDC</span>
      </div>
      <div className="row">
        <span className="dim">Owner</span>
        <span className="mono">{short(r.owner)}</span>
      </div>
      <div className="row">
        <span className="dim">Requested</span>
        <span className="num">{clock(r.requestedAt)}</span>
      </div>
      <div className="row">
        <span className="dim">Waited</span>
        <span className="num">{r.settledAt > 0 ? `${r.settledAt - r.requestedAt}s` : "—"}</span>
      </div>
    </>
  );
}
