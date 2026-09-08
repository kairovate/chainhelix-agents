// mcp_hire_proof.mjs (2026-09-08, MCP build plan B9, operator "0x9d16 go"): the agents-hire-agents proof. A machine buyer
// plans a hire THROUGH ChainHelix for machines (the MCP's free hire_plan_<agent> tool), then signs and funds the job from the
// market test buyer wallet, notifies the seller, waits for the deliverable and attempts settlement. The chain steps and the
// pre-signature allowlist are the public hire client's (hackathon-public/scripts/hire.mjs, fix H131), copied verbatim; the one
// difference from that client is where the plan comes from: the MCP, not the marketplace API. The keystore is decrypted
// in-process as scripts/hire_as_test_buyer.mjs does; the key is never printed or written.
//   node scripts/mcp_hire_proof.mjs [agentId]      (default healthmon)
import { readFileSync, readdirSync, appendFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { decryptKeystoreV3 } = require("@bnbagent/sdk/wallets");
const { createPublicClient, createWalletClient, http, keccak256, toBytes } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { bsc } = require("viem/chains");

const MCP = process.env.MCP_URL ?? "https://mcp.chainhelix.io/";
const API = process.env.HIRE_API ?? "https://agents.chainhelix.io";
const RPC = process.env.RPC_URL ?? "https://bsc-dataseed.binance.org";
const AGENT = process.argv[2] ?? "healthmon";
const LOG = new URL("../audit/mcp_hire_proof.log", import.meta.url).pathname;
function log(...a) { const line = new Date().toISOString() + " " + a.join(" "); console.log(line); try { appendFileSync(LOG, line + "\n"); } catch {} }

// the buyer key, decrypted in-process, address asserted
const studioDir = new URL("../spikeagent/.studio/", import.meta.url).pathname;
const walletFiles = readdirSync(studioDir + "wallets").filter((f) => f.endsWith(".json")).sort();
if (walletFiles.length !== 1) throw new Error(`expected exactly one keystore, found ${walletFiles.length}`);
const keystore = JSON.parse(readFileSync(studioDir + "wallets/" + walletFiles[0], "utf8"));
const password = /^WALLET_PASSWORD=(.+)$/m.exec(readFileSync(studioDir + ".env.local", "utf8"))?.[1]?.trim();
if (!password) throw new Error("no WALLET_PASSWORD");
const pk = "0x" + Buffer.from(decryptKeystoreV3(keystore, password)).toString("hex");
const account = privateKeyToAccount(pk);
if (account.address.toLowerCase() !== "0x9d16bb4b2ed89aafc8390998ed2d3254af6e513b") throw new Error("keystore does not derive the test buyer wallet");
const pub = createPublicClient({ chain: bsc, transport: http(RPC) });
const wallet = createWalletClient({ chain: bsc, transport: http(RPC), account });
log(`buyer ${account.address} agent ${AGENT} plan source ${MCP}`);

// allowlist and checks: hire.mjs (fix 2026-09-02 H131), verbatim
const COMMERCE = "0xea4daa3100a767e86fded867729ae7446476eba6", ROUTER = "0x51895229e12f9876011789b04f8698af06ccd6da", POLICY = "0x9c01845705b3078aa2e8cff7520a6376fd766de5", TOKEN = "0xcE24439F2D9C6a2289F741120FE202248B666666";
const sel = (sig) => keccak256(toBytes(sig)).slice(0, 10);
const ALLOWED = {
  [sel("createJob(address,address,uint256,string,address)")]: { to: COMMERCE },
  [sel("registerJob(uint256,address)")]: { to: ROUTER, word2: POLICY },
  [sel("setBudget(uint256,uint256,bytes)")]: { to: COMMERCE, bounded: true },
  [sel("approve(address,uint256)")]: { to: TOKEN, word1: COMMERCE, bounded: true },
  [sel("fund(uint256,uint256,bytes)")]: { to: COMMERCE, bounded: true },
  [sel("settle(uint256,bytes)")]: { to: ROUTER },
};
let priceCap = null;
function checkTx(label, tx) {
  const data = String(tx.data || "").toLowerCase(), to = String(tx.to || "").toLowerCase(); const rule = ALLOWED[data.slice(0, 10)];
  if (!rule) throw new Error(`${label}: refusing to sign, unknown function selector ${data.slice(0, 10)}`);
  if (to !== rule.to.toLowerCase()) throw new Error(`${label}: refusing to sign, ${to} is not the contract this step uses (${rule.to})`);
  if (BigInt(tx.value ?? 0) !== 0n) throw new Error(`${label}: refusing to sign, value must be 0`);
  if (rule.word1 && "0x" + data.slice(34, 74) !== rule.word1.toLowerCase()) throw new Error(`${label}: refusing to sign, spender is not the escrow contract`);
  if (rule.word2 && "0x" + data.slice(98, 138) !== rule.word2.toLowerCase()) throw new Error(`${label}: refusing to sign, policy is not the known policy contract`);
  if (rule.bounded) { const amount = BigInt("0x" + data.slice(74, 138)); if (priceCap == null || amount > priceCap) throw new Error(`${label}: refusing to sign, amount ${amount} exceeds the quoted price ${priceCap}`); }
}
async function api(path, opts) { const res = await fetch(API + path, { headers: { "Content-Type": "application/json" }, ...opts }); const body = await res.json(); if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body)}`); return body; }
async function send(label, tx) {
  checkTx(label, tx);
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  log(`${label}: ${hash} ${receipt.status} gas=${receipt.gasUsed}`);
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  return hash;
}
async function mcp(name, args) {
  const t0 = Date.now();
  const res = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const body = await res.json(); const text = body?.result?.content?.[0]?.text;
  if (res.status !== 200 || !text) throw new Error(`MCP ${name} -> ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const out = JSON.parse(text); log(`MCP ${name} answered in ${Date.now() - t0} ms, receipt ${body?.result?.receipt?.sha256 ? "yes" : "none"}`); return out;
}

// 1. the plan, from the MCP: the seller's sample task parameters as the job
log("1. hire plan through the MCP");
const sample = await api(`/api/agents/${AGENT}/quote`);
const params = JSON.parse(sample.envelope.request.task_description);
delete params.goal; // the schema names the numbers; the sample's goal sentence is not a parameter
const plan = await mcp(`hire_plan_${AGENT}`, params);
if (plan.error) throw new Error(`MCP plan refused: ${plan.error}`);
const p = plan.plan;
log(`   MCP plan: agent ${plan.agent} erc8004 #${plan.erc8004Id} signer verified ${JSON.stringify(p.signatureVerified)} price ${p.price} wei U task source ${p.taskSource}`);
const seller = await api(`/api/agents/${AGENT}`); // the signer the plan verified must be the seller's registered wallet
const signer = String(p.signatureVerified?.signer || "").toLowerCase();
if (p.signatureVerified?.valid === false || !signer || signer !== String(seller.wallet || "").toLowerCase()) throw new Error(`quote signer ${signer || "none"} is not the seller wallet ${seller.wallet}, stopping`);
log(`   signer is the registered wallet of ${AGENT} (${seller.wallet})`);
priceCap = BigInt(p.price);
const bal = await pub.readContract({ address: TOKEN, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [account.address] });
if (bal < priceCap) throw new Error(`buyer holds ${bal} wei U, the price is ${priceCap}; nothing signed`);

// 2..7: the public client's steps, with the MCP's createJob transaction
log("2. createJob (the MCP's transaction)");
const createHash = await send("   createJob", plan.tx);
let jobId = null;
for (let i = 0; i < 10 && !jobId; i++) { const r = await api(`/api/hire/jobid?tx=${createHash}`).catch(() => ({})); if (r.jobId) jobId = r.jobId; else await new Promise((r2) => setTimeout(r2, 3000)); }
if (!jobId) throw new Error("jobId not recovered");
log(`   jobId ${jobId}`);
log("3. registerJob");
const reg = await api(`/api/hire/${jobId}/register-tx`); await send("   registerJob", reg.tx);
log("4. approve + fund escrow");
const fund = await api(`/api/hire/${jobId}/fund-txs?buyer=${account.address}&amount=${p.price}`);
for (const tx of fund.txs) await send(`   ${tx.label}`, tx);
log("5. notify seller");
const ack = await api(`/api/agents/${AGENT}/hire/notify`, { method: "POST", body: JSON.stringify({ job_id: Number(jobId) }) });
log(`   ack ${JSON.stringify(ack.ack).slice(0, 160)}`);
log("6. poll for submission");
let job;
for (let i = 0; i < 60; i++) { job = await api(`/api/jobs/${jobId}`); if (job.statusName === "SUBMITTED" || job.status >= 3) break; await new Promise((r2) => setTimeout(r2, 10_000)); }
log(`   status ${job.statusName} deliverable ${job.deliverableUrl}`);
log("7. settle");
const settle = await api(`/api/hire/${jobId}/settle-tx`);
try { await send("   settle", settle.tx); log("   settled"); } catch (e) { log(`   settle not yet available: ${e.message.slice(0, 140)}; retry with /api/hire/${jobId}/settle-tx`); }
log(`PROOF COMPLETE job=${jobId} buyer=${account.address} agent=${AGENT} plan=MCP`);
