/**
 * Deterministic runWork dispatcher; the drop-in replacement for the
 * scaffold's model work hook. One category per agent, set at wiring time.
 * Never throws on BUYER INPUT: strategy input errors become structured
 * refusals the buyer can read and fix (they were charged for a deliverable;
 * a clear "your input was wrong and here is how" IS the deliverable in that
 * case). An INTERNAL error (anything that is not an InputError) is rethrown,
 * so the seller leaves the job unsubmitted and a later sweep retries it,
 * instead of settling our own failure as a delivery.
 */
import { parseJobInput, InputError, deliver, refuse, strictInput } from "./parseJob.js";
import { rebalance } from "./rebalance.js";
import { grid } from "./grid.js";
import { yieldOpt } from "./yieldopt.js";
import { health } from "./health.js";

export type Category = "rebalancing" | "grid" | "yield" | "health";

type Engine = (p: Record<string, unknown>) => Record<string, unknown>;
const ENGINES: Record<Category, Engine> = {
  rebalancing: rebalance,
  grid: grid,
  yield: yieldOpt,
  health: health,
};

/** Test seam (mirrors the studio-runtime `_set*` convention): swap an engine. Pass null to restore. */
export function _setEngine(category: Category, engine: Engine | null): void {
  const originals: Record<Category, Engine> = { rebalancing: rebalance, grid: grid, yield: yieldOpt, health: health };
  ENGINES[category] = engine ?? originals[category];
}

/** fix 2026-09-02 H68: the expected keys per category, attached to every input refusal. */
const PARAM_HINTS: Record<Category, string> = {
  rebalancing: "expected params: holdings {SYMBOL: amount}, targets {SYMBOL: weight, summing to 1}, prices {SYMBOL: usd}; optional driftThresholdPct, minTradeUsd",
  grid: "expected params: price, budgetUsd; optional levels, spanPct, walls {price: touches}, wallBandPct",
  yield: "expected params: pools {name: {apyPct, riskScore?, tvlUsd?}}, capitalUsd; optional maxPerPoolPct, riskAversion, tvlCapPct",
  health: "expected params: collateral {SYMBOL: {amount, liqThreshold}}, debt {SYMBOL: amount}, prices {SYMBOL: usd}; optional alertHF, criticalHF; or position {price, lowerPrice, upperPrice} for LP range health",
};

/**
 * Object-form input normalization. The commerce chain's description anchoring
 * mangles square brackets (arrays arrive as parentheses), so the wire schema
 * uses OBJECTS keyed by symbol/name; engines keep their array shapes. Both
 * forms accepted; arrays pass through untouched.
 */
function normalize(category: Category, p: Record<string, unknown>): Record<string, unknown> {
  const out = { ...p };
  const toArr = (v: unknown, shape: (k: string, val: unknown) => Record<string, unknown>) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.entries(v as Record<string, unknown>).map(([k, val]) => shape(k, val))
      : v;
  if (category === "rebalancing") {
    out.holdings = toArr(p.holdings, (k, v) => ({ symbol: k, amount: v }));
  } else if (category === "health") {
    out.walls = toArr(p.walls, (k, v) => ({ price: Number(k), touches: v }));
    // fix 2026-09-03 H96: the spread came AFTER the key, so an inner "symbol" in the value
    // shadowed the wire key: {"eth":{"symbol":"BTC",...}} priced the row as BTC and threw the
    // key away. The object key is the schema's own identifier and is authoritative over its
    // value's contents, so it goes last.
    out.collateral = toArr(p.collateral, (k, v) =>
      v !== null && typeof v === "object"
        ? { ...(v as Record<string, unknown>), symbol: k }
        : { symbol: k, amount: v });
    out.debt = toArr(p.debt, (k, v) => ({ symbol: k, amount: v }));
  } else if (category === "yield") {
    // fix 2026-09-03 H96: same shadowing on the yield normalizer; the wire key wins.
    out.pools = toArr(p.pools, (k, v) =>
      v !== null && typeof v === "object"
        ? { ...(v as Record<string, unknown>), name: k }
        : { name: k, apyPct: v });
  } else if (category === "grid") {
    out.walls = toArr(p.walls, (k, v) => ({ price: Number(k), touches: v }));
  }
  return out;
}

export function makeRunWork(category: Category) {
  if (!ENGINES[category]) throw new Error(`unknown category: ${category}`);
  return async (prompt: string): Promise<string> => {
    const engine = ENGINES[category];
    const parsed = parseJobInput(prompt);
    if ("error" in parsed) return refuse(category, parsed.error, parsed.hint);
    try {
      return deliver(category, engine(normalize(category, parsed.params)));
    } catch (e) {
      if (e instanceof InputError) return refuse(category, e.message, PARAM_HINTS[category]);
      // fix 2026-09-02 H31: this branch used to deliver a refusal promising a
      // "redemption window" that exists nowhere, and the seller settled that
      // text as a completed job. Rethrow so the job stays funded and is
      // retried by a later sweep. STRATEGY_STRICT_INPUT=0 restores a refusal
      // (without the false promise).
      if (strictInput()) {
        throw new Error(`internal error producing deliverable: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      return refuse(category, "internal error producing deliverable");
    }
  };
}
