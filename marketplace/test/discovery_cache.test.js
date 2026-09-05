// 2026-09-05: the last-good disk cache for third-party discovery, exercised with the source unreachable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const dir = mkdtempSync(join(tmpdir(), "disc-"));
process.env.DISCOVERY_CACHE_FILE = join(dir, "last_good.json");
process.env.SCAN_API = "https://127.0.0.1:1"; // nothing listens: every fetch fails fast
const { discoverCategory, sameScanOrigin } = await import("../src/scan.js");
// 2026-09-05: the directory moved its front door from www to the apex host with a 308; that pair passes,
// any other host, a different port or a scheme downgrade is refused.
test("redirect guard: www and apex are one origin, everything else is refused", () => {
  const base = "https://www.8004scan.io/api/v1";
  assert.equal(sameScanOrigin("https://8004scan.io/api/v1/agents?x=1", base), true);
  assert.equal(sameScanOrigin("https://www.8004scan.io/api/v1/agents", "https://8004scan.io/api/v1"), true);
  assert.equal(sameScanOrigin("https://www.8004scan.io/other", base), true);
  assert.equal(sameScanOrigin("http://8004scan.io/api/v1/agents", base), false);
  assert.equal(sameScanOrigin("https://8004scan.io:8443/api/v1/agents", base), false);
  assert.equal(sameScanOrigin("https://evil.example/api/v1/agents", base), false);
  assert.equal(sameScanOrigin("https://8004scan.io.evil.example/api/v1", base), false);
  assert.equal(sameScanOrigin("not a url", base), false);
});
test("source down, no cache anywhere: unavailable", async () => {
  const d = await discoverCategory("grid", new Set());
  assert.equal(d.unavailable, true); assert.equal(d.agents.length, 0);
});
test("source down, last good list on disk: served, marked stale, dated", async () => {
  writeFileSync(process.env.DISCOVERY_CACHE_FILE, JSON.stringify({ yield: { value: { agents: [{ erc8004Id: 7, name: "x", reputation: { link: "https://8004scan.io/agents/56:0xold:7" } }], totalMatched: 1, cap: 8 }, storedAt: 1700000000000 } }));
  const d = await discoverCategory("yield", new Set());
  assert.equal(d.stale, true); assert.equal(d.asOf, 1700000000000); assert.equal(d.agents.length, 1); assert.equal(d.unavailable, undefined);
  assert.equal(d.agents[0].reputation.link, "https://8004scan.io/agents/bsc/7", "a stored copy is served with the current link form");
});
// 2026-09-05: a failed read re-arms the cache with the fallback for the retry window, so the next page load
// does not wait for the abort again, and the fallback keeps the asOf of the copy it was made from.
test("source down: the fallback is held for the retry window with its original asOf", async () => {
  const { get } = await import("../src/cache.js");
  const first = await discoverCategory("yield", new Set());
  assert.ok(get("scan:discover:yield"), "fallback is in the cache");
  const t0 = Date.now();
  const second = await discoverCategory("yield", new Set());
  assert.ok(Date.now() - t0 < 500, "served from the cache, no fetch");
  assert.equal(second.stale, true); assert.equal(second.asOf, 1700000000000); assert.equal(first.asOf, second.asOf);
  const none = await discoverCategory("grid", new Set());
  assert.equal(none.unavailable, true); assert.ok(get("scan:discover:grid"), "unavailable is held too");
});

// 2026-09-05: directory agent page links use the slug form the directory serves; the old form answers 404.
test("directory agent link uses /agents/bsc/<id>", async () => {
  const { scanAgentUrl, SCAN_SITE } = await import("../src/config.js");
  assert.equal(scanAgentUrl(269223), SCAN_SITE + "/agents/bsc/269223");
  assert.equal(scanAgentUrl("269224"), SCAN_SITE + "/agents/bsc/269224");
});

// 2026-09-05: the 8004scan Pro key goes only to the directory's own host family, never to an agent or a gateway.
test("scanHeaders: the key rides to the directory host family only", async () => {
  process.env.SCAN_API_KEY = "test-key-123"; process.env.SCAN_API_KEY_HEADER = "x-api-key";
  const cfg = await import("../src/config.js");
  const base = cfg.SCAN_API;
  assert.equal(cfg.scanHeaders(base + "/agents?x=1")["x-api-key"], "test-key-123");
  assert.equal(cfg.scanHeaders(base + "/agents?limit=25&search=grid")["x-api-key"], "test-key-123");
  assert.equal(cfg.scanHeaders("https://agent.example/.well-known/agent-card.json")["x-api-key"], undefined);
  assert.equal(cfg.scanHeaders("https://ipfs.io/ipfs/x")["x-api-key"], undefined);
  assert.equal(cfg.scanHeaders("not a url")["x-api-key"], undefined);
  delete process.env.SCAN_API_KEY;
});
