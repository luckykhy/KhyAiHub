// Auto-generated shim - re-exports from new domain location
// Do not edit - move services/backend/src/services/domain/deploy/deploy instead

// Pointed at ../../cli/handlers/deploy, which exports handleDeploy/SUB_COMMANDS
// and never had deployProject — the target this shim declares in its own header
// is the moved domain module, and that is what both consumers ask for
// (cli/handlers/deploy.js lazyDeploy(), tests/deploy.orchestrator.test.js).
module.exports = require('../domain/deploy/deploy');

