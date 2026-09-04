// The catalog: first-party listed agents (catalog.json) merged with
// third-party ERC-8004 agents discovered live from the registry indexer.
// Third-party entries are shown, never endorsed, always "unverified".
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { CATEGORIES, DISCOVERY, SCAN_SITE, BSCSCAN, TTL } from "./config.js";
import { cached } from "./cache.js";
import { scanAgent, discoverCategory } from "./scan.js";
import { displayQuote } from "./quote.js";
import { probeThirdParty } from "./probe.js";
import { jobStatsFor } from "./jobstats.js";

const here = dirname(fileURLToPath(import.meta.url));
export const CATALOG = JSON.parse(readFileSync(join(here, "..", "catalog.json"), "utf8"));

const OUR_IDS = new Set(CATALOG.agents.map((a) => a.erc8004Id));

function identityLinks(erc8004Id, wallet) {
  return {
    scan: `${SCAN_SITE}/agents/${CATALOG.chainId}:${CATALOG.registry.toLowerCase()}:${erc8004Id}`,
    walletOnBscscan: `${BSCSCAN}/address/${wallet}`,
    registryOnBscscan: `${BSCSCAN}/address/${CATALOG.registry}`,
  };
}

// Live reachability: fetch the agent's card with a short timeout. An
// unreachable agent renders OFFLINE, never hidden, never faked.
async function probeStatus(agent) {
  return cached(`health:${agent.id}`, TTL.health, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2_500);
    try {
      const res = await fetch(
        `http://127.0.0.1:${agent.localPort}/.well-known/agent-card.json`,
        { signal: ctrl.signal }
      );
      return res.ok ? "online" : "offline";
    } catch {
      return "offline";
    } finally {
      clearTimeout(t);
    }
  });
}

async function firstPartyEntry(agent) {
  const [status, quote, scan] = await Promise.all([
    probeStatus(agent),
    displayQuote(agent),
    scanAgent(agent.erc8004Id, agent.name),
  ]);
  return {
    id: agent.id,
    listing: "first-party",
    category: agent.category,
    name: agent.name,
    oneLiner: agent.oneLiner,
    status,
    endpoint: agent.endpoint,
    wallet: agent.wallet,
    identity: {
      erc8004Id: agent.erc8004Id,
      registry: CATALOG.registry,
      chainId: CATALOG.chainId,
      links: identityLinks(agent.erc8004Id, agent.wallet),
    },
    price:
      quote && quote.accepted && !(quote.signatureVerified && quote.signatureVerified.valid === false) // fix 2026-09-02 H150: a price whose signature fails is not a price
        ? {
            amount: quote.amount,
            currency: quote.currency,
            symbol: CATALOG.paymentToken.symbol,
            decimals: CATALOG.paymentToken.decimals,
            quoteExpiresAt: quote.quoteExpiresAt,
            signatureVerified: quote.signatureVerified ?? null,
            source: quote.source,
          }
        : null,
    reputation: scan ? scan.reputation : null,
    jobs: jobStatsFor(agent.wallet),
    operatorDisclosure: operatorDisclosure(agent),
  };
}

// The same standard we hold third parties to, applied to ourselves: our four
// agents share an operator and a host and each concrete fact here is
// checkable against the links on the page.
function operatorDisclosure(agent) {
  const host = new URL(agent.endpoint).host;
  return (
    `One of ${CATALOG.agents.length} first-party agents run by this site on the host ${host}. ` +
    `They share an operator and a host, not a wallet or an endpoint: this agent runs as its own service at ` +
    `${agent.endpoint}, signs its quotes with its own wallet ${agent.wallet} and holds its own ` +
    `registry entry #${agent.erc8004Id}. Check the signature on any quote against that wallet ` +
    `and the wallet against the registry entry on 8004scan.`
  );
}

// Last-seen third-party records by registry id, the directory's free-text
// search can't find agents by token id, so detail pages resolve from here.
const tpSeen = new Map();
// fix 2026-09-02 H239: tpSeen grew without bound on an unauthenticated path (every /a/erc8004-<n> and
// /api/agents/erc8004-<n> added an entry; the registry holds 300k ids). Insertion-ordered Map: past
// TPSEEN_MAX (default 5000) the oldest entries go. TPSEEN_MAX=0 restores the unbounded map.
const TPSEEN_MAX = Number(process.env.TPSEEN_MAX ?? 5000);
function tpRemember(id, v) {
  if (tpSeen.has(id)) tpSeen.delete(id); // re-insert so a fresh sighting is newest
  if (TPSEEN_MAX > 0) while (tpSeen.size >= TPSEEN_MAX) tpSeen.delete(tpSeen.keys().next().value);
  tpSeen.set(id, v);
}

// Liveness is probed from the agent's OWN on-chain registration: tokenURI →
// declared service endpoint → agent card fetch. No endpoint declared =
// "unverified"; declared but dead = "offline". Shown either way, never hidden.
async function thirdPartyEntry(category, rec) {
  tpRemember(rec.erc8004Id, { category, rec }); // fix 2026-09-02 H239
  const probe = await probeThirdParty(rec.erc8004Id);
  return {
    id: `erc8004-${rec.erc8004Id}`,
    listing: "third-party",
    category,
    name: rec.name,
    oneLiner: rec.description,
    status: probe.status,
    endpoint: probe.endpoint,
    wallet: rec.owner,
    identity: {
      erc8004Id: rec.erc8004Id,
      registry: CATALOG.registry,
      chainId: CATALOG.chainId,
      links: identityLinks(rec.erc8004Id, rec.owner),
    },
    price: null,
    reputation: rec.reputation,
    jobs: jobStatsFor(rec.owner),
    note: "Third-party ERC-8004 registration discovered on-chain via 8004scan. Listed for discovery only. Not verified or endorsed by this marketplace.",
  };
}

// Count how many discovered listings declare the same endpoint. A collection
// that registers many tokens against one backend shows up here as a stated
// fact on each row, never as a hidden filter.
export function endpointCounts(groups) {
  const counts = new Map();
  for (const g of groups)
    for (const a of g.agents)
      if (a.endpoint) counts.set(a.endpoint, (counts.get(a.endpoint) || 0) + 1);
  return counts;
}

let lastEndpointCounts = new Map();

function markShared(entry) {
  const n = entry.endpoint ? lastEndpointCounts.get(entry.endpoint) || 0 : 0;
  if (n > 1) entry.endpointSharedBy = n;
  return entry;
}

export async function listAgents() {
  const firstParty = await Promise.all(CATALOG.agents.map(firstPartyEntry));
  const discovered = await Promise.all(
    CATEGORIES.map(async (cat) => {
      const d = await discoverCategory(cat, OUR_IDS);
      const agents = await Promise.all(d.agents.map((r) => thirdPartyEntry(cat, r)));
      // fix 2026-09-03 H240: the three keys are the only statuses probeThirdParty returns today, so a
      // fourth one made the comparator return NaN and the order implementation-defined. An unknown status
      // now sorts last, deterministically, and ties break on the registry id so the listing is stable.
      const rank = { online: 0, offline: 1, unverified: 2 };
      const rankOf = (a) => rank[a.status] ?? 9;
      agents.sort((a, b) => rankOf(a) - rankOf(b) || (a.identity?.erc8004Id ?? 0) - (b.identity?.erc8004Id ?? 0));
      return {
        category: cat,
        agents,
        totalMatched: d.totalMatched,
        cap: d.cap,
        ...(d.stale ? { stale: true } : {}),
        ...(d.unavailable ? { unavailable: true } : {}),
      };
    })
  );
  lastEndpointCounts = endpointCounts(discovered);
  for (const g of discovered) g.agents.forEach(markShared);
  return { firstParty, discovered };
}

export function findFirstParty(id) {
  return CATALOG.agents.find((a) => a.id === id) ?? null;
}

export async function agentDetail(id) {
  const own = findFirstParty(id);
  if (own) {
    const entry = await firstPartyEntry(own);
    return {
      ...entry,
      inputSchema: own.inputSchema,
      hire: {
        summary:
          "Get a signed quote from the agent, then create and fund the job on-chain from your own wallet. This marketplace never holds funds or keys. The agent delivers on-chain, where the result is public.",
        a2aEndpoint: own.endpoint,
        agentCard: `${own.endpoint}.well-known/agent-card.json`,
        quoteApi: `/api/agents/${own.id}/quote`,
        steps: [
          "Get a quote. The price and terms come back signed by the agent's wallet",
          "Create and fund the job on-chain from your own wallet, attaching the signed quote",
          "Tell the agent the job is funded. It does the work and posts the deliverable on-chain",
          "Watch the job status; once it shows submitted, fetch the deliverable link",
        ],
      },
    };
  }
  const m = /^erc8004-(\d+)$/.exec(id);
  if (m) {
    let seen = tpSeen.get(Number(m[1]));
    if (!seen) {
      // Cold start on a deep link: one discovery pass warms the map.
      await listAgents().catch(() => {});
      seen = tpSeen.get(Number(m[1]));
    }
    if (seen) return markShared(await thirdPartyEntry(seen.category, seen.rec));
    const rec = await scanAgent(Number(m[1]), null);
    if (rec) {
      const category =
        CATEGORIES.find((c) => DISCOVERY[c].pattern.test(`${rec.name} ${rec.description || ""}`)) ??
        "unclassified";
      return markShared(await thirdPartyEntry(category, rec));
    }
  }
  return null;
}
