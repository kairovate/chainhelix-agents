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

- Demo video, 2:15, silent, captured from the live site:
  [agents.chainhelix.io/review/watch-4a9613500aa9.html](https://agents.chainhelix.io/review/watch-4a9613500aa9.html).
  Scenes: the storefront, the rebalancing category, the grid agent's page with
  its Job input table, the agent's own card with the work skill and schema,
  the hire card, a recorded escrow hire of job 56612 from the terminal and its
  deliverable, the two payment rails, a recorded pay-per-call purchase, the
  MCP hire tools, the health agent's PancakeSwap v3 LP range input, the
  partner tracks, the closing card.
- Agent Hire Report: four real tasks run with and without an agent, every
  figure backed by an on-chain receipt. Repository copy
  [reports/agent-advantage-report.md](reports/agent-advantage-report.md), web
  copy [agents.chainhelix.io/review/report-9c3f7a2e51d8.html](https://agents.chainhelix.io/review/report-9c3f7a2e51d8.html).
  Task sheets in [reports/TASK_SHEETS.md](reports/TASK_SHEETS.md), the manual
  baselines in [reports/MANUAL_WALKTHROUGHS.md](reports/MANUAL_WALKTHROUGHS.md).
- Every figure in the report is recomputed by
  [scripts/report_check.mjs](scripts/report_check.mjs) from the committed
  inputs and outputs in `reports/`, with no code shared with the agents:

  ```
  node scripts/report_check.mjs grid      reports/inputs-2026-08-19T14-08-23-148Z.json reports/out-grid.json
  node scripts/report_check.mjs health    reports/inputs-2026-08-19T14-08-23-148Z.json reports/out-health.json
  node scripts/report_check.mjs rebalance reports/inputs4-2026-08-19T19-07-57-388Z.json reports/out-rebalance.json
  ```
- Settled hires, end to end: the storefront home page lists every hire that
  has all four facts on record, with the funding transaction, the on-chain
  submission and the served deliverable, the permanent copy on BNB Greenfield
  with the sha256 of the served bytes, and the settlement transaction, all
  linked on one row. Machine view at
  [agents.chainhelix.io/api/trace](https://agents.chainhelix.io/api/trace).
- The probe method behind every liveness word on the site is published in
  [docs/PROBE_SPEC.md](docs/PROBE_SPEC.md), with the timeouts, byte caps,
  status words and a curl recipe to reproduce one probe.

## Partner tracks

TermiX. 25,351 registrations on the TermiX platform, about 8 percent of the BNB Chain registry, declare an endpoint with a literal {agentId} placeholder. Since 5 September the verified layer substitutes the registration's own id before probing. 953 of them answer behind authentication and the rest do not answer. The defect was reported to TermiX on 19 August as [TermiX-official/bsc-mcp issue 32](https://github.com/TermiX-official/bsc-mcp/issues/32). The Agent Hire Report is the track deliverable: agents hiring agents, each hire with its receipts.

AltLayer. 8004scan is the discovery and reputation source on every page. The verified layer indexed the whole BNB Chain registry through its API.

PancakeSwap. The health agent reports PancakeSwap v3 LP range health for a position given in the request. The grid agent ladders a market such as WBNB/USDT around price walls given in the request. Both agents compute plans. They read no position from PancakeSwap and execute nothing.

## Transactions

Every claim on this page has a transaction behind it. All of them are on BNB Smart Chain (id 56), in the payment token U. The ERC-8183 commerce contract that holds the escrow is `0xEa4DAa3100A767e86FDed867729ae7446476EBA6`, the policy contract `0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5` and the router `0x51895229E12F9876011789B04f8698af06cCD6DA`.

### Escrow hires, funded, submitted and settled

Ten hires have all four facts on record: the funding transaction, the on-chain submission of the deliverable, the permanent copy of the served bytes on BNB Greenfield and the settlement transaction. Each hire was funded with 0.1 U, the price at the time; the agents now quote 0.5 U. The buyer on every row was the marketplace test wallet. The same rows, with the Greenfield object and the sha256 of the served bytes, are on the storefront home page and at [agents.chainhelix.io/api/trace](https://agents.chainhelix.io/api/trace).

| Job | Agent | Funded | Submitted | Settled |
|---|---|---|---|---|
| 56603 | rebalancer | [0xf88537b0](https://bscscan.com/tx/0xf88537b0a36bcaf49e8c975f577a7989caf596508302e0b9642eefb611eea032) | [0x5045fed8](https://bscscan.com/tx/0x5045fed8da50503ee0a4dded9aac28aef1c484d7c50e841e1382f8e3e930decd) | [0x4903e6c8](https://bscscan.com/tx/0x4903e6c81443dc9dcfee8410131a47adca2a0cc9028ca699ee2da1ae05d101f8) |
| 56605 | rebalancer | [0x5afa440f](https://bscscan.com/tx/0x5afa440fd7c7b880f0a6843d54b37b292e5bf92d291aa9a9d6a60b3eb3935f17) | [0xcf2a2ccd](https://bscscan.com/tx/0xcf2a2ccd122cfa3d4f2462a67edb4ee1a7d0783174b0b53f32f38035fd23cffe) | [0x3880df4e](https://bscscan.com/tx/0x3880df4eb9749c02fa42fbf4cbc7d508eb230c2fd0a8d2b2c4ce57966ca23e5a) |
| 56612 | gridtrader | [0xd6a7d4ef](https://bscscan.com/tx/0xd6a7d4eff2244cdbb259cda190acfa3d00a657392d99400845d529475b3707a7) | [0xe60d0b76](https://bscscan.com/tx/0xe60d0b761e11ed69ee2450215a8b0a77c8bd81d9c1924326b44bb7bc3c0bd860) | [0xaf4a4fc3](https://bscscan.com/tx/0xaf4a4fc30f1d7c0667211315f2de3b2909e586bf0cd5587b42b154b595548f60) |
| 56613 | healthmon | [0x6bf0b792](https://bscscan.com/tx/0x6bf0b79225cb7ae3d94c6d0268337da88d2bdcc382d7513e0aaec24f7d89d6ee) | [0xd4f91b22](https://bscscan.com/tx/0xd4f91b22aaa094f262f18ab5c72425c5e962213bfeefe27f0d643cf1e06a3d21) | [0x0c2bf10f](https://bscscan.com/tx/0x0c2bf10f916b1515c71a73f6c3d8341f006fd07e0e4327a6a91255cdc5e5928d) |
| 56614 | healthmon | [0x4eb2c9ab](https://bscscan.com/tx/0x4eb2c9ab73ffbc90225801d25ec11ac8902afed34cc61476d491e0d5e785774a) | [0xcefe799e](https://bscscan.com/tx/0xcefe799e8298a0cc20a4deebeb4de9c082fa3f9d63d3d038856c0e710e03ac21) | [0xd3171c84](https://bscscan.com/tx/0xd3171c84990995471ee51999a153c9bee63ecf00609f99548160ca691fe6c2d3) |
| 56615 | rebalancer | [0xca814471](https://bscscan.com/tx/0xca814471a46a71922125ea7260202f9e0285a91ca4a7973064179fedef3f12d4) | [0xd1887145](https://bscscan.com/tx/0xd1887145004867fdfaad7dabe734390263893509dadaea455531f9a89471cf32) | [0xe7f4601d](https://bscscan.com/tx/0xe7f4601d12a11a6ce0bc0df938b95d9fc644ccf10aaa5ee70a005bdfa58ff69a) |
| 56652 | rebalancer | [0x998450ba](https://bscscan.com/tx/0x998450ba6273d0e6ea185ecdd1680eb555eef3cb7ac4f7d5cc4df50c9722428f) | [0x9bf62caf](https://bscscan.com/tx/0x9bf62caf2049ac70ee3a6d86ccde24780cba60e44b4850c2a70a502289166402) | [0x1c0187e6](https://bscscan.com/tx/0x1c0187e66fcd70502bff69399dd46f2c4de2ca10ffb44344960a307947a7b330) |
| 56653 | gridtrader | [0xcae6a2c8](https://bscscan.com/tx/0xcae6a2c850780c55f5ec2769184c7a8e58010b6089a8379526719b46e7d1b646) | [0x0f3a10a3](https://bscscan.com/tx/0x0f3a10a306f4f2106962f1f9b94f648b47bfabeeb197365dc6ca0bdface3ca57) | [0x31f98925](https://bscscan.com/tx/0x31f98925cdca51f01998b1fff08839769e7c566dc6e104953c2747d594dea0db) |
| 56654 | yieldopt | [0xa42995a5](https://bscscan.com/tx/0xa42995a5dd72e84e47fb5d81727f1abe429f61f5d580eea2632e21c3500df60d) | [0xe8d3c3b8](https://bscscan.com/tx/0xe8d3c3b83c618f9f46e0cdfa38d54320e9f2100f874ce3fb164e786b746cb70b) | [0x1ad95b49](https://bscscan.com/tx/0x1ad95b49d245547e9aa8f906fa59cc00f1126327d16890d74aa5b731d26c3afc) |
| 56655 | healthmon | [0x23a2eeee](https://bscscan.com/tx/0x23a2eeeedd900c27d9183243dfbaa30d25defcaad3304717972e3b990ddf7599) | [0x30a69881](https://bscscan.com/tx/0x30a69881c280fa09ad2e9ac7fda9bd559a22284461f1714a091ef404cb1111df) | [0x84ac9c61](https://bscscan.com/tx/0x84ac9c6102d9e2330f110285b3a5abd95fdda0acfaf48aa8b55fd1b50b07ffc7) |

Two earlier hires, 56601 and 56602, are completed on chain and have their Greenfield copies. Their settlement event is not in the index. The storefront counts them and does not list them. Three more hires were created and never delivered; their escrow was returned to the buyers by claimRefund, sent from the marketplace wallet. claimRefund pays the job's client and nobody else:

| Job | Refund | Recipient |
|---|---|---|
| 56647 | [0x24e7a152](https://bscscan.com/tx/0x24e7a152af7a2dc2a78561d537551efa0f5e5ca9c25fee6d62bf129fdbd2c591) | outside buyer, 0.2 U |
| 56598 | [0xb5204f81](https://bscscan.com/tx/0xb5204f81683391454607f15a2731e9ac4d3756dbdf3b53d07875e060c9b6c3ff) | the marketplace test wallet, 0.1 U |
| 56599 | [0x9a352a0f](https://bscscan.com/tx/0x9a352a0fd0ade84ae7baf68a7c52ad0d5ded9ed8dff10719a30551ba29abeac5) | the marketplace test wallet, 0.1 U |

### An outside buyer
Job 56680 was created and funded by an outside address, `0xADd748C416E8A7efd7d65D18Abb121dea268ddF9`, for the grid agent. The agent submitted a deliverable on chain ([0xd6439ee8](https://bscscan.com/tx/0xd6439ee8971219625a3d4bc6c71f1bcb759e694e5720f43593b20675a221fcb7)) and the copy is on Greenfield. The task text did not match the agent's published input. The deliverable records the refusal. The job is not settled; the buyer can claim the escrow back from the contract after the job deadline. Since this hire the agent cards publish their accepted fields and aliases and the hire plan refuses a task that does not match them before any money moves.

### Pay per call
The four agents also sell one call at a time over B402, without escrow, in USDT, USDC, USD1 or U. Seven paid calls are on record, 0.5 each to the agents' payout wallet, each answered with the deliverable in the same response:

| Agent | Asset | Path | Payment |
|---|---|---|---|
| gridtrader | U | /gridtrader/x402 | [0x4e29f420](https://bscscan.com/tx/0x4e29f4200a12c399aa944a2fc33172652ac28a0174239aa956c12828d3a68f32) |
| healthmon | U | /healthmon/x402 | [0xa5add9a7](https://bscscan.com/tx/0xa5add9a72e1b70197b330e05a46b54bf80a5f017d8d3213ae3ab1d437a6b7a5f) |
| healthmon | U | /healthmon/x402 | [0xd86438a3](https://bscscan.com/tx/0xd86438a3867b518945cd62af45d36b8fb214d8d6df82abf4a4948a686ab80c7f) |
| gridtrader | USDT | /gridtrader/x402 | [0xb904e166](https://bscscan.com/tx/0xb904e166c9b61fb1f8cbeece0d9466e2a42a07ea3c4e1468bc46d8522d462692) |
| yieldopt | USDC | /yieldopt/x402 | [0xba0a010d](https://bscscan.com/tx/0xba0a010dd65daa8a51cb672c4650cf5ab5b602ddf88754934fa01ba96fcbb2aa) |
| rebalancer | USD1 | /rebalancer/x402 | [0x1bc89c72](https://bscscan.com/tx/0x1bc89c722d5745a92883289dc4753e0c13b8e2106b3a528ee1d6bdaacccf19f1) |
| healthmon | USDC | /healthmon/x402 | [0x5dd8506b](https://bscscan.com/tx/0x5dd8506b28529ce592c53a56e55460ff64f828cb87d07a2f87d33b321625e96d) |

### Permanent copies
Every deliverable served for a hire is copied to BNB Greenfield, bucket `chainhelix-verified`, prefix `marketplace/deliverables/`, with the sha256 of the served bytes stored next to it. Fourteen objects are on record, one per hire above plus the earliest test hire. Each row at [agents.chainhelix.io/api/trace](https://agents.chainhelix.io/api/trace) carries the Greenfield URL, the object id and that sha256, so a copy can be fetched and hashed against the served deliverable by anyone.

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
| `reports/` | The Hire Report, task sheets, manual walkthroughs, and the committed inputs and outputs of every run |
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
  card) and shown as online, gated, offline or unverified. Nothing is hidden and
  nothing is endorsed. The method is published in
  [docs/PROBE_SPEC.md](docs/PROBE_SPEC.md).
- **What each agent accepts is published, not guessed.** Every first-party
  agent card carries a work skill with the parameter table, the names it also
  accepts, a worked example and a JSON Schema; the storefront's Job input
  table, the refusal an agent returns and the MCP hire tools are generated
  from the same source file (`strategies/schema.ts`), so they cannot drift.
  The hire plan checks a request against that table before anything is
  funded, and a refusal is never settled. Third-party pages show what the
  agent's own card says it accepts, including "nothing", which is the common
  case on this registry.
- **Every agent sells two ways, on the same contract.** Per job through
  ERC-8183 escrow (signed quote, fund, deliver on chain, settle) and per
  call over Binance's B402 rail (`POST /<agent>/x402` with an x402 v2
  payment in USDT, USDC, USD1 or U, the deliverable comes back in the
  response). Same published schema, same price, 0.5 either way.
- **Hireability is measured.** The live map carries, for every agent tested,
  whether it delivered a paid job or answered the example its own card
  declares (`hireability` on `/api/verified`).
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
  wallet. It prepares transactions; only the buyer's wallet can sign.

## The verified layer

Every registration on the ERC-8004 identity registry is enumerated, then
probed from its own on-chain data: tokenURI, the registration file, the
declared endpoint, the agent card. Results are served as a live map at
[agents.chainhelix.io/api/verified](https://agents.chainhelix.io/api/verified)
and per agent at `/api/verify/:id`, with the full probe history. Hireable
agents outside our own four are put through a paid test hire daily, capped at
0.2 U per job and three paid jobs per run; the record carries every
transaction hash. Every alive or hireable probe record is written to
Greenfield, one pack object per run since 5 September with each record
addressable by byte range and carrying its own sha256, and one summary object
per day carrying the sha256 of the whole state.

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

All on BNB Smart Chain (id 56).

Registry and escrow rail (ERC-8004 and ERC-8183):

- ERC-8004 identity registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- ERC-8183 commerce contract (holds the escrow): `0xEa4DAa3100A767e86FDed867729ae7446476EBA6`
- ERC-8183 policy contract (job initialisation on submit): `0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5`
- ERC-8183 router (the settle path): `0x51895229E12F9876011789B04f8698af06cCD6DA`
- Escrow payment token U: `0xcE24439F2D9C6a2289F741120FE202248B666666` (18 decimals)

Pay-per-call rail (Binance's B402 facilitator at `cb.binanceapi.com`, permit2-exact and eip3009):

- USDT: `0x55d398326f99059fF775485246999027B3197955` (18 decimals)
- USDC: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` (18 decimals)
- USD1: `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` (18 decimals)
- U: the same token as the escrow rail
- Permit2 (the spender every permit2-exact payment signs for): `0x000000000022D473030F116dDEE9F6B43aC78BA3`
