// Tests for the third-party liveness probe. Covered here, offline, with no network and no TLS:
// the URL string guard, metadata endpoint extraction, card URL normalization, the private-range table
// (ipIsPublic) and the per-hop resolver decision (resolvePublic, driven through the OS resolver against
// names that resolve from /etc/hosts).
// fix 2026-09-03 H192: this header used to say "Network paths are exercised live against the running
// service, not here", and no such exercise existed anywhere runnable in the repository. What is still not
// covered, stated so the gap is visible rather than implied: probeFetch's redirect loop, readCapped and
// pinnedGet's own byte cap. Those need an https server presenting a publicly trusted certificate for a
// public name, which a unit test on this box cannot stand up; exercising them needs the deployed service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeAllowed, extractEndpoint, cardUrl, ipIsPublic, resolvePublic } from "../src/probe.js";

test("probeAllowed accepts plain public https only", () => {
  assert.equal(probeAllowed("https://agents.chainhelix.io/rebalancer/"), true);
  assert.equal(probeAllowed("https://example.com/.well-known/agent-card.json"), true);
  assert.equal(probeAllowed("http://example.com/"), false);
  assert.equal(probeAllowed("https://example.com:8443/"), false);
  assert.equal(probeAllowed("https://127.0.0.1/"), false);
  assert.equal(probeAllowed("https://10.0.0.5/x"), false);
  assert.equal(probeAllowed("https://localhost/"), false);
  assert.equal(probeAllowed("https://foo.local/"), false);
  assert.equal(probeAllowed("https://foo.internal/"), false);
  assert.equal(probeAllowed("https://[::1]/"), false);
  assert.equal(probeAllowed("ipfs://QmXyz"), false);
  assert.equal(probeAllowed("not a url"), false);
});

test("extractEndpoint reads registration-v1 services, prefers A2A", () => {
  const meta = {
    name: "X",
    services: [
      { name: "web", endpoint: "https://example.com/" },
      { name: "A2A", endpoint: "https://example.com/agent/.well-known/agent-card.json" },
    ],
  };
  assert.equal(extractEndpoint(meta), "https://example.com/agent/.well-known/agent-card.json");
});

test("extractEndpoint falls back to first https service and tolerates junk", () => {
  assert.equal(
    extractEndpoint({ services: [{ name: "api", url: "https://example.com/base" }] }),
    "https://example.com/base"
  );
  assert.equal(extractEndpoint({ services: [{ name: "api", endpoint: "http://plain" }] }), null);
  assert.equal(extractEndpoint({}), null);
  assert.equal(extractEndpoint(null), null);
  assert.equal(extractEndpoint({ services: "nope" }), null);
  assert.equal(extractEndpoint({ services: [null, {}, { endpoint: 42 }] }), null);
});

test("cardUrl normalizes a base endpoint, passes a card through", () => {
  assert.equal(
    cardUrl("https://example.com/agent/"),
    "https://example.com/agent/.well-known/agent-card.json"
  );
  assert.equal(
    cardUrl("https://agents.chainhelix.io/rebalancer/.well-known/agent-card.json"),
    "https://agents.chainhelix.io/rebalancer/.well-known/agent-card.json"
  );
});

// fix 2026-09-03 H126: nothing covered the private-range table, which is where an off-by-one (172.32 for
// 172.31) would silently open the guard. Every boundary is asserted on both sides.
test("ipIsPublic rejects every private range, at both edges of each", () => {
  const priv = [
    ["0.0.0.0", 4], ["0.255.255.255", 4],
    ["10.0.0.0", 4], ["10.255.255.255", 4],
    ["127.0.0.1", 4], ["127.255.255.255", 4],
    ["100.64.0.0", 4], ["100.127.255.255", 4],          // CGNAT
    ["169.254.169.254", 4],                              // link-local, the metadata address
    ["172.16.0.0", 4], ["172.31.255.255", 4],
    ["192.168.0.0", 4], ["192.168.255.255", 4],
    ["198.18.0.0", 4], ["198.19.255.255", 4],            // benchmark
    ["224.0.0.1", 4], ["255.255.255.255", 4],            // multicast and reserved
    ["::", 6], ["::1", 6],
    ["fc00::1", 6], ["fdff::1", 6],                      // ULA
    ["fe80::1", 6], ["feb0::1", 6],                      // link-local
    ["::ffff:127.0.0.1", 6], ["::ffff:10.1.2.3", 6],     // v4-mapped
  ];
  for (const [addr, family] of priv) {
    assert.equal(ipIsPublic(addr, family), false, `${addr} must be refused`);
  }
  const pub = [
    ["9.255.255.255", 4], ["11.0.0.0", 4],               // either side of 10/8
    ["100.63.255.255", 4], ["100.128.0.0", 4],           // either side of 100.64/10
    ["126.255.255.255", 4], ["128.0.0.0", 4],            // either side of 127/8
    ["172.15.255.255", 4], ["172.32.0.0", 4],            // either side of 172.16/12
    ["169.253.0.1", 4], ["169.255.0.1", 4],              // either side of 169.254/16
    ["192.167.255.255", 4], ["192.169.0.0", 4],          // either side of 192.168/16
    ["198.17.255.255", 4], ["198.20.0.0", 4],            // either side of 198.18/15
    ["223.255.255.255", 4],                              // just below multicast
    ["8.8.8.8", 4], ["2001:4860:4860::8888", 6], ["::ffff:8.8.8.8", 6],
  ];
  for (const [addr, family] of pub) {
    assert.equal(ipIsPublic(addr, family), true, `${addr} must be allowed`);
  }
});

// fix 2026-09-03 H191 (residual only): B3-36's central premise was refuted by verification, which found
// the resolver in the same file the sweep quoted. What survived was this file, which exercised only
// literals and bare names. The four shapes the sweep measured are pinned here, together with the decision
// that actually refuses them. The string guard is name-based on purpose and passes them; resolvePublic is
// the layer that refuses any of them that really points inward, and fetchJson calls it before every hop.
test("probeAllowed is name-based: the audited shapes pass the string guard", () => {
  assert.equal(probeAllowed("https://127.0.0.1.nip.io/"), true);        // wildcard DNS name
  assert.equal(probeAllowed("https://foo.local./"), true);              // trailing dot, absolute FQDN
  assert.equal(probeAllowed("https://foo.internal./"), true);
  assert.equal(probeAllowed("https://user:pass@evil.com/"), true);      // embedded credentials
  // and the layer that refuses them once they resolve inward
  assert.equal(ipIsPublic("127.0.0.1", 4), false);
});

// fix 2026-09-03 H192: the per-hop resolver guard, exercised end to end without a network. localhost and
// ip6-localhost resolve from the OS hosts file (nsswitch reads files before dns), so this needs no network
// and is deterministic. A not-a-url case covers the throw path without touching the resolver.
test("resolvePublic refuses a name that resolves to a private address", async () => {
  assert.equal(await resolvePublic("https://localhost/"), null);
  assert.equal(await resolvePublic("https://ip6-localhost/"), null);
  assert.equal(await resolvePublic("not a url"), null);
});

// fix 2026-09-05 (brief part 4): endpoint templates and the gated class.
import { resolveEndpointTemplate, cardFailureStatus, RESOLVE_TEMPLATES } from "../src/probe.js";

test("resolveEndpointTemplate substitutes the registry id and keeps the raw form", () => {
  const r = resolveEndpointTemplate("https://platform-backend.prod.termix.live/api/v1/a2a/agents/{agentId}", 293111);
  assert.equal(r.url, "https://platform-backend.prod.termix.live/api/v1/a2a/agents/293111");
  assert.equal(r.raw, "https://platform-backend.prod.termix.live/api/v1/a2a/agents/{agentId}");
  assert.deepEqual(resolveEndpointTemplate("https://example.com/agents/{ id }/card", 7), { url: "https://example.com/agents/7/card", raw: "https://example.com/agents/{ id }/card" });
  assert.deepEqual(resolveEndpointTemplate("https://example.com/a/{tokenId}", 7), { url: "https://example.com/a/7", raw: "https://example.com/a/{tokenId}" });
  assert.deepEqual(resolveEndpointTemplate("https://example.com/a/{other}", 7), { url: "https://example.com/a/{other}", raw: null });
  assert.deepEqual(resolveEndpointTemplate("https://example.com/plain/", 7), { url: "https://example.com/plain/", raw: null });
  assert.deepEqual(resolveEndpointTemplate(null, 7), { url: null, raw: null });
});

test("cardFailureStatus: 401 and 403 are gated only when templates are enabled, everything else offline", () => {
  const gated = RESOLVE_TEMPLATES ? "gated" : "offline";
  assert.equal(cardFailureStatus(new Error("401")), gated);
  assert.equal(cardFailureStatus(new Error("403")), gated);
  assert.equal(cardFailureStatus(new Error("HTTP 401")), gated);
  assert.equal(cardFailureStatus(new Error("404")), "offline");
  assert.equal(cardFailureStatus(new Error("500")), "offline");
  assert.equal(cardFailureStatus(new Error("host resolves to disallowed address")), "offline");
  assert.equal(cardFailureStatus(new Error("The operation was aborted")), "offline");
});

// 2026-09-05 (build B2): what a card says it accepts.
import { summarizeAccepts } from "../src/probe.js";
test("summarizeAccepts reads skills, examples and a declared schema, bounded", () => {
  const ours = { skills: [{ id: "grid", name: "Grid trading ladder", description: "x".repeat(500), examples: ['{"price":1}'] }, { id: "negotiate", description: "n" }],
    capabilities: { extensions: [{ uri: "u", params: { grid: { type: "object", properties: { price: {} } } } }] } };
  const a = summarizeAccepts(ours);
  assert.equal(a.declared, true); assert.equal(a.skills.length, 2); assert.equal(a.withExample, 1); assert.equal(a.schemaDeclared, true);
  assert.equal(a.skills[0].description.length, 300); assert.equal(a.skills[0].example, '{"price":1}'); assert.equal(a.skills[1].example, null);
  const bare = summarizeAccepts({ name: "x", skills: [] });
  assert.equal(bare.declared, false); assert.equal(bare.schemaDeclared, false);
  assert.equal(summarizeAccepts(null), null);
  const many = summarizeAccepts({ skills: Array.from({ length: 30 }, (_, i) => ({ id: "s" + i })) });
  assert.equal(many.skills.length, 12);
});
