// Live Pipeline：最近一次（或搜索命中的）还款 → Lasna react → Base 回调，三节点 + 发光连线 + 同期 LiquidityTaken
import type { Ev, Trace } from "../chain";
import { DEPLOYMENTS } from "../config";
import { clock, secs, usdc } from "../format";
import type { ScanState } from "../useScan";
import { useNow } from "../useScan";
import { Badge, ChainBadge, GlassCard, Pill, TxLink } from "./ui";

const NO_ACTION_AFTER_S = 60;
const SKIP_REASON: Record<number, string> = {
  1: "below threshold: cash for queue < min(head remaining, minSettleAssets)",
  2: "callback budget exhausted or settler not set",
};

type NodeState = "done" | "live" | "idle";

function Node(props: {
  step: string;
  chain: "base" | "lasna";
  name: string;
  state: NodeState;
  tx?: string;
  time?: number;
  live?: boolean;
  badge?: React.ReactNode;
  rows: [string, React.ReactNode][];
}) {
  return (
    <div className={`node ${props.state}`}>
      <div className="node-head">
        <span className="node-step">{props.step}</span>
        <ChainBadge chain={props.chain} />
      </div>
      <div className="node-name">{props.name}</div>
      <div className={`node-time num ${props.time === undefined ? "pending" : "gradient-text"}`}>
        {props.time === undefined ? "—" : secs(props.time)}
        {props.live && <span style={{ fontSize: 14, marginLeft: 8, color: "var(--base)" }}>live</span>}
      </div>
      <div style={{ marginBottom: 8, minHeight: 22, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <TxLink chain={props.chain} hash={props.tx} />
        {props.badge}
      </div>
      {props.rows.map(([k, v]) => (
        <div className="kv" key={k}>
          <span>{k}</span>
          <span className="num">{v}</span>
        </div>
      ))}
    </div>
  );
}

const Connector = ({ on, flow }: { on: boolean; flow: boolean }) => (
  <div className={`connector ${on ? "on" : ""} ${flow ? "flow" : ""}`}>
    <div className="line" />
  </div>
);

export function Pipeline({ scan, selected, highlight }: { scan: ScanState; selected?: string; highlight: boolean }) {
  const now = useNow(100);
  const nowS = now / 1000;
  const repaids = scan.events.filter((e) => e.chain === "base" && e.name === "Repaid");
  // 搜索命中的链路优先；否则取最近一次还款
  const trace: Trace | undefined = selected
    ? scan.traces.find((t) => t.origin === selected)
    : repaids[0]
      ? scan.traces.find((t) => t.origin === repaids[0].tx)
      : undefined;
  const repaid: Ev | undefined = trace ? repaids.find((e) => e.tx === trace.origin) : undefined;
  const originEv = repaid ?? (trace ? scan.events.find((e) => e.chain === "base" && e.tx === trace.origin) : undefined);

  const t0 = trace?.t0;
  const elapsed = t0 !== undefined ? nowS - t0 : undefined;
  const react = trace?.react;
  const cb = trace?.callback;
  const noAction = !!trace && !react && !trace.skipped && elapsed !== undefined && elapsed > NO_ACTION_AFTER_S;

  const reactLive = !!trace && !react && !trace.skipped && !noAction;
  const cbLive = !!react && !cb;

  // 同一笔还款期间（这次还款之后、下一次还款之前）的池子流动性去向
  const taken = repaid
    ? (() => {
        const next = repaids.filter((e) => order(e) > order(repaid)).sort((a, b) => order(a) - order(b))[0];
        return scan.events
          .filter((e) => e.name === "LiquidityTaken" && order(e) > order(repaid) && (!next || order(e) < order(next)))
          .sort((a, b) => order(a) - order(b));
      })()
    : [];

  const vault = DEPLOYMENTS?.vault.toLowerCase();

  return (
    <GlassCard
      id="pipeline"
      highlight={highlight}
      error={scan.errors.base ?? scan.errors.lasna}
      title="Live pipeline"
      sub={
        trace
          ? `Origin ${trace.source === "REPAY" ? "Repaid" : (trace.originEvent ?? "vault snapshot")} at ${clock(t0)} UTC · times relative to T0 (block timestamp)`
          : "Waiting for the first repayment on the shared pool"
      }
      right={
        <>
          {selected && <Pill small>Search result</Pill>}
          {trace && <StatusBadge trace={trace} noAction={noAction} />}
        </>
      }
    >
      {!trace ? (
        <div className="empty">
          No repayment observed yet. Trigger one with
          <code className="code">bash bin/loop.sh{"\n"}# or: cd bench && npm run bench -- --rounds 3</code>
        </div>
      ) : (
        <>
          <div className="pipeline">
            <Node
              step="T0 · trigger"
              chain="base"
              name={trace.source === "REPAY" ? "MockPool · Repaid" : `QueueVault · ${trace.originEvent ?? "snapshot"}`}
              state="done"
              tx={trace.origin}
              time={t0 !== undefined ? 0 : undefined}
              rows={
                repaid
                  ? [
                      ["Repaid", `${usdc(repaid.args.amount as bigint)} USDC`],
                      ["Pool liquidity after", `${usdc(repaid.args.availableLiquidity as bigint)} USDC`],
                    ]
                  : [["Event", originEv?.name ?? "LiquiditySnapshot"]]
              }
            />
            <Connector on={!!react} flow={reactLive} />
            <Node
              step="T1 · decide"
              chain="lasna"
              name="QueueReactive · react()"
              state={react ? "done" : reactLive ? "live" : "idle"}
              tx={react?.tx ?? trace.skipped?.tx}
              time={react && t0 !== undefined && trace.t1 !== undefined ? trace.t1 - t0 : reactLive ? elapsed : undefined}
              live={reactLive}
              badge={
                trace.skipped && !react ? (
                  <Badge tone="warn" title={SKIP_REASON[Number(trace.skipped.args.reason)]}>
                    Skipped · reason {String(trace.skipped.args.reason)}
                  </Badge>
                ) : noAction ? (
                  <Badge tone="warn" title="No react within 60s: queue empty or below threshold">
                    No action
                  </Badge>
                ) : undefined
              }
              rows={
                react
                  ? [
                      ["Cash for queue", `${usdc(react.args.cashForQueue as bigint)} USDC`],
                      ["Head remaining", `${usdc(react.args.headRemaining as bigint)} USDC`],
                      ["Max per callback", String(react.args.maxCount)],
                    ]
                  : trace.skipped
                    ? [["Reason", SKIP_REASON[Number(trace.skipped.args.reason)] ?? "—"]]
                    : noAction
                      ? [["Why", "queue empty or below threshold — react() returned without a callback"]]
                      : [["Status", "waiting for Reactive to deliver the log…"]]
              }
            />
            <Connector on={!!cb} flow={cbLive} />
            <Node
              step="T2 · settle"
              chain="base"
              name="QueueSettler · callback"
              state={cb ? "done" : cbLive ? "live" : "idle"}
              tx={cb?.tx}
              time={cb && t0 !== undefined && trace.t2 !== undefined ? trace.t2 - t0 : cbLive ? elapsed : undefined}
              live={cbLive}
              rows={
                cb
                  ? [
                      ["Recalled from pool", `${usdc(cb.args.recalled as bigint)} USDC`],
                      ["Paid out", `${usdc(cb.args.paid as bigint)} USDC`],
                      ["Requests processed", `${String(cb.args.processed)} · new head #${String(cb.args.newHead)}`],
                    ]
                  : [["Status", cbLive ? "callback in flight…" : "—"]]
              }
            />
          </div>

          <div className="taken">
            <div className="card-head" style={{ marginBottom: 8 }}>
              <div>
                <div className="card-title" style={{ fontSize: 14 }}>
                  Who got the liquidity
                </div>
                <div className="card-sub">
                  LiquidityTaken after this repayment — pool liquidity is first come, first served. A few seconds late and it is gone.
                </div>
              </div>
            </div>
            {taken.length === 0 ? (
              <div className="empty" style={{ padding: 16 }}>
                No withdrawals from the pool since this repayment yet.
              </div>
            ) : (
              taken.map((e) => {
                const mine = String(e.args.lender).toLowerCase() === vault;
                return (
                  <div className="taken-row" key={e.key}>
                    <span className="num gradient-text" style={{ fontSize: 15 }}>
                      {t0 !== undefined && e.ts !== undefined ? secs(e.ts - t0) : "—"}
                    </span>
                    <span>{mine ? <Badge tone="mint">Vault recalled</Badge> : <Badge tone="bad">Taken by other lender</Badge>}</span>
                    <TxLink chain="base" hash={e.tx} />
                    <span className="num" style={{ textAlign: "right", color: mine ? "var(--mint)" : "var(--bad)" }}>
                      {usdc(e.args.amount as bigint)} USDC
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </GlassCard>
  );
}

/** 事件的全局顺序：Base 上按区块号 + logIndex */
const order = (e: Ev) => Number(e.block) * 10_000 + e.logIndex;

function StatusBadge({ trace, noAction }: { trace: Trace; noAction: boolean }) {
  if (trace.status === "SETTLED") return <Badge tone="mint">Settled</Badge>;
  if (trace.status === "IN FLIGHT") return <Badge tone="lasna">In flight</Badge>;
  if (trace.status === "SKIPPED") return <Badge tone="warn">Skipped</Badge>;
  return noAction ? <Badge tone="warn">No action</Badge> : <Badge tone="base">Waiting for react</Badge>;
}
