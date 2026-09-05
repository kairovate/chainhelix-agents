// 2026-09-05: the RPC fallback must fire on a node that refuses a read for want of a token (publicnode's archive
// message, code -32602), and must not fire on a real deterministic answer (revert, bad params).
import { test } from "node:test";
import assert from "node:assert/strict";
const { isDeterministicRpcError } = await import("../src/hire.js");
const rpcErr = (code, message) => Object.assign(new Error("rpc eth_getTransactionReceipt: " + message), { rpcApplicationError: true, rpcErrorCode: code });
test("archive-token refusal is availability-shaped even with code -32602: falls back", () => {
  assert.equal(isDeterministicRpcError(rpcErr(-32602, "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode")), false);
  assert.equal(isDeterministicRpcError(rpcErr(-32005, "rate limit exceeded")), false);
});
test("a real deterministic answer is not replayed", () => {
  assert.equal(isDeterministicRpcError(rpcErr(-32602, "invalid argument 0: hex string has length 63")), true);
  assert.equal(isDeterministicRpcError(rpcErr(3, "execution reverted")), true);
  assert.equal(isDeterministicRpcError(new Error("fetch failed")), false);
});
