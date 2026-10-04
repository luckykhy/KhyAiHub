// Auto-generated shim - re-exports from new domain location
// Do not edit - move services/backend/src/services/domain/data/reverseEngineer instead

// Pointed at ../../tools/reverseEngineer — a tool *definition* module
// (name/inputSchema/execute) that itself requires this shim to reach the engine,
// so the loop handed every consumer a tool spec with no `analyze` on it. The
// header names the real source, and both consumers (src/tools/reverseEngineer.js:80,
// tests/services/reverseEngineer/) call engine.analyze().
module.exports = require('../domain/data/reverseEngineer');

