import { useState } from "react";
import { Contracts } from "./components/Contracts";
import { Events } from "./components/Events";
import { Experiments } from "./components/Experiments";
import { Heatmap } from "./components/Heatmap";
import { Hero } from "./components/Hero";
import { Latency } from "./components/Latency";
import { Nav, type SearchHit } from "./components/Nav";
import { Pipeline } from "./components/Pipeline";
import { GlassCard } from "./components/ui";
import { DEPLOYMENTS, NETWORK } from "./config";
import { useI18n } from "./i18n";
import { useScan } from "./useScan";

const REPO = (import.meta.env.VITE_REPO_URL as string | undefined) ?? "https://github.com/debugzhao/reactive-hackathon";
const DOC = `${REPO}/blob/master/docs/${encodeURIComponent("即时结算提款队列-产品与技术方案.md")}`;

export function App() {
  const { t } = useI18n();
  const scan = useScan();
  const [traceSel, setTraceSel] = useState<string>();
  const [reqSel, setReqSel] = useState<number>();
  const [flash, setFlash] = useState<"pipeline" | "heatmap">();

  const focus = (id: "pipeline" | "heatmap") => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setFlash(id);
    setTimeout(() => setFlash(undefined), 2400);
  };

  /** 交易哈希：匹配任一段（触发 / react / 回调）；#12 或 12：匹配请求 */
  const onSearch = (q: string): SearchHit => {
    const s = q.toLowerCase();
    if (!s) return null;
    if (/^0x[0-9a-f]{64}$/.test(s)) {
      const t = scan.traces.find((t) => t.origin === s || t.react?.tx === s || t.callback?.tx === s || t.skipped?.tx === s);
      if (t) {
        setTraceSel(t.origin);
        focus("pipeline");
        return { kind: "trace", origin: t.origin };
      }
      return null;
    }
    const m = s.match(/^#?(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (scan.requests.some((r) => r.id === id)) {
        setReqSel(id);
        focus("heatmap");
        return { kind: "request", id };
      }
    }
    return null;
  };

  return (
    <div className="page">
      <Nav scan={scan} onSearch={onSearch} />
      <Hero scan={scan} />
      <main className="container">
        {!DEPLOYMENTS ? (
          <GlassCard title={t("app.noDeploy")}>
            <div className="empty" style={{ textAlign: "left" }}>
              {t("app.noDeployDesc", { net: NETWORK })}
              <code className="code">cd queue-vault && bash bin/deploy.sh{"\n"}# or locally:{"\n"}bash bin/devnet.sh && (cd web && npm run dev:devnet)</code>
            </div>
          </GlassCard>
        ) : (
          <>
            <Pipeline scan={scan} selected={traceSel} highlight={flash === "pipeline"} />
            {traceSel && (
              <div style={{ textAlign: "right", marginTop: 8 }}>
                <button type="button" className="pill sm" onClick={() => setTraceSel(undefined)}>
                  {t("app.back")}
                </button>
              </div>
            )}
            <div className="grid grid-2-even section">
              <Latency scan={scan} />
              <Heatmap scan={scan} selected={reqSel} highlight={flash === "heatmap"} />
            </div>
            <div className="grid grid-2 section" style={{ alignItems: "start" }}>
              <Events scan={scan} />
              <Contracts scan={scan} />
            </div>
          </>
        )}
        <div className="section">
          <Experiments />
        </div>
        <footer className="footer">
          <span>{t("footer.source")}</span>
          <span style={{ display: "flex", gap: 18 }}>
            <a className="link" href={REPO} target="_blank" rel="noreferrer">
              {t("footer.repo")}
            </a>
            <a className="link" href={DOC} target="_blank" rel="noreferrer">
              {t("footer.doc")}
            </a>
          </span>
        </footer>
      </main>
    </div>
  );
}
