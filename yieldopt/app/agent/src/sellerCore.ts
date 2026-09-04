/**
 * Seller core: the a2a-free seller logic + background delivery machinery.
 *
 * This is the protocol-neutral heart of the ERC-8183 seller: the two fixed-code
 * operations (`negotiate` → signed quote; `notifyFunded` → verify → ACK →
 * deliver in the background) plus the background-delivery bookkeeping
 * (`isBusy`, the spawn/run/sweep helpers). It imports NOTHING from
 * `@a2a-js/sdk` so it can back any transport, the A2A executor
 * (`executor.ts`) inherits it and wraps it with the a2a wire, and a non-A2A
 * HTTP entrypoint can call it directly without dragging in the a2a sdk.
 *
 *     negotiate    → `signing.signQuote` (rule-based price clamp + EIP-191 sign)
 *     notifyFunded → `signing.verifySignedJob` (fast on-chain gate) → ACK at
 *                    once, then in the BACKGROUND: the `runWork` hook (deterministic
 *                    strategy math in the four listed agents) → `signing.submitResult`
 *
 * `notifyFunded` is the buyer's "I funded job X, please deliver" notification.
 * Because the work takes time, it does NOT block the caller: it verifies the
 * funded job synchronously (a couple of eth_calls) to ACK accepted/rejected,
 * then runs the slow work + on-chain `submit` in a background task and
 * returns immediately. The buyer reads the deliverable back from the CHAIN
 * (SUBMITTED / `getDeliverableUrl`), the chain is the source of truth. While
 * any background delivery is in flight {@link SellerCore.isBusy} reports busy,
 * which the transport feeds to AgentCore's `/ping` as `HEALTHY_BUSY` so the
 * scale-to-zero runtime stays warm until the work lands (within the session
 * max-lifetime).
 *
 * ALL signing is FIXED code in `signing.ts`, never callable by any model or
 * tool; the deliverable text comes only from the `runWork` hook. On each
 * notification the core also opportunistically sweeps
 * OTHER funded jobs assigned to this provider, the buyer-push fallback for
 * jobs whose buyer funded on-chain but never sent `notify_funded` (deduped
 * against in-flight jobs). Negotiate stays sweep-free so quotes are fast. A
 * periodic Lambda poller, which also covers the scale-to-zero cold window
 * when no one is invoking, is the v2 robust path.
 *
 * You own this file: specialise the work hook or the dispatch, but keep signing out
 * of any tool list a model can reach.
 */

import { ERC8183JobOps } from "@bnbagent/sdk/erc8183";
import { SubmitPermanentlyUnsupportedError } from "@bnbagent/studio-runtime/erc8183";
import { getWallet } from "@bnbagent/studio-runtime/wallet";
import * as defaultSigning from "./signing.js";

const log = {
  info: (msg: string) => console.log(`[seller-agent.core] ${msg}`),
  warn: (msg: string) => console.warn(`[seller-agent.core] WARNING ${msg}`),
  error: (msg: string, e?: unknown) =>
    console.error(`[seller-agent.core] ERROR ${msg}`, e ?? ""),
};

/** Read a positive timeout (seconds) from the env, falling back to `dflt`. */
function envSeconds(name: string, dflt: number): number {
  const v = Number(process.env[name] || dflt);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

// Background-task ceilings. notifyFunded ACKs immediately and delivers in a
// BACKGROUND task; AgentCore keeps the scale-to-zero microVM warm
// (HEALTHY_BUSY) while isBusy() is true. A delivery (work + on-chain
// submit + IPFS pin) normally finishes in ~1-2 min, so these caps sit far
// above real work and only fire on a HANG (e.g. an unresponsive RPC),
// without them a hung task keeps the VM pinned to its 8h max-lifetime,
// billing memory the whole time. A timed-out job is treated as TRANSIENT
// (not dropped): the funded job stays on-chain and a later sweep re-delivers
// it idempotently. (Read lazily so tests can tune them via the env.)
const jobDeliveryTimeoutSeconds = () =>
  envSeconds("NOTIFY_DELIVERY_TIMEOUT_SECONDS", 600);
const sweepTimeoutSeconds = () => envSeconds("NOTIFY_SWEEP_TIMEOUT_SECONDS", 60);
const preverifyTimeoutSeconds = () =>
  envSeconds("NOTIFY_PREVERIFY_TIMEOUT_SECONDS", 30);

/** Rejection raised by {@link withTimeout} when the deadline fires. */
export class DeliveryTimeoutError extends Error {}

/**
 * Race `work` against a deadline, aborting `controller` when it fires.
 *
 * JS cannot hard-cancel an arbitrary promise the way asyncio.wait_for cancels a
 * coroutine. The on-chain layers are idempotent, which is what makes an orphaned
 * straggler safe: `verifySignedJob` returns non-OK for an already-SUBMITTED job and
 * `submitResult` re-verifies FUNDED, so a leaked call can never double-deliver.
 *
 * fix 2026-09-03 H159 H268: read the deadline for what it is. It frees the CALLER,
 * not the work. `controller` is optional and the two callers that omit it, the
 * pre-verify in notifyFunded and the pendingJobs scan in sweep, cannot use one:
 * `SigningApi.verifySignedJob(jobId)` takes no signal and the runtime function it
 * wraps has no abort path, so passing a controller there would abort nothing. That
 * was measured: with a 1 s pre-verify deadline against a 2.5 s verify, the ack
 * returned after 1002 ms and the verify call still ran to completion 3 s later.
 * The leaked RPC is therefore inherent to the layer below, not a missing argument,
 * and what actually bounds the amplification is the single-flight sweep gate
 * (AGENT_SWEEP_SINGLE_FLIGHT), not this deadline.
 */
async function withTimeout<T>(
  work: Promise<T>,
  seconds: number,
  controller?: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new DeliveryTimeoutError(`timed out after ${seconds}s`));
    }, seconds * 1000);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The work hook: produce the deliverable text for a prompt.
 *
 * fix 2026-09-03 H116: this doc described a build that does not ship. In the four
 * listed agents the hook is `makeRunWork(<category>)` from `vendor/strategies`, fixed
 * strategy math with no model in the loop, built in `unifiedMain.ts`, and `buildRunWork`
 * discards the options object, so `abortSignal` is accepted by the type and is NOT
 * wired to anything. It stays in the signature because a hook that CAN honour
 * cancellation is still the right contract; do not read it as a cancellation guarantee.
 * Called by verified ERC-8183 delivery and, through the runtime adapter, by x402 only
 * after its commerce gate.
 */
export type RunWork = (
  prompt: string,
  opts: { sessionId: string; abortSignal?: AbortSignal },
) => Promise<string>;

/** The `signing.ts` surface the core drives (injectable for tests). */
export interface SigningApi {
  listPrice(): bigint;
  clampPrice(proposedWei: bigint): bigint;
  signQuote(
    request: Record<string, unknown>,
    clampedPriceWei: bigint,
  ): Promise<Record<string, unknown>>;
  verifySignedJob(
    jobId: number,
  ): Promise<{ ok: boolean; reason: string; permanent: boolean }>;
  jobSpec(
    jobId: number,
  ): Promise<{ task: string; terms: Record<string, unknown> } | null>;
  submitResult(
    jobId: number,
    responseContent: string,
    metadata?: Record<string, unknown> | null,
  ): Promise<{ submitTx: string; deliverableUrl: string | null }>;
}

/** Pending-job scanner used by the sweep (injectable for tests). */
export type PendingJobsFetcher = (
  network: string,
) => Promise<Record<string, unknown>>;

const defaultPendingJobs: PendingJobsFetcher = async (network) => {
  const ops = await ERC8183JobOps.create({
    walletProvider: getWallet(),
    network,
  });
  return (await ops.getPendingJobs()) as Record<string, unknown>;
};

export interface SellerCoreOpts {
  runWork: RunWork;
  generator: string;
  network?: string | null;
  /** Whether the project configured the ERC-8183 commerce rail. */
  commerceSkills?: boolean;
  /** Test seam: replace the signing module (default: `./signing.js`). */
  signing?: SigningApi;
  /** Test seam: replace the sweep's pending-job scan. */
  pendingJobs?: PendingJobsFetcher;
}

/**
 * ERC-8183 seller core: negotiate + notifyFunded, backed by signing.ts.
 *
 * `runWork(prompt, { sessionId })` is the work hook (built in
 * `unifiedMain.ts`; deterministic strategy math in the four listed agents);
 * it is called inside the background delivery (`notifyFunded` →
 * `doWorkAndSubmit`) to produce the deliverable text.
 *
 * The core exposes ONLY the two paid, structured operations, there is no
 * free-form chat operation. The transport is responsible for routing a
 * request to {@link negotiate} / {@link notifyFunded}; a request that names
 * no structured operation must never trigger work or a paid action.
 */
export class SellerCore {
  protected readonly runWork: RunWork;
  protected readonly generator: string;
  protected readonly network: string;
  protected readonly signing: SigningApi;
  private readonly commerceSkills: boolean;
  private readonly pendingJobs: PendingJobsFetcher;
  // Background delivery bookkeeping (see notifyFunded / isBusy):
  //  tasks:    live background promises (busy-status source).
  //  inflight: job ids in flight OR already terminally handled this
  //             process (notify/sweep dedup; retained on success so a
  //             slower sweep never re-delivers a just-submitted job).
  private readonly tasks = new Set<Promise<void>>();
  private readonly inflight = new Set<number>();
  // fix 2026-09-03 H158 H114: the retention above is deliberate and is NOT changed
  // to clear on success (that reopened the redelivery race). What is added is a cap,
  // so the set cannot grow for the whole life of a long-running service. A Set keeps
  // insertion order, so dropping from the front evicts the OLDEST terminal ids, which
  // are the ones a sweep can no longer redeliver anyway (the chain gate rejects an
  // already-SUBMITTED job). Measured today: flat at about 160 MB, NRestarts=0 over
  // 8d19h, so this is a bound on a latent property, not a live leak.
  // AGENT_INFLIGHT_MAX=0 restores the unbounded set.
  private readonly inflightMax = Number(process.env.AGENT_INFLIGHT_MAX ?? 10000);

  private rememberInflight(jobId: number): void {
    this.inflight.add(jobId);
    if (this.inflightMax <= 0) return;
    while (this.inflight.size > this.inflightMax) {
      const oldest = this.inflight.values().next();
      if (oldest.done) break;
      this.inflight.delete(oldest.value);
    }
  }
  // fix 2026-09-02 H113: one funded-job sweep in flight at a time (see spawnSweep).
  private sweepInFlight = false;

  constructor(opts: SellerCoreOpts) {
    this.runWork = opts.runWork;
    this.generator = opts.generator;
    // fix 2026-09-03 H269: the default was the literal "bsc-testnet", so a caller that
    // built a core without a network swept TESTNET for pending jobs while the agent is
    // registered and funded on mainnet, and found nothing without ever erroring. Take
    // the network from studio.toml instead, which is the same source the quote
    // signature binds to. AGENT_NETWORK_FROM_CONFIG=0 restores the testnet literal.
    this.network =
      opts.network ??
      (process.env.AGENT_NETWORK_FROM_CONFIG === "0"
        ? "bsc-testnet"
        : defaultSigning.defaultNetworkName());
    this.signing = opts.signing ?? defaultSigning;
    this.commerceSkills = opts.commerceSkills ?? true;
    this.pendingJobs = opts.pendingJobs ?? defaultPendingJobs;
  }

  /**
   * True while any background delivery is in flight.
   *
   * The transport feeds this to AgentCore's `/ping` (`HEALTHY_BUSY` when
   * busy) so the scale-to-zero runtime is not reaped on idle while work runs.
   */
  isBusy(): boolean {
    return this.tasks.size > 0;
  }

  /** Await every in-flight background task (test helper, not on the wire). */
  async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }

  // ── skills ──────────────────────────────────────────────────────────────

  /**
   * Rule-based quote to an SDK `NegotiationResult` envelope; no model prices anything.
   *
   * The price is the FIXED list price from studio.toml, clamped to
   * `[min,max]` BEFORE signing, a misconfigured or hostile request can
   * never sign out of bounds. The buyer parses this envelope verbatim and
   * anchors it on-chain via `createJob` + `fund`.
   */
  async negotiate(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.requireCommerceRail();
    let request = data.request;
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      const picked: Record<string, unknown> = {};
      for (const k of ["task_description", "terms"]) {
        if (k in data) picked[k] = data[k];
      }
      request = picked;
    }
    const clamped = this.signing.clampPrice(this.signing.listPrice());
    return this.signing.signQuote(request as Record<string, unknown>, clamped);
  }

  /** The seller's two advertised skills. */
  skills(): string[] {
    return this.commerceSkills ? ["negotiate", "notify_funded"] : [];
  }

  /**
   * Buyer notification: "I funded job X, please deliver."
   *
   * Verify the funded job synchronously (a couple of eth_calls) to ACK
   * accepted/rejected at once, then run the slow work + on-chain
   * `submit` in a BACKGROUND task and return IMMEDIATELY. The buyer reads
   * the deliverable back from the CHAIN (SUBMITTED / `getDeliverableUrl`),
   * the chain is the source of truth (see erc8183-buyer-push.md).
   *
   * An accepted notification also kicks a background sweep (deduped against
   * in-flight jobs), so a buyer that funded but forgot to notify is still
   * served while we're warm. A rejected / malformed notification spawns
   * nothing.
   */
  async notifyFunded(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.requireCommerceRail();
    const raw = data.job_id;
    const strictIds = process.env.AGENT_JOBID_STRICT !== "0";
    if (
      raw === undefined ||
      raw === null ||
      (strictIds ? String(raw).trim() === "" : String(raw) === "")
    ) {
      this.spawnSweep(); // bare notify → just scan stragglers
      // fix 2026-09-02 H113: a request that names no job is not "accepted";
      // say so, while the straggler scan still runs (single-flight).
      if (process.env.AGENT_SWEEP_SINGLE_FLIGHT !== "0") {
        return {
          status: "rejected",
          error: "job_id is required",
          note: "a funded-job scan runs in the background; fund the job on chain, then send notify_funded with its job_id",
        };
      }
      return {
        status: "accepted",
        note: "no job_id; scanning funded jobs in the background; poll the chain for results",
      };
    }
    let jobId: number;
    try {
      jobId = parseJobId(raw);
    } catch {
      return { status: "rejected", error: `invalid job_id: ${JSON.stringify(raw)}` };
    }
    let verified = false;
    try {
      // Time-bounded: a hung RPC must not stall the ack path. On timeout we
      // fall through to accept-and-re-verify below.
      const v = await withTimeout(
        this.signing.verifySignedJob(jobId),
        preverifyTimeoutSeconds(),
      );
      if (!v.ok && v.permanent) {
        return { status: "rejected", job_id: jobId, reason: v.reason };
      }
      verified = v.ok;
    } catch (e) {
      // pre-verify is best-effort; the background delivery re-verifies
      log.warn(
        `pre-verify of job ${jobId} failed (${e instanceof Error ? e.message : e}); accepting, will re-verify in background`,
      );
    }
    this.spawnJob(jobId, { verified });
    this.spawnSweep(); // straggler fallback alongside the named job
    return {
      status: "accepted",
      job_id: jobId,
      note: "delivery started; poll the chain (SUBMITTED / get_deliverable_url) for the result",
    };
  }

  // ── background delivery ──────────────────────────────────────────────────

  /** Run `work` as a tracked background task (keeps {@link isBusy} true). */
  protected spawn(work: () => Promise<void>): void {
    const task = work().catch((e) => {
      // a background task must never crash the process
      log.error("background task failed", e);
    });
    this.tasks.add(task);
    task.finally(() => this.tasks.delete(task));
  }

  /**
   * fix 2026-09-02 H113: run the funded-job sweep as a single-flight task.
   * Every notification used to spawn its own `getPendingJobs()` chain scan
   * (five bare notifies = five scans, each a tracked task), which made the
   * unauthenticated notify path an RPC amplifier. While a sweep is running a
   * new request joins it instead of starting another. AGENT_SWEEP_SINGLE_FLIGHT=0
   * restores one scan per notification.
   */
  private spawnSweep(): void {
    if (process.env.AGENT_SWEEP_SINGLE_FLIGHT === "0") {
      this.spawn(() => this.sweep());
      return;
    }
    if (this.sweepInFlight) return;
    this.sweepInFlight = true;
    this.spawn(() =>
      this.sweep().finally(() => {
        this.sweepInFlight = false;
      }),
    );
  }

  /**
   * Background-deliver `jobId` once, deduped against in-flight jobs.
   *
   * `inflight` is updated SYNCHRONOUSLY here (before scheduling) so a
   * concurrent notify + sweep can never double-deliver the same job.
   */
  private spawnJob(jobId: number, opts: { verified: boolean }): void {
    if (this.inflight.has(jobId)) return;
    // fix 2026-09-03 H158 H114: bounded retention, see rememberInflight.
    this.rememberInflight(jobId);
    this.spawn(() => this.runJob(jobId, opts));
  }

  /**
   * Background runner: deliver one job, log the outcome, free the slot.
   *
   * `verified` jobs (pre-verified in `notifyFunded`) skip straight to the
   * work; unverified ones (the sweep) run the full verify gate first.
   */
  private async runJob(
    jobId: number,
    { verified }: { verified: boolean },
  ): Promise<void> {
    let terminal = false;
    const controller = new AbortController();
    try {
      // Hard ceiling so a hung delivery (e.g. unresponsive RPC) cannot keep
      // isBusy() true, which would pin the microVM to its 8h max-lifetime.
      // A timeout is TRANSIENT: terminal stays false, the slot is freed, and
      // the funded job is re-delivered idempotently by a later sweep.
      const result = await withTimeout(
        verified
          ? this.doWorkAndSubmit(jobId, controller.signal)
          : this.fulfillJob(jobId, controller.signal),
        jobDeliveryTimeoutSeconds(),
        controller,
      );
      log.info(`notify_funded job ${jobId} → ${JSON.stringify(result)}`);
      // A terminal outcome (delivered, or a permanent skip) must STAY in
      // `inflight`: keeping it lets the dedup gate in spawnJob reject a
      // slower concurrent sweep that still sees this job as FUNDED, so the
      // just-submitted job is never re-delivered. Clearing on success
      // reopened that race, the sweep re-ran the work and then failed the
      // on-chain FUNDED gate (Job status is SUBMITTED). Only transient
      // failures fall through to delete so a later sweep can retry them.
      terminal = Boolean(result.ok || result.skip);
    } catch (e) {
      if (e instanceof DeliveryTimeoutError) {
        // Transient by design, leave terminal false so a later sweep retries.
        log.warn(
          `background delivery of job ${jobId} timed out after ${jobDeliveryTimeoutSeconds()}s; will retry`,
        );
      } else {
        log.error(`background delivery of job ${jobId} failed`, e);
      }
    } finally {
      if (!terminal) {
        this.inflight.delete(jobId);
      }
    }
  }

  private requireCommerceRail(): void {
    if (!this.commerceSkills) {
      throw new Error("8183 rail disabled");
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Verify the signed deal on-chain, then deliver (the sweep's per-job worker).
   *
   * VERIFY before working: confirm the funded job carries the exact quote
   * THIS agent signed (ecrecover + budget ≥ price). A permanent failure
   * (not our signature, tampered terms, underfunded, expired) returns
   * `skip: true`; a transient one returns `ok: false` to retry.
   */
  private async fulfillJob(
    jobId: number,
    abortSignal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const v = await this.signing.verifySignedJob(jobId);
    if (!v.ok) {
      return { ok: false, job_id: jobId, skip: v.permanent, reason: v.reason };
    }
    return this.doWorkAndSubmit(jobId, abortSignal);
  }

  /**
   * Work → sign + submit. Assumes `jobId` is already verified.
   *
   * DEVELOPER HOOK: `runWork` produces the deliverable text; specialise it
   * for your seller. A throw out of `runWork` (an internal error, never a
   * buyer input error, see vendor/strategies/dispatch.ts) propagates to
   * `runJob`, which leaves the job unsubmitted for a later sweep to retry
   * instead of settling the error as a delivery.
   * `signing.submitResult` re-runs the SDK `verifyJob`
   * (defense in depth) and THROWS on a failed submit, so an `ok: true`
   * result always carries a landed tx hash.
   */
  protected async doWorkAndSubmit(
    jobId: number,
    abortSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const spec = await this.signing.jobSpec(jobId);
    const task =
      spec !== null
        ? JSON.stringify({ task: spec.task, terms: spec.terms })
        : `job ${jobId}`;
    const prompt =
      "You accepted and were paid for the following job. Produce the " +
      "deliverable now. Be complete and self-contained.\n\n" +
      `JOB CONTEXT:\n${task}`;
    const work = await this.runWork(prompt, {
      sessionId: String(jobId),
      abortSignal,
    });

    let res: { submitTx: string; deliverableUrl: string | null };
    try {
      res = await this.signing.submitResult(jobId, work, {
        job_id: jobId,
        generator: this.generator,
        built_with: "https://github.com/bnb-chain/bnbagent-studio",
      });
    } catch (e) {
      if (
        e instanceof SubmitPermanentlyUnsupportedError ||
        (e instanceof Error && e.name === "SubmitPermanentlyUnsupportedError")
      ) {
        // Deterministic for this wallet kind: submit can NEVER succeed →
        // permanent skip (a transient error would burn one work run and a retry).
        return { ok: false, job_id: jobId, skip: true, reason: e.message };
      }
      throw e;
    }
    return {
      ok: true,
      job_id: jobId,
      tx_hash: res.submitTx,
      deliverable_url: res.deliverableUrl,
    };
  }

  /**
   * Best-effort background fallback: deliver any FUNDED jobs for this
   * provider.
   *
   * Catches jobs whose buyer funded on-chain but never sent `notify_funded`.
   * Each job is handed to `spawnJob` (deduped against in-flight jobs, so a
   * concurrent notify never double-delivers); `verifySignedJob` returns
   * non-OK for an already-SUBMITTED job (idempotent, no state file). Errors
   * here are logged and never surface to the caller.
   */
  private async sweep(): Promise<void> {
    let pending: Record<string, unknown>;
    try {
      // Time-bounded: a hung scan would otherwise keep isBusy() true (it
      // runs on every notify) and pin the microVM to its 8h max-lifetime.
      pending = await withTimeout(
        this.pendingJobs(this.network),
        sweepTimeoutSeconds(),
      );
    } catch (e) {
      // the sweep is best-effort (incl. timeouts)
      log.warn(`funded-job sweep failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    const jobs = Array.isArray(pending?.jobs) ? pending.jobs : [];
    for (const job of jobs) {
      const jid =
        job !== null && typeof job === "object" && !Array.isArray(job)
          ? (job as Record<string, unknown>).jobId
          : undefined;
      if (jid === undefined || jid === null) continue;
      try {
        this.spawnJob(parseJobId(jid), { verified: false });
      } catch {
        // unparseable id: skip
      }
    }
  }
}

/** Normalise an envelope `job_id` (`0x..` / decimal string / number) to int. */
export function parseJobId(raw: unknown): number {
  // fix 2026-09-02 H12: `Number(BigInt(x))` silently truncated ids above 2^53
  // and accepted negative ids; the id is the in-flight dedup key and the
  // argument to every signing-layer call, so reject both instead.
  // AGENT_JOBID_STRICT=0 restores the old conversion.
  let big: bigint;
  if (typeof raw === "number" && Number.isInteger(raw)) big = BigInt(raw);
  else if (typeof raw === "bigint") big = raw;
  // BigInt() parses both `0x..` hex and decimal strings, and throws on junk.
  else big = BigInt(String(raw).trim());
  if (
    process.env.AGENT_JOBID_STRICT !== "0" &&
    (big < 0n || big > BigInt(Number.MAX_SAFE_INTEGER))
  ) {
    throw new RangeError(`job_id out of range: ${big.toString()}`);
  }
  return Number(big);
}
