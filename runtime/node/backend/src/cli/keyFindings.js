// Relocated on 2026-09-28 ([RESEARCH-018] §3.1 P2 batch 18): zero-IO milestone reporter; sole dependency was already the D3 leaf utils/normalizeToolName, so the whole file sits in the shared substrate. Moved verbatim to the shared substrate D3 (utils/text/keyFindings.js); this old path is a re-export shell so the cli-side call sites (toolUseLoopCore.js, toolUseLoopHelpers.js) resolve unchanged.
// require(<shell>) === require(<true home>) holds by object identity.
module.exports = require('../utils/text/keyFindings');
