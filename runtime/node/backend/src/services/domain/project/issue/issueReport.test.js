'use strict';

/**
 * issueReport.test.js — 钉死 /issue 纯叶子的参数解析、remote 解析、正文汇总与降级 URL 构造。
 *
 * 为什么这支套件必须存在：这层是「离线也能算」的那一半——解析错一个 flag、URL 少编码一个
 * 字符、正文把整段 transcript 原样塞进浏览器 URL，都会在薄壳（handlers/issue.js）里变成
 * 用户可见的坏 issue。叶子契约自称「零 IO、确定性、绝不抛」，断言全部按注入数据打满。
 *
 * 实测更正（与注释/直觉不同处，按真实语义钉死）：
 *   · parseIssueArgs 未知 flag / 缺值 break 时，break 之前已收的 labels/assignees 仍会
 *     出现在返回值里（只是 valid=false）；调用方不能假设出错即全空。
 *   · 标题词以 - 开头会被判未知参数，但 `-1` 这类负数豁免（/^-\d/）。
 *   · buildIssueBody 的 opts.title 是文档字段，实现里从未使用——正文不含标题。
 *   · meta 条目整条跳过，连带的错误块也不抽取。
 *   · isEnabled(null)（非 undefined，不触发默认参数）→ false，与 isEnabled({}) → true 不同。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('./issueReport');

// ── parseIssueArgs ─────────────────────────────────────────────────────

test('parseIssueArgs: 基础标题 + 双形式 flag 收集', () => {
  const r = M.parseIssueArgs(['修复', '登录', '报错', '-l', 'bug', '--assignee', 'khy']);
  assert.equal(r.title, '修复 登录 报错');
  assert.deepEqual(r.labels, ['bug']);
  assert.deepEqual(r.assignees, ['khy']);
  assert.equal(r.valid, true);
  assert.equal(r.parseError, null);
});

test('parseIssueArgs: 缺值报错但已收列表保留（真实语义，不重置）', () => {
  const r = M.parseIssueArgs(['t', '--label', 'ok', '-a']);
  assert.equal(r.valid, false);
  assert.equal(r.parseError, '-a 需要一个值');
  assert.deepEqual(r.labels, ['ok'], 'break 前已收集的 label 仍返回');
  assert.equal(r.title, 't', '出错时 title 字段仍带 break 前的词');
});

test('parseIssueArgs: flag 值以 - 开头视为缺值', () => {
  const r = M.parseIssueArgs(['--label', '-x', '标题']);
  assert.equal(r.parseError, '--label 需要一个值');
  assert.equal(r.valid, false);
});

test('parseIssueArgs: 未知 flag 报错并停止解析', () => {
  const r = M.parseIssueArgs(['a', '--nope', 'b']);
  assert.equal(r.parseError, '未知参数:--nope');
  assert.equal(r.title, 'a');
  assert.equal(r.valid, false, 'parseError 存在时即便有标题也不 valid');
});

test('parseIssueArgs: 负数是标题词不是 flag（/^−\\d/ 豁免）', () => {
  const r = M.parseIssueArgs(['-1', '层嵌套']);
  assert.equal(r.title, '-1 层嵌套');
  assert.equal(r.valid, true);
});

test('parseIssueArgs: 空标题与非法输入统一报「缺少 issue 标题」，绝不抛', () => {
  assert.equal(M.parseIssueArgs([]).parseError, '缺少 issue 标题');
  assert.equal(M.parseIssueArgs(null).parseError, '缺少 issue 标题');
  assert.equal(M.parseIssueArgs([]).valid, false);
  assert.deepEqual(M.parseIssueArgs(undefined).labels, []);
});

// ── parseRemoteOwnerRepo ───────────────────────────────────────────────

test('parseRemoteOwnerRepo: SSH 形式去 .git 后缀', () => {
  assert.deepEqual(M.parseRemoteOwnerRepo('git@github.com:owner/repo.git'), {
    host: 'github.com',
    owner: 'owner',
    repo: 'repo',
  });
});

test('parseRemoteOwnerRepo: HTTPS 形式（含/不含 .git）', () => {
  assert.deepEqual(M.parseRemoteOwnerRepo('https://github.com/o/r.git'), {
    host: 'github.com',
    owner: 'o',
    repo: 'r',
  });
  assert.deepEqual(M.parseRemoteOwnerRepo('https://github.com/o/r'), {
    host: 'github.com',
    owner: 'o',
    repo: 'r',
  });
});

test('parseRemoteOwnerRepo: SSH 带尾部斜杠', () => {
  const r = M.parseRemoteOwnerRepo('git@github.com:owner/repo/');
  assert.equal(r.repo, 'repo');
});

test('parseRemoteOwnerRepo: GitLab 群组嵌套路径归 repo（真实语义）', () => {
  const r = M.parseRemoteOwnerRepo('https://gitlab.com/group/sub/repo.git');
  assert.equal(r.owner, 'group');
  assert.equal(r.repo, 'sub/repo');
});

test('parseRemoteOwnerRepo: 空/垃圾输入返回 null，绝不抛', () => {
  assert.equal(M.parseRemoteOwnerRepo(''), null);
  assert.equal(M.parseRemoteOwnerRepo(null), null);
  assert.equal(M.parseRemoteOwnerRepo('not a url'), null);
});

// ── buildIssueBody ─────────────────────────────────────────────────────

test('buildIssueBody: 回合截取 + 超长截断到 200 字加省略号', () => {
  const long = 'a'.repeat(250);
  const body = M.buildIssueBody({
    transcript: [{ role: 'user', content: long }],
  });
  assert.ok(body.includes(`${'a'.repeat(200)}…`), '200 字 + … 截断');
  assert.ok(!body.includes('a'.repeat(201)), '绝不带出第 201 个字');
});

test('buildIssueBody: 默认只取最近 5 回合（DEFAULT_MAX_TURNS），maxTurns 可覆盖', () => {
  const transcript = [];
  for (let i = 1; i <= 7; i += 1) {
    transcript.push({ role: 'user', content: `t${i}` });
  }
  const d = M.buildIssueBody({ transcript });
  assert.equal(d.split('**user:**').length - 1, M.DEFAULT_MAX_TURNS);
  assert.ok(!d.includes('t1'));
  assert.ok(d.includes('t7'));
  const c = M.buildIssueBody({ transcript, maxTurns: 2 });
  assert.equal(c.split('**user:**').length - 1, 2);
  assert.ok(c.includes('t6') && c.includes('t7') && !c.includes('t5'));
});

test('buildIssueBody: meta 条目整条跳过（连带错误也不抽取）', () => {
  const body = M.buildIssueBody({
    transcript: [
      { role: 'user', content: 'meta 错误', isMeta: true, other: [{ is_error: true }] },
      { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'metaErr' }], isMeta: true },
    ],
  });
  assert.equal(body, '(无可汇总的会话记录)');
});

test('buildIssueBody: 抽取错误块，只留最近 3 条', () => {
  const transcript = [];
  for (const e of ['errOne', 'errTwo', 'errThree', 'errFour']) {
    transcript.push({ role: 'assistant', content: [{ type: 'tool_result', is_error: true, content: e }] });
  }
  const body = M.buildIssueBody({ transcript });
  assert.ok(body.includes('### Recent errors'));
  assert.ok(body.includes('errTwo') && body.includes('errThree') && body.includes('errFour'));
  assert.ok(!body.includes('errOne'), '第 1 条被 slice(-3) 丢弃');
});

test('buildIssueBody: 模板剥离 YAML front-matter 后拼接', () => {
  const body = M.buildIssueBody({
    transcript: [{ role: 'user', content: '问题描述' }],
    template: '---\ntitle: x\n---\n请按模板填写复现步骤',
  });
  assert.ok(body.includes('请按模板填写复现步骤'));
  assert.ok(!body.includes('title: x'), 'front-matter 不进正文');
});

test('buildIssueBody: opts.title 是实现中的死参数（正文不含标题）', () => {
  const body = M.buildIssueBody({
    transcript: [{ role: 'user', content: 'u' }],
    title: 'ZZZ-标题-不该出现',
  });
  assert.ok(!body.includes('ZZZ'));
});

test('buildIssueBody: 空输入产占位文本；输出无三连换行；绝不抛', () => {
  assert.equal(M.buildIssueBody({}), '(无可汇总的会话记录)');
  const body = M.buildIssueBody({
    transcript: [
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      null,
      'string-entry-ignored',
    ],
  });
  assert.ok(body.includes('**user:** a b'), 'block 数组按空格拼接');
  assert.ok(!/\n{3,}/.test(body), '连续 3+ 换行被压成 2');
});

// ── buildIssueUrl ──────────────────────────────────────────────────────

test('buildIssueUrl: 缺 owner/repo 回 null 且无截断信号', () => {
  assert.deepEqual(M.buildIssueUrl({ title: 't' }), { url: null, bodyTruncated: false });
  assert.deepEqual(M.buildIssueUrl({ owner: 'o' }), { url: null, bodyTruncated: false });
});

test('buildIssueUrl: 最小链接无查询串，host 默认 github.com', () => {
  const { url } = M.buildIssueUrl({ owner: 'o', repo: 'r' });
  assert.equal(url, 'https://github.com/o/r/issues/new');
});

test('buildIssueUrl: title/body/labels 全量 URL 编码，labels 过滤假值', () => {
  const { url } = M.buildIssueUrl({
    owner: 'o',
    repo: 'r',
    host: 'gitee.com',
    title: '中文 标题',
    body: 'a&b',
    labels: ['bug', '', 'p0'],
  });
  assert.ok(url.startsWith('https://gitee.com/o/r/issues/new?'));
  assert.ok(url.includes('title=%E4%B8%AD%E6%96%87%20%E6%A0%87%E9%A2%98'));
  assert.ok(url.includes('body=a%26b'));
  assert.ok(url.includes('labels=bug%2Cp0'));
});

test('buildIssueUrl: body 超长截断并置 bodyTruncated（薄壳据此落草稿）', () => {
  const r = M.buildIssueUrl({ owner: 'o', repo: 'r', body: 'x'.repeat(10), maxBodyLen: 4 });
  assert.equal(r.bodyTruncated, true);
  const q = new URL(r.url).searchParams;
  assert.equal(q.get('body'), 'xxxx', 'URL 里只带截断后的 body');
  const full = M.buildIssueUrl({ owner: 'o', repo: 'r', body: 'y'.repeat(M.DEFAULT_MAX_URL_BODY) });
  assert.equal(full.bodyTruncated, false, '恰等于上限不算超长');
});

// ── isEnabled（门控，env 注入） ────────────────────────────────────────

test('isEnabled: 缺 key 默认开；off 值族关闭', () => {
  assert.equal(M.isEnabled({}), true);
  assert.equal(M.isEnabled({ KHY_ISSUE: undefined }), true);
  for (const off of ['0', 'false', 'OFF', ' no ', '']) {
    assert.equal(M.isEnabled({ KHY_ISSUE: off }), false, `off 值「${off}」必须关闭`);
  }
  assert.equal(M.isEnabled({ KHY_ISSUE: '1' }), true);
});

test('isEnabled(null) → false（null 不触发默认参数，与 isEnabled({}) 相反）', () => {
  assert.equal(M.isEnabled(null), false);
});
