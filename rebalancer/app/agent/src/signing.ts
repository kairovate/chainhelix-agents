/**
 * Deterministic signing: the Agent is the SOLE key-holder/signer.
 *
 * Every on-chain WRITE the Agent performs lives here as FIXED code:
 *
 *     signQuote(...)    EIP-191 sign the (clamped) negotiated offer
 *     submitResult(...) build manifest → upload → on-chain `submit`
 *     settle(...)       claim payment after the dispute window
 *
 * These functions are never registered as tools for any model (`tools.ts`
 * holds only read-only scaffold tools that the entrypoint does not load).
 * The price is a FIXED list price from studio.toml (`listPrice()`, clamped
 * by the entrypoint BEFORE it reaches here); the work hook only produces the
 * deliverable text and never moves money or sets a price.
 *
 * The key is loaded by `@bnbagent/studio-runtime/wallet` `getWallet()` (local
 * keystore, unlocked by `WALLET_PASSWORD`). It is injected into the AgentCore
 * runtime via the secret store, never bundled into the code package.
 *
 * You own this file: edit the pricing clamp source / manifest shape if your
 * domain needs it, but keep these ops out of any tool list.
 */

import {
  JobDescription,
  NegotiationHandler,
  type NegotiationResult,
  type QuoteSigner,
} from "@bnbagent/sdk/erc8183";
import {
  loadStudioToml,
  type TomlTable,
} from "@bnbagent/studio-runtime/config";
import {
  erc8183Network,
  get8183Client,
  settleWorkflow,
  type SubmitResult,
  submitWorkflow,
  type Verdict,
  verifySignedJob as verifySignedJobCore,
} from "@bnbagent/studio-runtime/erc8183";
import { getWallet } from "@bnbagent/studio-runtime/wallet";

const MAX_UINT256 = (1n << 256n) - 1n;

// ── test seams (mirror the studio-runtime `_set*` convention) ────────────────
type StudioTomlLoader = () => TomlTable;
const defaultTomlLoader: StudioTomlLoader = () => loadStudioToml();
let tomlLoader: StudioTomlLoader = defaultTomlLoader;

/** Test seam: replace the studio.toml loader. Pass null to restore. */
export function _setStudioTomlLoader(loader: StudioTomlLoader | null): void {
  tomlLoader = loader ?? defaultTomlLoader;
  handler = null; // config feeds the cached handler: rebuild it
}

/** The narrow NegotiationHandler surface signQuote drives (test-fakeable). */
export interface NegotiationHandlerLike {
  negotiate(
    request: Record<string, unknown>,
    opts?: { price?: string; estimatedCompletionSeconds?: number },
  ): Promise<NegotiationResult> | NegotiationResult;
}

let handler: NegotiationHandlerLike | null = null;

type RuntimeWallet = ReturnType<typeof getWallet>;
type SessionQuoteWallet = RuntimeWallet & {
  sessionQuoteSigner(): QuoteSigner;
};

/** Select the narrow quote-only authority when the wallet exposes one. */
export function negotiationSignerOptions(
  wallet: RuntimeWallet,
): { quoteSigner: QuoteSigner } | { walletProvider: RuntimeWallet } {
  const candidate = wallet as Partial<SessionQuoteWallet>;
  return typeof candidate.sessionQuoteSigner === "function"
    ? { quoteSigner: candidate.sessionQuoteSigner.call(wallet) }
    : { walletProvider: wallet };
}

/** Test seam: replace the cached NegotiationHandler. Pass null to restore. */
export function _setNegotiationHandler(h: NegotiationHandlerLike | null): void {
  handler = h;
}

// ── config readers ────────────────────────────────────────────────────────────

/**
 * fix 2026-09-02 H266: a studio.toml load failure used to fall back to `{}`,
 * which made listPrice() 0 (a FREE job), currency "" and the network
 * "bsc-testnet", and the quote was still signed. Fail closed instead: no
 * config, no quote. AGENT_CONFIG_FAIL_CLOSED=0 restores the empty fallback.
 */
function loadCfgOrFail(what: string): TomlTable {
  try {
    return tomlLoader();
  } catch (e) {
    if (process.env.AGENT_CONFIG_FAIL_CLOSED === "0") return {};
    throw new Error(
      `studio.toml could not be loaded (${e instanceof Error ? e.message : String(e)}); refusing to ${what} without config`,
    );
  }
}

/** Read `[payments.erc8183]` from studio.toml; throws when the config cannot be loaded. */
function erc8183Cfg(): Record<string, unknown> {
  const cfg = loadCfgOrFail("read [payments.erc8183]");
  const payments = (cfg.payments ?? {}) as Record<string, unknown>;
  return (payments.erc8183 ?? {}) as Record<string, unknown>;
}

/** studio.toml `[network].default` (binds the quote signature); throws when the config cannot be loaded. */
export function defaultNetworkName(): string {
  const cfg = loadCfgOrFail("bind the quote to a network");
  const name = ((cfg.network ?? {}) as TomlTable).default;
  // fix 2026-09-03 H269: a config that loads but names no network used to fall back to
  // the literal "bsc-testnet", so the quote signature would bind to testnet on an agent
  // registered and funded on mainnet, with no error anywhere. Fail closed instead: the
  // network is what the signature commits to. AGENT_NETWORK_FROM_CONFIG=0 restores the
  // testnet literal.
  if (name === undefined || String(name).trim() === "") {
    if (process.env.AGENT_NETWORK_FROM_CONFIG === "0") return "bsc-testnet";
    throw new Error(
      "studio.toml names no [network].default; refusing to bind a quote signature to a guessed network",
    );
  }
  return String(name);
}

/**
 * Bind provider_sig to the same Commerce deployment used by the runtime
 * client. QA/custom stacks override the canonical SDK registry via env.
 */
export function commerceVerifyingContract(
  networkName: string,
): `0x${string}` {
  return erc8183Network(networkName).commerceContract as `0x${string}`;
}

/**
 * Return `[minPrice, maxPrice]` in raw wei from studio.toml.
 *
 * These are the clamp bounds applied to the configured list price BEFORE
 * signing. `min_price`/`max_price` are raw uint256 strings in
 * `[payments.erc8183]`.
 */
export function priceBounds(): [bigint, bigint] {
  const cfg = erc8183Cfg();
  // If min/max are absent the bounds default to (0, +inf), i.e. NO clamp.
  // fix 2026-09-02 H24: the shipped studio.toml now sets min_price = the list
  // price and max_price = 10x the list price on every agent; keep both set.
  // The scaffold ships max_price = "" (an empty string, not absent), so treat
  // empty/whitespace the same as missing and fall back to the default bound.
  const raw = (key: string, dflt: bigint): bigint => {
    const s = String(cfg[key] ?? "").trim();
    return s ? BigInt(s) : dflt;
  };
  return [raw("min_price", 0n), raw("max_price", MAX_UINT256)];
}

/**
 * Return the seller's list price in raw wei from studio.toml.
 *
 * Reads `[payments.erc8183].price`, the deterministic asking price every
 * quote uses (rule-based pricing; no model in the quote path). Empty/absent: 0.
 * Edit `price` in studio.toml to change what you charge. The value is still
 * clamped to `[minPrice, maxPrice]` by {@link clampPrice} before signing.
 */
export function listPrice(): bigint {
  const s = String(erc8183Cfg().price ?? "").trim();
  // fix 2026-09-03 H102: an absent or empty `price` returned 0n, and studio.toml says
  // in the same file that price 0 means FREE. So one mistyped or deleted line turned a
  // paid agent into a free one, silently, on the signing path. An absent value is a
  // refusal, not a default; a deliberate FREE agent writes price = "0", which still
  // works. AGENT_PRICE_REQUIRED=0 restores the silent 0n.
  if (!s && process.env.AGENT_PRICE_REQUIRED !== "0") {
    throw new Error(
      "studio.toml [payments.erc8183] names no price; refusing to quote. Set price = \"0\" if this agent is deliberately FREE",
    );
  }
  return s ? BigInt(s) : 0n;
}

/** Clamp a proposed price into `[minPrice, maxPrice]`. */
export function clampPrice(proposedWei: bigint): bigint {
  const [lo, hi] = priceBounds();
  // fix 2026-09-03 H27 H160: the ceiling was applied first and the floor last and
  // unconditionally, so an inverted range (min_price > max_price, one decimals slip
  // between two adjacent config lines) returned the FLOOR, a price ABOVE the configured
  // ceiling, with no error. Measured on the old code with bounds (500, 200):
  // clampPrice(100) and clampPrice(1000) both returned 500. The right answer to an
  // inverted range is to refuse to sign, not to pick a side.
  // AGENT_PRICE_BOUNDS_STRICT=0 restores the old floor-wins behaviour.
  if (lo > hi && process.env.AGENT_PRICE_BOUNDS_STRICT !== "0") {
    throw new Error(
      `studio.toml [payments.erc8183] min_price (${lo}) is above max_price (${hi}); refusing to sign a quote against an inverted price range`,
    );
  }
  const capped = proposedWei < hi ? proposedWei : hi;
  return capped > lo ? capped : lo;
}

/**
 * Return the process-wide NegotiationHandler (lazy, cached).
 *
 * The handler's chainId + verifyingContract are stable per process, so we
 * build it once. The per-request clamped price is passed via
 * `negotiate(..., { price })` (see {@link signQuote}), so the
 * construction-time `servicePrice` is a placeholder that is always
 * overridden.
 *
 * chainId + verifyingContract bind provider_sig to this chain/contract
 * (prevents cross-chain replay). The runtime client facade does not expose
 * them, so
 * they come from the SDK's on-chain address registry for the configured
 * network, the same addresses the live client is constructed from.
 */
function getHandler(): NegotiationHandlerLike {
  if (handler === null) {
    const cfg = erc8183Cfg();
    const currency = String(cfg.currency ?? ""); // the Agent owns the currency now
    const ttl = Number(cfg.quote_ttl_seconds ?? 900);
    const est = Number(cfg.default_estimated_completion_seconds ?? 600);
    const networkName = defaultNetworkName();
    const network = erc8183Network(networkName);
    const wallet = getWallet();
    handler = new NegotiationHandler({
      servicePrice: "0", // placeholder, overridden per call via price=
      currency,
      estimatedCompletionSeconds: est,
      ...negotiationSignerOptions(wallet),
      quoteTtlSeconds: ttl,
      chainId: network.chainId,
      verifyingContract: network.commerceContract as `0x${string}`,
    });
  }
  return handler;
}

/**
 * Negotiate + EIP-191-sign a quote at `clampedPriceWei`; return the SDK
 * envelope.
 *
 * Reuses a process-wide NegotiationHandler (cached: its chainId +
 * verifyingContract are stable per process) and overrides the price for this
 * request via `negotiate(..., { price: String(clampedPriceWei) })`.
 *
 * Returns the SDK's `NegotiationResult.toDict()` envelope **verbatim**; the
 * exact wire structure a buyer parses and feeds to `buildJobDescription` to
 * anchor on-chain (see docs/design/erc8183-reference.md §2). On accept it
 * carries `response.terms.price`/`currency`, `quote_expires_at`,
 * `negotiation_hash`, `response_hash`, `provider_sig`, `chain_id`,
 * `verifying_contract`; on reject it carries `response.reason_code` /
 * `reason` (empty hash + sig). We do NOT invent a custom shape.
 */
export async function signQuote(
  request: Record<string, unknown>,
  clampedPriceWei: bigint,
): Promise<Record<string, unknown>> {
  // Validate the entire custom contract trio before signing, including when
  // tests inject a handler or a previously cached handler is reused.
  commerceVerifyingContract(defaultNetworkName());
  const cfg = erc8183Cfg();
  const est = Number(cfg.default_estimated_completion_seconds ?? 600);

  const result = await getHandler().negotiate(request, {
    price: String(clampedPriceWei),
    estimatedCompletionSeconds: est,
  });

  // NegotiationHandler signs non-fatally: if signMessage failed it returns an
  // accepted result WITHOUT provider_sig. Never relay an unsigned "accepted".
  if (result.accepted && (!result.negotiationHash || !result.providerSig)) {
    throw new Error(
      "quote accepted but provider_sig is missing (wallet sign failed); " +
        "refusing to relay an unsigned offer",
    );
  }

  return result.toDict();
}

/**
 * Verify funded `jobId` carries the quote THIS agent signed.
 *
 * Thin wrapper over `@bnbagent/studio-runtime/erc8183` `verifySignedJob` with
 * `expectedSigner` = our own wallet address. Returns a `Verdict` `{ ok,
 * reason, permanent }`: `ok` → safe to work; otherwise `permanent`
 * distinguishes a job to skip-forever (record + tell the client) from a
 * transient retry.
 */
export async function verifySignedJob(jobId: number): Promise<Verdict> {
  return verifySignedJobCore(jobId, getWallet().address);
}

/**
 * Return the on-chain `JobDescription` for `jobId` (`null` if unstructured).
 *
 * The task + terms the buyer ANCHORED ON-CHAIN (and that this agent's
 * `provider_sig` covers) are the authoritative work spec. The work hook
 * reads the task from HERE (the on-chain job description), so the Agent
 * delivers exactly the deal it signed.
 * Returns `null` for legacy/plain-text descriptions (caller falls back).
 */
export async function jobSpec(jobId: number): Promise<JobDescription | null> {
  const client = await get8183Client();
  const job = await client.getJob(BigInt(jobId));
  return JobDescription.fromStr(job.description);
}

/**
 * Sign + broadcast the on-chain `submit` for `jobId`.
 *
 * Delegates to `@bnbagent/studio-runtime/erc8183` `submitWorkflow`, which
 * re-verifies the job is genuinely FUNDED + assigned to us (via the SDK's
 * `ERC8183JobOps.verifyJob`), builds the `DeliverableManifest`, uploads it
 * to storage, and calls on-chain `submit`, all `auditedOp`-wrapped.
 * Returns the `SubmitResult` (`.submitTx` + `.deliverableUrl`);
 * `deliverableUrl` is published on-chain by the submit, so the buyer fetches
 * the canonical manifest from storage without an on-chain log scan.
 */
export async function submitResult(
  jobId: number,
  responseContent: string,
  metadata?: Record<string, unknown> | null,
): Promise<SubmitResult> {
  return submitWorkflow(jobId, responseContent, { metadata: metadata ?? null });
}

/**
 * Sign + broadcast `settle` (claim payment) for `jobId`.
 *
 * Delegates to `@bnbagent/studio-runtime/erc8183` `settleWorkflow` with the
 * default `approve` action → SDK `router.settle(jobId)`, `auditedOp`-wrapped.
 * Returns the settle tx hash.
 */
export async function settle(jobId: number): Promise<string> {
  return settleWorkflow(jobId, { action: "approve" });
}
