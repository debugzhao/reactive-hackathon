// Latest Events：合并两条链的事件流（最新在前，50 条），按链和事件类型筛选
import { useState } from "react";
import type { Ev } from "../chain";
import { type ChainKey, DEPLOYMENTS } from "../config";
import { ago, short, usdc } from "../format";
import { type Key, type T, useI18n } from "../i18n";
import type { ScanState } from "../useScan";
import { useNow } from "../useScan";
import { ChainBadge, GlassCard, Pill, TxLink } from "./ui";

type Group = "pool" | "queue" | "reactive" | "callback";
type View = { group: Group; color: string; summary: string; amount?: bigint };

function view(e: Ev, t: T): View {
  const a = e.args as Record<string, any>;
  const vault = DEPLOYMENTS?.vault.toLowerCase();
  switch (e.name) {
    case "Repaid":
      return { group: "pool", color: "var(--base)", summary: t("sum.Repaid", { liq: usdc(a.availableLiquidity) }), amount: a.amount };
    case "Borrowed":
      return { group: "pool", color: "var(--text-dim)", summary: t("sum.Borrowed", { liq: usdc(a.availableLiquidity) }), amount: a.amount };
    case "LiquidityTaken": {
      const mine = String(a.lender).toLowerCase() === vault;
      return {
        group: "pool",
        color: mine ? "var(--mint)" : "var(--bad)",
        summary: mine
          ? t("sum.takenMine", { left: usdc(a.availableAfter) })
          : t("sum.takenOther", { who: short(a.lender), left: usdc(a.availableAfter) }),
        amount: a.amount,
      };
    }
    case "RedeemRequested":
      return { group: "queue", color: "var(--base)", summary: t("sum.RedeemRequested", { id: a.id, who: short(a.owner) }), amount: a.assets };
    case "RedeemSettled":
      return {
        group: "queue",
        color: "var(--mint)",
        summary: a.done
          ? t("sum.settledDone", { id: a.id, who: short(a.receiver) })
          : t("sum.settledPart", { id: a.id, who: short(a.receiver), rem: usdc(a.remaining) }),
        amount: a.paid,
      };
    case "Recalled":
      return { group: "queue", color: "var(--mint)", summary: t("sum.Recalled", { w: usdc(a.wanted) }), amount: a.got };
    case "RecallFailed":
      return { group: "queue", color: "var(--bad)", summary: t("sum.RecallFailed") };
    case "PayoutDeferred":
      return { group: "queue", color: "var(--bad)", summary: t("sum.PayoutDeferred", { id: a.id, who: short(a.receiver) }), amount: a.amount };
    case "Claimed":
      return { group: "queue", color: "var(--mint)", summary: t("sum.Claimed", { who: short(a.account) }), amount: a.amount };
    case "SettleSkipped":
      return { group: "queue", color: "var(--text-dim)", summary: t("sum.SettleSkipped", { head: a.head, cash: usdc(a.queueCash) }) };
    case "Allocated":
      return { group: "queue", color: "var(--text-dim)", summary: t("sum.Allocated", { cash: usdc(a.cashAfter) }), amount: a.assets };
    case "Deposit":
      return { group: "queue", color: "var(--base)", summary: t("sum.Deposit", { who: short(a.sender) }), amount: a.assets };
    case "SettleRequested":
      return {
        group: "reactive",
        color: "var(--lasna)",
        summary: t("sum.SettleRequested", { src: Number(a.source) === 2 ? t("sum.srcRepaid") : t("sum.srcSnapshot"), n: a.maxCount }),
        amount: a.cashForQueue,
      };
    case "Skipped": {
      const r = String(a.reason);
      const reason = r === "1" ? t("sum.skip1") : r === "2" ? t("sum.skip2") : t("sum.skipOther", { r });
      return { group: "reactive", color: "var(--warn)", summary: t("sum.Skipped", { reason }) };
    }
    case "BudgetExhausted":
      return { group: "reactive", color: "var(--warn)", summary: t("sum.BudgetExhausted", { n: a.callbackCount }) };
    case "SubscriptionChanged":
      return { group: "reactive", color: "var(--lasna)", summary: a.subscribed ? t("sum.subscribed") : t("sum.unsubscribed") };
    case "CircuitBreak":
      return { group: "reactive", color: "var(--bad)", summary: t("sum.CircuitBreak", { n: a.reactsInWindow, s: a.windowSeconds }) };
    case "ReactiveSettled":
      return {
        group: "callback",
        color: "var(--mint)",
        summary: t("sum.ReactiveSettled", { n: a.processed, r: usdc(a.recalled), head: a.newHead }),
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

const GROUPS: { key: Group | "all"; label: Key }[] = [
  { key: "all", label: "ev.allTypes" },
  { key: "pool", label: "ev.pool" },
  { key: "queue", label: "ev.queue" },
  { key: "reactive", label: "ev.react" },
  { key: "callback", label: "ev.callback" },
];

export function Events({ scan }: { scan: ScanState }) {
  const { t } = useI18n();
  const now = useNow(1000);
  const [chain, setChain] = useState<ChainKey | "all">("all");
  const [group, setGroup] = useState<Group | "all">("all");
  const rows = scan.events
    .map((e) => ({ e, v: view(e, t) }))
    .filter(({ e, v }) => (chain === "all" || e.chain === chain) && (group === "all" || v.group === group))
    .slice(0, 50);

  return (
    <GlassCard
      title={t("ev.title")}
      sub={t("ev.sub")}
      error={scan.errors.base ?? scan.errors.lasna}
      right={
        <div className="filters">
          {(["all", "base", "lasna"] as const).map((c) => (
            <Pill key={c} small active={chain === c} onClick={() => setChain(c)}>
              {c === "all" ? t("ev.allChains") : c === "base" ? "Base" : "Lasna"}
            </Pill>
          ))}
        </div>
      }
    >
      <div className="filters" style={{ marginBottom: 14 }}>
        {GROUPS.map((g) => (
          <Pill key={g.key} small active={group === g.key} onClick={() => setGroup(g.key)}>
            {t(g.label)}
          </Pill>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="empty">{scan.syncing < 1 ? t("ev.syncing") : t("ev.none")}</div>
      ) : (
        <div className="events">
          {rows.map(({ e, v }) => (
            <div className="ev" key={e.key}>
              <div>
                <div className="ev-name">
                  <span className="ev-dot" style={{ ["--c" as string]: v.color }} />
                  {e.name}
                </div>
                <div className="ev-when">{ago(e.ts, now, t)}</div>
              </div>
              <div className="ev-mid">
                <div className="top">
                  <TxLink chain={e.chain} hash={e.tx} />
                  <span className="dim" style={{ fontSize: 12.5 }}>
                    {contractName(e)}
                  </span>
                  <ChainBadge chain={e.chain} />
                </div>
                <div className="sum" title={v.summary}>
                  {v.summary}
                </div>
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
