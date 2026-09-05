// ChainHelix Verified, lane 1 step 1 (2026-08-24, operator go "1 and 3" then "go").
// Enumerates every ERC-8004 agent on the configured chain from 8004scan, then probes each one
// from its OWN on-chain registration: tokenURI -> registration file -> declared endpoint ->
// A2A agent card. Records a status with evidence per agent. Read-only: no wallet, no signing.
// Test-hire (step 2) and the Greenfield evidence store (step 3) build on the state this writes.
//
// Status words (plain, user-facing later):
//   dead        registration has no usable https endpoint, or the endpoint never answers
//   offline     endpoint declared but the agent card did not load on this probe
//   alive       agent card loaded (the agent is running and describes itself)
//   hireable    alive AND the card declares a negotiate skill (ERC-8183 seller) or x402 is supported
//   gated       endpoint declared and it answers, but requires authentication (HTTP 401/403); whether the
//               agent works is not determinable by an anonymous probe (fix 2026-09-05, brief part 4;
//               on only with VERIFY_RESOLVE_TEMPLATES=1, which also substitutes {agentId}-style endpoint
//               templates with the registry id before probing; rawEndpoint keeps the declared form)
// Trust rung on the live map (fix 2026-09-02 H73), a separate field so status keeps its meaning:
//   rung        verified | hireable | alive; verified = the newest test-hire is a paid ERC-8183 job that
//               was hired, funded and delivered (tx hashes in the test record). VERIFY_RUNG=0 omits it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, writeSync, readSync, closeSync, rmSync, statSync, readdirSync, unlinkSync } from "fs";
import { dirname } from "path";
import { SCAN_API, CHAIN_ID, scanHeaders } from "./config.js";
import { rpcRead } from "./rpc.js"; // 2026-09-05
import { CATALOG } from "./catalog.js";
import { probeAllowed, extractEndpoint, cardUrl, resolveEndpointTemplate, cardFailureStatus, RESOLVE_TEMPLATES } from "./probe.js";

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
const IPFS_FOLLOW = process.env.VERIFY_IPFS_FOLLOW !== "0"; // fix 2026-09-03 H89, see readMetadata
const TOKEN_URI_SELECTOR = "0xc87b56dd"; // tokenURI(uint256)
const MAX_BYTES = 262_144;

export const INDEX_FILE = new URL("../data/agents_index.json", import.meta.url).pathname;
export const STATE_FILE = new URL("../data/verified.json", import.meta.url).pathname;
// Small live map (alive + hireable only) rewritten on every state save so readers (the marketplace
// API, the paid MCP tool) never parse the full state file, which grows with the registry.
export const LIVE_FILE = new URL("../data/live_map.json", import.meta.url).pathname;
// memory fix 2026-09-02: the marketplace server runs under systemd MemoryMax=512M and an on-demand verify
// (/api/verify/:id, called by the paid MCP agent_report tool) used to merge its ONE record by parsing the
// whole state file (146 MB on disk, about 500 MB parsed): the kernel killed the service on every such call
// (journal: 6 oom-kills since 08-26, the public site answered 502 for 10 s each time). With VERIFY_SPOOL=1
// (set on the unit) the server writes each probed record to data/verify_spool/<id>.<probedAt>.json and never
// opens the state file; the uncapped merge processes (scripts/verify_live.sh every 60 s, verify_loop.sh)
// drain the spool inside mergeSaveLocked, oldest first, so history and "newest probe wins" are unchanged.
// Kill switch: unset VERIFY_SPOOL on the unit (the old in-process merge, and the kill, come back).
export const SPOOL_DIR = new URL("../data/verify_spool/", import.meta.url).pathname;
const SPOOL_ONLY = process.env.VERIFY_SPOOL === "1";
function spoolFiles() {
  let names = [];
  try { names = readdirSync(SPOOL_DIR).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = /^(\d+)\.(\d+)\.json$/.exec(n);
    if (m) out.push({ name: n, id: m[1], probedAt: Number(m[2]) });
  }
  return out.sort((a, b) => a.probedAt - b.probedAt || a.id.localeCompare(b.id));
}
// fix 2026-09-02 H85: under VERIFY_SPOOL the answer's history came only from a spool file of the same id, and the
// merge process drains the spool every 60 s, so every on-demand answer carried ONE entry while the state held ten.
// Read that one record's history straight out of the state file with a streaming scan (1 MB window, no parse),
// so the capped server still never holds the state. Kill switch: VERIFY_HISTORY_SCAN=0 (the one-entry answer comes back).
const HISTORY_SCAN = process.env.VERIFY_HISTORY_SCAN !== "0";
// fix 2026-09-05 H235 (option A): the newest sweep record for one id, read with the same streaming scan as
// historyFromState, so GET /api/verify/:id can answer from the state without probing and without writing.
// Returns null when the id has never been probed.
// sweep 2026-09-05: the record's end was found by "the next record's key, else the last `}}`". For the LAST record
// in the file that heuristic kept one brace of the enclosing objects, JSON.parse failed and the route answered
// "not probed yet" for a registration that had been probed (id 335154, the newest, at the time of the sweep). The
// end is now found by walking the braces from the record's own opening one, string-aware, which also removes the
// dependence on the next key's shape.
export function objectEnd(text, from) {
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}
export function recordFromState(id, file = STATE_FILE) {
  if (!/^\d+$/.test(String(id)) || !existsSync(file)) return null;
  const key = `"${id}":{"id":${id},`;
  const WIN = 16384;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let s = "";
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n > 0) s += buf.toString("latin1", 0, n);
      const at = s.indexOf(key);
      if (at >= 0) {
        if (s.length - at < WIN && n > 0) continue;
        const start = at + key.length - `{"id":${id},`.length;
        const end = objectEnd(s, start);
        if (end < 0 || end - start > WIN) return null;
        try { return JSON.parse(Buffer.from(s.slice(start, end), "latin1").toString("utf8")); } catch { return null; }
      }
      if (n === 0) return null;
      if (s.length > WIN) s = s.slice(-WIN);
    }
  } finally { closeSync(fd); }
}
export function historyFromState(id) {
  if (!HISTORY_SCAN || !/^\d+$/.test(String(id)) || !existsSync(STATE_FILE)) return [];
  const key = `"${id}":{"id":${id},`;
  const WIN = 16384; // one agent record is well under this
  const fd = openSync(STATE_FILE, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let s = "";
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n > 0) s += buf.toString("latin1", 0, n);
      const at = s.indexOf(key);
      if (at >= 0) {
        if (s.length - at < WIN && n > 0) continue; // the record may continue in the next read
        const seg = s.slice(at + key.length, at + WIN);
        const next = /,"\d+":\{"id":\d+,/.exec(seg); // the next record's start bounds this one
        const rec = next ? seg.slice(0, next.index) : seg;
        const m = /"history":(\[[^\]]*\])/.exec(rec);
        if (!m) return [];
        try { return JSON.parse(m[1]); } catch { return []; }
      }
      if (n === 0) return [];
      s = s.slice(-(key.length + WIN));
    }
  } finally { closeSync(fd); }
}
function spoolWrite(touched) {
  mkdirSync(SPOOL_DIR, { recursive: true });
  const agents = {};
  // fix 2026-09-03 H87: spoolFiles() readdirSync + regex ran once per touched id. The keys of `touched`
  // are unique ids and the files written below are for other ids, so one scan before the loop returns the
  // same records; on-demand is one id per call today, this only stops a batch caller paying N readdirs.
  const spooled = spoolFiles();
  for (const [k, v] of Object.entries(touched)) {
    // history for the answer comes from the newest spooled record of this id (the state file is never read here);
    // it is recomputed from the full state when the merge process drains the spool.
    let prev = null;
    const mine = spooled.filter((f) => f.id === k);
    if (mine.length) { try { prev = JSON.parse(readFileSync(SPOOL_DIR + mine[mine.length - 1].name, "utf8")); } catch { prev = null; } }
    if (!prev) prev = { history: historyFromState(k) }; // fix 2026-09-02 H85: spool drained, read this id's history from the state
    const rec = Object.assign({}, v);
    rec.history = ((prev && prev.history) || []).concat([{ t: rec.probedAt, s: rec.status }]).slice(-10);
    saveJson(SPOOL_DIR + `${k}.${rec.probedAt || Date.now()}.json`, rec);
    agents[k] = rec;
  }
  return { agents };
}
// memory fix 2026-08-26: registry counts for the live map come from this small sidecar, written with every
// index save, so buildLiveMap (called on every state save) never parses the 58 MB index.
export const INDEX_META_FILE = new URL("../data/agents_index.meta.json", import.meta.url).pathname;
function indexMeta(idx) {
  return { total: idx.total, indexedAt: idx.newestSeenAt || idx.updated || null, indexed: Object.keys(idx.agents).length, writtenAt: Date.now() };
}
function saveIndex(idx) {
  saveJson(INDEX_FILE, idx);
  saveJson(INDEX_META_FILE, indexMeta(idx));
}
// fix 2026-09-02 H86: the index had two writers and no lock (enumerate rewrote the whole file from its own copy
// after every page while enumerate-new added registrations from another process), so a long enumerate run
// dropped what enumerate-new had added: 23 ids in the state but not in the index, and a live map reporting
// more agents probed than indexed. Every index save now reloads the disk copy under the same mkdir lock the
// state uses, applies only this call's entries and the fields this caller owns, writes that, and hands the
// merged map back to the caller. Kill switch: VERIFY_INDEX_LOCK=0 on the process (the bare rewrite comes back).
const INDEX_LOCK = process.env.VERIFY_INDEX_LOCK !== "0";
function saveIndexMerged(idx, entries, fields) {
  if (!INDEX_LOCK) { saveIndex(idx); return idx; }
  return withLock(INDEX_FILE, () => {
    const cur = loadJsonStrict(INDEX_FILE, { chainId: CHAIN_ID, total: null, offset: 0, agents: {} });
    for (const k in entries) cur.agents[k] = entries[k];
    for (const f of fields) if (idx[f] != null) cur[f] = idx[f];
    saveIndex(cur);
    idx.agents = cur.agents;
    return cur;
  });
}

function loadJson(p, fallback) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback; } catch { return fallback; }
}
// Data-loss fix 2026-08-26 (state file overwritten with 400 of 284,092 records): a file that EXISTS but does not
// parse is an error, never an empty fallback, because the caller would merge into nothing and write that back.
function loadJsonStrict(p, fallback) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, "utf8")); // throws on a damaged file; the caller must not write
}
// Per-process temp name (was p + ".tmp" shared by every writer: two processes wrote the same temp file and one
// renamed the other's half-written bytes into place) and rename, so a reader only ever sees a complete file.
function saveJson(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(v));
  renameSync(tmp, p);
}
// Cross-process lock (mkdir is atomic) around every load-merge-save of the state, so two writers never each
// load the same version and the second silently drop the first's records. Stale after 120 s (a crashed holder).
export function withLock(p, fn) { // exported 2026-09-02 (H210): the one-off seed script takes the same lock
  const dir = p + ".lock";
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const start = Date.now();
  for (;;) {
    try { mkdirSync(dir); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(dir).mtimeMs > 120_000) { rmSync(dir, { recursive: true, force: true }); continue; } } catch {}
      if (Date.now() - start > 180_000) throw new Error("lock timeout " + dir);
      sleep(200);
    }
  }
  try { return fn(); } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}
// memory fix 2026-08-26: the state file (112 MB) is written agent by agent in 4 MB pieces; one
// JSON.stringify of the whole object cost a 112 MB string plus a 112 MB write buffer on every save.
function saveState(p, st) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    let buf = "";
    const flush = () => { if (buf.length) { writeSync(fd, buf); buf = ""; } };
    const head = Object.assign({}, st); delete head.agents;
    const hj = JSON.stringify(head);
    buf += (hj === "{}" ? "{" : hj.slice(0, -1) + ",") + '"agents":{';
    let first = true;
    for (const k in st.agents) {
      buf += (first ? "" : ",") + JSON.stringify(k) + ":" + JSON.stringify(st.agents[k]);
      first = false;
      if (buf.length > 4_000_000) flush();
    }
    buf += "}}";
    flush();
  } finally { closeSync(fd); }
  renameSync(tmp, p);
}

// fix 2026-09-03 H238: MAX_BYTES was enforced only inside fetchJson; tokenUri read the RPC answer with a
// bare res.json(), unbounded, in a 768 MiB-capped process. Same bounded read, its own limit because an
// eth_call answer is hex-encoded (two characters per byte) and a data: URI registration is legitimately
// larger than a metadata document. VERIFY_RPC_MAX_BYTES=0 restores the unbounded read.
const RPC_MAX_BYTES = Number(process.env.VERIFY_RPC_MAX_BYTES ?? 1_048_576);
async function jsonCapped(res, max) {
  if (!(max > 0)) return res.json();
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) throw new Error("body too large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// follow=true only for our own data sources (8004scan, and the IPFS gateway this file picks at line 21);
// agent endpoints never follow redirects (a redirect could point at a private address, the same rule
// probe.js enforces).
async function fetchJson(url, ms, follow) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: follow ? "follow" : "manual", headers: scanHeaders(url) }); // 2026-09-05: the Pro key only when url is the directory
    if (res.status >= 300 && res.status < 400) throw new Error("redirect " + res.status);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error("body too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { clearTimeout(t); }
}

// ---- stage 1: enumerate from 8004scan (index of every registration on this chain) ----
export async function enumerateAgents({ pageSize = 100, maxPages = Infinity, log = () => {} } = {}) {
  const idx = loadJsonStrict(INDEX_FILE, { chainId: CHAIN_ID, total: null, offset: 0, agents: {} });
  let pages = 0;
  while (pages < maxPages) {
    const url = `${SCAN_API}/agents?limit=${pageSize}&chain_id=${CHAIN_ID}&offset=${idx.offset}`;
    // one slow or failed page must not end a 2,800-page run: retry with backoff, then wait a minute and go on
    let d = null;
    for (let attempt = 0; attempt < 6 && !d; attempt++) {
      try { d = await fetchJson(url, 20_000, true); }
      catch (e) { log(`enumerate: page at offset ${idx.offset} failed (${e.message}), attempt ${attempt + 1}`); await new Promise((r) => setTimeout(r, Math.min(60_000, 5_000 * 3 ** attempt))); }
    }
    if (!d) { log("enumerate: giving up on this page for now, will resume from the saved offset next run"); break; }
    idx.total = d.total ?? idx.total;
    const items = d.items || [];
    if (!items.length) break;
    const page = {}; // fix 2026-09-02 H86: this page's entries, merged into the disk copy under the lock
    for (const x of items) {
      page[String(x.token_id)] = idx.agents[String(x.token_id)] = {
        id: Number(x.token_id), name: x.name || null, owner: x.owner_address || null,
        protocols: x.supported_protocols || [], x402: !!x.x402_supported,
        feedbacks: x.total_feedbacks ?? 0, score: x.total_score ?? null, testnet: !!x.is_testnet,
        registeredAt: x.created_at || null,
      };
    }
    idx.offset += items.length;
    pages++;
    idx.updated = Date.now();
    saveIndexMerged(idx, page, ["total", "offset", "updated"]); // fix 2026-09-02 H86
    log(`enumerate: ${idx.offset}/${idx.total} indexed`);
    if (idx.offset >= (idx.total || 0)) break;
    await new Promise((r) => setTimeout(r, 400)); // 150/min, under the 180/min free limit
  }
  saveJson(INDEX_META_FILE, indexMeta(idx)); // memory fix 2026-08-26: the sidecar exists even when the index was already complete
  return { indexed: Object.keys(idx.agents).length, total: idx.total, offset: idx.offset };
}

// ---- stage 1b: keep up with the registry (operator 2026-08-24: the total moves hourly, a backfill is not a
// live index). Reads the NEWEST registrations first and stops at the first id already known; new ones are
// probed right away because a fresh registration is the likeliest to be alive. Run every few minutes.
export async function enumerateNew({ pageSize = 100, maxPages = 20, log = () => {} } = {}) {
  const idx = loadJsonStrict(INDEX_FILE, { chainId: CHAIN_ID, total: null, offset: 0, agents: {} });
  const fresh = [];
  for (let page = 0; page < maxPages; page++) {
    const url = `${SCAN_API}/agents?limit=${pageSize}&chain_id=${CHAIN_ID}&offset=${page * pageSize}`;
    let d = null;
    try { d = await fetchJson(url, 20_000, true); } catch (e) { log(`enumerate-new: page ${page} failed (${e.message})`); break; }
    idx.total = d.total ?? idx.total;
    const items = d.items || [];
    if (!items.length) break;
    let hitKnown = false;
    for (const x of items) {
      const key = String(x.token_id);
      if (idx.agents[key]) { hitKnown = true; continue; }
      idx.agents[key] = { id: Number(x.token_id), name: x.name || null, owner: x.owner_address || null, protocols: x.supported_protocols || [], x402: !!x.x402_supported,
        feedbacks: x.total_feedbacks ?? 0, score: x.total_score ?? null, testnet: !!x.is_testnet, registeredAt: x.created_at || null };
      fresh.push(idx.agents[key]);
    }
    if (hitKnown) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  idx.updated = Date.now();
  idx.newestSeenAt = Date.now();
  { const added = {}; for (const a of fresh) added[String(a.id)] = a; saveIndexMerged(idx, added, ["total", "updated", "newestSeenAt"]); } // fix 2026-09-02 H86
  if (fresh.length) {
    // bounded and concurrent: newest first, at most PROBE_NEW_MAX per run, 6 at a time; the batch loop
    // picks up whatever is left (unprobed entries rank first there too)
    const todo = fresh.filter((a) => !a.testnet).slice(0, Number(process.env.PROBE_NEW_MAX || 150));
    // memory fix 2026-08-26: no state parse here (it was loaded and never read); history comes from mergeSave
    const touched = {}; const counts = {}; let i = 0;
    async function worker() {
      while (i < todo.length) {
        const e = todo[i++];
        let rec; try { rec = await probeAgent(e); } catch (err) { rec = { id: e.id, probedAt: Date.now(), status: "dead", reason: "probe: " + err.message }; }
        rec.name = e.name; rec.owner = e.owner;
        touched[String(e.id)] = rec; counts[rec.status] = (counts[rec.status] || 0) + 1;
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    mergeSave(touched);
    log(`enumerate-new: ${fresh.length} new registrations (total now ${idx.total}), probed ${todo.length} ${JSON.stringify(counts)}`);
  } else log(`enumerate-new: nothing new, total ${idx.total}`);
  return { fresh: fresh.length, total: idx.total };
}

// ---- stage 2: probe one agent from its own registration ----
async function tokenUri(id) {
  const data = TOKEN_URI_SELECTOR + BigInt(id).toString(16).padStart(64, "0");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    // 2026-09-05: read through rpc.js (primary, then the fallback on an availability-shaped failure); the byte cap
    // (fix 2026-09-03 H238) is passed through.
    const hex = await rpcRead("eth_call", [{ to: CATALOG.registry, data }, "latest"], { signal: ctrl.signal, maxBytes: RPC_MAX_BYTES });
    if (!hex || hex === "0x") return null;
    const buf = Buffer.from(hex.slice(2), "hex");
    const len = Number(BigInt("0x" + buf.subarray(32, 64).toString("hex")));
    return buf.subarray(64, 64 + len).toString("utf8");
  } finally { clearTimeout(t); }
}

async function readMetadata(uri) {
  if (!uri) return null;
  if (uri.startsWith("data:application/json;base64,")) return JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8"));
  if (uri.startsWith("data:application/json,")) return JSON.parse(decodeURIComponent(uri.slice(22)));
  // fix 2026-09-03 H89: the third argument was omitted, so this call ran redirect:"manual" and every
  // gateway 301 became `registration: redirect 301` and a dead record (19 such records in the state at
  // audit time). IPFS_GATEWAY is our own chosen gateway, not an agent-controlled address, so it belongs
  // with 8004scan in the follow=true class; agent endpoints below still never follow.
  // VERIFY_IPFS_FOLLOW=0 restores redirect:"manual" on this call.
  if (uri.startsWith("ipfs://")) return fetchJson(IPFS_GATEWAY + uri.slice(7), 8_000, IPFS_FOLLOW);
  if (probeAllowed(uri)) return fetchJson(uri, 8_000);
  return null;
}

function summarizeCard(card) {
  if (!card || typeof card !== "object") return null;
  const skills = Array.isArray(card.skills) ? card.skills.map((s) => (s && (s.id || s.name)) || "").filter(Boolean).slice(0, 20) : [];
  return {
    name: card.name || null,
    url: card.url || null,
    version: card.version || null,
    skills,
    negotiate: skills.some((s) => /negotiate/i.test(String(s))),
    protocolVersion: card.protocolVersion || null,
  };
}

export async function probeAgent(entry) {
  const started = Date.now();
  const rec = { id: entry.id, probedAt: started, status: "dead", endpoint: null, card: null, reason: null, ms: null, x402: !!entry.x402 };
  let uri = null, meta = null;
  try { uri = await tokenUri(entry.id); } catch (e) { rec.reason = "tokenURI: " + e.message; }
  if (!uri) { rec.reason = rec.reason || "no tokenURI"; rec.ms = Date.now() - started; return rec; }
  rec.uriKind = uri.startsWith("data:") ? "data" : uri.startsWith("ipfs://") ? "ipfs" : "https";
  try { meta = await readMetadata(uri); } catch (e) { rec.reason = "registration: " + e.message; }
  if (!meta) { rec.reason = rec.reason || "registration file unreadable"; rec.ms = Date.now() - started; return rec; }
  rec.declaredServices = Array.isArray(meta.services) ? meta.services.length : 0;
  const declared = extractEndpoint(meta);
  // fix 2026-09-05 (brief part 4): substitute an endpoint template ({agentId} and kin) with this
  // registration's own id before probing; the declared form is kept in rawEndpoint. Flag-gated, see header.
  const resolved = RESOLVE_TEMPLATES ? resolveEndpointTemplate(declared, entry.id) : { url: declared, raw: null };
  const endpoint = resolved.url;
  if (resolved.raw) rec.rawEndpoint = resolved.raw;
  if (!endpoint || !probeAllowed(endpoint)) { rec.reason = endpoint ? "endpoint not probeable" : "no https endpoint declared"; rec.ms = Date.now() - started; return rec; }
  rec.endpoint = cardUrl(endpoint);
  try {
    const card = await fetchJson(rec.endpoint, 6_000);
    rec.card = summarizeCard(card);
    rec.status = rec.card ? ((rec.card.negotiate || entry.x402) ? "hireable" : "alive") : "offline";
    if (!rec.card) rec.reason = "card not an object";
  } catch (e) {
    // fix 2026-09-05: 401/403 is `gated` (answers, needs auth, not determinable anonymously), flag-gated.
    rec.status = cardFailureStatus(e);
    rec.reason = (rec.status === "gated" ? "card: " + e.message + " (authentication required; not determinable by an anonymous probe)" : "card: " + e.message);
  }
  rec.ms = Date.now() - started;
  return rec;
}


// Several processes (batch loop, 60 s live loop, on-demand verifies) write the state; a save must never
// overwrite records another process refreshed. Reload, apply only the records this call touched, write.
function mergeSave(touched) {
  if (SPOOL_ONLY) return spoolWrite(touched); // memory fix 2026-09-02: the capped server never parses the state
  return withLock(STATE_FILE, () => mergeSaveLocked(touched));
}
function mergeSaveLocked(touched) {
  const cur = loadJsonStrict(STATE_FILE, { chainId: CHAIN_ID, agents: {} });
  // memory fix 2026-09-02: drain the server's spool first, oldest probe first, so its records get the same
  // history derivation and newest-wins rule as this process's own; the files are removed after the save.
  const spooled = spoolFiles();
  const ordered = [];
  for (const f of spooled) {
    try { const rec = JSON.parse(readFileSync(SPOOL_DIR + f.name, "utf8")); delete rec.history; ordered.push([f.id, rec]); } catch {}
  }
  for (const [k, v] of Object.entries(touched)) ordered.push([k, v]);
  for (const [k, v] of ordered) {
    const prev = cur.agents[k];
    // memory fix 2026-08-26: history is derived here, at merge time, so callers never parse the full
    // state file just to read one record's history (the state file is 112 MB, 400 MB parsed).
    if (!v.history) v.history = ((prev && prev.history) || []).concat([{ t: v.probedAt, s: v.status }]).slice(-10);
    if (!prev || (v.probedAt || 0) >= (prev.probedAt || 0)) cur.agents[k] = v; // newest probe wins
  }
  cur.updated = Date.now();
  saveState(STATE_FILE, cur);
  for (const f of spooled) { try { unlinkSync(SPOOL_DIR + f.name); } catch {} } // consumed; a newer spool file has a newer name
  try { saveJson(LIVE_FILE, buildLiveMap(cur)); } catch {}
  return cur;
}
// ---- runner over the index: probe N agents, most promising first, persist state ----
export async function probeBatch({ batch = 200, concurrency = 4, log = () => {} } = {}) {
  // memory fix 2026-08-26: only probedAt per id is kept from the state file, parsed BEFORE the index so the
  // two parses (400 MB and 300 MB) are never live together; mergeSave parses the state again only when it writes.
  let lastProbed = {};
  { const st = loadJsonStrict(STATE_FILE, { chainId: CHAIN_ID, agents: {} }); for (const [k, r] of Object.entries(st.agents)) lastProbed[k] = r.probedAt || 0; }
  let idx = loadJsonStrict(INDEX_FILE, null);
  if (!idx) throw new Error("no index; run enumerate first");
  const entries = Object.values(idx.agents).filter((a) => !a.testnet);
  idx = null;
  // priority: never probed first; among those, x402 or protocols or feedback first; then oldest probe
  const rank = (a) => {
    const promise = (a.x402 ? 4 : 0) + (a.protocols.length ? 2 : 0) + (a.feedbacks > 0 ? 1 : 0);
    return (lastProbed[String(a.id)] || 0) * 10 - promise;
  };
  entries.sort((a, b) => rank(a) - rank(b));
  const todo = entries.slice(0, batch);
  let i = 0, done = 0;
  const counts = {};
  const touched = {}; // fix 2026-09-03 H88: declared before the closure that writes it; it was below worker,
  // so any future early call of worker (a pre-warm, a retry, a log hook) would have hit the temporal dead
  // zone and killed the whole probe batch with a ReferenceError.
  async function worker() {
    while (i < todo.length) {
      const e = todo[i++];
      let rec;
      try { rec = await probeAgent(e); } catch (err) { rec = { id: e.id, probedAt: Date.now(), status: "dead", reason: "probe: " + err.message }; }
      rec.name = e.name; rec.owner = e.owner;
      touched[String(e.id)] = rec; // history is filled in by mergeSave
      counts[rec.status] = (counts[rec.status] || 0) + 1;
      done++;
      if (done % 25 === 0) { mergeSave(touched); log(`probe: ${done}/${todo.length} ${JSON.stringify(counts)}`); }
    }
  }
  lastProbed = null;
  await Promise.all(Array.from({ length: concurrency }, worker));
  mergeSave(touched);
  return { probed: done, counts };
}

// Probe a named list of ids (control runs, re-checks). Uses index entries when present.
// memory fix 2026-09-02: in the capped server, calls that need the index parse run one at a time (each parse is
// about 260 MB of heap; two at once would cross the 512 MB cap). Known-map ids never wait.
let _indexTurn = Promise.resolve();
export async function probeIds(ids, { log = () => {} } = {}) {
  if (SPOOL_ONLY) {
    const lm = loadJson(LIVE_FILE, null);
    const known = new Set((lm && Array.isArray(lm.entries) ? lm.entries : []).map((e) => String(e.id)));
    if (ids.some((id) => !known.has(String(id)))) {
      const run = _indexTurn.then(() => probeIdsNow(ids, { log }));
      _indexTurn = run.catch(() => {});
      return run;
    }
  }
  return probeIdsNow(ids, { log });
}
async function probeIdsNow(ids, { log = () => {} } = {}) {
  // memory fix 2026-08-26: the index (58 MB) is parsed once, the needed entries copied out, and the parse
  // released before probing; the state file is parsed only inside mergeSave. Before this, a 60 s live pass
  // held three parses of the state plus the index (1.5 GB) and got postgres OOM-killed three times.
  let entries;
  // memory fix 2026-09-02: in the capped server an id already on the 200 KB live map needs no parse of the
  // 58 MB index (about 200 MB of heap per call; four concurrent calls would cross the 512 MB cap).
  const fromMap = {};
  if (SPOOL_ONLY) { const lm = loadJson(LIVE_FILE, null); if (lm && Array.isArray(lm.entries)) for (const e of lm.entries) fromMap[String(e.id)] = { id: e.id, name: e.name, owner: e.owner, protocols: [], x402: !!e.x402, feedbacks: 0 }; }
  const missing = ids.filter((id) => !fromMap[String(id)]);
  { const idx = missing.length ? loadJsonStrict(INDEX_FILE, { agents: {} }) : { agents: {} };
    // unknown: true marks an id that is neither on the live map nor in the index; if its on-chain registration
    // is also absent the probe result is answered but never persisted (fix 2026-09-02: any numeric id used to
    // become a "dead" agent record in the state file).
    entries = ids.map((id) => fromMap[String(id)] || idx.agents[String(id)] || { id: Number(id), name: null, owner: null, protocols: [], x402: false, feedbacks: 0, unknown: true }); }
  return probeEntries(entries, { log });
}
export async function probeEntries(entries, { log = () => {} } = {}) {
  const out = [];
  const touched = {};
  for (const e of entries) {
    let rec;
    try { rec = await probeAgent(e); } catch (err) { rec = { id: e.id, probedAt: Date.now(), status: "dead", reason: "probe: " + err.message }; }
    rec.name = e.name; rec.owner = e.owner;
    if (e.unknown && rec.reason === "no tokenURI") { rec.unregistered = true; out.push(rec); continue; } // not in the registry: answer, do not persist
    touched[String(e.id)] = rec;
    out.push(rec);
    log(`probe-ids: ${e.id} ${rec.status} ${rec.reason || ""} ${rec.endpoint || ""} ${rec.ms}ms`);
  }
  const merged = mergeSave(touched);
  for (const r of out) { const m = merged.agents[String(r.id)]; if (m && m.history) r.history = m.history; }
  return out;
}

// ---- live layer (operator 2026-08-24 "map should be live") ----
// verifyNow: probe ONE agent right now and persist; the answer is as of this second, never a cached line.
export async function verifyNow(id) {
  const out = await probeIds([id]);
  return out[0];
}
// livePass: re-probe every agent whose last status is alive or hireable (the map itself); meant to run
// about every 60 s from scripts/verify_live.sh (deadline sleep since fix 2026-09-02 H303); an entry's ageSeconds is the
// measurement, the period is a target, not a bound.
export async function livePass({ log = () => {} } = {}) {
  // memory fix 2026-08-26: the alive + hireable id list comes from the 200 KB live map (rewritten on every
  // state save by mergeSave), not from a parse of the full state file.
  const lm = loadJson(LIVE_FILE, null);
  let out;
  if (lm && Array.isArray(lm.entries) && lm.entries.length && lm.entries.every((e) => "x402" in e)) {
    // the map carries name, owner and x402 (all probeAgent reads from an index entry): no index parse
    out = await probeEntries(lm.entries.map((e) => ({ id: e.id, name: e.name, owner: e.owner, protocols: [], x402: !!e.x402, feedbacks: 0 })), { log: () => {} });
  } else {
    let ids;
    if (lm && Array.isArray(lm.entries)) ids = lm.entries.map((e) => e.id);
    else { const st = loadJsonStrict(STATE_FILE, { agents: {} }); ids = Object.values(st.agents).filter((r) => r.status === "alive" || r.status === "hireable").map((r) => r.id); }
    if (!ids.length) return { probed: 0 };
    out = await probeIds(ids, { log: () => {} });
  }
  const counts = {};
  for (const r of out) counts[r.status] = (counts[r.status] || 0) + 1;
  log(`live: ${out.length} re-probed ${JSON.stringify(counts)}`);
  return { probed: out.length, counts };
}
// liveMap: what an agent reads. Only alive and hireable entries, each with its age in seconds; a version
// (max probedAt) so a reader holding the same version knows nothing changed.
export function liveMap() {
  const cached = loadJson(LIVE_FILE, null);
  if (cached && cached.entries) {
    const now = Date.now();
    cached.entries.forEach((e) => { e.ageSeconds = Math.round((now - e.probedAt) / 1000); });
    cached.generated = now;
    return cached;
  }
  return buildLiveMap(loadJson(STATE_FILE, { agents: {}, updated: 0 }));
}
// fix 2026-09-02 H73: the ladder had no "verified" rung although the evidence existed (test-hire records);
// status stays the liveness word every consumer filters on, rung is the trust ladder.
const RUNG = process.env.VERIFY_RUNG !== "0";
export const RUNGS = {
  verified: "a paid ERC-8183 test job was hired, funded and delivered by this agent; the test record carries the tx hashes and, where the evidence writer had gas, the Greenfield object",
  hireable: "the agent card loaded and declares a negotiate skill or x402, and the agent did not refuse when asked",
  alive: "the agent card loaded on the newest probe",
};
const RUNG_RANK = { verified: 0, hireable: 1, alive: 2 };
// fix 2026-09-02 H318: `delivered: false` covered three different outcomes, one of them our own spend cap
// (run_cap_reached) and one a failure on our side (error). Now: true = delivered, false = the agent was asked
// and did not deliver or refused, null = the test ended on our side (no verdict on the agent). The map
// carries the legend (tests) next to rungs. VERIFY_TEST_TRISTATE=0 restores the plain boolean.
const TRISTATE = process.env.VERIFY_TEST_TRISTATE !== "0";
export const TESTS = {
  kinds: { erc8183_hire: "a paid hire through the ERC-8183 escrow flow (quote, createJob, fund, deliverable, settle)", skill_call: "a direct A2A skill call with no payment" },
  results: { delivered: "the agent returned a deliverable", not_delivered: "the agent answered the call but returned no deliverable", negotiate_refused: "the agent refused the quote request",
    run_cap_reached: "our test budget for the run ended before this agent was tested to completion; not a verdict on the agent", error: "the test failed on our side before a verdict; not a verdict on the agent" },
  delivered: "true = delivered; false = asked and did not deliver or refused; null = no verdict (run_cap_reached, error)",
  exampleDeclared: "skill_call only, since 2026-09-05: true = the request we sent was the example the agent's own card declares; false = the card declares no example, so we sent a generic sentence and the result is a liveness check, not a hire; absent = tested before the field existed",
  evidence: "set only where a Greenfield object was written for the test record (delivered and negotiate_refused runs); null elsewhere",
  ...(process.env.VERIFY_TEST_AGE !== "0" ? { ageDays: "how old this test verdict is, in days, at the time the map was generated. The entry's own ageSeconds is the age of the liveness probe and is unrelated: a fresh probe can sit beside a test verdict that is days old" } : {}), // fix 2026-09-03 H319
};
// fix 2026-09-03 H319: `ageSeconds` on the entry is the age of the liveness probe, in seconds, while the
// `test` verdict beside it can be days older (measured 2026-09-02: test.at oldest 2026-08-24T17:27:18.915Z,
// newest 2026-09-02T01:31:18.958Z, 7 of 177 tests older than 7 days). Both shipped in the same object with
// nothing separating them, so an entry read as 77 seconds fresh while its delivered/result verdict was from
// eight days earlier. The test carries its own age now. VERIFY_TEST_AGE=0 restores the old shape.
const TEST_AGE = process.env.VERIFY_TEST_AGE !== "0";
function testAgeDays(at, now) {
  const t = Date.parse(at);
  return Number.isFinite(t) ? Math.round(((now - t) / 86_400_000) * 10) / 10 : null;
}

function deliveredOf(t) {
  if (!TRISTATE) return !!t.delivered;
  if (t.delivered) return true;
  return (t.result === "run_cap_reached" || t.result === "error") ? null : false;
}
export function rungOf(status, t) {
  return (t && t.kind === "erc8183_hire" && t.result === "delivered" && !!t.delivered && status === "hireable") ? "verified" : status;
}
// fix 2026-09-02 H264 wording, hoisted 2026-09-03 H69 so summary() states the same thing.
export const REGISTRY_NOTE = "total is the count the 8004scan directory reports in its listing response; indexed is the number of distinct registrations this index has received from that listing (nothing is removed once seen). Measured 2026-08-24 to 2026-09-03: the listing handed over 29,050 new registrations while the reported total rose by 20,463, so the directory's total is not a count of what it lists and indexed can exceed it; indexedAt is the time the newest registration was seen, not when the index was written";

// 2026-09-03 (product idea 6): the map can name the published probe method (docs/PROBE_SPEC.md in the repository)
// so anyone can re-run a probe and compare. Off until VERIFY_METHOD_URL is set on the loop's environment (the
// repository is private until the operator flips it; the link is set in the same step). Empty or unset omits the field.
const METHOD_URL = process.env.VERIFY_METHOD_URL || "";
export function buildLiveMap(st) {
  const now = Date.now();
  // last test-hire per agent (scripts/test_hire.mjs): did it deliver when asked, and how fast
  const th = loadJson(new URL("../data/testhire.json", import.meta.url).pathname, { agents: {} }).agents || {};
  const entries = Object.values(st.agents)
    .filter((r) => r.status === "alive" || r.status === "hireable")
    .map((r) => {
      const t = th[String(r.id)] && th[String(r.id)][0];
      // a card may declare negotiate and still refuse everyone: hireable means it answered when asked
      const status = (t && t.kind === "erc8183_hire" && t.result === "negotiate_refused" && r.status === "hireable") ? "alive" : r.status;
      const rung = rungOf(status, t);
      return { id: r.id, name: r.name, owner: r.owner ?? null, x402: !!r.x402, status, ...(RUNG ? { rung, verified: rung === "verified" } : {}), endpoint: r.endpoint, skills: r.card && r.card.skills, probedAt: r.probedAt, ageSeconds: Math.round((now - r.probedAt) / 1000), ms: r.ms,
        test: t ? { at: t.at, ...(TEST_AGE ? { ageDays: testAgeDays(t.at, now) } : {}), kind: t.kind, result: t.result, delivered: deliveredOf(t), latencyMs: t.latencyMs ?? null, bytes: t.bytes ?? null, evidence: t.evidence ? t.evidence.url : null } : null }; // fix 2026-09-02 H318, fix 2026-09-03 H319
    })
    .sort((a, b) => { const ra = RUNG_RANK[a.rung ?? a.status] ?? 9, rb = RUNG_RANK[b.rung ?? b.status] ?? 9; return ra === rb ? a.id - b.id : ra - rb; }); // fix 2026-09-02 H73: verified first
  const version = entries.reduce((m, e) => Math.max(m, e.probedAt || 0), 0);
  let registry = { total: null, indexedAt: null, indexed: null };
  const meta = loadJson(INDEX_META_FILE, null);
  if (meta && meta.indexed != null) registry = { total: meta.total, indexedAt: meta.indexedAt, indexed: meta.indexed };
  else { try { const idx = loadJson(INDEX_FILE, null); if (idx) registry = { total: idx.total, indexedAt: idx.newestSeenAt || idx.updated || null, indexed: Object.keys(idx.agents).length }; } catch {} }
  // fix 2026-09-02 H264: three numbers from two sources read as broken arithmetic (indexed above total). Say what each is.
  registry = { ...registry, directoryTotal: registry.total, newestRegistrationAt: registry.indexedAt,
    note: REGISTRY_NOTE }; // fix 2026-09-03 H69: one constant, so summary() and the map cannot drift apart
  const probedTotal = Object.keys(st.agents).length;
  // fix 2026-09-05 (brief part 4): the gated population is counted separately wherever totals are served;
  // it is neither answered nor "did not answer", and the old scope sentence folded it into the latter.
  let gatedTotal = 0; for (const r of Object.values(st.agents)) if (r.status === "gated") gatedTotal++;
  // 2026-09-05 (build B4): the hireability count, from the newest test per agent. How many agents on this
  // registry can be asked for work: sellers that delivered a paid job, and skill agents that answered
  // the example their own card declares. Published here because nobody else measures it.
  const hireability = { tested: 0, sellers: { tested: 0, delivered: 0, refused: 0 }, skillAgents: { tested: 0, exampleDeclared: 0, answeredOwnExample: 0, noAnswerOwnExample: 0, noExampleDeclared: 0, unknownExample: 0 } };
  for (const recs of Object.values(th)) {
    const t = Array.isArray(recs) ? recs[0] : null; if (!t) continue;
    hireability.tested++;
    if (t.kind === "erc8183_hire") { hireability.sellers.tested++; if (t.result === "delivered") hireability.sellers.delivered++; if (t.result === "negotiate_refused") hireability.sellers.refused++; }
    else if (t.kind === "skill_call") {
      hireability.skillAgents.tested++;
      if (t.exampleDeclared === true) { hireability.skillAgents.exampleDeclared++; if (t.delivered) hireability.skillAgents.answeredOwnExample++; else hireability.skillAgents.noAnswerOwnExample++; }
      else if (t.exampleDeclared === false) hireability.skillAgents.noExampleDeclared++;
      else hireability.skillAgents.unknownExample++;
    }
  }
  hireability.note = "newest test per agent; sellers.delivered = paid ERC-8183 jobs delivered; skillAgents.answeredOwnExample = agents that answered the example their own card declares; noExampleDeclared = cards that publish no example, so nothing a buyer could send was tested; unknownExample = tested before 2026-09-05";
  // fix 2026-09-02 H144: "probed 300,000" and "184 answering" are both true and read differently; the map says both.
  const scope = `${probedTotal} registrations probed from their own on-chain record; ${entries.length} answered on their newest probe (alive or hireable, ${probedTotal ? (100 * entries.length / probedTotal).toFixed(3) : "0"} percent); ${gatedTotal} declared an endpoint that answers but requires authentication (gated, not determinable by an anonymous probe); the rest declared no usable https endpoint or did not answer`;
  return { version, generated: now, count: entries.length, probedTotal, gatedTotal, scope, registry, hireability, ...(METHOD_URL ? { method: METHOD_URL } : {}), ...(RUNG ? { rungs: RUNGS } : {}), ...(TRISTATE ? { tests: TESTS } : {}), entries }; // fix 2026-09-02 H318: legend; 2026-09-03 method
}

export function summary() {
  // memory fix 2026-08-26: state and index are parsed one after the other, never held together.
  let counts = {}, hireable, probed;
  { const st = loadJson(STATE_FILE, { agents: {} });
    for (const r of Object.values(st.agents)) counts[r.status] = (counts[r.status] || 0) + 1;
    hireable = Object.values(st.agents).filter((r) => r.status === "hireable").map((r) => ({ id: r.id, name: r.name, endpoint: r.endpoint, skills: r.card && r.card.skills }));
    probed = Object.keys(st.agents).length; }
  let indexed, registryTotal;
  const meta = loadJson(INDEX_META_FILE, null);
  if (meta && meta.indexed != null) { indexed = meta.indexed; registryTotal = meta.total; }
  else { const idx = loadJson(INDEX_FILE, { agents: {}, total: null }); indexed = Object.keys(idx.agents).length; registryTotal = idx.total; }
  // fix 2026-09-03 H69: summary() reported `indexed` and `registryTotal` side by side with nothing saying
  // what either is, so a reader saw "300,089 of 299,344 indexed" and read broken arithmetic. Same note the
  // live map's registry block carries under H264, in the same words, so the two surfaces cannot drift apart.
  return { indexed, registryTotal, probed, counts, hireable, note: REGISTRY_NOTE };
}
