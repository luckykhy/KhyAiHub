// Relocated to the shared substrate on 2026-09-28 ([RESEARCH-018] §3.1 P1/P2): this leaf is pure text-intent detection consumed by both cli/ and services/, so it no longer lives under cli/; every existing call
// path continues to resolve here.
module.exports = require('../../utils/text/imageIntent');
