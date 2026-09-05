// Central config, no secrets anywhere in this service; it holds no keys and
// signs nothing. All values overridable by env for tests.
export const PORT = Number(process.env.MARKETPLACE_PORT || 9110);
export const HOST = process.env.MARKETPLACE_HOST || "127.0.0.1";
export const RPC_URL = process.env.RPC_URL || "https://bsc-rpc.publicnode.com";
// 2026-09-05: the directory now serves from its apex host and answers the www host with a 308 to it.
export const SCAN_API = process.env.SCAN_API || "https://8004scan.io/api/v1";
export const SCAN_SITE = "https://8004scan.io";
// 2026-09-05: the directory's agent pages moved from /agents/<chainId>:<registry>:<id> (now 404) to
// /agents/<chain slug>/<id>; "bsc" is the slug it uses for BNB Smart Chain.
export const SCAN_CHAIN_SLUG = "bsc";
// 2026-09-05: the 8004scan Pro tier key, from the unit environment only (SCAN_API_KEY; header name SCAN_API_KEY_HEADER,
// default x-api-key). The header goes ONLY to the directory's own host family, never to an agent endpoint or a gateway.
export const SCAN_API_KEY = process.env.SCAN_API_KEY || "";
export const SCAN_API_KEY_HEADER = process.env.SCAN_API_KEY_HEADER || "x-api-key";
function hostFamily(h) { return String(h || "").toLowerCase().replace(/^www\./, ""); }
export function scanHeaders(url) {
  const h = { Accept: "application/json" };
  const key = process.env.SCAN_API_KEY || SCAN_API_KEY; // read at call time: a key set after boot is used without a restart
  if (!key) return h;
  const name = process.env.SCAN_API_KEY_HEADER || SCAN_API_KEY_HEADER;
  try { if (hostFamily(new URL(url).hostname) === hostFamily(new URL(SCAN_API).hostname)) h[name] = key; } catch { /* not a url */ }
  return h;
}
export function scanAgentUrl(erc8004Id) { return `${SCAN_SITE}/agents/${SCAN_CHAIN_SLUG}/${Number(erc8004Id)}`; }
export const BSCSCAN = "https://bscscan.com";
export const NETWORK = "bsc-mainnet";
export const CHAIN_ID = 56;

export const CATEGORIES = ["rebalancing", "grid", "yield", "health"];

// Discovery: 8004scan free-text search terms per category. An agent qualifies
// only if its name or description ALSO matches the category pattern, search
// alone is too loose.
export const DISCOVERY = {
  rebalancing: { search: "rebalance", pattern: /rebalanc/i },
  grid: { search: "grid", pattern: /grid/i },
  yield: { search: "yield", pattern: /yield/i },
  health: { search: "health", pattern: /health|liquidat|lending/i },
};
export const DISCOVERY_CAP = 8; // per category; capped, not truncated silently, the API reports the cap

export const TTL = {
  quote: 45_000, // < quote validity; a displayed price is a real signed quote
  scan: 300_000,
  health: 30_000,
  job: 15_000,
  registration: 3_600_000, // tokenURI metadata, effectively immutable
  tpHealth: 300_000, // third-party card probes, polite cadence, they're not our servers
};

export const RATE_LIMIT = { windowMs: 60_000, max: 120 };
