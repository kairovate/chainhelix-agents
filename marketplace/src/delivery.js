// Verified delivery claims (2026-09-07, build plan A4): the public record of every sealed delivery check, read from
// data/delivery_claims.json, which the check service writes after each claim and each seal. This file only reads it and
// shapes it for the page at /d/<job> and the JSON at /api/delivery. The record itself is what the MCP's free
// delivery_status tool returns; the claim hash is what sits in the opBNB calldata.
import { readFileSync, statSync } from "fs";
import { BSCSCAN } from "./config.js";
export const DELIVERY_FILE = process.env.DELIVERY_CLAIMS_FILE || new URL("../data/delivery_claims.json", import.meta.url).pathname;
export const OPBNBSCAN = "https://opbnb.bscscan.com";
// 2026-09-08 B10: the cleared buyers, read from data/cleared_buyers.json, which the ChainHelix MCP writes on every enrolment
// and every 24-hour renewal (the free MCP tool buyer_clearance returns the same record). Read-only here, like the claims.
export const CLEARED_FILE = process.env.CLEARED_BUYERS_FILE || new URL("../data/cleared_buyers.json", import.meta.url).pathname;
const _clearedCache = { path: null, mtimeMs: -1, doc: null }; // one parse per file version: a list page views many rows
export function loadCleared(path = CLEARED_FILE) {
  try {
    const m = statSync(path).mtimeMs;
    if (_clearedCache.path === path && _clearedCache.mtimeMs === m && _clearedCache.doc) return _clearedCache.doc;
    const d = JSON.parse(readFileSync(path, "utf8"));
    const doc = d && Array.isArray(d.buyers) ? d : { buyers: [], count: 0 };
    _clearedCache.path = path; _clearedCache.mtimeMs = m; _clearedCache.doc = doc;
    return doc;
  } catch { return { buyers: [], count: 0 }; }
}
// the clearance a seller reads before taking a job: on file, active period, and a current statement that has not expired
export function clearedBuyer(address, doc = loadCleared(), now = Date.now()) {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(String(address))) return { onFile: false };
  const w = String(address).toLowerCase();
  const r = doc.buyers.find((b) => b.wallet === w);
  if (!r) return { onFile: false, wallet: w };
  const cur = r.current || null;
  const fresh = !!(cur && cur.expiresAt && Date.parse(cur.expiresAt) > now);
  return { onFile: true, wallet: w, active: r.validUntil > now, validUntil: r.validUntil, result: cur ? cur.result : null, currentFresh: fresh,
    screenedAt: cur ? cur.screenedAt : null, signer: cur ? cur.signer : null, renewals: r.renewals || 0, current: cur };
}
export function loadDelivery(path = DELIVERY_FILE) {
  try { const d = JSON.parse(readFileSync(path, "utf8")); return d && Array.isArray(d.claims) ? d : { claims: [], count: 0 }; } catch { return { claims: [], count: 0 }; }
}
function http(u) { return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null; }
function tx(hash, base) { return hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? { hash, link: `${base}/tx/${hash}` } : null; }
export function deliveryView(row) {
  if (!row || !row.claim) return null;
  const c = row.claim;
  return {
    job: c.job, seq: row.seq, hash: row.hash, status: row.status, verdict: c.verdict, checkedAt: c.checkedAt, committedAt: row.committedAt,
    seal: { network: "opBNB", tx: tx(row.opbnbTx, OPBNBSCAN), key: null },
    provider: c.provider ? { address: c.provider, link: `${BSCSCAN}/address/${c.provider}` } : null,
    buyer: c.buyer ? { address: c.buyer, link: `${BSCSCAN}/address/${c.buyer}` } : null,
    buyerClearance: clearedBuyer(c.buyer), // 2026-09-08 B10
    jobStatus: c.status,
    deliverable: c.deliverable ? { url: http(c.deliverable.url), sha256: c.deliverable.sha256, keccak256: c.deliverable.keccak256, bytes: c.deliverable.bytes, source: c.deliverable.source } : null,
    onChain: c.onChain ? { pointer: c.onChain.pointer, submitTx: tx(c.onChain.submitTx, BSCSCAN), submittedAt: c.onChain.submittedAt } : null,
    permanentCopy: c.permanentCopy ? { url: http(c.permanentCopy.url), sha256: c.permanentCopy.sha256, indexSha256: c.permanentCopy.indexSha256, objectId: c.permanentCopy.objectId, fetched: !!c.permanentCopy.fetched } : null,
    hired: c.hired ? { at: c.hired.at, amount: c.hired.amount, token: c.hired.token, tx: tx(c.hired.tx, BSCSCAN) } : null,
    deliveredInSeconds: c.deliveredInSeconds,
    settled: c.settled ? { at: c.settled.at, verdict: c.settled.verdict, tx: tx(c.settled.tx, BSCSCAN) } : null,
    checks: c.checks || {},
    canonicalKeys: ["v", "job", "chainId", "provider", "buyer", "status", "verdict", "deliverable", "onChain", "permanentCopy", "hired", "deliveredInSeconds", "settled", "checks", "checkedAt"],
    claim: c,
  };
}
export function deliveryFor(job, data = loadDelivery()) {
  const id = Number(job);
  const rows = data.claims.filter((r) => r.claim && r.claim.job === id);
  const v = rows.length ? deliveryView(rows[rows.length - 1]) : null;
  if (v) v.seal.key = data.key || null;
  return v;
}
export function deliveryList(limit = 50, data = loadDelivery()) {
  const rows = data.claims.slice(-Math.min(Math.max(Number(limit) || 50, 1), 200)).reverse().map(deliveryView).filter(Boolean);
  rows.forEach((v) => { v.seal.key = data.key || null; });
  return { count: data.count || data.claims.length, key: data.key || null, network: "opBNB", updated: data.updated || null, claims: rows,
    note: "one row per sealed check of a hire: the verdict, the three checks, the hashes, the on chain pointer and the opBNB seal. Rebuild the canonical claim, hash it and compare with the calldata to verify a row yourself" };
}
export function deliveryByJob(data = loadDelivery()) { const m = {}; data.claims.forEach((r) => { if (r.claim) m[r.claim.job] = r; }); return m; }
