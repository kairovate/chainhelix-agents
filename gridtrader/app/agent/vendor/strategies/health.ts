/**
 * Health-factor monitoring core; pure arithmetic, no I/O.
 *
 * Standard lending-protocol health factor:
 *   HF = Σ(collateral_i value × liqThreshold_i) / Σ(debt value)
 * HF < 1 means liquidatable. Also computes, per collateral asset, the price
 * it would have to fall to (others held constant) for HF to hit 1; the
 * per-asset liquidation price; and the portfolio's distance to it.
 *
 * Input params:
 *   collateral: [{symbol, amount, liqThreshold}]   threshold in (0, 1]; the same
 *               symbol may appear in several rows (tranches), they are folded per
 *               symbol before the liquidation solve
 *   debt:       [{symbol, amount}]
 *   prices:     {SYMBOL: usd}   one key per symbol, case-insensitive
 *   alertHF?: number      warn level (default 1.5)
 *   criticalHF?: number   critical level (default 1.1)
 *
 * Output: HF, status (healthy | warning | critical | liquidatable),
 * per-asset liquidation prices and drop distances.
 */
import { InputError, nonNeg, pos, strictInput, symbolAggregation } from "./parseJob.js";
import { lpRange } from "./lprange.js";

export function health(params: Record<string, unknown>): Record<string, unknown> {
  // A spec carrying `position` is a PancakeSwap v3 LP range-health job;
  // lending health (collateral/debt) is unchanged below.
  if (params.position !== undefined) {
    // fix 2026-09-02 H98: a spec carrying both an LP position and lending fields
    // got the LP answer while a liquidatable loan was silently dropped; refuse.
    if (strictInput() && (params.collateral !== undefined || params.debt !== undefined)) {
      throw new InputError("spec carries both position (LP range health) and collateral/debt (lending health); send one job per question");
    }
    return { kind: "lp_range", ...lpRange(params) };
  }
  const collRaw = params.collateral;
  if (!Array.isArray(collRaw) || collRaw.length === 0) {
    throw new InputError("collateral must be a non-empty array of {symbol, amount, liqThreshold}");
  }
  const debtRaw = params.debt;
  if (!Array.isArray(debtRaw)) throw new InputError("debt must be an array of {symbol, amount}");
  const pricesRaw = params.prices;
  if (pricesRaw === null || typeof pricesRaw !== "object" || Array.isArray(pricesRaw)) {
    throw new InputError("prices must be an object of {SYMBOL: usd}");
  }
  const alertHF = params.alertHF === undefined ? 1.5 : pos(params.alertHF, "alertHF");
  const criticalHF = params.criticalHF === undefined ? 1.1 : pos(params.criticalHF, "criticalHF");
  if (criticalHF >= alertHF) throw new InputError("criticalHF must be < alertHF");

  const prices = new Map<string, number>();
  for (const [sym, p] of Object.entries(pricesRaw as Record<string, unknown>)) {
    // fix 2026-09-02 H99: two spellings of one price key collapsed to the last value.
    if (strictInput() && prices.has(sym.toUpperCase())) {
      throw new InputError(`prices.${sym.toUpperCase()} appears more than once (keys are case-insensitive)`);
    }
    prices.set(sym.toUpperCase(), pos(p, `prices.${sym}`));
  }
  const px = (sym: string): number => {
    const p = prices.get(sym);
    if (p === undefined) throw new InputError(`prices.${sym} is required`);
    return p;
  };

  type Coll = { symbol: string; amount: number; liqThreshold: number; valueUsd: number };
  const collateral: Coll[] = collRaw.map((c, i) => {
    if (c === null || typeof c !== "object") throw new InputError(`collateral[${i}] must be an object`);
    const rec = c as Record<string, unknown>;
    const symbol = String(rec.symbol ?? "").toUpperCase();
    if (!symbol) throw new InputError(`collateral[${i}].symbol is required`);
    const lt = pos(rec.liqThreshold, `collateral[${i}].liqThreshold`);
    if (lt > 1) throw new InputError(`collateral[${i}].liqThreshold must be in (0, 1]`);
    const amount = nonNeg(rec.amount, `collateral[${i}].amount`);
    return { symbol, amount, liqThreshold: lt, valueUsd: amount * px(symbol) };
  });

  let debtUsd = 0;
  const debts: Array<Record<string, unknown>> = [];
  for (const [i, d] of (debtRaw as unknown[]).entries()) {
    if (d === null || typeof d !== "object") throw new InputError(`debt[${i}] must be an object`);
    const rec = d as Record<string, unknown>;
    const symbol = String(rec.symbol ?? "").toUpperCase();
    if (!symbol) throw new InputError(`debt[${i}].symbol is required`);
    const amount = nonNeg(rec.amount, `debt[${i}].amount`);
    const v = amount * px(symbol);
    debtUsd += v;
    debts.push({ symbol, amount, valueUsd: round(v) });
  }

  const weighted = collateral.reduce((s, c) => s + c.valueUsd * c.liqThreshold, 0);
  const collUsd = collateral.reduce((s, c) => s + c.valueUsd, 0);

  if (debtUsd === 0) {
    return {
      healthFactor: null,
      status: "healthy",
      collateralUsd: round(collUsd),
      debtUsd: 0,
      note: "no debt; health factor is undefined (infinite); position cannot be liquidated",
    };
  }

  const hf = weighted / debtUsd;
  const status =
    hf < 1 ? "liquidatable" : hf < criticalHF ? "critical" : hf < alertHF ? "warning" : "healthy";

  // fix 2026-09-02 H97: the solve below ran per ROW, so a symbol split over two
  // rows treated its own other rows as collateral that holds its value while the
  // symbol falls (5+5 ETH read 500 against a truth of 1250; 4+3+3 read 125 plus
  // two false "other collateral covers the debt" rows). Fold rows per symbol
  // first; each tranche keeps its own threshold through the sum of amount*LT.
  type Agg = { symbol: string; amount: number; amtLT: number };
  const bySymbol = new Map<string, Agg>();
  for (const [i, c] of collateral.entries()) {
    const key = symbolAggregation() ? c.symbol : `${c.symbol}#${i}`;
    const a = bySymbol.get(key) ?? { symbol: c.symbol, amount: 0, amtLT: 0 };
    a.amount += c.amount;
    a.amtLT += c.amount * c.liqThreshold;
    bySymbol.set(key, a);
  }

  // per-asset liquidation price: solve HF = 1 varying only asset a's price:
  //   (weighted - Va*LTa + amount_a*p*LTa) = debtUsd
  //   p = (debtUsd - (weighted - Va*LTa)) / (amount_a * LTa)
  // with amount_a*LTa summed over every row of asset a.
  const liq = [...bySymbol.values()]
    .filter((a) => a.amount > 0)
    .map((a) => {
      const cur = px(a.symbol);
      const other = weighted - cur * a.amtLT;
      const p = (debtUsd - other) / a.amtLT;
      if (p <= 0) {
        return { symbol: a.symbol, liquidationPrice: null, note: "cannot trigger liquidation alone; other collateral covers the debt" };
      }
      const row: Record<string, unknown> = {
        symbol: a.symbol,
        currentPrice: cur,
        liquidationPrice: round(p, 8),
        dropToLiquidationPct: round(((cur - p) / cur) * 100),
      };
      // fix 2026-09-02 H175: past the liquidation price the "drop" is negative; say so in words.
      if (p >= cur) row.note = "price is already at or below the liquidation price; the position is liquidatable now and dropToLiquidationPct is negative";
      return row;
    });

  return {
    healthFactor: round(hf, 4),
    status,
    alertHF,
    criticalHF,
    collateralUsd: round(collUsd),
    debtUsd: round(debtUsd),
    perAssetLiquidation: liq,
  };
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
