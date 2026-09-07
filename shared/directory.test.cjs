'use strict';
// shared/directory.test.cjs (2026-09-07, B3): the shared directory client against a local server. Run: node --test shared/
var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');
var { createDirectory, sameOrigin, privateIp } = require('./directory.cjs');

var OK = JSON.stringify({ success: true, total: 2, items: [{ token_id: '7', name: 'grid bot' }, { token_id: '9', name: 'yield bot' }] });
var mode = 'ok', seen = [];
var S, S2, base;
function serve() {
  return new Promise(function (resolve) {
    var s = http.createServer(function (req, res) {
      seen.push({ url: req.url, headers: req.headers, port: s.address().port });
      if (mode === 'hang') return;
      if (mode === 'db500') { res.statusCode = 500; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ success: false, error: { code: 'DATABASE_ERROR' } })); }
      if (mode === 'noitems') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ success: true, data: [] })); }
      if (mode === 'html') { return res.end('<html>maintenance</html>'); }
      if (mode === 'big') { res.setHeader('content-type', 'application/json'); return res.end('{"items":[' + '"' + 'x'.repeat(5000) + '"' + ']}'); }
      if (mode === 'redirect-same') { if (req.url.indexOf('/moved') === -1) { res.statusCode = 308; res.setHeader('location', '/api/v1/moved' + req.url.slice(req.url.indexOf('?'))); return res.end(); } }
      if (mode === 'redirect-other') { res.statusCode = 308; res.setHeader('location', 'http://127.0.0.1:' + S2.address().port + '/api/v1/agents'); return res.end(); }
      if (mode === 'redirect-loop') { res.statusCode = 302; res.setHeader('location', req.url); return res.end(); }
      if (mode === 'redirect-noloc') { res.statusCode = 302; return res.end(); }
      res.setHeader('content-type', 'application/json'); res.end(OK);
    });
    s.listen(0, '127.0.0.1', function () { resolve(s); });
  });
}
test.before(async function () { S = await serve(); S2 = await serve(); base = 'http://127.0.0.1:' + S.address().port + '/api/v1'; });
test.after(function () { S.close(); S2.close(); });
function dir(extra) { return createDirectory(Object.assign({ apiBase: base, local: true, timeoutMs: 400, maxBytes: 4096, holdMs: 0, name: 'test' }, extra || {})); }
function reset(m) { mode = m; seen = []; }
async function fails(p) { try { await p; } catch (e) { return e; } throw new Error('expected a failure'); }

test('a good listing: items array back, chain id and query on the wire', async function () {
  reset('ok'); var d = dir();
  var j = await d.search('grid', { limit: 5 });
  assert.equal(j.items.length, 2); assert.equal(j.total, 2);
  assert.match(seen[0].url, /\/api\/v1\/agents\?limit=5&chain_id=56&search=grid$/);
  var p = await d.page(200, 100); assert.equal(p.items.length, 2); assert.match(seen[1].url, /offset=200/);
});
test('HTTP 500 with a JSON body is a failure with the directory code, never an empty answer', async function () {
  reset('db500'); var e = await fails(dir().search('grid'));
  assert.equal(e.kind, 'http'); assert.equal(e.status, 500); assert.match(e.message, /DATABASE_ERROR/);
});
test('a 200 without an items array and a 200 with html are failures', async function () {
  reset('noitems'); assert.equal((await fails(dir().search('grid'))).kind, 'body');
  reset('html'); assert.equal((await fails(dir().search('grid'))).kind, 'body');
});
test('a body over the cap is refused', async function () {
  reset('big'); assert.equal((await fails(dir().search('grid'))).kind, 'too_large');
});
test('a hang ends at the deadline', async function () {
  reset('hang'); var t0 = Date.now(); var e = await fails(dir().search('grid'));
  assert.equal(e.kind, 'timeout'); assert.ok(Date.now() - t0 < 1500, 'bounded by the timeout');
});
test('a redirect on the same origin is followed by hand; the answer comes from the new path', async function () {
  reset('redirect-same'); var j = await dir().search('grid'); assert.equal(j.items.length, 2);
  assert.equal(seen.length, 2); assert.match(seen[1].url, /\/api\/v1\/moved\?limit=20/);
});
test('a redirect to another origin (another port here) is refused and the other host is never contacted', async function () {
  reset('redirect-other'); var e = await fails(dir().search('grid'));
  assert.equal(e.kind, 'redirect'); assert.match(e.message, /disallowed host/);
  assert.equal(seen.filter(function (s) { return s.port === S2.address().port; }).length, 0);
});
test('a redirect loop stops at maxRedirects; a redirect without location is a failure', async function () {
  reset('redirect-loop'); var e = await fails(dir({ maxRedirects: 2 }).search('grid')); assert.equal(e.kind, 'redirect'); assert.match(e.message, /too many/); assert.equal(seen.length, 3);
  reset('redirect-noloc'); assert.match((await fails(dir().search('grid'))).message, /without location/);
});
test('www and apex are one origin; another host, port or scheme is not', function () {
  var b = 'https://www.8004scan.io/api/v1';
  assert.equal(sameOrigin('https://8004scan.io/api/v1/agents?x=1', b), true);
  assert.equal(sameOrigin('https://www.8004scan.io/api/v1/agents', 'https://8004scan.io/api/v1'), true);
  assert.equal(sameOrigin('http://8004scan.io/api/v1/agents', b), false);
  assert.equal(sameOrigin('https://8004scan.io:8443/api/v1/agents', b), false);
  assert.equal(sameOrigin('https://evil.example/api/v1/agents', b), false);
  assert.equal(sameOrigin('https://8004scan.io.evil.example/api/v1', b), false);
  assert.equal(sameOrigin('not a url', b), false);
  var d = createDirectory({ apiBase: 'https://8004scan.io/api/v1' });
  assert.equal(d.sameOrigin('https://www.8004scan.io/api/v1/agents'), true);
  assert.equal(d.agentUrl('42'), 'https://8004scan.io/agents/bsc/42');
});
test('the key header rides only to the directory host family and is read at call time', async function () {
  reset('ok'); var d = dir();
  delete process.env.SCAN_API_KEY;
  assert.equal(d.headers(base + '/agents')['x-api-key'], undefined, 'no key: no header');
  process.env.SCAN_API_KEY = 'k-test'; process.env.SCAN_API_KEY_HEADER = 'x-api-key';
  assert.equal(d.headers(base + '/agents')['x-api-key'], 'k-test');
  var real = createDirectory({ apiBase: 'https://8004scan.io/api/v1' });
  assert.equal(real.headers('https://www.8004scan.io/api/v1/agents')['x-api-key'], 'k-test', 'the www twin is the same family');
  assert.equal(d.headers('https://evil.example/agents')['x-api-key'], undefined, 'never to another host');
  assert.equal(d.headers('not a url')['x-api-key'], undefined);
  await d.search('grid'); assert.equal(seen[0].headers['x-api-key'], 'k-test', 'sent on the wire');
  delete process.env.SCAN_API_KEY; delete process.env.SCAN_API_KEY_HEADER;
  await d.search('grid'); assert.equal(seen[1].headers['x-api-key'], undefined, 'a key removed after boot stops being sent');
});
test('without local:true, http, literal IPs and private addresses are refused before any connection', async function () {
  var d = createDirectory({ apiBase: 'http://127.0.0.1:1/api/v1', timeoutMs: 300, holdMs: 0 });
  assert.equal((await fails(d.search('x'))).kind, 'refused');
  var d2 = createDirectory({ apiBase: 'https://127.0.0.1:1/api/v1', timeoutMs: 300, holdMs: 0 });
  assert.equal((await fails(d2.search('x'))).kind, 'refused');
  var d3 = createDirectory({ apiBase: 'https://internal.example/api/v1', timeoutMs: 300, holdMs: 0, lookup: function (h, o, cb) { cb(null, [{ address: '10.1.2.3', family: 4 }]); } });
  assert.equal((await fails(d3.search('x'))).kind, 'private');
  var d4 = createDirectory({ apiBase: 'https://nowhere.example/api/v1', timeoutMs: 300, holdMs: 0, lookup: function (h, o, cb) { cb(new Error('ENOTFOUND')); } });
  assert.equal((await fails(d4.search('x'))).kind, 'resolve');
  assert.equal(privateIp('100.64.0.1'), true); assert.equal(privateIp('169.254.1.1'), true); assert.equal(privateIp('8.8.8.8'), false); assert.equal(privateIp('::1'), true);
});
test('a path off the directory origin is refused', async function () {
  assert.equal((await fails(dir().fetchJson('https://evil.example/agents'))).kind, 'refused');
});
test('the hold: after a failure the next call answers at once without a request; a success clears it', async function () {
  reset('db500'); var d = dir({ holdMs: 500 });
  assert.equal((await fails(d.search('grid'))).kind, 'http'); assert.equal(seen.length, 1);
  var e = await fails(d.search('grid')); assert.equal(e.kind, 'held'); assert.ok(e.retryInMs > 0 && e.retryInMs <= 500); assert.equal(e.reason, 'HTTP 500');
  assert.equal(seen.length, 1, 'no second request during the hold');
  mode = 'ok'; var j = await d.search('grid', { ignoreHold: true }); assert.equal(j.items.length, 2); assert.equal(d.heldFor(), 0, 'a success clears the hold');
  reset('hang'); assert.equal((await fails(d.search('grid'))).kind, 'timeout'); assert.equal((await fails(d.search('grid'))).kind, 'held');
  d.clearHold(); assert.equal(d.heldFor(), 0);
});
test('holdMs 0: every call goes to the wire', async function () {
  reset('db500'); var d = dir({ holdMs: 0 });
  await fails(d.search('grid')); await fails(d.search('grid')); assert.equal(seen.length, 2);
});
test('the pin: the socket goes to the checked address, the Host header keeps the name', async function () {
  reset('ok');
  var d = createDirectory({ apiBase: 'http://directory.test:' + S.address().port + '/api/v1', local: true, timeoutMs: 400, holdMs: 0, lookup: function (h, o, cb) { cb(null, [{ address: '127.0.0.1', family: 4 }]); } });
  var j = await d.search('grid'); assert.equal(j.items.length, 2); assert.equal(seen[0].headers.host, 'directory.test:' + S.address().port);
});
test('S2: an illegal header value from the env is a refused answer, not an uncaught exception', async function () {
  reset('ok'); process.env.SCAN_API_KEY = 'bad\nvalue';
  var e = await fails(dir().search('grid'));
  delete process.env.SCAN_API_KEY;
  assert.equal(e.kind, 'refused'); assert.match(e.message, /could not be built/); assert.equal(seen.length, 0);
});
