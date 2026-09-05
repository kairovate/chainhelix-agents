// 2026-09-05 (operator: "add the fallback to the other three readers"): one RPC read helper for the readers that
// had none. hire.js keeps its own rpc() (the same rule, proven on job 56716); quote.js, probe.js and verify.js read
// through this. Rule: try RPC_URL, and on any failure that is not a complete deterministic answer (a revert, bad
// params) try RPC_FALLBACK once. A node refusing a read for want of a token, a rate limit, an HTTP error or a
// transport failure are availability answers whatever code they wear. RPC_FALLBACK_URL overrides the fallback
// (tests); RPC_FALLBACK=0 pins every reader to RPC_URL alone.
import { RPC_URL } from "./config.js";

export const RPC_FALLBACK = process.env.RPC_FALLBACK_URL || "https://bsc-dataseed.binance.org";
const FALLBACK_ON = process.env.RPC_FALLBACK !== "0";
const DETERMINISTIC_CODES = new Set([-32700, -32600, -32601, -32602]);
const AVAILABILITY_SHAPED = /archive request|personal token|rate limit|too many requests|quota|capacity/i;

export function isDeterministicRpcError(e) {
  if (!e || !e.rpcApplicationError) return false;
  if (AVAILABILITY_SHAPED.test(String(e.message))) return false;
  if (DETERMINISTIC_CODES.has(e.rpcErrorCode)) return true;
  return /execution reverted|invalid argument|invalid param/i.test(String(e.message));
}

async function readCapped(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) throw new Error("rpc response too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function rpcOn(url, method, params, { signal, maxBytes = 1_048_576 } = {}) {
  const res = await fetch(url, { signal, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!res.ok) throw new Error(`rpc HTTP ${res.status}`);
  const body = JSON.parse(await readCapped(res, maxBytes));
  if (body.error) {
    const err = new Error(`rpc ${method}: ${body.error.message}`);
    err.rpcApplicationError = true; err.rpcErrorCode = body.error.code;
    throw err;
  }
  return body.result;
}

// sweep 2026-09-05: a primary that hangs used to eat the caller's whole budget (the reader's 10 s abort), so the
// fallback never got a turn. The primary now gets at most PRIMARY_MS of the budget (default 6000); the fallback runs
// on whatever the caller's signal still allows. RPC_PRIMARY_MS overrides.
const PRIMARY_MS = Number(process.env.RPC_PRIMARY_MS || 6000);
function primarySignal(signal) {
  const t = AbortSignal.timeout(PRIMARY_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}
/** eth_* read with the fallback rule above; returns the JSON-RPC result. */
export async function rpcRead(method, params, opts = {}) {
  try {
    return await rpcOn(RPC_URL, method, params, { ...opts, signal: FALLBACK_ON ? primarySignal(opts.signal) : opts.signal });
  } catch (e) {
    if (!FALLBACK_ON || RPC_URL === RPC_FALLBACK) throw e;
    if (isDeterministicRpcError(e)) throw e;
    if (opts.signal && opts.signal.aborted) throw e;
    return rpcOn(RPC_FALLBACK, method, params, opts);
  }
}

/** The transports a viem client should use: primary then fallback, or the primary alone when pinned. */
export function viemTransports(viem) {
  return FALLBACK_ON && RPC_URL !== RPC_FALLBACK ? viem.fallback([viem.http(RPC_URL), viem.http(RPC_FALLBACK)]) : viem.http(RPC_URL);
}
