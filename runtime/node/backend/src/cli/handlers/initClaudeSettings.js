'use strict';

/**
 * initClaudeSettings.js — `~/.claude/settings.json` 的冲突检查与自动修复
 *
 * 从 handlers/init.js 按 R4（上帝文件门）拆出。承载四件事：
 *   1. 读快照（settings.json 不存在 / JSON 非法 / 正常 三态）；
 *   2. 冲突判定（外部 AUTH_TOKEN 与 khy-* API_KEY 共存、双重认证、写入开关与外部 BASE_URL 共存）；
 *   3. 自动修复（移除冲突的 ANTHROPIC_API_KEY / 本地代理 ANTHROPIC_BASE_URL）；
 *   4. 两个布尔判定辅助（isTruthyFlag / isLoopbackUrl）——它们只服务于上面三件事，
 *      故随本单元一起搬走，init.js 侧同名 import，调用点逐字节不变。
 *
 * 拆分约束（CLAUDE.md §二 B3）：函数体逐字节搬迁，一行逻辑都不改。
 *
 * @module handlers/initClaudeSettings
 */

const fs = require('fs');
const path = require('path');

function isTruthyFlag(raw = '') {
  // 布尔解析走 parseBoolean 单一真源（base tier）。
  return require('../../utils/parseBoolean')(raw, false, { extended: false });
}

function isLoopbackUrl(raw = '') {
  const input = String(raw || '').trim();
  if (!input) {
    return false;
  }
  try {
    const parsed = new URL(input);
    const host = String(parsed.hostname || '')
      .trim()
      .toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function readClaudeSettingsSnapshot() {
  const os = require('os');
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    return {
      settingsPath,
      exists: false,
      parseError: null,
      settings: null,
      env: {},
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const settings = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
    return {
      settingsPath,
      exists: true,
      parseError: null,
      settings,
      env: { ...env },
    };
  } catch (err) {
    return {
      settingsPath,
      exists: true,
      parseError: err,
      settings: null,
      env: {},
    };
  }
}

function writeClaudeSettingsSnapshot(settingsPath, settings) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${settingsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, settingsPath);
}

function inspectClaudeSettingsConflict() {
  const snapshot = readClaudeSettingsSnapshot();

  if (!snapshot.exists) {
    return {
      ok: true,
      level: 'info',
      detail: '未发现 ~/.claude/settings.json（未检测到冲突项）',
      summary: '未发现 Claude 配置文件，无冲突',
    };
  }

  if (snapshot.parseError) {
    return {
      ok: false,
      level: 'warn',
      detail: `~/.claude/settings.json 解析失败：${String(snapshot.parseError?.message || 'invalid json').slice(0, 120)}`,
      summary: 'Claude 配置文件 JSON 解析失败',
      fix: '修复 ~/.claude/settings.json 的 JSON 语法（当前无法解析，Claude Code 会忽略它）',
    };
  }

  const env = snapshot.env;
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const apiKey = String(env.ANTHROPIC_API_KEY || '').trim();
  const baseUrl = String(env.ANTHROPIC_BASE_URL || '').trim();
  const hasAnyAuth = !!authToken || !!apiKey;
  const hasDualAuth = !!authToken && !!apiKey;
  const hasKhyApiKey = apiKey.startsWith('khy-');
  const hasExternalBaseUrl = !!baseUrl && !isLoopbackUrl(baseUrl);
  const writeSettingsEnabled =
    isTruthyFlag(process.env.KHY_ALLOW_WRITE_CLAUDE_SETTINGS) ||
    isTruthyFlag(process.env.KHY_MANAGE_CLAUDE_SETTINGS);

  const fixClaudeConflict =
    '运行 khy doctor --fix-claude-conflict 自动修复，或手工清理 ~/.claude/settings.json 中冲突认证项';

  if (hasDualAuth && hasKhyApiKey && hasExternalBaseUrl) {
    return {
      ok: false,
      level: 'warn',
      detail:
        '检测到外部 AUTH_TOKEN + khy-* API_KEY + 外部 BASE_URL，存在高风险冲突（建议删除 settings.json 中 ANTHROPIC_API_KEY）',
      summary: '外部 AUTH_TOKEN 与 khy API_KEY 高风险共存',
      fix: fixClaudeConflict,
    };
  }

  if (hasDualAuth && hasKhyApiKey) {
    return {
      ok: false,
      level: 'warn',
      detail: '检测到同时存在 AUTH_TOKEN 与 khy-* API_KEY（建议仅保留一种认证方式）',
      summary: 'AUTH_TOKEN 与 khy API_KEY 同时存在',
      fix: fixClaudeConflict,
    };
  }

  if (hasDualAuth) {
    return {
      ok: false,
      level: 'warn',
      detail: '检测到同时配置 AUTH_TOKEN 与 API_KEY（Claude Code 可能拒绝请求，建议只保留一种）',
      summary: 'Claude 认证项双重配置，请求可能被拒',
      fix: fixClaudeConflict,
    };
  }

  if (!hasAnyAuth) {
    return {
      ok: true,
      level: 'info',
      detail: '未检测到 Claude 认证项（若使用直连 Claude，请配置 AUTH_TOKEN 或 API_KEY）',
      summary: '未发现 KHY 与 Claude 的配置冲突',
    };
  }

  if (writeSettingsEnabled && hasExternalBaseUrl) {
    return {
      ok: false,
      level: 'warn',
      detail:
        '检测到已开启 Claude settings 写入开关且使用外部 BASE_URL（建议关闭 KHY_ALLOW_WRITE_CLAUDE_SETTINGS）',
      summary: 'Claude 写入开关与外部 BASE_URL 共存',
      fix: '关闭 KHY_ALLOW_WRITE_CLAUDE_SETTINGS / KHY_MANAGE_CLAUDE_SETTINGS 环境变量',
    };
  }

  return {
    ok: true,
    level: 'info',
    detail: '未发现 KHY 与 Claude 的配置冲突',
    summary: '未发现 KHY 与 Claude 的配置冲突',
  };
}

function fixClaudeSettingsConflict() {
  const snapshot = readClaudeSettingsSnapshot();
  if (!snapshot.exists) {
    return { ok: true, changed: false, detail: '未发现 ~/.claude/settings.json，无需修复' };
  }
  if (snapshot.parseError || !snapshot.settings) {
    return {
      ok: false,
      changed: false,
      detail: `无法修复：settings.json 解析失败（${String(snapshot.parseError?.message || 'invalid json').slice(0, 120)}）`,
    };
  }

  const env = { ...(snapshot.env || {}) };
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const apiKey = String(env.ANTHROPIC_API_KEY || '').trim();
  const baseUrl = String(env.ANTHROPIC_BASE_URL || '').trim();
  const hasAuthToken = !!authToken;
  const hasApiKey = !!apiKey;
  const hasKhyApiKey = apiKey.startsWith('khy-');
  const hasExternalBaseUrl = !!baseUrl && !isLoopbackUrl(baseUrl);
  const actions = [];

  if (hasKhyApiKey && (hasAuthToken || hasExternalBaseUrl)) {
    delete env.ANTHROPIC_API_KEY;
    actions.push('移除冲突的 ANTHROPIC_API_KEY (khy-*)');
  }

  if (hasAuthToken && isLoopbackUrl(baseUrl)) {
    delete env.ANTHROPIC_BASE_URL;
    actions.push('移除本地代理 ANTHROPIC_BASE_URL，保留外部 AUTH_TOKEN');
  }

  if (actions.length === 0) {
    if (hasAuthToken && hasApiKey) {
      return {
        ok: false,
        changed: false,
        detail: '检测到双认证但 API_KEY 非 khy-*，请手动决定保留 AUTH_TOKEN 或 API_KEY',
      };
    }
    return { ok: true, changed: false, detail: '未发现可自动修复的冲突项' };
  }

  try {
    const nextSettings = {
      ...snapshot.settings,
      env,
    };
    writeClaudeSettingsSnapshot(snapshot.settingsPath, nextSettings);
    return {
      ok: true,
      changed: true,
      detail: actions.join('；'),
    };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      detail: `写入失败：${String(err?.message || err).slice(0, 160)}`,
    };
  }
}

module.exports = {
  isTruthyFlag,
  isLoopbackUrl,
  readClaudeSettingsSnapshot,
  writeClaudeSettingsSnapshot,
  inspectClaudeSettingsConflict,
  fixClaudeSettingsConflict,
};
