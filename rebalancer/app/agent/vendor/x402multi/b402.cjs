// x402multi/b402.cjs: Binance B402 settlement lane for the four agents (BSC mainnet), 2026-09-05.
// Ported from the ChainHelix MCP's lane (mcp/b402.js, live since 2026-08-12) so the agents' pay-per-call rail takes the
// SAME assets the MCP takes: USDT, USDC, USD1 and U on BNB Smart Chain. Differences from the MCP copy: credentials come
// from the agent's env only (the installed B402_* lines), the private key may arrive base64 in B402_PRIVATE_KEY_B64,
// payTo is pinned to the official payment wallet by constant (the agents cannot read the operator allowlist file),
// the lane is on whenever credentials are present, and the state directory is passed in. Everything else is the MCP's.
// Operator go: "can we start building that and review/audit/wire/harden".
// x402-v2-conformant facilitator behind Binance's Connect ("Tesla") gateway.
// Auth scheme is NOT in the b402 docs, derived from the Connect Prime guideline
// and confirmed empirically against production (audit/HANDOFF_2026-08-12.md):
//   X-Tesla-Signature = base64( SHA256withRSA( jsonBodyString + timestampMs ) )
// signed with our 1024-bit RSA key; Binance holds the public half.
//
// DARK BY DEFAULT: init() is a no-op unless B402_ENABLED=1. When enabled the
// lane self-configures from POST /supported at boot, no hard-coded schemes or
// assets. /supported failing (e.g. key not yet registered) = lane stays dark
// with a loud log. It cannot advertise terms it has not seen the facilitator
// confirm.
//
// SETTLE IS ASYNC on this rail (their docs): ~20s synchronous window, backend
// reconciliation up to ~30 min, settles strictly idempotent on (nonce, network,
// payer), identical retries return the cached result, never re-broadcast. So:
// an ambiguous settle (transport error / no terminal answer in-window) goes to
// a persisted pending queue and is re-tried with IDENTICAL params by a poller.
// A late success marks the nonce redeemable via onLateSettle (payer re-sends
// the same X-PAYMENT, tool runs, no second charge, same redemption contract
// as the Base lane).

var fs = require('fs');
var https = require('https');
var crypto = require('crypto');

var st = {
  enabled: false,
  baseUrl: 'https://cb.binanceapi.com',
  clientId: null,
  accessToken: null,   // never logged
  privateKey: null,    // PEM string, never logged
  network: 'eip155:56',
  payTo: null,
  kinds: [],           // from /supported: [{scheme, network, ...}]
  accepts: [],         // derived accepts entries for x402Body
  dataDir: null,               // set by init(opts.dataDir)
  pending: [],         // [{nonce, payer, payload, reqs, firstAt, tries}]
  onLateSettle: null,
  ready: false
};

// M128 claim [56] (2026-09-01): the paragraph that stood here was an older copy of the one below and said "both are
// 18-decimal" of a four-entry table. One paragraph, the current one.
// Wrong-address or wrong-decimal advertising is the one unrecoverable error, so assets outside this table are
// skipped until a human verifies them.
// Keyed by the EIP-712 name that /supported returns (no address on the wire); we supply
// the address + decimals, each verified on-chain (eth_call name/symbol/decimals on BSC)
// and cross-checked on BscScan. All four are 18-decimal (NOT 6 like Base USDC, a
// 6-decimal assumption would misprice by 1e12). `domain` is present only where the token
// implements its own EIP-712 (eip3009 path) and is PINNED from the token's on-chain
// DOMAIN_SEPARATOR (reproduce with tests/verify_domains.js) so we advertise the domain
// the token actually validates even if the facilitator drifts. USDC/USDT have no token
// domain, they move via the Permit2 contract's own domain, so they carry no `domain`
// and are reachable only through permit2-exact.
var BSC_ASSETS = {
  'United Stables':              { address: '0xce24439f2d9c6a2289f741120fe202248b666666', symbol: 'U',    decimals: 18, domain: { name: 'United Stables', version: '1' } },
  'World Liberty Financial USD': { address: '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', symbol: 'USD1', decimals: 18, domain: { name: 'World Liberty Financial USD', version: '1' } },
  'Tether USD':                  { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
  'USD Coin':                    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 }
};

var OFFICIAL_PAYTO = '0xD4Fa54a346A7788BBc32c2229008b4305Ab7E3fE'; // payout-address integrity: the one wallet customer money may go to
function log(m) { console.log('[x402multi] b402: ' + m); }
function warn(m) { console.error('[x402multi] b402: ' + m); }

// ---------- credentials ----------
function loadCreds(env) {
  var id = (env.B402_CLIENT_ID || '').trim();
  var tok = (env.B402_ACCESS_TOKEN || '').trim();
  if (!id || !tok) throw new Error('B402_CLIENT_ID/B402_ACCESS_TOKEN not set in the agent env');
  st.clientId = id; st.accessToken = tok;
}
function loadKey(env) {
  if (env.B402_PRIVATE_KEY_B64) return Buffer.from(String(env.B402_PRIVATE_KEY_B64).trim(), 'base64').toString('utf8');
  if (env.B402_PRIVATE_KEY) return fs.readFileSync(env.B402_PRIVATE_KEY, 'utf8');
  throw new Error('B402_PRIVATE_KEY_B64 (or B402_PRIVATE_KEY path) not set in the agent env');
}

// ---------- signed transport ----------
function sign(bodyStr, ts) {
  var s = crypto.createSign('RSA-SHA256');
  s.update(bodyStr + ts);
  return s.sign(st.privateKey, 'base64');
}
function _sw(name) { return String((st.env && st.env[name]) || process.env[name] || '1') !== '0'; } // kill-switch read: server.js passes .env as ENV, not process.env
function request(pathName, bodyObj, cb) { // cb(err, json)
  // MCP fix 2026-09-01 M98: settle latch. rq.destroy() inside the 'timeout' handler makes the
  // request emit 'error' as well (ECONNRESET), so one timed-out settle answered cb TWICE. In
  // poll() the second answer drove `--left` to zero early, rebuilt st.pending from a partial
  // `keep` and saved it to disk: a still-pending row was deleted from queue and disk (verify
  // lane run: queue ["A","A","B"], row C lost). Same latch as lib/mevintel/profit_core.js:62-65.
  // Kill switch CHX_B402_SETTLE_LATCH=0.
  if (_sw('CHX_B402_SETTLE_LATCH')) { var _rawCb = cb, _done = false; cb = function () { if (_done) return; _done = true; _rawCb.apply(null, arguments); }; }
  var bodyStr = JSON.stringify(bodyObj || {});
  var ts = String(Date.now());
  var sig;
  try { sig = sign(bodyStr, ts); } catch (e) { return cb(new Error('signing failed: ' + e.message)); }
  var u = new URL(st.baseUrl + pathName);
  if (u.protocol !== 'https:') return cb(new Error('b402 base URL must be https')); // token+sig never travel plaintext
  var rq = https.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname, method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr),
      'X-Tesla-ClientId': st.clientId, 'X-Tesla-SignAccessToken': st.accessToken,
      'X-Tesla-Timestamp': ts, 'X-Tesla-Signature': sig
    }, timeout: 45000 }, // same budget as the Base lane; their sync settle window is ~20s
    function (rs) {
      var d = '';
      rs.on('data', function (c) { d += c; });
      rs.on('end', function () {
        // 2026-08-20 (operator go): keep status/headers/raw alongside the parsed
        // JSON, the 08-15 invalid_transaction_state failures could not be
        // correlated with Binance's gateway logs because everything but
        // success/errorReason was discarded. Response headers carry no secrets
        // (our token/sig are request-side only). Capture only; no behavior change.
        var meta = { status: rs.statusCode, headers: rs.headers || {}, raw: String(d).slice(0, 2000) };
        var j = null;
        try { j = JSON.parse(d); } catch (e) {}
        if (!j) {
          var ne = new Error('b402 non-JSON response (' + rs.statusCode + '): ' + String(d).slice(0, 120));
          ne.meta = meta;
          return cb(ne);
        }
        // gateway may wrap x402 payloads in {code,message,data}, unwrap when present
        if (j.data && typeof j.code !== 'undefined') j = j.data;
        cb(null, j, rs.statusCode, meta);
      });
    });
  rq.on('error', function (e) { cb(e); });
  rq.on('timeout', function () { rq.destroy(); cb(new Error('b402 timeout')); });
  rq.end(bodyStr);
}

// ---------- pending-settle persistence ----------
function pendingFile() { return st.dataDir + '/pending.json'; }
function settlesFile() { return st.dataDir + '/settles.ndjson'; }
function savePending() {
  try {
    fs.writeFileSync(pendingFile() + '.tmp', JSON.stringify(st.pending));
    fs.renameSync(pendingFile() + '.tmp', pendingFile());
  } catch (e) { warn('pending save failed: ' + e.message); }
}
function ledger(row) {
  row.ts = Date.now();
  try { fs.appendFileSync(settlesFile(), JSON.stringify(row) + '\n'); } catch (e) { warn('ledger append failed: ' + e.message); }
}

// Pull any request/trace correlation IDs out of gateway response headers so
// failed settles can be matched to Binance's production logs (their 08-20 ask;
// we had nothing to give them for the 08-15 failures). Name-based match keeps
// this robust to whatever header their gateway actually uses.
function traceIds(meta) {
  var out = null;
  var h = meta && meta.headers;
  if (!h) return out;
  Object.keys(h).forEach(function (k) {
    var lk = k.toLowerCase();
    if (/trace|request-id|requestid|correlation/.test(lk)) { (out = out || {})[lk] = h[k]; }
  });
  return out;
}

// ---------- public API ----------
function supported(cb) { request('/papi/v2/b402/supported', {}, cb); }

function verify(paymentPayload, paymentRequirements, cb) { // cb(ok, resp)
  request('/papi/v2/b402/verify', { x402Version: 2, paymentPayload: paymentPayload, paymentRequirements: paymentRequirements },
    function (e, j, status, meta) {
      if (e) { warn('verify: ' + e.message); return cb(false, null); }
      var ok = j && j.isValid === true;
      // 2026-08-20: rejected verifies log status + trace + raw so they can be
      // correlated too, Binance is adding balance/approval preflight to verify,
      // which will make these rejections the first diagnostic surface.
      if (!ok) warn('verify REJECTED (' + ((j && j.invalidReason) || 'no reason') + ') [status=' + (meta && meta.status) +
        ' trace=' + JSON.stringify(traceIds(meta)) + '] raw=' + String(meta && meta.raw).slice(0, 300));
      cb(ok, j);
    });
}

// 2026-08-15 (operator "wire the binance extension"): B402 Bazaar discovery ,
// a confirmed settle carrying extensions.bazaar registers the resource in
// Binance's (unlaunched) discovery registry; entries persist now, are keyed
// (merchantId, resourceUrl), later settles with a changed blob overwrite, and
// failed settles never index. The blob rides ONLY on settle, a bad blob never
// blocks payment (per their docs), but we still only send spec-shaped blobs.
function settleBody(paymentPayload, paymentRequirements, bazaar) {
  var body = { x402Version: 2, paymentPayload: paymentPayload, paymentRequirements: paymentRequirements };
  if (bazaar) body.extensions = { bazaar: bazaar };
  return body;
}

// cb(ok, tx, pending), pending=true means charged-state unknown; caller must
// NOT serve, the poller owns the nonce from here.
function settle(paymentPayload, paymentRequirements, nonce, payer, cb, bazaar) {
  var body = settleBody(paymentPayload, paymentRequirements, bazaar);
  request('/papi/v2/b402/settle', body, function (e, j, status, meta) {
    if (!e && j && j.success === true) {
      ledger({ kind: 'settle', ok: true, nonce: nonce, payer: payer, tx: j.transaction || '', amount: j.amount || null, trace: traceIds(meta) });
      return cb(true, j.transaction || null, false);
    }
    // terminal rejection: well-formed answer with an error code and no broadcast.
    // 2026-08-17 (operator "do 1"): the gateway's errorReason rides the callback ,
    // the 08-15 organic buyer got 8 bare 402s for invalid_transaction_state and
    // had nothing to debug with.
    // 2026-08-20 (operator go): failed rows keep the FULL gateway response
    // (status, headers, raw body), the 08-15 failures had no trace IDs to hand
    // Binance when they asked to correlate their production logs.
    if (!e && j && j.success === false && j.errorReason && !j.transaction) {
      ledger({ kind: 'settle', ok: false, nonce: nonce, payer: payer, reason: j.errorReason,
        trace: traceIds(meta), httpStatus: meta && meta.status, respHeaders: meta && meta.headers, raw: meta && meta.raw });
      return cb(false, null, false, j.errorReason);
    }
    // ambiguous (transport error, timeout, or broadcast without confirmation):
    // funds MAY have moved, enqueue for idempotent re-settle, do not serve now.
    var am = (e && e.meta) || meta;
    warn('settle AMBIGUOUS for nonce ' + nonce + ' (' + (e ? e.message : 'success=false tx=' + (j && j.transaction)) + ')' +
      (am ? ' [status=' + am.status + ' trace=' + JSON.stringify(traceIds(am)) + ']' : '') + ', queued for reconciliation');
    // bazaar kept on the row so the poller's re-settle body stays IDENTICAL to
    // the first attempt (the idempotency contract we rely on)
    st.pending.push({ nonce: nonce, payer: payer, payload: paymentPayload, reqs: paymentRequirements, bazaar: bazaar || null, firstAt: Date.now(), tries: 0 });
    savePending();
    cb(false, null, true, 'pending');
  });
}

// Reconciliation poller: re-settle pending rows with IDENTICAL params (their
// idempotency contract makes this safe) every 60s until terminal or 35 min old.
var POLL_MS = 60e3, GIVE_UP_MS = 35 * 60e3;
function poll() {
  if (!st.pending.length) return;
  var keep = [];
  var due = st.pending.slice();
  var left = due.length;
  due.forEach(function (p) {
    request('/papi/v2/b402/settle', settleBody(p.payload, p.reqs, p.bazaar), function (e, j, status, meta) {
      p.tries++;
      if (!e && j && j.success === true) {
        ledger({ kind: 'settle_late', ok: true, nonce: p.nonce, payer: p.payer, tx: j.transaction || '', amount: j.amount || null, tries: p.tries, trace: traceIds(meta) });
        log('late settle CONFIRMED nonce ' + p.nonce + ', payer can redeem with the same X-PAYMENT');
        if (st.onLateSettle) { try { st.onLateSettle(p.nonce, p.payload, j.transaction || null, p.reqs); } catch (e2) {} } // payload so the owed entry binds to the signed payment (server F1); tx+reqs for the genesis marker
      } else if (!e && j && j.success === false && j.errorReason && !j.transaction) {
        ledger({ kind: 'settle_late', ok: false, nonce: p.nonce, payer: p.payer, reason: j.errorReason, tries: p.tries,
          trace: traceIds(meta), httpStatus: meta && meta.status, respHeaders: meta && meta.headers, raw: meta && meta.raw });
      } else if (Date.now() - p.firstAt > GIVE_UP_MS) {
        // Past their ~30-min reconciliation horizon with no terminal answer.
        // ALARM (never silent-drop): if funds moved, the payer is owed service.
        warn('ALARM: pending settle UNRESOLVED past ' + Math.round(GIVE_UP_MS / 60e3) + 'min, nonce ' + p.nonce + ' payer ' + p.payer + ', parked to ledger for manual review');
        ledger({ kind: 'settle_unresolved', nonce: p.nonce, payer: p.payer, tries: p.tries });
      } else {
        keep.push(p); // still ambiguous, retry next tick
      }
      // rebuild = survivors + anything settle() enqueued while this pass was in
      // flight (due was a snapshot; new rows live past its length in st.pending)
      if (--left === 0) { st.pending = keep.concat(st.pending.slice(due.length)); savePending(); }
    });
  });
}

// ---------- accepts derivation ----------
function toolAmountAtomic(usd, decimals) {
  // string math to survive 18-decimal atomic units (1e18 > 2^53)
  // MCP fix 2026-09-01 M130 claim [54]: a price under half a cent rounded to "0" + zeros (the tool advertised FREE) and a
  // non-numeric price produced "NaN000...". Both now return null and buildAccepts skips the kind, loudly.
  if (typeof usd !== 'number' || !isFinite(usd) || usd <= 0) return null;
  var cents = Math.round(usd * 100);
  if (cents < 1) return null;
  return String(cents) + '0'.repeat(decimals - 2);
}
function buildAccepts(kinds, priceUsd, quiet) {
  // quiet: per-call accepts derivation (every 402) must not re-log the skip
  // lines, they are logged once by the init probe.
  var skipLog = quiet ? function () {} : log;
  var out = [];
  (kinds || []).forEach(function (k) {
    if (!k || k.network !== st.network) return;
    // Two transfer methods are honoured: eip3009 (the token's own transferWithAuthorization)
    // and permit2-exact (any ERC-20 moved by the Permit2 contract). Both carry scheme
    // 'exact'; the real method is extra.assetTransferMethod. permit2-upto is metered
    // (settleAmount) and not handled. The buyer's signed nonce sits at a different path
    // for each (authorization.nonce vs permit2Authorization.nonce), the server replay
    // guard reads both.
    var method = String((k.extra && k.extra.assetTransferMethod) || '').toLowerCase();
    var assetName = (k.extra && k.extra.name) || '?';
    if (method !== 'eip3009' && method !== 'permit2-exact') { skipLog('kind ' + k.scheme + '/' + method + ' (' + assetName + ') not advertised (metered or unsupported method)'); return; }
    var meta = BSC_ASSETS[assetName];
    if (!meta) { skipLog('skipping unknown asset "' + assetName + '", not in verified asset table'); return; }
    var extra;
    if (method === 'eip3009') {
      if (!meta.domain) { skipLog('skipping eip3009 for "' + assetName + '", no pinned token domain'); return; }
      // buyer signs the TOKEN's own EIP-712 domain, advertise the PINNED, on-chain-
      // verified {name, version}, never the facilitator's extra, so a facilitator drift
      // cannot make buyers sign a domain the token rejects.
      extra = { name: meta.domain.name, version: meta.domain.version, assetTransferMethod: 'eip3009',
        signerAddress: (k.extra && k.extra.signerAddress) || undefined };
    } else {
      // permit2-exact: buyer signs the Permit2 contract's domain and needs the spender
      // (the Permit2 proxy) from the facilitator. No token domain is involved, so none
      // is pinned; skip if the facilitator gave no spender (can't build a valid permit).
      var spender = k.extra && k.extra.spenderAddress;
      if (!spender) { skipLog('skipping permit2-exact for "' + assetName + '", facilitator gave no spenderAddress'); return; }
      extra = { name: assetName, assetTransferMethod: 'permit2-exact', spenderAddress: spender,
        signerAddress: (k.extra && k.extra.signerAddress) || undefined };
    }
    var amount = toolAmountAtomic(priceUsd, meta.decimals);
    if (amount === null) { warn('NOT advertising ' + assetName + ': price ' + priceUsd + ' is under one cent or not a number (M130 [54])'); return; }
    out.push({ scheme: k.scheme, network: k.network, amount: amount,
      asset: meta.address, payTo: st.payTo, maxTimeoutSeconds: 60, extra: extra });
  });
  return out;
}
// per-call accepts for a given price (server.js passes the tool's USD price)
function acceptsFor(priceUsd) { return st.ready ? buildAccepts(st.kinds, priceUsd, true) : []; }

// ---------- init ----------
function init(env, opts) {
  if (String(env.X402_MULTI || '1') === '0') { log('disabled (X402_MULTI=0)'); return; }
  st.dataDir = (opts && opts.dataDir) || st.dataDir;
  if (!st.dataDir) { warn('DISABLED: no dataDir'); return; }
  st.baseUrl = (env.B402_BASE_URL || st.baseUrl).replace(/\/$/, '');
  st.network = env.B402_NETWORK_CAIP2 || st.network;
  st.payTo = env.B402_PAY_TO || (opts && opts.payTo);
  st.onLateSettle = opts && opts.onLateSettle;
  st.env = env;
  // MCP fix 2026-09-01 M130 claim [55]: payTo was never checked against the pinned allowlist that exists for exactly
  // this ("every address that receives customer money", lib/billing/_pinned_address.js). The rail stays dark unless
  // payTo equals config/payout_allowlist.json x402_payto_evm. Kill switch CHX_B402_PAYTO_PIN=0.
  if (_sw('CHX_B402_PAYTO_PIN')) {
    if (String(st.payTo || '').toLowerCase() !== OFFICIAL_PAYTO.toLowerCase()) {
      warn('DISABLED: payTo ' + st.payTo + ' is not the official payment wallet ' + OFFICIAL_PAYTO); st.payTo = null; return;
    }
  }
  try {
    loadCreds(env);
    // The key must be the pair Binance registered for this merchant; any other key gets 403 "Signature invalid".
    st.privateKey = loadKey(env);
  } catch (e) { warn('DISABLED, credentials/key load failed: ' + e.message); return; }
  if (!st.payTo) { warn('DISABLED, no payTo address'); return; }
  try { fs.mkdirSync(st.dataDir, { recursive: true }); } catch (e) {}
  try { st.pending = JSON.parse(fs.readFileSync(pendingFile(), 'utf8')) || []; } catch (e) { st.pending = []; }
  if (st.pending.length) log(st.pending.length + ' pending settle(s) reloaded, poller will reconcile');
  // MCP fix 2026-09-01 M102: the poller used to start ONLY inside the /supported success path
  // below, so with /supported failing (the header's own expected case, "key not yet registered")
  // every reloaded pending settle sat unreconciled and unalarmed while the line above said the
  // opposite. Reconciliation needs only creds + baseUrl, both loaded above, not st.ready. One
  // interval per process; the hourly re-arm of init() must not stack a second one.
  // Kill switch CHX_B402_POLL_ALWAYS=0 restores the old placement (success path only).
  if (_sw('CHX_B402_POLL_ALWAYS') && !st._pollTimer) st._pollTimer = setInterval(poll, POLL_MS).unref();
  // self-configure from the facilitator; failure = stay dark, loudly
  supported(function (e, j, status) {
    var kinds = j && (j.kinds || (j.data && j.data.kinds));
    if (e || !Array.isArray(kinds)) {
      warn('DISABLED, /supported failed (' + (e ? e.message : 'HTTP ' + status + ' ' + JSON.stringify(j).slice(0, 120)) + '). Expected until Binance registers our public key; lane stays dark, no restart needed to retry: it re-checks hourly.');
      setTimeout(function () { init(env, opts); }, 300e3).unref(); // re-arm every 5 minutes until /supported answers
      return;
    }
    st.kinds = kinds;
    var probe = buildAccepts(kinds, 0.01);
    if (!probe.length) { warn('DISABLED, /supported returned no usable ' + st.network + ' kinds (assets all unknown?)'); return; }
    st.ready = true;
    log('LIVE, ' + probe.length + ' accepts variant(s) on ' + st.network + ': ' +
      probe.map(function (a) { return a.scheme + '/' + ((BSC_ASSETS[a.extra && a.extra.name] || {}).symbol || '?'); }).join(', ') + ' → payTo ' + st.payTo);
    if (!st._pollTimer) st._pollTimer = setInterval(poll, POLL_MS).unref(); // MCP fix 2026-09-01 M102: single interval
  });
}

module.exports = {
  init: init,
  acceptsFor: acceptsFor,
  verify: verify,
  settle: settle,
  isReady: function () { return st.ready; },
  network: function () { return st.network; },
  OFFICIAL_PAYTO: OFFICIAL_PAYTO,
  assets: function () { return BSC_ASSETS; },
  _test: { sign: sign, buildAccepts: buildAccepts, toolAmountAtomic: toolAmountAtomic, st: st, loadCreds: loadCreds, settleBody: settleBody, poll: poll, request: request } // poll/request exposed 2026-09-01 for the M98/M102 harness
};
