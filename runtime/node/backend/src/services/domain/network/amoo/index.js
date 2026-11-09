'use strict';

/**
 * index.js — star-assembly facade for the Amoo collaboration unit.
 *
 * One import point for every consumer. Siblings never require each other: the
 * leaves (config / policy / plan / snapshot) are pure and dependency-free, the
 * shells (client / mailbox / runner) take their collaborators through the
 * constructor, and this file is the only place they are wired together.
 *
 * Why a facade at all: the unit has three shells with a strict order
 * (runner → client → adb) plus a fallback (mailbox → client). Letting consumers
 * build that order themselves is how the wiring drifts; here it is built once
 * and `resetAmooForTests()` gives tests a clean slate.
 *
 * The read-only panel lane rides along here too: `AmooStatusProvider` (the only
 * shell that caches collectStatus for a UI) and `buildAmooPanelModel` (the pure
 * leaf that turns a snapshot into rows). Both are exported as references — the
 * provider is deliberately NOT instantiated here, because a panel that is never
 * opened must never have started a poll timer.
 *
 * The tool-name / risk contract rides along as a read-only exit too:
 * `getAmooToolContract()` hands out the frozen `amooToolContract.json`
 * projection. It changes no runtime behaviour (D1-1 部分) — it exists so the
 * five tool lists that drifted apart can be compared against one coordinate.
 *
 * Nothing at module load touches the filesystem or the phone: `getAppDataDir`
 * is passed as a function and only called when a scratch file is actually
 * needed.
 *
 * @module services/domain/network/amoo
 */

const { resolveAmooConfig } = require('./amooBridgeConfig');
const { AmooBridgeClient } = require('./amooBridgeClient');
const { AmooBridgeMailbox } = require('./amooMailbox');
const { AmooDispatchRunner } = require('./amooDispatchRunner');
const { buildAmooPanelModel } = require('./amooPanelViewModel');
const { AmooStatusProvider } = require('./amooStatusProvider');
const dataHome = require('../../../../utils/dataHome');
const fs = require('fs');
const path = require('path');

const TOOL_CONTRACT_PATH = path.join(__dirname, 'amooToolContract.json');
let toolContractCache = null;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * 只读出口：工具名 / 风险契约（纯数据投影）。
 *
 * WHY 惰性读盘：本单元的纪律是「模块装载不碰磁盘不碰手机」，require 本文件
 * 不该有任何 IO，故第一次调用才读并缓存。WHY 冻结：契约是坐标不是配置，
 * 谁改它就等于改了坐标 —— 冻结让改动只能发生在那个 JSON 文件里。
 *
 * 口径 D1-1 部分：契约不驱动运行期行为，也不新增任何可调用能力。
 * @returns {{tools_contract_version:string, tools:object[]}}
 */
function getAmooToolContract() {
  if (!toolContractCache) {
    toolContractCache = deepFreeze(
      JSON.parse(fs.readFileSync(TOOL_CONTRACT_PATH, 'utf8')),
    );
  }
  return toolContractCache;
}

/**
 * Build a fresh, fully wired stack. Tests use this with injected fakes.
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {object} [opts.config]
 * @param {Function} [opts.spawnImpl]
 * @param {Function} [opts.sleep]
 * @param {Function} [opts.now]
 * @param {Function} [opts.getAppDataDir]
 * @returns {{config:object, client:AmooBridgeClient, mailbox:AmooBridgeMailbox,
 *            runner:AmooDispatchRunner}}
 */
function createAmooStack(opts = {}) {
  const config = opts.config || resolveAmooConfig(opts.env || process.env);
  const getAppDataDir =
    typeof opts.getAppDataDir === 'function' ? opts.getAppDataDir : dataHome.getAppDataDir;
  const shared = {
    spawnImpl: opts.spawnImpl,
    sleep: opts.sleep,
    now: opts.now,
  };
  const client = new AmooBridgeClient({ config, ...shared });
  const mailbox = new AmooBridgeMailbox({ config, client, getAppDataDir, ...shared });
  const runner = new AmooDispatchRunner({ config, client, mailbox, getAppDataDir, ...shared });
  return { config, client, mailbox, runner };
}

const defaultStack = createAmooStack();

/**
 * Drop cached secrets/state on the default stack. Called by tests between cases
 * so a token fetched for one device never leaks into the next.
 * @returns {{ok:boolean}}
 */
function resetAmooForTests() {
  defaultStack.client.invalidateToken();
  return { ok: true };
}

module.exports = {
  ...defaultStack,
  createAmooStack,
  resetAmooForTests,
  resolveAmooConfig,
  AmooBridgeClient,
  AmooBridgeMailbox,
  AmooDispatchRunner,
  AmooStatusProvider,
  buildAmooPanelModel,
  dataHome,
  getAmooToolContract,
};
