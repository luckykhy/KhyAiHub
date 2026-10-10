// Relocated to the shared substrate on 2026-09-28 ([RESEARCH-018] §3.1 P1/P2): zero-require leaf
// whose real home is below cli/ (its first consumer happened to be a TUI picker). Old path kept
// as a pure re-export shell so the seven TUI call sites are unchanged.
module.exports = require('../utils/format/fullWidthInput');
