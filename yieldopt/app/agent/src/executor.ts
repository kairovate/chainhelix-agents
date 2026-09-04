/**
 * A2A executor: the seller agent's outward A2A surface (two fixed-code
 * skills).
 *
 * The agent serves A2A directly (an `@a2a-js/sdk` express app on the
 * AgentCore A2A runtime contract). This module is ONLY the a2a wire:
 * {@link SellerAgentExecutor} inherits all of the seller logic +
 * background-delivery machinery from `sellerCore.ts` `SellerCore` (which
 * imports nothing from `@a2a-js/sdk`) and adds the a2a-specific
 * {@link SellerAgentExecutor.execute} / {@link SellerAgentExecutor.cancelTask}
 * entrypoints plus the request/response wire helpers. `execute` reads the
 * inbound message's data part and dispatches on its `skill`:
 *
 *     negotiate     → `SellerCore.negotiate` (rule-based price clamp + EIP-191 sign)
 *     notify_funded → `SellerCore.notifyFunded` (fast on-chain gate) → ACK at
 *                     once, then in the BACKGROUND: the `runWork` hook (deterministic
 *                     strategy math, see `unifiedMain.ts`) → `signing.submitResult`
 *
 * `notify_funded` is the buyer's "I funded job X, please deliver"
 * notification. Because the work takes time, the executor does NOT block the
 * caller: the core verifies the funded job synchronously (a couple of
 * eth_calls) to ACK accepted/rejected, then runs the slow work + on-chain
 * `submit` in a background task and replies immediately. The buyer reads the
 * deliverable back from the CHAIN (SUBMITTED / `getDeliverableUrl`); the
 * chain is the source of truth. While any background delivery is in flight
 * `isBusy` (from `SellerCore`) reports busy, which `main.ts` feeds to
 * AgentCore's `/ping` as `HEALTHY_BUSY` so the scale-to-zero runtime stays
 * warm until the work lands (within the session max-lifetime).
 *
 * fix 2026-09-02 H273: this header used to describe a model producing the
 * work text; the four listed agents compute it with fixed strategy code.
 * ALL signing is FIXED code in `signing.ts`, never callable by any model or
 * tool; the deliverable text comes only from the `runWork` hook. See
 * `sellerCore.ts` for the negotiate / notifyFunded / sweep logic.
 *
 * You own this file: specialise the work hook / dispatch in `sellerCore.ts`,
 * and keep signing out of any tool list.
 */

import { randomUUID } from "node:crypto";
import type { DataPart, Message } from "@a2a-js/sdk";
import {
  A2AError,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { SellerCore } from "./sellerCore.js";

const log = {
  error: (msg: string, e?: unknown) =>
    console.error(`[seller-agent.a2a] ERROR ${msg}`, e ?? ""),
};

/**
 * ERC-8183 seller A2A executor: the a2a wire over `SellerCore`.
 *
 * All seller logic (negotiate, notifyFunded, background delivery, `isBusy`,
 * the constructor bookkeeping, the `runWork` hook) lives in
 * `sellerCore.ts` `SellerCore`; this class adds only the A2A entrypoints and
 * request/response wire helpers.
 *
 * The agent exposes ONLY the two paid, structured skills; there is no
 * free-form chat skill. A plain text message (no `{"skill": ...}` DataPart)
 * is rejected: negotiate / notify_funded always need a structured DataPart,
 * so prose never triggers work or a paid action.
 *
 * fix 2026-09-03 H163: `negotiate` is deliberately open. Nothing here, in
 * `sellerCore.negotiate` or in `signing.signQuote` authenticates the caller or
 * rate-limits, so anyone can obtain EIP-191 quote signatures from the agent key.
 * That is bounded on purpose and the bound is the reason it stays open: the signed
 * payload is a NegotiationResult hashed against `chainId` + `verifyingContract`
 * (signing.ts, `network.chainId` / `network.commerceContract`), the price is the
 * fixed list price from studio.toml, and the quote expires after
 * `quote_ttl_seconds`. The signatures are therefore not repurposable and not
 * replayable past the TTL; the cost of abuse is CPU and key-usage volume, not loss.
 * This is why negotiate is rated below the `notify_funded` path, which costs a
 * pending-job chain scan per call and is guarded separately by the single-flight
 * sweep (AGENT_SWEEP_SINGLE_FLIGHT). The two are different on purpose.
 *
 * fix 2026-09-03 H165: the two carriers disagree on faults BY DESIGN, and a buyer
 * has to know which one it is on. Over the text carrier (`dispatch`) a fault comes
 * back as `{"error": "..."}` with HTTP success, because that carrier has no error
 * channel. Over A2A JSON-RPC (`execute`) the same fault is thrown as
 * `A2AError.internalError` and reaches the caller as JSON-RPC -32603. A buyer
 * written against one carrier must not assume the other's shape. The same note is
 * in the agent README so a buyer reads it without reading this file.
 */
export class SellerAgentExecutor extends SellerCore implements AgentExecutor {
  /**
   * Text-carrier entrypoint (Foundry invocations / responses SkillRouter).
   *
   * Same skill switch as {@link execute}, but NEVER throws: on a text
   * carrier there is no JSON-RPC error channel, so a fault is returned as an
   * `{"error": ...}` dict and the caller can always reply. The A2A path
   * keeps its own switch below because its fault semantics differ (faults
   * become JSON-RPC -32603 via A2AError).
   */
  async dispatch(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const skill = data.skill;
    try {
      if (skill === "negotiate") {
        return await this.negotiate(data);
      }
      if (skill === "notify_funded") {
        return await this.notifyFunded(data);
      }
      // Includes a plain text message (no skill envelope → skill is
      // undefined): the seller has no free-form skill, so prose is rejected
      // here.
      return {
        error: `unknown skill: ${JSON.stringify(skill)}`,
        skills: this.skills(),
      };
    } catch (e) {
      // a skill failure must still ACK the buyer
      log.error(`skill ${JSON.stringify(skill)} failed`, e);
      // fix 2026-09-03 H289: class only, detail stays in the log (see faultText).
      return { error: faultText(e), skill };
    }
  }

  // ── A2A entrypoints ───────────────────────────────────────────────────────
  execute = async (
    context: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> => {
    const data = inbound(context);
    const skill = data.skill;
    let result: Record<string, unknown>;
    try {
      if (skill === "negotiate") {
        result = await this.negotiate(data);
      } else if (skill === "notify_funded") {
        result = await this.notifyFunded(data);
      } else {
        // Includes a plain text message (no DataPart → skill is undefined):
        // the seller has no free-form skill, so prose is rejected here.
        result = {
          error: `unknown skill: ${JSON.stringify(skill)}`,
          skills: this.skills(),
        };
        if (skill === undefined) {
          // Most common cause: the caller put the JSON envelope in a
          // "text" part. Structured skill calls must ride in a DataPart.
          result.hint =
            'send the skill envelope as an A2A data part: parts:[{"kind":"data","data":{"skill":"negotiate",...}}]';
        }
      }
    } catch (e) {
      // A genuine internal fault is surfaced as a JSON-RPC error, NOT masked
      // as a successful result. Throwing `A2AError.internalError` is caught
      // by @a2a-js/sdk's request handler and serialized to a proper -32603
      // carrying the request id. CLASSIFIED business outcomes are
      // returned as a result above (peer of the MCP runtime: faults →
      // isError, business outcomes → result).
      log.error(`skill ${JSON.stringify(skill)} failed`, e);
      // fix 2026-09-03 H289: class only, detail stays in the log (see faultText).
      throw A2AError.internalError(faultText(e));
    }
    reply(eventBus, context, result);
  };

  cancelTask = async (
    _taskId: string,
    _eventBus: ExecutionEventBus,
  ): Promise<void> => {
    // negotiate is synchronous; notify_funded acks then delivers on-chain in
    // the background; once submitted it is anchored on-chain and cannot be
    // cancelled via A2A. Nothing to cancel here. (@a2a-js/sdk hands cancel
    // only a taskId, no message to reply to, so this surfaces as the
    // standard JSON-RPC unsupported-operation error.)
    throw A2AError.unsupportedOperation("cancel");
  };
}

// ── wire helpers ──────────────────────────────────────────────────────────────

/**
 * fix 2026-09-03 H289: what an anonymous caller is told about an internal fault.
 *
 * Both carriers used to return the exception's own text. The A2A root is reachable
 * without the marketplace, so that text goes to whoever asked, and an exception from
 * the chain layer carries the RPC host, the contract address, the block range and the
 * client version. The marketplace already settled this convention for the same class
 * of leak, server.js: `req.log.warn({ err: e.message }, "upstream failure"); // detail
 * stays server-side (redteam A6: e.message leaked internal hosts/ports)`. The agent
 * now does the same: the full error keeps going to the journal through log.error just
 * above each call site, and the caller gets the fault CLASS plus the skill, which is
 * what a client needs to decide whether to retry.
 *
 * Business outcomes are unaffected: they are returned as results, never thrown, so
 * nothing a buyer legitimately needs to read passes through here.
 * AGENT_ERROR_DETAIL=1 returns the old verbatim text (local debugging).
 */
function faultText(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name : "Error";
  if (process.env.AGENT_ERROR_DETAIL === "1") {
    const msg = e instanceof Error ? e.message : String(e);
    return `${name}: ${msg}`;
  }
  return `${name}: the agent hit an internal fault; the detail is in the agent log`;
}

function inbound(context: RequestContext): Record<string, unknown> {
  const parts = context.userMessage?.parts ?? [];
  const dataParts = parts.filter((p): p is DataPart => p.kind === "data");
  // fix 2026-09-03 H164: A2A permits several data parts and this read took the first
  // one only, so a buyer that put the skill envelope in the second part had it ignored
  // and got the unknown-skill rejection with the envelope sitting one part away. Take
  // the first data part that actually carries a skill; fall back to the old
  // first-part reading when none does, so a caller that follows the one-envelope
  // contract sees no change. AGENT_MULTI_DATAPART=0 restores the first-part-only read.
  if (process.env.AGENT_MULTI_DATAPART !== "0") {
    const withSkill = dataParts.find(
      (p) => (p.data as Record<string, unknown> | undefined)?.skill !== undefined,
    );
    if (withSkill !== undefined) return withSkill.data ?? {};
  }
  return dataParts[0]?.data ?? {};
}

function reply(
  eventBus: ExecutionEventBus,
  context: RequestContext,
  data: Record<string, unknown>,
): void {
  const message: Message = {
    kind: "message",
    role: "agent",
    messageId: randomUUID(),
    parts: [{ kind: "data", data }],
    contextId: context.contextId,
    taskId: context.taskId,
  };
  // publish + finished(): without finished() the event stream never closes
  // and the caller hangs.
  eventBus.publish(message);
  eventBus.finished();
}
