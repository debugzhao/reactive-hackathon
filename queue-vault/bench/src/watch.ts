// 演示看板：实时打印三条时间线（Base 池子 / Lasna Reactive / Base 金库与回调），并以最近一次还款为 0 点显示耗时。
// 用法：npm run watch
import type { Abi, Address } from "viem";
import { type Side, connect, getEvents, poolAbi, reactiveAbi, settlerAbi, sleep, vaultAbi } from "./lib.js";

const ctx = await connect();
const c = { reset: "\x1b[0m", dim: "\x1b[2m", y: "\x1b[33m", g: "\x1b[32m", m: "\x1b[35m", r: "\x1b[31m", b: "\x1b[36m" };
let zeroMs = 0;
let zeroTx = "";

function line(color: string, chain: string, text: string, tx: string) {
  const now = Date.now();
  const rel = zeroMs ? `+${((now - zeroMs) / 1000).toFixed(2)}s` : "";
  console.log(`${c.dim}${new Date(now).toISOString().slice(11, 23)}${c.reset} ${color}${chain.padEnd(6)}${c.reset} ${text.padEnd(58)} ${c.y}${rel.padStart(8)}${c.reset} ${c.dim}${tx.slice(0, 12)}…${c.reset}`);
}

type Feed = { side: Side; address: Address; abi: Abi; render: (name: string, args: Record<string, unknown>, tx: string) => void };
const usd = (x: unknown) => (Number(x as bigint) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

const feeds: Feed[] = [
  {
    side: ctx.base,
    address: ctx.d.pool,
    abi: poolAbi,
    render: (n, a, tx) => {
      if (n === "Repaid") {
        zeroMs = Date.now();
        zeroTx = tx;
        line(c.y, "Base", `💸 借款人还款 ${usd(a.amount)} → 池子流动性 ${usd(a.availableLiquidity)}`, tx);
      }
      if (n === "LiquidityTaken") {
        const who = String(a.lender).toLowerCase() === ctx.d.vault.toLowerCase() ? `${c.g}金库抢到` : `${c.r}其他存款人取走`;
        line(c.y, "Base", `${who} ${usd(a.amount)}${c.reset}（池子剩 ${usd(a.availableAfter)}）`, tx);
      }
    },
  },
  {
    side: ctx.lasna,
    address: ctx.d.reactive,
    abi: reactiveAbi,
    render: (n, a, tx) => {
      if (n === "SettleRequested") line(c.m, "Lasna", `⚡ react() 决定回调：可兑付 ${usd(a.cashForQueue)}，N=${a.maxCount}`, tx);
    },
  },
  {
    side: ctx.base,
    address: ctx.d.vault,
    abi: vaultAbi,
    render: (n, a, tx) => {
      if (n === "RedeemRequested") line(c.b, "Base", `🧾 #${a.id} 排队赎回 ${usd(a.assets)}`, tx);
      if (n === "RedeemSettled") line(c.g, "Base", `✅ #${a.id} 兑付 ${usd(a.paid)}${a.done ? "（结清）" : `（剩 ${usd(a.remaining)}）`}`, tx);
    },
  },
  {
    side: ctx.base,
    address: ctx.d.settler,
    abi: settlerAbi,
    render: (n, a, tx) => {
      if (n === "ReactiveSettled") {
        const origin = `0x${(a.originTxHash as bigint).toString(16).padStart(64, "0")}`;
        const mark = origin === zeroTx ? "（对应上一次还款）" : "";
        line(c.g, "Base", `🎯 回调落地：抢回 ${usd(a.recalled)}，兑付 ${a.processed} 笔${mark}`, tx);
      }
    },
  },
];

console.log(`👀 监听中… 金库 ${ctx.d.vault}  Reactive ${ctx.d.reactive}\n`);
const cursors = await Promise.all(feeds.map((f) => f.side.pub.getBlockNumber()));
for (;;) {
  await Promise.all(
    feeds.map(async (f, i) => {
      const head = await f.side.pub.getBlockNumber();
      if (head < cursors[i]) return;
      // 不传 eventName = 该合约的所有事件；分段查询，避免落后太多时超出 RPC 的区块跨度限制
      const logs = await getEvents<{ eventName: string; args: Record<string, unknown>; transactionHash: string }>(
        f.side,
        { address: f.address, abi: f.abi },
        cursors[i],
        head,
      );
      cursors[i] = head + 1n;
      for (const l of logs) f.render(l.eventName, l.args, l.transactionHash);
    }),
  );
  await sleep(250);
}
