// Verified delivery claims (2026-09-07, build plan A4): the public record of every sealed delivery check, read from
// data/delivery_claims.json, which the check service writes after each claim and each seal. This file only reads it and
// shapes it for the page at /d/<job> and the JSON at /api/delivery. The record itself is what the MCP's free
// delivery_status tool returns; the claim hash is what sits in the opBNB calldata.
import { readFileSync } from "fs";
import { BSCSCAN } from "./config.js";
export const DELIVERY_FILE = process.env.DELIVERY_CLAIMS_FILE || new URL("../data/delivery_claims.json", import.meta.url).pathname;
export const OPBNBSCAN = "https://opbnb.bscscan.com";
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
