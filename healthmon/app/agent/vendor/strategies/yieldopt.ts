/**
 * Yield-allocation strategy core; pure arithmetic, no I/O.
 *
 * Greedy fill: sort pools by risk-adjusted APY, fill each up to the
 * concentration cap (and the pool's own headroom when tvlCapPct given),
 * until capital is exhausted. Deterministic: ties broken by pool name.
 *
 * Input params:
 *   pools: [{name, apyPct, tvlUsd?, riskScore?}]   riskScore 1 (safest) .. 5
 *   capitalUsd: number
 *   maxPerPoolPct?: number       concentration cap per pool (default 40)
 *   riskAversion?: number        0 = chase raw APY, 1 = full risk discount (default 0.5)
 *   tvlCapPct?: number           max share of a pool's TVL we may be (default 5)
 *
 * Output: allocations, blended APY and what was left unallocated (caps can
 * bind before capital runs out; that residue is reported, never hidden).
 */
import { InputError, nonNeg, pos } from "./parseJob.js";

type Pool = { name: string; apyPct: number; tvlUsd: number | null; riskScore: number };

export function yieldOpt(params: Record<string, unknown>): Record<string, unknown> {
  const poolsRaw = params.pools;
  if (!Array.isArray(poolsRaw) || poolsRaw.length === 0) {
    throw new InputError("pools must be a non-empty array of {name, apyPct, tvlUsd?, riskScore?}");
  }
  const capital = pos(params.capitalUsd, "capitalUsd");
  const maxPerPoolPct = params.maxPerPoolPct === undefined ? 40 : pos(params.maxPerPoolPct, "maxPerPoolPct");
  if (maxPerPoolPct > 100) throw new InputError("maxPerPoolPct must be <= 100");
  const riskAversion = params.riskAversion === undefined ? 0.5 : nonNeg(params.riskAversion, "riskAversion");
  if (riskAversion > 1) throw new InputError("riskAversion must be in [0, 1]");
  const tvlCapPct = params.tvlCapPct === undefined ? 5 : pos(params.tvlCapPct, "tvlCapPct");

  const pools: Pool[] = poolsRaw.map((p, i) => {
    if (p === null || typeof p !== "object") throw new InputError(`pools[${i}] must be an object`);
    const rec = p as Record<string, unknown>;
    const name = String(rec.name ?? "");
    if (!name) throw new InputError(`pools[${i}].name is required`);
    const risk = rec.riskScore === undefined ? 3 : nonNeg(rec.riskScore, `pools[${i}].riskScore`);
    if (risk < 1 || risk > 5) throw new InputError(`pools[${i}].riskScore must be in [1, 5]`);
    return {
      name,
      apyPct: nonNeg(rec.apyPct, `pools[${i}].apyPct`),
      tvlUsd: rec.tvlUsd === undefined ? null : pos(rec.tvlUsd, `pools[${i}].tvlUsd`),
      riskScore: risk,
    };
  });
  const names = new Set(pools.map((p) => p.name));
  if (names.size !== pools.length) throw new InputError("pool names must be unique");

  // risk-adjusted score: linear discount, riskScore 1 keeps full APY at any
  // aversion; riskScore 5 keeps (1 - riskAversion) of it.
  const scored = pools
    .map((p) => ({
      ...p,
      adjApyPct: p.apyPct * (1 - riskAversion * ((p.riskScore - 1) / 4)),
    }))
    .sort((a, b) => b.adjApyPct - a.adjApyPct || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // byte-wise tie-break: localeCompare was locale-sensitive, breaking cross-machine determinism (redteam A3)

  const capPerPool = capital * (maxPerPoolPct / 100);
  let remaining = capital;
  const allocations: Array<Record<string, unknown>> = [];
  let blended = 0;
  for (const p of scored) {
    if (remaining <= 0.01) break;
    const tvlHeadroom = p.tvlUsd === null ? Infinity : p.tvlUsd * (tvlCapPct / 100);
    // fix 2026-09-03 H38 H287: capBound below was chosen by exact === against two of the
    // three inputs to Math.min. Two failure modes, both in the field a buyer reads to decide
    // which cap to raise: when `remaining` equals `capPerPool` the allocation was bound by
    // BOTH and the label said "concentration", telling the buyer to raise maxPerPoolPct when
    // there is no capital left to use; and `remaining` accumulates float error through
    // repeated subtraction, so after the first pool it can miss an equality it should hit and
    // fall through to "capital". Decide the label from the argmin with a tolerance, and when
    // two constraints bind together name the one the buyer cannot raise by config: capital.
    const allocParts = [
      { label: "capital", v: remaining },
      { label: "concentration", v: capPerPool },
      { label: "tvl", v: tvlHeadroom },
    ];
    const alloc = Math.min(remaining, capPerPool, tvlHeadroom);
    const tol = Math.max(1e-9, Math.abs(alloc) * 1e-12);
    const binding = allocParts.filter((x) => Math.abs(x.v - alloc) <= tol).map((x) => x.label);
    if (alloc < 0.01) continue;
    remaining -= alloc;
    blended += alloc * p.apyPct;
    allocations.push({
      pool: p.name,
      allocUsd: round(alloc),
      allocPct: round((alloc / capital) * 100),
      apyPct: p.apyPct,
      riskScore: p.riskScore,
      riskAdjApyPct: round(p.adjApyPct),
      capBound: binding.includes("capital")
        ? "capital"
        : binding.includes("concentration")
          ? "concentration"
          : "tvl",
      // fix 2026-09-03 H38 H287: every constraint that binds, not just the first match.
      capBoundAll: binding,
    });
  }

  const allocated = capital - remaining;
  return {
    capitalUsd: capital,
    allocatedUsd: round(allocated),
    unallocatedUsd: round(remaining),
    blendedApyPct: allocated > 0 ? round(blended / allocated) : 0,
    riskAversion,
    maxPerPoolPct,
    tvlCapPct,
    allocations,
    note:
      remaining > 0.01
        ? "caps bound before capital ran out; raise maxPerPoolPct/tvlCapPct or add pools to deploy the remainder"
        : "fully deployed",
  };
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
