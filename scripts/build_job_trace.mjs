// Builds marketplace/data/job_trace.json: one record per hire with the four facts a reader can check on
// their own (hire funded on chain, deliverable submitted on chain and served, permanent copy on Greenfield,
// escrow settled on chain). Read-only against the chain, no wallet. Run as the service user, from the workspace root:
//   node scripts/build_job_trace.mjs            # rebuild from every source below
//   DRY=1 node scripts/build_job_trace.mjs      # print, write nothing
//   JOBS=56655,56680 node scripts/build_job_trace.mjs   # only these ids (others keep their last record)
// Sources (all existing, none written here): marketplace/data/greenfield_deliverables.json (which jobs have a
// Greenfield copy), <agent>/app/agent/.studio/audit-log.jsonl (the seller's submit tx hash, where the studio
// runtime logged one), scripts/settle_jobs.log (the settle tx hash, where our watcher sent it), and the chain:
// getJob through the studio SDK (status, parties, submittedAt), receipts and block timestamps from RPC_URL, and
// indexed eth_getLogs windows from LOGS_RPC_URL. Free public endpoints serve at most about 1,000 blocks per
// logs query and rate-limit bursts (measured 2026-09-03), so every event is located from a timestamp the chain
// itself states (submittedAt, submittedAt + dispute window) with one small window per event.
// The marketplace server only reads the output (src/trace.js); this script is the single writer, atomic
// (temp + rename), under a directory lock, and a job whose chain reads fail this run keeps its last good record.
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, statSync, existsSync, utimesSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const sdk = require("@bnbagent/sdk");
const { toEventSelector, getAddress } = require("viem");

const ROOT = new URL("../", import.meta.url).pathname;
const DATA = ROOT + "marketplace/data/";
const OUT = DATA + "job_trace.json";
const LOCK = DATA + "job_trace.lock";
const GNFD_INDEX = DATA + "greenfield_deliverables.json";
const SETTLE_LOG = ROOT + "scripts/settle_jobs.log";
const TESTHIRE = DATA + "testhire.json"; // hires made by scripts/test_hire.mjs record every tx hash per step
const AGENT_DIRS = ["rebalancer", "gridtrader", "yieldopt", "healthmon"];
const CATALOG = JSON.parse(readFileSync(ROOT + "marketplace/catalog.json", "utf8"));
// The three contracts every deliverable file names under "contracts" (chain_id 56).
const COMMERCE = getAddress("0xEa4DAa3100A767e86FDed867729ae7446476EBA6"); // JobCreated, JobFunded
const POLICY = getAddress("0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5"); // JobInitialised (on submit)
const ROUTER = getAddress("0x51895229E12F9876011789B04f8698af06cCD6DA"); // settle path
const EMITTERS = [COMMERCE, POLICY, ROUTER];
const RPC_URL = process.env.RPC_URL || "https://bsc-dataseed.bnbchain.org"; // receipts and blocks for any age; rejects getLogs
// Logs are the fallback for a hash nobody recorded. Measured 2026-09-03: no free public BSC endpoint serves a wide
// indexed eth_getLogs (dataseed "limit exceeded" at every width, publicnode needs an archive token, drpc and the
// shared NodeReal key are exhausted within a query or two, tatum allows 5 per minute). bsc.blockrazor.xyz answers
// 25-block windows and rate-limits bursts, so every window is paced and retried. No key of ours, no paid call.
const LOGS_RPC_URL = process.env.LOGS_RPC_URL || "https://bsc.blockrazor.xyz";
const LOGS_WINDOW = Number(process.env.LOGS_WINDOW || 25);
const LOGS_PACE_MS = Number(process.env.LOGS_PACE_MS || 1500); // one logs query per pace
const BACK_WINDOWS = Number(process.env.BACK_WINDOWS || 40); // create/fund search back from the submit block (1,000 blocks)
const SETTLE_SCAN_WINDOWS = Number(process.env.SETTLE_SCAN_WINDOWS || 100); // forward scan for a settle nobody logged (2,500 blocks)
const ONLY = process.env.JOBS ? new Set(process.env.JOBS.split(",").map((s) => s.trim())) : null;
const DRY = process.env.DRY === "1";
const RPC_MAX_BYTES = 1_048_576; // body cap on every RPC answer
const RPC_TIMEOUT_MS = 12_000;

const EVENTS = {
  JobCreated: "JobCreated(uint256,address,address,address,uint256,address)",
  JobFunded: "JobFunded(uint256,address,address,uint256)",
  JobInitialised: "JobInitialised(uint256,bytes32,uint64,bytes)",
  JobSettled: "JobSettled(uint256,address,uint8,bytes32)",
};
const SELECTOR = Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [toEventSelector(v), k]));
const TOPIC0 = Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, toEventSelector(v)]));
const VERDICT = { 0: "PENDING", 1: "APPROVE", 2: "REJECT" }; // sdk Verdict enum

function log(...a) { console.log(new Date().toISOString(), ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + BigInt(n).toString(16);
const hexToInt = (h) => (h ? parseInt(h, 16) : null);
const topicAddress = (t) => getAddress("0x" + t.slice(26));
const topicJob = (id) => "0x" + BigInt(id).toString(16).padStart(64, "0");
const iso = (secs) => new Date(Number(secs) * 1000).toISOString();

async function rpc(url, method, params) {
  if (!/^https:\/\//.test(url)) throw new Error("rpc url must be https");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > RPC_MAX_BYTES) throw new Error("rpc body too large");
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.error) throw new Error(`${method}: ${body.error.message || JSON.stringify(body.error)}`);
    return body.result;
  } finally { clearTimeout(t); }
}

// one indexed logs query over [from, to], paced and retried on the free endpoint's rate limit
let lastLogsAt = 0;
async function getLogs(from, to, topics) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const wait = lastLogsAt + LOGS_PACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastLogsAt = Date.now();
    try {
      const logs = await rpc(LOGS_RPC_URL, "eth_getLogs", [{ address: EMITTERS, fromBlock: hex(from), toBlock: hex(to), topics }]);
      return logs.map((l) => ({ name: SELECTOR[l.topics[0]] || null, emitter: getAddress(l.address), topics: l.topics, data: l.data, tx: l.transactionHash, block: hexToInt(l.blockNumber) }));
    } catch (e) {
      if (attempt === 6 || !/rate limit|timeout|too many|usage limit|429/i.test(e.message)) throw e;
      log(`getLogs retry ${attempt}: ${e.message}`);
      await sleep(LOGS_PACE_MS * attempt * 2);
    }
  }
}
async function receipt(tx) {
  const r = await rpc(RPC_URL, "eth_getTransactionReceipt", [tx]);
  if (!r) return null;
  return { block: hexToInt(r.blockNumber), ok: r.status === "0x1", logs: r.logs.filter((l) => EMITTERS.includes(getAddress(l.address)) && SELECTOR[l.topics[0]]).map((l) => ({ name: SELECTOR[l.topics[0]], emitter: getAddress(l.address), topics: l.topics, data: l.data, tx: l.transactionHash, block: hexToInt(l.blockNumber) })) };
}
const blockTimes = new Map();
async function blockTime(n) {
  if (!blockTimes.has(n)) { const b = await rpc(RPC_URL, "eth_getBlockByNumber", [hex(n), false]); blockTimes.set(n, b ? hexToInt(b.timestamp) : null); }
  return blockTimes.get(n);
}
let headCache = null;
async function head() { if (!headCache) headCache = hexToInt(await rpc(RPC_URL, "eth_blockNumber", [])); return headCache; }
// first block whose timestamp is >= ts (binary search over block headers; about 27 header reads)
async function blockAt(ts) {
  let lo = 0, hi = await head();
  if ((await blockTime(hi)) < ts) return null; // in the future
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTime(mid)) < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ---- sources on disk ----
function greenfieldJobs() {
  const idx = JSON.parse(readFileSync(GNFD_INDEX, "utf8"));
  const out = {};
  for (const [k, e] of Object.entries(idx.jobs || {})) {
    if (!/^\d{1,12}$/.test(k) || Number(k) < 10000) continue; // the index carries one stray key (8183) from an old regex bug
    out[k] = { url: e.url, sha256: e.sha256, objectId: e.objectId, txHash: e.txHash, bytes: e.bytes ?? null };
  }
  return out;
}
function settleTxs() {
  const out = {};
  if (!existsSync(SETTLE_LOG)) return out;
  for (const line of readFileSync(SETTLE_LOG, "utf8").split("\n")) {
    const m = /^\S+ (\d+) settle sent (0x[0-9a-fA-F]{64})/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function submitTxs() {
  const out = {};
  for (const a of AGENT_DIRS) {
    const p = `${ROOT}${a}/app/agent/.studio/audit-log.jsonl`;
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.op !== "8183_submit_work") continue;
      const job = r.context && r.context.job_id;
      const m = /0x[0-9a-fA-F]{64}/.exec(String(r.tx_hash || "") + " " + String((r.context && r.context.error) || ""));
      if (job && m) out[String(job)] = { tx: m[0], agent: a };
    }
  }
  return out;
}

function hireTxs() {
  const out = {};
  try {
    const th = JSON.parse(readFileSync(TESTHIRE, "utf8")).agents || {};
    for (const recs of Object.values(th)) for (const r of recs || []) {
      if (!r || !r.jobId || !Array.isArray(r.txs)) continue;
      const step = (name) => (r.txs.find((t) => t.step === name && t.status === "success") || {}).hash || null;
      out[String(r.jobId)] = { create: step("createJob"), fund: step("fund") };
    }
  } catch (e) { log("testhire.json not read: " + e.message); }
  return out;
}

let clientPromise = null;
function client() { if (!clientPromise) clientPromise = sdk.ERC8183Client.create({ network: "bsc-mainnet" }); return clientPromise; }
let disputeWindowCache = null;
async function disputeWindow() {
  if (disputeWindowCache == null) {
    // disputeWindow() on the policy, uint256; selector of "disputeWindow()"
    const r = await rpc(RPC_URL, "eth_call", [{ to: POLICY, data: "0x" + require("viem").toFunctionSelector("disputeWindow()").slice(2) }, "latest"]);
    disputeWindowCache = Number(BigInt(r));
  }
  return disputeWindowCache;
}

async function traceJob(id, gnfd, submit, settleTx, hire, previous) {
  const rec = { id: Number(id), status: null, statusName: null, client: null, provider: null, providerAgent: null, buyerKind: null,
    created: null, funded: null, submitted: null, greenfield: gnfd || null, settled: null, deliverableUrl: null, complete: false, missing: [], checkedAt: new Date().toISOString() };
  try {
    const c = await client();
    const j = await c.getJob(BigInt(id));
    if (!j || /^0x0{40}$/i.test(j.client || "")) { rec.missing.push("no such job on chain"); return rec; }
    rec.status = Number(j.status); rec.statusName = sdk.JobStatus[rec.status] ?? String(rec.status);
    rec.client = getAddress(j.client); rec.provider = getAddress(j.provider);
    const agent = (CATALOG.agents || []).find((a) => getAddress(a.wallet) === rec.provider);
    rec.providerAgent = agent ? agent.id : null;
    const testBuyers = (CATALOG.testBuyers || []).map(getAddress);
    rec.buyerKind = testBuyers.includes(rec.client) ? "first-party test wallet" : "outside buyer";
    if (agent) rec.deliverableUrl = `https://agents.chainhelix.io/${agent.id}/erc8183/job/${Number(id)}/response`;
    const submittedAt = Number(j.submittedAt || 0);
    // 1. submit: from the logged tx receipt, else from a JobInitialised window around the chain's own submittedAt
    let initEv = null;
    if (submit) {
      const r = await receipt(submit.tx);
      initEv = r && r.ok ? r.logs.find((l) => l.name === "JobInitialised" && BigInt(l.topics[1]) === BigInt(id)) : null;
    }
    if (!initEv && submittedAt) {
      const est = await blockAt(submittedAt); // first block at or after the chain's own submittedAt
      for (let w = 0; est != null && w < 8 && !initEv; w++) { // the event sits at est or a few blocks after
        const from = est + w * LOGS_WINDOW, to = from + LOGS_WINDOW - 1;
        initEv = (await getLogs(from, to, [TOPIC0.JobInitialised, topicJob(id)])).find((l) => l.name === "JobInitialised") || null;
      }
    }
    if (initEv) rec.submitted = { tx: initEv.tx, block: initEv.block, at: iso(await blockTime(initEv.block)), deliverablePointer: "0x" + initEv.data.slice(2, 66), submittedAt: iso(BigInt("0x" + initEv.data.slice(66, 130))), emitter: initEv.emitter, agent: submit ? submit.agent : rec.providerAgent };
    else rec.missing.push("submit event not found");
    // 2. create + fund: from recorded hashes (receipts), else windows back from the submit block
    if (hire && hire.create) {
      const r = await receipt(hire.create);
      const l = r && r.ok ? r.logs.find((l) => l.name === "JobCreated" && BigInt(l.topics[1]) === BigInt(id)) : null;
      if (l) rec.created = { tx: l.tx, block: l.block, at: iso(await blockTime(l.block)), client: topicAddress(l.topics[2]), provider: topicAddress(l.topics[3]) };
    }
    if (hire && hire.fund) {
      const r = await receipt(hire.fund);
      const l = r && r.ok ? r.logs.find((l) => l.name === "JobFunded" && BigInt(l.topics[1]) === BigInt(id)) : null;
      if (l) rec.funded = { tx: l.tx, block: l.block, at: iso(await blockTime(l.block)), amountWei: BigInt(l.data).toString(), token: CATALOG.paymentToken.symbol, decimals: CATALOG.paymentToken.decimals };
    }
    if (rec.submitted && !(rec.created && rec.funded)) {
      for (let w = 0; w < BACK_WINDOWS && !(rec.created && rec.funded); w++) {
        const to = rec.submitted.block - w * LOGS_WINDOW, from = to - LOGS_WINDOW + 1;
        for (const l of await getLogs(from, to, [[TOPIC0.JobCreated, TOPIC0.JobFunded], topicJob(id)])) {
          if (l.name === "JobCreated" && !rec.created) rec.created = { tx: l.tx, block: l.block, at: iso(await blockTime(l.block)), client: topicAddress(l.topics[2]), provider: topicAddress(l.topics[3]) };
          if (l.name === "JobFunded") rec.funded = { tx: l.tx, block: l.block, at: iso(await blockTime(l.block)), amountWei: BigInt(l.data).toString(), token: CATALOG.paymentToken.symbol, decimals: CATALOG.paymentToken.decimals };
        }
      }
    }
    if (!rec.created) rec.missing.push("createJob event not found");
    if (!rec.funded) rec.missing.push("fund event not found");
    // 3. settle: from the logged tx receipt, else a forward scan from submittedAt + dispute window
    let settleEv = null;
    if (settleTx) {
      const r = await receipt(settleTx);
      settleEv = r && r.ok ? r.logs.find((l) => l.name === "JobSettled" && BigInt(l.topics[1]) === BigInt(id)) : null;
    }
    if (!settleEv && rec.status === sdk.JobStatus.COMPLETED && submittedAt) {
      const start = await blockAt(submittedAt + (await disputeWindow()));
      const top = await head();
      for (let w = 0; w < SETTLE_SCAN_WINDOWS && start != null && !settleEv; w++) {
        const from = start + w * LOGS_WINDOW, to = Math.min(from + LOGS_WINDOW - 1, top);
        if (from > top) break;
        settleEv = (await getLogs(from, to, [TOPIC0.JobSettled, topicJob(id)])).find((l) => l.name === "JobSettled") || null;
      }
    }
    if (settleEv) rec.settled = { tx: settleEv.tx, block: settleEv.block, at: iso(await blockTime(settleEv.block)), verdict: VERDICT[Number(BigInt(settleEv.topics[3]))] ?? String(Number(BigInt(settleEv.topics[3]))), policy: topicAddress(settleEv.topics[2]), emitter: settleEv.emitter };
    else rec.missing.push(rec.status === sdk.JobStatus.COMPLETED ? "settle event not found" : "not settled");
    if (!rec.greenfield) rec.missing.push("no Greenfield copy");
    if (rec.status !== sdk.JobStatus.COMPLETED) rec.missing.push("status is not COMPLETED");
    rec.complete = rec.missing.length === 0;
    return rec;
  } catch (e) {
    log(`job ${id}: chain read failed: ${e.message}`);
    if (previous) { log(`job ${id}: keeping the previous record`); return { ...previous, lastError: e.message }; }
    rec.missing.push("chain read failed: " + e.message);
    return rec;
  }
}

function loadPrevious() {
  try { return JSON.parse(readFileSync(OUT, "utf8")); } catch (e) { if (existsSync(OUT)) log("existing job_trace.json unreadable, rebuilding from sources: " + e.message); return null; }
}
// The lock is held across the whole read-modify-write (loadPrevious, every chain read, the write), not only
// the write (fix 2026-09-04, VERIFY_H finding 2): a second build started while one runs fails at once instead
// of repeating minutes of RPC work and racing the final rename. The lock directory's mtime is refreshed after
// every job, so the 120 s stale rule breaks only a lock whose owner died, never a live build. DRY takes no lock.
async function withLock(fn) {
  try { mkdirSync(LOCK); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (Date.now() - statSync(LOCK).mtimeMs < 120_000) throw new Error("another build holds the lock");
    rmSync(LOCK, { recursive: true, force: true }); mkdirSync(LOCK);
  }
  try { return await fn(); } finally { rmSync(LOCK, { recursive: true, force: true }); }
}
const touchLock = () => { try { const now = new Date(); utimesSync(LOCK, now, now); } catch {} };

const gnfd = greenfieldJobs(), settles = settleTxs(), submits = submitTxs(), hires = hireTxs();
const ids = [...new Set([...Object.keys(gnfd), ...Object.keys(settles), ...Object.keys(submits)])].map(Number).sort((a, b) => a - b);
async function build() {
  const previous = loadPrevious();
  const prevJobs = (previous && previous.jobs) || {};
  log(`jobs on record: ${ids.length} (greenfield ${Object.keys(gnfd).length}, settle log ${Object.keys(settles).length}, submit logs ${Object.keys(submits).length}, test-hire txs ${Object.keys(hires).length})${ONLY ? `, rebuilding ${[...ONLY].join(",")}` : ""}`);
  const jobs = {};
  for (const id of ids) {
    const k = String(id);
    if (ONLY && !ONLY.has(k)) { if (prevJobs[k]) jobs[k] = prevJobs[k]; continue; }
    jobs[k] = await traceJob(k, gnfd[k], submits[k], settles[k], hires[k], prevJobs[k]);
    log(`job ${k}: ${jobs[k].statusName} complete=${jobs[k].complete}${jobs[k].missing.length ? " missing: " + jobs[k].missing.join("; ") : ""}`);
    if (!DRY) touchLock();
  }
  const out = { generated: new Date().toISOString(), chainId: CATALOG.chainId, contracts: { commerce: COMMERCE, policy: POLICY, router: ROUTER },
    sources: { greenfieldIndex: "marketplace/data/greenfield_deliverables.json", testHire: "marketplace/data/testhire.json", settleLog: "scripts/settle_jobs.log", submitLogs: "<agent>/app/agent/.studio/audit-log.jsonl", rpc: RPC_URL, logsRpc: LOGS_RPC_URL, logsWindow: LOGS_WINDOW }, jobs };
  log(`complete rows: ${Object.values(jobs).filter((j) => j.complete).length} of ${Object.keys(jobs).length}`);
  if (DRY) console.log(JSON.stringify(out, null, 2));
  else { const tmp = `${OUT}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(out, null, 1)); renameSync(tmp, OUT); log(`wrote ${OUT}`); }
}
if (DRY) await build(); else await withLock(build);
