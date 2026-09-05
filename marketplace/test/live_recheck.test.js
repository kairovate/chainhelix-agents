// 2026-09-06: the live map's recheck list. An agent that was alive or hireable within the recheck window and is
// offline or dead on its newest probe stays on the live cadence; older drops and gated agents do not.
import { test } from "node:test";
import assert from "node:assert/strict";
const { buildLiveMap, lastLiveOf } = await import("../src/verify.js");
const now = Date.now(), h = 3600e3;
const st = { agents: {
  "1": { id: 1, name: "live", status: "hireable", probedAt: now - 30e3, lastLiveAt: now - 30e3, endpoint: "https://a/x" },
  "2": { id: 2, name: "dropped an hour ago", status: "offline", probedAt: now - 60e3, lastLiveAt: now - 1 * h, x402: true },
  "3": { id: 3, name: "dropped two days ago", status: "offline", probedAt: now - 60e3, lastLiveAt: now - 48 * h },
  "4": { id: 4, name: "never live", status: "dead", probedAt: now - 60e3 },
  "5": { id: 5, name: "gated", status: "gated", probedAt: now - 60e3, lastLiveAt: now - 1 * h },
  "6": { id: 6, name: "old record, history only", status: "dead", probedAt: now - 60e3, history: [{ t: now - 2 * h, s: "alive" }, { t: now - 60e3, s: "dead" }] },
}, updated: now };
test("recheck holds recent drops only, newest first, with the probe fields", () => {
  const lm = buildLiveMap(st);
  assert.deepEqual(lm.entries.map((e) => e.id), [1]);
  assert.deepEqual(lm.recheck.map((e) => e.id), [2]);
  assert.equal(lm.recheck[0].x402, true);
  assert.equal(lm.recheck[0].status, "offline");
  assert.equal(lm.recheckHours, 24);
});
test("lastLiveOf: a live probe stamps now, a drop keeps the previous stamp, an old record derives it from history", () => {
  assert.equal(lastLiveOf(null, { status: "alive", probedAt: 5 }), 5);
  assert.equal(lastLiveOf({ lastLiveAt: 7 }, { status: "offline", probedAt: 9 }), 7);
  assert.equal(lastLiveOf(st.agents["6"], { status: "dead", probedAt: now }), now - 2 * h);
  assert.equal(lastLiveOf(null, { status: "dead", probedAt: 9 }), null);
});
