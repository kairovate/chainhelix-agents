// Tiny TTL cache. get() returns undefined past the TTL; getStale() returns the
// last value regardless of age (fallback when an upstream is down, callers
// must label stale data as stale).
const store = new Map();

export function get(key) {
  const e = store.get(key);
  if (!e) return undefined;
  return Date.now() < e.expires ? e.value : undefined;
}

export function getStale(key) {
  const e = store.get(key);
  return e ? { value: e.value, storedAt: e.storedAt } : undefined;
}

// fix 2026-09-03 H122 H184 H185: the old prune fired only above 5000 entries and removed only entries that
// were ALREADY expired, so 5000 was not a cap (9000 live entries were retained, measured) and the entries it
// did remove were exactly the ones getStale exists to serve as the upstream-down fallback. One mechanism for
// all three: no bulk expiry sweep, a real ceiling, and eviction by oldest write so a stale fallback survives
// until the store actually needs the room. Re-inserting on set keeps the Map in oldest-write-first order.
// MARKETPLACE_CACHE_BOUND=0 restores the old expired-only prune. MARKETPLACE_CACHE_MAX sets the ceiling.
const CACHE_BOUND = process.env.MARKETPLACE_CACHE_BOUND !== "0";
const MAX_ENTRIES = Number(process.env.MARKETPLACE_CACHE_MAX || 5000);
export function set(key, value, ttlMs) {
  if (CACHE_BOUND) store.delete(key); // re-insert: newest write goes to the end of the iteration order
  store.set(key, { value, storedAt: Date.now(), expires: Date.now() + ttlMs });
  if (!CACHE_BOUND) {
    if (store.size > 5000) {
      const now = Date.now();
      for (const [k, e] of store) if (e.expires < now) store.delete(k);
    }
    return;
  }
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

// fix 2026-09-03 H123 H186: get() returns undefined for "absent", for "past the TTL" and for "the stored
// value is undefined", so a fetcher that resolves undefined was re-run on every call and never cached.
// getFresh separates the three with a sentinel; get() keeps its public undefined contract for callers.
// MARKETPLACE_CACHE_UNDEFINED=0 restores the old behaviour (a stored undefined reads as a miss).
const MISS = Symbol("cache miss");
const CACHE_UNDEFINED = process.env.MARKETPLACE_CACHE_UNDEFINED !== "0";
function getFresh(key) {
  if (!CACHE_UNDEFINED) { const v = get(key); return v === undefined ? MISS : v; }
  const e = store.get(key);
  if (!e) return MISS;
  return Date.now() < e.expires ? e.value : MISS;
}

// De-duplicate concurrent fetches of the same key.
const inflight = new Map();
export async function cached(key, ttlMs, fetcher) {
  const hit = getFresh(key); // fix 2026-09-03 H123 H186
  if (hit !== MISS) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await fetcher();
      set(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}
