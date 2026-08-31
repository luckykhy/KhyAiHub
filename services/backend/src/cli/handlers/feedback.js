'use strict';

/**
 * feedback.js — `/feedback`(+ `/bug` 别名)命令薄壳:对 khy **工具本身**提反馈 / 报 bug。
 *
 * 对齐 Claude Code `/feedback`。真正的「背后逻辑」(门控 / 参数解析 / 类别标签 /
 * 反馈文档构造 / 文件名)在纯叶子 feedbackDoc.js;本薄壳只做 IO:
 *   1. 门控 + 解析参数(叶子);
 *   2. 采集环境上下文(khy 版本 versionService、平台 os);
 *   3. 构造反馈文档(叶子)→ 写本地草稿 getDataDir('feedback');
 *   4. 如实指向上游 issues 页(URL 取自 package.json bugs.url,非硬编码端点)。
 *
 * **诚实边界(核心)**:khy 无任何遥测/反馈云端汇聚点,红线禁止臆造网络端点外发用户数据。
 * 故本命令**只在本地落草稿**,**绝不假装已提交、绝不静默外发**;给出本地路径 + 上游
 * issues URL,由用户自行决定是否上报。与 `/issue`(向用户自己的仓库建 issue)语义不同,
 * 绝不复用其 git-remote 路由把反馈错投进用户产品仓库。
 *
 * 门控 KHY_FEEDBACK 默认开;关 → 命令不接管(printInfo 提示后返回,镜像 handlers/issue.js)。
 *
 * 用法:
 *   /feedback <反馈内容...>
 *   /feedback --category bug <反馈内容...>   (类别:bug|idea|praise|other)
 *   /bug <反馈内容...>                        (别名)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const feedbackDoc = require('../feedbackDoc');
const { printInfo, printError, printWarn, printSuccess } = require('../formatters');

/** khy 版本(fail-soft)。 */
function _khyVersion() {
  try {
    return require('../../services/versionService').getCurrentVersion();
  } catch {
    try {
      return require('../../../package.json').version || '';
    } catch {
      return '';
    }
  }
}

/** 平台串(fail-soft)。 */
function _platform() {
  try {
    return `${os.platform()} ${os.release()}`.trim();
  } catch {
    return '';
  }
}

/** 上游 issues URL(取自 package.json bugs.url,非硬编码端点;fail-soft 返回 '')。 */
function _upstreamUrl() {
  try {
    const pkg = require('../../../package.json');
    const bugs = pkg && pkg.bugs;
    if (typeof bugs === 'string') {
      return bugs;
    }
    if (bugs && typeof bugs.url === 'string') {
      return bugs.url;
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * 把 parseInput 路由进 `parsed.options` 的长选项回填成原始 token 序列
 * (与 handlers/commit.js 的 r43 修法同型):`--category bug` 会被 parser 吞进
 * options、args 里什么都不剩,而叶子只扫 token 序列 —— 不回填则文档广告的
 * 长形式永远是幻影,类别被静默错标为 other。布尔 true → `--k`;false 丢弃;
 * 其余 → `--k value`(叶子认这对形式,已实测)。
 */
function _optionTokens(options) {
  const out = [];
  for (const [k, v] of Object.entries(options || {})) {
    if (v === true) {
      out.push(`--${k}`);
    } else if (typeof v === 'boolean') {
      continue;
    } else if (v != null && String(v) !== '') {
      out.push(`--${k}`, String(v));
    }
  }
  return out;
}

/** 落本地反馈草稿到 getDataDir('feedback')(绝不硬编码路径)。fail-soft 返回路径或 null。 */
function _writeDraft(title, body, stamp) {
  try {
    const { getDataDir } = require('../../utils/dataHome');
    const dir = getDataDir('feedback');
    const outPath = path.join(dir, feedbackDoc.buildFeedbackFilename(stamp));
    const content = `# ${title}\n\n${body}\n`;
    fs.writeFileSync(outPath, content, 'utf-8');
    return outPath;
  } catch (e) {
    printError(`保存反馈草稿失败:${e && e.message ? e.message : e}`);
    return null;
  }
}

/**
 * @param {string} subCommand 第一个位置参数
 * @param {string[]} args 其余参数
 * @returns {Promise<boolean>}
 */
async function handleFeedback(subCommand, args = [], options = {}) {
  if (!feedbackDoc.feedbackEnabled(process.env)) {
    printInfo('反馈功能已关闭(KHY_FEEDBACK)。');
    return true;
  }

  // 合并 subCommand + args + 回填的长选项(router 把首词拆给 subCommand;
  // parseInput 把 --category/--label 类长形式吞进 options,见 _optionTokens)。
  const allArgs = [..._optionTokens(options), subCommand, ...(Array.isArray(args) ? args : [])]
    .map((a) => String(a == null ? '' : a))
    .filter((a) => a.length > 0);

  const parsed = feedbackDoc.parseFeedbackArgs(allArgs);
  const upstream = _upstreamUrl();

  if (!parsed.valid) {
    printInfo('用法: khy feedback [--category bug|idea|praise|other] <反馈内容...>');
    console.log('      会话内等价 /feedback;别名 /bug(khy bug ...)');
    if (upstream) {
      printInfo(`也可直接到上游提交:${upstream}`);
    }
    return true;
  }

  // r46:显式类别值非法被静默归一时,把替换说出来(叶子已给出整句提示)。
  if (parsed.categoryNotice) {
    printInfo(parsed.categoryNotice);
  }

  const stamp = new Date().toISOString();
  const { title, body } = feedbackDoc.buildFeedbackDoc({
    text: parsed.text,
    category: parsed.category,
    version: _khyVersion(),
    platform: _platform(),
    stamp,
  });

  const draftPath = _writeDraft(title, body, stamp);
  if (draftPath) {
    printSuccess(`反馈(${feedbackDoc.categoryLabel(parsed.category)})已保存到本地:`);
    printInfo(draftPath);
  } else {
    printWarn('反馈未能写入本地草稿(见上面的错误)。');
  }
  // 诚实:khy 无遥测云端汇聚,绝不假装已提交;指向上游由用户自行上报。
  if (upstream) {
    printInfo(`khy 不会自动上传;如愿分享,请到上游提交:${upstream}`);
  } else {
    printInfo('khy 不会自动上传;反馈已存本地,可自行分享给维护者。');
  }
  return true;
}

module.exports = { handleFeedback, _optionTokens, _khyVersion, _platform, _upstreamUrl };
