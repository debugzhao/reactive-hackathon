// Latest Events：合并两条链的事件流（最新在前，50 条），按链和事件类型筛选
import { useState } from "react";
import type { Ev } from "../chain";
import { type ChainKey, DEPLOYMENTS } from "../config";
import { ago, short, usdc } from "../format";
import type { ScanState } from "../useScan";
import { useNow } from "../useScan";
import { ChainBadge, GlassCard, Pill, TxLink } from "./ui";

type Group = "pool" | "queue" | "reactive" | "callback";
type View = { group: Group; color: string; summary: string; amount?: bigint };

const SKIP: Record<string, string> = { "1": "below threshold", "2": "budget exhausted / settler unset" };

function view(e: Ev): View {
  const a = e.args as Record<string, any>;
  const vault = DEPLOYMENTS?.vault.toLowerCase();
  switch (e.name) {
    case "Repaid":
      return { group: "pool", color: "var(--base)", summary: `Borrower repaid · pool liquidity → ${usdc(a.availableLiquidity)}`, amount: a.amount };
    case "Borrowed":
      return { group: "pool", color: "var(--text-dim)", summary: `Borrowed · pool liquidity → ${usdc(a.availableLiquidity)}`, amount: a.amount };
    case "LiquidityTaken": {
      const mine = String(a.lender).toLowerCase() === vault;
      return {
        group: "pool",
        color: mine ? "var(--mint)" : "var(--bad)",
        summary: `${mine ? "Vault recalled liquidity" : `Taken by other lender ${short(a.lender)}`} · ${usdc(a.availableAfter)} left`,
        amount: a.amount,
      };
    }
    case "RedeemRequested":
      return { group: "queue", color: "var(--base)", summary: `#${a.id} queued by ${short(a.owner)}`, amount: a.assets };
    case "RedeemSettled":
      return {
        group: "queue",
        color: "var(--mint)",
        summary: `#${a.id} paid to ${short(a.receiver)} · ${a.done ? "fully settled" : `${usdc(a.remaining)} remaining`}`,
        amount: a.paid,
      };
    case "Recalled":
      return { group: "queue", color: "var(--mint)", summary: `Recalled from pool · wanted ${usdc(a.wanted)}`, amount: a.got };
    case "RecallFailed":
      return { group: "queue", color: "var(--bad)", summary: "Recall from pool failed (caught, settle continues)" };
    case "PayoutDeferred":
      return { group: "queue", color: "var(--bad)", summary: `#${a.id} transfer failed → claimable for ${short(a.receiver)}`, amount: a.amount };
    case "Claimed":
      return { group: "queue", color: "var(--mint)", summary: `Claimed by ${short(a.account)}`, amount: a.amount };
    case "SettleSkipped":
      return { group: "queue", color: "var(--text-dim)", summary: `Nothing to settle · head #${a.head}, queue cash ${usdc(a.queueCash)}` };
    case "Allocated":
      return { group: "queue", color: "var(--text-dim)", summary: `Allocated to pool · cash after ${usdc(a.cashAfter)}`, amount: a.assets };
    case "Deposit":
      return { group: "queue", color: "var(--base)", summary: `Deposit by ${short(a.sender)}`, amount: a.assets };
    case "SettleRequested":
      return {
        group: "reactive",
        color: "var(--lasna)",
        summary: `react() → callback · source ${Number(a.source) === 2 ? "Repaid" : "snapshot"} · N=${a.maxCount}`,
        amount: a.cashForQueue,
      };
    case "Skipped":
      return { group: "reactive", color: "var(--warn)", summary: `react() skipped · ${SKIP[String(a.reason)] ?? `reason ${a.reason}`}` };
    case "BudgetExhausted":
      return { group: "reactive", color: "var(--warn)", summary: `Callback budget exhausted after ${a.callbackCount} callbacks · unsubscribed` };
    case "SubscriptionChanged":
      return { group: "reactive", color: "var(--lasna)", summary: a.subscribed ? "Subscribed" : "Unsubscribed" };
    case "CircuitBreak":
      return { group: "reactive", color: "var(--bad)", summary: `Circuit breaker: ${a.reactsInWindow} reacts in ${a.windowSeconds}s · paused` };
    case "ReactiveSettled":
      return {
        group: "callback",
        color: "var(--mint)",
        summary: `Callback settled ${a.processed} request(s) · recalled ${usdc(a.recalled)} · head → #${a.newHead}`,
        amount: a.paid,
      };
    default:
      return { group: "queue", color: "var(--text-dim)", summary: e.name };
  }
}

function contractName(e: Ev) {
  const d = DEPLOYMENTS;
  const a = e.address.toLowerCase();
  if (!d) return "";
  if (a === d.vault.toLowerCase()) return "QueueVault";
  if (a === d.pool.toLowerCase()) return "MockPool";
  if (a === d.settler.toLowerCase()) return "QueueSettler";
  if (a === d.reactive.toLowerCase()) return "QueueReactive";
  return short(e.address);
}

const GROUPS: { key: Group | "all"; label: string }[] = [
  { key: "all", label: "All types" },
  { key: "pool", label: "Pool" },
  { key: "queue", label: "Queue" },
  { key: "reactive", label: "React" },
  { key: "callback", label: "Callback" },
];

export function Events({ scan }: { scan: ScanState }) {
  const now = useNow(1000);
  const [chain, setChain] = useState<ChainKey | "all">("all");
  const [group, setGroup] = useState<Group | "all">("all");
  const rows = scan.events
    .map((e) => ({ e, v: view(e) }))
    .filter(({ e, v }) => (chain === "all" || e.chain === chain) && (group === "all" || v.group === group))
    .slice(0, 50);

  return (
    <GlassCard
      title="Latest events"
      sub="Both chains merged, newest first"
      error={scan.errors.base ?? scan.errors.lasna}
      right={
        <div className="filters">
          {(["all", "base", "lasna"] as const).map((c) => (
            <Pill key={c} small active={chain === c} onClick={() => setChain(c)}>
              {c === "all" ? "All chains" : c === "base" ? "Base" : "Lasna"}
            </Pill>
          ))}
        </div>
      }
    >
      <div className="filters" style={{ marginBottom: 14 }}>
        {GROUPS.map((g) => (
          <Pill key={g.key} small active={group === g.key} onClick={() => setGroup(g.key)}>
            {g.label}
          </Pill>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="empty">{scan.syncing < 1 ? "Syncing logs…" : "No events yet."}</div>
      ) : (
        <div className="events">
          {rows.map(({ e, v }) => (
            <div className="ev" key={e.key}>
              <div>
                <div className="ev-name">
                  <span className="ev-dot" style={{ ["--c" as string]: v.color }} />
                  {e.name}
                </div>
                <div className="ev-when">{ago(e.ts, now)}</div>
              </div>
              <div className="ev-mid">
                <div className="top">
                  <TxLink chain={e.chain} hash={e.tx} />
                  <span className="dim" style={{ fontSize: 12.5 }}>
                    {contractName(e)}
                  </span>
                  <ChainBadge chain={e.chain} />
                </div>
                <div className="sum">{v.summary}</div>
              </div>
              <div className="ev-amt num">
                {v.amount !== undefined ? (
                  <>
                    {usdc(v.amount)}
                    <small>USDC</small>
                  </>
                ) : (
                  <span className="faint">—</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </GlassCard>
  );
}
