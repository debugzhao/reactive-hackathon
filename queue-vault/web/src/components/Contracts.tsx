// Contracts & Health：5 个合约地址 + Reactive / Settler / 镜像一致性健康指标
import { type ChainKey, DEPLOYMENTS, ZERO } from "../config";
import { native, usdc } from "../format";
import { type Key, useI18n } from "../i18n";
import type { ScanState } from "../useScan";
import { AddrLink, Badge, ChainBadge, CopyButton, GlassCard } from "./ui";

const ROWS: { key: "usdc" | "pool" | "vault" | "settler" | "reactive"; name: string; chain: ChainKey; role: Key }[] = [
  { key: "vault", name: "QueueVault", chain: "base", role: "role.vault" },
  { key: "pool", name: "MockPool", chain: "base", role: "role.pool" },
  { key: "settler", name: "QueueSettler", chain: "base", role: "role.settler" },
  { key: "reactive", name: "QueueReactive", chain: "lasna", role: "role.reactive" },
  { key: "usdc", name: "MockUSDC", chain: "base", role: "role.usdc" },
];

export function Contracts({ scan }: { scan: ScanState }) {
  const { t } = useI18n();
  const s = scan.snap;
  const r = s?.reactive;
  const seqLag = r && s ? s.vault.seq - r.mirror.seq : undefined;
  const windowPct = r && r.maxReactsPerWindow ? Math.min(1, r.windowCount / r.maxReactsPerWindow) : 0;

  return (
    <GlassCard id="contracts" title={t("c.title")} sub={t("c.sub")} error={scan.errors.base ?? scan.errors.lasna}>
      {!DEPLOYMENTS ? (
        <div className="empty">{t("c.noDeploy")}</div>
      ) : (
        ROWS.map((row) => {
          const addr = DEPLOYMENTS![row.key];
          return (
            <div className="contract-row" key={row.key}>
              <ChainBadge chain={row.chain} />
              <b style={{ fontWeight: 500, color: "var(--text-strong)" }}>{row.name}</b>
              <span style={{ minWidth: 0 }}>
                {addr === ZERO ? <span className="faint">{t("c.notDeployed")}</span> : <AddrLink chain={row.chain} address={addr} />}
              </span>
              {addr !== ZERO ? <CopyButton text={addr} title={t("c.copy")} /> : <span />}
              <span className="role">{t(row.role)}</span>
            </div>
          );
        })
      )}

      <div className="health">
        <div className="mini">
          <div className="label">{t("h.balance")}</div>
          <div className="value num">{native(r?.balance, 3)}</div>
          <div className="foot">{t("h.balanceFoot")}</div>
        </div>
        <div className="mini">
          <div className="label">{t("h.breaker")}</div>
          <div className="value num">
            {r ? `${r.windowCount}/${r.maxReactsPerWindow}` : "—"}
            <span className="dim" style={{ fontSize: 12, marginLeft: 6 }}>
              {t("h.per", { s: r?.windowSeconds ?? "—" })}
            </span>
          </div>
          <div className="progress">
            <i style={{ width: `${windowPct * 100}%`, background: windowPct > 0.8 ? "var(--warn)" : "var(--mint)" }} />
          </div>
        </div>
        <div className="mini">
          <div className="label">{t("h.subscription")}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            {r ? (
              <>
                <Badge tone={r.subscribed ? "mint" : "warn"}>{r.subscribed ? t("h.subscribed") : t("h.unsubscribed")}</Badge>
                <Badge tone={r.paused ? "warn" : "mint"}>{r.paused ? t("h.paused") : t("h.running")}</Badge>
              </>
            ) : (
              <span className="faint">—</span>
            )}
          </div>
          <div className="foot">{t("h.budget", { n: r ? r.remainingCallbacks.toString() : "—" })}</div>
        </div>
        <div className="mini">
          <div className="label">{t("h.settler")}</div>
          <div className="value num">{native(s?.settlerBalance, 4)}</div>
          <div className="foot">{t("h.settlerFoot")}</div>
        </div>
        <div className="mini">
          <div className="label">{t("h.mirror")}</div>
          <div className="value num">{r && s ? `${r.mirror.seq} / ${s.vault.seq}` : "—"}</div>
          <div className="foot">
            {seqLag === undefined ? (
              "mirror.seq / snapshotSeq"
            ) : seqLag === 0n ? (
              <Badge tone="mint">{t("h.inSync")}</Badge>
            ) : (
              <span title={t("h.lagTitle")}>
                <Badge tone="warn">Δ {seqLag.toString()}</Badge>
              </span>
            )}
          </div>
        </div>
        <div className="mini">
          <div className="label">{t("h.threshold")}</div>
          <div className="value num">{r ? usdc(r.minSettleAssets) : "—"}</div>
          <div className="foot">{t("h.thresholdFoot", { n: r?.maxPerCallback.toString() ?? "—" })}</div>
        </div>
      </div>
    </GlassCard>
  );
}
