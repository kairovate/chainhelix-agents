'use strict';
// shared/rpc.test.cjs (2026-09-07, B2): the shared read helper against two local nodes. Run: node --test shared/
var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');
var { createRpc, isDeterministicRpcError } = require('./rpc.cjs');
// the ethersRead cases need ethers; the tree that runs the MCP has it, the public tree may not: those two cases skip then
function loadEthers() { var names = [process.env.ETHERS_PATH, 'ethers'].filter(Boolean); for (var i = 0; i < names.length; i++) { try { return require(names[i]); } catch (e) {} } return null; }

var answers = { primary: null, fallback: '{"jsonrpc":"2.0","id":1,"result":"0xok"}' };
var calls = { primary: 0, fallback: 0 };
function serve(which) {
  return new Promise(function (resolve) {
    var s = http.createServer(function (req, res) {
      calls[which]++;
      var a = answers[which];
      if (a === 'hang') return;
      if (a === 'http500') { res.statusCode = 500; return res.end('bad gateway'); }
      if (a === 'http429') { res.statusCode = 429; return res.end('slow down'); }
      var body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        res.setHeader('content-type', 'application/json');
        if (typeof a === 'function') return res.end(a(body));
        res.end(a);
      });
    });
    s.listen(0, '127.0.0.1', function () { resolve(s); });
  });
}
var P, F, rpc;
test.before(async function () {
  P = await serve('primary'); F = await serve('fallback');
  rpc = createRpc({ primary: 'http://127.0.0.1:' + P.address().port, fallback: 'http://127.0.0.1:' + F.address().port, primaryMs: 400, name: 'test' });
});
test.after(function () { P.close(); F.close(); });
function reset() { calls.primary = 0; calls.fallback = 0; answers.fallback = '{"jsonrpc":"2.0","id":1,"result":"0xok"}'; }

test('archive-token refusal on the primary falls back', async function () {
  reset(); answers.primary = '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Archive requests require a personal token"}}';
  assert.equal(await rpc.rpcRead('eth_call', []), '0xok'); assert.equal(calls.fallback, 1);
});
test('HTTP 500 and HTTP 429 on the primary fall back', async function () {
  reset(); answers.primary = 'http500'; assert.equal(await rpc.rpcRead('eth_blockNumber', []), '0xok');
  reset(); answers.primary = 'http429'; assert.equal(await rpc.rpcRead('eth_blockNumber', []), '0xok'); assert.equal(calls.fallback, 1);
});
test('a primary that hangs gets only its share of the budget, then the fallback answers', async function () {
  reset(); answers.primary = 'hang';
  var t0 = Date.now(); assert.equal(await rpc.rpcRead('eth_blockNumber', []), '0xok');
  assert.ok(Date.now() - t0 < 2000); assert.equal(calls.fallback, 1);
});
test('a revert is a deterministic answer: thrown, never replayed on the fallback', async function () {
  reset(); answers.primary = '{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}';
  await assert.rejects(rpc.rpcRead('eth_call', []), /execution reverted/); assert.equal(calls.fallback, 0);
});
test('bad params (-32602 without an availability message) is deterministic', async function () {
  reset(); answers.primary = '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid argument 0: hex string"}}';
  await assert.rejects(rpc.rpcRead('eth_call', ['x'])); assert.equal(calls.fallback, 0);
});
test('a good primary answer never touches the fallback', async function () {
  reset(); answers.primary = '{"jsonrpc":"2.0","id":1,"result":"0xprimary"}';
  assert.equal(await rpc.rpcRead('eth_blockNumber', []), '0xprimary'); assert.equal(calls.fallback, 0);
});
test('pinned (on=false): the primary alone, its failure is the answer', async function () {
  reset(); answers.primary = 'http500';
  var pinned = createRpc({ primary: rpc.primary, fallback: rpc.fallback, on: false });
  await assert.rejects(pinned.rpcRead('eth_blockNumber', []), /HTTP 500/); assert.equal(calls.fallback, 0);
});
test('rawRead: a batch body goes through with the same fallback rule and comes back as sent', async function () {
  reset(); answers.primary = 'http500'; answers.fallback = '[{"jsonrpc":"2.0","id":1,"result":"0x1"},{"jsonrpc":"2.0","id":2,"result":"0x2"}]';
  var r = await rpc.rawRead([{ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [] }, { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [] }]);
  assert.equal(r.length, 2); assert.equal(r[1].result, '0x2'); assert.equal(calls.fallback, 1);
});
test('callbackRead: the callback face, error first', function (t, done) {
  reset(); answers.primary = 'http500';
  rpc.callbackRead('eth_blockNumber', [], 2000, function (e, r) { assert.equal(e, null); assert.equal(r, '0xok'); done(); });
});
test('viemTransports: fallback of both when on, the primary alone when pinned', function () {
  var viem = { http: function (u) { return { http: u }; }, fallback: function (list) { return { fallback: list }; } };
  var t = rpc.viemTransports(viem); assert.equal(t.fallback.length, 2); assert.equal(t.fallback[0].http, rpc.primary);
  var pinned = createRpc({ primary: rpc.primary, fallback: rpc.fallback, on: false });
  assert.equal(pinned.viemTransports(viem).http, rpc.primary);
});
test('ethersRead: an availability failure on the primary provider runs the same read on the fallback', async function () {
  var ethers = loadEthers(); if (!ethers) { console.log('ethers not installed in this tree, ethersRead case skipped'); return; }
  reset(); answers.primary = 'http500'; answers.fallback = function (body) { var m = JSON.parse(body); return JSON.stringify({ jsonrpc: '2.0', id: m.id, result: '0x1bc16d674ec80000' }); };
  var bal = await rpc.ethersRead(ethers, 56, function (p) { return p.getBalance('0x000000000000000000000000000000000000dEaD'); });
  assert.equal(bal, 2000000000000000000n); assert.ok(calls.fallback >= 1);
});
test('ethersRead: a revert is thrown, not replayed', async function () {
  var ethers = loadEthers(); if (!ethers) { console.log('ethers not installed in this tree, ethersRead case skipped'); return; }
  reset(); answers.primary = function (body) { var m = JSON.parse(body); return JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: 3, message: 'execution reverted' } }); };
  await assert.rejects(rpc.ethersRead(ethers, 56, function (p) { return p.call({ to: '0x000000000000000000000000000000000000dEaD', data: '0x' }); }));
  assert.equal(calls.fallback, 0);
});
test('isDeterministicRpcError: the classifier', function () {
  var a = new Error('rpc: rate limit'); a.rpcApplicationError = true; a.rpcErrorCode = -32602; assert.equal(isDeterministicRpcError(a), false);
  var b = new Error('rpc: bad'); b.rpcApplicationError = true; b.rpcErrorCode = -32601; assert.equal(isDeterministicRpcError(b), true);
  var c = new Error('execution reverted'); assert.equal(isDeterministicRpcError(c), true);
  var d = new Error('socket hang up'); assert.equal(isDeterministicRpcError(d), false);
  var e = new Error('x'); e.code = 'CALL_EXCEPTION'; assert.equal(isDeterministicRpcError(e), true);
});
