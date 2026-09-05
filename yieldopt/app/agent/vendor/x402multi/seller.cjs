'use strict';
// x402multi/seller.cjs: the agents' pay-per-call route (/x402) with the SAME acceptance as the ChainHelix MCP:
// USDT, USDC, USD1 and U on BNB Smart Chain over Binance's B402 facilitator (2026-09-05, operator: "should be same
// acceptance as our mcp, not just U"). The studio runtime's own x402 seller takes one token by design ("assets other
// than [U] arrive in a later version"), so this module takes the route instead when X402_MULTI is not 0.
//
// Contract, the same one the MCP keeps: a request without a payment header answers 402 with the terms (x402 v2 body
// plus the base64 payment-required header). A request with PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1) is parsed, matched
// to OUR advertised terms (never the payer's), checked to pay our wallet at least our price, verified and settled by
// the facilitator, and only then is the work run and the deliverable returned with the PAYMENT-RESPONSE header. A
// settled payment whose work failed stays OWED: the payer re-sends the same header and is served without a second
// charge. A settle with no terminal answer is queued for idempotent reconciliation and the payer is told to retry
// with the same header. Spent nonces are tombstoned as a replay guard. State lives under dataDir.
var fs = require('fs');
var path = require('path');

var REDEMPTION_TTL_MS = 24 * 3600e3;      // a paid, unserved call can be redeemed for a day
var NONCE_GUARD_TTL_MS = 30 * 24 * 3600e3; // a spent nonce is refused for a month

function createMultiSeller(opts) {
  var lane = opts.lane || require('./b402.cjs');
  var env = opts.env || process.env;
  var priceUsd = Number(opts.priceUsd);
  var payTo = opts.payTo;
  var resourceUrl = opts.resourceUrl;
  var description = opts.description || 'pay per call';
  var runWork = opts.runWork;                 // async ({prompt, payer}) -> deliverable (any JSON value)
  var workTimeoutMs = Number(opts.workTimeoutSeconds || 60) * 1000;
  var dataDir = opts.dataDir;
  var log = opts.log || function (m) { console.log('[x402multi] ' + m); };
  var stateFile = path.join(dataDir, 'paystate.json');
  var settled = {}; // nonce -> { status: 'owed'|'done'|'used', body?, at, payer, tx, network }

  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}
  try {
    var saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    var now = Date.now();
    Object.keys(saved.settled || {}).forEach(function (k) { if (now - (saved.settled[k].at || 0) < NONCE_GUARD_TTL_MS) settled[k] = saved.settled[k]; });
  } catch (e) { /* first boot */ }
  function save() {
    try { fs.writeFileSync(stateFile + '.tmp', JSON.stringify({ settled: settled })); fs.renameSync(stateFile + '.tmp', stateFile); }
    catch (e) { log('state save failed: ' + e.message); }
  }
  function remember(nonce, rec) { if (!nonce) return; rec.at = Date.now(); settled[nonce] = rec; save(); }
  setInterval(function () {
    var now = Date.now();
    Object.keys(settled).forEach(function (k) {
      var r = settled[k];
      if (r.status === 'done' && now - r.at > REDEMPTION_TTL_MS) { settled[k] = { status: 'used', at: r.at, payer: r.payer, tx: r.tx, network: r.network }; }
      else if (now - r.at > NONCE_GUARD_TTL_MS) delete settled[k];
    });
    save();
  }, 3600e3).unref();

  lane.init(env, { payTo: payTo, dataDir: path.join(dataDir, 'lane'), onLateSettle: function (nonce, payload, tx, reqs) {
    var au = payload && payload.payload && (payload.payload.authorization || payload.payload.permit2Authorization);
    remember(nonce, { status: 'owed', payer: au && au.from ? String(au.from).toLowerCase() : null, tx: tx || null, network: reqs && reqs.network });
    log('late settle confirmed for nonce ' + nonce + '; the payer can redeem with the same header');
  } });

  function b64(obj) { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); }
  function json(status, body, extraHeaders) {
    return { status: status, headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}), body: JSON.stringify(body) };
  }
  function terms(error) {
    var body = { x402Version: 2, error: error || 'X-PAYMENT header is required',
      resource: { url: resourceUrl, description: description, mimeType: 'application/json' },
      accepts: lane.isReady() ? lane.acceptsFor(priceUsd) : [],
      hint: 'Send the job input as the request body (or as {"prompt": "<input>"}). Every accepted network and asset is listed in accepts; the same header retried after a pending settlement redeems it without a second charge.' };
    return json(402, body, { 'payment-required': b64(body) });
  }
  function receipt(tx, network, payer) {
    var v = b64({ success: true, transaction: tx || null, network: network || null, payer: payer || null });
    return { 'PAYMENT-RESPONSE': v, 'X-PAYMENT-RESPONSE': v };
  }
  // the prompt: ?prompt=, {"prompt": "..."} in a JSON body, a JSON object body taken whole as the job input, or plain text
  function promptFrom(request) {
    var q = request.query && request.query.prompt;
    if (q !== undefined && q !== null && String(q).trim()) return String(q);
    var body = request.body;
    if (!body) return '';
    try {
      var parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (typeof parsed.prompt === 'string') return parsed.prompt;
        return JSON.stringify(parsed); // the whole object is the job input, the shape the card documents
      }
    } catch (e) { /* plain text */ }
    return String(body);
  }
  function parsePayment(headers) {
    var hdr = headers['payment-signature'] || headers['x-payment'];
    if (!hdr) return null;
    try {
      var payload = JSON.parse(Buffer.from(String(hdr), 'base64').toString('utf8'));
      var auth = payload && payload.payload && (payload.payload.authorization || payload.payload.permit2Authorization);
      var payer = null;
      var f = String((auth && auth.from) || '').toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(f)) payer = f;
      return { payload: payload, nonce: (auth && auth.nonce) || null, payer: payer };
    } catch (e) { return null; }
  }
  // OUR terms entry the payer signed for: matched on (network, scheme, asset, method), the method read from the
  // payload's own shape; requirements are never taken from the payer
  function reqsFor(parsed) {
    var all = lane.acceptsFor(priceUsd);
    var p = parsed.payload;
    var chosen = p && (p.accepted || (p.network ? { network: p.network, scheme: p.scheme, asset: p.asset } : null));
    if (!chosen || chosen.network !== lane.network()) return null;
    var method = String(p.payload && p.payload.permit2Authorization ? 'permit2-exact' : (p.payload && p.payload.authorization ? 'eip3009' : (chosen.extra && chosen.extra.assetTransferMethod) || '')).toLowerCase();
    var methodOf = function (a) { return String((a.extra && a.extra.assetTransferMethod) || '').toLowerCase(); };
    var same = all.filter(function (a) { return a.network === chosen.network && a.scheme === chosen.scheme && (!method || methodOf(a) === method); });
    var exact = same.filter(function (a) { return String(a.asset).toLowerCase() === String(chosen.asset || '').toLowerCase(); });
    if (exact.length) return exact[0];
    if (!chosen.asset && same.length === 1) return same[0];
    return null;
  }
  function signedTermsMatch(payload, reqs) {
    try {
      var pp = payload && payload.payload; if (!pp || !reqs) return false;
      var wantTo = String(reqs.payTo || '').toLowerCase(); if (!wantTo || reqs.amount == null) return false;
      var to, amt, a = pp.authorization, p2 = pp.permit2Authorization;
      if (a) { to = a.to; amt = a.value; } else if (p2) { to = (p2.witness || {}).to; amt = (p2.permitted || {}).amount; } else return false;
      return String(to || '').toLowerCase() === wantTo && BigInt(String(amt || '0')) >= BigInt(String(reqs.amount));
    } catch (e) { return false; }
  }
  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('work timed out after ' + ms + ' ms')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }
  function serve(nonce, payer, tx, network, prompt) {
    return withTimeout(Promise.resolve().then(function () { return runWork({ prompt: prompt, payer: payer }); }), workTimeoutMs)
      .then(function (result) {
        var body = { result: result };
        remember(nonce, { status: 'done', body: body, payer: payer, tx: tx, network: network });
        return json(200, body, receipt(tx, network, payer));
      }, function (e) {
        log('work failed after settlement (payment retained, nonce owed): ' + (e && e.message));
        remember(nonce, { status: 'owed', payer: payer, tx: tx, network: network });
        return json(500, { error: 'work failed after settlement; retry this exact request with the same payment header to redeem it, no second charge', transaction: tx || null }, receipt(tx, network, payer));
      });
  }

  async function handle(request) {
    var headers = {}; Object.keys(request.headers || {}).forEach(function (k) { headers[k.toLowerCase()] = request.headers[k]; });
    var parsed = parsePayment(headers);
    if (!parsed) return terms();
    if (!lane.isReady()) return json(503, { error: 'pay-per-call rail is not ready (facilitator not confirmed); retry shortly' });
    var prompt = promptFrom(request).trim();
    if (!prompt) return json(400, { error: 'x402 request requires a job input: send it as the request body' });
    var known = parsed.nonce && settled[parsed.nonce];
    if (known) {
      if (known.status === 'done' && known.body) return json(200, known.body, receipt(known.tx, known.network, known.payer));
      if (known.status === 'owed') return serve(parsed.nonce, known.payer || parsed.payer, known.tx, known.network, prompt);
      return terms('this payment was already used');
    }
    var reqs = reqsFor(parsed);
    if (!reqs) return terms('the payment names terms this resource does not offer');
    if (!signedTermsMatch(parsed.payload, reqs)) return terms('the signed payment does not pay this resource its price');
    var ok = await new Promise(function (resolve) { lane.verify(parsed.payload, reqs, function (v) { resolve(!!v); }); });
    if (!ok) return terms('payment verification failed');
    var s = await new Promise(function (resolve) { lane.settle(parsed.payload, reqs, parsed.nonce, parsed.payer, function (sok, tx, pending, reason) { resolve({ ok: sok, tx: tx, pending: pending, reason: reason }); }, null); });
    if (!s.ok) {
      if (s.pending) return json(402, { x402Version: 2, error: 'payment settlement is pending confirmation. Do not sign a new payment: retry this exact request with the SAME payment header to redeem it once settled.', resource: { url: resourceUrl, description: description, mimeType: 'application/json' }, accepts: [] });
      return terms('payment settlement failed' + (s.reason ? ': ' + s.reason : ''));
    }
    remember(parsed.nonce, { status: 'owed', payer: parsed.payer, tx: s.tx, network: reqs.network });
    log('PAID ' + (lane.assets()[reqs.extra && reqs.extra.name] || {}).symbol + ' tx ' + (s.tx || '') + ' payer ' + parsed.payer);
    return serve(parsed.nonce, parsed.payer, s.tx, reqs.network, prompt);
  }

  return { handle: handle, get state() { return lane.isReady() ? 'live' : 'dormant'; }, _test: { promptFrom: promptFrom, reqsFor: reqsFor, signedTermsMatch: signedTermsMatch, settled: settled } };
}

module.exports = { createMultiSeller: createMultiSeller };
