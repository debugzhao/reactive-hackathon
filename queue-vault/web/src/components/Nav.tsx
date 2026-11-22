// 悬浮玻璃导航：Logo、搜索（交易哈希 / #请求ID）、状态胶囊、网络胶囊、Contracts 锚点、语言切换。
// 页面顶部时导航融在 Hero 里（透明、全宽）；向下滚动超过阈值后收成玻璃胶囊吸附在顶部，带弹性缓动。
import { useEffect, useState } from "react";
import { IS_DEVNET } from "../config";
import { LANGS, useI18n } from "../i18n";
import type { ScanState } from "../useScan";
import { Logo, Pill } from "./ui";

export type SearchHit = { kind: "trace"; origin: string } | { kind: "request"; id: number } | null;

const DOCK_AT = 96; // 滚动超过这个距离开始吸附

/** rAF 节流的滚动监听，带 16px 回滞，避免在阈值附近来回抖动 */
function useDocked() {
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() =>
        setDocked((d) => (d ? window.scrollY > DOCK_AT - 16 : window.scrollY > DOCK_AT)),
      );
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return docked;
}

export function Nav({ scan, onSearch }: { scan: ScanState; onSearch: (q: string) => SearchHit }) {
  const { t, lang, setLang } = useI18n();
  const docked = useDocked();
  const [q, setQ] = useState("");
  const [notFound, setNotFound] = useState(false);
  const r = scan.snap?.reactive;
  const rpcDown = !!(scan.errors.base || scan.errors.lasna);
  const [tone, label] = rpcDown
    ? ["var(--bad)", t("status.rpcError")]
    : !scan.snap
      ? ["var(--text-dim)", t("status.connecting")]
      : !r
        ? ["var(--warn)", t("status.noReactive")]
        : r.paused || !r.subscribed
          ? ["var(--warn)", r.paused ? t("status.paused") : t("status.unsubscribed")]
          : r.remainingCallbacks === 0n
            ? ["var(--warn)", t("status.budgetEmpty")]
            : ["var(--mint)", t("status.live")];

  const submit = () => {
    const query = q.trim();
    setNotFound(!!query && !onSearch(query));
  };

  return (
    <div className={`nav-wrap ${docked ? "docked" : ""}`}>
      <nav className="nav">
        <a className="brand" href="#top">
          <Logo />
          <span>QueueVault Scan</span>
        </a>
        <div className="search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={q}
            placeholder={t("nav.search")}
            onChange={(e) => {
              setQ(e.target.value);
              setNotFound(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            spellCheck={false}
          />
          {notFound && <span className="search-msg">{t("nav.notFound")}</span>}
        </div>
        <div className="nav-right">
          <Pill title={scan.errors.base ?? scan.errors.lasna}>
            <span className="dot" style={{ color: tone }} />
            {label}
          </Pill>
          {IS_DEVNET && docked && <span className="badge warn sim-mini">{t("sim.short")}</span>}
          <Pill className="net">{IS_DEVNET ? t("nav.devnet") : t("nav.testnet")}</Pill>
          <Pill href="#contracts" className="nav-link">
            {t("nav.contracts")}
          </Pill>
          <div className="lang-switch" role="group" aria-label={t("nav.lang")}>
            {LANGS.map((l) => (
              <button key={l.key} type="button" className={lang === l.key ? "on" : ""} onClick={() => setLang(l.key)} aria-pressed={lang === l.key}>
                {l.label}
              </button>
            ))}
            <i className={`lang-thumb ${lang}`} />
          </div>
        </div>
      </nav>
      {IS_DEVNET && (
        <div className="sim-banner">
          <b>LOCAL SIMULATION</b>
          {t("sim.desc")}
        </div>
      )}
    </div>
  );
}
