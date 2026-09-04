// 8004scan indexer client, the reputation + discovery source. Read-only,
// public API, no auth. Every number returned carries its source link so the
// UI/API can point at where it came from.
import { SCAN_API, SCAN_SITE, CHAIN_ID, DISCOVERY, DISCOVERY_CAP, TTL } from "./config.js";
import { cached, getStale } from "./cache.js";


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
function sameScanOrigin(url) {
  try {
    // same scheme, host and port as the configured endpoint: a redirect may move the path, never the
    // origin, and never downgrade the scheme
    return new URL(url).origin === new URL(SCAN_API).origin;
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
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`8004scan ${res.status}`);
      return await jsonCapped(res);
    }
    let current = `${SCAN_API}${path}`;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        signal: ctrl.signal,
        redirect: "manual", // fix 2026-09-03 H187
        headers: { Accept: "application/json" },
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
  return `${SCAN_SITE}/agents/${item.agent_id}`;
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
    const stale = getStale(`scan:agent:${erc8004Id}`);
    return stale ? { ...stale.value, stale: true } : null;
  });
}

// Third-party discovery: search per category, keep only real category matches,
// drop testnet entries and our own listings.
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
    return {
      agents: items.slice(0, DISCOVERY_CAP).map(publicRecord),
      totalMatched: items.length,
      cap: DISCOVERY_CAP,
    };
  }).catch(() => {
    const stale = getStale(`scan:discover:${category}`);
    return stale
      ? { ...stale.value, stale: true }
      : { agents: [], totalMatched: 0, cap: DISCOVERY_CAP, unavailable: true };
  });
}
