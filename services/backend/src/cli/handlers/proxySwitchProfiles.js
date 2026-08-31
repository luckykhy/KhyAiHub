'use strict';

/**
 * Proxy switch-profile subsystem (extracted from cli/handlers/proxy.js).
 *
 * Owns the Switch-Center meta-dispatcher (normalizeSwitchCenterProvider / resolveSwitchCenterCall /
 * resolveDefaultSwitchCenterProvider / isSwitchCenterAutoSyncEnabled / resolveAutoSyncCooldownMs /
 * maybeAutoSyncSwitchCenter / printSwitchCenterHelp / handleProxySwitchCenter) that dispatches to the
 * Trae switch handler. Extracted verbatim (byte-identical bodies) as a same-directory sibling leaf so
 * in-body relative require() paths resolve identically; the host re-imports handleProxySwitchCenter /
 * maybeAutoSyncSwitchCenter by the same names to keep the `proxy switch-center` command contract unchanged.
 *
 * 2026-09-23：Windsurf 适配器随其 IDE 被 Cognition 退役更名 Devin Desktop 而下线（Cascade 2026-07-01 停服）。
 * 本子系统的 windsurf 命令面（`proxy windsurf-switch` / `--provider windsurf`）与 windsurf profile store
 * 一并物理删除，switch-center 收敛为 trae-only。
 *
 * This leaf performs IO (adapter sync, upstream/local proxy probes, .env-driven profile apply, terminal
 * output) so it does NOT self-declare as a pure zero-IO leaf. The host callbacks it still needs (shared
 * parse helper, the Trae sync + Trae switch handler it dispatches to) are injected via
 * setProxySwitchProfilesDeps to avoid a require cycle back into the host. parseBooleanMaybe is re-required
 * directly (pure module util); the switch-center auto-sync cooldown Map is used only here and was moved in
 * wholesale.
 */

const chalkModule = require('chalk');

const chalk = chalkModule.default || chalkModule;
const http = require('http');
const https = require('https');
const path = require('path');

const parseBooleanMaybe = require('../../utils/parseBoolean');
const { printSuccess, printError, printInfo } = require('../formatters');

// ── Switch-center auto-sync cooldown state (used only by this subsystem; moved out of the host verbatim) ──
const _switchCenterAutoSyncState = new Map();

// ── Host callbacks injected via DI (avoid a require cycle back into proxy.js) ──
let parsePositiveInt = null;
let syncTraeSwitchProfileFromAdapter = null;
let handleProxyTraeSwitch = null;

function setProxySwitchProfilesDeps(deps = {}) {
  if (typeof deps.parsePositiveInt === 'function') {
    parsePositiveInt = deps.parsePositiveInt;
  }
  if (typeof deps.syncTraeSwitchProfileFromAdapter === 'function') {
    syncTraeSwitchProfileFromAdapter = deps.syncTraeSwitchProfileFromAdapter;
  }
  if (typeof deps.handleProxyTraeSwitch === 'function') {
    handleProxyTraeSwitch = deps.handleProxyTraeSwitch;
  }
}

function normalizeSwitchCenterProvider(raw = '') {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (!value) {
    return '';
  }
  if (['auto', 'smart', 'fallback'].includes(value)) {
    return 'auto';
  }
  if (['trae', 'nirvana', 'nir', 'nrv'].includes(value)) {
    return 'trae';
  }
  if (['all', '*', 'both', '全部'].includes(value)) {
    return 'all';
  }
  return '';
}

function resolveSwitchCenterCall(action = 'status', args = [], options = {}) {
  let nextAction = String(action || 'status')
    .trim()
    .toLowerCase();
  let nextArgs = Array.isArray(args) ? [...args] : [];
  let provider = normalizeSwitchCenterProvider(options.provider || options.p || '');

  const providerByAction = normalizeSwitchCenterProvider(nextAction);
  if (providerByAction && providerByAction !== 'all') {
    provider = providerByAction;
    nextAction = String(nextArgs[0] || 'status')
      .trim()
      .toLowerCase();
    nextArgs = nextArgs.slice(1);
  } else if (!provider) {
    const providerByFirstArg = normalizeSwitchCenterProvider(nextArgs[0] || '');
    if (providerByFirstArg && providerByFirstArg !== 'all') {
      provider = providerByFirstArg;
      nextArgs = nextArgs.slice(1);
    }
  }

  return { provider, action: nextAction, args: nextArgs };
}

function resolveDefaultSwitchCenterProvider(action = 'status') {
  if (['sync', 'refresh', 'import'].includes(String(action || '').toLowerCase())) {
    return 'auto';
  }
  return 'trae';
}

function isSwitchCenterAutoSyncEnabled(options = {}) {
  if (options.enabled !== undefined) {
    return parseBooleanMaybe(options.enabled, true);
  }
  if (options.autoSync !== undefined) {
    return parseBooleanMaybe(options.autoSync, true);
  }
  if (process.env.SWITCH_CENTER_AUTO_SYNC !== undefined) {
    return parseBooleanMaybe(process.env.SWITCH_CENTER_AUTO_SYNC, true);
  }
  if (process.env.KHY_SWITCH_CENTER_AUTO_SYNC !== undefined) {
    return parseBooleanMaybe(process.env.KHY_SWITCH_CENTER_AUTO_SYNC, true);
  }
  // Default on: keeps switch-center models "read-and-use" without manual sync.
  return true;
}

function resolveAutoSyncCooldownMs(options = {}) {
  const raw =
    options.cooldownMs ??
    options['cooldown-ms'] ??
    process.env.SWITCH_CENTER_AUTO_SYNC_COOLDOWN_MS ??
    process.env.KHY_SWITCH_CENTER_AUTO_SYNC_COOLDOWN_MS ??
    '45000';
  const value = parsePositiveInt(raw, 45000);
  return Math.min(Math.max(value, 5000), 10 * 60 * 1000);
}

/**
 * Auto-sync provider profile into switch-center store and apply it immediately.
 * This mirrors Kiro-like auto-discovery behavior and avoids requiring explicit
 * "proxy switch-center sync" before model usage.
 *
 * 2026-09-23：Windsurf 下线后收敛为 trae-only；`auto` / `all` 等价于 trae，
 * 原双通道降级（先首选、失败再降级）随之删除。
 */
async function maybeAutoSyncSwitchCenter(options = {}) {
  const enabled = isSwitchCenterAutoSyncEnabled(options);
  if (!enabled) {
    return { synced: false, skipped: true, reason: 'disabled' };
  }

  const provider =
    normalizeSwitchCenterProvider(
      options.provider ||
        process.env.SWITCH_CENTER_AUTO_PROVIDER ||
        process.env.KHY_SWITCH_CENTER_AUTO_PROVIDER ||
        'auto'
    ) || 'auto';
  if (provider !== 'auto' && provider !== 'all' && provider !== 'trae') {
    return { synced: false, skipped: true, reason: `unsupported-provider:${provider}` };
  }

  const cooldownMs = resolveAutoSyncCooldownMs(options);
  const force = parseBooleanMaybe(options.force, false);
  const quiet = parseBooleanMaybe(options.quiet, true);
  const key = 'provider:trae';
  const now = Date.now();
  const state = _switchCenterAutoSyncState.get(key) || { lastAt: 0, inFlight: null };
  if (!force && state.lastAt > 0 && now - state.lastAt < cooldownMs) {
    return { synced: false, skipped: true, reason: 'cooldown' };
  }
  if (state.inFlight) {
    return state.inFlight;
  }

  const task = (async () => {
    state.lastAt = Date.now();
    try {
      const result = await syncTraeSwitchProfileFromAdapter({
        activate: true,
        id:
          options.id ||
          process.env.SWITCH_CENTER_AUTO_TRAE_PROFILE_ID ||
          process.env.SWITCH_CENTER_AUTO_PROFILE_ID ||
          'trae-auto',
        name:
          options.name ||
          process.env.SWITCH_CENTER_AUTO_TRAE_PROFILE_NAME ||
          process.env.SWITCH_CENTER_AUTO_PROFILE_NAME ||
          'Trae Auto',
        endpoint: options.endpoint || process.env.SWITCH_CENTER_AUTO_ENDPOINT || '',
        key: options.key || process.env.SWITCH_CENTER_AUTO_KEY || '',
        model: options.model || process.env.SWITCH_CENTER_AUTO_MODEL || '',
      });
      const payload = {
        synced: true,
        skipped: false,
        provider: 'trae',
        changed: !!result.changed,
        activeChanged: !!result.activeChanged,
        profileId: result.profile?.id || '',
        profileName: result.profile?.name || '',
        modelsCount: Array.isArray(result.profile?.models) ? result.profile.models.length : 0,
      };
      if (!quiet && (payload.changed || payload.activeChanged)) {
        printInfo(
          `switch-center 自动同步完成: ${payload.profileName || payload.profileId} (${payload.modelsCount} models)`
        );
      }
      return payload;
    } catch (err) {
      const message = err?.message || String(err || 'auto sync failed');
      if (!quiet) {
        printInfo(`switch-center 自动同步跳过: ${message}`);
      }
      return {
        synced: false,
        skipped: true,
        provider: 'trae',
        reason: 'sync-failed',
        error: message,
      };
    } finally {
      state.inFlight = null;
      _switchCenterAutoSyncState.set(key, state);
    }
  })();

  state.inFlight = task;
  _switchCenterAutoSyncState.set(key, state);
  return task;
}

function printSwitchCenterHelp() {
  console.log('');
  console.log(chalk.cyan.bold('  proxy switch-center 命令'));
  console.log('');
  console.log(chalk.dim('  proxy switch-center status'));
  console.log(chalk.dim('  proxy switch-center list'));
  console.log(chalk.dim('  proxy switch-center status --provider trae'));
  console.log(chalk.dim('  proxy switch-center sync [--provider trae]'));
  console.log(chalk.dim('  proxy switch-center use <id|名称> [--provider trae]'));
  console.log(chalk.dim('  proxy switch-center remove <id|名称> [--provider trae]'));
  console.log(chalk.dim('  proxy switch-center test [id|名称] [--provider trae] [--model xxx]'));
  console.log('');
  console.log(chalk.dim('  说明:'));
  console.log(chalk.dim('    1) 默认 provider 为 trae'));
  console.log(chalk.dim('    2) sync 支持 Trae 登录态自动发现'));
  console.log(
    chalk.dim(
      '    3) gateway status / gateway model 默认自动触发 switch-center 同步（可用 SWITCH_CENTER_AUTO_SYNC=false 关闭）'
    )
  );
  console.log(chalk.dim('    4) 保留 trae-switch 兼容旧脚本'));
  console.log('');
}

async function handleProxySwitchCenter(action = 'status', args = [], options = {}) {
  const parsed = resolveSwitchCenterCall(action, args, options);
  const sub = String(parsed.action || 'status').toLowerCase();

  if (!sub || sub === 'help') {
    printSwitchCenterHelp();
    return;
  }

  if (sub === 'status' || sub === 'list' || sub === 'show') {
    await handleProxyTraeSwitch('status', parsed.args, options);
    return;
  }

  const provider = parsed.provider || resolveDefaultSwitchCenterProvider(sub);
  if (
    (sub === 'sync' || sub === 'refresh' || sub === 'import') &&
    (provider === 'auto' || provider === 'all')
  ) {
    const result = await maybeAutoSyncSwitchCenter({
      ...options,
      provider: 'auto',
      quiet: false,
      force: true,
      name: options.name || parsed.args[0] || '',
    });
    if (result && result.synced) {
      printSuccess('switch-center 同步成功: trae');
      return;
    }
    printError(`switch-center 同步失败: ${result?.error || result?.reason || 'unknown error'}`);
    return;
  }
  if (provider === 'trae') {
    await handleProxyTraeSwitch(sub, parsed.args, { ...options, provider: 'trae' });
    return;
  }

  printError(`switch-center 无法识别 provider: ${provider}`);
  printSwitchCenterHelp();
}

module.exports = {
  handleProxySwitchCenter,
  maybeAutoSyncSwitchCenter,
  setProxySwitchProfilesDeps,
};
