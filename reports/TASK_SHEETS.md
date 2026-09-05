# Agent Hire Report: frozen task sheets and rubrics

Frozen and committed BEFORE any run, agent or manual. Both sides of every task
receive identical inputs, captured at run start by the committed scripts. The
rubric checker (scripts/report_check.mjs) recomputes every figure of tasks 2,
3 and 4 from first principles and shares no code with the agents; task 1 is
scored by hand against its checklist (no checker covers it). Amendment
2026-09-02: the checker aggregates collateral by symbol before the per-asset
solve, so it no longer shares the agents' former one-row-per-entry model.

Manual cost (amendment v3, 2026-08-19): no hourly rate is assumed. An hour
costs each reader something different, so manual figures carry TIME ONLY and
cost comparisons are stated as break-even rates the reader tests against
their own. (Supersedes the earlier 60 USD/h stated assumption.)
Amendment 2026-08-19, BEFORE any manual run: the manual persona is a
non-specialist following step-by-step public instructions
(reports/MANUAL_WALKTHROUGHS.md), not a professional analyst. This matches
the realistic alternative for a marketplace buyer; instruction-reading time
counts as task time. No agent run or scored figure is affected.

## Task 1: market read (trading)

Produce a structured market read for BNB covering, per the checklist:
C1 current regime label with a stated basis
C2 at least 3 support/resistance levels with concrete prices
C3 momentum state (direction + at least one named indicator reading)
C4 at least 2 risk flags relevant to the next 24h
C5 data freshness: every figure carries its source timestamp

Agent side: a two-call bundle (situation_report + wall_map) to ChainHelix for
Machines, the ChainHelix intel service (ERC-8004 #251399, b402 rail, exact-amount payment, one
settlement per call, tx hashes recorded); the bundle replaced the original
single call under amendment v5. The signal record behind
it is anchored by the standing on-chain attestation stream, which predates
this report.
Manual side: the same checklist built from freely available public charts
and data per the walkthrough, wall-clock recorded.
Quality score: checklist items met, 0 to 5, plus verifiability: a reader must
be able to check each figure against a public source or an on-chain record.

## Task 2: bounded grid construction (trading)

Construct a WBNB/USDT grid: budgetUsd 10000, levels 8 per side, spanPct 6,
wallBandPct 0.7. Inputs captured at run start by scripts/report_inputs.mjs:
mark price (Binance BNBUSDT spot) and a wall map (3 most-touched levels from
the last 30 daily candles, deterministic script, same file both sides).

Agent side: hire gridtrader (ERC-8004 #269224) through the live marketplace
flow: funded escrow, on-chain job, public deliverable URL.
Manual side: the same ladder built in a spreadsheet from the same captured
inputs per the walkthrough, wall-clock recorded.
Quality rubric (checker-scored, pass/fail per item):
G1 8 buy levels strictly below mark, 8 sell levels strictly above
G2 all levels inside the 6 percent half-width span
G3 per-level size = 10000/16 USD within 0.5 percent
G4 every level within 0.7 percent of a supplied wall is flagged, no others
G5 arithmetic reproduces from inputs exactly (checker recompute)

## Task 3: lending health report (security)

Compute portfolio health for: collateral 0.5 BTCB (liqThreshold 0.78) and
5 ETH (liqThreshold 0.80); debt 25000 USDT; alertHF 1.5, criticalHF 1.1.
Prices captured at run start (Binance BTCUSDT, ETHUSDT spot; USDT = 1).

Agent side: hire healthmon (ERC-8004 #269228) through the marketplace flow.
Manual side: the same report computed by hand from the same captured prices
per the walkthrough, wall-clock recorded.
Quality rubric (checker-scored):
H1 health factor matches checker recompute within 0.1 percent
H2 status classification correct against the 1.5/1.1 thresholds
H3 per-asset liquidation prices correct within 0.1 percent
H4 drop distances to liquidation correct within 0.1 percent

## Skill-tier analysis (amendment 2026-08-19, before any manual run)
Final method (amendment v2, same day; amendment v4, 2026-08-24: the manual
side is the operator's own run, timed as ranges): the without-agent side is
an operator run, timed as a range rather than to the second. Each
walkthrough step (reports/MANUAL_WALKTHROUGHS.md) carries a conservative
time range; the task total is the sum, labeled operator run wherever it appears (the ordering across tiers is fact; the specific minutes are ranges).
The analysis then also states a best-case professional bound:
assume a professional completes each task 10x faster than the fastest
first-timer time. The bound is an assumption and is labeled as one,
never as a measurement. Quality note: tasks 2 and 3 are deterministic
arithmetic, so correctly executed manual output matches expert output;
task 1 quality varies with skill and the report says so.

## Task 4: portfolio rebalancing (trading), addendum 2026-08-19

Addendum dated 2026-08-19: this sheet and its rubric were frozen and
committed before task 4 ran.

Compute the trade plan that restores a three asset portfolio to target
weights: holdings 0.4 BTC, 6 ETH, 12 BNB; targets BTC 40 percent, ETH 35
percent, BNB 25 percent; drift band 1 percent; minimum trade 5 USD. Prices
captured at run start (Binance BTCUSDT, ETHUSDT, BNBUSDT spot) by
scripts/report_inputs_task4.mjs; both sides use the same captured file.

Agent side: hire rebalancer (ERC-8004 #269223) through the live marketplace
flow: funded escrow, on-chain job, public deliverable.
Manual side: operator run per the standing method; the walkthrough
breaks it into calculator steps (value each asset, total, weights, drift,
trade sizes); first-timer range 10 to 20 minutes, professional 10x bound.
Quality rubric (checker-scored):
R1 portfolio total matches recompute within 0.1 percent
R2 per asset current and target weights within 0.05 points, drift = current
   minus target
R3 trade set exact: assets outside the 1 percent band with delta of at least
   5 USD, buy when under target, sell when over
R4 trade sizes: usd within 0.5 percent of weight gap times total, token
   amount = usd over price within 0.5 percent
R5 sells listed before buys (self funding order)

## Measurement, all tasks
- Agent time: first hire tx timestamp to public deliverable availability
  (on-chain and HTTP evidence). Task 1: request sent to response received.
- Manual time: recorded wall-clock, good faith, no sandbagging.
- Agent cost: exact job price plus gas from the receipts. Task 1: the exact
  payment amount from the settlement tx.
- Manual cost: time only; no hourly rate assumed; the reader multiplies
  by their own rate.
- Every number in the report traces to a tx hash, URL or committed artifact.

Amendment v5 (2026-08-24): third run of task 1. The catalog gained named
momentum indicators (RSI 14, MACD 12/26/9 and a 4h trend label, response field
`trend4h`) on 2026-08-24; the same two-call bundle was run again with this
checklist unchanged. Responses in reports/out-intel-rerun2.json, which also
carries the run script's own `score` block; task 1 has no checker, so that
block is the run's record of the hand score, not an independent recomputation.
Score under amendment v6 below.

Amendment v6 (2026-09-02, after the runs): C5 as frozen reads "every figure
carries its source timestamp". The scored artefact (reports/out-intel-rerun2.json)
carries one generation timestamp, on situation_report, and none on wall_map;
the figures carry windows and timeframes (windowHours, timeframe), not source
timestamps. The recorded C5: true is a bundle-level reading: the response
carries its generation time. Under the frozen wording the item is not met and
the run scores 4 of 5 per figure with C5 met at bundle level. The report
states both.

Amendment v7 (2026-09-03, after the runs): what the task-4 rubric checker
tests, stated so the sheet and scripts/report_check.mjs agree.
- R5 is named "self funding order". The check compares the positions of
  sells and buys in the list and, since this amendment, the sums: the buys
  must equal the sells, or the plan must declare the difference in
  `residualUsd` and the declared figure must match what the trades do.
  rebalance.ts states the contract it grades against: "The plan is self-funding
  only when residualUsd is 0."
- R3 grades the trade set against the filter rule AS SPECIFIED in this sheet
  (outside the 1 percent band, delta at least 5 USD). It applies that rule
  itself rather than deriving the trade set independently, so R3 confirms the
  agent followed the specified rule; it is not an independent opinion about
  whether the rule is the right one. The checker shares no code with the agents
  (its only import is `fs`), which is a different thing from sharing no
  assumption, and this line records the difference.
