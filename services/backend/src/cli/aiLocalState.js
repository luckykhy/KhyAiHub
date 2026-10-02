// Relocated on 2026-09-28 ([RESEARCH-018] §3.1 P2 batch 13): State holder, not a pure formatting leaf: a require()-cached mutable singleton read/written in-place by the cli/ai family and by sessionWatchdog. Its home is the service layer (D2) because both directions then point downward; cli/aiLocalState.js stays a re-export shell so the four ai.js-family writers keep their path and the SAME object identity.
// The old path is kept as a pure re-export shell, so existing cli call sites resolve here
// unchanged and require(<shell>) === require(<true home>) holds by object identity.
module.exports = require('../services/aiLocalState');
