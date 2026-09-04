/**
 * Grid-trading strategy core; pure arithmetic, no I/O.
 *
 * Builds a symmetric buy/sell grid around the current price and, when the
 * buyer supplies a price-wall map (strong support/resistance levels, e.g.
 * from a market-data provider), annotates each grid level with the nearest
 * strong wall and flags levels that sit ON a wall; filled orders hugging a
 * heavily-defended level behave differently from open-air levels and a
 * grid bot should know which is which.
 *
 * Input params:
 *   price: number                     current mark
 *   budgetUsd: number                 total capital to ladder
 *   levels?: number                   grid lines per side (default 5, max 50)
 *   spanPct?: number                  half-width of the grid (default 5)
 *   walls?: [{price, side?, touches?}]  optional strong levels
 *   wallBandPct?: number              "on a wall" distance (default 0.7)
 *
 * Output: buy levels below price, sell levels above, per-level size (equal
 * USD ladder) and wall annotations.
 */
import { InputError, nonNeg, pos } from "./parseJob.js";

type Wall = { price: number; touches: number; side?: "support" | "resistance" };

export function grid(params: Record<string, unknown>): Record<string, unknown> {
  const price = pos(params.price, "price");
  const budget = pos(params.budgetUsd, "budgetUsd");
  const levels = params.levels === undefined ? 5 : intIn(params.levels, "levels", 1, 50);
  const spanPct = params.spanPct === undefined ? 5 : pos(params.spanPct, "spanPct");
  if (spanPct >= 100) throw new InputError("spanPct must be < 100");
  const wallBandPct = params.wallBandPct === undefined ? 0.7 : pos(params.wallBandPct, "wallBandPct");

  const walls: Wall[] = [];
  if (params.walls !== undefined) {
    if (!Array.isArray(params.walls)) throw new InputError("walls must be an array");
    for (const [i, w] of (params.walls as unknown[]).entries()) {
      if (w === null || typeof w !== "object") throw new InputError(`walls[${i}] must be an object`);
      const rec = w as Record<string, unknown>;
      // fix 2026-09-03 H283: `side` is in this file's own documented schema and was read
      // nowhere, so nearestWall was side-blind and a BUY level below the mark could be
      // annotated with, and flagged onWall against, a RESISTANCE wall above it. That is the
      // inversion the header sells against. Read it, validate it, and use it below.
      const side = rec.side === undefined ? undefined : String(rec.side).toLowerCase();
      if (side !== undefined && side !== "support" && side !== "resistance") {
        throw new InputError(`walls[${i}].side must be "support" or "resistance"`);
      }
      walls.push({
        price: pos(rec.price, `walls[${i}].price`),
        touches: rec.touches === undefined ? 1 : intIn(rec.touches, `walls[${i}].touches`, 1, 10_000),
        ...(side === undefined ? {} : { side: side as "support" | "resistance" }),
      });
    }
  }

  // fix 2026-09-03 H171: sizeUsd was ROUNDED to 2dp per level while budgetUsd was echoed
  // unrounded, so the ladder summed above the budget whenever the third decimal was >= 5:
  // grid({price:100,budgetUsd:1000,levels:3}) summed to 1000.0199999999999 against a stated
  // 1000. A bot that treats budgetUsd as a hard cap then places more than it was given, and
  // the error grows with the level count. Floor to the cent instead of rounding, so the sum
  // is always at or under the budget, and report the sum as allocatedUsd so the number is
  // stated rather than inferred. STRATEGY_BUDGET_HARD_CAP=0 restores the rounded size.
  const hardCap = process.env.STRATEGY_BUDGET_HARD_CAP !== "0";
  const rawPerLevelUsd = budget / (levels * 2);
  const perLevelUsd = hardCap ? Math.floor(rawPerLevelUsd * 100) / 100 : rawPerLevelUsd;
  const step = (price * (spanPct / 100)) / levels;

  const mkLevel = (side: "buy" | "sell", i: number) => {
    const px = side === "buy" ? price - step * i : price + step * i;
    // fix 2026-09-03 H283: a buy level is defended by SUPPORT and a sell level by
    // RESISTANCE. A wall that declares the other side is not a wall for this level.
    // A wall that declares no side still matches either, so the old behaviour is
    // unchanged for every caller that does not use the field.
    const wall = nearestWall(walls, px, side === "buy" ? "support" : "resistance");
    const onWall =
      wall !== null && (Math.abs(px - wall.price) / px) * 100 <= wallBandPct;
    return {
      side,
      price: round(px, 8),
      sizeUsd: round(perLevelUsd),
      amount: round(perLevelUsd / px, 8),
      ...(wall !== null
        ? {
            nearestWall: round(wall.price, 8),
            wallTouches: wall.touches,
            wallDistPct: round((Math.abs(px - wall.price) / px) * 100, 3),
            onWall,
          }
        : {}),
    };
  };

  const buys = [];
  const sells = [];
  for (let i = 1; i <= levels; i++) {
    buys.push(mkLevel("buy", i));
    sells.push(mkLevel("sell", i));
  }

  const onWallCount = [...buys, ...sells].filter((l) => (l as Record<string, unknown>).onWall === true).length;

  return {
    mark: price,
    spanPct,
    levelsPerSide: levels,
    perLevelUsd: round(perLevelUsd),
    budgetUsd: budget,
    // fix 2026-09-03 H171: what the ladder actually spends, at or under budgetUsd.
    allocatedUsd: round(round(perLevelUsd) * levels * 2),
    buys,
    sells,
    wallsSupplied: walls.length,
    levelsOnWalls: onWallCount,
    note:
      walls.length === 0
        ? "no wall map supplied; levels are spacing-only; supply walls[] for placement-aware grids"
        : `${onWallCount} level(s) sit within ${wallBandPct}% of a strong wall; expect defended fills there`,
  };
}

function nearestWall(walls: Wall[], px: number, want?: "support" | "resistance"): Wall | null {
  let best: Wall | null = null;
  let bestD = Infinity;
  for (const w of walls) {
    // fix 2026-09-03 H283: skip a wall that declares the opposite side.
    if (want !== undefined && w.side !== undefined && w.side !== want) continue;
    const d = Math.abs(w.price - px);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}

function intIn(v: unknown, name: string, min: number, max: number): number {
  const n = nonNeg(v, name);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new InputError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return n;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
