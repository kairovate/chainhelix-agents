/**
 * A2A AgentCard: the seller agent's outward, discoverable identity.
 *
 * Built by `unifiedMain.ts` and served at `/.well-known/agent-card.json`.
 * `card.url` is the address an A2A client dials after reading the card, so
 * it must be the PUBLIC address. Resolution order, see {@link publicBaseUrl}:
 * AGENTCORE_RUNTIME_URL (a managed AgentCore deploy), BNBAGENT_PUBLIC_URL
 * (an operator gateway in front of the agent), the base of ERC8183_AGENT_URL
 * (the public agent URL the ERC-8183 rail already carries, minus its
 * `/erc8183` suffix), and only then the local-dev host:port fallback.
 *
 * The card advertises the agent's WORK skill (generated from the shared strategy schema,
 * with a worked example) plus the two commerce skills `negotiate` and `notify_funded`.
 * Authentication: on an AgentCore deploy `bag deploy provision-cognito`
 * injects `OAUTH_TOKEN_URL` / `OAUTH_SCOPE`, the card then carries the OAuth2
 * client-credentials scheme and the runtime's inbound JWT authorizer enforces
 * it. The self-hosted deployment behind a reverse proxy sets neither, so the
 * public card advertises NO security scheme and `negotiate` answers without a
 * bearer. Recorded decision (2026-09-02), not an omission: a quote is the
 * fixed list price signed by the agent, it costs the caller nothing until the
 * buyer funds it on chain at that price, the proxy rate-limits the endpoint
 * (10 requests per second per address, burst 20), and nothing is delivered or
 * signed for money without a chain-verified funded job.
 *
 * You own this file: edit the skill descriptions / card metadata for your
 * seller.
 */

import type { AgentCard, AgentSkill, SecurityScheme } from "@a2a-js/sdk";
import { loadStudioToml } from "@bnbagent/studio-runtime/config";
import { WORK_SCHEMAS, exampleTaskDescription, skillDescription, inputSchema } from "../vendor/strategies/schema.js";
import type { WorkSchema } from "../vendor/strategies/schema.js";

const NEGOTIATE: AgentSkill = {
  id: "negotiate",
  name: "Negotiate an ERC-8183 job",
  description:
    'Send a data part {"skill": "negotiate", "task_description": "<the job spec as the flat JSON object ' +
    'shown in the work skill\'s examples>", ' +
    '"terms": {"deliverables": "...", "quality_standards": "..."}} (both ' +
    "terms keys are REQUIRED) and receive a " +
    "wallet-signed price quote (price, currency, negotiation_hash, provider_sig). " +
    "Anchor the returned envelope on-chain via createJob + fund, then send the " +
    "`notify_funded` skill with the job_id to request delivery.",
  tags: ["erc8183", "negotiation", "bnb-chain"],
  inputModes: ["application/json"],
  outputModes: ["application/json"],
};

/**
 * fix 2026-09-05 (audit H68 completed): the WORK skill. Until now the card advertised only the
 * two commerce skills, so a buyer could learn how to haggle and how to say "I funded it" and
 * nothing about what a job must contain; the one outside hire (job 56680) guessed field names
 * and was refused. The id, name, description, parameter table and the worked example all come
 * from vendor/strategies/schema.ts, the same source the dispatcher's refusal hint is built from.
 */
function workSkill(category: WorkSchema["category"]): AgentSkill {
  const s = WORK_SCHEMAS[category];
  return {
    id: s.category,
    name: s.name,
    description: skillDescription(category),
    tags: s.tags,
    examples: [exampleTaskDescription(category)],
    inputModes: ["application/json"],
    outputModes: ["application/json"],
  };
}

const NOTIFY_FUNDED: AgentSkill = {
  id: "notify_funded",
  name: "Notify the seller a job is funded (request delivery)",
  description:
    'After you fund the job on-chain, send {"skill": "notify_funded", ' +
    '"job_id": <int>} to tell the seller "I funded job X, please deliver". ' +
    "The seller verifies the funded job carries its signed quote and replies " +
    'AT ONCE with {"status": "accepted"|"rejected", "job_id"}; delivery then ' +
    "runs in the background (work takes time). Do NOT wait on this call for " +
    "the result; read the deliverable back from the CHAIN once the job " +
    "reaches SUBMITTED (the `submit` tx carries the deliverable_url; " +
    "ERC-8183 `get_deliverable_url`). The agent serves no job-query endpoint.",
  tags: ["erc8183", "delivery", "bnb-chain"],
  inputModes: ["application/json"],
  outputModes: ["application/json"],
};

/** Card name from studio.toml `[project].name` (best-effort). */
function agentName(): string {
  let name = "";
  try {
    const cfg = loadStudioToml();
    name = String(
      ((cfg.project ?? {}) as Record<string, unknown>).name ?? "",
    );
  } catch {
    // a card label must never break boot
  }
  return name || "bnbagent-seller";
}

/**
 * OAuth2 (Cognito client-credentials) scheme from env, or null locally.
 *
 * `bag deploy provision-cognito` emits a Cognito user pool + app client and
 * injects `OAUTH_TOKEN_URL` + `OAUTH_SCOPE`; the AgentCore runtime's inbound
 * JWT authorizer is wired to the same pool. Absent (local `bag dev`):
 * return null so the card advertises no auth requirement.
 */
function oauth2Scheme(): SecurityScheme | null {
  const tokenUrl = process.env.OAUTH_TOKEN_URL;
  const scope = process.env.OAUTH_SCOPE;
  // fix 2026-09-03 H20: the local case this null branch exists for is NEITHER variable
  // set. Half a pair is a deployment mistake, and taking the same branch published a
  // card with no security block while the inbound JWT authorizer kept enforcing, so a
  // buyer that read the card and called without a bearer got a 403 it could not have
  // anticipated. Enforcement is unaffected either way; what breaks is discovery. Say so
  // loudly instead of publishing a card that understates the requirement.
  // AGENT_OAUTH_PAIR_STRICT=0 restores the silent null.
  if (!tokenUrl !== !scope && process.env.AGENT_OAUTH_PAIR_STRICT !== "0") {
    throw new Error(
      `OAUTH_TOKEN_URL and OAUTH_SCOPE must be set together: OAUTH_TOKEN_URL is ${
        tokenUrl ? "set" : "missing"
      } and OAUTH_SCOPE is ${
        scope ? "set" : "missing"
      }; refusing to publish an agent card that advertises no auth requirement while the runtime enforces one`,
    );
  }
  if (!tokenUrl || !scope) {
    return null;
  }
  return {
    type: "oauth2",
    flows: {
      clientCredentials: {
        tokenUrl,
        scopes: { [scope]: "Invoke the seller agent" },
      },
    },
  };
}

/**
 * Public base URL of this agent, with a trailing slash. Used for `card.url`
 * and for the x402 402-challenge resource URL in `unifiedMain.ts`.
 */
export function publicBaseUrl(): string {
  const explicit =
    process.env.AGENTCORE_RUNTIME_URL ??
    process.env.BNBAGENT_PUBLIC_URL ??
    process.env.AGENT_PUBLIC_URL;
  if (explicit) return explicit.endsWith("/") ? explicit : `${explicit}/`;
  // fix 2026-09-02 H109: behind the reverse proxy none of the three variables
  // above is set, so every public card advertised the loopback bind address
  // (http://127.0.0.1:910x/). The service unit already carries the public
  // URL in ERC8183_AGENT_URL (.../<agent>/erc8183); derive the base from it.
  // AGENT_CARD_URL_FROM_ERC8183=0 restores the host:port fallback below.
  const rail = (process.env.ERC8183_AGENT_URL ?? "").trim();
  if (process.env.AGENT_CARD_URL_FROM_ERC8183 !== "0" && rail !== "") {
    const m = /^(https?:\/\/[^\s]+?)\/erc8183\/?$/.exec(rail);
    if (m !== null) return `${m[1]}/`;
  }
  // Local-dev fallback: a client-routable localhost URL (not the 0.0.0.0
  // bind address). Host via AGENT_HOST (default localhost); port via the
  // same AGENT_PORT to 9000 resolution unifiedMain.ts serves on. Do not honor
  // the AgentCore HTTP $PORT=8080 convention for this A2A runtime.
  return `http://${process.env.AGENT_HOST ?? "localhost"}:${process.env.AGENT_PORT || "9000"}/`;
}

/** Build the A2A AgentCard, gating ERC-8183 skills on the configured rail. */
export function buildAgentCard(
  opts: { commerceSkills?: boolean; category?: WorkSchema["category"] } = {},
): AgentCard {
  const name = agentName();
  const extra: Partial<AgentCard> = {};
  const scheme = oauth2Scheme();
  if (scheme !== null) {
    const scope = process.env.OAUTH_SCOPE as string;
    extra.securitySchemes = { oauth2: scheme };
    extra.security = [{ oauth2: [scope] }];
  }
  return {
    name,
    description: `${name}: deterministic on-chain work, sold per job through ERC-8183 escrow (negotiate + notify_funded over A2A) and per call on the B402 rail (/x402). The work skill on this card states exactly what a job must contain.`,
    url: publicBaseUrl(),
    version: "1.0.0",
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    // Non-streaming: negotiate / notify_funded are request/response
    // (message/send). Do NOT flip this on to satisfy the AgentCore
    // inspector's chat box: that box can't drive a seller agent (it can
    // only send plain text, never the {"skill": ...} DataPart these skills
    // require, and its streaming view expects Task events). Test locally
    // with curl / an A2A client sending a DataPart (see the operating skill).
    capabilities: {
      streaming: false,
      // fix 2026-09-05 (brief part 3, the bridge): A2A has no per-skill body schema, so the work
      // skill's JSON Schema rides as an extension, in the same {inputSchema} shape the MCP product
      // publishes per tool. Generated from vendor/strategies/schema.ts like everything else here.
      ...(opts.category
        ? {
            extensions: [
              {
                uri: "https://agents.chainhelix.io/ext/skill-input-schema/v1",
                description: "JSON Schema (draft 2020-12) of the task_description each work skill accepts, keyed by skill id",
                required: false,
                params: { [opts.category]: inputSchema(opts.category) },
              },
            ],
          }
        : {}),
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      ...(opts.category ? [workSkill(opts.category)] : []),
      ...(opts.commerceSkills === false ? [] : [NEGOTIATE, NOTIFY_FUNDED]),
    ],
    ...extra,
  };
}
