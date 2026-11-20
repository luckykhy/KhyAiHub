'use strict';

/**
 * index.js — assembly facade for the Android GUI loop:
 * dump -> uidref digest -> act by ref -> screendiff re-check.
 *
 * Desktop only, no phone-side APK: adb runs `exec-out uiautomator dump` and
 * `shell input ...`; element references and change detection come from the
 * vendored android-agent-kit (uidref / screendiff).
 *
 * Why the vendor path lives here: this is the only place that spells it out; the
 * adapter receives the modules by injection, and tests inject the same real
 * modules or replay stubs. Depth: androidRef -> phone -> network -> domain ->
 * services -> src -> backend, exactly 6 levels. One level less lands in
 * src/vendor (absent), one more escapes backend. Verify with
 * `check-repo-layout --list=unresolved-require` (baseline 0).
 */

const phone = require('../index.js');
const { createUidrefAdapter, findElement } = require('./uidrefAdapter');
const {
  planAndroidUiAction,
  buildDeviceArgs,
  checkTarget,
  verdictOfEffect,
  verdictOfScreenChange,
} = require('./androidUiPolicy');

const uidref = require('../../../../../../vendor/android-agent-kit/uidref/js/uidref.js');
const screendiff = require('../../../../../../vendor/android-agent-kit/screendiff/js/screendiff.js');

const VERIFY_DEFAULT_MS = 20000;
const MAX_DUMP_OUTPUT_CHARS = 512 * 1024;

/**
 * Settle budget after a write action.
 *
 * This is a short I/O wait before the second frame, not a task deadline: nothing
 * is killed, and when the budget is used up the second dump still happens and the
 * verdict is reported from whatever evidence exists. Registered as a numeric flag.
 */
function resolveVerifyMs(env = process.env) {
  try {
    // eslint-disable-next-line global-require
    return require('../../../../../utils/flagRegistry').resolveNumeric('KHY_ANDROID_UI_VERIFY_MS', env);
  } catch {
    return VERIFY_DEFAULT_MS;
  }
}

function _defaultRunAdb(config) {
  const transport = phone.createAdbTransport({
    adbExecutable: config.adbExecutable,
    timeoutMs: Number(config.adbTimeoutMs) > 0 ? Number(config.adbTimeoutMs) : undefined,
    maxOutputChars: MAX_DUMP_OUTPUT_CHARS,
  });
  return (argv, runOptions) => transport.run(argv, runOptions);
}

/**
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {object} [options.config]      override the resolved phoneBridgeConfig (tests)
 * @param {function} [options.runAdb]    injected adb transport
 * @param {function} [options.sleep]     injected wait (tests skip the real 20s)
 * @param {object} [options.uidref]      injected vendored uidref
 * @param {function} [options.diff]      injected screendiff.diff
 * @param {function} [options.effectOf]  injected screendiff.effectOf
 */
function createAndroidRef(options = {}) {
  const env = options.env || process.env;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const config = options.config || Object.assign(
    {},
    phone.resolvePhoneBridgeConfig(env),
    { adbExecutable: phone.resolveAdbExecutableProbed(env) }
  );
  const runAdb = typeof options.runAdb === 'function' ? options.runAdb : _defaultRunAdb(config);
  const diff = typeof options.diff === 'function' ? options.diff : screendiff.diff;
  const effectOf = typeof options.effectOf === 'function' ? options.effectOf : screendiff.effectOf;

  const adapter = createUidrefAdapter({
    config,
    env,
    runAdb,
    uidref: options.uidref || uidref,
    buildAdbArgv: options.buildAdbArgv || ((cfg, args) => phone.buildAdbArgv(cfg, args)),
    maxOutputChars: options.maxOutputChars || MAX_DUMP_OUTPUT_CHARS,
    timeoutMs: options.timeoutMs,
  });

  /**
   * Public read entry. It goes through the same policy as run() so the
   * KHY_ANDROID_UI_DUMP gate cannot be bypassed by calling snapshot() directly:
   * a future caller must not get an ungated screen-read door.
   */
  async function snapshot() {
    const planned = planAndroidUiAction({ action: 'snapshot' }, { env });
    if (!planned.success) {
      return planned;
    }
    return adapter.snapshot();
  }

  async function run(input = {}) {
    const planned = planAndroidUiAction(input, { env });
    if (!planned.success) {
      return planned;
    }
    const action = planned.action;
    if (action === 'snapshot') {
      return snapshot();
    }

    const steps = [];
    const prev = await adapter.snapshot();
    if (!prev.success) {
      return Object.assign({}, prev, {
        action,
        hint: prev.hint || '先让界面静止，再重试；ref 必须有当前帧快照才能解析。',
      });
    }
    steps.push(`1/3 抓取当前界面：${prev.package || '未知包'} 元素 ${prev.elements.length} 个`);

    const ref = planned.plan.ref;
    const element = ref ? findElement(prev, ref) : null;
    const blocked = checkTarget(action, element);
    if (blocked) {
      return {
        success: false,
        action,
        ref,
        code: blocked.code,
        error: blocked.error,
        hint: blocked.hint,
        snapshotId: prev.snapshotId,
        digest: prev.digest,
        steps,
      };
    }

    const deviceArgs = buildDeviceArgs({
      action,
      element,
      text: input && input.text,
      direction: planned.plan.direction,
      distance: planned.plan.distance,
    });
    if (!deviceArgs) {
      return {
        success: false,
        action,
        ref,
        code: 'invalid_args',
        error: '动作参数不足，未能生成设备侧指令',
        hint: 'tap/longpress/swipe 需要 ref 解析出中心点；type 需要码表内的文本。',
        steps,
      };
    }

    const argv = phone.buildAdbArgv(config, deviceArgs);
    steps.push(`2/3 发送 ${deviceArgs.join(' ')}（目标 ${ref || planned.plan.target}）`);

    let actRes;
    try {
      actRes = await runAdb(argv, {
        timeoutMs: Number(config.adbTimeoutMs) > 0 ? Number(config.adbTimeoutMs) : undefined,
      });
    } catch (err) {
      return {
        success: false,
        action,
        ref,
        executed: false,
        code: 'action_failed',
        error: `adb 指令未执行完：${(err && err.message) || String(err)}`,
        hint: '先 action:"snapshot" 确认手机仍在线，再重试。',
        steps,
      };
    }

    if (!actRes || actRes.ok !== true) {
      const detail = phone.redactSecrets((actRes && (actRes.stderr || actRes.stdout)) || '无输出');
      return {
        success: false,
        action,
        ref,
        executed: false,
        code: 'action_failed',
        error: `adb 指令被拒绝或失败：${detail}`,
        hint: '指令可能未被设备接受（离线/权限/界面不接收该动作）；先 snapshot 看现状再决定下一步。',
        steps,
      };
    }

    const verifyMs = resolveVerifyMs(env);
    await sleep(verifyMs);

    const cur = await adapter.snapshot();
    if (!cur.success) {
      return {
        success: true,
        action,
        ref,
        executed: true,
        effective: null,
        code: 'verify_unavailable',
        message: `${deviceArgs.slice(1).join(' ')} 已发送到${ref ? `元素 ${ref}` : planned.plan.target}；等待 ${verifyMs}ms 后复检抓取失败（${cur.error}），无法判断是否生效——不把没有证据当作未生效。`,
        verifyMs,
        steps: steps.concat(`3/3 复检失败：${cur.code}`),
      };
    }

    let verdict;
    try {
      const changeSet = diff(prev, cur);
      verdict = ref
        ? verdictOfEffect(effectOf(changeSet, ref), ref)
        : verdictOfScreenChange(changeSet);
    } catch (err) {
      verdict = {
        effective: null,
        conclusion: 'verify_error',
        changes: [],
        message: `复检解析失败（${(err && err.message) || String(err)}）——无法判断是否生效，不把没有证据当作未生效`,
      };
    }
    steps.push(`3/3 复检完成：${verdict.conclusion}`);

    return {
      success: true,
      action,
      ref,
      executed: true,
      effective: verdict.effective,
      verdict: verdict.conclusion,
      changes: verdict.changes,
      message: verdict.message,
      verifyMs,
      snapshotId: cur.snapshotId,
      digest: cur.digest,
      metrics: cur.metrics,
      steps,
    };
  }

  return {
    config,
    snapshot,
    run,
    resolveVerifyMs: () => resolveVerifyMs(env),
  };
}

let singleton = null;

/** Lazy singleton: requiring this directory spawns no adb and resolves no serial. */
function getAndroidRef(env = process.env) {
  if (!singleton) {
    singleton = createAndroidRef({ env });
  }
  return singleton;
}

function resetAndroidRefForTests() {
  singleton = null;
}

module.exports = {
  MAX_DUMP_OUTPUT_CHARS,
  VERIFY_DEFAULT_MS,
  createAndroidRef,
  getAndroidRef,
  resetAndroidRefForTests,
  resolveVerifyMs,
  findElement,
};
