// Relocated to the shared substrate on 2026-09-28 ([RESEARCH-018] §3.1 P2 batch 12b): this leaf is
// pure (zero requires, deterministic) and its first consumer was a TUI footer, so it no longer
// lives under cli/. The old path is kept as a pure re-export shell; every existing cli call site
// continues to resolve here. The services layer requires the true home directly (R1-layering).
module.exports = require('../utils/format/ccModelName');
