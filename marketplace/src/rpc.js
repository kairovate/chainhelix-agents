// marketplace/src/rpc.js, 2026-09-07 (build plan B2): the marketplace face of the ONE chain-read helper,
// shared/rpc.cjs at the repo root, the same code the ChainHelix MCP's readers, the attestor and the billing watchers
// run. The rule (2026-09-05, proven on job 56716) has not changed: try RPC_URL with a bounded share of the budget, and
// on any failure that is not a complete deterministic answer (a revert, bad params) try RPC_FALLBACK once. The
// exports and the environment switches are the ones quote.js, probe.js, verify.js and the tests already use:
// RPC_FALLBACK_URL overrides the fallback, RPC_FALLBACK=0 pins every reader to RPC_URL, RPC_PRIMARY_MS bounds the
// primary. hire.js keeps its own copy of the rule, proven live, untouched.
import { createRequire } from "node:module";
import { RPC_URL } from "./config.js";

const shared = createRequire(import.meta.url)("../../shared/rpc.cjs");

export const RPC_FALLBACK = process.env.RPC_FALLBACK_URL || "https://bsc-dataseed.binance.org";
const rpc = shared.createRpc({ primary: RPC_URL, fallback: RPC_FALLBACK, on: process.env.RPC_FALLBACK !== "0", primaryMs: Number(process.env.RPC_PRIMARY_MS || 6000), name: "marketplace" });

export const isDeterministicRpcError = shared.isDeterministicRpcError;
/** POST one JSON-RPC call to one node; returns the result or throws (rpcApplicationError on a JSON-RPC error). */
export const rpcOn = rpc.rpcOn;
/** eth_* read with the fallback rule above; returns the JSON-RPC result. */
export const rpcRead = rpc.rpcRead;
/** The transports a viem client should use: primary then fallback, or the primary alone when pinned. */
export const viemTransports = rpc.viemTransports;
