'use strict';

/**
 * Convert Command Handler — `khy convert …`.
 *
 * The unified file-format conversion capability (DESIGN-ARCH-059, second
 * instance). One shared core, `runConvert()`, is exposed as both the
 * `khy convert` CLI command and the agent tool `tools/convertFile.js`, so the
 * format routing, validation and path-confinement live in exactly one place
 * (mirroring the doc.js → docTitleStyle pattern).
 *
 *   convert <input> [--output out] [--to pdf|txt|docx]
 *
 * Supported conversions (source → target):
 *   image → pdf   (single, or multiple/dir merged into one multi-page PDF)
 *   image → txt   (OCR; multiple images are OCR'd and concatenated)
 *   pdf   → txt   (text-layer extraction; scanned PDFs are rejected with a hint)
 *   pdf   → docx  (layout-preserving, via pdf2docx)
 *   docx  → txt   (paragraph text)
 *   txt   → docx  (one paragraph per line)
 *
 * @module handlers/convert
 */
const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const _markFailure = require('../../utils/markProcessFailure');
const { runConvert, _supportedList } = require('../../services/documentConvertService');

/**
 * CLI entry: `khy convert <input> [--output out] [--to pdf|txt|docx]`.
 * The input is a positional argument; flags arrive in `options`.
 * @param {object} parsed - { subCommand, args, options }
 * @returns {Promise<boolean>}
 */
async function handleConvert(parsed = {}) {
  const { printInfo, printError, printSuccess, printWarn } = require('../formatters');
  const options = parsed.options || {};
  const args = Array.isArray(parsed.args) ? parsed.args : [];

  // `convert` takes a positional input. Depending on the parser the first token
  // may land in subCommand or args[0]; accept both, plus --input.
  const positional = [];
  if (parsed.subCommand) {
    positional.push(parsed.subCommand);
  }
  positional.push(...args);

  const opts = {
    input: options.input || (positional.length > 1 ? positional : positional[0]),
    output: options.output,
    to: options.to,
    lang: options.lang,
  };

  if (opts.input == null || opts.input === '') {
    printError('用法: convert <文件|图片,图片,…|目录> [--output 输出路径] [--to pdf|txt|docx]');
    printInfo(`支持的转换: ${_supportedList()}`);
    _markFailure();
    return true;
  }

  const result = await runConvert(opts);
  if (result.success) {
    printSuccess(result.message || `已转换 → ${result.output}`);
    printInfo(`输出：${result.output}`);
  } else if (result.needsDep) {
    printWarn(result.error);
    if (result.hint) {
      printInfo(result.hint);
    }
  } else {
    printError(result.error || '格式转换失败');
    if (result.hint) {
      printInfo(result.hint);
    }
    _markFailure();
  }
  return true;
}

module.exports = {
  handleConvert,
  runConvert,
  [MANIFEST_EXPORT_KEY]: {
    name: 'convert',
    aliases: ['conv', '转换'],
    description: '文件格式转换：image↔PDF / PDF↔TXT / Word↔TXT 等（Capability 实例）',
    usage: 'convert <subcommand> [args]',
    category: 'dev',
    handler: handleConvert,
  },
};
