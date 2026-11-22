// ABI 一致性检查：把 src/abi.ts 里每个签名与 `forge inspect <合约> abi --json` 逐项对照，不一致就退出码 1。
// 用法（需要 foundry）：npm run check:abi
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as A from "../src/abi.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const contracts: Record<string, string> = {
  vaultAbi: "QueueVault",
  poolAbi: "MockPool",
  usdcAbi: "MockUSDC",
  reactiveAbi: "QueueReactive",
  settlerAbi: "QueueSettler",
};
type Item = { type: string; name?: string; inputs?: any[]; outputs?: any[]; stateMutability?: string };
const sig = (x: Item) => {
  const ins = (x.inputs ?? []).map((i) => i.type + (x.type === "event" && i.indexed ? " indexed" : "")).join(",");
  const out = (o: any) => (o.type === "tuple" ? `(${o.components.map((c: any) => `${c.type} ${c.name}`).join(",")})` : o.type);
  return `${x.type} ${x.name}(${ins})` + (x.type === "function" ? `->${(x.outputs ?? []).map(out).join(",")}:${x.stateMutability}` : "");
};

let total = 0;
let bad = 0;
for (const [key, name] of Object.entries(contracts)) {
  const json = execFileSync("forge", ["inspect", `src/${name}.sol:${name}`, "abi", "--json"], { cwd: root, encoding: "utf8" });
  const known = new Set((JSON.parse(json) as Item[]).filter((x) => x.type === "function" || x.type === "event").map(sig));
  for (const item of (A as Record<string, readonly Item[]>)[key]) {
    total++;
    if (!known.has(sig(item))) {
      bad++;
      console.log(`❌ ${name}: ${sig(item)}`);
    }
  }
}
console.log(`${bad ? "❌" : "✅"} checked ${total} signatures, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
