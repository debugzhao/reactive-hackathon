// 首屏：发光星球弧面 + 渐变大标题 + 4 个玻璃指标卡 + 历史日志同步进度
import { pct, pps, usdc, usdcNum } from "../format";
import type { ScanState } from "../useScan";
import { AnimatedNumber, Badge, GlassCard, Pill } from "./ui";

const fmtUsd = (n: number) =>
  n >= 10_000 ? n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 }) : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

export function Hero({ scan }: { scan: ScanState }) {
  const s = scan.snap;
  const v = s?.vault;
  const p = s?.pool;
  const r = s?.reactive;
  const util = p && p.totalAssets > 0n ? 1 - Number(p.liquidity) / Number(p.totalAssets) : NaN;

  return (
    <header className="hero" id="top">
      <div className="planet-glow" />
      <div className="planet" />
      <div className="container hero-inner">
        <div className="eyebrow">
          <Pill small>
            <span className="dot" style={{ color: "var(--lasna)" }} />
            Reactive Omni Buildathon · Track 1
          </Pill>
        </div>
        <h1 className="gradient-text">Every second counts.</h1>
        <p>
          An ERC-4626 vault with a FIFO withdrawal queue. When a borrower repays the shared pool, Reactive grabs the liquidity back
          within seconds — before other lenders take it — and settles the queue in order.
        </p>
        <Pill btn href="#pipeline">
          View live pipeline
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </Pill>

        <div className="stats">
          <GlassCard className="stat" error={scan.errors.base}>
            <div className="label">Vault TVL</div>
            <div className="value gradient-text">
              <AnimatedNumber value={usdcNum(v?.totalAssets)} format={fmtUsd} />
              <small>USDC</small>
            </div>
            <div className="foot">
              PPS <span className="num">{pps(v?.assetsPerShare)}</span> · instant cash {usdc(v?.instantCash, { compact: true })}
            </div>
          </GlassCard>
          <GlassCard className="stat" error={scan.errors.base}>
            <div className="label">Queue pending</div>
            <div className="value gradient-text">
              <AnimatedNumber value={v ? Number(v.pendingCount) : NaN} format={fmtInt} />
              <small>requests</small>
            </div>
            <div className="foot">
              {usdc(v?.totalQueued, { compact: true })} USDC queued · head #{v ? v.head.toString() : "—"}
            </div>
          </GlassCard>
          <GlassCard className="stat" error={scan.errors.base}>
            <div className="label">Pool liquidity</div>
            <div className="value gradient-text">
              <AnimatedNumber value={usdcNum(p?.liquidity)} format={fmtUsd} />
              <small>USDC</small>
            </div>
            <div className="foot">
              Utilization <span className="num">{pct(util)}</span> · vault position {usdc(v?.poolPosition, { compact: true })}
            </div>
          </GlassCard>
          <GlassCard className="stat" error={scan.errors.lasna}>
            <div className="label">Reactive callbacks</div>
            <div className="value gradient-text">
              <AnimatedNumber value={r ? Number(r.callbackCount) : NaN} format={fmtInt} />
              <small>sent</small>
            </div>
            <div className="foot">
              {r ? (
                <>
                  Budget left <span className="num">{r.remainingCallbacks.toString()}</span> · {r.reactCount.toString()} reacts
                </>
              ) : (
                "Reactive not deployed"
              )}
            </div>
          </GlassCard>
        </div>

        {scan.syncing < 1 && (
          <div className="sync">
            <Pill small>
              Syncing logs {Math.floor(scan.syncing * 100)}%
              <span className="bar">
                <i style={{ width: `${scan.syncing * 100}%` }} />
              </span>
            </Pill>
          </div>
        )}
        {scan.syncing >= 1 && scan.updatedAt && (
          <div className="sync">
            <Badge>
              Base #{s?.baseBlock.toString() ?? "—"}
              {r ? ` · Lasna #${r.lasnaBlock.toString()}` : ""}
            </Badge>
          </div>
        )}
      </div>
    </header>
  );
}
