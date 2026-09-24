'use strict';

/**
 * longFlagsHonest.test.js — 长选项幻影三兄弟诚实契约(hci-r44)。
 *
 * 复现源自 .khy/feedback/hci-r44-longflag-trio/ :parseInput 把
 * `feedback --category bug` / `issue --label bug --assignee alice` /
 * `perf-issue --format=json|csv`(= 与空格两式)整体吞进 parsed.options,
 * 三个 handler 只 raw-scan [subCommand, ...args]、`_options` 即弃 →
 * 类别静默错标 other、标签/指派人全丢、报告静默降级 md。
 *
 * 修法式:feedback/issue 用 _optionTokens 回填(r43 同型,叶子实测认长对);
 * perfIssue 走 _parseFormat 第三参 options 优先级(回填会把 'json' 喂给
 * _parseSessionArg 误当 sessionId —— hazard 有专测)。
 *
 * issue 只测「聚合 → 叶子」段:handleIssue 的 gh 分支是网络写,禁止在测试里
 * 触达(repro 阶段同款纪律)。feedback/perf 的落盘全部经 KHY_DATA_HOME 隔离到
 * 临时目录,断言读**真实草稿文件**(非空转)。node --test only。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const BACKEND = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(BACKEND, 'src');

function seed(absPath, exportsObj) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[absPath] = m;
}

const rec = { info: [], error: [], warn: [], success: [] };
seed(path.join(SRC, 'cli', 'formatters.js'), {
  printSuccess: (m) => rec.success.push(String(m)),
  printError: (m) => rec.error.push(String(m)),
  printInfo: (m) => rec.info.push(String(m)),
  printWarn: (m) => rec.warn.push(String(m)),
  printTable: () => {},
});

const router = require(path.join(SRC, 'cli', 'router.js'));
const feedbackH = require(path.join(SRC, 'cli', 'handlers', 'feedback.js'));
const issueH = require(path.join(SRC, 'cli', 'handlers', 'issue.js'));
const perfH = require(path.join(SRC, 'cli', 'handlers', 'perfIssue.js'));
const issueReport = require(path.join(SRC, 'services/domain/project/issue/issueReport.js'));
const feedbackDoc = require(path.join(SRC, 'cli', 'feedbackDoc.js'));

const ORIG_DATA_HOME = process.env.KHY_DATA_HOME;
// dataHome.js 用模块级 `_cached` 记忆首次解析结果(并会把解析值写回 env)——
// 同进程内换 env 不生效,必须调它导出的 _resetStorageCaches()(测试专用钩子)。
const dataHome = require(path.join(SRC, 'utils', 'dataHome.js'));

function tempDataHome(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r44t-${tag}-`));
  process.env.KHY_DATA_HOME = dir;
  dataHome._resetStorageCaches();
  return dir;
}
function restoreDataHome() {
  if (ORIG_DATA_HOME === undefined) delete process.env.KHY_DATA_HOME;
  else process.env.KHY_DATA_HOME = ORIG_DATA_HOME;
  dataHome._resetStorageCaches();
}

/** 读 <dataHome>/feedback 下唯一草稿首行。 */
function onlyDraftLine(dir) {
  const files = fs.readdirSync(path.join(dir, 'feedback'));
  assert.equal(files.length, 1, `期望恰好 1 份草稿,实有 ${files.length}`);
  return fs.readFileSync(path.join(dir, 'feedback', files[0]), 'utf-8').split('\n')[0];
}

test('T1 纯回填:_optionTokens 还原被吞的 token 对(feedback/issue 同型)', () => {
  assert.deepEqual(feedbackH._optionTokens({ category: 'bug' }), ['--category', 'bug']);
  assert.deepEqual(issueH._optionTokens({ label: 'bug', assignee: 'alice' }),
    ['--label', 'bug', '--assignee', 'alice']);
  assert.deepEqual(feedbackH._optionTokens({ flag: true }), ['--flag']);
  assert.deepEqual(feedbackH._optionTokens({ flag: false }), []);
  assert.deepEqual(feedbackH._optionTokens(undefined), []);
});

test('T2 主案:feedback `--category bug` 真落 bug 类别(读真实草稿文件)', async () => {
  const dir = tempDataHome('t2');
  try {
    const p = router.parseInput('feedback --category bug 长形式回归文本');
    assert.deepEqual(p.options, { category: 'bug' }); // 前提:值确实在 options 里
    await feedbackH.handleFeedback(null, p.args, p.options);
    const head = onlyDraftLine(dir);
    assert.match(head, /\[feedback\]\[bug\]/); // 修复前这里是 [other](静默错标)
    assert.ok(rec.success.join('\n').includes('缺陷'));
  } finally {
    restoreDataHome();
  }
});

test('T3 对照+默认面:`-c bug`(args 短形式)不回归;裸反馈仍是 other', async () => {
  const dir = tempDataHome('t3');
  try {
    const p = router.parseInput('feedback -c bug 短形式文本');
    await feedbackH.handleFeedback(null, p.args, p.options);
    assert.match(onlyDraftLine(dir), /\[feedback\]\[bug\]/);
  } finally {
    restoreDataHome();
  }
  const dir2 = tempDataHome('t3b');
  try {
    const p = router.parseInput('feedback 没有类别文本');
    await feedbackH.handleFeedback(null, p.args, p.options);
    assert.match(onlyDraftLine(dir2), /\[feedback\]\[other\]/);
  } finally {
    restoreDataHome();
  }
});

test('T4 主案:issue 长形式经回填后标签/指派人到达叶子(不触 gh)', () => {
  const p = router.parseInput('issue --label bug --assignee alice 复现标题');
  assert.deepEqual(p.options, { label: 'bug', assignee: 'alice' });
  const allArgs = [...issueH._optionTokens(p.options), ...(p.args || [])]
    .map((a) => String(a == null ? '' : a)).filter((a) => a.length > 0);
  const parsed = issueReport.parseIssueArgs(allArgs);
  assert.deepEqual(parsed.labels, ['bug']); // 修复前:[](全丢)
  assert.deepEqual(parsed.assignees, ['alice']);
  assert.equal(parsed.title, '复现标题');
  const ctrl = issueReport.parseIssueArgs(['-l', 'urgent', '短对照']);
  assert.deepEqual(ctrl.labels, ['urgent']); // 短形式对照不回归
});

test('T5 主案:perf-issue --format 两式均经 options 生效;非法值回退 md 且**如实提示**(r46);args 式字节不变', () => {
  const eq = router.parseInput('perf-issue --format=json');
  assert.deepEqual(perfH._parseFormat(null, eq.args, eq.options), { format: 'json', notice: null });
  const sp = router.parseInput('perf-issue --format csv');
  assert.deepEqual(perfH._parseFormat(null, sp.args, sp.options), { format: 'csv', notice: null });
  const bad = router.parseInput('perf-issue --format=xls');
  const badRes = perfH._parseFormat(null, bad.args, bad.options);
  assert.equal(badRes.format, 'md'); // 回退面不变
  assert.match(badRes.notice, /格式「xls」不是已知值\(md\|json\|csv\)/); // r46:原「已知残留:静默」已消化
  const bare = router.parseInput('perf-issue');
  assert.deepEqual(perfH._parseFormat(null, bare.args, bare.options), { format: 'md', notice: null });
  assert.deepEqual(perfH._parseFormat(null, ['--format=csv'], {}), { format: 'csv', notice: null }); // 历史 args 扫描式不变
});

test('T7 r46:feedback 非法类别静默替换→categoryNotice;合法/缺省不打扰', () => {
  const typo = feedbackDoc.parseFeedbackArgs(['--category', 'bugs', '文本']);
  assert.equal(typo.category, 'other'); // 归一行为字节不变
  assert.match(typo.categoryNotice, /类别「bugs」不是已知值/);
  assert.match(typo.categoryNotice, /已按「其他」记录/);
  const typoEq = feedbackDoc.parseFeedbackArgs(['--category=whatever', '文本']);
  assert.match(typoEq.categoryNotice, /类别「whatever」/);
  const ok = feedbackDoc.parseFeedbackArgs(['--category', 'Bug', '文本']); // 大小写容忍,合法
  assert.equal(ok.category, 'bug');
  assert.equal(ok.categoryNotice, null);
  const explicitOther = feedbackDoc.parseFeedbackArgs(['-c', 'other', '文本']); // 显式合法值不打扰
  assert.equal(explicitOther.categoryNotice, null);
  const absent = feedbackDoc.parseFeedbackArgs(['纯文本']); // 缺省 other 是文档化默认,不打扰
  assert.equal(absent.category, 'other');
  assert.equal(absent.categoryNotice, null);
});

test('T6 hazard 专测:options 携带 format 值不会污染 sessionId 判定', () => {
  const p = router.parseInput('perf-issue --format json');
  assert.equal(perfH._parseSessionArg(null, p.args), ''); // 回填式会把 'json' 喂成会话 id
  const withSess = router.parseInput('perf-issue abc123 --format json');
  assert.equal(perfH._parseSessionArg(null, withSess.args), 'abc123');
});

test('after-hook: KHY_DATA_HOME 已复位', () => {
  assert.equal(process.env.KHY_DATA_HOME, ORIG_DATA_HOME);
});
