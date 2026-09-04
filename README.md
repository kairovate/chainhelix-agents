# ChainHelix Agentic Marketplace

A marketplace for on-chain service agents on BNB Smart Chain, live at
[agents.chainhelix.io](https://agents.chainhelix.io/).

Agents on the ERC-8004 registry are listed, probed and hireable. Payment runs
through the ERC-8183 commerce contracts in the U stablecoin, with escrow and an
optimistic evaluation window. The marketplace itself holds no keys and cannot
spend: every hire transaction is prepared server-side and signed by the buyer's
own wallet. It does decide what that transaction contains, which is why the
transaction is checked before it is signed rather than trusted: the
command-line client (scripts/hire.mjs) refuses any prepared transaction whose
target contract, function selector or amount is outside the hire flow and the
quoted price, and a wallet shows the buyer the same fields.

## Demo and evidence

- Demo video, 1:44, silent, recorded on the live site:
  [agents.chainhelix.io/review/watch-4b9d21c07f6e.html](https://agents.chainhelix.io/review/watch-4b9d21c07f6e.html).
  Scenes: the storefront, a category page, an agent page, a recorded hire of
  job 56612 from the terminal, the deliverable, the verification steps.
- Agent Advantage Report: four real tasks run with and without an agent, every
  figure backed by an on-chain receipt. Repository copy
  [reports/agent-advantage-report.md](reports/agent-advantage-report.md), web
  copy [agents.chainhelix.io/review/report-9c3f7a2e51d8.html](https://agents.chainhelix.io/review/report-9c3f7a2e51d8.html).
  Task sheets in [reports/TASK_SHEETS.md](reports/TASK_SHEETS.md), the manual
  baselines in [reports/MANUAL_WALKTHROUGHS.md](reports/MANUAL_WALKTHROUGHS.md).
- Every figure in the report is recomputed by
  [scripts/report_check.mjs](scripts/report_check.mjs) from the committed
  inputs and outputs in `reports/`, with no code shared with the agents.
- Settled hires, end to end: the storefront home page lists every hire that
  has all four facts on record, with the funding transaction, the on-chain
  submission and the served deliverable, the permanent copy on BNB Greenfield
  with the sha256 of the served bytes, and the settlement transaction, all
  linked on one row. Machine view at
  [agents.chainhelix.io/api/trace](https://agents.chainhelix.io/api/trace).
- The probe method behind every liveness word on the site is published in
  [docs/PROBE_SPEC.md](docs/PROBE_SPEC.md), with the timeouts, byte caps,
  status words and a curl recipe to reproduce one probe.

## What is in this repository

| Path | What it is |
| --- | --- |
| `marketplace/` | The storefront service: one data core serving the web pages and the free JSON API |
| `marketplace/src/verify.js` | The verified layer: registry enumeration, probing from on-chain registrations, the live map |
| `marketplace/src/trace.js` | The settled-hires row: reads the trace file, serves the home page section and `/api/trace` |
| `rebalancer/` | Portfolio Rebalancer, seller agent (ERC-8004 id 269223) |
| `gridtrader/` | Grid Trader, seller agent (ERC-8004 id 269224) |
| `yieldopt/` | Yield Allocator, seller agent (ERC-8004 id 269226) |
| `healthmon/` | Health Factor Monitor, seller agent (ERC-8004 id 269228) |
| `strategies/` | Shared strategy library the four agents run, with its golden tests |
| `docs/PROBE_SPEC.md` | The open probe specification |
| `reports/` | The Advantage Report, task sheets, manual walkthroughs, and the committed inputs and outputs of every run |
| `scripts/hire.mjs` | Command-line hire client that drives the public API end to end |
| `scripts/report_check.mjs` | Independent checker that recomputes every report figure from first principles |
| `scripts/build_job_trace.mjs` | Builds the settled-hires trace file from the chain and the evidence on record |

## How the marketplace earns trust

- **Prices are real.** Every displayed price is a live quote fetched from the
  agent and signature-checked against the agent's wallet, the one shown next
  to its registry entry; a quote whose signature does not verify is not shown
  as a price, and the API carries the check result with each price.
- **Liveness is checked, not claimed.** Each discovered agent's own
  registration is read from the registry (tokenURI, declared endpoint, agent
  card) and shown as online, offline or unverified. Nothing is hidden and
  nothing is endorsed. The method is published in
  [docs/PROBE_SPEC.md](docs/PROBE_SPEC.md).
- **Shared backends are marked.** When many registrations declare one
  endpoint, every affected row says so, as a fact, not a filter.
- **Job history comes from the chain.** Per-provider all-time job counts are
  read directly from the commerce contract, not self-reported.
- **Settled hires are shown with their evidence.** A hire appears on the
  home page only when the funding, the submission, the Greenfield copy and the
  settlement are all on record; hires missing any fact are counted and not
  listed.
- **The same standard applies to us.** Our own four agents carry an operation
  disclosure: shared host and operator, distinct services, wallets, and
  registry entries, with instructions to verify each claim.
- **Read-only by construction.** The storefront service is built with no
  wallet at all. It prepares transactions; only the buyer's wallet can sign.

## The verified layer

Every registration on the ERC-8004 identity registry is enumerated, then
probed from its own on-chain data: tokenURI, the registration file, the
declared endpoint, the agent card. Results are served as a live map at
[agents.chainhelix.io/api/verified](https://agents.chainhelix.io/api/verified)
and per agent at `/api/verify/:id`, with the full probe history. Hireable
agents outside our own four are put through a paid test hire daily, capped at
0.2 U per job and three paid jobs per run; the record carries every
transaction hash. One Greenfield object is written per alive or hireable
probe, and one summary object per day carrying the sha256 of the whole state.

## The four agents

Each agent is a deterministic worker: the same job input always produces the
same deliverable. Work is computed by fixed code in the shared strategy
library, quotes are rule-based and signed by the agent's wallet, and
deliverables are published at stable public URLs after on-chain submission.

## The JSON API

Everything on the pages is served as JSON from the same data core.

| Route | What it returns |
| --- | --- |
| `/api/agents` | The listing, first-party and discovered, with live signed quotes and their check result |
| `/api/agents/:id` | One agent: registration, card, quote, job counts |
| `/api/agents/:id/quote` | A fresh signed quote from the agent |
| `/api/jobs/:id` | One job read from the commerce contract, with the Greenfield copy of its deliverable when mirrored |
| `/api/verified` | The live map of every probed registration |
| `/api/verify/:id` | One registration's probe history |
| `/api/trace` | Every settled hire with all four facts on record |
| `/api/hire/...` | The prepared transactions of the hire flow: job id, register, fund, settle |

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
