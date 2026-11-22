// 轮询主循环：快照 + 队列请求 + 两条链的增量日志 + 跨链关联，统一放进一个 state。
// 任何一路 RPC 失败都只记错误、保留上一次的数据，页面不会白屏。
import { useEffect, useRef, useState } from "react";
import {
  type Ev,
  type RedeemRequest,
  type Snapshot,
  type Trace,
  buildTraces,
  makeScanners,
  readRequests,
  readSnapshot,
} from "./chain";
import { type ChainKey, DEPLOYMENTS, POLL_MS } from "./config";

export const HEATMAP_CELLS = 120;
const MAX_EVENTS = 2_000;

export type ScanState = {
  snap?: Snapshot;
  requests: RedeemRequest[];
  events: Ev[]; // 新的在前
  traces: Trace[];
  syncing: number; // 历史日志同步进度 0..1
  errors: Partial<Record<ChainKey, string>>;
  updatedAt?: number;
};

const msg = (e: unknown) => (e as Error).message.split("\n")[0].slice(0, 160);

export function useScan(): ScanState {
  const [state, setState] = useState<ScanState>({ requests: [], events: [], traces: [], syncing: 0, errors: {} });
  const events = useRef<Map<string, Ev>>(new Map());
  const last = useRef<{ snap?: Snapshot; requests: RedeemRequest[]; traces: Trace[] }>({ requests: [], traces: [] });

  useEffect(() => {
    if (!DEPLOYMENTS) return;
    let alive = true;
    const scanners = makeScanners();

    const tick = async () => {
      const errors: Partial<Record<ChainKey, string>> = {};
      const [snapR, ...scanR] = await Promise.allSettled([readSnapshot(), ...scanners.map((s) => s.step())]);

      if (snapR.status === "fulfilled") {
        last.current.snap = snapR.value.snap;
        if (snapR.value.lasnaError) errors.lasna = snapR.value.lasnaError;
      } else errors.base = msg(snapR.reason);

      scanR.forEach((r, i) => {
        if (r.status === "fulfilled") for (const e of r.value) events.current.set(e.key, e);
        else errors[scanners[i].chain] ??= msg(r.reason);
      });

      const all = [...events.current.values()].sort(
        (a, b) => (b.ts ?? 0) - (a.ts ?? 0) || Number(b.block - a.block) || b.logIndex - a.logIndex,
      );
      if (all.length > MAX_EVENTS) for (const e of all.splice(MAX_EVENTS)) events.current.delete(e.key);

      const snap = last.current.snap;
      const [reqR, trR] = await Promise.allSettled([
        snap ? readRequests(snap.vault.tail, HEATMAP_CELLS) : Promise.resolve(last.current.requests),
        buildTraces(all),
      ]);
      if (reqR.status === "fulfilled") last.current.requests = reqR.value;
      else errors.base ??= msg(reqR.reason);
      if (trR.status === "fulfilled") last.current.traces = trR.value;
      else errors.base ??= msg(trR.reason);

      const syncing = Math.min(...scanners.map((s) => s.progress));
      if (alive)
        setState({
          snap,
          requests: last.current.requests,
          events: all,
          traces: last.current.traces,
          syncing,
          errors,
          updatedAt: Date.now(),
        });
    };

    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await tick();
      // 历史还没扫完时立即接着扫，扫完后按 POLL_MS 轮询
      const behind = scanners.some((s) => s.progress < 1);
      if (alive) timer = setTimeout(loop, behind ? 50 : POLL_MS);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  return state;
}

/** 定时刷新，用于「N seconds ago」和进行中链路的计时 */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
