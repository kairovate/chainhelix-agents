# Manual baseline walkthroughs

Instructions for the manual side of the Advantage Report. Written for a
non-specialist: no prior trading or DeFi knowledge assumed. You execute every
step yourself; these pages give the method (all of it public knowledge), never
the answers.

## Rules for every task
- Start a stopwatch when you open the task section, stop it when your output
  file is saved. The reading is the task's manual time, learning included.
- Screen-record if convenient; otherwise write down start and
  end times.
- One sitting per task. Breaks pause the stopwatch.
- Do not open the agent deliverable URLs or reports/out-*.json before you
  finish. You are doing this cold.
- Save each output as a file (text or spreadsheet) and note your times.

---

## Task 3 first (easiest): loan health report

You need: a calculator. Your position: 0.5 BTCB and 5 ETH as collateral,
25000 USDT of debt. Prices: BTCB 65335.99, ETH 1937.51, USDT 1.
Liquidation thresholds: BTCB 0.78, ETH 0.80.

A lending protocol liquidates you when your health factor drops below 1.
Health factor = (each collateral's USD value x its threshold, summed) divided
by total debt. This formula is in every lending protocol's documentation.

1. BTCB value: 0.5 x 65335.99. Write it down.
2. Weighted BTCB: that number x 0.78. Write it down.
3. ETH value: 5 x 1937.51. Write it down.
4. Weighted ETH: that number x 0.80. Write it down.
5. Add the two weighted numbers. This is your risk-adjusted collateral.
6. Divide by 25000. This is the HEALTH FACTOR. Round to 4 decimals.
7. Status: 1.5 or above = healthy; below 1.5 = warning; below 1.1 =
   critical; below 1.0 = liquidatable. Write the word.
8. BTCB liquidation price (the BTCB price at which HF hits exactly 1 if ETH
   holds): (25000 minus weighted ETH) divided by (0.5 x 0.78).
9. Drop distance: (65335.99 minus that price) / 65335.99 x 100, in percent.
10. ETH check: is weighted BTCB alone bigger than 25000? If yes, write that
    ETH falling cannot cause liquidation by itself. If no, compute ETH's
    liquidation price the same way as step 8 with roles swapped.

Output: a short text file with the health factor, the status word, the BTCB
liquidation price and drop percent and your one-line ETH conclusion.

---

## Task 2: build the WBNB/USDT grid (spreadsheet)

You need: Google Sheets or Excel. Given: current price 605.5, budget 10000
USD, 8 buy levels below the price and 8 sell levels above, all inside a 6
percent band around the price. Wall prices to check against: 574.80, 593.52,
605.89.

1. A1: type 605.5 (the price). A2: type =A1*0.06/8 (the spacing between
   levels; the 6 percent half-width split into 8 steps).
2. Column B, buy levels. B1: =A$1 - A$2*1  then B2: =A$1 - A$2*2  and so on
   down to B8 with *8. (Or type =A$1-A$2*ROW() in B1 and drag to B8.)
3. Column C, sell levels. C1: =A$1 + A$2*1  down to C8 with *8.
4. Column D, size: every level gets the same money: =10000/16. Fill D1:D8
   (it applies to both the buy and sell level on that row).
5. Wall check, columns E (for buys) and F (for sells). For each level,
   compute its distance to the CLOSEST wall in percent of the level:
   E1: =MIN(ABS(B1-574.8),ABS(B1-593.52),ABS(B1-605.89))/B1*100
   Drag down to E8. Same for F1 with C1. A level is ON A WALL when this
   number is 0.7 or less. Mark those rows (bold or a YES column).
6. Sanity: all 16 levels must sit between =A1*0.94 and =A1*1.06.

Output: the spreadsheet, with 8 buy prices, 8 sell prices, per-level size,
and the on-wall marks.

---

## Task 1: market read for BNB (the judgment task)

You need: a free chart. Open tradingview.com, search BNBUSDT (Binance), no
account needed for basics. You will write 5 short sections in a text file.
There is no answer key; write what you actually see, in your own words.

1. REGIME. Set the chart to 1 day candles, look at the last 3 to 4 weeks.
   Sideways inside a band = "ranging". Clear staircase up or down = 
   "trending". Wild expanding swings = "volatile". Write the word, plus one
   sentence of why (for example the high and low of the band you see).
2. LEVELS, at least 3 with prices. Look for horizontal prices where candles
   repeatedly stopped and reversed: floors under the price (support) and
   ceilings above it (resistance). Hover the chart to read prices. Write
   each price and whether it is above or below the current price.
3. MOMENTUM. Click Indicators, add RSI. Read today's RSI number (0 to 100;
   above 70 usually called overbought, below 30 oversold, near 50 neutral).
   Write the number, the word and whether the last week of candles is
   drifting up or down.
4. RISK FLAGS, at least 2 for the next 24 hours. Anything a careful person
   would flag: price sitting right under a ceiling from your section 2, RSI
   at an extreme, one unusually huge candle in the last days, a visible
   news event. One line each.
5. FRESHNESS. Note the date and time (UTC) you read the chart and that the
   source is the public Binance BNBUSDT chart on TradingView.

Output: the text file with those 5 sections.

---

## Task 4: portfolio rebalance plan

You need: a calculator. Holdings: 0.4 BTC, 6 ETH, 12 BNB. Targets: BTC 40
percent, ETH 35 percent, BNB 25 percent. Prices come from the captured
inputs file at run start.

1. Value each asset: amount x price. Three numbers.
2. Add them. This is the portfolio total.
3. Each asset's current weight: its value over the total, x 100.
4. Drift per asset: current weight minus target weight, in points.
5. Skip any asset whose drift is within 1 point either way (no trade band).
6. For the rest: trade size in USD = (target weight minus current weight)
   x total. Negative = sell that many USD worth, positive = buy.
7. Skip any trade under 5 USD.
8. Token amount per trade: USD size over that asset's price.
9. List sells before buys.
10. Add the sells and add the buys. Step 5 and step 7 can drop a leg, and when
    they do the two totals are not equal: write the difference down as the
    residual (buys minus sells). Added 2026-09-03.

Output: the total, the three weights with drift, the trade list and the
residual from step 10.

This walkthrough follows the same method as the agent, deliberately, so that
the two sides are comparable step for step. That also means it is a check of
the arithmetic and not an independent check of the method: if the no-trade
band or the minimum-trade filter drops a leg, the manual run produces the same
unbalanced plan the engine produces, and the two agree because they followed
the same rule, not because the rule is right. Step 10 is what makes that
visible on the manual side; the engine reports the same number as
`residualUsd`. On the published task-4 case nothing is skipped: the manual
steps above reproduce the committed output exactly (total 47,330.44, sell BTC
8,430.03, buy BNB 4,428.37, buy ETH 4,001.66) and the trades net to zero,
8,430.03 = 4,428.37 + 4,001.66. That output predates the `residualUsd` field,
so the zero is read off its trades. Added 2026-09-03.
