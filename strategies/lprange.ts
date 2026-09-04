/**
 * PancakeSwap v3 LP range health; pure arithmetic, no I/O.
 *
 * A v3 position earns fees only while the pool price sits inside its range.
 * Given the current price and the position's bounds, reports range status,
 * distance to each edge, position inside the band, and, when the caller
 * supplies fees/value/age, the realized fee run-rate. An optional wall map
 * (strong support/resistance levels) annotates each edge, since a range edge
 * sitting on a defended level behaves differently from one in open air.
 *
 * Input params (inside `position`, plus optional top-level `walls`):
 *   price: number          current pool price
 *   lowerPrice: number     range lower bound
 *   upperPrice: number     range upper bound (must exceed lowerPrice)
 *   nearEdgePct?: number   band share counted as near an edge (default 20)
 *   feesEarnedUsd?, positionValueUsd?, ageDays?   for fee run-rate
 *   walls?: [{price, touches}]   optional strong levels; `touches` is an integer in
 *                          [1, 10000], the same contract grid.ts uses for the same field
 *                          (fix 2026-09-03 H172; STRATEGY_WALLS_STRICT=0 relaxes it)
 *   wallBandPct?: number   "on a wall" distance (default 0.7)
 *
 * fix 2026-09-03 H173 H286: `distToLowerPct`, `distToUpperPct` and `bandPosPct` are SIGNED
 * displacements, not magnitudes, and they are not clamped to any range. Below the band
 * `distToLowerPct` is negative and `bandPosPct` is below 0; above it `distToUpperPct` is
 * negative and `bandPosPct` is above 100. Measured, band 2800..3200: price 2500 gives
 * distToLowerPct -12 and bandPosPct -75; price 3500 gives distToUpperPct -8.571 and
 * bandPosPct 175. The sign IS the direction and `status` names it in words
 * (in_range / near_lower_edge / near_upper_edge / out_of_range_below / out_of_range_above),
 * so read `status` first and treat these three as signed. A consumer that takes the
 * magnitude of one of them reads headroom on a position that has none. The field names and
 * the numbers are deliberately unchanged: they are live output of a paid deliverable and
 * renaming or clamping them would break every consumer reading them today.
 */
import { InputError, nonNeg, pos } from "./parseJob.js";

type Wall = { price: number; touches: number };
const round = (n: number, d = 4) => parseFloat(n.toFixed(d));

export function lpRange(params: Record<string, unknown>): Record<string, unknown> {
  const posn = params.position;
  if (posn === null || typeof posn !== "object" || Array.isArray(posn)) {
    throw new InputError("position must be an object of {price, lowerPrice, upperPrice}");
  }
  const p = posn as Record<string, unknown>;
  const price = pos(p.price, "position.price");
  const lower = pos(p.lowerPrice, "position.lowerPrice");
  const upper = pos(p.upperPrice, "position.upperPrice");
  if (upper <= lower) throw new InputError("position.upperPrice must exceed position.lowerPrice");
  const nearEdgePct = p.nearEdgePct === undefined ? 20 : pos(p.nearEdgePct, "position.nearEdgePct");
  if (nearEdgePct >= 50) throw new InputError("position.nearEdgePct must be below 50");
  const wallBandPct = params.wallBandPct === undefined ? 0.7 : pos(params.wallBandPct, "wallBandPct");

  const walls: Wall[] = [];
  if (params.walls !== undefined) {
    if (!Array.isArray(params.walls)) throw new InputError("walls must be an array");
    for (const [i, w] of (params.walls as unknown[]).entries()) {
      if (w === null || typeof w !== "object") throw new InputError(`walls[${i}] must be an object`);
      const rec = w as Record<string, unknown>;
      // fix 2026-09-03 H172: grid.ts requires walls[].touches to be an integer in [1, 10000]
      // and this file accepted 0 and fractions, so one wall map fed to both agents was refused
      // by gridtrader and answered by healthmon. Both are sold from the same marketplace with
      // the same documented `walls` param, so they now share one contract, and it is grid's
      // (a "touch" is a count). STRATEGY_WALLS_STRICT=0 restores the nonNeg reading.
      const strictWalls = process.env.STRATEGY_WALLS_STRICT !== "0";
      const t = rec.touches === undefined ? 1 : nonNeg(rec.touches, `walls[${i}].touches`);
      if (strictWalls && (!Number.isInteger(t) || t < 1 || t > 10_000)) {
        throw new InputError(`walls[${i}].touches must be an integer in [1, 10000]`);
      }
      walls.push({
        price: pos(rec.price, `walls[${i}].price`),
        touches: t,
      });
    }
  }

  const bandPosPct = ((price - lower) / (upper - lower)) * 100;
  const inRange = price >= lower && price <= upper;
  const status = !inRange
    ? (price < lower ? "out_of_range_below" : "out_of_range_above")
    : bandPosPct <= nearEdgePct ? "near_lower_edge"
    : bandPosPct >= 100 - nearEdgePct ? "near_upper_edge"
    : "in_range";

  const edgeInfo = (edge: number) => {
    if (!walls.length) return null;
    let best: Wall = walls[0];
    for (const w of walls) if (Math.abs(w.price - edge) < Math.abs(best.price - edge)) best = w;
    const distPct = Math.abs(edge - best.price) / edge * 100;
    return { nearestWall: best.price, touches: best.touches, distPct: round(distPct, 3), onWall: distPct <= wallBandPct };
  };

  const out: Record<string, unknown> = {
    inRange,
    status,
    bandPosPct: round(bandPosPct, 2),
    distToLowerPct: round(((price - lower) / price) * 100, 3),
    distToUpperPct: round(((upper - price) / price) * 100, 3),
    price, lowerPrice: lower, upperPrice: upper,
    lowerEdge: edgeInfo(lower),
    upperEdge: edgeInfo(upper),
  };
  if (!inRange) out.note = "a v3 position earns no fees while the pool price is outside its range";

  const fees = p.feesEarnedUsd, val = p.positionValueUsd, age = p.ageDays;
  if (fees !== undefined || val !== undefined || age !== undefined) {
    // fix 2026-09-03 H35: the guard is OR and the body needs all three, so sending only
    // ageDays failed with "position.feesEarnedUsd must be a finite number", naming a field
    // the buyer never sent, for an optional block they may not have meant to open. Name
    // every field that is actually missing, once.
    const missing = ([["feesEarnedUsd", fees], ["positionValueUsd", val], ["ageDays", age]] as const)
      .filter(([, v]) => v === undefined)
      .map(([k]) => `position.${k}`);
    if (missing.length > 0) {
      throw new InputError(
        `the fee run-rate block needs feesEarnedUsd, positionValueUsd and ageDays together; missing: ${missing.join(", ")}`,
      );
    }
    const f = nonNeg(fees, "position.feesEarnedUsd");
    const v = pos(val, "position.positionValueUsd");
    const a = pos(age, "position.ageDays");
    out.feeAprPct = round((f / v) / (a / 365) * 100, 2);
  }
  return out;
}
