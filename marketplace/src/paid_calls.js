// 2026-09-05: pay-per-call purchases on record (marketplace/paid_calls.json, a committed file, one row per purchase),
// served on the home page and at /api/paid-calls the way the settled-hire trace is. Read-only; every row passes an
// allow-list (agent id, asset symbol, path, amount, 64-hex transaction, ISO-like time) or is dropped.
import { readFileSync } from "fs";
import { BSCSCAN } from "./config.js";

export const PAID_CALLS_FILE = new URL("../paid_calls.json", import.meta.url).pathname;
const AGENTS = new Set(["rebalancer", "gridtrader", "yieldopt", "healthmon"]);
const ASSETS = new Set(["U", "USDT", "USDC", "USD1"]);

export function paidCallRow(c) {
  if (!c || typeof c !== "object") return null;
  if (!AGENTS.has(c.agent) || !ASSETS.has(c.asset)) return null;
  if (!/^0x[0-9a-f]{64}$/i.test(String(c.tx || ""))) return null;
  if (!/^\/[a-z]+\/x402$/.test(String(c.path || ""))) return null;
  if (!/^\d+(\.\d+)?$/.test(String(c.amount || ""))) return null;
  const at = typeof c.at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(c.at) ? c.at : null;
  return { agent: c.agent, asset: c.asset, path: c.path, amount: String(c.amount), tx: String(c.tx).toLowerCase(), link: `${BSCSCAN}/tx/${String(c.tx).toLowerCase()}`, at };
}
export function loadPaidCalls(path = PAID_CALLS_FILE) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return { calls: [] }; }
}
export function paidCallRows(data) {
  return ((data && data.calls) || []).map(paidCallRow).filter(Boolean);
}
export function paidCallsView(data = loadPaidCalls()) {
  const rows = paidCallRows(data);
  return { generated: data.generated || null, count: rows.length, note: data.note || null, rows };
}
