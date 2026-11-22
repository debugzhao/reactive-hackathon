// 只放前端用到的 view 函数和事件，签名与 src/*.sol 保持一致
import { parseAbi } from "viem";

export const vaultAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function head() view returns (uint256)",
  "function tail() view returns (uint256)",
  "function pendingCount() view returns (uint256)",
  "function totalQueuedAssets() view returns (uint256)",
  "function totalClaimable() view returns (uint256)",
  "function queueCash() view returns (uint256)",
  "function instantCash() view returns (uint256)",
  "function poolPosition() view returns (uint256)",
  "function snapshotSeq() view returns (uint256)",
  "function BUFFER_BPS() view returns (uint16)",
  "function getRequest(uint256 id) view returns ((address owner, address receiver, uint128 assetsTotal, uint128 assetsRemaining, uint64 requestedAt, uint64 settledAt))",
  "event RedeemRequested(uint256 indexed id, address indexed owner, address indexed receiver, uint256 shares, uint256 assets, uint64 requestedAt)",
  "event Recalled(uint256 wanted, uint256 got, uint256 poolLiquidityAfter)",
  "event RecallFailed(bytes reason)",
  "event RedeemSettled(uint256 indexed id, address indexed receiver, uint256 paid, uint256 remaining, bool done)",
  "event PayoutDeferred(uint256 indexed id, address indexed receiver, uint256 amount)",
  "event Claimed(address indexed account, uint256 amount)",
  "event SettleSkipped(uint256 head, uint256 queueCash)",
  "event Allocated(uint256 assets, uint256 cashAfter)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
]);

export const poolAbi = parseAbi([
  "function liquidity() view returns (uint256)",
  "function owed() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function APR_BPS() view returns (uint256)",
  "event Repaid(address indexed payer, uint256 amount, uint256 availableLiquidity, uint64 timestamp)",
  "event Borrowed(address indexed borrower, uint256 amount, uint256 availableLiquidity, uint64 timestamp)",
  "event LiquidityTaken(address indexed lender, uint256 amount, uint256 availableAfter, uint64 timestamp)",
]);

export const usdcAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export const reactiveAbi = parseAbi([
  "function paused() view returns (bool)",
  "function subscribed() view returns (bool)",
  "function remainingCallbacks() view returns (uint256)",
  "function reactCount() view returns (uint256)",
  "function callbackCount() view returns (uint256)",
  "function maxPerCallback() view returns (uint256)",
  "function minSettleAssets() view returns (uint256)",
  "function callbackGasLimit() view returns (uint64)",
  "function windowCount() view returns (uint32)",
  "function maxReactsPerWindow() view returns (uint32)",
  "function windowSeconds() view returns (uint32)",
  "function mirror() view returns (uint256 seq, uint256 queueCash, uint256 poolPosition, uint256 headId, uint256 headRemaining, uint256 totalQueued, uint256 pendingCount)",
  "event SettleRequested(uint256 indexed originTxHash, uint8 source, uint256 seq, uint256 cashForQueue, uint256 headRemaining, uint256 maxCount)",
  "event Skipped(uint256 indexed originTxHash, uint8 reason)",
  "event BudgetExhausted(uint256 callbackCount)",
  "event SubscriptionChanged(bool subscribed)",
  "event CircuitBreak(uint256 reactsInWindow, uint256 windowSeconds)",
]);

export const settlerAbi = parseAbi([
  "event ReactiveSettled(uint256 indexed originTxHash, uint8 source, uint256 seq, uint256 recalled, uint256 processed, uint256 paid, uint256 newHead, uint64 timestamp)",
]);

export const baseEventsAbi = [...vaultAbi, ...poolAbi, ...settlerAbi].filter((x) => x.type === "event");
export const lasnaEventsAbi = reactiveAbi.filter((x) => x.type === "event");
