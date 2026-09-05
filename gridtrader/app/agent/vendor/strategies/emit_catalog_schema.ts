/**
 * Regenerates agents[].inputSchema in marketplace/catalog.json from schema.ts. Run after any schema
 * change: `rebalancer/app/agent/node_modules/.bin/tsx strategies/emit_catalog_schema.ts [path]`.
 * test.ts asserts the file on disk equals this output, so a stale catalog fails the suite.
 */
import { readFileSync, writeFileSync } from "fs";
import { WORK_SCHEMAS, catalogInputSchema, inputSchema, exampleTaskDescription } from "./schema.js";

/**
 * 2026-09-05 (build B3, the MCP bridge): marketplace/work_schemas.json, one entry per first-party agent with the
 * JSON Schema and the example, read by the ChainHelix MCP to publish hire_<agent> tools whose inputSchema IS this
 * schema. Same source as the card, the refusal and the storefront table.
 */
export function renderWorkSchemas(catalogJson: string): string {
  const cat = JSON.parse(catalogJson);
  const out: Record<string, unknown> = { generated: "from strategies/schema.ts by strategies/emit_catalog_schema.ts; do not edit", agents: {} as Record<string, unknown> };
  for (const a of cat.agents) {
    if (!(a.category in WORK_SCHEMAS)) continue;
    const s = WORK_SCHEMAS[a.category as keyof typeof WORK_SCHEMAS];
    (out.agents as Record<string, unknown>)[a.id] = { id: a.id, category: a.category, name: s.name, description: s.description, erc8004Id: a.erc8004Id, endpoint: a.endpoint, inputSchema: inputSchema(a.category), example: JSON.parse(exampleTaskDescription(a.category)) };
  }
  return JSON.stringify(out, null, 2) + "\n";
}

export function renderCatalog(json: string): string {
  const cat = JSON.parse(json);
  for (const a of cat.agents) {
    if (a.category in WORK_SCHEMAS) a.inputSchema = catalogInputSchema(a.category);
  }
  return JSON.stringify(cat, null, 2) + "\n";
}

if (process.argv[1] && /emit_catalog_schema/.test(process.argv[1])) {
  const path = process.argv[2] ?? new URL("../marketplace/catalog.json", import.meta.url).pathname;
  const before = readFileSync(path, "utf8");
  const after = renderCatalog(before);
  if (after !== before) { writeFileSync(path, after); console.log("catalog.json inputSchema regenerated: " + path); }
  else console.log("catalog.json already current: " + path);
  const wsPath = path.replace(/catalog\.json$/, "work_schemas.json");
  const ws = renderWorkSchemas(after);
  let cur = ""; try { cur = readFileSync(wsPath, "utf8"); } catch { cur = ""; }
  if (ws !== cur) { writeFileSync(wsPath, ws); console.log("work_schemas.json regenerated: " + wsPath); } else console.log("work_schemas.json already current: " + wsPath);
}
