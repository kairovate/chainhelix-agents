'use strict';
// shared/rpc.cjs: THE ONE chain-read helper for both products, 2026-09-07 (build plan B2).
// The rule, first written in marketplace/src/rpc.js on 2026-09-05 and proven on hire 56716: try the primary node with a
// bounded share of the caller's budget; on any failure that is not a complete deterministic answer (a revert, bad
// params) try the fallback once. A node refusing a read for want of a token, a rate limit, a quota, an HTTP error, a
// hang or a transport failure are availability answers whatever code they wear. A deterministic answer is never
// replayed on another node. Sends are never the helper's business: a broadcast is not a read.
//
// One core, three faces:
//   rpcRead(method, params, opts)      JSON-RPC over fetch, primary then fallback     (marketplace, sanctions, billing)
//   rawRead(bodyObj, opts)             the same for a batch body (an array of calls)   (payment_watch balance batches)
//   viemTransports(viem)               viem.fallback([primary, fallback]) or the primary alone when pinned
//   ethersRead(ethers, chainId, fn)    fn(provider) on the primary, then on the fallback on an availability failure
//   callbackRead(method, params, ms, cb) the callback face for the older modules
// createRpc({ primary, fallback, on, primaryMs, maxBytes, name }). on=false pins every read to the primary.
var DETERMINISTIC_CODES = { '-32700': 1, '-32600': 1, '-32601': 1, '-32602': 1 };
var AVAILABILITY_SHAPED = /archive request|personal token|rate limit|too many requests|quota|capacity|timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|503|502|429/i;
var DETERMINISTIC_SHAPED = /execution reverted|invalid argument|invalid param|revert/i;

function isDeterministicRpcError(e) {
  if (!e) return false;
  var msg = String(e.message || e);
  if (AVAILABILITY_SHAPED.test(msg)) return false;
  if (e.rpcApplicationError && DETERMINISTIC_CODES[String(e.rpcErrorCode)]) return true;
  if (e.rpcApplicationError) return DETERMINISTIC_SHAPED.test(msg);
  // ethers v6 shapes a revert as CALL_EXCEPTION; a bad argument as INVALID_ARGUMENT
  if (e.code === 'CALL_EXCEPTION' || e.code === 'INVALID_ARGUMENT' || e.code === 'UNSUPPORTED_OPERATION') return true;
  return DETERMINISTIC_SHAPED.test(msg);
}

async function readCapped(res, maxBytes) {
  var reader = res.body.getReader(), chunks = [], size = 0;
  for (;;) {
    var r = await reader.read();
    if (r.done) break;
    size += r.value.length;
    if (size > maxBytes) throw new Error('rpc response too large');
    chunks.push(r.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function postJson(url, bodyObj, opts) {
  opts = opts || {};
  var res = await fetch(url, { signal: opts.signal, method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ChainHelix/1.0' }, body: JSON.stringify(bodyObj) });
  if (!res.ok) { var he = new Error('rpc HTTP ' + res.status + ' from ' + new URL(url).hostname); he.httpStatus = res.status; throw he; }
  return JSON.parse(await readCapped(res, opts.maxBytes || 1048576));
}

function createRpc(cfg) {
  cfg = cfg || {};
  var primary = cfg.primary, fallback = cfg.fallback || null;
  var on = cfg.on !== false && !!fallback && fallback !== primary;
  var primaryMs = cfg.primaryMs > 0 ? cfg.primaryMs : 6000;
  var name = cfg.name || 'rpc';
  if (!primary) throw new Error(name + ': createRpc needs a primary url');
  function primarySignal(signal) {
    var t = AbortSignal.timeout(primaryMs);
    return signal ? AbortSignal.any([signal, t]) : t;
  }
  async function rpcOn(url, method, params, opts) {
    var body = await postJson(url, { jsonrpc: '2.0', id: 1, method: method, params: params || [] }, opts);
    if (body && body.error) {
      var err = new Error('rpc ' + method + ': ' + (body.error.message || JSON.stringify(body.error)));
      err.rpcApplicationError = true; err.rpcErrorCode = body.error.code;
      throw err;
    }
    return body ? body.result : undefined;
  }
  function shouldFallBack(e, opts) {
    if (!on) return false;
    if (isDeterministicRpcError(e)) return false;
    if (opts && opts.signal && opts.signal.aborted) return false;
    return true;
  }
  async function rpcRead(method, params, opts) {
    opts = opts || {};
    try { return await rpcOn(primary, method, params, Object.assign({}, opts, { signal: on ? primarySignal(opts.signal) : opts.signal })); }
    catch (e) { if (!shouldFallBack(e, opts)) throw e; return rpcOn(fallback, method, params, opts); }
  }
  // a raw body (a batch array, or a non-Ethereum JSON-RPC shape); the answer is returned as parsed, the caller
  // validates it. Fallback on HTTP, transport, timeout and availability-shaped JSON-RPC errors.
  async function rawRead(bodyObj, opts) {
    opts = opts || {};
    async function once(url, o) {
      var j = await postJson(url, bodyObj, o);
      if (j && !Array.isArray(j) && j.error) { var err = new Error('rpc: ' + (j.error.message || JSON.stringify(j.error))); err.rpcApplicationError = true; err.rpcErrorCode = j.error.code; throw err; }
      return j;
    }
    try { return await once(primary, Object.assign({}, opts, { signal: on ? primarySignal(opts.signal) : opts.signal })); }
    catch (e) { if (!shouldFallBack(e, opts)) throw e; return once(fallback, opts); }
  }
  function callbackRead(method, params, timeoutMs, cb) {
    var done = false;
    rpcRead(method, params, { signal: AbortSignal.timeout(timeoutMs > 0 ? timeoutMs : 8000) })
      .then(function (r) { if (!done) { done = true; cb(null, r); } }, function (e) { if (!done) { done = true; cb(e); } });
  }
  function viemTransports(viem) {
    return on ? viem.fallback([viem.http(primary), viem.http(fallback)]) : viem.http(primary);
  }
  var providers = {};
  function provider(ethers, url, chainId) {
    var k = url + '|' + chainId;
    if (!providers[k]) providers[k] = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
    return providers[k];
  }
  // fn(provider) -> promise. The primary provider first; on an availability-shaped failure the same fn on the
  // fallback provider. A deterministic failure (a revert, a bad argument) is thrown as it came.
  async function ethersRead(ethers, chainId, fn) {
    try { return await fn(provider(ethers, primary, chainId)); }
    catch (e) { if (!on || isDeterministicRpcError(e)) throw e; return fn(provider(ethers, fallback, chainId)); }
  }
  return { primary: primary, fallback: fallback, on: on, primaryMs: primaryMs, name: name, isDeterministicRpcError: isDeterministicRpcError,
    rpcOn: rpcOn, rpcRead: rpcRead, rawRead: rawRead, callbackRead: callbackRead, viemTransports: viemTransports, ethersRead: ethersRead, provider: function (ethers, chainId) { return provider(ethers, primary, chainId); } };
}

// the free public fallbacks the products use, one per chain, no keys (operator 2026-09-06: no paid tiers until revenue)
var DEFAULT_FALLBACK = {
  'eip155:56': 'https://bsc-rpc.publicnode.com',           // BNB Smart Chain; primary is usually bsc-dataseed.binance.org
  'eip155:204': 'https://opbnb-rpc.publicnode.com',        // opBNB; primary opbnb-mainnet-rpc.bnbchain.org
  'eip155:1': 'https://1rpc.io/eth'                         // Ethereum; primary ethereum-rpc.publicnode.com
};

module.exports = { createRpc: createRpc, isDeterministicRpcError: isDeterministicRpcError, DEFAULT_FALLBACK: DEFAULT_FALLBACK };
