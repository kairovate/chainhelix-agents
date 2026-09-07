'use strict';
// 2026-09-07 (build plan B1, one payment module): this agent runs THE shared lane, x402multi/b402.cjs at the repo root,
// the same file the ChainHelix MCP runs. Nothing is vendored any more; the pre-B1 copy is b402.cjs.pre_B1_2026-09-07.
module.exports = require('../../../../../x402multi/b402.cjs');
