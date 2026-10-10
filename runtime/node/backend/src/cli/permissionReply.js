// Relocated on 2026-09-28 ([RESEARCH-018] §3.1 P2 batch 18): zero-IO approve/deny token SSOT (CONTRACT: 零 IO、确定性、fail-soft、门控感知), its only sin was living under cli/. Moved verbatim to the shared substrate D3 (utils/text/permissionReply.js); this old path is a re-export shell so the cli-side call sites (toolCallingPermissions.js) resolve unchanged.
// require(<shell>) === require(<true home>) holds by object identity.
module.exports = require('../utils/text/permissionReply');
