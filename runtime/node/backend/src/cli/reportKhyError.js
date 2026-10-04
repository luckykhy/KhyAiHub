// Relocated on 2026-09-28 ([RESEARCH-018] §3.1 P2 batch 20): the error renderer's true home is the service
// layer (src/services/reportKhyError.js) — it needs services/errorClassifier and its four print primitives
// already live in D3 (utils/format/consoleNotice + consoleError). This old path is a re-export shell so
// cli-side and test call sites resolve unchanged; require(<shell>) === require(<true home>) by identity.
module.exports = require('../services/reportKhyError');
