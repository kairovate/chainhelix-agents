// 2026-09-05: the shared RPC fallback for quote.js, probe.js and verify.js, exercised against two local nodes:
// the primary refuses (archive-token message, code -32602; then HTTP 500; then a hang), the fallback answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
const answers = { primary: null, fallback: '{"jsonrpc":"2.0","id":1,"result":"0xok"}' };
let primaryCalls = 0, fallbackCalls = 0;
function serve(which) {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      if (which === "primary") primaryCalls++; else fallbackCalls++;
      const a = answers[which];
      if (a === "hang") return; // never answers; the caller's abort must decide
      if (a === "http500") { res.statusCode = 500; return res.end("bad gateway"); }
      res.setHeader("content-type", "application/json"); res.end(a);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}
const primary = await serve("primary"), fallback = await serve("fallback");
process.env.RPC_URL = `http://127.0.0.1:${primary.address().port}`;
process.env.RPC_FALLBACK_URL = `http://127.0.0.1:${fallback.address().port}`;
process.env.RPC_PRIMARY_MS = "500";
const { rpcRead, isDeterministicRpcError } = await import("../src/rpc.js");
test("archive-token refusal (code -32602) falls back", async () => {
  answers.primary = '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"}}';
  assert.equal(await rpcRead("eth_call", []), "0xok"); assert.equal(fallbackCalls, 1);
});
test("HTTP 500 on the primary falls back", async () => {
  answers.primary = "http500";
  assert.equal(await rpcRead("eth_call", []), "0xok"); assert.equal(fallbackCalls, 2);
});
test("a real deterministic answer is not replayed", async () => {
  answers.primary = '{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}';
  await assert.rejects(() => rpcRead("eth_call", []), /execution reverted/); assert.equal(fallbackCalls, 2);
  answers.primary = '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid argument 0: hex string has length 63"}}';
  await assert.rejects(() => rpcRead("eth_call", []), /invalid argument/); assert.equal(fallbackCalls, 2);
});
test("a hung primary gives way to the fallback inside the caller's budget", async () => {
  answers.primary = "hang";
  const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 2000);
  const t0 = Date.now();
  assert.equal(await rpcRead("eth_call", [], { signal: ctrl.signal }), "0xok");
  assert.ok(Date.now() - t0 < 1500, "the primary was cut off by RPC_PRIMARY_MS, not by the caller");
});
test("a caller budget shorter than the primary window still ends the read", async () => {
  answers.primary = "hang";
  const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 200);
  await assert.rejects(() => rpcRead("eth_call", [], { signal: ctrl.signal }));
});
test("classifier", () => {
  const e = Object.assign(new Error("rpc x: rate limit exceeded"), { rpcApplicationError: true, rpcErrorCode: -32005 });
  assert.equal(isDeterministicRpcError(e), false); assert.equal(isDeterministicRpcError(new Error("fetch failed")), false);
});
test.after(() => { primary.close(); fallback.close(); });
