// Compress an installed package directory with transparent filesystem
// compression: NTFS LZX on Windows, btrfs/zstd or ZFS on Linux.
//
// NOT wired to an install hook, by design: this package published a
// `postinstall` until 2026-09-25, and scripts/audit-purity.js forbids
// preinstall/install/postinstall outright — the two declarations contradicted
// each other, so every `npm publish` died in prepack before upload (and
// publish-dual.sh gates on that same audit). The hook was dropped rather than
// the audit being exempted: the npm channel's stance is "prebuilt bundle, no
// code runs at install time", and this step is an optimization, not a
// requirement. Run it explicitly after install instead:
//   node node_modules/@khy-os/khy-os/scripts/postinstall-compress.js
//
// Best-effort: every failure is swallowed. Detached spawn keeps the caller
// fast; compression finishes in the background.
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
// [RUNTIME-001] no literal absolute path. SystemRoot is set on every Windows
// host; were it somehow absent, skip rather than guess a drive letter — this
// script is best-effort by design, so doing nothing is a legal outcome.
const systemRoot = process.env.SystemRoot || process.env.windir || '';

function spawnDetached(cmd, args) {
  try {
    const child = spawn(cmd, args, {
      cwd: packageRoot,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch (err) {
    // best-effort only: compression is an optimization, never a requirement
  }
}

if (process.platform === 'win32' && systemRoot) {
  const compact = path.join(systemRoot, 'System32', 'compact.exe');
  // compact.exe syntax note: the positional argument is a filename pattern,
  // /s:<dir> sets the recursion root and an explicit "*" pattern is required,
  // otherwise compact matches no files and compresses nothing.
  spawnDetached(compact, ['/c', '/s:' + packageRoot, '/q', '/exe:lzx', '*']);
} else if (process.platform === 'linux' || process.platform === 'darwin') {
  const helper = path.join(__dirname, 'install', 'enable-fs-compression.sh');
  spawnDetached('bash', [helper, '--project-root', packageRoot, '--no-pnpm-store']);
}
// Other platforms have no supported transparent compression; do nothing.

process.exit(0);
