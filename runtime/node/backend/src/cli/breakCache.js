// Relocated to the shared substrate on 2026-09-28 ([RESEARCH-018] §3.1 P1/P2): this leaf is
// pure and serves both cli/ and services/, so it no longer lives under cli/. The old path is
// kept as a pure re-export shell; every existing cli call site continues to resolve here.
module.exports = require('../utils/breakCache');
