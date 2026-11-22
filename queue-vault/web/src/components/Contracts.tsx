// Contracts & Health：5 个合约地址 + Reactive / Settler / 镜像一致性健康指标
import { type ChainKey, DEPLOYMENTS, ZERO } from "../config";
import { native, usdc } from "../format";
import type { ScanState } from "../useScan";
import { AddrLink, Badge, ChainBadge, CopyButton, GlassCard } from "./ui";

const ROWS: { key: "usdc" | "pool" | "vault" | "settler" | "reactive"; name: string; chain: ChainKey; role: string }[] = [
  { key: "vault", name: "QueueVault", chain: "base", role: "ERC-4626 vault + FIFO withdrawal queue; settleQueue is permissionless" },
  { key: "pool", name: "MockPool", chain: "base", role: "Shared lending pool — withdrawals capped by liquidity (first come, first served)" },
  { key: "settler", name: "QueueSettler", chain: "base", role: "Callback target, guarded by onlyServiceProvider + onlyCallbackSender" },
  { key: "reactive", name: "QueueReactive", chain: "lasna", role: "Subscribes to snapshots + repayments, mirrors queue, decides callbacks" },
  { key: "usdc", name: "MockUSDC", chain: "base", role: "6-decimal test token (testnet only)" },
];

export function Contracts({ scan }: { scan: ScanState }) {
  const s = scan.snap;
  const r = s?.reactive;
  const seqLag = r && s ? s.vault.seq - r.mirror.seq : undefined;
  const windowPct = r && r.maxReactsPerWindow ? Math.min(1, r.windowCount / r.maxReactsPerWindow) : 0;

  return (
    <GlassCard id="contracts" title="Contracts & health" sub="Addresses are read from deployments/*.json" error={scan.errors.base ?? scan.errors.lasna}>
      {!DEPLOYMENTS ? (
        <div className="empty">No deployment file found.</div>
      ) : (
        ROWS.map((row) => {
          const addr = DEPLOYMENTS![row.key];
          return (
            <div className="contract-row" key={row.key}>
              <ChainBadge chain={row.chain} />
              <b style={{ fontWeight: 500, color: "var(--text-strong)" }}>{row.name}</b>
              <span style={{ minWidth: 0 }}>
                {addr === ZERO ? <span className="faint">not deployed</span> : <AddrLink chain={row.chain} address={addr} />}
              </span>
              {addr !== ZERO ? <CopyButton text={addr} /> : <span />}
              <span className="role">{row.role}</span>
            </div>
          );
        })
      )}

      <div className="health">
        <div className="mini">
          <div className="label">Reactive balance</div>
          <div className="value num">{native(r?.balance, 3)}</div>
          <div className="foot">lREACT · pays react() gas</div>
        </div>
        <div className="mini">
          <div className="label">Circuit breaker</div>
          <div className="value num">
            {r ? `${r.windowCount}/${r.maxReactsPerWindow}` : "—"}
            <span className="dim" style={{ fontSize: 12, marginLeft: 6 }}>
              per {r?.windowSeconds ?? "—"}s
            </span>
          </div>
          <div className="progress">
            <i style={{ width: `${windowPct * 100}%`, background: windowPct > 0.8 ? "var(--warn)" : "var(--mint)" }} />
          </div>
        </div>
        <div className="mini">
          <div className="label">Subscription</div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            {r ? (
              <>
                <Badge tone={r.subscribed ? "mint" : "warn"}>{r.subscribed ? "Subscribed" : "Unsubscribed"}</Badge>
                <Badge tone={r.paused ? "warn" : "mint"}>{r.paused ? "Paused" : "Running"}</Badge>
              </>
            ) : (
              <span className="faint">—</span>
            )}
          </div>
          <div className="foot">Budget left {r ? r.remainingCallbacks.toString() : "—"} callbacks</div>
        </div>
        <div className="mini">
          <div className="label">Settler balance</div>
          <div className="value num">{native(s?.settlerBalance, 4)}</div>
          <div className="foot">ETH · pays callback gas</div>
        </div>
        <div className="mini">
          <div className="label">Mirror consistency</div>
          <div className="value num">{r && s ? `${r.mirror.seq} / ${s.vault.seq}` : "—"}</div>
          <div className="foot">
            {seqLag === undefined ? (
              "mirror.seq / snapshotSeq"
            ) : seqLag === 0n ? (
              <Badge tone="mint">In sync</Badge>
            ) : (
              <span title="Only snapshots with queueActive = true are delivered to Reactive; a gap while the queue is idle is expected">
                <Badge tone="warn">Δ {seqLag.toString()}</Badge>
              </span>
            )}
          </div>
        </div>
        <div className="mini">
          <div className="label">Trigger threshold</div>
          <div className="value num">{r ? usdc(r.minSettleAssets) : "—"}</div>
          <div className="foot">USDC · min(head remaining, this) · N={r?.maxPerCallback.toString() ?? "—"}</div>
        </div>
      </div>
    </GlassCard>
  );
}
