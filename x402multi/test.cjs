'use strict';
// x402multi tests (2026-09-05): the handler against a stub lane that answers like Binance's facilitator would, so the
// terms, the matching, the pay-us check, verify, settle, the owed redemption and the replay guard are exercised with
// no network and no money. Run: node x402multi/test.cjs
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var real = require('./b402.cjs');
var PAYTO = real.OFFICIAL_PAYTO;
// the kinds Binance's /supported returns for BSC, as the MCP has seen them live
var KINDS = [
  { x402Version: 2, scheme: 'exact', network: 'eip155:56', extra: { name: 'United Stables', version: '1', assetTransferMethod: 'eip3009', signerAddress: '0x34F7a661160780Ce1346e6D7B96D2bE244590899' } },
  { x402Version: 2, scheme: 'exact', network: 'eip155:56', extra: { name: 'United Stables', version: '1', assetTransferMethod: 'permit2-exact', spenderAddress: '0x000000000022D473030F116dDEE9F6B43aC78BA3', signerAddress: '0x34F7' } },
  { x402Version: 2, scheme: 'exact', network: 'eip155:56', extra: { name: 'World Liberty Financial USD', version: '1', assetTransferMethod: 'eip3009', signerAddress: '0x34F7' } },
  { x402Version: 2, scheme: 'exact', network: 'eip155:56', extra: { name: 'World Liberty Financial USD', version: '1', assetTransferMethod: 'permit2-exact', spenderAddress: '0x000000000022D473030F116dDEE9F6B43aC78BA3' } },
  { x402Version: 2, scheme: 'exact', network: 'eip155:56', extra: { name: 'Tether USD', assetTransferMethod: 'permit2-exact', spenderAddress: '0x000000000022D473030F116dDEE9F6B43aC78BA3' } },
  { x402Version: 2, scheme: 'exact', network: 'eip155:56', extra: { name: 'USD Coin', assetTransferMethod: 'permit2-exact', spenderAddress: '0x000000000022D473030F116dDEE9F6B43aC78BA3' } },
  { x402Version: 2, scheme: 'exact', network: 'eip155:56', extra: { name: 'Tether USD', assetTransferMethod: 'permit2-upto' } },
];
real._test.st.payTo = PAYTO; real._test.st.network = 'eip155:56'; real._test.st.kinds = KINDS; real._test.st.ready = true;
var calls = { verify: 0, settle: 0 }, mode = { verify: true, settle: 'ok' };
var lane = {
  init: function () {}, isReady: function () { return true; }, network: function () { return 'eip155:56'; }, assets: real.assets,
  acceptsFor: function (usd) { return real._test.buildAccepts(KINDS, usd, true); },
  verify: function (payload, reqs, cb) { calls.verify++; cb(mode.verify, null); },
  settle: function (payload, reqs, nonce, payer, cb) { calls.settle++; if (mode.settle === 'ok') cb(true, '0xtx' + nonce, false); else if (mode.settle === 'pending') cb(false, null, true, 'pending'); else cb(false, null, false, 'insufficient_funds'); },
};
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402multi-'));
var work = { fail: false, n: 0 };
var { createMultiSeller } = require('./seller.cjs');
var seller = createMultiSeller({ lane: lane, env: {}, priceUsd: 0.5, payTo: PAYTO, resourceUrl: 'https://agents.chainhelix.io/gridtrader/x402', description: 'grid plan', dataDir: dir, log: function () {},
  runWork: async function (a) { work.n++; if (work.fail) throw new Error('boom'); return { ok: true, prompt: a.prompt, payer: a.payer }; } });
var PAYER = '0x9d16bb4b2ed89aafc8390998ed2d3254af6e513b';
function header(asset, method, opts) {
  opts = opts || {};
  var nonce = opts.nonce || ('0x' + String(Math.random()).slice(2).padEnd(64, '0'));
  var p = { x402Version: 2, scheme: 'exact', network: 'eip155:56', accepted: { scheme: 'exact', network: 'eip155:56', asset: asset }, payload: {} };
  var amt = opts.amount || '500000000000000000';
  if (method === 'eip3009') p.payload.authorization = { from: PAYER, to: opts.to || PAYTO, value: amt, nonce: nonce };
  else p.payload.permit2Authorization = { from: PAYER, permitted: { token: asset, amount: amt }, nonce: nonce, witness: { to: opts.to || PAYTO } };
  return { hdr: Buffer.from(JSON.stringify(p)).toString('base64'), nonce: nonce };
}
var req = function (hdr, body) { return { method: 'POST', path: '/x402', query: {}, headers: hdr ? { 'payment-signature': hdr } : {}, body: body }; };
var ok = 0, fail = 0; function check(name, cond) { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (cond) ok++; else fail++; }
(async function () {
  var t = await seller.handle(req(null, '{}'));
  var body = JSON.parse(t.body);
  check('no payment: 402 with terms and the payment-required header', t.status === 402 && t.headers['payment-required'] && body.x402Version === 2);
  var symbols = body.accepts.map(function (a) { return (real.assets()[a.extra.name] || {}).symbol + '/' + a.extra.assetTransferMethod; }).sort().join(' ');
  check('terms offer the MCP set: U, USD1 (both methods), USDT, USDC (permit2)', symbols === 'U/eip3009 U/permit2-exact USD1/eip3009 USD1/permit2-exact USDC/permit2-exact USDT/permit2-exact');
  check('every entry pays the official wallet 0.5 in 18 decimals', body.accepts.every(function (a) { return a.payTo === PAYTO && a.amount === '500000000000000000'; }));
  var usdt = real.assets()['Tether USD'].address;
  var h = header(usdt, 'permit2-exact');
  var r = await seller.handle(req(h.hdr, JSON.stringify({ price: 600, budgetUsd: 1000 })));
  var rb = JSON.parse(r.body);
  check('USDT permit2 payment: verified, settled, work run, 200 with the receipt header', r.status === 200 && calls.verify === 1 && calls.settle === 1 && rb.result.ok === true && r.headers['PAYMENT-RESPONSE']);
  check('a JSON object body is the job spec, sent whole as the prompt', rb.result.prompt === '{"price":600,"budgetUsd":1000}' && rb.result.payer === PAYER);
  var r2 = await seller.handle(req(h.hdr, '{"price":600}'));
  check('same header again: served from the cache, no second verify or settle or work', r2.status === 200 && calls.verify === 1 && calls.settle === 1 && work.n === 1);
  var usdc = real.assets()['USD Coin'].address;
  var under = header(usdc, 'permit2-exact', { amount: '400000000000000000' });
  var ru = await seller.handle(req(under.hdr, '{"a":1}'));
  check('underpayment refused before the facilitator', ru.status === 402 && calls.verify === 1);
  var wrongTo = header(usdc, 'permit2-exact', { to: PAYER });
  var rw = await seller.handle(req(wrongTo.hdr, '{"a":1}'));
  check('payment to another recipient refused before the facilitator', rw.status === 402 && calls.verify === 1);
  var u = real.assets()['United Stables'].address;
  var eip = header(u, 'eip3009');
  mode.verify = false;
  var rv = await seller.handle(req(eip.hdr, '{"a":1}'));
  check('facilitator verify rejection: 402, no settle', rv.status === 402 && calls.settle === 1);
  mode.verify = true; mode.settle = 'pending';
  var pend = header(u, 'eip3009');
  var rp = await seller.handle(req(pend.hdr, '{"a":1}'));
  check('pending settle: 402 that says retry the same header, no work run', rp.status === 402 && /SAME payment header/.test(JSON.parse(rp.body).error) && work.n === 1);
  mode.settle = 'ok'; work.fail = true;
  var owed = header(u, 'eip3009');
  var ro = await seller.handle(req(owed.hdr, '{"a":1}'));
  check('work fails after settlement: 500 with the receipt, nonce owed', ro.status === 500 && ro.headers['PAYMENT-RESPONSE'] && seller._test.settled[owed.nonce].status === 'owed');
  work.fail = false;
  var settlesBefore = calls.settle;
  var rr = await seller.handle(req(owed.hdr, '{"a":1}'));
  check('same header redeems the owed call: work runs, no second charge', rr.status === 200 && calls.settle === settlesBefore && seller._test.settled[owed.nonce].status === 'done');
  var usd1 = real.assets()['World Liberty Financial USD'].address;
  var r1 = await seller.handle(req(header(usd1, 'eip3009').hdr, '{"prompt":"a spec"}'));
  check('USD1 eip3009 payment served; {"prompt"} body honoured', r1.status === 200 && JSON.parse(r1.body).result.prompt === 'a spec');
  var noBody = await seller.handle(req(header(u, 'eip3009').hdr, ''));
  check('paid request without a job spec: 400, nothing charged', noBody.status === 400);
  var state = JSON.parse(fs.readFileSync(path.join(dir, 'paystate.json'), 'utf8'));
  check('state persisted to disk with the served nonces', state.settled[h.nonce].status === 'done' && state.settled[owed.nonce].status === 'done');
  // ---- sweep 2026-09-07 (S5): nonce required and bounded; one run per payment under concurrent duplicates ----
  var vb = calls.verify, sb = calls.settle, wb = work.n;
  var nn = header(usdt, 'permit2-exact'); var pj = JSON.parse(Buffer.from(nn.hdr, 'base64').toString('utf8')); delete pj.payload.permit2Authorization.nonce;
  var rn = await seller.handle(req(Buffer.from(JSON.stringify(pj)).toString('base64'), '{"a":1}'));
  check('S5: a payment without a nonce is refused before verify (402), nothing charged', rn.status === 402 && JSON.parse(rn.body).error.indexOf('nonce') !== -1 && calls.verify === vb && calls.settle === sb);
  var big = header(usdt, 'permit2-exact', { nonce: '0x' + 'f'.repeat(300) });
  var rbg = await seller.handle(req(big.hdr, '{"a":1}'));
  check('S5: an oversized nonce is refused the same way', rbg.status === 402 && calls.verify === vb);
  var dup = header(usdt, 'permit2-exact');
  var both = await Promise.all([seller.handle(req(dup.hdr, '{"a":1}')), seller.handle(req(dup.hdr, '{"a":1}'))]);
  var codes = both.map(function (x) { return x.status; }).sort().join(',');
  check('S5: the same header twice at once: one served, one 409, one settle, one run of the work (' + codes + ')', codes === '200,409' && calls.settle === sb + 1 && work.n === wb + 1);
  var again = await seller.handle(req(dup.hdr, '{"a":1}'));
  check('S5: after the run the same header is served from the cache', again.status === 200 && work.n === wb + 1);
  console.log('[x402multi-test] pass ' + ok + ' fail ' + fail);
  process.exitCode = fail ? 1 : 0; // the proxy block below finishes on its own timer and closes its stub server
  setTimeout(function () { console.log('[x402multi-test] timed out waiting for the proxy block'); process.exit(1); }, 5000).unref();
})();

// ---- B1 (2026-09-07): the shared redemption store and the shared lane's init options, no network ----
(function () {
  var { createRedemptionStore } = require('./redemption.cjs');
  var d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'x402multi-store-'));
  var f2 = path.join(d2, 'state.json');
  var s = createRedemptionStore({ file: f2, log: function () {} });
  s.remember('n1', { status: 'owed', bind: 'bind-1', payer: PAYER });
  s.remember('n1', { status: 'done', envelope: { a: 1 } });
  check('store: an owed -> done update without a bind keeps the bind of the settled payment', s.get('n1').bind === 'bind-1' && s.get('n1').status === 'done');
  s.get('n1').at = Date.now() - 25 * 3600e3;
  s.prune();
  check('store: past 24h a served nonce is tombstoned used, the answer dropped, the bind kept', s.get('n1').status === 'used' && s.get('n1').envelope === undefined && s.get('n1').bind === 'bind-1');
  s.remember('n2', { status: 'owed', bind: 'b2' }); s.get('n2').at = Date.now() - 31 * 24 * 3600e3; s.prune();
  check('store: past 30 days the record is dropped (the on-chain nonce is single use by then)', s.get('n2') === undefined);
  s.markUsed('n3'); s.used.n3 = Date.now() - 2 * 3600e3; s.prune();
  check('store: replay telemetry is forgotten after an hour', s.used.n3 === undefined);
  var s2 = createRedemptionStore({ file: f2, log: function () {} });
  check('store: a restart reloads the tombstone from disk (the replay guard survives)', s2.get('n1') && s2.get('n1').status === 'used' && s2.get('n1').bind === 'bind-1');
  var old = path.join(d2, 'old.json'); fs.writeFileSync(old, JSON.stringify({ settled: { k1: { status: 'owed', at: Date.now(), payer: PAYER } } }));
  var s3 = createRedemptionStore({ file: old, log: function () {} });
  check('store: the agents\' pre-B1 { settled } file loads as it is', s3.get('k1') && s3.get('k1').status === 'owed' && s3.counts().owed === 1);
  // sweep 2026-09-07 (S4): a corrupt file is reported, a malformed record is skipped on its own, prototype keys are never loaded
  var bad = path.join(d2, 'bad.json'); fs.writeFileSync(bad, '{not json');
  var logged = []; var s4 = createRedemptionStore({ file: bad, log: function (m) { logged.push(m); } });
  check('store: an unreadable state file is logged, not passed off as a first boot', logged.some(function (m) { return m.indexOf('UNREADABLE') !== -1; }) && s4.counts().settled === 0);
  var mixed = path.join(d2, 'mixed.json'); fs.writeFileSync(mixed, '{"settled":{"good":{"status":"owed","at":' + Date.now() + '},"junk":7,"__proto__":{"status":"owed","at":' + Date.now() + '}},"used":{"__proto__":' + Date.now() + ',"x":"str"}}');
  logged = []; var s5 = createRedemptionStore({ file: mixed, log: function (m) { logged.push(m); } });
  check('store: the good record loads, the malformed one and the prototype keys are skipped and counted', s5.get('good') && s5.get('good').status === 'owed' && s5.counts().settled === 1 && Object.keys(s5.used).length === 0 && logged.some(function (m) { return /3 malformed/.test(m); }) && !Object.prototype.hasOwnProperty.call(Object.prototype, 'status'));
  // lane init options
  var creds = path.join(d2, 'creds.txt'); fs.writeFileSync(creds, 'clientId: cid-from-file\naccessToken: tok-from-file\n');
  real._test.loadCreds({}, creds);
  check('lane: with no env credentials the caller\'s credentials file is read', real._test.st.clientId === 'cid-from-file' && real._test.st.accessToken === 'tok-from-file');
  real._test.loadCreds({ B402_CLIENT_ID: 'cid-env', B402_ACCESS_TOKEN: 'tok-env' }, creds);
  check('lane: env credentials win over the file', real._test.st.clientId === 'cid-env');
  var threw = false; try { real._test.loadCreds({}, null); } catch (e) { threw = true; }
  check('lane: no env and no file named (the agents) throws, the lane stays dark', threw);
  var keyf = path.join(d2, 'key.pem'); fs.writeFileSync(keyf, 'PEMKEY');
  check('lane: the caller\'s default key path is used when the env names no key', real._test.loadKey({}, keyf) === 'PEMKEY');
  check('lane: a base64 key in the env wins over the path', real._test.loadKey({ B402_PRIVATE_KEY_B64: Buffer.from('ENVKEY').toString('base64') }, keyf) === 'ENVKEY');
  var allow = path.join(d2, 'allow.json'); fs.writeFileSync(allow, JSON.stringify({ x402_payto_evm: '0x0000000000000000000000000000000000000001' }));
  var st0 = real._test.st, keep = { payTo: st0.payTo, dataDir: st0.dataDir, ready: st0.ready };
  real.init({}, { enabled: true, dataDir: d2, payTo: PAYTO, allowlistFile: allow, logPrefix: '[test] ' });
  check('lane: payTo equal to the constant but not to the allowlist file is refused (the MCP\'s pin)', st0.payTo === null);
  real.init({}, { enabled: false, dataDir: d2, payTo: PAYTO });
  check('lane: enabled:false leaves the lane dark before any credential is read', st0.payTo === null);
  st0.payTo = keep.payTo; st0.dataDir = keep.dataDir; st0.ready = keep.ready;
  // ---- sweep 2026-09-07 (merchant credentials, one root-only copy): proxy mode of the lane ----
  var keepP = { proxyUrl: st0.proxyUrl, proxyToken: st0.proxyToken, clientId: st0.clientId, accessToken: st0.accessToken, privateKey: st0.privateKey, baseUrl: st0.baseUrl };
  real.init({ B402_PROXY_URL: 'http://10.0.0.5:5020', B402_PROXY_TOKEN: 't' }, { enabled: true, dataDir: d2, payTo: PAYTO, logPrefix: '[test] ' });
  check('proxy: a proxy url off loopback is refused, the credentials loaded before are untouched', st0.proxyUrl === null && st0.clientId === keepP.clientId);
  real.init({ B402_PROXY_URL: 'http://127.0.0.1:5020' }, { enabled: true, dataDir: d2, payTo: PAYTO, logPrefix: '[test] ' });
  check('proxy: a proxy url without a token is refused', st0.proxyUrl === null && st0.clientId === keepP.clientId);
  var hits = [];
  var stub = require('http').createServer(function (rq, rs) { var b = ''; rq.on('data', function (c) { b += c; }); rq.on('end', function () { hits.push({ url: rq.url, token: rq.headers['x-b402-proxy-token'], signed: !!rq.headers['x-tesla-signature'], body: b }); rs.setHeader('content-type', 'application/json'); rs.statusCode = 200; rs.end(JSON.stringify({ kinds: [] })); }); });
  stub.listen(0, '127.0.0.1', function () {
    var url = 'http://127.0.0.1:' + stub.address().port;
    real.init({ B402_PROXY_URL: url, B402_PROXY_TOKEN: 'tok-123' }, { enabled: true, dataDir: d2, payTo: PAYTO, logPrefix: '[test] ', rearmMs: 3600e3 });
    check('proxy: with a loopback url and a token the lane needs no credential and holds none', st0.proxyUrl === url && st0.clientId === null && st0.privateKey === null);
    setTimeout(function () {
      var h = hits[0];
      check('proxy: the /supported probe went to the proxy, unsigned, with the token', !!h && h.url === '/papi/v2/b402/supported' && h.token === 'tok-123' && h.signed === false);
      real.rawRequest('/papi/v2/b402/verify', { a: 1 }, function (e, j, status) {
        check('proxy: rawRequest forwards a body through the proxy and returns the answer', !e && status === 200 && hits[1].body === '{"a":1}');
        stub.close();
        st0.proxyUrl = keepP.proxyUrl; st0.proxyToken = keepP.proxyToken; st0.clientId = keepP.clientId; st0.accessToken = keepP.accessToken; st0.privateKey = keepP.privateKey; st0.baseUrl = keepP.baseUrl; st0.ready = keep.ready;
        console.log('[x402multi-test] proxy pass ' + ok + ' fail ' + fail);
        if (fail) process.exitCode = 1;
      });
    }, 150);
  });
  console.log('[x402multi-test] B1 pass ' + ok + ' fail ' + fail);
  if (fail) process.exitCode = 1;
})();
