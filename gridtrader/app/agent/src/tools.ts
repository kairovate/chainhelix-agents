/**
 * Read-only chain tools exposed to this agent's LLM (AI SDK `tool` wrap).
 *
 * Each entry in `LLM_READ_TOOLS` is a function from
 * `@bnbagent/studio-runtime/tools` wrapped as a Vercel AI SDK tool. The LLM
 * may call any tool in this set while producing the deliverable (the
 * `notify_funded` work step); the `description` is what the LLM sees.
 *
 * You own this file: edit `LLM_READ_TOOLS` to control exactly what your agent can read
 * on-chain. Entries for features your project does not use are commented out by default.
 *
 * fix 2026-09-03 H18: the line that used to follow, "uncomment after you've added the
 * dependency to `studio.toml`", was template text. No tool in this set reads a
 * studio.toml section of its own; the per-tool "requires [...] in studio.toml" comments
 * named three tables that do not exist in this project's config and are corrected below.
 *
 * **All tools are read-only** by the studio definition: no on-chain state
 * change, no transferable authority, no transaction signing, no EIP-712
 * typed-data signing. The agent IS the sole on-chain signer, but ALL of its
 * signing (quote-sign, submitResult, settle, plus any automatic budget-gated
 * provider-credit renewal a model-backed build may add) lives in the
 * entrypoint code (`signing.ts`) as FIXED code and is NEVER a tool
 * the LLM can invoke. The LLM only produces work text after a job is
 * verified funded; it can never price, sign, spend, or mutate chain state.
 * Keep this set read-only.
 *
 * (`pieverseUsage` is the one exception in the underlying module: it does a
 * SIWE EIP-191 personal_sign, domain-locked to llm.pieverse.io, no on-chain
 * effect. It is commented out below.)
 */

import * as cr from "@bnbagent/studio-runtime/tools";
import { loadStudioToml } from "@bnbagent/studio-runtime/config";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * The project-wide default network (`[network].default`): tool calls that omit
 * `network` fall back to it, never to a hardcoded name.
 *
 * fix 2026-09-03 H272: the body did the opposite of that sentence. Both a config that
 * could not be loaded and a config with no `[network].default` returned the literal
 * "bsc-testnet", on agents registered and funded on mainnet, so a read would quietly
 * answer about the wrong chain. This is the third copy of the same fail-open (the other
 * two are in signing.ts and sellerCore.ts, fixed under H266 and H269); all three now
 * fail closed. AGENT_NETWORK_FROM_CONFIG=0 restores the testnet literal.
 */
function defaultNetwork(): string {
  const lenient = process.env.AGENT_NETWORK_FROM_CONFIG === "0";
  let cfg: Record<string, unknown>;
  try {
    cfg = loadStudioToml() as Record<string, unknown>;
  } catch (e) {
    if (lenient) return "bsc-testnet";
    throw new Error(
      `studio.toml could not be loaded (${e instanceof Error ? e.message : String(e)}); refusing to read a chain without knowing which one`,
    );
  }
  const name = ((cfg.network ?? {}) as Record<string, unknown>).default;
  if (name === undefined || String(name).trim() === "") {
    if (lenient) return "bsc-testnet";
    throw new Error(
      "studio.toml names no [network].default; refusing to read a chain without knowing which one",
    );
  }
  return String(name);
}

const networkArg = z
  .string()
  .optional()
  .describe("studio network name (defaults to the project's [network].default)");

export const LLM_READ_TOOLS: ToolSet = {
  // --- Wallet & chain basics ---
  wallet_info: tool({
    // fix 2026-09-03 H17 H107 H197 H271: the runtime's walletInfo() returns
    // `keystore_dir` (or `key_location` for a twak wallet), an absolute path on the
    // machine running the agent, and this tool advertised it to the model as "key
    // location". The model's text is the deliverable, and the deliverable is submitted
    // on chain and served publicly, so a job whose prompt asks the agent to describe
    // itself could publish that path permanently. studio.toml says the opposite posture
    // three lines above its own [wallet] block: the keystore lives at the workspace root
    // so no packaging path can bundle it. Project only what a deliverable can use:
    // address and wallet kind. No published deliverable has ever carried a path
    // (13 published, measured, zero hits), and LLM_READ_TOOLS is not attached in the
    // four served agents, so this closes it before it can fire rather than after.
    // AGENT_WALLET_INFO_FULL=1 returns the runtime's full object again.
    description: "Describe the agent's active wallet (address and wallet kind).",
    inputSchema: z.object({}),
    execute: async () => {
      const info = (await cr.walletInfo()) as Record<string, unknown>;
      if (process.env.AGENT_WALLET_INFO_FULL === "1") return info;
      return { address: info.address, source: info.source };
    },
  }),
  balance_native: tool({
    description:
      "Native BNB balance of an address (defaults to the agent's own wallet).",
    inputSchema: z.object({
      address: z.string().optional().describe("0x address; omit for own wallet"),
      network: networkArg,
    }),
    execute: async ({ address, network }) =>
      cr.balanceNative(address ?? null, network ?? defaultNetwork()),
  }),
  balance_u: tool({
    // fix 2026-09-03 H18: this said "requires [u_token] in studio.toml". No such section
    // exists in this project (the config has [payments.erc8183], not [u_token]/[erc8004]/
    // [erc8183]), and the tool does not read studio.toml: the U token address comes
    // from the SDK network table. Nothing to uncomment, nothing to add.
    description:
      "$U (payment token) balance of an address (defaults to the agent's own wallet).",
    inputSchema: z.object({
      address: z.string().optional().describe("0x address; omit for own wallet"),
      network: networkArg,
    }),
    execute: async ({ address, network }) =>
      cr.balanceU(address ?? null, network ?? defaultNetwork()),
  }),
  network_info: tool({
    description: "Chain id / RPC / token info for a studio network.",
    inputSchema: z.object({ network: networkArg }),
    execute: async ({ network }) => cr.networkInfo(network ?? defaultNetwork()),
  }),
  tx_status: tool({
    description: "Status + receipt summary of a transaction hash.",
    inputSchema: z.object({
      tx_hash: z.string().describe("0x transaction hash"),
      network: networkArg,
    }),
    execute: async ({ tx_hash, network }) =>
      cr.txStatus(tx_hash, network ?? defaultNetwork()),
  }),

  // --- LLM provider ---
  // pieverse_usage: tool({
  //   // SIWE personal_sign; requires [llm.provider=pieverse-llm]
  //   description: "Provider usage/credit summary for the last N days.",
  //   inputSchema: z.object({ days: z.number().int().optional() }),
  //   execute: async ({ days }) => cr.pieverseUsage(days ?? 7),
  // }),

  // --- ERC-8004 identity (read-only lookups the LLM may want for context) ---
  agent_info: tool({
    // fix 2026-09-03 H18: no [erc8004] section exists in this project and the tool does not
    // read one; it uses the wallet plus the SDK factory, and returns an error object rather
    // than throwing when the lookup fails.
    description: "ERC-8004 identity record for an agent id.",
    inputSchema: z.object({
      agent_id: z.number().int().describe("ERC-8004 agent id"),
      network: networkArg,
    }),
    execute: async ({ agent_id, network }) =>
      cr.agentInfo(agent_id, network ?? defaultNetwork()),
  }),
  agent_by_address: tool({
    // fix 2026-09-03 H18: no [erc8004] section exists in this project and the tool does not
    // read one; it uses the wallet plus the SDK factory, and returns an error object rather
    // than throwing when the lookup fails.
    description: "Look up an ERC-8004 agent registration by wallet address.",
    inputSchema: z.object({
      address: z.string().describe("0x wallet address"),
      network: networkArg,
    }),
    execute: async ({ address, network }) =>
      cr.agentByAddress(address, network ?? defaultNetwork()),
  }),

  // --- ERC-8183 jobs (READ-ONLY status/list; writes live in signing.ts) ---
  job_status: tool({
    // fix 2026-09-03 H18: no [erc8183] section exists in this project (the config key is
    // [payments.erc8183], a different table, which this tool does not read); it uses the
    // wallet plus the SDK factory and returns an error object rather than throwing.
    description: "Read-only ERC-8183 job summary (status, budget, deliverable URL).",
    inputSchema: z.object({
      job_id: z.number().int().describe("on-chain job id"),
      network: networkArg,
    }),
    execute: async ({ job_id, network }) =>
      cr.jobStatus(job_id, network ?? defaultNetwork()),
  }),
  job_list: tool({
    // fix 2026-09-03 H18: no [erc8183] section exists in this project (the config key is
    // [payments.erc8183], a different table, which this tool does not read); it uses the
    // wallet plus the SDK factory and returns an error object rather than throwing.
    description: "List recent ERC-8183 jobs (optionally only this agent's).",
    inputSchema: z.object({
      limit: z.number().int().optional(),
      mine: z.boolean().optional().describe("only jobs assigned to this agent"),
      network: networkArg,
    }),
    execute: async ({ limit, mine, network }) =>
      cr.jobList({ limit, mine, network: network ?? defaultNetwork() }),
  }),
  // job_count: ...        // network-wide stat, usually noise

  // --- Advanced (commented by default; not for a seller) ---
  // contract_call_view: ...  // accepts any ABI; a model could call anything through it
  // block_info: ...
  // wallet_list: ...          // multi-wallet management, dev concern
  // wallet_address: ...       // alias of wallet_info
};
