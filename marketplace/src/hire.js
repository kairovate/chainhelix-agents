// Hire machinery: builds the exact transactions a buyer's own wallet sends to
// hire an agent and reads back what the chain says happened. Pure encoding
// plus public reads. This service holds no keys, signs nothing and never
// broadcasts; every transaction here is returned to the caller to sign in
// their own wallet.
import { createRequire } from "module";
import { RPC_URL } from "./config.js";
import { CATALOG } from "./catalog.js";

const require = createRequire(import.meta.url);
const sdk = require("@bnbagent/sdk");
const erc8183 = require("@bnbagent/sdk/erc8183");
const viem = require("viem");

export const NETWORK = sdk.NETWORKS["bsc-mainnet"];
const COMMERCE = NETWORK.commerceContract;
const ROUTER = NETWORK.routerContract;
const POLICY = NETWORK.policyContract;

// Minimal ABI, copied field-for-field from the SDK's bundled contract ABI.
const COMMERCE_ABI = [
  {
    type: "function",
    name: "createJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "provider", type: "address" },
      { name: "evaluator", type: "address" },
      { name: "expiredAt", type: "uint256" },
      { name: "description", type: "string" },
      { name: "hook", type: "address" },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "expectedBudget", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setBudget",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "jobHasBudget",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "JobCreated",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "client", type: "address", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "evaluator", type: "address", indexed: false },
      { name: "expiredAt", type: "uint256", indexed: false },
      { name: "hook", type: "address", indexed: false },
    ],
  },
];

const ROUTER_ABI = [
  {
    type: "function",
    name: "registerJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "policy", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "evidence", type: "bytes" },
    ],
    outputs: [],
  },
];

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
];

// publicnode's free tier intermittently mislabels fresh receipt reads as
// archive requests; dataseed serves them fine (it only rejects getLogs, which
// nothing here calls). Try the configured RPC first, fall back once.
const RPC_FALLBACK = "https://bsc-dataseed.binance.org";


// 2026-08-20 hardening (redteam A7): bounded body read for external JSON reads.
// A misbehaving upstream must not be able to stream us into the memory limit;
// 1MB is far above any legitimate response on this path.
const MAX_JSON_BYTES = 1_048_576;
async function jsonCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_JSON_BYTES) throw new Error("response body too large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// fix 2026-09-02 H188: rpcOn had no timeout and notifyFunded had neither a timeout nor a body cap
// (300 s per phase, the undici default, on an unauthenticated POST route). Every sibling fetch in this
// service is bounded at 10 s. 0 restores the unbounded behaviour.
const RPC_TIMEOUT_MS = Number(process.env.HIRE_RPC_TIMEOUT_MS ?? 10_000);
const NOTIFY_TIMEOUT_MS = Number(process.env.HIRE_NOTIFY_TIMEOUT_MS ?? 30_000);
const timeoutSignal = (ms) => (ms > 0 ? AbortSignal.timeout(ms) : undefined);

async function rpcOn(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: timeoutSignal(RPC_TIMEOUT_MS), // fix 2026-09-02 H188
  });
  const body = await jsonCapped(res);
  if (body.error) {
    // fix 2026-09-03 H189 H257: tag the JSON-RPC error so rpc() can tell a complete answer from a
    // healthy node (revert, bad params) apart from the transport-class failure the fallback is for.
    const err = new Error(`rpc ${method}: ${body.error.message}`);
    err.rpcApplicationError = true;
    err.rpcErrorCode = body.error.code;
    throw err;
  }
  return body.result;
}

// fix 2026-09-03 H189 H257: RPC_FALLBACK above is documented as a fallback for publicnode's archive
// mislabelling, which is an availability-shaped failure. A deterministic JSON-RPC error is a complete
// answer: replaying it doubles the outbound call on the path that is already failing and hands the
// caller dataseed's wording instead of publicnode's, so error attribution is wrong. Those are not
// replayed; every other failure, including the archive mislabel, still falls back.
// HIRE_RPC_FALLBACK_STRICT=0 restores the fall-back-on-any-throw behaviour.
const RPC_FALLBACK_STRICT = (process.env.HIRE_RPC_FALLBACK_STRICT ?? "1") !== "0";
const DETERMINISTIC_RPC_CODES = new Set([-32700, -32600, -32601, -32602]);
function isDeterministicRpcError(e) {
  if (!e?.rpcApplicationError) return false;
  if (DETERMINISTIC_RPC_CODES.has(e.rpcErrorCode)) return true;
  return /execution reverted|invalid argument|invalid param/i.test(e.message);
}

async function rpc(method, params) {
  try {
    return await rpcOn(RPC_URL, method, params);
  } catch (e) {
    if (RPC_URL === RPC_FALLBACK) throw e;
    if (RPC_FALLBACK_STRICT && isDeterministicRpcError(e)) throw e; // fix 2026-09-03 H189 H257
    return rpcOn(RPC_FALLBACK, method, params);
  }
}

// The seller may only submit while now < expiredAt - disputeWindow, so the
// job lifetime must exceed the policy's dispute window by the submission
// margin. Witnessed the hard way on job 56604: a 24h lifetime against the
// 7-day window makes every submit revert. Read the window from the policy,
// once.
const SUBMIT_MARGIN_SECONDS = 48 * 3600;
let disputeWindowPromise = null;
async function disputeWindowSeconds() {
  if (!disputeWindowPromise) {
    const sel = viem
      .keccak256(viem.toBytes("disputeWindow()"))
      .slice(0, 10);
    disputeWindowPromise = rpc("eth_call", [{ to: POLICY, data: sel }, "latest"]).then((r) =>
      Number(BigInt(r))
    );
    disputeWindowPromise.catch(() => (disputeWindowPromise = null));
  }
  return disputeWindowPromise;
}
export async function jobLifetimeSeconds() {
  return (await disputeWindowSeconds()) + SUBMIT_MARGIN_SECONDS;
}

// fix 2026-09-03 H190 H258: this client is what erc8183.verifyQuoteSignature reads through, and the
// comment below calls that read the safety check. It was pinned to RPC_URL alone, so a publicnode
// wobble turned into a 502 on /api/agents/:id/hire/plan while the raw reads through rpc() survived
// on the fallback. Same two endpoints, same order, one transport.
// HIRE_VERIFY_RPC_FALLBACK=0 pins it back to RPC_URL alone.
const VERIFY_RPC_FALLBACK = (process.env.HIRE_VERIFY_RPC_FALLBACK ?? "1") !== "0";
const publicClient = viem.createPublicClient({
  transport:
    VERIFY_RPC_FALLBACK && RPC_URL !== RPC_FALLBACK
      ? viem.fallback([viem.http(RPC_URL), viem.http(RPC_FALLBACK)])
      : viem.http(RPC_URL),
});

// Step 1: verify the signed quote and produce the createJob transaction.
// The signature check runs the SDK's own verifier (hash recompute, expiry,
// chain id, verifying contract, EIP-191 recover) so a tampered quote never
// reaches a wallet.
export async function buildCreateJobTx(envelope, providerWallet, nowSeconds) {
  if (!envelope?.response?.accepted) throw new Error("quote was not accepted");
  const verdict = await erc8183.verifyQuoteSignature({
    envelope,
    provider: providerWallet,
    publicClient,
    expectedVerifyingContract: COMMERCE,
  });
  if (!verdict.valid) {
    throw new Error(`quote signature rejected: ${verdict.reason}`);
  }
  const description = erc8183.buildJobDescription(envelope);
  const lifetime = await jobLifetimeSeconds();
  const expiredAt = BigInt(nowSeconds + lifetime);
  const data = viem.encodeFunctionData({
    abi: COMMERCE_ABI,
    functionName: "createJob",
    args: [providerWallet, ROUTER, expiredAt, description, ROUTER],
  });
  return {
    signatureVerified: { method: verdict.method, signer: verdict.signer },
    description,
    price: envelope.response.terms.price,
    currency: envelope.response.terms.currency,
    quoteExpiresAt: envelope.response.quote_expires_at,
    tx: { to: COMMERCE, data, value: "0x0" },
  };
}

// Step 2: recover the jobId the contract assigned, from the buyer's tx hash.
export async function jobIdFromTx(txHash) {
  const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { pending: true };
  if (receipt.status !== "0x1") return { failed: true };
  const logs = viem.parseEventLogs({
    abi: COMMERCE_ABI,
    eventName: "JobCreated",
    logs: receipt.logs.filter(
      (l) => l.address.toLowerCase() === COMMERCE.toLowerCase()
    ),
  });
  if (!logs.length) return { failed: true, reason: "no JobCreated event in receipt" };
  return { jobId: logs[0].args.jobId.toString() };
}

// Step 3: bind the evaluation policy on the router.
export function buildRegisterJobTx(jobId) {
  const data = viem.encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "registerJob",
    args: [BigInt(jobId), POLICY],
  });
  return { to: ROUTER, data, value: "0x0" };
}

// Step 4: set the budget (if not already set), approve (only if the
// allowance is short) and fund the escrow. fund() reverts ZeroBudget()
// without the setBudget step; the contract takes budget and escrow deposit
// as two separate transactions.
// fix 2026-09-03 H259: the two reads below decide whether the bundle carries setBudget and approve,
// and the buyer signs later. They were two independent "latest" calls, so they could straddle a block
// and the caller had no way to tell how old the plan was. Read one block number, pin both calls to it
// and stamp it on every returned tx; re-plan if the stamp is stale.
// HIRE_FUND_PIN_BLOCK=0 restores the two unpinned "latest" reads and drops the stamp.
const FUND_PIN_BLOCK = (process.env.HIRE_FUND_PIN_BLOCK ?? "1") !== "0";

export async function buildFundTxs(jobId, amount, buyer) {
  const txs = [];
  const blockTag = FUND_PIN_BLOCK ? await rpc("eth_blockNumber", []) : "latest"; // fix 2026-09-03 H259
  const hasBudgetData = viem.encodeFunctionData({
    abi: COMMERCE_ABI,
    functionName: "jobHasBudget",
    args: [BigInt(jobId)],
  });
  const hasBudgetRaw = await rpc("eth_call", [{ to: COMMERCE, data: hasBudgetData }, blockTag]);
  if (BigInt(hasBudgetRaw === "0x" ? 0 : hasBudgetRaw) === 0n) {
    txs.push({
      label: "setBudget",
      to: COMMERCE,
      data: viem.encodeFunctionData({
        abi: COMMERCE_ABI,
        functionName: "setBudget",
        args: [BigInt(jobId), BigInt(amount), "0x"],
      }),
      value: "0x0",
    });
  }
  const allowanceData = viem.encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [buyer, COMMERCE],
  });
  const raw = await rpc("eth_call", [
    { to: CATALOG.paymentToken.address, data: allowanceData },
    blockTag,
  ]);
  const allowance = BigInt(raw === "0x" ? 0 : raw);
  if (allowance < BigInt(amount)) {
    txs.push({
      label: "approve",
      to: CATALOG.paymentToken.address,
      data: viem.encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [COMMERCE, BigInt(amount)],
      }),
      value: "0x0",
    });
  }
  txs.push({
    label: "fund",
    to: COMMERCE,
    data: viem.encodeFunctionData({
      abi: COMMERCE_ABI,
      functionName: "fund",
      args: [BigInt(jobId), BigInt(amount), "0x"],
    }),
    value: "0x0",
  });
  if (FUND_PIN_BLOCK) for (const t of txs) t.readAtBlock = blockTag; // fix 2026-09-03 H259
  return txs;
}

// Final step, permissionless once the dispute window has passed.
export function buildSettleTx(jobId) {
  const data = viem.encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "settle",
    args: [BigInt(jobId), "0x"],
  });
  return { to: ROUTER, data, value: "0x0" };
}

// Forward notify_funded to a first-party agent over its local A2A port.
// fix 2026-09-03 H256: this forward carries no proof that the job exists, is funded, or names this
// agent as provider, and the route that calls it validates only the shape of job_id. It is a
// notification, not an authorisation: the seller re-runs the full gate itself (sellerCore
// verifySignedJob, then fulfillJob against expectedSigner = its own wallet address), so a forwarded
// job id cannot buy work. Do not add a paid action on this path without a gate of its own.
export async function notifyFunded(agent, jobId) {
  const res = await fetch(`http://127.0.0.1:${agent.localPort}/`, {
    method: "POST",
    signal: timeoutSignal(NOTIFY_TIMEOUT_MS), // fix 2026-09-02 H188
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          role: "user",
          kind: "message",
          messageId: `notify-${jobId}-${nowSecondsForId()}`,
          parts: [
            { kind: "data", data: { skill: "notify_funded", job_id: Number(jobId) } },
          ],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`notify HTTP ${res.status}`);
  const body = await jsonCapped(res); // fix 2026-09-02 H188: 1 MB cap, same as rpcOn
  return body?.result?.parts?.find((p) => p.kind === "data")?.data ?? body?.result ?? {};
}

function nowSecondsForId() {
  return Math.floor(Date.now() / 1000);
}
