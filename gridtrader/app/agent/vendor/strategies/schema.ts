/**
 * The ONE source of what each seller agent accepts. Added 2026-09-05.
 *
 * Before this file the accepted parameters lived in three places that could
 * drift: the engine headers, PARAM_HINTS in dispatch.ts, and nowhere on the
 * public agent card (the card listed only the two commerce skills, so a buyer
 * had no way to learn what a job must contain and guessed; job 56680 was
 * refused over field names for exactly that reason). Now the refusal hint,
 * the card's work skill and its worked example are all generated from here.
 *
 * WIRE FORM. The buyer sends the job input in `task_description` when it
 * negotiates; that string is anchored on chain as the job `task` and handed
 * back to the seller verbatim. The spec is a flat JSON object. Maps keyed by
 * symbol or name are OBJECTS, never arrays: the chain's description anchoring
 * mangles square brackets, so the wire schema keys rows by their identifier
 * and dispatch.ts normalizes them into the arrays the engines take.
 */

export type ParamDoc = {
  name: string;
  type: string;
  required: boolean;
  doc: string;
  /** other names a buyer may use for this parameter; applied only when the canonical name is absent (2026-09-05) */
  aliases?: string[];
};

export type WorkSchema = {
  /** dispatcher category, also the skill id on the card */
  category: "rebalancing" | "grid" | "yield" | "health";
  name: string;
  description: string;
  params: ParamDoc[];
  /** a complete valid request; the test suite proves the dispatcher serves it */
  example: Record<string, unknown>;
  tags: string[];
};

export const WORK_SCHEMAS: Record<WorkSchema["category"], WorkSchema> = {
  rebalancing: {
    category: "rebalancing",
    name: "Portfolio rebalancing plan",
    description:
      "Given current holdings, target weights and prices, returns current vs target weights, " +
      "per-asset drift and the ordered trade list (sells before buys) that moves the portfolio " +
      "to target, with the residual cash the plan does not net out. Deterministic arithmetic, " +
      "no custody, no execution.",
    params: [
      { name: "holdings", type: "{SYMBOL: amount}", required: true, aliases: ["positions", "balances", "portfolio"], doc: "current position sizes in token units, one key per symbol" },
      { name: "targets", type: "{SYMBOL: weight}", required: true, aliases: ["targetWeights", "weights", "allocation"], doc: "desired weights, must sum to 1" },
      { name: "prices", type: "{SYMBOL: usd}", required: true, doc: "a mark for every symbol in holdings or targets", aliases: ["marks", "quotes", "pricesUsd"],},
      { name: "driftThresholdPct", type: "number", required: false, doc: "no-trade band per asset, default 1" },
      { name: "minTradeUsd", type: "number", required: false, doc: "dust filter on emitted trades, default 5" },
    ],
    example: {
      holdings: { BTC: 1, ETH: 10 },
      targets: { BTC: 0.5, ETH: 0.5 },
      prices: { BTC: 60000, ETH: 2000 },
      driftThresholdPct: 1,
    },
    tags: ["rebalancing", "portfolio", "deterministic"],
  },
  grid: {
    category: "grid",
    name: "Grid trading ladder",
    description:
      "Given a mark price and a budget, returns a symmetric buy/sell grid: buy levels below the " +
      "price, sell levels above, equal USD size per level, and when strong price walls are supplied " +
      "each level is annotated with its nearest wall and flagged if it sits on one. Deterministic " +
      "arithmetic, no custody, no execution. Not a bounded-loss or profit-target strategy: fees, " +
      "slippage, gas and PnL are not computed.",
    params: [
      { name: "price", type: "number", required: true, aliases: ["mid", "midPrice", "mark", "markPrice", "currentPrice", "spot"], doc: "current mark price" },
      { name: "budgetUsd", type: "number", required: true, aliases: ["capitalUsd", "budget", "capital", "notionalUsd", "sizeUsd"], doc: "total capital to ladder" },
      { name: "levels", type: "integer 1..50", required: false, aliases: ["gridLevels", "nLevels"], doc: "grid lines per side, default 5" },
      { name: "spanPct", type: "number", required: false, aliases: ["rangePct", "widthPct"], doc: "half-width of the grid in percent, below 100, default 5; or send lower and upper (absolute bounds) and the half-width is derived from the wider side" },
      { name: "lower", type: "number", required: false, doc: "grid lower bound in price; with upper, an alternative to spanPct" },
      { name: "upper", type: "number", required: false, doc: "grid upper bound in price; with lower, an alternative to spanPct" },
      { name: "walls", type: "{price: touches}", required: false, doc: "known support/resistance walls keyed by price, touches is an integer 1 to 10000; levels on a wall are flagged" },
      { name: "wallBandPct", type: "number", required: false, doc: "distance in percent that counts as on a wall, default 0.7" },
    ],
    example: {
      price: 691.65,
      budgetUsd: 1000,
      levels: 5,
      spanPct: 2,
      walls: { "677.8": 3, "705.5": 2 },
    },
    tags: ["grid", "market-making", "deterministic"],
  },
  yield: {
    category: "yield",
    name: "Yield allocation across pools",
    description:
      "Given candidate pools with APY, optional TVL and risk score, and the capital to place, " +
      "returns the allocation per pool under concentration and TVL-share caps, the blended APY " +
      "and any capital left unallocated because a cap bound first. Deterministic arithmetic, no " +
      "custody, no execution.",
    params: [
      { name: "pools", type: "{name: {apyPct, tvlUsd?, riskScore?}}", required: true, aliases: ["opportunities", "vaults", "farms"], doc: "candidate pools keyed by name; riskScore 1 (safest) to 5, default 3" },
      { name: "capitalUsd", type: "number", required: true, aliases: ["budgetUsd", "capital", "budget", "amountUsd"], doc: "capital to allocate" },
      { name: "maxPerPoolPct", type: "number", required: false, doc: "max share of capital in one pool, at most 100, default 40" },
      { name: "riskAversion", type: "number 0..1", required: false, doc: "0 chases raw APY, 1 applies the full risk discount, default 0.5" },
      { name: "tvlCapPct", type: "number", required: false, doc: "max share of a pool's TVL to hold, default 5" },
    ],
    example: {
      pools: {
        "pcs-wbnb-usdt": { apyPct: 12.5, tvlUsd: 50000000, riskScore: 2 },
        "venus-usdt": { apyPct: 6.1, tvlUsd: 200000000, riskScore: 1 },
        "new-farm": { apyPct: 80, tvlUsd: 400000, riskScore: 5 },
      },
      capitalUsd: 10000,
      maxPerPoolPct: 40,
    },
    tags: ["yield", "allocation", "deterministic"],
  },
  health: {
    category: "health",
    name: "Position health report",
    description:
      "Lending health: given collateral rows with liquidation thresholds, debt and prices, returns " +
      "the health factor, its status (healthy, warning, critical, liquidatable) and per-asset " +
      "liquidation prices with drop distances. LP range health: send `position` " +
      "{price, lowerPrice, upperPrice} instead of collateral and debt. One question per job. " +
      "Deterministic arithmetic, no custody, no execution.",
    params: [
      { name: "collateral", type: "{SYMBOL: {amount, liqThreshold}}", required: true, aliases: ["collaterals", "supplied", "deposits"], doc: "liqThreshold in (0, 1]; required unless `position` is sent" },
      { name: "debt", type: "{SYMBOL: amount}", required: true, aliases: ["debts", "borrowed", "borrows", "loans"], doc: "outstanding debt per symbol; required unless `position` is sent" },
      { name: "prices", type: "{SYMBOL: usd}", required: true, doc: "a mark for every collateral and debt symbol", aliases: ["marks", "quotes", "pricesUsd"],},
      { name: "alertHF", type: "number", required: false, doc: "warning level, default 1.5" },
      { name: "criticalHF", type: "number", required: false, doc: "critical level, must be below alertHF, default 1.1" },
      { name: "position", type: "{price, lowerPrice, upperPrice}", required: false, aliases: ["lpPosition", "range"], doc: "PancakeSwap v3 LP range health instead of lending health (do not send with collateral or debt); optional nearEdgePct, feesEarnedUsd, positionValueUsd, ageDays; returns range status, distance to each edge, position inside the band and the fee run-rate" },
      { name: "walls", type: "{price: touches}", required: false, doc: "with position only: strong levels keyed by price, each range edge is annotated with the nearest one" },
    ],
    example: {
      collateral: { ETH: { amount: 10, liqThreshold: 0.8 } },
      debt: { USDT: 10000 },
      prices: { ETH: 2000, USDT: 1 },
    },
    tags: ["health", "liquidation", "deterministic"],
  },
};

/**
 * Apply the declared aliases: a buyer's name is renamed to ours ONLY when our name is absent, never over it.
 * Grid also derives spanPct from lower/upper when spanPct is absent. Every alias here is printed on the card,
 * in the storefront table and in the refusal, so this is published acceptance, not guessing.
 * STRATEGY_INPUT_ALIASES=0 restores the exact-name behaviour.
 */
export function applyAliases(category: WorkSchema["category"], p: Record<string, unknown>): { params: Record<string, unknown>; applied: string[] } {
  if (process.env.STRATEGY_INPUT_ALIASES === "0") return { params: p, applied: [] };
  const out: Record<string, unknown> = { ...p };
  const applied: string[] = [];
  for (const d of WORK_SCHEMAS[category].params) {
    if (out[d.name] !== undefined || !d.aliases) continue;
    const hit = d.aliases.find((a) => out[a] !== undefined);
    if (hit !== undefined) { out[d.name] = out[hit]; applied.push(`${hit} -> ${d.name}`); }
  }
  if (category === "grid" && out.spanPct === undefined && out.lower !== undefined && out.upper !== undefined && out.price !== undefined) {
    const mid = Number(out.price), lo = Number(out.lower), hi = Number(out.upper);
    if (Number.isFinite(mid) && Number.isFinite(lo) && Number.isFinite(hi) && mid > 0 && lo < mid && hi > mid) {
      out.spanPct = Math.round((Math.max(mid - lo, hi - mid) / mid) * 100 * 1e6) / 1e6;
      applied.push(`lower/upper -> spanPct ${out.spanPct}`);
    }
  }
  return { params: out, applied };
}

/** The refusal hint: required and optional names, then the worked example. */
export function paramHint(category: WorkSchema["category"]): string {
  const s = WORK_SCHEMAS[category];
  const nm = (p: ParamDoc) => `${p.name}${p.type.startsWith("{") ? " " + p.type : ""}${p.aliases ? " (or " + p.aliases.join("/") + ")" : ""}`;
  const req = s.params.filter((p) => p.required).map(nm);
  const opt = s.params.filter((p) => !p.required).map(nm);
  return `expected params: ${req.join(", ")}; optional ${opt.join(", ")}; example task_description: ${JSON.stringify(s.example)}`;
}

/** The card skill's `examples` entry: the exact string a buyer sends as task_description. */
export function exampleTaskDescription(category: WorkSchema["category"]): string {
  return JSON.stringify(WORK_SCHEMAS[category].example);
}

/** The card skill's description: what the work is, then the parameter table. */
export function skillDescription(category: WorkSchema["category"]): string {
  const s = WORK_SCHEMAS[category];
  const rows = s.params.map((p) => `${p.name} (${p.type}${p.required ? ", required" : ", optional"}): ${p.doc}${p.aliases ? "; also accepted as " + p.aliases.join(", ") : ""}`);
  return (
    `${s.description} ` +
    `The job input is a flat JSON object sent as task_description when negotiating. It is anchored on chain ` +
    `as the job task and answered as sent. Parameters: ${rows.join("; ")}. ` +
    `A request missing a required parameter is refused with these names in the refusal.`
  );
}

/**
 * The BRIDGE (brief part 3): the same declaration shape the MCP product emits per tool
 * ({name, description, inputSchema}), so a machine reading either product sees one contract
 * format. Map-typed params are objects keyed by symbol or name (see WIRE FORM above).
 */
export function inputSchema(category: WorkSchema["category"]): Record<string, unknown> {
  const s = WORK_SCHEMAS[category];
  const properties: Record<string, unknown> = {};
  for (const p of s.params) properties[p.name] = { ...jsonType(p.type), description: p.doc + (p.aliases ? " (also accepted as: " + p.aliases.join(", ") + ")" : "") };
  const required = s.params.filter((p) => p.required).map((p) => p.name);
  // sweep 2026-09-05: health answers one of two questions (lending: collateral, debt, prices; LP range: position).
  // The flat required list said "collateral, debt, prices" and contradicted the skill text and the dispatcher,
  // which serve a position-only request. The schema now states the two shapes as anyOf, required at the top is
  // empty for health, and the storefront table and refusal hint keep their wording (position is documented there).
  if (s.category === "health") {
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: `${s.category} task_description`,
      description: "One question per job: lending health (collateral, debt, prices) or LP range health (position).",
      type: "object",
      properties,
      required: [],
      anyOf: [{ required }, { required: ["position"] }],
      additionalProperties: true,
    };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `${s.category} task_description`,
    type: "object",
    properties,
    required,
    additionalProperties: true,
  };
}

function jsonType(t: string): Record<string, unknown> {
  if (t.startsWith("integer")) return { type: "integer", minimum: 1, maximum: 50 };
  if (t.startsWith("number 0..1")) return { type: "number", minimum: 0, maximum: 1 };
  if (t.startsWith("number")) return { type: "number" };
  // "{SYMBOL: amount}", "{price: touches}", "{SYMBOL: weight}", "{SYMBOL: usd}": number-valued map
  if (/^\{[A-Za-z]+: (amount|touches|weight|usd)\}$/.test(t)) return { type: "object", additionalProperties: { type: "number" } };
  // "{SYMBOL: {amount, liqThreshold}}", "{name: {apyPct, tvlUsd?, riskScore?}}": object-valued map
  const m = /^\{[A-Za-z]+: \{([^}]+)\}\}$/.exec(t);
  if (m) {
    const inner: Record<string, unknown> = {}; const req: string[] = [];
    for (const f of m[1].split(",").map((x) => x.trim())) { const opt = f.endsWith("?"); const n = opt ? f.slice(0, -1) : f; inner[n] = { type: "number" }; if (!opt) req.push(n); }
    return { type: "object", additionalProperties: { type: "object", properties: inner, required: req } };
  }
  // "{price, lowerPrice, upperPrice}": a fixed object
  const o = /^\{([^}]+)\}$/.exec(t);
  if (o) {
    const inner: Record<string, unknown> = {}; const names = o[1].split(",").map((x) => x.trim());
    for (const n of names) inner[n] = { type: "number" };
    return { type: "object", properties: inner, required: names };
  }
  return {};
}

/**
 * The marketplace storefront's "Job input" table (marketplace/catalog.json agents[].inputSchema,
 * rendered by marketplace/src/pages.js). Generated from here by strategies/emit_catalog_schema.ts so
 * the storefront, the agent card and the refusal cannot say three different things.
 */
export function catalogInputSchema(category: WorkSchema["category"]): { note: string; required: Record<string, string>; optional: Record<string, string>; aliases: Record<string, string[]> } {
  const s = WORK_SCHEMAS[category];
  const row = (p: ParamDoc) => (p.type.startsWith("{") ? `object ${p.type}, ${p.doc}` : `${p.type}, ${p.doc}`) + (p.aliases ? `; also accepted as ${p.aliases.join(", ")}` : "");
  const required: Record<string, string> = {}; const optional: Record<string, string> = {};
  const aliases: Record<string, string[]> = {};
  for (const p of s.params) { (p.required ? required : optional)[p.name] = row(p); if (p.aliases) aliases[p.name] = p.aliases; }
  const maps = s.params.filter((p) => p.type.startsWith("{")).map((p) => p.name);
  return {
    note: `Send ${maps.join(", ")} as an object keyed by ${category === "yield" ? "pool name" : category === "grid" ? "price" : "symbol"}, not a list. The whole job input is sent as JSON text in task_description. Example: ${JSON.stringify(s.example)}`,
    required,
    optional,
    aliases,
  };
}
