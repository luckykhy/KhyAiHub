// Relocated on 2026-09-28 ([RESEARCH-018] §3.1 P2 batch 13): Pure leaf (676 lines, zero requires, deterministic, env-gated) whose only sin was being authored under cli/. Moved verbatim to the shared substrate D3; cli/toolCallNoise.js becomes a re-export shell for the cli-side renderer.
// The old path is kept as a pure re-export shell, so existing cli call sites resolve here
// unchanged and require(<shell>) === require(<true home>) holds by object identity.
module.exports = require('../utils/toolCallNoise');
