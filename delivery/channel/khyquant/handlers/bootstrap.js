// Shim: resolve to backend CLI bootstrap via Node module resolution
const path = require('path');

function findBackendCli() {
  // 1. pip bundled: handlers/ -> software/khyquant/handlers/ -> khy_quant/bundled/services/backend/src/cli/
  const bundled = path.resolve(__dirname, '..', 'khy_quant', 'bundled', 'services', 'backend', 'src', 'cli', 'bootstrap.js');
  try { if (require('fs').existsSync(bundled)) return require(bundled); } catch {}
  // 2. source dev: handlers/ -> delivery/channel/khyquant/handlers/ -> runtime/node/backend/src/cli/
  const dev = path.resolve(__dirname, '..', '..', '..', '..', 'runtime', 'node', 'backend', 'src', 'cli', 'bootstrap.js');
  try { return require(dev); } catch {}
  // 2b. legacy source layout (pre-migration): <root>/services/backend/src/cli/
  const devLegacy = path.resolve(__dirname, '..', '..', '..', '..', 'services', 'backend', 'src', 'cli', 'bootstrap.js');
  try { return require(devLegacy); } catch {}
  // 3. fallback no-op (log warning in debug mode)
  try { if (process.env.DEBUG) console.warn('[khyquant] bootstrap fallback: backend CLI not found'); } catch {}
  return { bootstrap: async () => {}, muteDbLogs: () => {}, restoreDbLogs: () => {} };
}

module.exports = findBackendCli();
