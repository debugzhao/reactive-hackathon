// 悬浮玻璃导航：Logo、搜索（交易哈希 / #请求ID）、状态胶囊、网络胶囊、Contracts 锚点
import { useState } from "react";
import { IS_DEVNET } from "../config";
import type { ScanState } from "../useScan";
import { Logo, Pill } from "./ui";

export type SearchHit = { kind: "trace"; origin: string } | { kind: "request"; id: number } | null;

export function Nav({ scan, onSearch }: { scan: ScanState; onSearch: (q: string) => SearchHit }) {
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<string>();
  const r = scan.snap?.reactive;
  const rpcDown = !!(scan.errors.base || scan.errors.lasna);
  const [tone, label] = rpcDown
    ? ["var(--bad)", "RPC error"]
    : !scan.snap
      ? ["var(--text-dim)", "Connecting"]
      : !r
        ? ["var(--warn)", "No reactive"]
        : r.paused || !r.subscribed
          ? ["var(--warn)", r.paused ? "Paused" : "Unsubscribed"]
          : r.remainingCallbacks === 0n
            ? ["var(--warn)", "Budget empty"]
            : ["var(--mint)", "Live"];

  const submit = () => {
    const hit = onSearch(q.trim());
    setMsg(q.trim() && !hit ? "not found" : undefined);
    if (hit) setTimeout(() => setMsg(undefined), 50);
  };

  return (
    <div className="nav-wrap">
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
            placeholder="Search by tx hash or #request id"
            onChange={(e) => {
              setQ(e.target.value);
              setMsg(undefined);
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            spellCheck={false}
          />
          {msg && <span className="search-msg" style={{ color: "var(--bad)" }}>{msg}</span>}
        </div>
        <div className="nav-right">
          <Pill title={scan.errors.base ?? scan.errors.lasna}>
            <span className="dot" style={{ color: tone }} />
            {label}
          </Pill>
          <Pill className="net">
            {IS_DEVNET ? "Devnet · anvil" : "Base Sepolia ⇄ Lasna"}
          </Pill>
          <Pill href="#contracts">Contracts</Pill>
        </div>
      </nav>
      {IS_DEVNET && (
        <div className="sim-banner">
          <b>LOCAL SIMULATION</b>
          Local anvil + devnet-relay. Cross-chain delays are artificially injected (~0.8s per hop) and carry no experimental meaning.
        </div>
      )}
    </div>
  );
}
