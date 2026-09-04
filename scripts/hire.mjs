// Command-line hire client. Runs the exact flow the browser hire page runs,
// against the public marketplace API: fetch a live signed quote, create the
// job, bind the policy, fund the escrow, notify the seller, poll for the
// deliverable, then attempt settlement.
//
// The API prepares every transaction; this script signs them with YOUR key.
// The marketplace never sees the key. Before anything is signed, each
// transaction is checked against the known contracts and function selectors of
// the hire flow: approve only to the escrow contract and only up to the quoted
// price, setBudget and fund bounded the same way, value always zero. A
// transaction outside that set is refused (fix 2026-09-02 H131).
//
//   BUYER_PRIVATE_KEY=0x... node scripts/hire.mjs [agentId]
//   HIRE_TASK='{"goal":...}' hires for your own task (JSON spec string); without it the
//   agent's sample task is fetched from /quote, printed, and used (fix 2026-09-02 H261).
//   HIRE_TERMS='{"deliverables":...}' sends your own terms the same way.
//   HIRE_TX_CHECK=0 disables the pre-signature check.
//   HIRE_URL_CHECK=0 fetches the seller-written deliverable URL even when it is not a
//   plain public https URL (fix 2026-09-03 H132).
//
// Resume a job that already exists on chain with JOB_ID=<id>.
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

const API = process.env.HIRE_API ?? "https://agents.chainhelix.io";
// dataseed serves fresh receipts reliably; some free RPC tiers intermittently
// mislabel fresh-receipt reads as archive requests. This script never calls
// getLogs, the one method dataseed rejects.
const RPC = process.env.RPC_URL ?? "https://bsc-dataseed.binance.org";
const AGENT = process.argv[2] ?? "rebalancer";

const pk = process.env.BUYER_PRIVATE_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error("Set BUYER_PRIVATE_KEY to a 0x-prefixed 32-byte private key.");
  process.exit(1);
}
const account = privateKeyToAccount(pk);
console.log("buyer:", account.address);

const pub = createPublicClient({ chain: bsc, transport: http(RPC) });
const wallet = createWalletClient({ chain: bsc, transport: http(RPC), account });

// fix 2026-09-02 H131: the API dictated every field of every transaction this key signed.
// Allowlist of {contract, selector} per step, amounts bounded by the quoted price.
const TX_CHECK = process.env.HIRE_TX_CHECK !== "0";
const COMMERCE = "0xea4daa3100a767e86fded867729ae7446476eba6"; // ERC-8183 commerce (escrow), bsc-mainnet
const ROUTER = "0x51895229e12f9876011789b04f8698af06ccd6da"; // ERC-8183 router
const POLICY = "0x9c01845705b3078aa2e8cff7520a6376fd766de5"; // dispute-window policy
const TOKEN = "0xcE24439F2D9C6a2289F741120FE202248B666666"; // U, the escrow token
const sel = (sig) => keccak256(toBytes(sig)).slice(0, 10);
const ALLOWED = {
  [sel("createJob(address,address,uint256,string,address)")]: { to: COMMERCE },
  [sel("registerJob(uint256,address)")]: { to: ROUTER, word2: POLICY },
  [sel("setBudget(uint256,uint256,bytes)")]: { to: COMMERCE, bounded: true },
  [sel("approve(address,uint256)")]: { to: TOKEN, word1: COMMERCE, bounded: true },
  [sel("fund(uint256,uint256,bytes)")]: { to: COMMERCE, bounded: true },
  [sel("settle(uint256,bytes)")]: { to: ROUTER },
};
let priceCap = null; // wei, set from the plan before the first signature
function checkTx(label, tx) {
  if (!TX_CHECK) return;
  const data = String(tx.data || "").toLowerCase();
  const to = String(tx.to || "").toLowerCase();
  const rule = ALLOWED[data.slice(0, 10)];
  if (!rule) throw new Error(`${label}: refusing to sign, unknown function selector ${data.slice(0, 10)}`);
  if (to !== rule.to.toLowerCase()) throw new Error(`${label}: refusing to sign, ${to} is not the contract this step uses (${rule.to})`);
  if (BigInt(tx.value ?? 0) !== 0n) throw new Error(`${label}: refusing to sign, value must be 0`);
  if (rule.word1 && "0x" + data.slice(34, 74) !== rule.word1.toLowerCase()) throw new Error(`${label}: refusing to sign, spender is not the escrow contract`);
  if (rule.word2 && "0x" + data.slice(98, 138) !== rule.word2.toLowerCase()) throw new Error(`${label}: refusing to sign, policy is not the known policy contract`);
  if (rule.bounded) {
    const amount = BigInt("0x" + data.slice(74, 138));
    if (priceCap == null || amount > priceCap) throw new Error(`${label}: refusing to sign, amount ${amount} exceeds the quoted price ${priceCap}`);
  }
}

async function api(path, opts) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function send(label, tx) {
  checkTx(label, tx); // fix 2026-09-02 H131
  const hash = await wallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value ?? 0),
  });
  process.stdout.write(`${label}: ${hash} ... `);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(receipt.status, `gas=${receipt.gasUsed}`);
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  return hash;
}

console.log(`\n1. hire plan (live signed quote) for ${AGENT}`);
// fix 2026-09-02 H261: the plan is built for the task YOU send; the API no longer substitutes the sample silently.
let task = process.env.HIRE_TASK;
if (!task) {
  const q = await api(`/api/agents/${AGENT}/quote`);
  task = q.envelope.request.task_description;
  console.log("   no HIRE_TASK set: hiring for the agent's sample task:", String(task).slice(0, 120));
}
const planBody = { task_description: task, ...(process.env.HIRE_TERMS ? { terms: JSON.parse(process.env.HIRE_TERMS) } : {}) };
const plan = await api(`/api/agents/${AGENT}/hire/plan`, { method: "POST", body: JSON.stringify(planBody) });
console.log("   task source:", plan.taskSource, "| terms source:", plan.termsSource);
console.log("   signer verified:", JSON.stringify(plan.signatureVerified));
console.log("   price:", plan.price, "wei U; description", plan.description.length, "bytes");
priceCap = BigInt(plan.price); // fix 2026-09-02 H131: approve, setBudget and fund may not exceed this

let jobId = process.env.JOB_ID;
if (jobId) {
  console.log("\n2. createJob skipped, resuming job", jobId);
} else {
  console.log("\n2. createJob");
  const createHash = await send("   createJob", plan.tx);
  for (let i = 0; i < 10; i++) {
    const r = await api(`/api/hire/jobid?tx=${createHash}`).catch((e) => {
      console.log("   jobid lookup retry:", e.message.slice(0, 100));
      return {};
    });
    if (r.jobId) { jobId = r.jobId; break; }
    await new Promise((r2) => setTimeout(r2, 3000));
  }
  if (!jobId) throw new Error("jobId not recovered");
  console.log("   jobId:", jobId);
}

console.log("\n3. registerJob (bind policy)");
const policySel = keccak256(toBytes("jobPolicy(uint256)")).slice(0, 10);
const boundRaw = await pub.call({
  to: "0x51895229e12f9876011789b04f8698af06ccd6da",
  data: policySel + BigInt(jobId).toString(16).padStart(64, "0"),
});
if (boundRaw.data && BigInt(boundRaw.data) !== 0n) {
  console.log("   policy already bound, skipping");
} else {
  const reg = await api(`/api/hire/${jobId}/register-tx`);
  await send("   registerJob", reg.tx);
}

console.log("\n4. approve + fund escrow");
const fund = await api(`/api/hire/${jobId}/fund-txs?buyer=${account.address}&amount=${plan.price}`);
for (const tx of fund.txs) await send(`   ${tx.label}`, tx);

console.log("\n5. notify seller");
const ack = await api(`/api/agents/${AGENT}/hire/notify`, {
  method: "POST",
  body: JSON.stringify({ job_id: Number(jobId) }),
});
console.log("   ack:", JSON.stringify(ack.ack).slice(0, 200));

console.log("\n6. poll for submission");
let job;
for (let i = 0; i < 60; i++) {
  job = await api(`/api/jobs/${jobId}`);
  process.stdout.write(`   ${job.statusName}      \r`);
  if (job.statusName === "SUBMITTED" || job.status >= 3) break;
  await new Promise((r2) => setTimeout(r2, 10_000));
}
console.log("\n   status:", job.statusName, "deliverable:", job.deliverableUrl);

// fix 2026-09-03 H132: deliverableUrl is written on chain by the SELLER, so for any agent you did not write
// it is an attacker-chosen URL fetched by YOUR machine. Same rule marketplace/src/probe.js probeAllowed()
// applies to registration metadata: plain public https only, no IP literal, no bare or internal name.
function deliverableAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;          // IPv4 literal
  if (host.startsWith("[") || host.includes(":")) return false;    // IPv6 literal
  if (!host.includes(".")) return false;                           // bare names (localhost etc.)
  if (/\.(local|internal|lan|home|localdomain)$/.test(host)) return false;
  return true;
}

if (job.deliverableUrl) {
  if (process.env.HIRE_URL_CHECK !== "0" && !deliverableAllowed(job.deliverableUrl)) {
    console.log("   deliverable fetch refused: the seller pointed it at", job.deliverableUrl);
    console.log("   only plain public https URLs are fetched; open it yourself if you trust it (HIRE_URL_CHECK=0 to fetch anyway)");
  } else {
    const del = await fetch(job.deliverableUrl);
    console.log("   deliverable fetch:", del.status);
    console.log("   body:", (await del.text()).slice(0, 400));
  }
}

console.log("\n7. settle (expected to pend inside the evaluation window)");
const settle = await api(`/api/hire/${jobId}/settle-tx`);
try {
  await send("   settle", settle.tx);
  console.log("   settled immediately");
} catch (e) {
  console.log("   settle not yet available (evaluation window):", e.message.slice(0, 120));
  console.log(`   retry later with the same tx from /api/hire/${jobId}/settle-tx`);
}

console.log(`\nHIRE COMPLETE job=${jobId} buyer=${account.address}`);
