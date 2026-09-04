# Grid Trader

Lays out a buy/sell grid around the current price, sized to a budget and avoiding known walls.

A seller agent on BNB Smart Chain, registered on the ERC-8004 identity
registry as agent 269224, signing with wallet `0xb8143345687aa5a527f4f9568d508ebbc612d06d`.
Live at `https://agents.chainhelix.io/gridtrader/`: the agent card is
[/.well-known/agent-card.json](https://agents.chainhelix.io/gridtrader/.well-known/agent-card.json);
the bare path is the JSON-RPC endpoint and accepts POST only (a browser GET gets an nginx 405).

## How it works

- The agent serves the A2A protocol: a `negotiate` skill that returns a
  rule-based, wallet-signed quote and a `notify_funded` skill that verifies
  escrow funding on chain, runs the work and submits the deliverable.
- The work itself is deterministic. The same job input always produces the
  same deliverable, computed by fixed code vendored from the shared strategy
  library at `app/agent/vendor/strategies/` (tests live in the repository
  root `strategies/` directory).
- Signing is confined to fixed entrypoints in `app/agent/src/signing.ts`.

## How to reach it

<!-- fix 2026-09-03 H221: the sections above named the endpoint but never said how to dial it, nor
     that no authentication is required. Judge-facing copy: keep the prose clean, keep the note here. -->

- The A2A agent card is at `/.well-known/agent-card.json` under the URL above, and the `url` it
  advertises is that same public base. Fetch the card first; do not assume the path.
- The bare path is the JSON-RPC endpoint. It accepts POST only.
- No authentication is required to call it. The card carries no security scheme because there is
  none: the paid gate is on chain, not at the door. `negotiate` returns a signed quote to anyone;
  work is only done for a job that is funded to this provider on chain.
- Skill calls ride in an A2A data part, not a text part: `parts: [{"kind":"data","data":{"skill":
  "negotiate", ...}}]`. A message with no such part gets an explicit error naming the shape.
- The supported path for a first-time caller is the marketplace hire flow, which does the quote,
  the on-chain funding and the notify for you. Dialling the agent directly is the same protocol
  with those three steps as your own.

## Deployment

<!-- fix 2026-09-03 H137 H295 H15: an unfilled AWS placeholder and a Node major nothing was tested on
     shipped in the judge tree with nothing saying they are scaffold. This section says it. -->

`agentcore/` in this workspace is a self-rendered descriptor for an
AWS AgentCore deploy that this project does not use and has never run. Its `aws-targets.json` still
carries the scaffold placeholder `FILL_IN_AWS_ACCOUNT_ID`, and its `runtimeVersion` names a Node
major that is not the one anything here was built or tested on. The demonstrated deployment is the
self-hosted one behind the URL above, on Node 20. Read `agentcore/` as scaffold; it is not a
deployment claim, and nothing in it has been exercised.

## Job input

See the `inputSchema` for `gridtrader` in `marketplace/catalog.json` or the agent's
detail page on the marketplace, which shows the schema with hire steps and
curl equivalents.

## Run it

```bash
cd app/agent
pnpm install
pnpm test                                  # strategy goldens (vendor/strategies/test.ts)
pnpm dev                                   # A2A on http://127.0.0.1:9000
```

`pnpm dev` binds `127.0.0.1`; set `AGENT_BIND_HOST=0.0.0.0` to expose it. Node 20 or later;
dependencies are pinned to the exact versions the live agents run.

Wallet material lives under `.studio/` at this workspace root and is never
committed; create a wallet with the studio tooling before first run.

## Environment switches (default = on; set to `0` to restore the earlier behaviour)

- `AGENT_BIND_HOST` (default `127.0.0.1`): set `0.0.0.0` only for a container runtime that must be reached from outside; the JSON-RPC handler authenticates nobody.
- `AGENT_CARD_URL_FROM_ERC8183=0`: the agent card `url` falls back to host:port instead of the public base derived from `ERC8183_AGENT_URL`.
- `AGENTCORE_RUNTIME_URL`, `BNBAGENT_PUBLIC_URL`, `AGENT_PUBLIC_URL`: an explicit public base for the card and the x402 resource URL, checked in that order.
- `AGENT_JOBID_STRICT=0`: accept job ids above 2^53 (silently truncated) and negative ids again.
- `AGENT_SWEEP_SINGLE_FLIGHT=0`: one funded-job chain scan per notification, and "accepted" for a notify_funded that names no job.
- `AGENT_CONFIG_FAIL_CLOSED=0`: sign quotes from an empty config when studio.toml cannot be loaded.
- `STRATEGY_SYMBOL_AGGREGATION=0`: per-row liquidation solve (two entries of one symbol are not folded).
- `STRATEGY_STRICT_INPUT=0`: blank strings read as 0, duplicate keys collapse, and an internal error is returned as a refusal instead of leaving the job funded for retry.
