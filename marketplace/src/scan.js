// 8004scan indexer client, the reputation + discovery source. Read-only, public API.
// Every number returned carries its source link so the UI/API can point at where it came from.
// 2026-09-07 (build plan B3): the transport is the ONE shared directory client (shared/directory.cjs, configured in
// config.js as `directory`): the 1 MB cap (redteam A7, 2026-08-20), the by-hand redirects with the www/apex host
// guard (H187 2026-09-03, directory move 2026-09-05), the Pro key header to the directory host only (2026-09-05), the
// listing check (200 with an items array; the directory's DATABASE_ERROR is a 500 with a JSON body, MCP lesson
// 2026-09-05), the private-address refusal and the resolved-address pin (the MCP's M119 rule) and the 60 s hold
// after a failure all live there now and are the same for the marketplace and the MCP. This file keeps what is the
// marketplace's own: the memory cache with its stale fallback, the discovery disk copy, the record shapes.
// SCAN_REDIRECT_STRICT=0 (redirect: "follow") is gone: the guard is the rule for both products.
import { readFileSync, writeFileSync, renameSync } from "fs";
import { SCAN_API, DISCOVERY, DISCOVERY_CAP, TTL, scanAgentUrl, directory } from "./config.js";
import { cached, getStale, set } from "./cache.js";

export function sameScanOrigin(url, apiBase = SCAN_API) { return directory.sameOrigin(url, apiBase); }

// one listing read: HTTP 200 with an items array, or a thrown DirectoryError (the callers' catch is the fallback)
async function scanFetch(path) { return directory.listing(path); }

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
    const d = await scanFetch(`/agents?limit=20&chain_id=${directory.chainId}&search=${q}`);
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
      `/agents?limit=25&chain_id=${directory.chainId}&search=${encodeURIComponent(search)}`
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
