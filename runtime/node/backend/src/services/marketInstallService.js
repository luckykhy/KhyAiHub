'use strict';

/**
 * marketInstallService — execute a khy-market/1 install spec and report which
 * marketplace entries are installed.
 *
 * A marketplace install must land in the same stores as `khy skill add` and
 * `khy mcp add`; a second writer would drift. This module only dispatches:
 * skills go through skillInstallService, MCP servers through mcpConfigStore,
 * and a small ledger remembers which entry produced which artifact so the
 * pane can offer uninstall after the catalog entry disappears.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const atomicWriteJson = require('../utils/atomicWriteJson');
const { getDataHome, getAppHome, DATA_PATHS } = require('../utils/dataHome');
const skillInstallService = require('./skillInstallService');
const mcpConfigStore = require('./domain/messaging/mcp/mcpConfigStore');

const LEDGER_FILE = 'market-installed.json';

function _errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

function _homes(options) {
  const io = options && options.io ? options.io : {};
  const dataHome = path.resolve(io.dataHome || getDataHome());
  const appHome = path.resolve(io.appHome || getAppHome());
  return { dataHome, appHome };
}

function ledgerPath(options) {
  const io = options && options.io ? options.io : {};
  if (io.ledgerFile) return path.resolve(io.ledgerFile);
  return path.join(_homes(options).appHome, LEDGER_FILE);
}

function readLedger(options) {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(options), 'utf-8'));
    const installs = raw && typeof raw.installs === 'object' && raw.installs ? raw.installs : {};
    return { version: 1, installs };
  } catch {
    return { version: 1, installs: {} };
  }
}

function writeLedger(doc, options) {
  const file = ledgerPath(options);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!atomicWriteJson(file, doc, { trailingNewline: true })) {
    throw new Error(`无法写入市场安装台账：${file}`);
  }
}

function entryKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.marketId === 'string' && entry.marketId.trim()) return entry.marketId.trim();
  const eco = Array.isArray(entry.agentScope) && entry.agentScope.length ? entry.agentScope[0] : '';
  return eco ? `${eco}:${entry.name}` : '';
}

function _isInside(dir, root) {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function _realOrSelf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

// `importSkill` writes to getDataDir('skills'), which maps to
// <dataHome>/T1-domains/tools/skills; <dataHome>/skills is a compatibility
// junction to that dir. Compare real paths against both the junction and the
// mapped dir so the ledger's canonical dest is not refused as "outside".
function _skillRoots(options) {
  const dataHome = _homes(options).dataHome;
  const roots = [path.join(dataHome, 'skills')];
  if (DATA_PATHS.skills) roots.push(path.join(dataHome, DATA_PATHS.skills));
  return [...new Set(roots.map(_realOrSelf))];
}

function _invalidateSkills() {
  try {
    require('../skills').invalidateCache();
  } catch {
    /* loader unavailable → next scan is cold anyway */
  }
}

function _record(entry, payload, options) {
  const key = entryKey(entry);
  if (!key) return;
  const ledger = readLedger(options);
  ledger.installs[key] = {
    marketId: key,
    eco: Array.isArray(entry.agentScope) && entry.agentScope.length ? entry.agentScope[0] : '',
    name: String(entry.name || ''),
    at: new Date().toISOString(),
    ...payload,
  };
  writeLedger(ledger, options);
}

function _forget(key, options) {
  if (!key) return;
  const ledger = readLedger(options);
  if (!ledger.installs[key]) return;
  delete ledger.installs[key];
  writeLedger(ledger, options);
}

async function _installSkill(entry, spec, options) {
  const source = String(spec.source || '').trim();
  if (!source) {
    return { ok: false, error: '安装规格缺少技能来源仓库：请在详情页复制命令手动接入。' };
  }
  const installer = options._skillInstall || skillInstallService;
  if (!installer || typeof installer.addFromSource !== 'function') {
    return { ok: false, error: '技能安装服务不可用：后端缺少 skillInstallService，请以完整仓库或便携版运行。' };
  }
  const skills = Array.isArray(spec.skills) ? spec.skills.map(String).filter(Boolean) : [];
  const targets = skills.length ? skills : [''];
  const installed = [];
  const failures = [];
  for (const skill of targets) {
    try {
      const result = await installer.addFromSource(source, skill ? { skill } : {});
      installed.push({
        name: String(result && result.name ? result.name : ''),
        dir: String(result && result.dest ? result.dest : ''),
        subdir: skill,
      });
    } catch (err) {
      failures.push(`${skill || '仓库根目录'}：${_errorText(err)}`);
    }
  }
  if (installed.length === 0) {
    return {
      ok: false,
      error: `技能未安装：${failures.join('；')}。修复：检查网络与 git，或改用详情页命令手动导入。`,
    };
  }
  _record(entry, { mode: 'skill', skills: installed, complete: failures.length === 0 }, options);
  const names = installed.map((item) => item.name).filter(Boolean).join('、');
  const message = failures.length
    ? `已导入 ${installed.length}/${targets.length} 个技能（${names}）；失败：${failures.join('；')}`
    : `已导入技能 ${names}，可在「技能」页查看。`;
  return { ok: true, mode: 'skill', installed, partial: failures.length > 0, message };
}

function _requiredKeys(entry) {
  const requires = entry.installRequires || entry.installSpec?.requires;
  const env = Array.isArray(requires && requires.env) ? requires.env : [];
  const headers = Array.isArray(requires && requires.headers) ? requires.headers : [];
  return [...env, ...headers]
    .filter((item) => item && item.required && item.name)
    .map((item) => String(item.name));
}

function _installMcp(entry, spec, options) {
  const name = String(spec.name || '').trim();
  const sourceConfig = spec.config && typeof spec.config === 'object' ? spec.config : null;
  if (!name || !sourceConfig) {
    return { ok: false, error: '安装规格缺少 MCP 服务器名或启动配置：请在详情页复制命令手动接入。' };
  }
  const values = options.values && typeof options.values === 'object' ? options.values : {};
  const config = JSON.parse(JSON.stringify(sourceConfig));
  if (values.env && typeof values.env === 'object') {
    config.env = { ...(config.env || {}), ...values.env };
  }
  if (values.headers && typeof values.headers === 'object') {
    config.headers = { ...(config.headers || {}), ...values.headers };
  }
  const scope = spec.scope === 'project' ? 'project' : 'user';
  const store = options._mcpStore || mcpConfigStore;
  const written = store.addServer(name, config, { scope, dataHome: _homes(options).dataHome });
  const missing = _requiredKeys(entry).filter((key) => {
    const env = values.env && typeof values.env === 'object' ? values.env : {};
    const headers = values.headers && typeof values.headers === 'object' ? values.headers : {};
    return !String(env[key] || headers[key] || '').trim();
  });
  _record(
    entry,
    { mode: 'mcp', mcp: { name, scope, path: written.path, replaced: Boolean(written.replaced) } },
    options
  );
  const message = missing.length
    ? `已写入 MCP 服务器 ${name}（${scope === 'project' ? '项目级' : '用户级'}）；缺少必填项 ${missing.join('、')}，连接前请在该条目补上。`
    : `已写入 MCP 服务器 ${name}（${scope === 'project' ? '项目级' : '用户级'}），可在「MCP 服务器」页查看。`;
  return {
    ok: true,
    mode: 'mcp',
    installed: [{ name, path: written.path }],
    replaced: Boolean(written.replaced),
    missing,
    message,
  };
}

async function installEntry(entry, options) {
  const opts = options || {};
  const spec = entry && entry.installSpec;
  if (!spec || !spec.mode) {
    return {
      ok: false,
      error: '该条目没有可执行的安装规格：请在详情页复制命令，用 khy skill add / khy mcp add 手动接入。',
    };
  }
  try {
    if (spec.mode === 'skill') return await _installSkill(entry, spec, opts);
    if (spec.mode === 'mcp') return _installMcp(entry, spec, opts);
    return { ok: false, error: `暂不支持安装 ${spec.mode} 形态：请用详情页命令手动接入。` };
  } catch (err) {
    return { ok: false, error: `安装失败：${_errorText(err)}` };
  }
}

async function _removeSkillDir(dir, expectedName, options) {
  const resolved = _realOrSelf(dir);
  const roots = _skillRoots(options);
  if (!roots.some((root) => _isInside(resolved, root)) || roots.includes(resolved)) {
    throw new Error(`技能目录不在可管理范围内：${resolved}`);
  }
  if (!fs.existsSync(resolved)) return false;
  const manifestFile = path.join(resolved, 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    let manifestName = '';
    try {
      manifestName = String(JSON.parse(fs.readFileSync(manifestFile, 'utf-8')).name || '');
    } catch {
      manifestName = '';
    }
    if (manifestName && expectedName && manifestName !== expectedName) {
      throw new Error(`技能目录与台账名称不一致（${manifestName} ≠ ${expectedName}）：请到「技能」页确认后删除。`);
    }
  }
  await fsp.rm(resolved, { recursive: true, force: true });
  return true;
}

async function uninstallEntry(entry, options) {
  const opts = options || {};
  const key = entryKey(entry);
  if (!key) return { ok: false, error: '该条目缺少市场标识，无法匹配安装台账：请刷新编目后重试。' };
  const ledger = readLedger(opts);
  const record = ledger.installs[key];
  const spec = entry && entry.installSpec;
  const removed = [];
  const failures = [];

  if (record && record.mode === 'skill') {
    for (const skill of Array.isArray(record.skills) ? record.skills : []) {
      const dir = skill && skill.dir ? String(skill.dir) : '';
      if (!dir) continue;
      try {
        const gone = await _removeSkillDir(dir, String(skill.name || ''), opts);
        if (gone) removed.push(String(skill.name || dir));
      } catch (err) {
        failures.push(_errorText(err));
      }
    }
  } else if ((record && record.mode === 'mcp') || (spec && spec.mode === 'mcp')) {
    const name = String((record && record.mcp && record.mcp.name) || (spec && spec.name) || '').trim();
    const scope = (record && record.mcp && record.mcp.scope) || (spec && spec.scope) || 'user';
    const store = opts._mcpStore || mcpConfigStore;
    if (!name) {
      failures.push('台账与安装规格都没有记录 MCP 服务器名。');
    } else {
      try {
        const result = store.removeServer(name, { scope, dataHome: _homes(opts).dataHome });
        if (result.removed) removed.push(name);
        else failures.push(`MCP 配置里没有服务器 ${name}，可能已被手动删除。`);
      } catch (err) {
        failures.push(_errorText(err));
      }
    }
  } else {
    return { ok: false, error: '未找到该条目的安装记录：可能安装时没有写入台账，请到「技能」页或「MCP 服务器」页手动删除。' };
  }

  if (failures.length === 0) _forget(key, opts);
  if (removed.length === 0 && failures.length > 0) {
    return { ok: false, error: `卸载失败：${failures.join('；')}` };
  }
  if (record && record.mode === 'skill') _invalidateSkills();
  return {
    ok: true,
    removed,
    partial: failures.length > 0,
    message:
      failures.length > 0
        ? `已移除 ${removed.join('、') || '部分产物'}；未完成：${failures.join('；')}`
        : `已卸载 ${removed.join('、')}，对应页面会同步刷新。`,
  };
}

function _recordAlive(record, options) {
  if (!record || typeof record !== 'object') return false;
  if (record.mode === 'mcp') {
    const name = String((record.mcp && record.mcp.name) || '');
    if (!name) return false;
    const scope = (record.mcp && record.mcp.scope) === 'project' ? 'project' : 'user';
    const config = mcpConfigStore.readConfigFile(
      mcpConfigStore.scopePath(scope, { dataHome: _homes(options).dataHome })
    );
    return Boolean(config && config.mcpServers && config.mcpServers[name]);
  }
  if (record.mode === 'skill') {
    const dirs = (Array.isArray(record.skills) ? record.skills : []).map((item) => String((item && item.dir) || ''));
    return dirs.length > 0 && dirs.every((dir) => dir && fs.existsSync(dir));
  }
  return false;
}

/**
 * Mark catalog entries that are already installed and still present on disk.
 * Stale ledger rows (artifact removed by hand) are pruned so the pane never
 * shows a button whose backing store is gone.
 */
function annotateInstalled(ecosystems, options) {
  const opts = options || {};
  const ledger = readLedger(opts);
  let dirty = false;
  const list = Array.isArray(ecosystems) ? ecosystems : [];
  const out = list.map((market) => {
    if (!market || typeof market !== 'object' || !Array.isArray(market.entries)) return market;
    return {
      ...market,
      entries: market.entries.map((entry) => {
        const key = entryKey(entry);
        const record = key ? ledger.installs[key] : null;
        if (!record) return entry;
        if (!_recordAlive(record, opts)) {
          delete ledger.installs[key];
          dirty = true;
          return entry;
        }
        return {
          ...entry,
          installed: true,
          installedAt: String(record.at || ''),
          installedSummary:
            record.mode === 'skill'
              ? `${(record.skills || []).length} 个技能目录`
              : `MCP 服务器 ${record.mcp && record.mcp.name ? record.mcp.name : ''}`,
        };
      }),
    };
  });
  if (dirty) {
    try {
      writeLedger(ledger, opts);
    } catch {
      /* annotation must not take the catalog down */
    }
  }
  return out;
}

function listInstalled(options) {
  const ledger = readLedger(options || {});
  return Object.values(ledger.installs);
}

module.exports = {
  LEDGER_FILE,
  ledgerPath,
  readLedger,
  entryKey,
  installEntry,
  uninstallEntry,
  annotateInstalled,
  listInstalled,
};
