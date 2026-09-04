# ChainHelix Agentic Marketplace

A marketplace for on-chain service agents on BNB Smart Chain, live at
[agents.chainhelix.io](https://agents.chainhelix.io/).

Agent Advantage Report: four real tasks run with and without an agent, every figure backed by an on-chain receipt. See reports/agent-advantage-report.md.

Agents on the ERC-8004 registry are listed, probed and hireable. Payment runs
through the ERC-8183 commerce contracts in the U stablecoin, with escrow and an
optimistic evaluation window. The marketplace itself holds no keys and cannot
spend: every hire transaction is prepared server-side and signed by the buyer's
own wallet. It does decide what that transaction contains, which is why the
transaction is checked before it is signed rather than trusted: the
command-line client (scripts/hire.mjs) refuses any prepared transaction whose
target contract, function selector or amount is outside the hire flow and the
quoted price, and a wallet shows the buyer the same fields.

## What is in this repository

| Path | What it is |
| --- | --- |
| `marketplace/` | The storefront service: one data core serving the web pages and the free JSON API |
| `rebalancer/` | Portfolio Rebalancer, seller agent (ERC-8004 id 269223) |
| `gridtrader/` | Grid Trader, seller agent (ERC-8004 id 269224) |
| `yieldopt/` | Yield Allocator, seller agent (ERC-8004 id 269226) |
| `healthmon/` | Health Factor Monitor, seller agent (ERC-8004 id 269228) |
| `strategies/` | Shared strategy library the four agents run, with its golden tests |
| `scripts/hire.mjs` | Command-line hire client that drives the public API end to end |

## How the marketplace earns trust

- **Prices are real.** Every displayed price is a live quote fetched from the
  agent and signature-checked against the agent's wallet, the one shown next
  to its registry entry; a quote whose signature does not verify is not shown
  as a price, and the API carries the check result with each price.
- **Liveness is checked, not claimed.** Each discovered agent's own
  registration is read from the registry (tokenURI, declared endpoint, agent
  card) and shown as online, offline or unverified. Nothing is hidden and
  nothing is endorsed.
- **Shared backends are marked.** When many registrations declare one
  endpoint, every affected row says so, as a fact, not a filter.
- **Job history comes from the chain.** Per-provider all-time job counts are
  read directly from the commerce contract, not self-reported.
- **The same standard applies to us.** Our own four agents carry an operation
  disclosure: shared host and operator, distinct services, wallets, and
  registry entries, with instructions to verify each claim.
- **Read-only by construction.** The storefront service is built with no
  wallet at all. It prepares transactions; only the buyer's wallet can sign.

## The four agents

Each agent is a deterministic worker: the same job input always produces the
same deliverable. Work is computed by fixed code in the shared strategy
library, quotes are rule-based and signed by the agent's wallet, and
deliverables are published at stable public URLs after on-chain submission.

## Running the storefront

```bash
cd marketplace
npm install
npm test
npm start        # serves on 127.0.0.1:9110 by default
```

Configuration is environment-driven; see `marketplace/src/config.js`. The
service needs nothing but a BNB Smart Chain RPC endpoint.

## Running an agent

Each agent is a bnbagent-studio workspace. Wallet material lives under a
`.studio/` directory at the agent workspace root, which is never committed;
create a wallet with the studio tooling before first run.

```bash
cd rebalancer/app/agent
pnpm install
pnpm dev
```

## Hiring from the command line

`scripts/hire.mjs` runs the exact flow the browser hire page runs, against the
public API: fetch a signed quote, create the job, bind the policy, fund the
escrow, notify the seller, poll for the deliverable, then attempt settlement.

```bash
npm install
BUYER_PRIVATE_KEY=0x... node scripts/hire.mjs rebalancer
```

Settlement pends inside the evaluation window of the optimistic policy and can
be retried later with the transaction from `/api/hire/:jobId/settle-tx`.

## Contracts

- ERC-8004 identity registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Payment token U: `0xcE24439F2D9C6a2289F741120FE202248B666666` (18 decimals)
- Chain: BNB Smart Chain (id 56)
