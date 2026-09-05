import { readFileSync, statSync } from "fs";
// Marketplace data core, the single source every surface reads from.
// Surface 1 of 3 (JSON API); the web pages and MCP server consume the same
// functions. No keys, no custody, no signing, no writes: since fix 2026-09-05 (H235 option A) GET /api/verify/:id
// answers from the newest sweep record in the state and writes nothing; the sweeps (verify_live.sh, verify_loop.sh)
// are the only writers. VERIFY_ON_DEMAND=1 restores the old behaviour (probe now, spool the record under data/).
import Fastify from "fastify";
import { PORT, HOST, CATEGORIES, CHAIN_ID, RATE_LIMIT } from "./config.js";
import { CATALOG, listAgents, agentDetail, findFirstParty } from "./catalog.js";
import { liveQuote } from "./quote.js";
import { readJob } from "./chain.js";
import {
  buildCreateJobTx,
  jobIdFromTx,
  buildRegisterJobTx,
  buildFundTxs,
  buildSettleTx,
  notifyFunded,
  jobLifetimeSeconds,
} from "./hire.js";
import { renderHome, renderCategory, renderAgent, renderHire, HIRE_SCRIPT, CATEGORY_COPY } from "./pages.js";
import { startJobStats } from "./jobstats.js";
import { verifyNow, liveMap, recordFromState } from "./verify.js"; // 2026-08-24 ChainHelix Verified live layer
import { traceView, traceRows, loadTrace } from "./trace.js"; // 2026-09-03 settled hires, end to end (read-only)
import { paidCallsView, paidCallRows, loadPaidCalls } from "./paid_calls.js"; // 2026-09-05 pay-per-call purchases on record (read-only)

startJobStats();

// trustProxy: 1 - trust exactly the one nginx hop in front of us. With `true`,
// req.ip took the FIRST X-Forwarded-For entry, which the client controls, so a
// spoofed header rotated the rate-limit key per request (redteam A2). With 1,
// req.ip is the address nginx itself saw; spoofed entries are ignored.
const app = Fastify({ logger: true, trustProxy: 1 });

// Per-IP fixed-window rate limit, small, honest, no dependency.
const hits = new Map();
app.addHook("onRequest", async (req, reply) => {
  const now = Date.now();
  const e = hits.get(req.ip);
  if (!e || now > e.resetAt) {
    hits.set(req.ip, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
  } else if (++e.count > RATE_LIMIT.max) {
    // return reply - without it the hook let the request continue after the 429 (redteam A9)
    return reply.code(429).send({ error: "rate limited", retryAfterMs: e.resetAt - now });
  }
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  }
});

// Human surface, rendered from the same functions the API serves. Pages
// carry live data, so browsers must revalidate instead of serving stale HTML.
function sendPage(reply, html) {
  reply
    .type("text/html; charset=utf-8")
    .header("Cache-Control", "no-cache")
    .send(html);
}

app.get("/", async (req, reply) => {
  sendPage(reply, renderHome(await listAgents(), traceRows(loadTrace()), paidCallRows(loadPaidCalls())));
});

app.get("/c/:cat", async (req, reply) => {
  if (!CATEGORY_COPY[req.params.cat]) {
    return reply.code(404).type("text/plain").send("no such category");
  }
  sendPage(reply, renderCategory(req.params.cat, await listAgents()));
});

app.get("/a/:id", async (req, reply) => {
  const detail = await agentDetail(req.params.id);
  if (!detail) return reply.code(404).type("text/plain").send("no such agent");
  sendPage(reply, renderAgent(detail));
});

app.get("/a/:id/hire", async (req, reply) => {
  const agent = findFirstParty(req.params.id);
  if (!agent) return reply.code(404).type("text/plain").send("hiring is only wired for first-party agents");
  const detail = await agentDetail(req.params.id);
  sendPage(reply, renderHire(detail));
});

// fix 2026-09-03 H65: same-origin file for the hire page script, so the site CSP can drop
// script-src 'unsafe-inline' and keep 'self'. Served only when pages.js is in file mode
// (MARKETPLACE_HIRE_SCRIPT=file); the route exists either way so the nginx CSP change and the
// marketplace restart can be applied in one step. Static text, no live data, so it may be cached.
app.get("/assets/hire.js", async (req, reply) => {
  reply
    .type("application/javascript; charset=utf-8")
    .header("Cache-Control", "public, max-age=300")
    .send(HIRE_SCRIPT);
});

app.get("/api/health", async () => ({
  ok: true,
  chain: { id: CHAIN_ID, name: "BNB Smart Chain" },
  registry: CATALOG.registry,
}));

app.get("/api/agents", async () => {
  const { firstParty, discovered } = await listAgents();
  return {
    marketplace: "agents.chainhelix.io",
    chain: { id: CHAIN_ID, name: "BNB Smart Chain" },
    registry: CATALOG.registry,
    categories: CATEGORIES,
    agents: firstParty,
    discovered,
  };
});

app.get("/api/agents/:id", async (req, reply) => {
  const detail = await agentDetail(req.params.id);
  if (!detail) return reply.code(404).send({ error: "unknown agent id" });
  return detail;
});

// Live negotiate passthrough. GET returns a signed quote for a representative
// sample task; POST {task_description, terms} quotes the caller's own spec.
// The full envelope (negotiation_hash, provider_sig) is returned, it is what
// the buyer anchors on-chain.
async function quoteHandler(req, reply) {
  const agent = findFirstParty(req.params.id);
  if (!agent) {
    return reply
      .code(404)
      .send({ error: "quotes are only available for first-party listed agents" });
  }
  const body = req.body ?? {};
  try {
    const envelope = await liveQuote(agent, body.task_description, body.terms);
    return { agent: agent.id, envelope, taskSource: body.task_description ? "caller" : "sample", termsSource: body.terms ? "caller" : "sample" }; // fix 2026-09-02 H261
  } catch (e) {
    req.log.warn({ err: e.message }, "upstream failure"); // detail stays server-side (redteam A6: e.message leaked internal hosts/ports)
    return reply.code(502).send({ error: "agent did not return a quote" });
  }
}
app.get("/api/agents/:id/quote", quoteHandler);
app.post("/api/agents/:id/quote", quoteHandler);

// ── Hire flow ──────────────────────────────────────────────────────────────
// The buyer's own wallet signs and sends every transaction; these endpoints
// only prepare calldata and read public chain state.

const JOB_ID_RE = /^\d{1,12}$/;

// Negotiate a live quote and return the verified createJob transaction.
// fix 2026-09-02 H261: without a task_description the plan was built for the agent's SAMPLE task and the buyer
// signed a job they never asked for. The plan now requires the caller's task; HIRE_PLAN_REQUIRE_TASK=0 restores
// the fallback. The quote route keeps the sample (for display) and says so in taskSource.
const PLAN_REQUIRE_TASK = process.env.HIRE_PLAN_REQUIRE_TASK !== "0";
// fix 2026-09-05 (brief section 8b): the plan is what the buyer signs and funds. Until now a task_description
// missing a required parameter was quoted, funded and then refused by the agent, and the escrow paid for the
// refusal (jobs 56652-56655, 56680). The agent's own Job input table (catalog.json, generated from
// strategies/schema.ts, the same source the agent card and the refusal use) is checked HERE, before any quote,
// and the buyer gets the missing names and the example back with a 400. HIRE_PLAN_SCHEMA_CHECK=0 disables it.
const PLAN_SCHEMA_CHECK = process.env.HIRE_PLAN_SCHEMA_CHECK !== "0";
function specFromTask(task) {
  if (typeof task !== "string") return null;
  const a = task.indexOf("{"), b = task.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try { const o = JSON.parse(task.slice(a, b + 1)); if (o && typeof o === "object" && !Array.isArray(o)) return o; } catch { /* fall through to key=value */ }
  }
  // 2026-09-05: the key=value carrier (`k=v; k=v`, the same one strategies/parseJob.ts accepts) is a spec too
  const kv = {};
  for (const part of task.split(/[;\n]/)) { const m = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/.exec(part); if (m) kv[m[1]] = /^-?\d+(\.\d+)?$/.test(m[2]) ? Number(m[2]) : m[2]; }
  return Object.keys(kv).length ? kv : null;
}
export function checkTaskAgainstSchema(agent, task) {
  const schema = agent && agent.inputSchema;
  if (!schema || !schema.required) return { ok: true, skipped: true };
  const spec = specFromTask(task);
  if (!spec) return { ok: false, error: "task_description must carry the job spec as a JSON object (or key=value pairs); see the agent's Job input table and example", expected: schema };
  let required = Object.keys(schema.required);
  const aliases = schema.aliases || {};
  const present = (k) => (v => v !== undefined && v !== null && v !== "")(spec[k]) || (aliases[k] || []).some((a) => spec[a] !== undefined && spec[a] !== null && spec[a] !== ""); // 2026-09-05: declared aliases count
  if (agent.category === "health" && (spec.position !== undefined || (aliases.position || []).some((a) => spec[a] !== undefined))) required = []; // LP range health: position instead of collateral/debt/prices
  if (agent.category === "grid" && spec.spanPct === undefined && spec.lower !== undefined && spec.upper !== undefined) { /* lower/upper is the declared alternative to spanPct; optional anyway */ }
  const missing = required.filter((k) => !present(k));
  if (missing.length) return { ok: false, error: `task_description is missing required parameter(s): ${missing.join(", ")}; the agent would refuse this job`, missing, expected: schema };
  return { ok: true };
}
app.post("/api/agents/:id/hire/plan", async (req, reply) => {
  const agent = findFirstParty(req.params.id);
  if (!agent) return reply.code(404).send({ error: "hiring is only wired for first-party agents" });
  const body = req.body ?? {};
  if (PLAN_REQUIRE_TASK && !(typeof body.task_description === "string" && body.task_description.trim())) {
    return reply.code(400).send({ error: "task_description required: the plan encodes it into the job you sign; GET /api/agents/:id/quote shows the agent's sample task" });
  }
  if (PLAN_SCHEMA_CHECK) {
    const v = checkTaskAgainstSchema(agent, body.task_description);
    if (!v.ok) return reply.code(400).send({ error: v.error, ...(v.missing ? { missing: v.missing } : {}), expected: v.expected });
  }
  try {
    const envelope = await liveQuote(agent, body.task_description, body.terms);
    const plan = await buildCreateJobTx(
      envelope,
      agent.wallet,
      Math.floor(Date.now() / 1000)
    );
    return {
      agent: agent.id,
      envelope,
      taskSource: body.task_description ? "caller" : "sample", // fix 2026-09-02 H261
      termsSource: body.terms ? "caller" : "sample",
      schemaCheck: PLAN_SCHEMA_CHECK ? "passed" : "off", // fix 2026-09-05
      jobLifetimeSeconds: await jobLifetimeSeconds(),
      ...plan,
      next: "send tx from your wallet, then GET /api/hire/jobid?tx=<hash>",
    };
  } catch (e) {
    req.log.warn({ err: e.message }, "upstream failure"); // detail stays server-side (redteam A6: e.message leaked internal hosts/ports)
    return reply.code(502).send({ error: "could not build a hire plan" });
  }
});

app.get("/api/hire/jobid", async (req, reply) => {
  const tx = req.query.tx;
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx ?? "")) {
    return reply.code(400).send({ error: "tx=<transaction hash> required" });
  }
  try {
    const r = await jobIdFromTx(tx);
    return { ...r, next: r.jobId ? `GET /api/hire/${r.jobId}/register-tx` : undefined };
  } catch (e) {
    req.log.warn({ err: e.message }, "upstream failure"); // detail stays server-side (redteam A6: e.message leaked internal hosts/ports)
    return reply.code(502).send({ error: "chain read failed" });
  }
});

app.get("/api/hire/:jobId/register-tx", async (req, reply) => {
  if (!JOB_ID_RE.test(req.params.jobId)) return reply.code(400).send({ error: "numeric job id required" });
  return {
    tx: buildRegisterJobTx(req.params.jobId),
    next: `GET /api/hire/${req.params.jobId}/fund-txs?buyer=<your address>&amount=<price wei>`,
  };
});

app.get("/api/hire/:jobId/fund-txs", async (req, reply) => {
  const { buyer, amount } = req.query;
  if (!JOB_ID_RE.test(req.params.jobId)) return reply.code(400).send({ error: "numeric job id required" });
  if (!/^0x[0-9a-fA-F]{40}$/.test(buyer ?? "")) return reply.code(400).send({ error: "buyer=<address> required" });
  if (!/^\d{1,30}$/.test(amount ?? "")) return reply.code(400).send({ error: "amount=<price in wei> required" });
  try {
    const txs = await buildFundTxs(req.params.jobId, amount, buyer);
    return {
      txs,
      next: `send each tx in order, then POST /api/agents/<agent>/hire/notify {"job_id": ${req.params.jobId}}`,
    };
  } catch (e) {
    req.log.warn({ err: e.message }, "upstream failure"); // detail stays server-side (redteam A6: e.message leaked internal hosts/ports)
    return reply.code(502).send({ error: "chain read failed" });
  }
});

app.post("/api/agents/:id/hire/notify", async (req, reply) => {
  const agent = findFirstParty(req.params.id);
  if (!agent) return reply.code(404).send({ error: "unknown first-party agent" });
  const jobId = req.body?.job_id;
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    return reply.code(400).send({ error: "job_id (number) required" });
  }
  try {
    const ack = await notifyFunded(agent, jobId);
    return { agent: agent.id, ack, next: `poll GET /api/jobs/${jobId} until SUBMITTED` };
  } catch (e) {
    req.log.warn({ err: e.message }, "upstream failure"); // detail stays server-side (redteam A6: e.message leaked internal hosts/ports)
    return reply.code(502).send({ error: "agent did not acknowledge" });
  }
});

app.get("/api/hire/:jobId/settle-tx", async (req, reply) => {
  if (!JOB_ID_RE.test(req.params.jobId)) return reply.code(400).send({ error: "numeric job id required" });
  return {
    tx: buildSettleTx(req.params.jobId),
    note: "permissionless; succeeds once the evaluation window has passed",
  };
});


// Greenfield mirror index (marketplace/data/greenfield_deliverables.json): jobId -> { url, sha256, objectId, txHash }.
let _gnfd = { mt: 0, data: null };
function greenfieldCopy(jobId) {
  try {
    const p = new URL("../data/greenfield_deliverables.json", import.meta.url).pathname;
    const mt = statSync(p).mtimeMs;
    if (mt !== _gnfd.mt) _gnfd = { mt, data: JSON.parse(readFileSync(p, "utf8")) };
    const e = _gnfd.data && _gnfd.data.jobs && _gnfd.data.jobs[String(jobId)];
    return e ? { url: e.url, sha256: e.sha256, objectId: e.objectId, txHash: e.txHash } : null;
  } catch { return null; }
}
// ChainHelix Verified (2026-08-24, operator "map should be live"). Both routes read only public data
// (the agent's own on-chain registration and its endpoint); no wallet, no signing.
// /api/verified: the live map, alive and hireable agents only, each with ageSeconds; version = newest probe.
// Each entry also carries rung (verified / hireable / alive) and the map carries rungs, the legend (fix 2026-09-02 H73).
app.get("/api/verified", async () => liveMap());
// /api/verify/:id: the newest sweep record for this agent with its probe history (fix 2026-09-05 H235 option A:
// an unauthenticated GET no longer probes or writes; refresh happens on the sweeps, whose cadence is published in
// docs/PROBE_SPEC.md section 5). VERIFY_ON_DEMAND=1: probe now and answer as of this second, as before.
const ON_DEMAND = process.env.VERIFY_ON_DEMAND === "1";
app.get("/api/verify/:id", async (req, reply) => {
  const id = req.params.id;
  if (!/^\d{1,12}$/.test(id)) return reply.code(400).send({ error: "numeric ERC-8004 id required" });
  if (!ON_DEMAND) {
    const r = recordFromState(Number(id));
    if (!r) return reply.code(404).send({ error: "not probed yet; the sweeps reach every registration on their own cadence (docs/PROBE_SPEC.md section 5)" });
    return { id: r.id, status: r.status, reason: r.reason ?? null, endpoint: r.endpoint ?? null, ...(r.rawEndpoint ? { rawEndpoint: r.rawEndpoint } : {}), card: r.card ?? null, probedAt: r.probedAt, ageSeconds: Math.round((Date.now() - r.probedAt) / 1000), ms: r.ms ?? null, history: r.history ?? [], source: "sweep" };
  }
  try {
    const r = await verifyNow(Number(id));
    if (r.unregistered) return reply.code(404).send({ error: "no such agent on-chain" }); // fix 2026-09-02: an id with no registration is not recorded
    return { id: r.id, status: r.status, reason: r.reason, endpoint: r.endpoint, card: r.card, probedAt: r.probedAt, ms: r.ms, history: r.history };
  } catch (e) {
    req.log.warn({ err: e.message }, "verify failure");
    return reply.code(502).send({ error: "probe failed" });
  }
});
// 2026-09-03: settled hires with all four facts on record (funding tx, on-chain submission + served deliverable,
// Greenfield copy, settlement tx). Read from data/job_trace.json, written only by scripts/build_job_trace.mjs.
app.get("/api/trace", async () => traceView());
app.get("/api/paid-calls", async () => paidCallsView()); // 2026-09-05
app.get("/api/jobs/:id", async (req, reply) => {
  const id = req.params.id;
  if (!/^\d{1,12}$/.test(id)) return reply.code(400).send({ error: "numeric job id required" });
  try {
    const job = await readJob(id);
    if (!job) return reply.code(404).send({ error: "no such job on-chain" });
    // 2026-08-24: permanent copy of the deliverable on BNB Greenfield (written by an out-of-repo mirror,
    // this server only reads the index). Absent = not mirrored yet; the on-chain pointer stays the source of truth.
    job.greenfield = greenfieldCopy(id);
    return job;
  } catch (e) {
    req.log.warn({ err: e.message }, "upstream failure"); // detail stays server-side (redteam A6: e.message leaked internal hosts/ports)
    return reply.code(502).send({ error: "chain read failed" });
  }
});

app.listen({ port: PORT, host: HOST }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
