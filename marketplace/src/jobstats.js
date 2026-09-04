// All-time on-chain job history per provider, read straight from the
// commerce contract: every job id from 1 to jobCounter() is fetched once
// (paced Multicall batches), then new ids are picked up incrementally and a
// recent tail is rescanned so live jobs converge as their status changes.
// No log scans, no lookback window, no external indexer: the counts shown on
// trust panels are the full registry history and while the one-time
// backfill is still running the API says so instead of pretending.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { client, JobStatus } from "./chain.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const STATE_FILE = join(DATA_DIR, "jobstats.json");

const BATCH = 40; // jobs per multicall; descriptions can be up to 4KB each
const BATCH_DELAY_MS = 400;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SAVE_EVERY_BATCHES = 25;
const TAIL = 300; // recent jobs rescanned every sweep (status still moving)

// state.jobs maps jobId -> "provider|statusKey", making every record()
// idempotent: rescanning any id first reverses its previous contribution.
// note 2026-09-03 H253: that map holds one entry per job id ever created and is rewritten whole on every
// save (every 25 batches and again at the end of each 10-minute sweep). Measured 2026-09-03: 56,693 ids,
// 3.5 MB on disk, in a service that runs under MemoryMax=768M with the state parsed into the same heap at
// import. It cannot simply be dropped, because the reversal above needs it. If the id count or the file
// size grows materially, this is the piece to change first, and the shape to copy is verify.js, which
// writes its state in pieces instead of one JSON.stringify.
// fix 2026-09-02 H194 H251: the state was written in place (3.5 MB, no temp-and-rename) and a corrupt or partial
// file read as "first run", after which the trust panel showed total 0 with scanning FALSE. Now: per-process temp
// file and rename, an unreadable file is kept aside as <file>.corrupt-<ts> instead of being overwritten, and the
// panel says scanning until the first sweep completes. JOBSTATS_SAFE_STATE=0 restores the old behaviour.
const SAFE_STATE = process.env.JOBSTATS_SAFE_STATE !== "0";
let state = { lastJobId: 0, totalOnChain: 0, providers: {}, jobs: {}, updatedAt: null };
try {
  state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
} catch (e) {
  if (SAFE_STATE && e.code !== "ENOENT") {
    try { renameSync(STATE_FILE, `${STATE_FILE}.corrupt-${Date.now()}`); console.error("jobstats: state file unreadable, kept aside:", e.message); } catch {}
  }
  /* first run */
}

function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!SAFE_STATE) { writeFileSync(STATE_FILE, JSON.stringify(state)); return; }
  const tmp = `${STATE_FILE}.${process.pid}.tmp`; // fix 2026-09-02 H194 H251
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_FILE);
}

const STATUS_KEY = {
  [JobStatus.OPEN]: "open",
  [JobStatus.FUNDED]: "funded",
  [JobStatus.SUBMITTED]: "submitted",
  [JobStatus.COMPLETED]: "completed",
  [JobStatus.REJECTED]: "rejected",
  [JobStatus.EXPIRED]: "expired",
};

function bump(providerKey, statusKey, delta) {
  const p = (state.providers[providerKey] ??= {
    total: 0,
    open: 0,
    funded: 0,
    submitted: 0,
    completed: 0,
    rejected: 0,
    expired: 0,
    unknown: 0, // fix 2026-09-03 H195 H252
  });
  p.total += delta;
  // fix 2026-09-03 H195 H252: state files written before the unknown bucket existed have no such key, and
  // a reversal of an old entry would otherwise turn the counter into NaN.
  p[statusKey] = (p[statusKey] || 0) + delta;
}

// fix 2026-09-03 H193: getJobsBatch returns null for a per-call multicall revert AND for a decode failure
// (sdk chunk-MLBBI5CM.js: `if (!success || !decoded) return null;` then `try { return decodeJob(decoded); }
// catch { return null; }`), so a null is "no answer", not "no job". The reversal below used to run before
// the guard, which silently deleted an already-counted completed job from its provider's all-time total on
// any transient null; it came back only if the id fell inside the next sweep's 300-job tail. A null now
// leaves the previous contribution alone. A job that really carries no provider still reverses, because
// that is a real change of state. JOBSTATS_KEEP_ON_NULL=0 restores the old order.
const KEEP_ON_NULL = process.env.JOBSTATS_KEEP_ON_NULL !== "0";
// fix 2026-09-03 H195 H252: an unrecognised contract status used to be counted as "open". STATUS_KEY covers
// exactly the six JobStatus members that exist today, so this is latent, but the count would still balance
// while `completed`, the number on the trust panel, went wrong in the safe-looking direction. Unknown
// statuses now land in their own bucket and jobStatsFor surfaces it, so a gap shows as a gap.
// JOBSTATS_UNKNOWN_BUCKET=0 restores the "open" fallback.
const UNKNOWN_BUCKET = process.env.JOBSTATS_UNKNOWN_BUCKET !== "0";

function record(id, job) {
  if (KEEP_ON_NULL && !job) return; // fix 2026-09-03 H193: a failed read must not reverse a counted job
  const prev = state.jobs[id];
  if (prev) {
    const [pk, sk] = prev.split("|");
    bump(pk, sk, -1);
    delete state.jobs[id];
  }
  if (!job || !job.provider || /^0x0{40}$/i.test(job.provider)) return;
  const pk = job.provider.toLowerCase();
  const known = STATUS_KEY[Number(job.status)];
  const sk = known ?? (UNKNOWN_BUCKET ? "unknown" : "open"); // fix 2026-09-03 H195 H252
  bump(pk, sk, 1);
  state.jobs[id] = `${pk}|${sk}`;
}

async function scanRange(c, from, to) {
  let batches = 0;
  for (let start = from; start <= to; start += BATCH) {
    const end = Math.min(start + BATCH - 1, to);
    const ids = [];
    for (let i = start; i <= end; i++) ids.push(BigInt(i));
    const jobs = await c.commerce.getJobsBatch(ids);
    jobs.forEach((job, idx) => record(start + idx, job));
    if (to > state.lastJobId) state.lastJobId = Math.max(state.lastJobId, end);
    if (++batches % SAVE_EVERY_BATCHES === 0) save();
    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }
}

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const c = await client();
    const counter = Number(await c.commerce.jobCounter());
    state.totalOnChain = counter;
    // Rescan the recent tail (statuses still moving), then extend to new ids.
    const tailFrom = Math.max(1, Math.min(state.lastJobId, counter) - TAIL + 1);
    if (state.lastJobId > 0) await scanRange(c, tailFrom, Math.min(state.lastJobId, counter));
    if (state.lastJobId < counter) await scanRange(c, state.lastJobId + 1, counter);
    state.updatedAt = new Date().toISOString();
    save();
  } catch (e) {
    save();
    console.error("jobstats sweep interrupted:", e.message);
  } finally {
    sweeping = false;
  }
}

export function startJobStats() {
  setTimeout(sweep, 3000);
  setInterval(sweep, SWEEP_INTERVAL_MS);
}

export function jobStatsFor(providerWallet) {
  const p = state.providers[(providerWallet || "").toLowerCase()];
  const scanning = state.lastJobId < state.totalOnChain || (SAFE_STATE && state.updatedAt == null); // fix 2026-09-02 H194: before the first sweep the panel says so
  return {
    total: p?.total ?? 0,
    completed: p?.completed ?? 0,
    rejected: p?.rejected ?? 0,
    inProgress: (p?.funded ?? 0) + (p?.submitted ?? 0),
    ...(p?.unknown ? { unknownStatus: p.unknown } : {}), // fix 2026-09-03 H195 H252: a gap shows as a gap
    scope: "all jobs ever created on the commerce contract",
    scannedJobs: state.lastJobId,
    totalJobsOnChain: state.totalOnChain,
    ...(scanning ? { scanning: true } : {}),
  };
}
