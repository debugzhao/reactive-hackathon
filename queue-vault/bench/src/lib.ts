// 共享工具：读 .env 和部署地址、两条链的客户端、ABI、日志查询、CSV、统计。
// 时间口径：链上时间戳（整秒，Base Sepolia 约 5 个区块共用一个）+ 链下毫秒时间（Date.now()），两者一起报告。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  nonceManager,
  parseAbi,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const USDC = 1_000_000n;

// ───────────── 环境变量与部署地址 ─────────────

function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv(resolve(ROOT, ".env"));

export function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined || v === "") throw new Error(`缺少环境变量 ${key}（见 queue-vault/.env.example）`);
  return v;
}

export type Deployments = { chainId: number; usdc: Address; pool: Address; vault: Address; reactive: Address; settler: Address };
export const deployments: Deployments = JSON.parse(
  readFileSync(resolve(ROOT, process.env.DEPLOYMENTS ?? "deployments/testnet.json"), "utf8"),
);

/** 简单的命令行参数：--rounds 30 --delays 3,10,30 */
export function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export const RESULTS_DIR = resolve(ROOT, "bench", process.env.RESULTS_DIR ?? "results");

// ───────────── ABI ─────────────

export const vaultAbi = parseAbi([
  "function head() view returns (uint256)",
  "function tail() view returns (uint256)",
  "function pendingCount() view returns (uint256)",
  "function getRequest(uint256 id) view returns ((address owner, address receiver, uint128 assetsTotal, uint128 assetsRemaining, uint64 requestedAt, uint64 settledAt))",
  "function totalQueuedAssets() view returns (uint256)",
  "function queueCash() view returns (uint256)",
  "function poolPosition() view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function requestRedeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function settleQueue(uint256 maxCount) returns (uint256, uint256, uint256)",
  "event RedeemRequested(uint256 indexed id, address indexed owner, address indexed receiver, uint256 shares, uint256 assets, uint64 requestedAt)",
  "event Recalled(uint256 wanted, uint256 got, uint256 poolLiquidityAfter)",
  "event RedeemSettled(uint256 indexed id, address indexed receiver, uint256 paid, uint256 remaining, bool done)",
  "event SettleSkipped(uint256 head, uint256 queueCash)",
]);

export const poolAbi = parseAbi([
  "function liquidity() view returns (uint256)",
  "function owed() view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function borrow(uint256 amount)",
  "function repay(uint256 amount)",
  "event Repaid(address indexed payer, uint256 amount, uint256 availableLiquidity, uint64 timestamp)",
  "event LiquidityTaken(address indexed lender, uint256 amount, uint256 availableAfter, uint64 timestamp)",
]);

export const usdcAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export const reactiveAbi = parseAbi([
  "function pause()",
  "function resume()",
  "function paused() view returns (bool)",
  "function subscribed() view returns (bool)",
  "function remainingCallbacks() view returns (uint256)",
  "event SettleRequested(uint256 indexed originTxHash, uint8 source, uint256 seq, uint256 cashForQueue, uint256 headRemaining, uint256 maxCount)",
]);

export const settlerAbi = parseAbi([
  "event ReactiveSettled(uint256 indexed originTxHash, uint8 source, uint256 seq, uint256 recalled, uint256 processed, uint256 paid, uint256 newHead, uint64 timestamp)",
]);

// ───────────── 客户端 ─────────────

/** tipFloor：该链建议小费为 0 但节点要求 ≥ 1 wei（Lasna），发交易时要自己填 gas 和费用，见 send() */
export type Side = { chain: Chain; pub: PublicClient; rpc: string; tipFloor: boolean };
export type Ctx = {
  base: Side;
  lasna: Side;
  main: PrivateKeyAccount; // 部署者：金库 owner、借款人、排队用户
  bot: PrivateKeyAccount; // 轮询机器人（默认与 main 相同，nonceManager 避免并发冲突）
  competitor?: PrivateKeyAccount; // 对手：池子的另一个存款人
  d: Deployments;
};

async function side(name: string, rpc: string): Promise<Side> {
  const probe = createPublicClient({ transport: http(rpc) });
  const [id, tip] = await Promise.all([
    probe.getChainId(),
    probe.request({ method: "eth_maxPriorityFeePerGas" }).then(BigInt, () => 1n),
  ]);
  const chain = defineChain({
    id,
    name,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  return { chain, rpc, pub: createPublicClient({ chain, transport: http(rpc) }) as PublicClient, tipFloor: tip === 0n };
}

function account(key: string): PrivateKeyAccount {
  return privateKeyToAccount(key as Hex, { nonceManager });
}

export async function connect(): Promise<Ctx> {
  const base = await side("base", env("BASE_RPC_URL"));
  const lasna = await side("lasna", env("LASNA_RPC_URL"));
  const main = account(env("PRIVATE_KEY"));
  const bot = process.env.BOT_KEY ? account(process.env.BOT_KEY) : main;
  const competitor = process.env.COMPETITOR_KEY ? account(process.env.COMPETITOR_KEY) : undefined;
  return { base, lasna, main, bot, competitor, d: deployments };
}

export function wallet(s: Side, acct: PrivateKeyAccount): WalletClient {
  return createWalletClient({ account: acct, chain: s.chain, transport: http(s.rpc) });
}

/** 发交易并等回执；返回回执和「拿到回执的本机毫秒时间」 */
export async function send(
  s: Side,
  acct: PrivateKeyAccount,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
) {
  const w = wallet(s, acct);
  const req = { address, abi, functionName, args, account: acct, chain: s.chain };
  // Lasna 的 eth_maxPriorityFeePerGas / eth_fillTransaction 都给出 tip = 0，但节点拒收 tip < 1 wei 的交易
  // （"gas tip cap 0, minimum needed 1"）。viem 会直接采用 fillTransaction 的结果，所以这里把 gas 和费用全部自己填好，
  // 让 viem 跳过 fillTransaction。forge/cast 默认至少给 1 wei，所以部署时没遇到。Base 不受影响，仍走 viem 默认流程。
  const extra = s.tipFloor
    ? await (async () => {
        const [gas, block] = await Promise.all([s.pub.estimateContractGas(req as never), s.pub.getBlock()]);
        const tip = 1_000_000_000n; // 1 gwei：远高于下限，相对 100 gwei 的 base fee 可以忽略
        return { gas: (gas * 12n) / 10n, maxPriorityFeePerGas: tip, maxFeePerGas: block.baseFeePerGas! * 2n + tip };
      })()
    : {};
  const hash = await w.writeContract({ ...req, ...extra } as never);
  const receipt = await s.pub.waitForTransactionReceipt({ hash, pollingInterval: 200 });
  const seenMs = Date.now();
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, receipt, seenMs };
}

export async function read<T>(s: Side, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  return (await s.pub.readContract({ address, abi, functionName, args } as never)) as T;
}

const tsCache = new Map<string, number>();
/** 区块时间戳（秒）。Base Sepolia 是整秒，约 5 个区块共用一个 */
export async function blockTs(s: Side, blockNumber: bigint): Promise<number> {
  const k = `${s.chain.id}:${blockNumber}`;
  if (!tsCache.has(k)) tsCache.set(k, Number((await s.pub.getBlock({ blockNumber })).timestamp));
  return tsCache.get(k)!;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 反复执行 fn，直到返回非 undefined 或超时（返回 undefined） */
export async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs: number, everyMs = 250): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(everyMs);
  }
  return undefined;
}

/** 单次 eth_getLogs 的区块跨度上限。sepolia.base.org 限制 200 个区块（200ms 出块下只有约 40 秒），超出直接报 413 */
export const LOG_RANGE = BigInt(process.env.LOG_RANGE ?? 199);

type LogQuery = { address: Address; abi: Abi; eventName?: string; args?: Record<string, unknown> };

/** 分段查日志：把 [fromBlock, toBlock] 切成不超过 LOG_RANGE 的小段依次查询 */
export async function getEvents<T = { transactionHash: Hex; blockNumber: bigint; args: Record<string, unknown> }>(
  s: Side,
  q: LogQuery,
  fromBlock: bigint,
  toBlock?: bigint,
): Promise<T[]> {
  const end = toBlock ?? (await s.pub.getBlockNumber());
  const out: T[] = [];
  for (let from = fromBlock; from <= end; from += LOG_RANGE + 1n) {
    const to = from + LOG_RANGE < end ? from + LOG_RANGE : end;
    out.push(...((await s.pub.getContractEvents({ ...q, fromBlock: from, toBlock: to } as never)) as unknown as T[]));
  }
  return out;
}

/** 按 originTxHash（indexed uint256）找日志 */
export async function findByOrigin(s: Side, address: Address, abi: Abi, eventName: string, originTx: Hex, fromBlock: bigint) {
  const logs = await getEvents<{ transactionHash: Hex; blockNumber: bigint; args: Record<string, bigint> }>(
    s,
    { address, abi, eventName, args: { originTxHash: BigInt(originTx) } },
    fromBlock,
  );
  return logs[0];
}

/** 确保 owner 给 spender 的授权足够（实验开始前做一次，避免把 approve 算进延迟） */
export async function ensureAllowance(ctx: Ctx, acct: PrivateKeyAccount, spender: Address, amount: bigint) {
  const cur = await read<bigint>(ctx.base, ctx.d.usdc, usdcAbi, "allowance", [acct.address, spender]);
  if (cur < amount) await send(ctx.base, acct, ctx.d.usdc, usdcAbi, "approve", [spender, 2n ** 255n]);
}

export async function ensureBalance(ctx: Ctx, acct: PrivateKeyAccount, amount: bigint) {
  const bal = await read<bigint>(ctx.base, ctx.d.usdc, usdcAbi, "balanceOf", [acct.address]);
  if (bal < amount) await send(ctx.base, acct, ctx.d.usdc, usdcAbi, "mint", [acct.address, amount - bal]);
}

// ───────────── CSV 与统计 ─────────────

export function csvAppend(file: string, row: Record<string, string | number | bigint>) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = resolve(RESULTS_DIR, file);
  if (!existsSync(path)) writeFileSync(path, Object.keys(row).join(",") + "\n");
  appendFileSync(path, Object.values(row).map(String).join(",") + "\n");
}

export function csvRead(path: string): Record<string, string>[] {
  const [head, ...rows] = readFileSync(path, "utf8").trim().split("\n");
  const keys = head.split(",");
  return rows.filter(Boolean).map((r) => Object.fromEntries(r.split(",").map((v, i) => [keys[i], v])));
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** nearest-rank 百分位：n 小的时候结果不稳定，报告里要注明 n */
export function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

export const fmtUsdc = (x: bigint) => (Number(x) / 1e6).toFixed(2);
export const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
