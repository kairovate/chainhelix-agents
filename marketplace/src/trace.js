// Settled hires, end to end (2026-09-03, product idea 7). One row per hire with the four facts a reader can
// check without trusting this site: the funding transaction, the on-chain submission plus the served
// deliverable, the permanent copy on BNB Greenfield, and the settlement transaction. Every value comes from
// marketplace/data/job_trace.json, written by scripts/build_job_trace.mjs from the chain and the existing
// evidence files; this module only reads it (one writer, this server never writes it). Absent file = no rows.
// MARKETPLACE_TRACE=0 hides the section and empties /api/trace (default on).
import { readFileSync, statSync } from "fs";
import { BSCSCAN } from "./config.js";

export const TRACE_ON = process.env.MARKETPLACE_TRACE !== "0";
export const TRACE_FILE = new URL("../data/job_trace.json", import.meta.url).pathname;

let _cache = { mt: 0, data: null, path: null };
export function loadTrace(path = TRACE_FILE) {
  if (!TRACE_ON) return null;
  try {
    const mt = statSync(path).mtimeMs;
    if (mt !== _cache.mt || path !== _cache.path) _cache = { mt, path, data: JSON.parse(readFileSync(path, "utf8")) };
    return _cache.data;
  } catch { return _cache.path === path ? _cache.data : null; } // a damaged rewrite keeps the last good read
}

function fmtUnits(wei, decimals) {
  try {
    const d = Number(decimals) || 0;
    let a = BigInt(wei).toString().padStart(d + 1, "0");
    const whole = a.slice(0, a.length - d), frac = a.slice(a.length - d).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
  } catch { return null; }
}

// Explicit field list (allow-list): nothing from the state file reaches a reader unless named here.
export function traceRow(j) {
  if (!j || !j.complete) return null;
  return {
    job: Number(j.id),
    agent: j.providerAgent || null,
    provider: j.provider || null,
    buyer: j.client || null,
    buyerKind: j.buyerKind || null,
    status: j.statusName || null,
    hired: j.funded ? { at: j.funded.at, amount: fmtUnits(j.funded.amountWei, j.funded.decimals), token: j.funded.token, tx: j.funded.tx, link: `${BSCSCAN}/tx/${j.funded.tx}`, createTx: j.created ? j.created.tx : null, createLink: j.created ? `${BSCSCAN}/tx/${j.created.tx}` : null } : null,
    delivered: j.submitted ? { at: j.submitted.at, tx: j.submitted.tx, link: `${BSCSCAN}/tx/${j.submitted.tx}`, url: j.deliverableUrl || null, onChainPointer: j.submitted.deliverablePointer || null } : null,
    greenfield: j.greenfield ? { url: j.greenfield.url, sha256: j.greenfield.sha256, objectId: j.greenfield.objectId, txHash: j.greenfield.txHash } : null,
    settled: j.settled ? { at: j.settled.at, tx: j.settled.tx, link: `${BSCSCAN}/tx/${j.settled.tx}`, verdict: j.settled.verdict } : null,
  };
}

export function traceRows(data) {
  const jobs = data && data.jobs ? Object.values(data.jobs) : [];
  return jobs.map(traceRow).filter(Boolean).sort((a, b) => b.job - a.job);
}

// The JSON surface: rows plus what they are and where they come from.
export function traceView(data = loadTrace()) {
  const rows = traceRows(data);
  const all = data && data.jobs ? Object.values(data.jobs) : [];
  return {
    enabled: TRACE_ON,
    generated: data ? data.generated : null,
    chainId: data ? data.chainId : null,
    contracts: data && data.contracts ? { commerce: data.contracts.commerce, policy: data.contracts.policy, router: data.contracts.router } : null,
    count: rows.length,
    onRecord: all.length,
    note: "one row per hire that has all four facts on record: the funding transaction, the on-chain submission with the served deliverable, the permanent copy on BNB Greenfield (sha256 of the served bytes) and the settlement transaction; hires missing any fact are counted in onRecord and not listed. buyerKind says whether the buyer was our own test wallet or an outside address",
    rows,
  };
}
