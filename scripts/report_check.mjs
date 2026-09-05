// Independent rubric checker for Hire Report tasks 2, 3 and 4.
// Recomputes from first principles per the published formulas; shares no code
// with the agents. Collateral is aggregated by symbol before the per-asset
// solve (2026-09-02), so the check does not share the agents' former
// one-row-per-entry model either. Usage:
//   node scripts/report_check.mjs grid   <inputs.json> <output.json>
//   node scripts/report_check.mjs health <inputs.json> <output.json>
//   node scripts/report_check.mjs rebalance <inputs.json> <output.json>
import { readFileSync } from "fs";

const [, , kind, inputsPath, outputPath] = process.argv;
// 2026-09-05 sweep: a bare run printed a stack trace from readFileSync(undefined); the usage is printed instead,
// with the three commands that check the committed files.
if (!["grid", "health", "rebalance"].includes(kind) || !inputsPath || !outputPath) {
  console.error("usage: node scripts/report_check.mjs <grid|health|rebalance> <inputs.json> <output.json>\n" +
    "  node scripts/report_check.mjs grid      reports/inputs-2026-08-19T14-08-23-148Z.json reports/out-grid.json\n" +
    "  node scripts/report_check.mjs health    reports/inputs-2026-08-19T14-08-23-148Z.json reports/out-health.json\n" +
    "  node scripts/report_check.mjs rebalance reports/inputs4-2026-08-19T19-07-57-388Z.json reports/out-rebalance.json");
  process.exit(2);
}
const inputs = JSON.parse(readFileSync(inputsPath, "utf8"));
const out = JSON.parse(readFileSync(outputPath, "utf8"));
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); };

if (kind === "grid") {
  const t = inputs.task2;
  const buys = out.buyLevels ?? out.buys ?? [];
  const sells = out.sellLevels ?? out.sells ?? [];
  const px = (l) => (typeof l === "number" ? l : l.price);
  check("G1", buys.length === t.levels && sells.length === t.levels
    && buys.every((l) => px(l) < t.price) && sells.every((l) => px(l) > t.price),
    `buys=${buys.length} sells=${sells.length}`);
  const lo = t.price * (1 - t.spanPct / 100), hi = t.price * (1 + t.spanPct / 100);
  check("G2", [...buys, ...sells].every((l) => px(l) >= lo - 1e-9 && px(l) <= hi + 1e-9),
    `span [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
  const want = t.budgetUsd / (t.levels * 2);
  const sz = (l) => l.sizeUsd ?? l.usd ?? l.size;
  check("G3", [...buys, ...sells].every((l) => Math.abs(sz(l) - want) / want <= 0.005),
    `per-level ${want}`);
  let g4 = true;
  for (const l of [...buys, ...sells]) {
    const near = t.walls.some((w) => Math.abs(px(l) - w.price) / px(l) * 100 <= t.wallBandPct);
    const flagged = !!(l.onWall ?? l.wall ?? l.nearWall);
    if (near !== flagged) { g4 = false; break; }
  }
  check("G4", g4, "wall flags match 0.7 percent band");
  const step = (t.price * (t.spanPct / 100)) / t.levels;
  let g5 = true;
  for (let i = 1; i <= t.levels; i++) {
    const wantBuy = t.price - step * i, wantSell = t.price + step * i;
    const haveBuy = px(buys[i - 1] ?? buys[buys.length - i]);
    const haveSell = px(sells[i - 1] ?? sells[sells.length - i]);
    const near = (a, b) => Math.abs(a - b) / b <= 0.001;
    if (!(buys.some((l) => near(px(l), wantBuy)) && sells.some((l) => near(px(l), wantSell)))) { g5 = false; break; }
  }
  check("G5", g5, `step ${step.toFixed(4)}`);
} else if (kind === "health") {
  const t = inputs.task3;
  const p = t.prices;
  // fix 2026-09-03 H203: the debt leg priced an unknown symbol at $1 (`?? 1`) and computed a health
  // factor where health.ts refuses the same input, so the rubric could not detect a missing-price bug
  // in either direction. Refuse what the agent refuses, with the agent's message.
  const priceOf = (sym) => {
    const v = p[sym];
    if (v === undefined) { console.error(`prices.${sym} is required`); process.exit(2); }
    return v;
  };
  const collVal = t.collateral.reduce((s, c) => s + c.amount * priceOf(c.symbol) * c.liqThreshold, 0);
  const debtVal = t.debt.reduce((s, d) => s + d.amount * priceOf(d.symbol), 0);
  const hf = collVal / debtVal;
  const near = (a, b, tol) => Math.abs(a - b) / b <= tol;
  check("H1", near(out.healthFactor ?? out.hf, hf, 0.001), `expect HF ${hf.toFixed(4)}`);
  const status = hf < 1 ? "liquidatable" : hf < t.criticalHF ? "critical" : hf < t.alertHF ? "warning" : "healthy";
  check("H2", (out.status ?? "").toLowerCase() === status, `expect ${status}`);
  let h3 = true, h4 = true;
  // fix 2026-09-02 H202: the solve ran per ROW (object identity), the same one-row-per-entry model as the agents'
  // former solve, so a symbol split over two rows was certified at the wrong price. Aggregate by symbol first.
  const bySymbol = new Map();
  for (const x of t.collateral) { const a = bySymbol.get(x.symbol) ?? { symbol: x.symbol, amount: 0, amtLT: 0 }; a.amount += x.amount; a.amtLT += x.amount * x.liqThreshold; bySymbol.set(x.symbol, a); }
  for (const c of bySymbol.values()) {
    const others = collVal - c.amtLT * p[c.symbol];
    const liqPx = (debtVal - others) / c.amtLT;
    const rec = (out.liquidationPrices ?? out.perAssetLiquidation ?? out.perAsset ?? []).find?.((r) => r.symbol === c.symbol)
      ?? (out.liquidationPrices ?? {})[c.symbol];
    const recPx = typeof rec === "number" ? rec : rec?.liquidationPrice ?? rec?.price;
    if (liqPx <= 0) {
      // this asset alone cannot trigger liquidation (other collateral covers
      // the debt); correct answer is no liquidation price
      if (recPx != null) h3 = false;
      continue;
    }
    if (recPx == null || !near(recPx, liqPx, 0.001)) h3 = false;
    const drop = (p[c.symbol] - liqPx) / p[c.symbol] * 100;
    const recDrop = typeof rec === "object" ? (rec?.dropPct ?? rec?.distancePct) : null;
    if (recDrop != null && !near(recDrop, drop, 0.005)) h4 = false;
  }
  check("H3", h3, "per-asset liquidation prices");
  check("H4", h4, "drop distances (skipped items pass only if absent)");
} else if (kind === "rebalance") {
  const t = inputs.task4;
  const p4 = t.prices;
  const near = (a, b, tol) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) <= tol;
  const vals = {}; let total = 0;
  for (const h of t.holdings) { vals[h.symbol] = h.amount * p4[h.symbol]; total += vals[h.symbol]; }
  check("R1", near(out.portfolioUsd, total, 0.001), `expect total ${total.toFixed(2)}`);
  let r2 = true, expectedTrades = [];
  // fix 2026-09-03 H204: the rubric iterated `holdings` only, so a target symbol the portfolio does not
  // yet hold was never weight-checked and never expected as a trade, and a correct agent that opened the
  // new position failed R3. rebalance.ts iterates the union of holdings and targets; iterate the same set.
  const allSyms = new Set([...t.holdings.map((h) => h.symbol), ...Object.keys(t.targets ?? {})]);
  for (const sym of allSyms) {
    const cur = (vals[sym] ?? 0) / total * 100;
    const tgt = (t.targets[sym] ?? 0) * 100;
    const row = (out.weights ?? []).find((w) => w.symbol === sym);
    if (!row || Math.abs(row.currentWeightPct - cur) > 0.05 || Math.abs(row.targetWeightPct - tgt) > 0.05
        || Math.abs(row.driftPct - (cur - tgt)) > 0.05) r2 = false;
    const deltaUsd = (tgt - cur) / 100 * total;
    if (Math.abs(cur - tgt) > t.driftThresholdPct && Math.abs(deltaUsd) >= t.minTradeUsd)
      expectedTrades.push({ symbol: sym, side: deltaUsd > 0 ? "buy" : "sell", usd: Math.abs(deltaUsd) });
  }
  check("R2", r2, "weights and drift recompute");
  const got = out.trades ?? [];
  let r3 = got.length === expectedTrades.length, r4 = true;
  for (const e of expectedTrades) {
    const g = got.find((x) => x.symbol === e.symbol);
    if (!g || g.side !== e.side) { r3 = false; continue; }
    if (!near(g.usd, e.usd, 0.005) || !near(g.amount, e.usd / p4[e.symbol], 0.005)) r4 = false;
  }
  check("R3", r3, `expect ${expectedTrades.length} trades: ` + expectedTrades.map((e) => e.side + " " + e.symbol).join(", "));
  check("R4", r4, "trade sizes usd and token amounts");
  let lastSell = -1, firstBuy = got.length;
  got.forEach((g, i) => { if (g.side === "sell") lastSell = Math.max(lastSell, i); else firstBuy = Math.min(firstBuy, i); });
  // fix 2026-09-03 H51: R5 is named "self funding order" in the task sheet but only compared indices, so a
  // plan with one sell and no buys (or one buy and no sells) passed. rebalance.ts states the contract:
  // "residualUsd reports the difference (positive = the buys need that much cash) ... The plan is
  // self-funding only when residualUsd is 0". So the sums must net to zero, unless the plan declares the
  // imbalance in residualUsd, in which case the declared figure must match what the trades actually do.
  const sideSum = (side) => got.filter((g) => g.side === side).reduce((s, g) => s + Number(g.usd ?? 0), 0);
  const residual = sideSum("buy") - sideSum("sell");
  const tol = Math.max(total * 0.001, 0.01);
  const declared = out.residualUsd === undefined || out.residualUsd === null ? null : Number(out.residualUsd);
  const selfFunding = Math.abs(residual) <= tol || (declared !== null && Math.abs(declared - residual) <= tol);
  check("R5", (lastSell < firstBuy || got.length === 0) && selfFunding,
    `sells before buys; buys ${sideSum("buy").toFixed(2)} sells ${sideSum("sell").toFixed(2)} residual ${residual.toFixed(2)}`
    + (declared === null ? " (none declared)" : ` declared ${declared}`));
} else {
  console.error("kind must be grid, health or rebalance"); process.exit(2);
}

for (const r of results) console.log((r.ok ? "PASS" : "FAIL"), r.id, r.detail ?? "");
process.exit(results.every((r) => r.ok) ? 0 : 1);
