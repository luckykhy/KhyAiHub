'use strict';

/**
 * amooWorkspacePlan.js — 双向同步工作区的纯计划叶。
 *
 * 「Amoo 在本地磁盘上开发，同时与 khy-os 互联」的磁盘侧：PC 项目目录 ↔ 手机
 * /sdcard/amoo-dev。为什么是 adb 而不是桥的文件工具：桥会自己卡死（实测 5 次），
 * 而 adb 通道与桥共存亡无关；push/pull 走 adb，状态展示优先桥的 ls（有大小与
 * 时间），桥不在线退回 adb 的名字列表——两条路都不撒谎。
 *
 * v1 约定（写进 README，不靠猜）：
 *   - 工作区是**扁平文件**（node 脚本、数据、提示词），不做子目录递归；
 *   - PC 侧 manifest `.amoo-workspace.json` 记录上次推送的 sha256，
 *     push 只上传哈希变动的文件——「同步」不是「全量拷贝」；
 *   - pull 按远端名字列表逐个拉，拉到本地目录， flat 落盘。
 *
 * 本叶零 IO：argv 拼接、manifest 差异计算、中文文案都在这里，
 * 断言不需要设备。
 *
 * @module services/domain/network/amoo/amooWorkspacePlan
 */

const WORKSPACE_ACTIONS = Object.freeze(['push', 'pull', 'status', 'help']);
const DEFAULT_REMOTE_DIR = '/sdcard/amoo-dev';
const MANIFEST_NAME = '.amoo-workspace.json';

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 解析 workspace 子命令。空参落 status（与 amoo 主命令同一哲学：未知词明确
 * 拒绝，静默落默认会让 `khy amoo workspace pushh` 看起来像成功了）。
 * @param {string[]} [tokens]
 * @returns {{ok:boolean, action:string, localDir:string, remoteDir:string, error:string|null}}
 */
function parseWorkspaceArgv(tokens = []) {
  const list = Array.isArray(tokens) ? tokens.map((t) => _clean(t)).filter(Boolean) : [];
  if (list.length === 0) {
    return { ok: true, action: 'status', localDir: '', remoteDir: '', error: null };
  }
  const head = list[0];
  if (!WORKSPACE_ACTIONS.includes(head)) {
    return {
      ok: false,
      action: '',
      localDir: '',
      remoteDir: '',
      error: `未知工作区动作：${head}（可用：${WORKSPACE_ACTIONS.join(' / ')}）`,
    };
  }
  const rest = list.slice(1);
  if (head === 'help') {
    return { ok: true, action: 'help', localDir: '', remoteDir: '', error: null };
  }
  if (head === 'status') {
    return { ok: true, action: 'status', localDir: rest[0] || '', remoteDir: rest[1] || '', error: null };
  }
  if (head === 'push') {
    if (rest.length === 0) {
      return {
        ok: false,
        action: '',
        localDir: '',
        remoteDir: '',
        error: 'push 需要本地目录：khy amoo workspace push <本地目录>',
      };
    }
    return { ok: true, action: 'push', localDir: rest[0], remoteDir: rest[1] || '', error: null };
  }
  // pull：本地目录可省（落到 <cwd>/amoo-dev-pulled）
  return { ok: true, action: 'pull', localDir: rest[0] || '', remoteDir: rest[1] || '', error: null };
}

// ── argv 构造（与 amooBridgePolicy 同构：单字符串 device-shell 命令） ──────

function buildRemoteListArgv(serial, remoteDir) {
  return ['-s', serial, 'shell', `ls -1 ${remoteDir} 2>/dev/null`];
}

function buildPushArgv(serial, localPath, remotePath) {
  return ['-s', serial, 'push', localPath, remotePath];
}

function buildPullArgv(serial, remotePath, localPath) {
  return ['-s', serial, 'pull', remotePath, localPath];
}

// ── manifest 与差异 ───────────────────────────────────────────────────────

/**
 * 读 manifest 文本。坏 JSON / 非对象都按空 manifest 处理——第一次同步本来
 * 就没有 manifest，把坏文件当成异常抛出去只会挡住第一次 push。
 * @param {string} [text]
 * @returns {{files:Object<string,{sha256:string,size:number}>, version:number}}
 */
function readManifest(text) {
  const empty = { version: 1, files: {} };
  if (typeof text !== 'string' || text.trim().length === 0) {
    return empty;
  }
  try {
    const parsed = JSON.parse(text);
    if (!_isPlainObject(parsed) || !_isPlainObject(parsed.files)) {
      return empty;
    }
    return { version: 1, files: parsed.files };
  } catch {
    return empty;
  }
}

function writeManifest(files) {
  return JSON.stringify({ version: 1, files }, null, 2);
}

/**
 * 算推送计划：本地文件里 manifest 没有的、或哈希变了的，进 upload；
 * manifest 有而本地没了的，进 remove（只报告，不擅自删手机上的文件）。
 * @param {{name:string, sha256:string, size:number}[]} [files]
 * @param {{files:Object<string,{sha256:string}>}} [manifest]
 * @returns {{upload:string[], skip:string[], remove:string[]}}
 */
function planPush(files = [], manifest = { files: {} }) {
  const known = _isPlainObject(manifest) && _isPlainObject(manifest.files) ? manifest.files : {};
  const upload = [];
  const skip = [];
  const seen = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file.name !== 'string' || file.name.length === 0) continue;
    if (file.name === MANIFEST_NAME) continue;
    seen.add(file.name);
    const prev = known[file.name];
    if (prev && prev.sha256 === file.sha256) {
      skip.push(file.name);
    } else {
      upload.push(file.name);
    }
  }
  const remove = Object.keys(known).filter((name) => !seen.has(name));
  return { upload, skip, remove };
}

// ── 文案 ──────────────────────────────────────────────────────────────────

function renderWorkspaceHelp() {
  return [
    '用法：',
    '  khy amoo workspace status [本地目录]        本地 ↔ /sdcard/amoo-dev 对账',
    '  khy amoo workspace push <本地目录>          上传哈希变动的文件（manifest 增量）',
    '  khy amoo workspace pull [本地目录]          把手机工作区拉回本地',
    '',
    '约定：',
    '  - 手机侧默认 /sdcard/amoo-dev（KHY_AMOO_WORKSPACE_DIR 可改）；',
    '  - 扁平文件，不递归子目录；manifest 是本地目录里的 ' + MANIFEST_NAME + '；',
    '  - 走 adb 通道：桥卡死时同步照样能用（与桥共存亡无关）。',
    '',
    '日常循环：push 让 Amoo 拿到最新代码 → 让它干活 → pull 收回结果。',
  ].join('\n');
}

function renderWorkspaceStatus({ localDir, remoteDir, local, remote, remoteSource, error }) {
  const lines = [];
  lines.push(`本地目录：${localDir || '（未指定）'}`);
  lines.push(`手机目录：${remoteDir}`);
  if (error) {
    lines.push(`手机侧读取失败：${error}`);
  }
  lines.push(`本地文件：${(local || []).length} 个`);
  if (remoteSource === 'bridge') {
    lines.push(`手机文件：${(remote || []).length} 个（来源：桥 ls）`);
  } else if (remoteSource === 'adb') {
    lines.push(`手机文件：${(remote || []).length} 个（来源：adb 名字列表，无大小）`);
  }
  for (const entry of remote || []) {
    if (typeof entry === 'string') {
      lines.push(`  - ${entry}`);
    } else {
      lines.push(`  - ${entry.name}（${entry.size} B）`);
    }
  }
  return lines.join('\n');
}

function renderPushResult({ upload, skip, remove, remoteDir }) {
  const lines = [];
  if (upload.length === 0) {
    lines.push('没有需要上传的文件（manifest 比对无变动）。');
  } else {
    lines.push(`已上传 ${upload.length} 个文件到 ${remoteDir}：`);
    for (const name of upload) lines.push(`  + ${name}`);
  }
  if (skip.length > 0) {
    lines.push(`跳过 ${skip.length} 个未变动文件。`);
  }
  if (remove.length > 0) {
    lines.push(`本地已删除、手机仍在（未擅自动手机上文件）：${remove.join('、')}`);
  }
  return lines.join('\n');
}

function renderPullResult({ pulled, localDir, failed }) {
  const lines = [];
  lines.push(`已拉回 ${(pulled || []).length} 个文件到 ${localDir}`);
  for (const name of pulled || []) lines.push(`  v ${name}`);
  for (const name of failed || []) lines.push(`  x ${name}（拉取失败）`);
  return lines.join('\n');
}

module.exports = {
  WORKSPACE_ACTIONS,
  DEFAULT_REMOTE_DIR,
  MANIFEST_NAME,
  parseWorkspaceArgv,
  buildRemoteListArgv,
  buildPushArgv,
  buildPullArgv,
  readManifest,
  writeManifest,
  planPush,
  renderWorkspaceHelp,
  renderWorkspaceStatus,
  renderPushResult,
  renderPullResult,
};
