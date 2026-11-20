'use strict';

/**
 * uidrefAdapter.js — thin IO shell: uiautomator dump -> uidref snapshot.
 *
 * Why this has its own 512KB output cap: the phone bridge's adb cap is 64KB, and a
 * real settings screen dumps ~276KB. A truncated dump gets the
 * "...[adb 输出已截断]" tail appended and is then handed to an XML parser, which
 * yields a partial element set — tapping a ref from that set taps the wrong
 * control. The cap is 512KB here, and a truncated dump is a hard failure: never
 * guess half a screen.
 *
 * uidref is injected by index.js (the only place with the vendor path); tests
 * inject either the same real module or a replay stub.
 */

const { buildDumpDeviceArgs } = require('./androidUiPolicy');

const DEFAULT_MAX_OUTPUT_CHARS = 512 * 1024;
const DEFAULT_ADB_TIMEOUT_MS = 15000;

function _pickTimeoutMs(config, explicit) {
  if (Number(explicit) > 0) {
    return Number(explicit);
  }
  if (Number(config && config.adbTimeoutMs) > 0) {
    return Number(config.adbTimeoutMs);
  }
  return DEFAULT_ADB_TIMEOUT_MS;
}

/**
 * @param {object} options
 * @param {object} options.config          resolved phoneBridgeConfig (serial / adbTimeoutMs)
 * @param {function} options.runAdb        adb transport run(argv, opts)
 * @param {object} options.uidref          vendored uidref module (parse / digest)
 * @param {function} options.buildAdbArgv  (config, args[]) => argv[], adds -s <serial>
 * @param {object} [options.env]
 * @param {number} [options.maxOutputChars]
 * @param {number} [options.timeoutMs]
 */
function createUidrefAdapter(options = {}) {
  const config = options.config || {};
  const runAdb = typeof options.runAdb === 'function' ? options.runAdb : null;
  const uidref = options.uidref || null;
  const buildAdbArgv = typeof options.buildAdbArgv === 'function' ? options.buildAdbArgv : null;
  const env = options.env || process.env;
  const maxOutputChars = Number(options.maxOutputChars) > 0
    ? Number(options.maxOutputChars)
    : DEFAULT_MAX_OUTPUT_CHARS;
  const timeoutMs = _pickTimeoutMs(config, options.timeoutMs);

  function _misconfigured() {
    const missing = [];
    if (!runAdb) missing.push('runAdb');
    if (!buildAdbArgv) missing.push('buildAdbArgv');
    if (!uidref || typeof uidref.parse !== 'function' || typeof uidref.digest !== 'function') {
      missing.push('uidref');
    }
    if (!missing.length) {
      return null;
    }
    return {
      success: false,
      code: 'adapter_misconfigured',
      error: `androidRef 适配层未装配完整：缺 ${missing.join(' / ')}`,
      hint: '生产侧由 phone/androidRef/index.js 注入；测试请传 runAdb 与 vendored uidref 模块。',
    };
  }

  async function snapshot() {
    const broken = _misconfigured();
    if (broken) {
      return broken;
    }

    let argv;
    try {
      argv = buildAdbArgv(config, buildDumpDeviceArgs(env));
    } catch (err) {
      return {
        success: false,
        code: 'dump_failed',
        error: `构造 adb 指令失败：${(err && err.message) || String(err)}`,
        hint: '检查手机串号配置（KHY_PHONE_BRIDGE_SERIAL）与 adb 可执行文件路径。',
      };
    }

    let res;
    try {
      res = await runAdb(argv, { timeoutMs, maxOutputChars });
    } catch (err) {
      return {
        success: false,
        code: 'dump_failed',
        error: `uiautomator dump 未执行完：${(err && err.message) || String(err)}`,
        hint: '确认手机在线（khy phone status）且无线调试仍授权。',
      };
    }

    if (!res || res.ok !== true) {
      const detail = String((res && (res.stderr || res.stdout)) || '无输出').trim();
      return {
        success: false,
        code: 'dump_failed',
        error: `uiautomator dump 返回失败：${detail || '无输出'}`,
        hint: '确认手机在线且当前界面不是安全界面（锁屏/支付页会拒绝 dump）；重试前先让界面静止。',
        truncated: !!(res && res.truncated === true),
      };
    }

    if (res.truncated === true) {
      return {
        success: false,
        code: 'dump_truncated',
        error: `dump 输出超过 ${maxOutputChars} 字符上限，已被截断`,
        hint: '截断的 XML 解析出来是残缺元素集，按它点按会点错控件，所以本次直接判失败；换一个元素更少的界面，或调大 maxOutputChars。',
        truncated: true,
      };
    }

    const xml = String(res.stdout == null ? '' : res.stdout);
    if (!xml.trim()) {
      return {
        success: false,
        code: 'dump_empty',
        error: 'uiautomator dump 返回空内容',
        hint: '界面可能正在动画或无障碍服务未就绪；等待后重试一次。',
      };
    }

    let parsed;
    try {
      parsed = uidref.parse(xml);
    } catch (err) {
      return {
        success: false,
        code: 'dump_unparsable',
        error: `dump XML 解析失败：${(err && err.message) || String(err)}`,
        hint: '输出不是完整 XML（可能是别的进程的日志混进了 stdout）；重试一次，仍失败就换 dump 目标路径（KHY_ANDROID_UI_DUMP_PATH）。',
      };
    }

    // Upstream metrics()/digest() closures miss snapshot_id (uidref.js:320-321):
    // p.metrics() yields snapshot_id: undefined and p.digest()'s first line is
    // "[undefined]". The standalone uidref.digest(parsed) reads parsed.snapshot_id,
    // so both projections are rebuilt here. They are also wrapped: a parsed result
    // without metrics/digest must surface as a structured failure, not a throw.
    let metrics;
    let digestText;
    try {
      metrics = Object.assign({}, parsed.metrics(), { snapshot_id: parsed.snapshot_id });
      digestText = uidref.digest(parsed);
    } catch (err) {
      return {
        success: false,
        code: 'digest_failed',
        error: `snapshot 摘要计算失败：${(err && err.message) || String(err)}`,
        hint: 'dump 抓到了但 digest/metrics 算不出来——uidref 的返回形状可能变了；检查 vendor/android-agent-kit 是否被改动，或重试一次。',
        snapshotId: parsed && parsed.snapshot_id ? parsed.snapshot_id : null,
      };
    }

    return {
      success: true,
      action: 'snapshot',
      snapshotId: parsed.snapshot_id,
      package: parsed.package,
      digest: digestText,
      metrics,
      elements: parsed.elements,
      truncated: false,
    };
  }

  return {
    config,
    maxOutputChars,
    timeoutMs,
    buildDumpArgv() {
      return buildAdbArgv ? buildAdbArgv(config, buildDumpDeviceArgs(env)) : null;
    },
    snapshot,
  };
}

/** Find an element by ref from the current frame; null means stale_ref upstream. */
function findElement(snapshot, ref) {
  if (!snapshot || !Array.isArray(snapshot.elements)) {
    return null;
  }
  const target = String(ref == null ? '' : ref);
  return snapshot.elements.find((element) => element && element.ref === target) || null;
}

module.exports = {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_ADB_TIMEOUT_MS,
  createUidrefAdapter,
  findElement,
};
