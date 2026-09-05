// 8004scan indexer client, the reputation + discovery source. Read-only,
// public API, no auth. Every number returned carries its source link so the
// UI/API can point at where it came from.
import { readFileSync, writeFileSync, renameSync } from "fs";
import { SCAN_API, CHAIN_ID, DISCOVERY, DISCOVERY_CAP, TTL, scanAgentUrl, scanHeaders } from "./config.js";
import { cached, getStale, set } from "./cache.js";


// 2026-08-20 hardening (redteam A7): bounded body read for external JSON reads.
// A misbehaving upstream must not be able to stream us into the memory limit;
// 1MB is far above any legitimate response on this path.
const MAX_JSON_BYTES = 1_048_576;
async function jsonCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_JSON_BYTES) throw new Error("response body too large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// fix 2026-09-03 H187: this read followed redirects with no per-hop check, while the sibling probe.js
// re-checks its allowlist on every hop ("redirect to disallowed host"). SCAN_API is a fixed operator-set
// endpoint, so this only matters if that endpoint is hijacked, and the 1 MB cap and 10 s abort still
// applied either way; two sibling files should not have two redirect policies for the same class of read.
// Redirects are now followed by hand and every hop must stay on the configured SCAN_API origin over https.
// SCAN_REDIRECT_STRICT=0 restores redirect: "follow".
const REDIRECT_STRICT = process.env.SCAN_REDIRECT_STRICT !== "0";
const MAX_REDIRECTS = 3;
// 2026-09-05: the directory came back from an outage answering every request on its www host with a 308
// to its apex host, and the origin guard here refused that hop ("redirect to disallowed host"), so the
// site read "directory unreachable" while the directory was up. A redirect between the configured host
// and its www or apex twin is the same operator moving the front door, so that one pair is allowed; any
// other host, a different port or a scheme downgrade is still refused.
function scanHostFamily(hostname) {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}
export function sameScanOrigin(url, apiBase = SCAN_API) {
  try {
    const u = new URL(url), c = new URL(apiBase);
    return u.protocol === c.protocol && u.port === c.port && scanHostFamily(u.hostname) === scanHostFamily(c.hostname);
  } catch {
    return false;
  }
}

async function scanFetch(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    if (!REDIRECT_STRICT) {
      const res = await fetch(`${SCAN_API}${path}`, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: scanHeaders(`${SCAN_API}${path}`),
      });
      if (!res.ok) throw new Error(`8004scan ${res.status}`);
      return await jsonCapped(res);
    }
    let current = `${SCAN_API}${path}`;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        signal: ctrl.signal,
        redirect: "manual", // fix 2026-09-03 H187
        headers: scanHeaders(current), // 2026-09-05: the Pro key rides only to the directory's own host
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error("8004scan redirect without location");
        current = new URL(loc, current).href;
        if (!sameScanOrigin(current)) throw new Error("8004scan redirect to disallowed host");
        continue;
      }
      if (!res.ok) throw new Error(`8004scan ${res.status}`);
      return await jsonCapped(res);
    }
    throw new Error("8004scan too many redirects");
  } finally {
    clearTimeout(t);
  }
}

function agentLink(item) {
  return scanAgentUrl(item.token_id); // 2026-09-05: the directory's page scheme changed, see config.js
}

function publicRecord(item) {
  return {
    erc8004Id: Number(item.token_id),
    name: item.name,
    description: item.description || null,
    owner: item.owner_address,
    reputation: {
      totalScore: item.total_score ?? null,
      feedbacks: item.total_feedbacks ?? null,
      healthScore: item.health_score ?? null,
      source: "8004scan",
      link: agentLink(item),
    },
    protocols: item.supported_protocols || [],
    registeredAt: item.created_at || null,
  };
}

// Look one agent up by registry token id (search by name, match exactly).
export async function scanAgent(erc8004Id, nameHint) {
  return cached(`scan:agent:${erc8004Id}`, TTL.scan, async () => {
    const q = encodeURIComponent(nameHint || String(erc8004Id));
    const d = await scanFetch(`/agents?limit=20&chain_id=${CHAIN_ID}&search=${q}`);
    const hit = (d.items || []).find((x) => Number(x.token_id) === Number(erc8004Id));
    return hit ? publicRecord(hit) : null;
  }).catch(() => {
    const key = `scan:agent:${erc8004Id}`;
    const stale = getStale(key);
    return remember(key, stale ? { ...stale.value, stale: true } : null);
  });
}

// 2026-09-05 (directory flapping after its outage: HTTP 500 after the full 10 s on most searches): a failed
// read was never cached, so once the 5 min entry expired every page load waited the 10 s abort for the
// first-party lookups and then another 10 s for discovery, 20 s per page, until one read succeeded. The
// fallback value (stale copy, disk copy, or "unavailable") is now kept for SCAN_RETRY_MS (default 60 s) so
// the page stays fast and the directory is retried once a minute; a fallback keeps the asOf of the copy it
// was made from, never the time it was re-armed.
const RETRY_MS = Number(process.env.SCAN_RETRY_MS || 60_000);
// sweep 2026-09-05: a cached copy carries the directory link as it was built; the directory's page scheme changed
// today, so a copy served from memory or disk gets its link rebuilt from the registry id, never served as stored.
function relink(agents) {
  return (agents || []).map((a) => ({ ...a, reputation: { ...(a.reputation || {}), link: scanAgentUrl(a.erc8004Id) } }));
}
function remember(key, value) {
  set(key, value, RETRY_MS);
  return value;
}

// Third-party discovery: search per category, keep only real category matches,
// drop testnet entries and our own listings.
// 2026-09-05 (sweep, directory outage): the in-memory stale fallback dies with the process, so after a restart
// during an 8004scan outage every lane read "unavailable" although the last good list was known minutes
// earlier. The last successful discovery per category is now also written to disk and served, dated, when
// both the source and the memory cache are empty. DISCOVERY_CACHE_FILE overrides the path; DISCOVERY_DISK_CACHE=0
// disables the disk copy.
const DISK_CACHE = process.env.DISCOVERY_DISK_CACHE !== "0";
const DISK_FILE = process.env.DISCOVERY_CACHE_FILE || new URL("../data/discovery_last_good.json", import.meta.url).pathname;
function diskRead() { try { return JSON.parse(readFileSync(DISK_FILE, "utf8")); } catch { return {}; } }
function diskWrite(category, value) {
  if (!DISK_CACHE) return;
  try {
    const all = diskRead(); all[category] = { value, storedAt: Date.now() };
    writeFileSync(DISK_FILE + ".tmp", JSON.stringify(all)); renameSync(DISK_FILE + ".tmp", DISK_FILE);
  } catch { /* a failed write never breaks the listing */ }
}
export async function discoverCategory(category, excludeIds) {
  const { search, pattern } = DISCOVERY[category];
  return cached(`scan:discover:${category}`, TTL.scan, async () => {
    const d = await scanFetch(
      `/agents?limit=25&chain_id=${CHAIN_ID}&search=${encodeURIComponent(search)}`
    );
    const items = (d.items || [])
      .filter((x) => !x.is_testnet)
      .filter((x) => !excludeIds.has(Number(x.token_id)))
      .filter((x) => pattern.test(`${x.name} ${x.description || ""}`));
    const value = {
      agents: items.slice(0, DISCOVERY_CAP).map(publicRecord),
      totalMatched: items.length,
      cap: DISCOVERY_CAP,
    };
    diskWrite(category, value);
    return value;
  }).catch(() => {
    const key = `scan:discover:${category}`;
    const stale = getStale(key);
    if (stale) return remember(key, { ...stale.value, agents: relink(stale.value.agents), stale: true, asOf: stale.value.asOf ?? stale.storedAt });
    const disk = DISK_CACHE ? diskRead()[category] : null;
    if (disk && disk.value) return remember(key, { ...disk.value, agents: relink(disk.value.agents), stale: true, asOf: disk.storedAt });
    return remember(key, { agents: [], totalMatched: 0, cap: DISCOVERY_CAP, unavailable: true });
  });
}
