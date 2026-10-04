// Relocated on 2026-09-28 ([RESEARCH-018] §3.1 P2 batch 17): zero-require pure leaf (109 lines, gate KHY_TABLE_BORDERS) — its only sin was living under cli/ while the shared substrate D3 now needs it (utils/format/consoleError renders the error panel with it). Moved verbatim to D3; this old path is a re-export shell.
// require(<shell>) === require(<true home>) holds by object identity.
module.exports = require('../utils/format/tableStyle');
