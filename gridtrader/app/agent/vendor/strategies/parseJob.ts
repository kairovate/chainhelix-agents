/**
 * Deterministic job-input parsing shared by all four seller agents.
 *
 * The seller runtime hands runWork a prompt whose tail embeds the on-chain
 * job spec as JSON: `JOB CONTEXT:\n{"task": ..., "terms": ...}`. The x402
 * lane hands the raw buyer prompt instead. Both paths land here: extract the
 * first JSON object found, else treat the whole prompt as JSON, else fail
 * with a structured error the buyer can act on. No LLM anywhere.
 */

export type JobInput = {
  task: string;
  params: Record<string, unknown>;
};

export type ParseFail = { error: string; hint: string };

export function parseJobInput(prompt: string): JobInput | ParseFail {
  const raw = extractJson(prompt);
  if (raw === null) {
    return {
      error: "no JSON job input found in request",
      hint: 'send {"task": "<description>", "params": {...}}; see the agent card for the per-category params schema',
    };
  }
  const task = typeof raw.task === "string" ? raw.task : "";
  // params may arrive at top level, under params or inside ERC-8183 terms
  const fromTerms =
    raw.terms && typeof raw.terms === "object"
      ? (raw.terms as Record<string, unknown>)
      : {};
  const fromParams =
    raw.params && typeof raw.params === "object"
      ? (raw.params as Record<string, unknown>)
      : {};
  // The chain anchors only `task` + the signed quote terms; buyer-side strategy
  // params in the negotiate request never reach delivery. Protocol-conformant
  // carrier: the task string ITSELF holds the job spec as JSON; parse and merge
  // it. Key-collision precedence, lowest to highest (spread order below):
  // task-embedded JSON < terms < params < other top-level keys (redteam A9:
  // this comment previously understated that top-level keys win over params).
  // fix 2026-09-03 H93: that order means an unsigned `params` block and unsigned top-level
  // keys both override the on-chain-anchored `terms`. Measured: terms prices BTC 60000 with
  // params prices BTC 1 delivers portfolioUsd 1, and a top-level prices BTC 7 beats params.
  // It is safe in shipped code because NOTHING builds a prompt that mixes the two:
  // sellerCore's only ERC-8183 producer emits JSON.stringify({task, terms}) from one on-chain
  // string, with no params and no top-level keys, and the x402 path has the buyer supply the
  // whole prompt with no counterparty terms to override. A future prompt builder that appends
  // buyer-supplied params beside on-chain terms would make the signed terms advisory. If one
  // is ever written, change this order first; do not rely on the caller.
  // fix 2026-09-02 H68: a task string in `key=value; key=value` form (the
  // carrier the one outside buyer used, job 56680) is parsed too, so the
  // buyer gets a refusal naming the expected keys, not "no JSON job input".
  const fromTask = extractJson(task) ?? parseKeyValues(task);
  return { task, params: { ...fromTask, ...fromTerms, ...fromParams, ...topLevel(raw) } };
}

/**
 * `key=value` pairs separated by `;` or newlines -> params. Numeric values
 * become numbers, everything else stays a string. Non-matching parts are
 * ignored, so a plain sentence yields {}.
 */
export function parseKeyValues(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of text.split(/[;\n]/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/.exec(part);
    if (m === null) continue;
    const v = m[2];
    out[m[1]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}

function topLevel(raw: Record<string, unknown>): Record<string, unknown> {
  const skip = new Set(["task", "terms", "params"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!skip.has(k)) out[k] = v;
  return out;
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  // walk balanced braces from the first '{'; the job context is the first
  // (and in practice only) JSON object in the prompt
  let depth = 0;
  let inStr = false;
  let esc = false;
  // fix 2026-09-03 H281: the scan ran to the end of the string when the braces never
  // balanced, with no cap of its own; the only bounds were upstream and they disagreed
  // (the proxy caps a request at 64k, the direct port used to allow 8mb). Measured cost of
  // the worst input at each: 4ms at 64k, 65ms at 8mb, linear with no backtracking, so this
  // is a missing cap rather than a hazard. Cap it here so the engine does not depend on a
  // caller's limit. STRATEGY_MAX_PROMPT sets the byte budget (default 1 MB, which is the
  // agent's own AGENT_MAX_BODY default); 0 removes the cap.
  const maxScan = Number(process.env.STRATEGY_MAX_PROMPT ?? 1_048_576);
  const stop = maxScan > 0 ? Math.min(text.length, start + maxScan) : text.length;
  for (let i = start; i < stop; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Kill switches for the 2026-09-02 strategy-core fixes. Default ON; set the
 * variable to "0" to restore the previous behaviour.
 *   STRATEGY_STRICT_INPUT=0        blank strings parse as 0 again, duplicate
 *                                  symbol keys and mixed LP + lending specs pass
 *   STRATEGY_SYMBOL_AGGREGATION=0  health solves liquidation per row again
 */
export function strictInput(): boolean {
  return process.env.STRATEGY_STRICT_INPUT !== "0";
}
export function symbolAggregation(): boolean {
  return process.env.STRATEGY_SYMBOL_AGGREGATION !== "0";
}

/** Finite positive number or fail; every strategy validates through these. */
export function num(v: unknown, name: string): number {
  // fix 2026-09-02 H32: Number("") is 0 by the language spec, so "amount": ""
  // became a silent 0 in a paid deliverable; a blank string is not a number.
  if (strictInput() && typeof v === "string" && v.trim() === "") {
    throw new InputError(`${name} must be a finite number (got an empty string)`);
  }
  // fix 2026-09-03 H94 H170 H280: Number() also accepts forms a job spec never means as a
  // quantity. num("0x10") was 16, so a buyer's hex string became a silent 16 units inside a
  // paid deliverable (measured end to end: holdings {"BTC":"0x10"} at price 100 delivered
  // portfolioUsd 1600, ok:true). Accept only decimal, with an optional sign, decimal point
  // and exponent, which is every form a numeric JSON field or a key=value carrier can carry.
  // 0x/0b/0o, "Infinity" and numeric separators are refused by name instead.
  // STRATEGY_STRICT_INPUT=0 restores the bare Number() conversion.
  if (strictInput() && typeof v === "string" && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim())) {
    throw new InputError(`${name} must be a finite number in decimal form (got ${JSON.stringify(v)})`);
  }
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new InputError(`${name} must be a finite number`);
  }
  return n;
}

export function pos(v: unknown, name: string): number {
  const n = num(v, name);
  if (n <= 0) throw new InputError(`${name} must be > 0`);
  return n;
}

export function nonNeg(v: unknown, name: string): number {
  const n = num(v, name);
  if (n < 0) throw new InputError(`${name} must be >= 0`);
  return n;
}

export class InputError extends Error {}

/** Uniform deliverable envelope: ok payloads and structured failures. */
export function deliver(category: string, result: Record<string, unknown>): string {
  return JSON.stringify({ category, ok: true, ...result });
}

export function refuse(category: string, error: string, hint?: string): string {
  return JSON.stringify({ category, ok: false, error, ...(hint ? { hint } : {}) });
}
