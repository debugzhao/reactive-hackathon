// 数据层：两条链的只读客户端、状态快照、队列请求、增量扫日志、按 originTxHash 跨链关联。
// 全部是链上实时数据，没有任何模拟值；读不到就显示空状态。
import { type Abi, type Address, type Hex, type PublicClient, createPublicClient, decodeEventLog, defineChain, http, toHex } from "viem";
import { baseEventsAbi, lasnaEventsAbi, poolAbi, reactiveAbi, usdcAbi, vaultAbi } from "./abi";
import {
  BASE_RPC,
  type ChainKey,
  DEPLOYMENTS,
  IS_DEVNET,
  LASNA_RPC,
  LOG_CHUNK,
  LOOKBACK,
  MULTICALL3,
  hasReactive,
  hasSettler,
} from "./config";

const baseChain = defineChain({
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [BASE_RPC] } },
  ...(IS_DEVNET ? {} : { contracts: { multicall3: { address: MULTICALL3 } } }),
});

export const clients: Record<ChainKey, PublicClient> = {
  // 测试网上用 multicall 把十几个 view 合成一次请求，减轻公共 RPC 的限流压力
  base: createPublicClient({ chain: baseChain, transport: http(BASE_RPC), batch: { multicall: !IS_DEVNET } }) as PublicClient,
  lasna: createPublicClient({ transport: http(LASNA_RPC) }) as PublicClient,
};

// ───────────── 状态快照 ─────────────

export type Snapshot = {
  at: number;
  baseBlock: bigint;
  vault: {
    totalAssets: bigint;
    totalSupply: bigint;
    assetsPerShare: bigint; // 1 份额（12 位小数）值多少 USDC 最小单位
    cash: bigint;
    queueCash: bigint;
    instantCash: bigint;
    poolPosition: bigint;
    pendingCount: bigint;
    head: bigint;
    tail: bigint;
    totalQueued: bigint;
    totalClaimable: bigint;
    seq: bigint;
    bufferBps: number;
  };
  pool: { liquidity: bigint; owed: bigint; totalAssets: bigint; aprBps: bigint };
  reactive?: {
    lasnaBlock: bigint;
    paused: boolean;
    subscribed: boolean;
    remainingCallbacks: bigint;
    reactCount: bigint;
    callbackCount: bigint;
    maxPerCallback: bigint;
    minSettleAssets: bigint;
    callbackGasLimit: bigint;
    windowCount: number;
    maxReactsPerWindow: number;
    windowSeconds: number;
    balance: bigint;
    mirror: { seq: bigint; queueCash: bigint; headId: bigint; headRemaining: bigint; pendingCount: bigint };
  };
  settlerBalance?: bigint;
};

type R = <T>(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) => Promise<T>;
const reader =
  (c: PublicClient): R =>
  (address, abi, functionName, args = []) =>
    c.readContract({ address, abi, functionName, args } as never) as never;

let lastReactive: Snapshot["reactive"];

/** Base 读失败直接抛错（调用方保留上一次快照）；Lasna 读失败只记错误，沿用上一次的 Reactive 状态 */
export async function readSnapshot(): Promise<{ snap: Snapshot; lasnaError?: string }> {
  const d = DEPLOYMENTS!;
  const rb = reader(clients.base);
  const v = <T>(fn: string, args?: readonly unknown[]) => rb<T>(d.vault, vaultAbi, fn, args);
  const p = <T>(fn: string) => rb<T>(d.pool, poolAbi, fn);

  const [baseBlock, vault, pool, settlerBalance] = await Promise.all([
    clients.base.getBlockNumber(),
    Promise.all([
      v<bigint>("totalAssets"),
      v<bigint>("totalSupply"),
      v<bigint>("convertToAssets", [10n ** 12n]),
      rb<bigint>(d.usdc, usdcAbi, "balanceOf", [d.vault]),
      v<bigint>("queueCash"),
      v<bigint>("instantCash"),
      v<bigint>("poolPosition"),
      v<bigint>("pendingCount"),
      v<bigint>("head"),
      v<bigint>("tail"),
      v<bigint>("totalQueuedAssets"),
      v<bigint>("totalClaimable"),
      v<bigint>("snapshotSeq"),
      v<number>("BUFFER_BPS"),
    ]),
    Promise.all([p<bigint>("liquidity"), p<bigint>("owed"), p<bigint>("totalAssets"), p<bigint>("APR_BPS")]),
    hasSettler() ? clients.base.getBalance({ address: d.settler }) : Promise.resolve(undefined),
  ]);

  const snap: Snapshot = {
    at: Date.now(),
    baseBlock,
    vault: {
      totalAssets: vault[0],
      totalSupply: vault[1],
      assetsPerShare: vault[2],
      cash: vault[3],
      queueCash: vault[4],
      instantCash: vault[5],
      poolPosition: vault[6],
      pendingCount: vault[7],
      head: vault[8],
      tail: vault[9],
      totalQueued: vault[10],
      totalClaimable: vault[11],
      seq: vault[12],
      bufferBps: Number(vault[13]),
    },
    pool: { liquidity: pool[0], owed: pool[1], totalAssets: pool[2], aprBps: pool[3] },
    settlerBalance,
  };

  if (!hasReactive()) return { snap };
  try {
    snap.reactive = await readReactive();
    lastReactive = snap.reactive;
    return { snap };
  } catch (e) {
    snap.reactive = lastReactive;
    return { snap, lasnaError: (e as Error).message.split("\n")[0].slice(0, 160) };
  }
}

async function readReactive(): Promise<NonNullable<Snapshot["reactive"]>> {
  const d = DEPLOYMENTS!;
  {
    const rl = reader(clients.lasna);
    const r = <T>(fn: string) => rl<T>(d.reactive, reactiveAbi, fn);
    const x = await Promise.all([
      clients.lasna.getBlockNumber(),
      r<boolean>("paused"),
      r<boolean>("subscribed"),
      r<bigint>("remainingCallbacks"),
      r<bigint>("reactCount"),
      r<bigint>("callbackCount"),
      r<bigint>("maxPerCallback"),
      r<bigint>("minSettleAssets"),
      r<bigint>("callbackGasLimit"),
      r<number>("windowCount"),
      r<number>("maxReactsPerWindow"),
      r<number>("windowSeconds"),
      clients.lasna.getBalance({ address: d.reactive }),
      r<readonly bigint[]>("mirror"),
    ]);
    const m = x[13];
    return {
      lasnaBlock: x[0],
      paused: x[1],
      subscribed: x[2],
      remainingCallbacks: x[3],
      reactCount: x[4],
      callbackCount: x[5],
      maxPerCallback: x[6],
      minSettleAssets: x[7],
      callbackGasLimit: x[8],
      windowCount: Number(x[9]),
      maxReactsPerWindow: Number(x[10]),
      windowSeconds: Number(x[11]),
      balance: x[12],
      mirror: { seq: m[0], queueCash: m[1], headId: m[3], headRemaining: m[4], pendingCount: m[6] },
    };
  }
}

// ───────────── 队列请求（热力图） ─────────────

export type RedeemRequest = {
  id: number;
  owner: Address;
  receiver: Address;
  assetsTotal: bigint;
  assetsRemaining: bigint;
  requestedAt: number;
  settledAt: number;
};

const requestCache = new Map<number, RedeemRequest>();

/** 读最近 count 个请求。已结清的请求不会再变，只读一次；未结清的每轮重读 */
export async function readRequests(tail: bigint, count: number): Promise<RedeemRequest[]> {
  const d = DEPLOYMENTS!;
  const last = Number(tail) - 1;
  const first = Math.max(1, last - count + 1);
  const ids: number[] = [];
  for (let id = first; id <= last; id++) {
    const c = requestCache.get(id);
    if (!c || c.assetsRemaining > 0n) ids.push(id);
  }
  const rb = reader(clients.base);
  const rows = await Promise.all(
    ids.map((id) =>
      rb<{ owner: Address; receiver: Address; assetsTotal: bigint; assetsRemaining: bigint; requestedAt: bigint; settledAt: bigint }>(
        d.vault,
        vaultAbi,
        "getRequest",
        [BigInt(id)],
      ),
    ),
  );
  rows.forEach((r, i) =>
    requestCache.set(ids[i], {
      id: ids[i],
      owner: r.owner,
      receiver: r.receiver,
      assetsTotal: r.assetsTotal,
      assetsRemaining: r.assetsRemaining,
      requestedAt: Number(r.requestedAt),
      settledAt: Number(r.settledAt),
    }),
  );
  const out: RedeemRequest[] = [];
  for (let id = first; id <= last; id++) out.push(requestCache.get(id)!);
  return out;
}

// ───────────── 增量扫日志 ─────────────

export type Ev = {
  key: string;
  chain: ChainKey;
  name: string;
  args: Record<string, unknown>;
  address: Address;
  tx: Hex;
  block: bigint;
  logIndex: number;
  ts?: number; // 区块时间戳（秒）
};

const tsCache = new Map<string, number>();
export async function blockTs(chain: ChainKey, block: bigint): Promise<number> {
  const k = `${chain}:${block}`;
  if (!tsCache.has(k)) tsCache.set(k, Number((await clients[chain].getBlock({ blockNumber: block })).timestamp));
  return tsCache.get(k)!;
}

/** 事件里自带时间戳的直接用，省一次 getBlock */
const tsFromArgs = (a: Record<string, unknown>) => (a.timestamp ?? a.requestedAt) as bigint | undefined;

export class Scanner {
  private cursor?: bigint;
  head = 0n;
  from = 0n;
  constructor(
    readonly chain: ChainKey,
    private readonly addresses: Address[],
    private readonly abi: Abi,
    private readonly startBlock?: number,
  ) {}

  /** 进度 0..1，用于首屏显示「正在同步历史日志」 */
  get progress() {
    if (this.cursor === undefined || this.head <= this.from) return this.cursor === undefined ? 0 : 1;
    return Math.min(1, Number(this.cursor - this.from) / Number(this.head - this.from));
  }

  /** 每次最多扫 maxChunks 段，避免首屏一次性打太多请求 */
  async step(maxChunks = 4): Promise<Ev[]> {
    const c = clients[this.chain];
    this.head = await c.getBlockNumber();
    if (this.cursor === undefined) {
      const start = this.startBlock && this.startBlock > 0 ? BigInt(this.startBlock) : this.head - LOOKBACK;
      this.cursor = start > 0n ? start : 0n;
      this.from = this.cursor;
    }
    const out: Ev[] = [];
    let cursor: bigint = this.cursor;
    for (let i = 0; i < maxChunks && cursor <= this.head; i++) {
      const to: bigint = cursor + LOG_CHUNK - 1n < this.head ? cursor + LOG_CHUNK - 1n : this.head;
      let logs: Awaited<ReturnType<typeof c.getLogs>>;
      try {
        logs = await c.getLogs({ address: this.addresses, fromBlock: cursor, toBlock: to });
      } catch (e) {
        if (!out.length) throw e;
        break; // 前面几段已经扫到的日志先交出去，失败的这段下一轮重扫
      }
      for (const l of logs) {
        let decoded: { eventName: string; args: unknown };
        try {
          decoded = decodeEventLog({ abi: this.abi, data: l.data, topics: l.topics });
        } catch {
          continue; // ERC20 Transfer、LiquiditySnapshot 等不展示的事件
        }
        const args = (decoded.args ?? {}) as Record<string, unknown>;
        const t = tsFromArgs(args);
        out.push({
          key: `${this.chain}:${l.transactionHash}:${l.logIndex}`,
          chain: this.chain,
          name: decoded.eventName,
          args,
          address: l.address,
          tx: l.transactionHash!,
          block: l.blockNumber!,
          logIndex: l.logIndex!,
          ts: t !== undefined ? Number(t) : undefined,
        });
      }
      cursor = to + 1n;
      this.cursor = cursor; // 每段成功后才推进，失败的段下一轮重扫
    }
    // 没自带时间戳的事件按区块补齐（同一区块只查一次），每批 8 个并发，避免触发公共 RPC 限流
    const blocks = [...new Set(out.filter((e) => e.ts === undefined).map((e) => e.block))];
    for (let i = 0; i < blocks.length; i += 8)
      await Promise.allSettled(blocks.slice(i, i + 8).map((b) => blockTs(this.chain, b)));
    for (const e of out) if (e.ts === undefined) e.ts = tsCache.get(`${this.chain}:${e.block}`);
    return out;
  }
}

export function makeScanners(): Scanner[] {
  const d = DEPLOYMENTS!;
  const base = [d.vault, d.pool, ...(hasSettler() ? [d.settler] : [])];
  const s = [new Scanner("base", base, baseEventsAbi as Abi, d.baseBlock)];
  if (hasReactive()) s.push(new Scanner("lasna", [d.reactive], lasnaEventsAbi as Abi, d.lasnaBlock));
  return s;
}

// ───────────── 跨链关联：Base 触发 → Lasna react → Base 回调 ─────────────

export type Trace = {
  origin: Hex;
  source: "REPAY" | "SNAPSHOT";
  originEvent?: string; // 触发交易里能识别的事件，例如 Repaid / RedeemRequested
  t0?: number; // Base 触发交易的区块时间（秒）
  react?: Ev; // Lasna SettleRequested
  skipped?: Ev; // Lasna Skipped
  callback?: Ev; // Base ReactiveSettled
  t1?: number;
  t2?: number;
  status: "SETTLED" | "IN FLIGHT" | "SKIPPED" | "WAITING";
};

const hexOf = (x: unknown) => toHex(x as bigint, { size: 32 }) as Hex;
const originTs = new Map<string, number>();

async function originBlockTs(origin: Hex, known?: Ev): Promise<number | undefined> {
  if (known?.ts) return known.ts;
  if (originTs.has(origin)) return originTs.get(origin);
  try {
    const r = await clients.base.getTransactionReceipt({ hash: origin });
    const t = await blockTs("base", r.blockNumber);
    originTs.set(origin, t);
    return t;
  } catch {
    return undefined;
  }
}

/**
 * 以 originTxHash 为主键把三段串起来。来源：
 * - 每个 Repaid 都是一次潜在的触发（即使 Reactive 判定跳过，也能看到 SKIPPED）
 * - 每个 SettleRequested / ReactiveSettled 都带 originTxHash（可能来自金库快照，例如排队交易本身）
 */
export async function buildTraces(all: Ev[], limit = 60): Promise<Trace[]> {
  const byOrigin = new Map<string, Trace>();
  const baseByTx = new Map<string, Ev>();
  for (const e of all) if (e.chain === "base" && (e.name === "Repaid" || e.name === "RedeemRequested")) baseByTx.set(e.tx, e);

  const get = (origin: Hex, src: number | "REPAY") => {
    let t = byOrigin.get(origin);
    if (!t) {
      t = { origin, source: src === "REPAY" || src === 2 ? "REPAY" : "SNAPSHOT", status: "WAITING" };
      byOrigin.set(origin, t);
    }
    return t;
  };
  for (const e of all) {
    if (e.chain === "base" && e.name === "Repaid") get(e.tx, "REPAY");
    if (e.name === "SettleRequested") get(hexOf(e.args.originTxHash), Number(e.args.source)).react = e;
    if (e.name === "Skipped") get(hexOf(e.args.originTxHash), "REPAY").skipped ??= e;
    if (e.name === "ReactiveSettled") {
      const t = get(hexOf(e.args.originTxHash), Number(e.args.source));
      if (!t.callback) t.callback = e;
    }
  }

  const sortKey = (t: Trace) => Math.max(t.callback?.ts ?? 0, t.react?.ts ?? 0, t.skipped?.ts ?? 0, baseByTx.get(t.origin)?.ts ?? 0);
  const traces = [...byOrigin.values()].sort((a, b) => sortKey(b) - sortKey(a)).slice(0, limit);
  await Promise.all(
    traces.map(async (t) => {
      const ev = baseByTx.get(t.origin);
      t.originEvent = ev?.name;
      t.t0 = await originBlockTs(t.origin, ev);
      t.t1 = t.react?.ts;
      if (t.callback) t.t2 = t.callback.ts;
      t.status = t.callback ? "SETTLED" : t.react ? "IN FLIGHT" : t.skipped ? "SKIPPED" : "WAITING";
    }),
  );
  return traces;
}

