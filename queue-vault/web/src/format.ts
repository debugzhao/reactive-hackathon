// 格式化：金额（USDC 6 位小数）、原生币（18 位）、时间、哈希缩写

const USDC_DECIMALS = 6;

/** USDC 最小单位 → 带千分位的字符串；compact 用于大数字卡片（1.2M / 35.4K） */
export function usdc(x: bigint | undefined, opts: { digits?: number; compact?: boolean } = {}): string {
  if (x === undefined) return "—";
  const n = Number(x) / 10 ** USDC_DECIMALS;
  if (opts.compact && Math.abs(n) >= 10_000)
    return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: opts.digits ?? 2 });
}

export const usdcNum = (x: bigint | undefined) => (x === undefined ? NaN : Number(x) / 10 ** USDC_DECIMALS);

/** 18 位小数的原生币（ETH / lREACT） */
export function native(x: bigint | undefined, digits = 4): string {
  if (x === undefined) return "—";
  return (Number(x) / 1e18).toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** 金库 PPS：convertToAssets(1e12) 的结果（份额 12 位小数，资产 6 位小数） */
export const pps = (assetsPerShare: bigint | undefined) =>
  assetsPerShare === undefined ? "—" : (Number(assetsPerShare) / 1e6).toFixed(6);

export function pct(x: number, digits = 1): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "—";
}

/** 0x1234…abcd */
export function short(h: string | undefined, head = 6, tail = 4): string {
  if (!h) return "—";
  return h.length <= head + tail + 2 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** 秒数 → +1.0s；整秒时间戳算出来的差值也保留 1 位小数，避免看起来像整数精度更高 */
export function secs(x: number | undefined, sign = true): string {
  if (x === undefined || !Number.isFinite(x)) return "—";
  return `${sign && x >= 0 ? "+" : ""}${x.toFixed(1)}s`;
}

export function ago(tsSec: number | undefined, nowMs: number): string {
  if (!tsSec) return "—";
  const d = Math.max(0, Math.round(nowMs / 1000 - tsSec));
  if (d < 60) return `${d} second${d === 1 ? "" : "s"} ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86_400)} d ago`;
}

export const clock = (tsSec: number | undefined) => (tsSec ? new Date(tsSec * 1000).toISOString().slice(11, 19) : "—");
