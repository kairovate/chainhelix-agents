// Shared-endpoint tally: many registrations declaring one backend are counted
// as a stated fact per row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointCounts } from "../src/catalog.js";

test("endpointCounts tallies across categories, ignores missing endpoints", () => {
  const groups = [
    {
      agents: [
        { endpoint: "https://api.shared.xyz/card" },
        { endpoint: "https://api.shared.xyz/card" },
        { endpoint: null },
      ],
    },
    {
      agents: [
        { endpoint: "https://api.shared.xyz/card" },
        { endpoint: "https://solo.example/card" },
      ],
    },
  ];
  const counts = endpointCounts(groups);
  assert.equal(counts.get("https://api.shared.xyz/card"), 3);
  assert.equal(counts.get("https://solo.example/card"), 1);
  assert.equal(counts.has(null), false);
});
