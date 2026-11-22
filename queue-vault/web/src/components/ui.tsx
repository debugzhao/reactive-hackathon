// 基础组件：玻璃卡片、胶囊、徽章、滚动数字、交易/地址链接、复制按钮
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { type ChainKey, addrUrl, txUrl } from "../config";
import { short } from "../format";

export function GlassCard(props: {
  id?: string;
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  error?: string;
  highlight?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <section id={props.id} className={`card ${props.highlight ? "highlight" : ""} ${props.className ?? ""}`} style={props.style}>
      {props.error && (
        <span className="card-error" title={props.error}>
          <Badge tone="bad">RPC error</Badge>
        </span>
      )}
      {(props.title || props.right) && (
        <div className="card-head">
          <div>
            {props.title && <div className="card-title">{props.title}</div>}
            {props.sub && <div className="card-sub">{props.sub}</div>}
          </div>
          {props.right && <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{props.right}</div>}
        </div>
      )}
      {props.children}
    </section>
  );
}

export type Tone = "mint" | "lasna" | "base" | "warn" | "bad" | undefined;

export function Badge({ tone, children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone ?? ""}`} title={title}>
      {children}
    </span>
  );
}

export const ChainBadge = ({ chain }: { chain: ChainKey }) => (
  <Badge tone={chain === "base" ? "base" : "lasna"}>{chain === "base" ? "Base" : "Lasna"}</Badge>
);

export function Pill(props: {
  children: ReactNode;
  active?: boolean;
  small?: boolean;
  btn?: boolean;
  href?: string;
  onClick?: () => void;
  title?: string;
  style?: CSSProperties;
  className?: string;
}) {
  const cls = `pill ${props.small ? "sm" : ""} ${props.active ? "active" : ""} ${props.btn ? "btn" : ""} ${props.className ?? ""}`;
  if (props.href)
    return (
      <a className={cls} href={props.href} title={props.title} style={props.style}>
        {props.children}
      </a>
    );
  if (props.onClick)
    return (
      <button type="button" className={cls} onClick={props.onClick} title={props.title} style={props.style}>
        {props.children}
      </button>
    );
  return (
    <span className={cls} title={props.title} style={props.style}>
      {props.children}
    </span>
  );
}

const reduceMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** 数字变化时 300ms 缓动过渡；format 负责把数值转成显示字符串 */
export function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (!Number.isFinite(value) || !Number.isFinite(from.current) || reduceMotion()) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 300);
      const e = 1 - (1 - k) ** 3;
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value]);
  return <span className="num">{Number.isFinite(value) ? format(shown) : "—"}</span>;
}

export function TxLink({ chain, hash, head = 8, tail = 6 }: { chain: ChainKey; hash?: string; head?: number; tail?: number }) {
  if (!hash) return <span className="mono faint">—</span>;
  const url = txUrl(chain, hash);
  const text = short(hash, head, tail);
  return url ? (
    <a className="mono link" href={url} target="_blank" rel="noreferrer" title={hash}>
      {text}
    </a>
  ) : (
    <span className="mono" title={hash}>
      {text}
    </span>
  );
}

export function AddrLink({ chain, address, full }: { chain: ChainKey; address: string; full?: boolean }) {
  const url = addrUrl(chain, address);
  const text = full ? address : short(address, 8, 6);
  return url ? (
    <a className="mono link" href={url} target="_blank" rel="noreferrer" title={address}>
      {text}
    </a>
  ) : (
    <span className="mono" title={address}>
      {text}
    </span>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        });
      }}
    >
      {ok ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--mint)" strokeWidth="2.4">
          <path d="M5 12l5 5L20 7" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="9" y="9" width="12" height="12" rx="3" />
          <path d="M5 15V6a3 3 0 0 1 3-3h9" />
        </svg>
      )}
    </button>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="lg-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#bfd4fa" />
          <stop offset="1" stopColor="#5b8cff" />
        </linearGradient>
        <linearGradient id="lg-bolt" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#a9c6ff" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="13.5" fill="rgba(147,197,253,0.08)" stroke="url(#lg-ring)" strokeWidth="1.6" />
      <path d="M18 5 9 18h6l-2 9 9-13h-6z" fill="url(#lg-bolt)" />
    </svg>
  );
}

/** 跟随鼠标的玻璃 tooltip：容器需要 position: relative */
export function useTooltip<T>() {
  const [tip, setTip] = useState<{ x: number; y: number; data: T } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const show = (e: React.MouseEvent, data: T) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, data });
  };
  return { ref, tip, show, hide: () => setTip(null) };
}

export function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  // 靠右时翻到左边，避免溢出卡片
  const left = x + 250 > width ? Math.max(0, x - 250) : x + 14;
  return (
    <div className="tooltip" style={{ left, top: y + 14 }}>
      {children}
    </div>
  );
}
