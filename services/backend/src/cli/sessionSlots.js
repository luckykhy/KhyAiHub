// Relocated on 2026-09-28 ([RESEARCH-018] §3.1 P2 batch 16): zero-IO deterministic leaf (CONTRACT: no fs, no env, no Date/crypto), its only sin was living under cli/. Moved verbatim to the shared substrate D3; this old path is a re-export shell so the cli-side call sites (handlers/fork, handlers/topology, tui/TopologyPanel, tui/App, cli/ai self-registration) resolve unchanged.
// require(<shell>) === require(<true home>) holds by object identity.
module.exports = require('../utils/sessionSlots');
