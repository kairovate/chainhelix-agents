// Central config, no secrets anywhere in this service; it holds no keys and
// signs nothing. All values overridable by env for tests.
import { createRequire } from "node:module";
export const PORT = Number(process.env.MARKETPLACE_PORT || 9110);
export const HOST = process.env.MARKETPLACE_HOST || "127.0.0.1";
export const RPC_URL = process.env.RPC_URL || "https://bsc-rpc.publicnode.com";
// 2026-09-05: the directory now serves from its apex host and answers the www host with a 308 to it.
export const SCAN_API = process.env.SCAN_API || "https://8004scan.io/api/v1";
export const SCAN_SITE = "https://8004scan.io";
// 2026-09-05: the directory's agent pages moved from /agents/<chainId>:<registry>:<id> (now 404) to
// /agents/<chain slug>/<id>; "bsc" is the slug it uses for BNB Smart Chain.
export const SCAN_CHAIN_SLUG = "bsc";
// 2026-09-07 (build plan B3): the directory is read through the ONE shared client, shared/directory.cjs at the repo
// root, the same code the ChainHelix MCP runs: https only, private addresses refused, the resolved address pinned,
// redirects followed by hand within the www/apex host family, the Pro key (SCAN_API_KEY, header SCAN_API_KEY_HEADER,
// default x-api-key, read at call time) only to the directory's own host family, a 1 MB body cap, and the listing
// check (200 + items array, or a failure). `directory` holds "unavailable" for SCAN_RETRY_MS (default 60 s) after a
// failure so a page never waits on the timeout twice a minute; `directoryBatch` (the enumerator) has its own retry
// ladder and no hold. DIRECTORY_HOLD_MS overrides the hold for every reader; SCAN_RETRY_MS is the marketplace's name.
const sharedDirectory = createRequire(import.meta.url)("../../shared/directory.cjs");
const HOLD_MS = Number(process.env.DIRECTORY_HOLD_MS ?? process.env.SCAN_RETRY_MS ?? 60_000);
export const directory = sharedDirectory.createDirectory({ apiBase: SCAN_API, site: SCAN_SITE, chainSlug: SCAN_CHAIN_SLUG, chainId: 56, timeoutMs: 10_000, maxBytes: 1_048_576, holdMs: HOLD_MS, name: "marketplace directory", userAgent: "ChainHelix-Marketplace/1 (+https://agents.chainhelix.io)" });
export const directoryBatch = sharedDirectory.createDirectory({ apiBase: SCAN_API, site: SCAN_SITE, chainSlug: SCAN_CHAIN_SLUG, chainId: 56, timeoutMs: 20_000, maxBytes: 1_048_576, holdMs: 0, name: "marketplace enumerator", userAgent: "ChainHelix-Verified/1 (+https://agents.chainhelix.io)" });
export const SCAN_API_KEY = process.env.SCAN_API_KEY || "";
export const SCAN_API_KEY_HEADER = process.env.SCAN_API_KEY_HEADER || "x-api-key";
export function scanHeaders(url) { return directory.headers(url); }
export function scanAgentUrl(erc8004Id) { return directory.agentUrl(erc8004Id); }
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
