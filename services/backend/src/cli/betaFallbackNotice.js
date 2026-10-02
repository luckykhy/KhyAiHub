// Relocated on 2026-09-28 ([RESEARCH-018] §3.1 P2 batch 13): Pure leaf (82 lines, zero requires, never throws, env-gated) that renders one CC-style notice line. Moved verbatim to D3; cli path kept as a re-export shell.
// The old path is kept as a pure re-export shell, so existing cli call sites resolve here
// unchanged and require(<shell>) === require(<true home>) holds by object identity.
module.exports = require('../utils/betaFallbackNotice');
