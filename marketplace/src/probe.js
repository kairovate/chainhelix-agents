// Third-party liveness: does a discovered registration declare a service
// endpoint and does that endpoint answer with an agent card right now?
// Read-only throughout, one eth_call for the registration metadata, one
// guarded GET for the card. Fetched bodies are parsed as JSON and reduced to
// a status string; third-party content is never rendered from here.
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { TTL } from "./config.js";
import { rpcRead } from "./rpc.js"; // 2026-09-05
import { CATALOG } from "./catalog.js";
import { cached } from "./cache.js";

const TOKEN_URI_SELECTOR = "0xc87b56dd"; // tokenURI(uint256)
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

// Guarded GET for third-party URLs: redirects are followed manually so every
// hop passes the same host guard (a listed endpoint must not bounce this
// server to an internal address) and the body is read through a hard byte
// cap so a hostile endpoint cannot stream us into the memory limit.
const MAX_BODY_BYTES = 262_144;
const MAX_REDIRECTS = 3;

// A hostname that passes the string guard can still resolve to an internal
// address (DNS pointing a public name at 127.0.0.1/10.x/169.254.x). Resolve
// every host and refuse when any answer is non-public. Applied per hop, same
// as the string guard.
// fix 2026-09-03 H126: exported so the private-range table can be tested without a network. It is a pure
// function of (address, family); nothing else about it changed. H2-46: an off-by-one here (172.32 for
// 172.31) would silently open the guard and no test would have caught it.
export function ipIsPublic(addr, family) {
  if (family === 4) {
    const p = addr.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false; // CGNAT
    if (p[0] === 169 && p[1] === 254) return false; // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return false; // benchmark
    if (p[0] >= 224) return false; // multicast + reserved
    return true;
  }
  const a = addr.toLowerCase();
  if (a === "::" || a === "::1") return false;
  if (a.startsWith("fc") || a.startsWith("fd")) return false; // ULA fc00::/7
  if (a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return false; // link-local
  const v4 = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // v4-mapped
  if (v4) return ipIsPublic(v4[1], 4);
  return true;
}

// fix 2026-09-02 H59: the guard resolved the name and fetch resolved it again (check, then connect),
// so a rebinding answer could pass the guard and put the connection on an internal address. Now the
// name is resolved once, every answer is vetted, and the connection is made to the vetted address
// with the hostname kept for SNI, certificate checking and the Host header. PROBE_DNS_PIN=0 restores
// the unpinned fetch.
const DNS_PIN = process.env.PROBE_DNS_PIN !== "0";

export async function resolvePublic(url) {
  try {
    const answers = await lookup(new URL(url).hostname, { all: true, verbatim: true });
    return answers.length > 0 && answers.every((a) => ipIsPublic(a.address, a.family)) ? answers : null;
  } catch {
    return null;
  }
}

// One request (GET unless init.method says otherwise) to a vetted address, no redirect
// following. Returns the subset of the Response shape fetchJson reads (status, ok,
// headers.get, body as a web stream) plus text()/json() capped at MAX_BODY_BYTES.
export function pinnedGet(url, address, family, signal, init = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(new URL(url), {
      method: init.method || "GET",
      headers: { Accept: "application/json", ...(init.headers || {}) },
      signal,
      lookup: (_host, opts, cb) =>
        opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family),
    }, (res) => {
      const body = Readable.toWeb(res);
      const text = async () => {
        const reader = body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BODY_BYTES) { req.destroy(); throw new Error(`body exceeds ${MAX_BODY_BYTES} bytes`); }
          chunks.push(value);
        }
        return Buffer.concat(chunks).toString("utf8");
      };
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: { get: (n) => { const v = res.headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; } },
        body,
        text,
        json: async () => JSON.parse(await text()),
      });
    });
    req.on("error", reject);
    if (init.body != null) req.write(init.body);
    req.end();
  });
}

export async function fetchJson(url, timeoutMs) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const answers = await resolvePublic(current);
    if (!answers) throw new Error("host resolves to disallowed address");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = DNS_PIN
        ? await pinnedGet(current, answers[0].address, answers[0].family, ctrl.signal) // fix 2026-09-02 H59
        : await fetch(current, {
            signal: ctrl.signal,
            redirect: "manual",
            headers: { Accept: "application/json" },
          });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`redirect without location`);
        current = new URL(loc, current).href;
        if (!probeAllowed(current)) throw new Error(`redirect to disallowed host`);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status}`);
      return JSON.parse(await readCapped(res, ctrl));
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error("too many redirects");
}

async function readCapped(res, ctrl) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      ctrl.abort();
      throw new Error(`body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Only probe plain public https hosts. Registration metadata is untrusted
// input; never let it point a server-side fetch at anything internal.
export function probeAllowed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false; // IPv4 literal
  if (host.startsWith("[") || host.includes(":")) return false; // IPv6 literal
  if (!host.includes(".")) return false; // bare names (localhost etc.)
  if (/\.(local|internal|lan|home|localdomain)$/.test(host)) return false;
  return true;
}

// Pull a service endpoint out of registration metadata (EIP-8004
// registration-v1 shape: services[]; tolerate a few common variants).
export function extractEndpoint(meta) {
  if (!meta || typeof meta !== "object") return null;
  const services = Array.isArray(meta.services) ? meta.services : [];
  const candidates = services
    .map((s) => s && (s.endpoint || s.url))
    .filter((e) => typeof e === "string" && e.startsWith("https://"));
  const a2a = services.find(
    (s) => s && /a2a/i.test(String(s.name || "")) && candidates.includes(s.endpoint || s.url)
  );
  return (a2a && (a2a.endpoint || a2a.url)) || candidates[0] || null;
}

// fix 2026-09-05 (brief part 4): 25,296 registrations (8.3 percent of the index, 25,272 of them on one
// platform) declare an endpoint carrying an unsubstituted template such as
// https://host/api/v1/a2a/agents/{agentId}. The probe fetched the braces literally, got nothing, and the
// registration was counted offline over a URL we never resolved. The registry id IS the value the template
// wants; substitute it before probing and keep the raw form beside it. Off unless VERIFY_RESOLVE_TEMPLATES=1
// so the running loops do not change behaviour before the operator's restart window.
export const RESOLVE_TEMPLATES = process.env.VERIFY_RESOLVE_TEMPLATES === "1";
const TEMPLATE_KEYS = /\{\s*(agent_?id|id|token_?id|agentid)\s*\}/gi;
export function resolveEndpointTemplate(endpoint, id) {
  if (typeof endpoint !== "string" || id === undefined || id === null) return { url: endpoint, raw: null };
  const url = endpoint.replace(TEMPLATE_KEYS, String(id));
  return url === endpoint ? { url: endpoint, raw: null } : { url, raw: endpoint };
}
// fix 2026-09-05 (brief part 4): an endpoint that resolves and answers 401 or 403 exists and is running
// behind authentication; an anonymous probe cannot tell whether the agent works. That is neither alive
// nor offline. Status word `gated`, defined in docs/PROBE_SPEC.md. Off unless VERIFY_RESOLVE_TEMPLATES=1.
export function cardFailureStatus(err) {
  const m = /^(?:HTTP )?(401|403)$/.exec(String(err && err.message ? err.message : err).trim());
  return RESOLVE_TEMPLATES && m ? "gated" : "offline";
}

// The declared endpoint may be the card itself or a base URL.
export function cardUrl(endpoint) {
  if (/agent-card\.json$/.test(endpoint)) return endpoint;
  return `${endpoint.replace(/\/+$/, "")}/.well-known/agent-card.json`;
}

// Decode the three tokenURI forms seen on the registry: inline data: JSON,
// https: JSON, ipfs: JSON (via public gateway).
async function readMetadata(uri) {
  if (uri.startsWith("data:application/json;base64,")) {
    return JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8"));
  }
  if (uri.startsWith("ipfs://")) {
    return fetchJson(`${IPFS_GATEWAY}${uri.slice(7)}`, 5_000);
  }
  if (probeAllowed(uri)) {
    return fetchJson(uri, 5_000);
  }
  return null;
}

// fix 2026-09-03 H60 H125: this is the one fetch in the file that does not go through the hardened
// fetchJson, because it targets our own configured RPC rather than a stranger's host. Three gaps, one
// discipline: res.ok was never checked, so an RPC error page that happens to be JSON gave
// body.result === undefined and returned null, which reads as "no endpoint declared" instead of "the RPC
// failed"; there was no byte cap, so an oversized answer was buffered whole in a 768 MiB-capped process
// while every third-party read here goes through readCapped; and the ABI head at bytes 0-32 was assumed
// to be the offset 0x20 without checking it. A public node is not a trusted party.
// PROBE_RPC_STRICT=0 restores the bare res.json() with no check, no cap and no offset test.
const RPC_STRICT = process.env.PROBE_RPC_STRICT !== "0";

async function tokenUri(erc8004Id) {
  const data = TOKEN_URI_SELECTOR + BigInt(erc8004Id).toString(16).padStart(64, "0");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  let body;
  try {
    // 2026-09-05: read through rpc.js (primary, then the fallback on an availability-shaped failure). rpc.js
    // refuses a non-2xx and caps the body the way fix 2026-09-03 H60 H125 did here.
    body = { result: await rpcRead("eth_call", [{ to: CATALOG.registry, data }, "latest"], { signal: ctrl.signal, maxBytes: MAX_BODY_BYTES }) };
  } finally {
    clearTimeout(t);
  }
  if (RPC_STRICT && body.error) throw new Error(`rpc eth_call: ${body.error.message}`); // fix 2026-09-03 H60
  const hex = body.result;
  if (!hex || hex === "0x") return null;
  const buf = Buffer.from(hex.slice(2), "hex");
  // fix 2026-09-03 H60: solidity emits 0x20 as the head of a single dynamic return. Check it rather than
  // assume it, so a garbled answer is a named failure instead of a silent slice at the wrong place.
  if (RPC_STRICT && BigInt("0x" + (buf.subarray(0, 32).toString("hex") || "0")) !== 32n) {
    throw new Error("rpc eth_call: unexpected abi head");
  }
  const len = Number(BigInt("0x" + buf.subarray(32, 64).toString("hex")));
  return buf.subarray(64, 64 + len).toString("utf8");
}

// Registration metadata is effectively immutable, cache long and treat any
// resolution failure as "no endpoint declared" (null), never as an error.
async function declaredEndpoint(erc8004Id) {
  return cached(`tp:endpoint:${erc8004Id}`, TTL.registration, async () => {
    const uri = await tokenUri(erc8004Id);
    if (!uri) return null;
    const meta = await readMetadata(uri).catch(() => null);
    return extractEndpoint(meta);
  }).catch((e) => {
    // fix 2026-09-03 H60: an RPC failure and "the registration declares no endpoint" both end as null here
    // and the agent is reported unverified either way. The reason is now named on stderr, the same place
    // the rest of this service writes its failures. PROBE_LOG_FAILURES=0 restores the silent catch.
    if (process.env.PROBE_LOG_FAILURES !== "0") console.error(`probe: endpoint lookup failed for ${erc8004Id}: ${e.message}`);
    return null;
  });
}

// Status ladder, cheapest honest version:
//   online      declared endpoint served a valid agent card just now
//   offline     an endpoint is declared on-chain but did not answer
//   unverified  the registration declares no reachable service endpoint
//   gated       the declared endpoint answers, but requires authentication (401/403); not determinable
//               by an anonymous probe (fix 2026-09-05, VERIFY_RESOLVE_TEMPLATES=1)
// 2026-09-05 (build B2): what the agent says it ACCEPTS, read from its own card. The finding behind it: cards on
// this network describe how to pay and say nothing about the work; a buyer cannot tell what to send. Each skill:
// id, name, a bounded description, whether it carries an example and the first one, input modes; plus whether the
// card declares any machine-readable input schema (an A2A extension carrying inputSchema, the shape our own cards
// use). `declared: false` with a loaded card means the agent publishes nothing a buyer could act on. Bounded:
// 12 skills, 300 chars per text field, every string escaped by the page renderer.
export function summarizeAccepts(card) {
  if (!card || typeof card !== "object") return null;
  const cut = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  const skills = (Array.isArray(card.skills) ? card.skills : []).slice(0, 12).map((s) => ({
    id: cut(s && (s.id || s.name), 80), name: cut(s && s.name, 120), description: cut(s && s.description, 300),
    example: Array.isArray(s && s.examples) && s.examples.length ? cut(String(s.examples[0]), 300) : null,
    examples: Array.isArray(s && s.examples) ? s.examples.length : 0,
    inputModes: Array.isArray(s && s.inputModes) ? s.inputModes.slice(0, 4).map((m) => cut(String(m), 40)) : [],
  }));
  const ext = card.capabilities && Array.isArray(card.capabilities.extensions) ? card.capabilities.extensions : [];
  const schemaDeclared = ext.some((e) => e && e.params && typeof e.params === "object" && Object.values(e.params).some((v) => v && typeof v === "object" && (v.properties || v.type === "object")));
  return { declared: skills.length > 0, skills, withExample: skills.filter((s) => s.examples > 0).length, schemaDeclared };
}
export async function probeThirdParty(erc8004Id) {
  const declared = await declaredEndpoint(erc8004Id);
  const endpoint = RESOLVE_TEMPLATES ? resolveEndpointTemplate(declared, erc8004Id).url : declared;
  if (!endpoint || !probeAllowed(endpoint)) return { status: "unverified", endpoint: null, accepts: null };
  const url = cardUrl(endpoint);
  const r = await cached(`tp:health:${erc8004Id}`, TTL.tpHealth, async () => {
    try {
      const card = await fetchJson(url, 3_000);
      return card && typeof card === "object" ? { status: "online", accepts: summarizeAccepts(card) } : { status: "offline", accepts: null };
    } catch (e) {
      return { status: cardFailureStatus(e), accepts: null };
    }
  }).catch(() => ({ status: "offline", accepts: null }));
  // an older cache entry may still be the bare status string (same TTL window as the deploy)
  const status = typeof r === "string" ? r : r.status;
  return { status, endpoint: url, accepts: typeof r === "string" ? null : r.accepts };
}
