// 网络与部署配置。地址只从 ../deployments/*.json 读取（部署脚本写入），前端不硬编码任何合约地址。
import type { Address } from "viem";

export type Deployments = {
  chainId: number;
  usdc: Address;
  pool: Address;
  vault: Address;
  reactive: Address;
  settler: Address;
  baseBlock?: number; // 部署脚本记录的起始区块，前端从这里开始扫日志
  lasnaBlock?: number;
};

const files = import.meta.glob<Deployments>("../../deployments/*.json", { eager: true, import: "default" });
const pick = (name: string) => files[`../../deployments/${name}.json`];

const env = import.meta.env;
const requested = env.VITE_NETWORK as string | undefined;

/** 优先 VITE_NETWORK；没指定时有 testnet.json 就用测试网，否则退回本地 devnet */
export const NETWORK: "testnet" | "devnet" =
  requested === "devnet" || (!requested && !pick("testnet") && pick("devnet")) ? "devnet" : "testnet";
export const IS_DEVNET = NETWORK === "devnet";
export const DEPLOYMENTS: Deployments | undefined = pick(NETWORK);

const DEVNET_RPC = "http://127.0.0.1:8546";
export const BASE_RPC: string = env.VITE_BASE_RPC_URL ?? (IS_DEVNET ? DEVNET_RPC : "https://sepolia.base.org");
export const LASNA_RPC: string = env.VITE_LASNA_RPC_URL ?? (IS_DEVNET ? DEVNET_RPC : "https://lasna-rpc.rnk.dev/");

/** 部署文件里没有起始区块时，往回扫多少个区块 */
export const LOOKBACK = BigInt(env.VITE_LOOKBACK_BLOCKS ?? 20_000);
/** 单次 getLogs 的区块跨度：公共 RPC 一般有上限，扫不动就调小 */
export const LOG_CHUNK = BigInt(env.VITE_LOG_CHUNK ?? 5_000);
export const POLL_MS = Number(env.VITE_POLL_MS ?? 2_000);

/** Base Sepolia 上 Multicall3 的标准地址；本地 anvil 没有，所以 devnet 不用 multicall */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const hasReactive = () => !!DEPLOYMENTS && DEPLOYMENTS.reactive !== ZERO;
export const hasSettler = () => !!DEPLOYMENTS && DEPLOYMENTS.settler !== ZERO;

export type ChainKey = "base" | "lasna";
export const CHAIN_LABEL: Record<ChainKey, string> = IS_DEVNET
  ? { base: "ANVIL·BASE", lasna: "ANVIL·LASNA" }
  : { base: "BASE SEPOLIA", lasna: "LASNA" };

const EXPLORER: Record<ChainKey, string | null> = IS_DEVNET
  ? { base: null, lasna: null }
  : { base: "https://sepolia.basescan.org", lasna: "https://lasna.reactscan.net" };

export const txUrl = (c: ChainKey, hash: string) => (EXPLORER[c] ? `${EXPLORER[c]}/tx/${hash}` : undefined);
export const addrUrl = (c: ChainKey, a: string) => (EXPLORER[c] ? `${EXPLORER[c]}/address/${a}` : undefined);
