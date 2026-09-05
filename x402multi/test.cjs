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
  console.log('[x402multi-test] pass ' + ok + ' fail ' + fail);
  process.exit(fail ? 1 : 0);
})();
