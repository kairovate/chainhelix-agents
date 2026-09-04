// Central config, no secrets anywhere in this service; it holds no keys and
// signs nothing. All values overridable by env for tests.
export const PORT = Number(process.env.MARKETPLACE_PORT || 9110);
export const HOST = process.env.MARKETPLACE_HOST || "127.0.0.1";
export const RPC_URL = process.env.RPC_URL || "https://bsc-rpc.publicnode.com";
export const SCAN_API = process.env.SCAN_API || "https://www.8004scan.io/api/v1";
export const SCAN_SITE = "https://www.8004scan.io";
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
