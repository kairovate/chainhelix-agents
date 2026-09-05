/** Golden-case tests for the four strategy cores + parser + dispatcher. Run: tsx test.ts */
import { parseJobInput } from "./parseJob.js";
import { rebalance } from "./rebalance.js";
import { grid } from "./grid.js";
import { yieldOpt } from "./yieldopt.js";
import { health } from "./health.js";
import { makeRunWork, _setEngine } from "./dispatch.js";
import { parseKeyValues } from "./parseJob.js";
import { WORK_SCHEMAS, paramHint, exampleTaskDescription, inputSchema } from "./schema.js";
import { renderCatalog, renderWorkSchemas } from "./emit_catalog_schema.js";
import { readFileSync, existsSync } from "fs";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}
function throws(name: string, fn: () => unknown, needle: string) {
  try { fn(); ok(name, false, "no throw"); }
  catch (e) { ok(name, String(e).includes(needle), String(e)); }
}

// ---- parser
const p1 = parseJobInput('You accepted... JOB CONTEXT:\n{"task":"rebalance me","terms":{"deliverables":"x"},"params":{"a":1}}');
ok("parser: extracts embedded JSON", !("error" in p1) && p1.task === "rebalance me" && p1.params.a === 1);
const p2 = parseJobInput("no json here");
ok("parser: structured failure on prose", "error" in p2);
const p3 = parseJobInput('{"task":"t","price":"5"} trailing text {"other":1}');
ok("parser: first balanced object wins", !("error" in p3) && (p3 as { params: Record<string, unknown> }).params.price === "5");
const p4 = parseJobInput('prefix {"task":"t","note":"brace \\" in { string }"} suffix');
ok("parser: braces inside strings ignored", !("error" in p4));

const p5 = parseJobInput('JOB CONTEXT:\n{"task":"{\\"goal\\":\\"rebalance\\",\\"price\\":100}","terms":{"deliverables":"d"}}');
ok("parser: JSON inside task string is merged into params", !("error" in p5) && (p5 as {params:Record<string,unknown>}).params.price === 100);

// ---- rebalance
const rb = rebalance({
  holdings: [{ symbol: "btc", amount: 1 }, { symbol: "eth", amount: 10 }],
  targets: { BTC: 0.5, ETH: 0.5 },
  prices: { BTC: 60000, ETH: 2000 },
});
ok("rebalance: total value", (rb.portfolioUsd as number) === 80000);
const rbTrades = rb.trades as Array<{ symbol: string; side: string; usd: number }>;
ok("rebalance: sells btc buys eth", rbTrades.length === 2 && rbTrades[0].side === "sell" && rbTrades[0].symbol === "BTC" && rbTrades[1].side === "buy");
ok("rebalance: trade sizes are the 20k drift", rbTrades[0].usd === 20000 && rbTrades[1].usd === 20000);
const rbFlat = rebalance({
  holdings: [{ symbol: "btc", amount: 1 }], targets: { BTC: 1 }, prices: { BTC: 60000 },
});
ok("rebalance: on-target emits no trades", (rbFlat.trades as unknown[]).length === 0 && rbFlat.tradesNeeded === false);
throws("rebalance: weights must sum to 1", () => rebalance({ holdings: [{ symbol: "a", amount: 1 }], targets: { A: 0.6 }, prices: { A: 1 } }), "sum to 1");
throws("rebalance: missing price rejected", () => rebalance({ holdings: [{ symbol: "a", amount: 1 }], targets: { A: 0.5, B: 0.5 }, prices: { A: 1 } }), "prices.B");
// fix 2026-09-02 H36/H282: filtered plans report their residual instead of claiming self-funding
const rbRes = rebalance({
  holdings: [{ symbol: "BTC", amount: 1 }, { symbol: "ETH", amount: 10 }, { symbol: "BNB", amount: 10 }],
  targets: { BTC: 0.5, ETH: 0.3, BNB: 0.2 }, prices: { BTC: 60000, ETH: 2000, BNB: 1980 },
});
ok("rebalance: B4-50 three-asset plan reports residualUsd -160 and names the skipped BNB leg", rbRes.residualUsd === -160 && String(rbRes.note).includes("160") && String(rbRes.note).includes("BNB") && (rbRes.trades as unknown[]).length === 2);
const rbDef = rebalance({
  holdings: [{ symbol: "BNB", amount: 1060 }, { symbol: "BTC", amount: 980 }, { symbol: "ETH", amount: 980 }, { symbol: "USDT", amount: 980 }],
  targets: { BNB: 0.25, BTC: 0.25, ETH: 0.25, USDT: 0.25 }, prices: { BNB: 1, BTC: 1, ETH: 1, USDT: 1 },
});
ok("rebalance: B1-33 default-parameter plan (sell 60, buy nothing) reports residualUsd -60", rbDef.residualUsd === -60 && (rbDef.trades as unknown[]).length === 1);
const rbBuy = rebalance({
  holdings: [{ symbol: "A", amount: 1000 }, { symbol: "B", amount: 1000 }, { symbol: "C", amount: 1000 }, { symbol: "D", amount: 940 }],
  targets: { A: 0.25, B: 0.25, C: 0.25, D: 0.25 }, prices: { A: 1, B: 1, C: 1, D: 1 }, minTradeUsd: 16, driftThresholdPct: 0.1,
});
ok("rebalance: B1-33 buy-side variant reports residualUsd +45 (cash the plan was not given)", rbBuy.residualUsd === 45 && String(rbBuy.note).includes("needs that much cash"));
ok("rebalance: balanced control plan has residualUsd 0 and no note", rb.residualUsd === 0 && rb.note === undefined);
throws("rebalance: negative amount rejected", () => rebalance({ holdings: [{ symbol: "a", amount: -1 }], targets: { A: 1 }, prices: { A: 1 } }), ">= 0");

// ---- grid
const g = grid({ price: 100, budgetUsd: 1000, levels: 5, spanPct: 5 });
const buys = g.buys as Array<{ price: number; sizeUsd: number }>;
const sells = g.sells as Array<{ price: number }>;
ok("grid: 5 buys 5 sells", buys.length === 5 && sells.length === 5);
ok("grid: first buy one step below", buys[0].price === 99 && sells[0].price === 101);
ok("grid: outermost at span edge", buys[4].price === 95 && sells[4].price === 105);
ok("grid: equal USD ladder", buys.every((b) => b.sizeUsd === 100));
const gw = grid({ price: 100, budgetUsd: 1000, levels: 2, spanPct: 4, walls: [{ price: 98.1, touches: 9 }], wallBandPct: 0.7 });
const gwBuys = gw.buys as Array<Record<string, unknown>>;
ok("grid: wall annotated with distance", gwBuys[0].nearestWall === 98.1 && typeof gwBuys[0].wallDistPct === "number");
ok("grid: on-wall flag set for the 98 level", gwBuys[0].onWall === true && gwBuys[1].onWall === false && (gw.levelsOnWalls as number) === 1);
throws("grid: zero price rejected", () => grid({ price: 0, budgetUsd: 1000 }), "> 0");
throws("grid: span >= 100 rejected", () => grid({ price: 100, budgetUsd: 1000, spanPct: 120 }), "< 100");

// ---- yield
const y = yieldOpt({
  pools: [
    { name: "safe", apyPct: 5, riskScore: 1 },
    { name: "degen", apyPct: 30, riskScore: 5 },
    { name: "mid", apyPct: 12, riskScore: 3 },
  ],
  capitalUsd: 1000, maxPerPoolPct: 40, riskAversion: 1,
});
const yAlloc = y.allocations as Array<{ pool: string; allocUsd: number }>;
ok("yield: full aversion ranks by discounted APY (mid first: 12*0.5=6 > safe 5 > degen 0)", yAlloc[0].pool === "mid" && yAlloc[1].pool === "safe");
ok("yield: concentration cap binds at 400", yAlloc[0].allocUsd === 400 && yAlloc[1].allocUsd === 400);
ok("yield: remainder reported not hidden", (y.allocatedUsd as number) === 1000 || (y.unallocatedUsd as number) > 0);
const yTvl = yieldOpt({ pools: [{ name: "tiny", apyPct: 50, tvlUsd: 1000 }], capitalUsd: 10000, tvlCapPct: 5 });
ok("yield: tvl cap binds (5% of 1000 = 50)", (yTvl.allocations as Array<{ allocUsd: number }>)[0].allocUsd === 50 && (yTvl.unallocatedUsd as number) === 9950);
throws("yield: duplicate pool names rejected", () => yieldOpt({ pools: [{ name: "a", apyPct: 1 }, { name: "a", apyPct: 2 }], capitalUsd: 1 }), "unique");

// ---- health
const h = health({
  collateral: [{ symbol: "eth", amount: 10, liqThreshold: 0.8 }],
  debt: [{ symbol: "usdt", amount: 10000 }],
  prices: { ETH: 2000, USDT: 1 },
});
ok("health: HF = 10*2000*0.8/10000 = 1.6", h.healthFactor === 1.6 && h.status === "healthy");
const hLiq = (h.perAssetLiquidation as Array<{ liquidationPrice: number; dropToLiquidationPct: number }>)[0];
ok("health: eth liquidation price 1250", hLiq.liquidationPrice === 1250 && hLiq.dropToLiquidationPct === 37.5);
const h2 = health({
  collateral: [{ symbol: "eth", amount: 10, liqThreshold: 0.8 }],
  debt: [{ symbol: "usdt", amount: 15000 }],
  prices: { ETH: 2000, USDT: 1 },
});
ok("health: HF 1.0667 => critical", h2.healthFactor === 1.0667 && h2.status === "critical");
const h3 = health({ collateral: [{ symbol: "eth", amount: 1, liqThreshold: 0.8 }], debt: [], prices: { ETH: 2000 } });
ok("health: no debt => undefined HF, healthy", h3.healthFactor === null && h3.status === "healthy");
throws("health: liqThreshold > 1 rejected", () => health({ collateral: [{ symbol: "e", amount: 1, liqThreshold: 1.2 }], debt: [], prices: { E: 1 } }), "(0, 1]");
const h4 = health({
  collateral: [{ symbol: "eth", amount: 10, liqThreshold: 0.8 }, { symbol: "btc", amount: 1, liqThreshold: 0.85 }],
  debt: [{ symbol: "usdt", amount: 10000 }],
  prices: { ETH: 2000, BTC: 60000, USDT: 1 },
});
const h4liq = h4.perAssetLiquidation as Array<{ symbol: string; liquidationPrice: number | null }>;
ok("health: asset covered by other collateral has null liq price", h4liq.find((x) => x.symbol === "ETH")!.liquidationPrice === null);

// ---- fix 2026-09-02 H97/H98/H99/H32/H175: symbol folding and strict input (exact verification inputs)
type LiqRow = { symbol: string; liquidationPrice: number | null; dropToLiquidationPct?: number; note?: string };
const hSplit = health({
  collateral: [{ symbol: "ETH", amount: 5, liqThreshold: 0.8 }, { symbol: "ETH", amount: 5, liqThreshold: 0.8 }],
  debt: [{ symbol: "usdt", amount: 10000 }], prices: { ETH: 2000, USDT: 1 },
});
const hSplitLiq = hSplit.perAssetLiquidation as LiqRow[];
ok("health: 5+5 split folds to one row at 1250 / 37.5 (was two rows at 500 / 75)", hSplit.healthFactor === 1.6 && hSplitLiq.length === 1 && hSplitLiq[0].liquidationPrice === 1250 && hSplitLiq[0].dropToLiquidationPct === 37.5);
const hThree = health({
  collateral: [{ symbol: "ETH", amount: 4, liqThreshold: 0.8 }, { symbol: "ETH", amount: 3, liqThreshold: 0.8 }, { symbol: "ETH", amount: 3, liqThreshold: 0.8 }],
  debt: [{ symbol: "usdt", amount: 10000 }], prices: { ETH: 2000, USDT: 1 },
});
const hThreeLiq = hThree.perAssetLiquidation as LiqRow[];
ok("health: 4+3+3 split folds to one row at 1250 (was 125 plus two false null rows)", hThreeLiq.length === 1 && hThreeLiq[0].liquidationPrice === 1250);
const hMixed = health({
  collateral: [{ symbol: "ETH", amount: 5, liqThreshold: 0.8 }, { symbol: "ETH", amount: 5, liqThreshold: 0.6 }],
  debt: [{ symbol: "usdt", amount: 10000 }], prices: { ETH: 2000, USDT: 1 },
});
ok("health: tranches with different thresholds solve on the summed amount*LT (10000/7 = 1428.57142857)", (hMixed.perAssetLiquidation as LiqRow[])[0].liquidationPrice === 1428.57142857);
throws("health: empty-string debt amount rejected (was a silent 0 and 'healthy')", () => health({ collateral: [{ symbol: "eth", amount: 2.5, liqThreshold: 0.8 }], debt: [{ symbol: "usdt", amount: "" }], prices: { ETH: 2400, USDT: 1 } }), "empty string");
throws("health: whitespace collateral amount rejected (was a silent 0 and 'liquidatable')", () => health({ collateral: [{ symbol: "eth", amount: "  ", liqThreshold: 0.8 }], debt: [{ symbol: "usdt", amount: 3000 }], prices: { ETH: 2400, USDT: 1 } }), "empty string");
throws("health: position plus collateral/debt refused (was the LP answer with the loan dropped)", () => health({ position: { price: 605, lowerPrice: 580, upperPrice: 640 }, collateral: [{ symbol: "eth", amount: 1, liqThreshold: 0.8 }], debt: [{ symbol: "usdt", amount: 1900 }], prices: { ETH: 2000, USDT: 1 } }), "one job per question");
throws("health: duplicate price key across case rejected", () => health({ collateral: [{ symbol: "eth", amount: 10, liqThreshold: 0.8 }], debt: [{ symbol: "usdt", amount: 10000 }], prices: { ETH: 2000, eth: 1, USDT: 1 } }), "more than once");
const hPast = health({ collateral: [{ symbol: "eth", amount: 1, liqThreshold: 0.8 }], debt: [{ symbol: "usdt", amount: 5000 }], prices: { ETH: 2000, USDT: 1 } });
const hPastLiq = (hPast.perAssetLiquidation as LiqRow[])[0];
ok("health: already liquidatable carries a note next to the negative drop", hPast.status === "liquidatable" && hPastLiq.liquidationPrice === 6250 && hPastLiq.dropToLiquidationPct === -212.5 && String(hPastLiq.note).includes("liquidatable now"));
throws("rebalance: duplicate target key across case rejected (was a sell-half plan)", () => rebalance({ holdings: [{ symbol: "btc", amount: 1 }], targets: { BTC: 0.5, btc: 0.5 }, prices: { BTC: 60000 } }), "more than once");
throws("rebalance: duplicate price key across case rejected (was marked at 1)", () => rebalance({ holdings: [{ symbol: "btc", amount: 1 }], targets: { BTC: 1 }, prices: { BTC: 60000, btc: 1 } }), "more than once");
// kill switches restore the previous behaviour exactly
process.env.STRATEGY_SYMBOL_AGGREGATION = "0";
const hSplitOff = health({
  collateral: [{ symbol: "ETH", amount: 5, liqThreshold: 0.8 }, { symbol: "ETH", amount: 5, liqThreshold: 0.8 }],
  debt: [{ symbol: "usdt", amount: 10000 }], prices: { ETH: 2000, USDT: 1 },
});
const hSplitOffLiq = hSplitOff.perAssetLiquidation as LiqRow[];
ok("kill switch: STRATEGY_SYMBOL_AGGREGATION=0 restores the per-row solve (two rows at 500)", hSplitOffLiq.length === 2 && hSplitOffLiq[0].liquidationPrice === 500 && hSplitOffLiq[1].liquidationPrice === 500);
delete process.env.STRATEGY_SYMBOL_AGGREGATION;
process.env.STRATEGY_STRICT_INPUT = "0";
const rbOff = rebalance({ holdings: [{ symbol: "btc", amount: 1 }], targets: { BTC: 0.5, btc: 0.5 }, prices: { BTC: 60000 } });
const hEmptyOff = health({ collateral: [{ symbol: "eth", amount: 2.5, liqThreshold: 0.8 }], debt: [{ symbol: "usdt", amount: "" }], prices: { ETH: 2400, USDT: 1 } });
ok("kill switch: STRATEGY_STRICT_INPUT=0 restores lenient parsing (sell-half plan, blank debt as 0)", (rbOff.trades as unknown[]).length === 1 && hEmptyOff.debtUsd === 0);
delete process.env.STRATEGY_STRICT_INPUT;

// ---- dispatcher end-to-end (the exact prompt shape sellerCore builds)
(async () => {
  const run = makeRunWork("health");
  const prompt =
    "You accepted and were paid for the following job. Produce the deliverable now. Be complete and self-contained.\n\n" +
    'JOB CONTEXT:\n{"task":"monitor my loan","terms":{"deliverables":"health report","collateral":[{"symbol":"eth","amount":10,"liqThreshold":0.8}],"debt":[{"symbol":"usdt","amount":10000}],"prices":{"ETH":2000,"USDT":1}}}';
  const out = JSON.parse(await run(prompt));
  ok("dispatch: seller prompt -> health deliverable", out.ok === true && out.healthFactor === 1.6);
  const bad = JSON.parse(await run("gibberish with no json"));
  ok("dispatch: refusal is structured, never a throw", bad.ok === false && typeof bad.error === "string");
  const badInput = JSON.parse(await run('{"task":"t","collateral":[],"debt":[],"prices":{}}'));
  ok("dispatch: input error surfaces as readable refusal", badInput.ok === false && badInput.error.includes("collateral"));

    // object-form (bracket-free wire schema) end-to-end per category
  const runs = { rebalancing: makeRunWork("rebalancing"), health: makeRunWork("health"), yield: makeRunWork("yield"), grid: makeRunWork("grid") };
  const objJobs: Record<string, string> = {
    rebalancing: '{"task":"t","holdings":{"btc":1},"targets":{"BTC":1},"prices":{"BTC":60000}}',
    health: '{"task":"t","collateral":{"eth":{"amount":10,"liqThreshold":0.8}},"debt":{"usdt":10000},"prices":{"ETH":2000,"USDT":1}}',
    yield: '{"task":"t","pools":{"safe":{"apyPct":5,"riskScore":1}},"capitalUsd":100}',
    grid: '{"task":"t","price":100,"budgetUsd":1000,"walls":{"98.1":9}}',
  };
  for (const [cat, j] of Object.entries(objJobs)) {
    const r = JSON.parse(await (runs as Record<string, (p: string) => Promise<string>>)[cat]("JOB CONTEXT:\n" + j));
    ok("object-form: " + cat, r.ok === true && r.category === cat);
  }
  const hObj = JSON.parse(await runs.health('{"task":"t","collateral":{"eth":{"amount":10,"liqThreshold":0.8}},"debt":{"usdt":10000},"prices":{"ETH":2000,"USDT":1}}'));
  ok("object-form: health math identical", hObj.healthFactor === 1.6);
  // fix 2026-09-02 H97: the documented object form with two spellings of one symbol
  const hDup = JSON.parse(await runs.health('{"task":"t","collateral":{"eth":{"amount":5,"liqThreshold":0.8},"ETH":{"amount":5,"liqThreshold":0.8}},"debt":{"usdt":10000},"prices":{"ETH":2000,"USDT":1}}'));
  ok("object-form: eth + ETH fold to one row at 1250", hDup.ok === true && hDup.perAssetLiquidation.length === 1 && hDup.perAssetLiquidation[0].liquidationPrice === 1250);
  const rbDup = JSON.parse(await runs.rebalancing('{"task":"t","holdings":{"btc":1},"targets":{"BTC":0.5,"btc":0.5},"prices":{"BTC":60000}}'));
  ok("object-form: duplicate target key is a readable refusal, not a plan", rbDup.ok === false && String(rbDup.error).includes("more than once"));

  // lp range (PancakeSwap v3) via the health agent
  const lp1 = JSON.parse(await runs.health('{"task":"t","position":{"price":605,"lowerPrice":580,"upperPrice":640}}'));
  ok("lprange: in range", lp1.ok === true && lp1.kind === "lp_range" && lp1.inRange === true && lp1.status === "in_range");
  ok("lprange: band position", Math.abs(lp1.bandPosPct - 41.67) < 0.01);
  const lp2 = JSON.parse(await runs.health('{"task":"t","position":{"price":575,"lowerPrice":580,"upperPrice":640}}'));
  ok("lprange: out of range below, no-fees note", lp2.inRange === false && lp2.status === "out_of_range_below" && String(lp2.note).includes("no fees"));
  const lp3 = JSON.parse(await runs.health('{"task":"t","position":{"price":633,"lowerPrice":580,"upperPrice":640}}'));
  ok("lprange: near upper edge", lp3.status === "near_upper_edge");
  const lp4 = JSON.parse(await runs.health('{"task":"t","position":{"price":605,"lowerPrice":580,"upperPrice":640,"feesEarnedUsd":50,"positionValueUsd":10000,"ageDays":30}}'));
  ok("lprange: fee run-rate", Math.abs(lp4.feeAprPct - 6.08) < 0.01);
  const lp5 = JSON.parse(await runs.health('{"task":"t","position":{"price":605,"lowerPrice":580,"upperPrice":640},"walls":{"579.5":7,"642.0":4}}'));
  ok("lprange: object-form walls annotate edges", lp5.lowerEdge.onWall === true && lp5.lowerEdge.touches === 7 && lp5.upperEdge.nearestWall === 642);
  const lp6 = JSON.parse(await runs.health('{"task":"t","position":{"price":605,"lowerPrice":650,"upperPrice":640}}'));
  ok("lprange: inverted bounds refused readably", lp6.ok === false && lp6.error.includes("upperPrice"));
  const lendStill = JSON.parse(await runs.health('{"task":"t","collateral":{"eth":{"amount":10,"liqThreshold":0.8}},"debt":{"usdt":10000},"prices":{"ETH":2000,"USDT":1}}'));
  ok("lprange: lending path untouched", lendStill.healthFactor === 1.6 && lendStill.kind === undefined);

  // fix 2026-09-02 H31/H68: internal errors are rethrown (job stays funded); key=value carrier; hints
  _setEngine("grid", () => { throw new TypeError("boom"); });
  let threw = "";
  try { await runs.grid('{"task":"t","price":100,"budgetUsd":1000}'); } catch (e) { threw = String(e); }
  ok("dispatch: internal error is rethrown, not delivered as a refusal", threw.includes("internal error producing deliverable") && threw.includes("boom"));
  process.env.STRATEGY_STRICT_INPUT = "0";
  const offRef = JSON.parse(await runs.grid('{"task":"t","price":100,"budgetUsd":1000}'));
  ok("kill switch: STRATEGY_STRICT_INPUT=0 restores a refusal without the redemption promise", offRef.ok === false && offRef.error === "internal error producing deliverable" && !JSON.stringify(offRef).includes("redemption"));
  delete process.env.STRATEGY_STRICT_INPUT;
  _setEngine("grid", null);
  const backOk = JSON.parse(await runs.grid('{"task":"t","price":100,"budgetUsd":1000}'));
  ok("dispatch: engine restored after the seam", backOk.ok === true);
  const kv = parseKeyValues("POSITIONCREW_BOUNDED_GRID_V1; request=pancake-grid-119215728; chain=56; pair=WBNB/USDT; mid=691.652751; lower=677.819696; upper=705.485806; levels=5; capitalUsd=1000.00");
  ok("parser: key=value carrier (job 56680 shape) yields typed params", kv.chain === 56 && kv.pair === "WBNB/USDT" && kv.mid === 691.652751 && kv.levels === 5 && kv.capitalUsd === 1000 && kv.request === "pancake-grid-119215728");
  const kvJob = JSON.parse(await runs.grid('JOB CONTEXT:\n{"task":"POSITIONCREW_BOUNDED_GRID_V1; request=pancake-grid-119215728; chain=56; pair=WBNB/USDT; mid=691.652751; lower=677.819696; upper=705.485806; levels=5; capitalUsd=1000.00","terms":{"deliverables":"grid"}}'));
  // 2026-09-05 (brief section 11 acceptance 1): with the DECLARED aliases (mid -> price, capitalUsd -> budgetUsd,
  // lower/upper -> spanPct) this request is SERVED, with the numbers asserted, not merely ok === true.
  ok("dispatch: the job 56680 key=value request is served through the declared aliases", kvJob.ok === true && kvJob.mark === 691.652751 && kvJob.budgetUsd === 1000 && kvJob.levelsPerSide === 5 && Math.abs(Number(kvJob.spanPct) - 2.0) < 0.01, kvJob);
  ok("dispatch: served grid has 5 buys below and 5 sells above the mark", Array.isArray(kvJob.buys) && kvJob.buys.length === 5 && kvJob.buys.every((b: { price: number }) => b.price < 691.652751) && Array.isArray(kvJob.sells) && kvJob.sells.length === 5 && kvJob.sells.every((b: { price: number }) => b.price > 691.652751), kvJob);
  ok("dispatch: served grid ladders the whole budget", Math.abs(Number(kvJob.allocatedUsd) - 1000) < 1, kvJob.allocatedUsd);
  process.env.STRATEGY_INPUT_ALIASES = "0";
  const kvOff = JSON.parse(await runs.grid('JOB CONTEXT:\n{"task":"mid=691.652751; capitalUsd=1000","terms":{"deliverables":"grid"}}'));
  ok("kill switch: STRATEGY_INPUT_ALIASES=0 restores the exact-name refusal, hint still names price and budgetUsd", kvOff.ok === false && String(kvOff.error).includes("price") && String(kvOff.hint).includes("price"));
  delete process.env.STRATEGY_INPUT_ALIASES;
  const canon = JSON.parse(await runs.grid('JOB CONTEXT:\n{"task":"{\\"price\\":100,\\"mid\\":5,\\"budgetUsd\\":1000,\\"budget\\":1}","terms":{"deliverables":"grid"}}'));
  ok("aliases: the canonical name wins when both are present", canon.ok === true && canon.mark === 100 && canon.budgetUsd === 1000, canon);
  const rbAlias = JSON.parse(await runs.rebalancing('JOB CONTEXT:\n{"task":"{\\"positions\\":{\\"BTC\\":1,\\"ETH\\":10},\\"weights\\":{\\"BTC\\":0.5,\\"ETH\\":0.5},\\"marks\\":{\\"BTC\\":60000,\\"ETH\\":2000}}","terms":{"deliverables":"plan"}}'));
  ok("aliases: rebalancing positions/weights/marks are served", rbAlias.ok === true && rbAlias.portfolioUsd === 80000, rbAlias);
  const yAlias = JSON.parse(await runs.yield('JOB CONTEXT:\n{"task":"{\\"vaults\\":{\\"a\\":{\\"apyPct\\":10}},\\"budgetUsd\\":1000}","terms":{"deliverables":"alloc"}}'));
  ok("aliases: yield vaults/budgetUsd are served", yAlias.ok === true, yAlias);
  const hAlias = JSON.parse(await runs.health('JOB CONTEXT:\n{"task":"{\\"deposits\\":{\\"ETH\\":{\\"amount\\":10,\\"liqThreshold\\":0.8}},\\"borrowed\\":{\\"USDT\\":10000},\\"marks\\":{\\"ETH\\":2000,\\"USDT\\":1}}","terms":{"deliverables":"hf"}}'));
  ok("aliases: health deposits/borrowed/marks are served", hAlias.ok === true && typeof hAlias.healthFactor === "number", hAlias);
  ok("aliases: every alias is printed in the refusal hint", (["rebalancing", "grid", "yield", "health"] as const).every((c) => WORK_SCHEMAS[c].params.every((q) => !q.aliases || q.aliases.every((a) => paramHint(c).includes(a)))));

  // ---- fix 2026-09-05 (H68 completed): schema.ts is the one source for the card and the refusal.
  // Every published example is served, every required parameter is named when missing, and the
  // dispatcher's hint is byte-equal to what the card is generated from. Prompt shape is the one
  // sellerCore builds: JOB CONTEXT then {"task": <task_description verbatim>, "terms": {...}}.
  for (const cat of ["rebalancing", "grid", "yield", "health"] as const) {
    const sch = WORK_SCHEMAS[cat];
    const prompt = (task: string) => "You accepted and were paid for the following job. Produce the deliverable now.\n\nJOB CONTEXT:\n" + JSON.stringify({ task, terms: { deliverables: sch.name, quality_standards: "deterministic" } });
    const served = JSON.parse(await (runs as Record<string, (p: string) => Promise<string>>)[cat](prompt(exampleTaskDescription(cat))));
    ok(`schema ${cat}: the card's example task_description is served`, served.ok === true && served.category === cat, served);
    for (const req of sch.params.filter((q) => q.required)) {
      if (cat === "health" && (req.name === "collateral" || req.name === "debt")) continue; // either-or with position, covered by the H98 cases
      const dropped = { ...sch.example }; delete dropped[req.name];
      const r = JSON.parse(await (runs as Record<string, (p: string) => Promise<string>>)[cat](prompt(JSON.stringify(dropped))));
      ok(`schema ${cat}: missing ${req.name} is refused and named`, r.ok === false && String(r.error).includes(req.name) && String(r.hint) === paramHint(cat), r);
    }
    ok(`schema ${cat}: hint carries the example`, paramHint(cat).includes(exampleTaskDescription(cat)));
    ok(`schema ${cat}: every declared name is one the engine reads`, sch.params.every((q) => q.name in sch.example || !q.required));
    const js = inputSchema(cat) as { properties: Record<string, unknown>; required: string[]; anyOf?: { required: string[] }[] };
    const jsRequired = cat === "health" ? (js.anyOf ?? [])[0]?.required ?? [] : js.required; // sweep 2026-09-05: health states its two shapes as anyOf
    ok(`schema ${cat}: the JSON Schema lists exactly the card's parameters`, Object.keys(js.properties).join() === sch.params.map((q) => q.name).join() && jsRequired.join() === sch.params.filter((q) => q.required).map((q) => q.name).join(), js);
    ok(`schema ${cat}: the example satisfies the JSON Schema's required list`, jsRequired.every((n) => n in sch.example));
    if (cat === "health") ok("schema health: the JSON Schema states the LP shape (position) as the second anyOf branch and requires nothing at the top", js.required.length === 0 && JSON.stringify((js.anyOf ?? [])[1]) === JSON.stringify({ required: ["position"] }));
  }
  // the storefront's Job input table is generated from the same source; a stale catalog.json fails here.
  // Only where the catalog exists next to this tree (the vendored copies inside the agents have none).
  const catalogPath = new URL("../marketplace/catalog.json", import.meta.url).pathname;
  if (existsSync(catalogPath)) {
    const cur = readFileSync(catalogPath, "utf8");
    ok("schema: marketplace/catalog.json inputSchema is current with schema.ts (run strategies/emit_catalog_schema.ts)", renderCatalog(cur) === cur);
    const wsPath = catalogPath.replace(/catalog\.json$/, "work_schemas.json");
    ok("schema: marketplace/work_schemas.json (the MCP bridge) is current with schema.ts", existsSync(wsPath) && readFileSync(wsPath, "utf8") === renderWorkSchemas(cur));
  }

  const plain = parseKeyValues("no pairs here");
  ok("parser: prose yields no key=value params", Object.keys(plain).length === 0);

  // ---- fix 2026-09-03 H100 H176 H288: one regression case per LOW-tier strategy fix in this run.
  // The suite had no negative coverage for any defect the sweeps found; every earlier case is a
  // single-entry well-formed input. `throws()` already existed, so the gap was coverage, not harness.
  throws("H94/H170/H280: a hex amount is refused, not read as 16",
    () => rebalance({ holdings: [{ symbol: "BTC", amount: "0x10" }], targets: { BTC: 1 }, prices: { BTC: 100 } }),
    "decimal form");
  throws("H94/H170/H280: a numeric-separator amount is refused",
    () => rebalance({ holdings: [{ symbol: "BTC", amount: "1_0" }], targets: { BTC: 1 }, prices: { BTC: 100 } }),
    "must be a finite number");
  ok("H94/H170/H280: plain decimal and exponent forms still parse",
    (rebalance({ holdings: [{ symbol: "A", amount: "1e3" }], targets: { A: 1 }, prices: { A: "2.5" } }) as Record<string, unknown>).portfolioUsd === 2500);
  const bigJunk = parseJobInput("JOB CONTEXT:\n" + "{".repeat(2_000_000));
  ok("H281: an unbalanced prompt past the scan cap is a structured refusal, not a hang", "error" in bigJunk);
  const shadow = health({
    collateral: [{ symbol: "ETH", amount: 1, liqThreshold: 0.8 }],
    debt: [{ symbol: "USDT", amount: 100 }], prices: { ETH: 2000, USDT: 1 },
  }) as Record<string, unknown>;
  ok("H96: control, an unshadowed collateral row keeps its symbol",
    ((shadow.perAssetLiquidation as Record<string, unknown>[])[0]).symbol === "ETH");
  const gridBudget = grid({ price: 100, budgetUsd: 1000, levels: 3 }) as Record<string, unknown>;
  const ladderSum = [...(gridBudget.buys as Record<string, unknown>[]), ...(gridBudget.sells as Record<string, unknown>[])]
    .reduce((s, l) => s + (l.sizeUsd as number), 0);
  ok("H171: the rounded ladder never sums above budgetUsd",
    ladderSum <= (gridBudget.budgetUsd as number) && gridBudget.allocatedUsd === Math.round(ladderSum * 100) / 100,
    { ladderSum, budgetUsd: gridBudget.budgetUsd, allocatedUsd: gridBudget.allocatedUsd });
  const sideGrid = grid({ price: 100, budgetUsd: 1000, levels: 2, walls: [{ price: 97.6, touches: 9, side: "resistance" }] }) as Record<string, unknown>;
  ok("H283: a buy level is not annotated with a resistance wall",
    (sideGrid.buys as Record<string, unknown>[]).every((b) => b.nearestWall === undefined));
  const supportGrid = grid({ price: 100, budgetUsd: 1000, levels: 2, walls: [{ price: 97.6, touches: 9, side: "support" }] }) as Record<string, unknown>;
  ok("H283: the same wall declared support still annotates the buy level",
    (supportGrid.buys as Record<string, unknown>[])[0].nearestWall === 97.6);
  throws("H283: an unknown walls[].side is refused",
    () => grid({ price: 100, budgetUsd: 1000, walls: [{ price: 99, side: "up" }] }), 'side must be "support" or "resistance"');
  throws("H172: grid and lprange share one walls[].touches contract",
    () => health({ position: { price: 100, lowerPrice: 90, upperPrice: 110 }, walls: [{ price: 91, touches: 0 }] }),
    "touches must be an integer in [1, 10000]");
  throws("H35: a partial fee block names every missing field, not the first",
    () => health({ position: { price: 100, lowerPrice: 90, upperPrice: 110, ageDays: 30 } }),
    "missing: position.feesEarnedUsd, position.positionValueUsd");
  const drift = rebalance({
    holdings: [{ symbol: "A", amount: 1120 }, { symbol: "B", amount: 960 }, { symbol: "C", amount: 960 }, { symbol: "D", amount: 960 }],
    targets: { A: 0.25, B: 0.25, C: 0.25, D: 0.25 }, prices: { A: 1, B: 1, C: 1, D: 1 }, driftThresholdPct: 1,
  }) as Record<string, unknown>;
  ok("H37: a leg whose SHOWN drift equals the threshold gets no trade",
    (drift.trades as Record<string, unknown>[]).every((t) => t.symbol !== "B"),
    drift.trades);
  const caps = yieldOpt({ capitalUsd: 1000, maxPerPoolPct: 50, pools: [{ name: "a", apyPct: 10 }, { name: "b", apyPct: 9 }] }) as Record<string, unknown>;
  ok("H38/H287: a pool bound by BOTH capital and concentration is labelled capital",
    (caps.allocations as Record<string, unknown>[])[1].capBound === "capital",
    caps.allocations);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
