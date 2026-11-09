'use strict';

/**
 * lib/khy-tools.js — KhyOS-side integration helpers (module D).
 *
 * This file owns everything needed to put the bridge into KhyOS:
 *   - discover a KhyOS installation (khy.js + node + user mcp.json);
 *   - build the absolute MCP stdio server entry
 *     (getMcpServerEntry, the frozen contract name);
 *   - build the exact `khy mcp add|remove` argv and copy/paste command;
 *   - read an mcp.json without ever overwriting unrelated servers;
 *   - build the optional one-shot `khy -p` verification command.
 *
 * It performs NO writes and spawns NOTHING. install.ps1 / doctor.ps1 call it
 * (or call `khy` directly) so the path generation has a single source.
 *
 * Deviation note: the frozen contract names lib/mcp/entry.js for
 * getMcpServerEntry. This build task restricts the file set to
 * lib/khy-tools.js, so the same export name is provided here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('./contracts');

/** MCP server name written into KhyOS's mcp.json. */
const SERVER_NAME = 'amoon';

/** Qualified tool prefix KhyOS uses (toolPool.js / mcp/index.js). */
const QUALIFIED_PREFIX = `mcp__${SERVER_NAME}__`;

/** Relative location of KhyOS's CLI inside a portable KhyOS root. */
const KHY_JS_REL = path.join('runtime', 'node', 'backend', 'bin', 'khy.js');

/** Relative location of the user-scope mcp.json inside a portable KhyOS root. */
const MCP_JSON_REL = path.join('works', 'data', 'khy', 'mcp.json');

/**
 * @param {string} value
 * @returns {string} PowerShell single-quoted literal ('it''s')
 */
function psQuote(value) {
  return `'${String(value === undefined || value === null ? '' : value).replace(/'/g, "''")}'`;
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * KhyOS root = four levels above <root>/runtime/node/backend/bin/khy.js.
 *
 * @param {string} khyJs absolute path
 * @returns {string}
 */
function rootFromKhyJs(khyJs) {
  return path.resolve(path.dirname(khyJs), '..', '..', '..', '..');
}

/**
 * Locate a KhyOS installation without running anything.
 *
 * Order (first existing wins):
 *   1. KHY_JS
 *   2. KHY_HOME/runtime/node/backend/bin/khy.js
 *   3. ancestors of extRoot + <ancestor>/runtime/node/backend/bin/khy.js
 *   4. <this repo>/runtime/node/backend/bin/khy.js when extRoot lives inside it
 *   5. D:\Portable\khy-os (the validated portable location on this host)
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   extRoot?: string,
 *   extraCandidates?: string[],
 * }} [options]
 * @returns {{khyJs:string,root:string,nodePath:string,source:string}|null}
 */
function findKhyOsInstallation(options = {}) {
  const env = options.env || process.env;
  const extRoot = options.extRoot ? path.resolve(options.extRoot) : path.resolve(__dirname, '..');

  const candidates = [];
  if (typeof env.KHY_JS === 'string' && env.KHY_JS.trim()) {
    candidates.push({ file: env.KHY_JS.trim(), source: 'env:KHY_JS' });
  }
  if (typeof env.KHY_HOME === 'string' && env.KHY_HOME.trim()) {
    candidates.push({
      file: path.join(env.KHY_HOME.trim(), KHY_JS_REL),
      source: 'env:KHY_HOME',
    });
  }

  let cursor = extRoot;
  for (let i = 0; i < 8; i += 1) {
    candidates.push({
      file: path.join(cursor, KHY_JS_REL),
      source: i === 0 ? 'extRoot' : `ancestor:${i}`,
    });
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  if (Array.isArray(options.extraCandidates)) {
    for (const item of options.extraCandidates) {
      if (typeof item === 'string' && item.trim()) {
        candidates.push({ file: item.trim(), source: 'candidate' });
      }
    }
  }

  candidates.push({ file: path.join('D:\\', 'Portable', 'khy-os', KHY_JS_REL), source: 'portable-default' });

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.file);
    if (!isFile(resolved)) continue;
    return {
      khyJs: resolved,
      root: rootFromKhyJs(resolved),
      nodePath: typeof env.KHY_NODE === 'string' && env.KHY_NODE.trim()
        ? path.resolve(env.KHY_NODE.trim())
        : process.execPath,
      source: candidate.source,
    };
  }
  return null;
}

/**
 * User-scope mcp.json path, matching KhyOS:
 *   - KHY_DATA_HOME/mcp.json when set (dataHome.js override);
 *   - <khyRoot>/works/data/khy/mcp.json for a portable install;
 *   - ~/.khy/mcp.json as the historical fallback.
 *
 * @param {{env?: NodeJS.ProcessEnv, khyJs?: string|null}} [options]
 * @returns {{path:string, source:string}}
 */
function resolveUserMcpJson(options = {}) {
  const env = options.env || process.env;
  if (typeof env.KHY_DATA_HOME === 'string' && env.KHY_DATA_HOME.trim()) {
    return { path: path.resolve(env.KHY_DATA_HOME.trim(), 'mcp.json'), source: 'KHY_DATA_HOME' };
  }
  if (options.khyJs) {
    return { path: path.join(rootFromKhyJs(path.resolve(options.khyJs)), MCP_JSON_REL), source: 'khy-root' };
  }
  return { path: path.join(os.homedir(), '.khy', 'mcp.json'), source: 'home-fallback' };
}

/**
 * Project scope is <cwd>/works/data/khy/mcp.json in this KhyOS version
 * (mcpConfigStore.scopePath), not <cwd>/.khy/mcp.json.
 *
 * @param {{cwd?: string}} [options]
 * @returns {string}
 */
function resolveProjectMcpJson(options = {}) {
  return path.join(path.resolve(options.cwd || process.cwd()), MCP_JSON_REL);
}

/**
 * Resolve an mcp.json path by scope.
 *
 * @param {{scope?: 'user'|'project', env?: NodeJS.ProcessEnv, khyJs?: string|null, cwd?: string}} [options]
 * @returns {{path:string, scope:'user'|'project', source:string}}
 */
function resolveMcpJsonPath(options = {}) {
  const scope = options.scope === 'project' ? 'project' : 'user';
  if (scope === 'project') {
    return { path: resolveProjectMcpJson({ cwd: options.cwd }), scope, source: 'project' };
  }
  const resolved = resolveUserMcpJson({ env: options.env, khyJs: options.khyJs });
  return { path: resolved.path, scope, source: resolved.source };
}

/**
 * Read an mcp.json without mutating it. Missing file is NOT an error: it is an
 * empty configuration. A corrupt file is an error so callers never overwrite it.
 *
 * @param {string} file
 * @returns {{ok:boolean, exists:boolean, data?:object, error?:string}}
 */
function readMcpJson(file) {
  if (!isFile(file)) {
    return { ok: true, exists: false, data: { mcpServers: {} } };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, exists: true, error: `读取失败：${err && err.message ? err.message : err}` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, exists: true, error: 'JSON 解析失败（文件可能损坏；拒绝覆盖）' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, exists: true, error: '顶层不是 JSON 对象' };
  }
  if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) {
    data.mcpServers = {};
  }
  return { ok: true, exists: true, data };
}

/**
 * @param {object} data parsed mcp.json
 * @param {string} [name]
 * @returns {object|null} server config or null
 */
function findRegisteredServer(data, name = SERVER_NAME) {
  if (!data || typeof data !== 'object') return null;
  const servers = data.mcpServers;
  if (!servers || typeof servers !== 'object') return null;
  const entry = servers[name];
  return entry && typeof entry === 'object' ? entry : null;
}

/**
 * Build the absolute MCP stdio entry KhyOS should spawn.
 *
 * Frozen contract signature: getMcpServerEntry({nodePath, extRoot, stateDir, khyJs}).
 * All paths are absolute because KhyOS spawns MCP servers WITHOUT a cwd.
 *
 * @param {{
 *   nodePath?: string,
 *   extRoot?: string,
 *   stateDir?: string,
 *   khyJs?: string|null,
 * }} [options]
 * @returns {{command:string, args:string[]}}
 */
function getMcpServerEntry(options = {}) {
  const extRoot = path.resolve(options.extRoot || path.resolve(__dirname, '..'));
  const serverJs = path.join(extRoot, 'bin', 'mcp-server.js');
  if (!isFile(serverJs)) {
    throw new C.BridgeError('invalid_config', `MCP 入口不存在：${serverJs}`);
  }

  const command = path.resolve(options.nodePath || process.execPath);
  if (!isFile(command)) {
    throw new C.BridgeError('invalid_config', `node 可执行文件不存在：${command}`);
  }

  const args = [serverJs];
  const extRootAbsolute = extRoot;

  let stateDir = options.stateDir;
  if (!stateDir) {
    const env = process.env;
    const override = env[C.ENV.home];
    if (override && String(override).trim()) {
      stateDir = path.resolve(String(override).trim());
    } else if (env.LOCALAPPDATA && String(env.LOCALAPPDATA).trim()) {
      stateDir = path.join(path.resolve(String(env.LOCALAPPDATA).trim()), C.LOCAL_DIR_NAME);
    } else {
      stateDir = path.join(os.homedir(), 'AppData', 'Local', C.LOCAL_DIR_NAME);
    }
  }
  stateDir = path.resolve(stateDir);

  args.push('--root', extRootAbsolute);
  args.push('--state-dir', stateDir);
  if (options.khyJs) {
    const khyJs = path.resolve(options.khyJs);
    if (!isFile(khyJs)) {
      throw new C.BridgeError('invalid_config', `khy.js 不存在：${khyJs}`);
    }
    args.push('--khy-js', khyJs);
  }

  return { command, args };
}

/**
 * Full argv after khy.js for `khy mcp add`.
 *
 * KhyOS router: `--` makes every following token part of `rest`, preserving
 * the inner command's own flags (mcpAddSpec.js `_consumePreamble`).
 *
 * @param {{
 *   nodePath?: string,
 *   extRoot?: string,
 *   stateDir?: string,
 *   khyJs?: string|null,
 *   name?: string,
 *   scope?: 'user'|'project',
 * }} [options]
 * @returns {string[]}
 */
function buildMcpAddArgv(options = {}) {
  const entry = getMcpServerEntry(options);
  const name = options.name || SERVER_NAME;
  const scope = options.scope === 'project' ? 'project' : 'user';
  return ['mcp', 'add', name, '--scope', scope, '--', entry.command, ...entry.args];
}

/**
 * Copy/paste PowerShell command equivalent to buildMcpAddArgv.
 *
 * @param {{
 *   nodePath?: string,
 *   extRoot?: string,
 *   stateDir?: string,
 *   khyJs?: string,
 *   name?: string,
 *   scope?: 'user'|'project',
 * }} [options]
 * @returns {string}
 */
function buildMcpAddCommand(options = {}) {
  if (!options.khyJs) {
    throw new C.BridgeError('invalid_config', 'buildMcpAddCommand 需要 khyJs（KhyOS CLI 路径）');
  }
  const entry = getMcpServerEntry(options);
  const name = options.name || SERVER_NAME;
  const scope = options.scope === 'project' ? 'project' : 'user';
  const nodePath = path.resolve(options.nodePath || process.execPath);
  const khyJs = path.resolve(options.khyJs);
  const tokens = [
    nodePath,
    khyJs,
    'mcp',
    'add',
    name,
    '--scope',
    scope,
    '--',
    entry.command,
    ...entry.args,
  ];
  return `& ${tokens.map(psQuote).join(' ')}`;
}

/**
 * @param {{khyJs:string, nodePath?:string, name?:string, scope?:'user'|'project'}} options
 * @returns {string[]} argv after khy.js
 */
function buildMcpRemoveArgv(options) {
  const name = options.name || SERVER_NAME;
  const scope = options.scope === 'project' ? 'project' : 'user';
  return ['mcp', 'remove', name, '--scope', scope];
}

/**
 * @param {{khyJs:string, nodePath?:string, name?:string, scope?:'user'|'project'}} options
 * @returns {string}
 */
function buildMcpRemoveCommand(options) {
  const nodePath = path.resolve(options.nodePath || process.execPath);
  const khyJs = path.resolve(options.khyJs);
  const argv = buildMcpRemoveArgv(options);
  return `& ${[nodePath, khyJs, ...argv].map(psQuote).join(' ')}`;
}

/**
 * Optional one-shot verification. This consumes model tokens, so it is never
 * run automatically. `khy mcp test` is NOT a substitute: handlers/mcp.js only
 * connects + lists tools, it never performs tools/call.
 *
 * @param {{tool?: string, question?: string}} [options]
 * @returns {string[]} argv after khy.js
 */
function buildVerifyArgv(options = {}) {
  const tool = options.tool || 'ping';
  const qualified = `${QUALIFIED_PREFIX}${tool}`;
  const question = options.question || `调用 ${qualified} 并只返回结果`;
  return [
    '-p',
    question,
    '--allowedTools',
    qualified,
    '--output-format',
    'json',
    '--max-turns',
    '2',
  ];
}

/**
 * @param {{khyJs:string, nodePath?:string, tool?:string, question?:string}} options
 * @returns {string}
 */
function buildVerifyCommand(options) {
  const nodePath = path.resolve(options.nodePath || process.execPath);
  const khyJs = path.resolve(options.khyJs);
  return `& ${[nodePath, khyJs, ...buildVerifyArgv(options)].map(psQuote).join(' ')}`;
}

/**
 * Redacted description of a registered server for diagnostics. Never includes
 * env values (they may hold secrets).
 *
 * @param {object|null} entry
 * @returns {object|null}
 */
function describeRegisteredServer(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    type: typeof entry.type === 'string' ? entry.type : 'stdio',
    command: typeof entry.command === 'string' ? entry.command : null,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    envKeys:
      entry.env && typeof entry.env === 'object' ? Object.keys(entry.env) : [],
    disabled: entry.disabled === true,
  };
}

module.exports = {
  SERVER_NAME,
  QUALIFIED_PREFIX,
  KHY_JS_REL,
  MCP_JSON_REL,
  psQuote,
  findKhyOsInstallation,
  resolveUserMcpJson,
  resolveProjectMcpJson,
  resolveMcpJsonPath,
  readMcpJson,
  findRegisteredServer,
  getMcpServerEntry,
  buildMcpAddArgv,
  buildMcpAddCommand,
  buildMcpRemoveArgv,
  buildMcpRemoveCommand,
  buildVerifyArgv,
  buildVerifyCommand,
  describeRegisteredServer,
};
