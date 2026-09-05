// sweep 2026-09-05: the read-only verify route's record scanner, on a small state file: first, middle and LAST
// record, a record whose strings carry braces, and an unknown id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const { recordFromState, objectEnd } = await import("../src/verify.js");
const dir = mkdtempSync(join(tmpdir(), "vstate-"));
const file = join(dir, "verified.json");
const agents = {
  "7": { id: 7, status: "alive", reason: 'card: {"x":"}"}', history: [{ t: 1, s: "alive" }] },
  "8": { id: 8, status: "dead", card: { name: "brace } in a string", nested: { deep: { deeper: 1 } } } },
  "335154": { id: 335154, status: "dead", endpoint: null, history: [{ t: 2, s: "dead" }] },
};
writeFileSync(file, JSON.stringify({ version: 1, agents, meta: { n: 3 } }));
test("first, middle and last record are returned whole", () => {
  assert.deepEqual(recordFromState(7, file), agents["7"]);
  assert.deepEqual(recordFromState(8, file), agents["8"]);
  assert.deepEqual(recordFromState(335154, file), agents["335154"]);
});
test("unknown id and bad id are null", () => {
  assert.equal(recordFromState(9, file), null);
  assert.equal(recordFromState("x", file), null);
});
test("objectEnd walks braces string-aware", () => {
  const s = 'ab{"k":"}","n":{"m":1}}tail';
  assert.equal(s.slice(2, objectEnd(s, 2)), '{"k":"}","n":{"m":1}}');
  assert.equal(objectEnd("{unterminated", 0), -1);
});
