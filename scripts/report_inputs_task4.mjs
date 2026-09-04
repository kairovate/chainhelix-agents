// Captures the shared inputs for Advantage Report task 4 at run start.
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
// fix 2026-09-03 H205: the fetches had no timeout and no body cap, so a stalled or oversized reply hung the
// capture instead of failing it. Same 10 s abort and 1 MB cap the marketplace uses (scan.js scanFetch/jsonCapped).
const FETCH_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 1_048_576;
async function jsonCapped(res, url) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_JSON_BYTES) throw new Error(url + " -> response body too large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function j(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(url + " -> " + r.status);
    return await jsonCapped(r, url);
  } finally {
    clearTimeout(t);
  }
}
const [btc, eth, bnb] = await Promise.all([
  j("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
  j("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"),
  j("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT"),
]);
const inputs = {
  capturedAt: new Date().toISOString(),
  source: "api.binance.com spot",
  task4: {
    holdings: [
      { symbol: "BTC", amount: 0.4 },
      { symbol: "ETH", amount: 6 },
      { symbol: "BNB", amount: 12 },
    ],
    targets: { BTC: 0.4, ETH: 0.35, BNB: 0.25 },
    prices: { BTC: parseFloat(btc.price), ETH: parseFloat(eth.price), BNB: parseFloat(bnb.price) },
    driftThresholdPct: 1, minTradeUsd: 5,
  },
};
// fix 2026-09-03 H206: new URL(...).pathname percent-encodes a clone path containing a space or a #, so the
// write landed on a bogus name. fileURLToPath decodes it, as marketplace/src/jobstats.js L13 already does.
const path = join(dirname(fileURLToPath(import.meta.url)), "..", "reports",
  "inputs4-" + inputs.capturedAt.replace(/[:.]/g, "-") + ".json");
writeFileSync(path, JSON.stringify(inputs, null, 2));
console.log(path); console.log(JSON.stringify(inputs.task4.prices));
