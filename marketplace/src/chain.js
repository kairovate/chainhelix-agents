// Read-only chain access via the studio SDK (resolved from the workspace
// root node_modules). No wallet is ever constructed here, reads work, writes
// are impossible by construction.
import { createRequire } from "module";
import { NETWORK, BSCSCAN, TTL } from "./config.js";
import { CATALOG } from "./catalog.js";
import { cached } from "./cache.js";

const require = createRequire(import.meta.url);
const sdk = require("@bnbagent/sdk");

let clientPromise = null;
export function client() {
  if (!clientPromise) clientPromise = sdk.ERC8183Client.create({ network: NETWORK });
  return clientPromise;
}

export const JobStatus = sdk.JobStatus;


import { existsSync } from "fs";
// Directory where first-party agents publish deliverables (set on the service; empty disables the fallback).
const DELIVERABLE_DIR = process.env.DELIVERABLE_DIR || "";
function firstPartyDeliverable(provider, jobId) {
  try {
    const agent = (CATALOG.agents || []).find((a) => a.wallet && provider && a.wallet.toLowerCase() === String(provider).toLowerCase());
    if (!agent || !DELIVERABLE_DIR) return null;
    if (!existsSync(`${DELIVERABLE_DIR}/erc8183-job-${Number(jobId)}.json`)) return null;
    return `https://agents.chainhelix.io/${agent.id}/erc8183/job/${Number(jobId)}/response`;
  } catch { return null; }
}
export async function readJob(jobId) {
  return cached(`job:${jobId}`, TTL.job, async () => {
    const c = await client();
    const id = BigInt(jobId);
    const job = await c.getJob(id);
    if (!job || !job.client || /^0x0{40}$/i.test(job.client)) return null;
    const status = Number(job.status ?? (await c.getJobStatus(id)));
    let deliverableUrl = null;
    if (status >= sdk.JobStatus.SUBMITTED) {
      deliverableUrl = await c.getDeliverableUrl(id).catch(() => null);
      // 2026-08-24: the SDK resolves the URL from JobInitialised logs inside a recent block window, so a
      // job older than that window comes back null. For our own agents the deliverable is the file the
      // agent published (served at /<agent>/erc8183/job/<id>/response); if it exists, point at it.
      if (!deliverableUrl) deliverableUrl = firstPartyDeliverable(job.provider, jobId);
    }
    return {
      id: Number(jobId),
      status,
      statusName: sdk.JobStatus[status] ?? String(status),
      client: job.client,
      provider: job.provider,
      deliverableUrl,
      links: {
        clientOnBscscan: `${BSCSCAN}/address/${job.client}`,
        providerOnBscscan: `${BSCSCAN}/address/${job.provider}`,
      },
    };
  });
}
