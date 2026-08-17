'use strict';

/**
 * gatewayResetService.js — 薄壳:判断、询问、重置网关配置。
 *
 * 调用纯叶子 gatewayResetPolicy.js 的重置判定与出厂默认值,处理 IO 操作。
 */

const readline = require('readline');

const { printWarn, printInfo, printSuccess } = require('../cli/formatters');

const { shouldResetGateway, getFactoryDefaults } = require('./gatewayResetPolicy');

/**
 * 读取当前网关配置(复用 config.js 的逻辑)。
 * @returns {{envMap: object, envPath: string}}
 */
function _readCurrentGatewayConfig() {
  const path = require('path');
  const fs = require('fs');

  const envPath = process.env.KHY_ENV_FILE
    ? path.resolve(process.env.KHY_ENV_FILE)
    : path.resolve(__dirname, '../../.env');

  const envMap = {};
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) {
        continue;
      }
      const idx = line.indexOf('=');
      if (idx <= 0) {
        continue;
      }
      const key = line.slice(0, idx).trim();
      if (!key) {
        continue;
      }
      const rawValue = line.slice(idx + 1).trim();
      envMap[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  }

  return { envMap, envPath };
}

/**
 * 写入环境变量到 .env 文件(复用 config.js 的逻辑)。
 * @param {object} envMap - 键值对
 */
function _writeEnvPatch(envMap = {}) {
  const path = require('path');
  const fs = require('fs');

  const canonicalPath = process.env.KHY_ENV_FILE
    ? path.resolve(process.env.KHY_ENV_FILE)
    : path.resolve(__dirname, '../../.env');
  const mirrorPath = path.resolve(__dirname, '../../../.env');
  const syncMirror = String(process.env.KHY_ENV_SYNC_ROOT || 'true').toLowerCase() !== 'false';

  const targets = [canonicalPath];
  if (
    syncMirror &&
    mirrorPath !== canonicalPath &&
    (fs.existsSync(mirrorPath) || fs.existsSync(canonicalPath))
  ) {
    targets.push(mirrorPath);
  }

  const written = [];
  const failed = [];
  for (const file of targets) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      /* no .env yet */
    }

    // 补丁式更新
    let next = String(content || '');
    for (const [key, value] of Object.entries(envMap)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${value}`;
      if (regex.test(next)) {
        next = next.replace(regex, line);
      } else {
        next = next.trimEnd() + '\n' + line + '\n';
      }
    }

    try {
      fs.writeFileSync(file, next);
      written.push(file);
    } catch (e) {
      failed.push({ file, code: e && e.code ? String(e.code) : '' });
    }
  }

  // 运行时同步仅在有文件成功写入后进行,避免把未落盘的默认值假装生效。
  if (written.length > 0) {
    for (const [key, value] of Object.entries(envMap)) {
      process.env[key] = String(value);
    }
  }

  return { written, failed };
}

/**
 * 交互询问用户。
 * @param {string} question
 * @returns {Promise<boolean>}
 */
async function _askUser(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      const normalized = String(answer || '')
        .trim()
        .toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * 判断并可能重置网关配置。
 *
 * @param {object} [options]
 * @param {boolean} [options.interactive=true] - 是否交互询问用户
 * @param {boolean} [options.force=false] - 强制重置(跳过询问)
 * @param {boolean} [options.configCorrupted=false] - 配置文件是否已损坏
 * @param {object} [options.env] - 环境变量(用于门控)
 * @returns {Promise<{reset: boolean, reason: string, message?: string}>}
 *
 * 流程:
 *   1. 读取当前网关配置
 *   2. 判断是否需要重置
 *   3. 若需要:
 *      - force=true: 直接重置
 *      - interactive=true: 询问用户
 *      - 否则: 只返回建议
 *   4. 重置:写入出厂默认值
 */
async function maybeResetGateway(options = {}) {
  const opts = options || {};
  const interactive = opts.interactive !== false;
  const force = opts.force || false;
  const configCorrupted = opts.configCorrupted || false;
  const env = opts.env || process.env;

  try {
    // 读取当前配置
    const { envMap } = _readCurrentGatewayConfig();

    // 判断是否需要重置
    const decision = shouldResetGateway({ envMap, configCorrupted, env });
    if (!decision.shouldReset) {
      return {
        reset: false,
        reason: '',
        message: '网关配置正常,无需重置',
      };
    }

    // 准备提示信息
    let reasonText = '';
    switch (decision.reason) {
      case 'config-corrupted':
        reasonText = '配置文件已损坏';
        break;
      case 'required-fields-missing':
        reasonText = '必需字段缺失';
        break;
      case 'invalid-adapter':
        reasonText = '适配器值非法';
        break;
      default:
        reasonText = '未知原因';
    }

    // 决定是否重置
    let shouldProceed = false;
    if (force) {
      shouldProceed = true;
    } else if (interactive) {
      printWarn(`检测到网关配置问题: ${reasonText}`);
      printInfo('建议重置为出厂默认值:');
      const defaults = getFactoryDefaults();
      for (const [key, value] of Object.entries(defaults)) {
        printInfo(`  ${key}=${value || '(空)'}`);
      }
      shouldProceed = await _askUser('是否重置网关配置?');
    } else {
      return {
        reset: false,
        reason: decision.reason,
        message: `建议重置网关配置: ${reasonText}`,
      };
    }

    if (!shouldProceed) {
      return {
        reset: false,
        reason: decision.reason,
        message: '用户取消重置',
      };
    }

    // 执行重置
    const defaults = getFactoryDefaults();
    const { written, failed } = _writeEnvPatch(defaults);

    if (failed.length > 0) {
      const codes = [...new Set(failed.map((f) => f.code).filter(Boolean))].join('/') || '未知错误';
      const part = written.length > 0
        ? `已写入 ${written.length} 个、失败 ${failed.length} 个配置文件`
        : `${failed.length} 个配置文件均写入失败`;
      // 只报问题,修复建议由 cli/bootstrap.js 追加(khy gateway config),避免重复。
      return {
        reset: false,
        reason: 'error',
        message: `网关配置重置未完全成功：${part}（${codes}）`,
      };
    }

    printSuccess('网关配置已重置为出厂默认值');
    return {
      reset: true,
      reason: decision.reason,
      message: `网关配置已重置: ${reasonText}`,
    };
  } catch (error) {
    const code = error && error.code ? String(error.code) : '';
    return {
      reset: false,
      reason: 'error',
      message: `网关配置重置失败${code ? `（${code}）` : ''}`,
    };
  }
}

module.exports = {
  maybeResetGateway,
};
