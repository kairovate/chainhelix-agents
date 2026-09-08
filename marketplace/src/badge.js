// Seller badge (2026-09-08): every completed job of a seller set against the sealed delivery checks on record. The badge is
// earned, not declared: the line "all deliveries checked" appears only when every completed job on the commerce contract
// for the seller's wallet has a sealed check (data/delivery_claims.json, the record behind /d and the MCP's verified_delivery).
// Otherwise the same row carries the true counts, so a seller with unchecked or failed deliveries shows exactly that.
// Pure function over two inputs; the page and the JSON at /api/agents read the same object.
import { loadDelivery } from "./delivery.js";
import { completedJobIds } from "./jobstats.js";
export function deliveryBadge(wallet, { claims = loadDelivery().claims, completed = completedJobIds(wallet) } = {}) {
  const w = String(wallet || "").toLowerCase();
  const latest = {}; // one row per job, the last row on record is its state
  for (const r of claims || []) if (r && r.claim && String(r.claim.provider || "").toLowerCase() === w) latest[r.claim.job] = r;
  const rows = Object.values(latest);
  const sealed = rows.filter((r) => r.status === "sealed");
  const passed = sealed.filter((r) => r.claim.verdict === "verified").length;
  const done = new Set(completed || []);
  const checkedDone = sealed.filter((r) => done.has(r.claim.job)).length;
  const last = sealed.reduce((m, r) => Math.max(m, Number(r.claim.checkedAt) || 0), 0);
  return {
    completedJobs: done.size,
    checked: sealed.length,           // completed jobs with a sealed check plus any sealed check of a job in another state
    completedChecked: checkedDone,
    pending: rows.length - sealed.length,
    passed,
    failed: sealed.length - passed,
    lastCheck: last ? new Date(last).toISOString().slice(0, 10) : null,
    earned: done.size > 0 && checkedDone === done.size,
    record: "/d",
  };
}
