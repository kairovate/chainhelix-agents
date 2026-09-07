'use strict';
// shared/directory.cjs: THE ONE client for the ERC-8004 directory (8004scan), 2026-09-07 (build plan B3).
// Before this file the marketplace (src/scan.js, src/verify.js) and the ChainHelix MCP (lib/agent_tools.js) each read
// the directory with their own transport and each learnt its failures separately: the 500 with a JSON body that read
// as "0 matches" (MCP, 2026-09-05), the www to apex 308 refused by the origin guard (marketplace, 2026-09-05), the
// Pro key header (marketplace only), the private-address refusal and the resolved-address pin (MCP only), the
// per-key retry window (marketplace only). One client now carries every rule for both products:
//   transport   https only (a local http server only with local:true, tests), literal IPs and single-label hosts
//               refused, the host resolved once and refused when any address is private, loopback, link-local or
//               CGNAT, the socket opened to the address that passed (M119; DIRECTORY_PIN_RESOLVED_IP=0 or
//               CHX_PIN_RESOLVED_IP=0 turns the pin off), one timeout for the whole request, body capped.
//   redirects   followed by hand, at most maxRedirects hops; every hop must keep the scheme and the port and stay in
//               the configured host family (www.<host> and <host> are one family); every hop is resolved and
//               checked again.
//   key header  SCAN_API_KEY (name SCAN_API_KEY_HEADER, default x-api-key), read at call time, sent ONLY to a url in
//               the directory's own host family. No key set: no header. Neither product has a key today.
//   listing     a directory answer counts only when it is HTTP 200, a JSON object, success is not false and items is
//               an array; anything else throws a DirectoryError the caller turns into its own fallback.
//   hold        after a failed listing the client answers "held" at once for holdMs (default 60 s, the marketplace
//               retry window) instead of waiting for the timeout again; a success clears it. DIRECTORY_HOLD_MS
//               overrides, 0 turns it off (the enumerator has its own retry ladder and runs with holdMs 0).
// Each product's last-good store stays where it is (the MCP's per-query map, the marketplace's memory cache and
// discovery disk copy): their answer shapes differ; the transport and the rules above do not.
// createDirectory({ apiBase, site, chainSlug, chainId, timeoutMs, maxBytes, maxRedirects, holdMs, pinResolvedIp,
//                   keyEnv, keyHeaderEnv, keyHeaderDefault, userAgent, name, local, lookup })
var https = require('https');
var http = require('http');
var dns = require('dns');

var DEFAULT_API = 'https://8004scan.io/api/v1'; // the www host answers 308 to this; the bare host is canonical
var DEFAULT_SITE = 'https://8004scan.io';

function DirectoryError(kind, message, extra) {
  var e = new Error(message);
  e.name = 'DirectoryError'; e.directory = true; e.kind = kind;
  if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
  return e;
}

function privateIp(ip) {
  var p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(function (n) { return !Number.isInteger(n) || n < 0 || n > 255; })) return true; // IPv6 or garbage: refuse
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
function hostFamily(h) { return String(h || '').toLowerCase().replace(/^www\./, ''); }
// the www and apex twins of one host are one origin; any other host, another port or a scheme change is not
function sameOrigin(url, base) {
  try {
    var u = new URL(url), c = new URL(base);
    return u.protocol === c.protocol && u.port === c.port && hostFamily(u.hostname) === hostFamily(c.hostname);
  } catch (e) { return false; }
}

function createDirectory(cfg) {
  cfg = cfg || {};
  var apiBase = String(cfg.apiBase || process.env.SCAN_API || DEFAULT_API).replace(/\/+$/, '');
  var site = String(cfg.site || DEFAULT_SITE).replace(/\/+$/, '');
  var chainSlug = cfg.chainSlug || 'bsc';
  var chainId = cfg.chainId != null ? Number(cfg.chainId) : 56;
  var timeoutMs = cfg.timeoutMs > 0 ? cfg.timeoutMs : 10000;
  var maxBytes = cfg.maxBytes > 0 ? cfg.maxBytes : 1048576;
  var maxRedirects = cfg.maxRedirects != null ? cfg.maxRedirects : 3;
  var holdMs = cfg.holdMs != null ? Number(cfg.holdMs) : (process.env.DIRECTORY_HOLD_MS != null ? Number(process.env.DIRECTORY_HOLD_MS) : 60000);
  if (!(holdMs >= 0)) holdMs = 0;
  var keyEnv = cfg.keyEnv || 'SCAN_API_KEY', keyHeaderEnv = cfg.keyHeaderEnv || 'SCAN_API_KEY_HEADER', keyHeaderDefault = cfg.keyHeaderDefault || 'x-api-key';
  var userAgent = cfg.userAgent || 'ChainHelix/1.0 (+https://agents.chainhelix.io)';
  var name = cfg.name || 'directory';
  var local = cfg.local === true; // tests only: http and private addresses allowed
  var lookup = cfg.lookup || dns.lookup;
  function pinOn() {
    if (cfg.pinResolvedIp != null) return !!cfg.pinResolvedIp;
    if (process.env.DIRECTORY_PIN_RESOLVED_IP === '0') return false;
    return String(process.env.CHX_PIN_RESOLVED_IP || '1') !== '0';
  }
  var hold = { until: 0, reason: null, since: 0 };

  function headers(url) {
    var h = { Accept: 'application/json', 'User-Agent': userAgent };
    var key = process.env[keyEnv] || cfg.key || '';
    if (!key) return h;
    var hn = process.env[keyHeaderEnv] || keyHeaderDefault;
    try { if (hostFamily(new URL(url).hostname) === hostFamily(new URL(apiBase).hostname)) h[hn] = key; } catch (e) { /* not a url */ }
    return h;
  }
  function agentUrl(id) { return site + '/agents/' + chainSlug + '/' + Number(id); }

  // one hop: resolve, check, connect to the checked address, read a capped body. Resolves { status, headers, text }.
  function hop(urlStr, deadline) {
    return new Promise(function (resolve, reject) {
      var u; try { u = new URL(urlStr); } catch (e) { return reject(DirectoryError('refused', name + ': bad url')); }
      var secure = u.protocol === 'https:';
      if (!secure && !(local && u.protocol === 'http:')) return reject(DirectoryError('refused', name + ': endpoint must be https'));
      if (!local && (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.indexOf(':') !== -1 || u.hostname.indexOf('.') === -1)) return reject(DirectoryError('refused', name + ': endpoint host not allowed'));
      var left = deadline - Date.now();
      if (left <= 0) return reject(DirectoryError('timeout', name + ': timeout'));
      lookup(u.hostname, { all: true }, function (err, addrs) {
        if (err || !addrs || !addrs.length) return reject(DirectoryError('resolve', name + ': endpoint does not resolve'));
        var v4 = addrs.filter(function (a) { return a.family === 4; });
        if (!v4.length) return reject(DirectoryError('resolve', name + ': endpoint has no IPv4 address'));
        if (!local && v4.some(function (a) { return privateIp(a.address); })) return reject(DirectoryError('private', name + ': endpoint resolves to a private address'));
        var mod = secure ? https : http;
        var port = u.port ? Number(u.port) : (secure ? 443 : 80);
        var pin = pinOn();
        var reqOpts = { host: pin ? v4[0].address : u.hostname, port: port, path: u.pathname + u.search, method: 'GET', headers: Object.assign({ Host: u.host }, headers(urlStr)), timeout: Math.max(1, deadline - Date.now()) };
        if (secure) reqOpts.servername = u.hostname;
        var done = false, hard = null, req;
        function finish(fn) { if (done) return; done = true; if (hard) clearTimeout(hard); fn(); }
        // sweep 2026-09-07 (S2): this callback runs outside the promise executor, so a synchronous throw from request()
        // (a header value with an illegal character, from the env) would have been an uncaught exception in the process
        try { req = mod.request(reqOpts, onResponse); } catch (e) { return finish(function () { reject(DirectoryError('refused', name + ': request could not be built (' + (e && e.message) + ')')); }); }
        function onResponse(res) {
          var chunks = [], size = 0;
          res.on('data', function (c) { size += c.length; if (size > maxBytes) { req.destroy(); finish(function () { reject(DirectoryError('too_large', name + ': response too large')); }); } else chunks.push(c); });
          res.on('end', function () { finish(function () { resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }); }); });
          res.on('error', function () { finish(function () { reject(DirectoryError('transport', name + ': request failed')); }); });
        }
        // the socket timeout covers idle time only; the hard timer is the one deadline for the whole request
        hard = setTimeout(function () { req.destroy(); finish(function () { reject(DirectoryError('timeout', name + ': timeout')); }); }, Math.max(1, deadline - Date.now()));
        req.on('error', function () { finish(function () { reject(DirectoryError('transport', name + ': request failed')); }); });
        req.on('timeout', function () { req.destroy(); finish(function () { reject(DirectoryError('timeout', name + ': timeout')); }); });
        req.end();
      });
    });
  }

  // GET one directory path with the redirect guard. Resolves { status, json, text }; throws DirectoryError on a
  // refused url, a refused hop, a transport failure, a timeout or an oversized body. HTTP status is the caller's.
  async function fetchJson(path, opts) {
    opts = opts || {};
    var deadline = Date.now() + (opts.timeoutMs > 0 ? opts.timeoutMs : timeoutMs);
    var current = /^https?:\/\//i.test(path) ? path : apiBase + (path.charAt(0) === '/' ? '' : '/') + path;
    if (!sameOrigin(current, apiBase)) throw DirectoryError('refused', name + ': url is not on the directory origin');
    for (var i = 0; i <= maxRedirects; i++) {
      var r = await hop(current, deadline);
      if (r.status >= 300 && r.status < 400) {
        var loc = r.headers && r.headers.location;
        if (!loc) throw DirectoryError('redirect', name + ': redirect without location', { status: r.status });
        current = new URL(loc, current).href;
        if (!sameOrigin(current, apiBase)) throw DirectoryError('redirect', name + ': redirect to disallowed host', { status: r.status, location: current });
        continue;
      }
      var j = null; try { j = JSON.parse(r.text); } catch (e) { j = null; }
      return { status: r.status, json: j, text: r.text.slice(0, 300) };
    }
    throw DirectoryError('redirect', name + ': too many redirects');
  }

  function heldFor() { return hold.until > Date.now() ? hold.until - Date.now() : 0; }
  function clearHold() { hold.until = 0; hold.reason = null; hold.since = 0; }
  function setHold(reason) { if (holdMs > 0) { hold.until = Date.now() + holdMs; hold.reason = reason; hold.since = Date.now(); } }

  // a listing answer: HTTP 200, a JSON object, success not false, items an array. Anything else is a failure
  // (the 2026-09-05 lesson: the directory's DATABASE_ERROR is a 500 with a JSON body, and an empty items array
  // on a 200 is a real "no matches"). A failure arms the hold; a success clears it.
  async function listing(path, opts) {
    opts = opts || {};
    var h = heldFor();
    if (h > 0 && !opts.ignoreHold) throw DirectoryError('held', name + ': held after ' + hold.reason + ', retry in ' + Math.ceil(h / 1000) + ' s', { retryInMs: h, reason: hold.reason });
    var r;
    try { r = await fetchJson(path, opts); }
    catch (e) { setHold(e.kind || 'failure'); throw e; }
    if (r.status !== 200) { var code = r.json && r.json.error && (r.json.error.code || r.json.error.message); setHold('HTTP ' + r.status); throw DirectoryError('http', name + ': HTTP ' + r.status + (code ? ' ' + code : ''), { status: r.status, body: r.text }); }
    if (!r.json || typeof r.json !== 'object' || r.json.success === false || !Array.isArray(r.json.items)) { setHold('bad body'); throw DirectoryError('body', name + ': answer without an items array', { status: r.status, body: r.text }); }
    clearHold();
    return r.json;
  }
  function search(query, opts) {
    opts = opts || {};
    var lim = opts.limit > 0 ? Math.floor(opts.limit) : 20;
    var p = '/agents?limit=' + lim + '&chain_id=' + chainId + '&search=' + encodeURIComponent(String(query));
    if (opts.offset > 0) p += '&offset=' + Math.floor(opts.offset);
    return listing(p, opts);
  }
  function page(offset, limit, opts) {
    return listing('/agents?limit=' + (limit > 0 ? Math.floor(limit) : 100) + '&chain_id=' + chainId + '&offset=' + (offset > 0 ? Math.floor(offset) : 0), opts);
  }

  return { apiBase: apiBase, site: site, chainId: chainId, chainSlug: chainSlug, name: name, timeoutMs: timeoutMs, maxBytes: maxBytes, holdMs: holdMs,
    headers: headers, agentUrl: agentUrl, sameOrigin: function (url, base) { return sameOrigin(url, base || apiBase); },
    fetchJson: fetchJson, listing: listing, search: search, page: page, heldFor: heldFor, clearHold: clearHold, hold: hold };
}

module.exports = { createDirectory: createDirectory, sameOrigin: sameOrigin, hostFamily: hostFamily, privateIp: privateIp, DirectoryError: DirectoryError, DEFAULT_API: DEFAULT_API, DEFAULT_SITE: DEFAULT_SITE };
