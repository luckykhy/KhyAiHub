'use strict';

/**
 * Known system-wide installation locations used only as discovery candidates.
 * Environment variables keep the values portable across Windows installations.
 */
const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

// Portable root (set by khy.bat / khy.sh) — never hardcode a drive letter here.
// Trailing separators are stripped so the joined paths stay single-separated.
const portableRoot = String(
  process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT || ''
).replace(/[\\/]+$/, '');

// Portable Git for Windows: <portableRoot>/Tools/git/cmd/git.exe (first) plus the
// legacy bin/ layout and the source/ + 2-tools/ re-organised layouts.
const GIT_PORTABLE_CANDIDATES = portableRoot
  ? Object.freeze([
      pathJoin(portableRoot, 'Tools', 'git', 'cmd', 'git.exe'),
      pathJoin(portableRoot, 'Tools', 'git', 'bin', 'git.exe'),
      pathJoin(portableRoot, '2-tools', 'Tools', 'git', 'cmd', 'git.exe'),
      pathJoin(portableRoot, 'source', 'Tools', 'git', 'cmd', 'git.exe'),
    ])
  : Object.freeze([]);

const WINDOWS_IDE_INSTALL_PATHS = Object.freeze({
  kiro: [
    pathJoin(programFiles, 'Kiro'),
    pathJoin(programFilesX86, 'Kiro'),
  ],
  cursor: [pathJoin(programFiles, 'Cursor')],
  trae: [
    pathJoin(programFiles, 'Trae CN'),
    pathJoin(programFiles, 'Trae'),
  ],
  warp: [pathJoin(programFiles, 'Warp')],
  vscode: [
    pathJoin(programFiles, 'Microsoft VS Code'),
    pathJoin(programFilesX86, 'Microsoft VS Code'),
  ],
});

const NIRVANA_STORAGE_CANDIDATES = Object.freeze([
  pathJoin(programFiles, 'nirvana', 'User', 'globalStorage', 'storage.json'),
  pathJoin(programFiles, 'Nirvana', 'User', 'globalStorage', 'storage.json'),
  pathJoin(programFiles, 'nirvana', 'storage.json'),
  pathJoin(programFiles, 'Nirvana', 'storage.json'),
]);

const NIRVANA_CACHE_CANDIDATES = Object.freeze([
  pathJoin(programFiles, 'nirvana', 'trae_local_cache.json'),
  pathJoin(programFiles, 'Nirvana', 'trae_local_cache.json'),
  pathJoin(programFilesX86, 'nirvana', 'trae_local_cache.json'),
]);

const GIT_BASH_CANDIDATES = Object.freeze([
  // Portable Git wins: a portable deployment ships its own Git for Windows.
  ...GIT_PORTABLE_CANDIDATES,
  pathJoin(programFiles, 'Git', 'bin', 'git.exe'),
  pathJoin(programFilesX86, 'Git', 'bin', 'git.exe'),
  pathJoin(process.env.SystemDrive || 'C:', 'Git', 'bin', 'git.exe'),
]);

function pathJoin(...segments) {
  return segments.join('\\');
}

module.exports = {
  GIT_BASH_CANDIDATES,
  GIT_PORTABLE_CANDIDATES,
  NIRVANA_CACHE_CANDIDATES,
  NIRVANA_STORAGE_CANDIDATES,
  WINDOWS_IDE_INSTALL_PATHS,
};
