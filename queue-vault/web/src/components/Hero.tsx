// 首屏：发光星球弧面 + 渐变大标题 + 4 个玻璃指标卡 + 历史日志同步进度
import { compactNum, pct, pps, usdc, usdcNum } from "../format";
import { useI18n } from "../i18n";
import type { ScanState } from "../useScan";
import { AnimatedNumber, Badge, GlassCard, Pill } from "./ui";

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

export function Hero({ scan }: { scan: ScanState }) {
  const { t } = useI18n();
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
            {t("hero.eyebrow")}
          </Pill>
        </div>
        <h1 className="gradient-text">{t("hero.title")}</h1>
        <p>{t("hero.desc")}</p>
        <Pill btn href="#pipeline">
          {t("hero.cta")}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </Pill>

        <div className="stats">
          <GlassCard className="stat" error={scan.errors.base}>
            <div className="label">{t("stat.tvl")}</div>
            <div className="value gradient-text">
              <AnimatedNumber value={usdcNum(v?.totalAssets)} format={compactNum} />
              <small>USDC</small>
            </div>
            <div className="foot">{t("stat.tvlFoot", { pps: pps(v?.assetsPerShare), cash: usdc(v?.instantCash, { compact: true }) })}</div>
          </GlassCard>
          <GlassCard className="stat" error={scan.errors.base}>
            <div className="label">{t("stat.queue")}</div>
            <div className="value gradient-text">
              <AnimatedNumber value={v ? Number(v.pendingCount) : NaN} format={fmtInt} />
              <small>{t("stat.queueUnit")}</small>
            </div>
            <div className="foot">
              {t("stat.queueFoot", { amount: usdc(v?.totalQueued, { compact: true }), head: v ? v.head.toString() : "—" })}
            </div>
          </GlassCard>
          <GlassCard className="stat" error={scan.errors.base}>
            <div className="label">{t("stat.pool")}</div>
            <div className="value gradient-text">
              <AnimatedNumber value={usdcNum(p?.liquidity)} format={compactNum} />
              <small>USDC</small>
            </div>
            <div className="foot">{t("stat.poolFoot", { util: pct(util), pos: usdc(v?.poolPosition, { compact: true }) })}</div>
          </GlassCard>
          <GlassCard className="stat" error={scan.errors.lasna}>
            <div className="label">{t("stat.callbacks")}</div>
            <div className="value gradient-text">
              <AnimatedNumber value={r ? Number(r.callbackCount) : NaN} format={fmtInt} />
              <small>{t("stat.callbacksUnit")}</small>
            </div>
            <div className="foot">
              {r ? t("stat.callbacksFoot", { left: r.remainingCallbacks, reacts: r.reactCount }) : t("stat.noReactive")}
            </div>
          </GlassCard>
        </div>

        {scan.syncing < 1 && (
          <div className="sync">
            <Pill small>
              {t("sync", { pct: Math.floor(scan.syncing * 100) })}
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
