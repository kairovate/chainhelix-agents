/**
 * Rebalancing strategy core; pure arithmetic, no I/O.
 *
 * Input params:
 *   holdings: [{symbol, amount}]          current position sizes (token units);
 *                                         the same symbol twice (any case) is summed
 *   targets:  {SYMBOL: weight}            desired weights, must sum to ~1;
 *                                         one key per symbol, case-insensitive
 *   prices:   {SYMBOL: usd}               marks for every symbol involved;
 *                                         one key per symbol, case-insensitive
 *   driftThresholdPct?: number            no-trade band per asset (default 1)
 *   minTradeUsd?: number                  dust filter on emitted trades (default 5)
 *
 * Output: current vs target weights, per-asset drift and the trade list that
 * moves the portfolio toward the targets, sells listed before buys. When the
 * no-trade band or the dust filter drops a leg the surviving legs no longer
 * net to zero: `residualUsd` reports the difference (positive = the buys need
 * that much cash beyond the sells, negative = that much cash is left over)
 * and `note` names the skipped symbols. The plan is self-funding only when
 * residualUsd is 0.
 */
import { InputError, nonNeg, pos, strictInput } from "./parseJob.js";

type Holding = { symbol: string; amount: number };
type Trade = { symbol: string; side: "buy" | "sell"; amount: number; usd: number };

export function rebalance(params: Record<string, unknown>): Record<string, unknown> {
  const holdingsRaw = params.holdings;
  if (!Array.isArray(holdingsRaw) || holdingsRaw.length === 0) {
    throw new InputError("holdings must be a non-empty array of {symbol, amount}");
  }
  const targetsRaw = params.targets;
  if (targetsRaw === null || typeof targetsRaw !== "object" || Array.isArray(targetsRaw)) {
    throw new InputError("targets must be an object of {SYMBOL: weight}");
  }
  const pricesRaw = params.prices;
  if (pricesRaw === null || typeof pricesRaw !== "object" || Array.isArray(pricesRaw)) {
    throw new InputError("prices must be an object of {SYMBOL: usd}");
  }
  const driftBand = params.driftThresholdPct === undefined ? 1 : nonNeg(params.driftThresholdPct, "driftThresholdPct");
  const minTradeUsd = params.minTradeUsd === undefined ? 5 : nonNeg(params.minTradeUsd, "minTradeUsd");

  const targets = new Map<string, number>();
  let wSum = 0;
  for (const [sym, w] of Object.entries(targetsRaw as Record<string, unknown>)) {
    const weight = nonNeg(w, `targets.${sym}`);
    // fix 2026-09-02 H99: fold case BEFORE the duplicate check; {BTC:0.5, btc:0.5}
    // passed the weight-sum guard and collapsed to the last weight (sell-half plan).
    if (strictInput() && targets.has(sym.toUpperCase())) {
      throw new InputError(`targets.${sym.toUpperCase()} appears more than once (keys are case-insensitive)`);
    }
    targets.set(sym.toUpperCase(), weight);
    wSum += weight;
  }
  if (Math.abs(wSum - 1) > 0.001) {
    throw new InputError(`target weights must sum to 1 (got ${wSum.toFixed(4)})`);
  }

  const prices = new Map<string, number>();
  for (const [sym, p] of Object.entries(pricesRaw as Record<string, unknown>)) {
    // fix 2026-09-02 H99: same collision on prices; {BTC:60000, btc:1} silently marked at 1.
    if (strictInput() && prices.has(sym.toUpperCase())) {
      throw new InputError(`prices.${sym.toUpperCase()} appears more than once (keys are case-insensitive)`);
    }
    prices.set(sym.toUpperCase(), pos(p, `prices.${sym}`));
  }

  const holdings: Holding[] = holdingsRaw.map((h, i) => {
    if (h === null || typeof h !== "object") throw new InputError(`holdings[${i}] must be an object`);
    const sym = String((h as Record<string, unknown>).symbol ?? "").toUpperCase();
    if (!sym) throw new InputError(`holdings[${i}].symbol is required`);
    return { symbol: sym, amount: nonNeg((h as Record<string, unknown>).amount, `holdings[${i}].amount`) };
  });

  // every symbol on either side needs a mark
  const allSyms = new Set<string>([...holdings.map((h) => h.symbol), ...targets.keys()]);
  for (const s of allSyms) {
    if (!prices.has(s)) throw new InputError(`prices.${s} is required`);
  }

  const valueOf = new Map<string, number>();
  let total = 0;
  for (const s of allSyms) valueOf.set(s, 0);
  for (const h of holdings) {
    const v = (valueOf.get(h.symbol) ?? 0) + h.amount * (prices.get(h.symbol) as number);
    valueOf.set(h.symbol, v);
  }
  for (const v of valueOf.values()) total += v;
  if (total <= 0) throw new InputError("portfolio value is zero; nothing to rebalance");

  const rows: Array<Record<string, unknown>> = [];
  const trades: Trade[] = [];
  const skipped: string[] = [];
  for (const s of [...allSyms].sort()) {
    const cur = (valueOf.get(s) as number) / total;
    const tgt = targets.get(s) ?? 0;
    // fix 2026-09-03 H37: the object reported round(driftPct) and the band test below used
    // the UNROUNDED value, so a deliverable could show driftPct -1 next to an echoed
    // driftThresholdPct of 1 and still emit a trade, because the real number was
    // -1.0000000000000009. A buyer had no way to tell why. Filter on the number that is
    // shown. STRATEGY_DRIFT_ROUNDED_FILTER=0 restores the unrounded comparison.
    const driftRaw = (cur - tgt) * 100;
    const driftPct =
      process.env.STRATEGY_DRIFT_ROUNDED_FILTER === "0" ? driftRaw : round(driftRaw);
    const deltaUsd = (tgt - cur) * total;
    rows.push({
      symbol: s,
      currentWeightPct: round(cur * 100),
      targetWeightPct: round(tgt * 100),
      driftPct: round(driftPct),
    });
    // fix 2026-09-02 H36: a skipped leg is remembered so the residual below is reported, not hidden
    if (Math.abs(driftPct) <= driftBand) { if (deltaUsd !== 0) skipped.push(s); continue; }   // inside the no-trade band
    if (Math.abs(deltaUsd) < minTradeUsd) { skipped.push(s); continue; }  // dust
    const px = prices.get(s) as number;
    trades.push({
      symbol: s,
      side: deltaUsd > 0 ? "buy" : "sell",
      amount: round(Math.abs(deltaUsd) / px, 8),
      usd: round(Math.abs(deltaUsd)),
    });
  }
  trades.sort((a, b) => (a.side === b.side ? b.usd - a.usd : a.side === "sell" ? -1 : 1));

  // fix 2026-09-02 H36: the emitted legs net to zero only when nothing was
  // filtered; report the difference the way yieldopt.ts reports unallocatedUsd.
  const buysUsd = trades.filter((t) => t.side === "buy").reduce((s, t) => s + t.usd, 0);
  const sellsUsd = trades.filter((t) => t.side === "sell").reduce((s, t) => s + t.usd, 0);
  const residualUsd = round(buysUsd - sellsUsd);

  return {
    portfolioUsd: round(total),
    driftThresholdPct: driftBand,
    weights: rows,
    trades,
    tradesNeeded: trades.length > 0,
    residualUsd,
    ...(residualUsd !== 0 || skipped.length > 0
      ? {
          note:
            (residualUsd > 0
              ? `buys exceed sells by ${residualUsd} USD; the plan needs that much cash or a smaller buy`
              : residualUsd < 0
                ? `sells exceed buys by ${-residualUsd} USD; that cash stays unallocated`
                : "trades net to zero") +
            (skipped.length > 0 ? `; legs inside the no-trade band or under minTradeUsd were skipped: ${skipped.join(", ")}` : ""),
        }
      : {}),
  };
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
