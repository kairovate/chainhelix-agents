'use strict';
// x402multi/redemption.cjs: THE ONE redemption and replay store for both products, 2026-09-07 (build plan B1).
// Until 2026-09-07 the ChainHelix MCP kept this logic inline in mcp/server.js (settledResults, usedPayments,
// cacheSettled, savePayState, the ten-minute pruner) and the agents' seller.cjs kept its own copy with a different
// tombstone rule. This module is the single implementation. The contract, the same the 402 terms advertise:
//   owed   settled, not yet served (work failed, or a late settle confirmed): the same header redeems it, no charge
//   done   served: the same header returns the cached answer, no charge
//   used   the 24 hour redemption window closed: the same header is refused, never re-settled (replay guard)
// A record keeps its `bind` (the MCP's F1 binding of the entry to the signed payment) across every transition, so a
// bare nonce can never redeem. Past NONCE_GUARD_TTL_MS the record is dropped: the on-chain nonce is single use by then.
// `used` (the map, not the status) is write-only replay telemetry kept for REPLAY_TELEMETRY_TTL_MS.
// File shape, unchanged from the MCP's: { used: { nonce: at }, settled: { nonce: record } }. The agents' older
// { settled } files load as they are.
var fs = require('fs');

var REDEMPTION_TTL_MS = 24 * 3600e3;
var NONCE_GUARD_TTL_MS = 30 * 24 * 3600e3;
var REPLAY_TELEMETRY_TTL_MS = 3600e3;

function createRedemptionStore(opts) {
  opts = opts || {};
  var file = opts.file;
  var log = opts.log || function (m) { console.log('[redemption] ' + m); };
  var redemptionTtl = opts.redemptionTtlMs || REDEMPTION_TTL_MS;
  var guardTtl = opts.nonceGuardTtlMs || NONCE_GUARD_TTL_MS;
  var telemetryTtl = opts.replayTelemetryTtlMs || REPLAY_TELEMETRY_TTL_MS;
  var settled = {}, used = {};
  // LOAD RUNS BEFORE ANY SAVE CAN (2026-08-12 restart-bleed rule): a boot-time save would clobber the owed entries
  // this store exists to protect.
  // sweep 2026-09-07 (S4): a file that exists but does not parse, or one malformed record, used to drop the WHOLE state
  // without a word ("first boot"), owed records included. A missing file is the first boot; anything else is logged, and
  // a malformed record is skipped on its own. Keys that would touch the prototype are never accepted from disk.
  var raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { raw = null; }
  if (raw !== null) {
    var saved = null;
    try { saved = JSON.parse(raw); } catch (e) { log('STATE FILE UNREADABLE (' + file + '): ' + e.message + '; starting with an empty store, the file is left in place'); }
    if (saved && typeof saved === 'object') {
      var now = Date.now(), skipped = 0;
      Object.keys(saved.used || {}).forEach(function (k) { if (k === '__proto__' || k === 'constructor' || k === 'prototype') { skipped++; return; } var t = saved.used[k]; if (typeof t === 'number' && now - t < telemetryTtl) used[k] = t; });
      Object.keys(saved.settled || {}).forEach(function (k) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') { skipped++; return; }
        var r = saved.settled[k];
        if (!r || typeof r !== 'object') { skipped++; return; }
        if (now - (r.at || 0) < guardTtl) settled[k] = r;
      });
      if (skipped) log(skipped + ' malformed record(s) skipped while loading ' + file);
    }
  }
  function save() {
    if (!file) return;
    try { fs.writeFileSync(file + '.tmp', JSON.stringify({ used: used, settled: settled })); fs.renameSync(file + '.tmp', file); }
    catch (e) { log('state save failed: ' + e.message); }
  }
  function get(nonce) { return nonce ? settled[nonce] : undefined; }
  // rec: { status, bind?, envelope? | body?, tx?, net?/network?, payer? }. The bind of an existing record is kept
  // when the update omits it, so an owed -> done transition stays bound to the payment that settled it.
  function remember(nonce, rec) {
    if (!nonce || !rec) return;
    rec.at = Date.now();
    if (rec.bind == null && settled[nonce] && settled[nonce].bind) rec.bind = settled[nonce].bind;
    settled[nonce] = rec;
    save();
  }
  function markUsed(nonce) { if (!nonce) return; used[nonce] = Date.now(); save(); }
  function prune() {
    var now = Date.now(), changed = 0;
    Object.keys(used).forEach(function (k) { if (now - used[k] > telemetryTtl) { delete used[k]; changed++; } });
    Object.keys(settled).forEach(function (k) {
      var e = settled[k], age = now - (e.at || 0);
      if (age > guardTtl) { delete settled[k]; changed++; }
      else if (age > redemptionTtl && e.status !== 'used') {
        // the redemption window closed: tombstone, drop the answer, keep the guard, the bind and the receipt facts
        settled[k] = { status: 'used', at: e.at, bind: e.bind, payer: e.payer, tx: e.tx, net: e.net, network: e.network };
        changed++;
      }
    });
    if (changed) save();
    return changed;
  }
  function counts() {
    var owed = 0, done = 0, usedN = 0;
    Object.keys(settled).forEach(function (k) { var s = settled[k].status; if (s === 'owed') owed++; else if (s === 'done') done++; else if (s === 'used') usedN++; });
    return { settled: Object.keys(settled).length, owed: owed, done: done, used: usedN, telemetry: Object.keys(used).length };
  }
  var timer = null;
  function startPruner(intervalMs) { if (!timer) timer = setInterval(prune, intervalMs || 600e3).unref(); return timer; }
  return { get: get, remember: remember, markUsed: markUsed, prune: prune, save: save, counts: counts, startPruner: startPruner,
    settled: settled, used: used, file: file, ttl: { redemption: redemptionTtl, guard: guardTtl, telemetry: telemetryTtl } };
}

module.exports = { createRedemptionStore: createRedemptionStore, REDEMPTION_TTL_MS: REDEMPTION_TTL_MS, NONCE_GUARD_TTL_MS: NONCE_GUARD_TTL_MS, REPLAY_TELEMETRY_TTL_MS: REPLAY_TELEMETRY_TTL_MS };
