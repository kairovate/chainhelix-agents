// Live price quotes. A listed price is never a stored number, it is a real
// wallet-signed negotiate quote fetched from the agent over A2A, cached only
// briefly (well inside the quote's own validity window).
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { TTL } from "./config.js";
import { viemTransports } from "./rpc.js"; // 2026-09-05: primary then fallback, see rpc.js
import { cached } from "./cache.js";

// fix 2026-09-02 H150: the storefront labelled every price "wallet-signed" and checked nothing; the check
// ran only on the hire path (hire.js buildCreateJobTx). Same SDK verifier here, against the agent's wallet
// from the catalog (the wallet shown next to its registry entry). QUOTE_SIG_CHECK=0 skips it.
const require = createRequire(import.meta.url);
const sdk = require("@bnbagent/sdk");
const erc8183 = require("@bnbagent/sdk/erc8183");
const viem = require("viem");
const SIG_CHECK = process.env.QUOTE_SIG_CHECK !== "0";
const COMMERCE = sdk.NETWORKS["bsc-mainnet"].commerceContract;
const publicClient = viem.createPublicClient({ transport: viemTransports(viem) }); // 2026-09-05: was pinned to RPC_URL alone
export async function verifyDisplayQuote(envelope, wallet) {
  if (!SIG_CHECK) return { checked: false };
  try {
    const v = await erc8183.verifyQuoteSignature({ envelope, provider: wallet, publicClient, expectedVerifyingContract: COMMERCE });
    return v.valid ? { checked: true, valid: true, method: v.method, signer: v.signer } : { checked: true, valid: false, reason: String(v.reason).slice(0, 120) };
  } catch (e) {
    return { checked: true, valid: false, reason: String(e.message).slice(0, 120) };
  }
}

// A minimal, schema-valid job spec per category, used only to obtain a
// representative signed quote for display. Real hires send their own spec.
const SAMPLE_SPECS = {
  rebalancing: {
    spec: {
      goal: "Rebalance a two-asset portfolio to target weights",
      holdings: { BTC: 0.5, ETH: 8 },
      targets: { BTC: 0.5, ETH: 0.5 },
      prices: { BTC: 64000, ETH: 1900 },
    },
    terms: {
      deliverables: "rebalancing plan with trade list",
      quality_standards: "deterministic arithmetic, drift and trades to 2 decimals",
    },
  },
  grid: {
    spec: { goal: "Lay out a grid for one asset", price: 600, budgetUsd: 1000 },
    terms: {
      deliverables: "grid level plan with per-level sizes",
      quality_standards: "deterministic arithmetic, levels within the stated span",
    },
  },
  yield: {
    spec: {
      goal: "Allocate capital across candidate pools",
      capitalUsd: 10000,
      pools: { alpha: { apyPct: 12, riskScore: 2 }, beta: { apyPct: 30, riskScore: 4 } },
    },
    terms: {
      deliverables: "allocation plan with per-pool amounts",
      quality_standards: "deterministic arithmetic, caps respected",
    },
  },
  health: {
    spec: {
      goal: "Compute loan health and liquidation prices",
      collateral: { BNB: { amount: 10, liqThreshold: 0.8 } },
      debt: { USDT: 2000 },
      prices: { BNB: 600, USDT: 1 },
    },
    terms: {
      deliverables: "health factor report with per-asset liquidation prices",
      quality_standards: "deterministic arithmetic, health factor to 4 decimals",
    },
  },
};

async function a2aNegotiate(localPort, taskDescription, terms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`http://127.0.0.1:${localPort}/`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            role: "user",
            kind: "message",
            messageId: randomUUID(),
            parts: [
              {
                kind: "data",
                data: { skill: "negotiate", task_description: taskDescription, terms },
              },
            ],
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`negotiate HTTP ${res.status}`);
    const body = await res.json();
    const data = body?.result?.parts?.find((p) => p.kind === "data")?.data;
    if (!data?.response) throw new Error("negotiate: no response part");
    return data;
  } finally {
    clearTimeout(t);
  }
}

// fix 2026-09-03 H57 H263: `.catch(() => null)` below made a dead agent, a 15 s timeout, a malformed
// envelope and a category with no sample spec render identically, no price on the card and nothing
// anywhere saying why. SAMPLE_SPECS covers exactly the four catalog categories today, so the missing-spec
// case is latent, but it fails as a bare TypeError on `sample.spec`. The reason is now named and written to
// stderr, where the service's other failures go. QUOTE_LOG_FAILURES=0 restores the silent catch.
const LOG_QUOTE_FAILURES = process.env.QUOTE_LOG_FAILURES !== "0";
function sampleFor(agent) {
  const sample = SAMPLE_SPECS[agent.category];
  if (!sample) throw new Error(`no sample spec for category ${JSON.stringify(agent.category)}`);
  return sample;
}

// Fetch (or serve the briefly-cached) representative quote for a listed agent.
export async function displayQuote(agent) {
  return cached(`quote:${agent.id}`, TTL.quote, async () => {
    const sample = sampleFor(agent); // fix 2026-09-03 H57 H263: inside the callback, so the catch below
    const data = await a2aNegotiate(
      agent.localPort,
      JSON.stringify(sample.spec),
      sample.terms
    );
    const r = data.response;
    const signatureVerified = await verifyDisplayQuote(data, agent.wallet); // fix 2026-09-02 H150
    return {
      accepted: r.accepted === true,
      amount: r.terms?.price ?? null,
      currency: r.terms?.currency ?? null,
      quoteExpiresAt: r.quote_expires_at ?? null,
      estimatedCompletionSeconds: r.estimated_completion_seconds ?? null,
      signatureVerified,
      source: signatureVerified.valid ? "live negotiate quote (A2A), signature verified against the agent wallet"
        : signatureVerified.checked ? "live negotiate quote (A2A), signature NOT verified"
        : "live wallet-signed negotiate quote (A2A)",
      sampleTask: sample.spec.goal,
    };
  }).catch((e) => {
    // fix 2026-09-03 H57 H263: name the failure instead of rendering it as "no price"
    if (LOG_QUOTE_FAILURES) console.error(`quote: display quote failed for ${agent.id}: ${e.message}`);
    return null;
  });
}

// Full negotiate passthrough used by /api/agents/:id/quote, same wire, the
// caller's own spec, nothing cached, full envelope returned (the caller needs
// negotiation_hash + provider_sig to anchor the job on-chain). Falls back to
// the sample spec only for the quote route; the hire plan refuses a missing
// task (server.js, fix 2026-09-02 H261) so no buyer signs the sample by accident.
// fix 2026-09-03 H58: the same substitution happens for `terms`, and those terms are inside the envelope the
// agent EIP-191 signs and the buyer anchors on chain. Requiring them here would break the buyer script,
// which sends terms only when HIRE_TERMS is set (scripts/hire.mjs L115), so the substitution is declared
// instead: both quote routes and the hire plan return termsSource "caller" or "sample"
// (server.js, fix 2026-09-02 H261) and the buyer script prints it. A caller that supplies both fields
// never touches SAMPLE_SPECS.
export async function liveQuote(agent, taskDescription, terms) {
  // fix 2026-09-03 H58: an unlisted category gave `sample.terms` on undefined, a bare TypeError that the
  // display path's catch hid and the passthrough path returned as a 502 with no reason. It is only reached
  // when the caller also omitted the field, so the message says which one is missing.
  const sample = taskDescription != null && terms != null ? null : sampleFor(agent);
  return a2aNegotiate(
    agent.localPort,
    taskDescription ?? JSON.stringify(sample.spec),
    terms ?? sample.terms
  );
}
