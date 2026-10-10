'use strict';

/**
 * artifactPlan.test.js — 钉死 Artifact 本地工件叶子的门控、动作校验、安全文件名派生与
 * 结果构造。
 *
 * 为什么这支套件必须存在：deriveSafeName 是防目录穿越的**唯一**一道闸——工件落点由薄壳
 * 拼 `getDataDir('artifacts')/<name>`，name 里漏出 `/`、`\` 或 `..` 就等于把任意路径写入
 * 交给模型。文件头承诺「绝不抛 / 绝不伪造云 URL / 不写死目录」，本套件把三条承诺全部打满。
 *
 * 实测更正（与注释/直觉不同处，按真实语义钉死）：
 *   · _MAX_NAME=128 只截清洗后的名字，**补扩展名发生在截断之后**——超长名最终可 >128。
 *   · validateInput 的错误消息内插原始 p.action，返回的 action 字段却是 trim+lower 后的。
 *   · buildListResult 对条目 name 无差别 String()，undefined 会变成字面 'undefined'。
 *   · isEnabled(null) → true（内部 `env || {}`），与 issueReport 叶子对 null → false 相反，
 *     两个叶子的门控对 null 语义不一致，此处按 artifactPlan 自身事实钉死。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('./artifactPlan');

// ── isEnabled ──────────────────────────────────────────────────────────

test('isEnabled: 缺 key 默认开；off 值族（含大小写/空白）关闭', () => {
  assert.equal(M.isEnabled({}), true);
  assert.equal(M.isEnabled({ KHY_ARTIFACT_TOOL: 'true' }), true);
  for (const off of ['', '  ', '0', 'FALSE', 'off', ' No']) {
    assert.equal(M.isEnabled({ KHY_ARTIFACT_TOOL: off }), false, `off 值「${off}」必须关闭`);
  }
});

test('isEnabled: 数字 0 / null 值也读作关；null env 反而默认开', () => {
  assert.equal(M.isEnabled({ KHY_ARTIFACT_TOOL: 0 }), false);
  assert.equal(M.isEnabled({ KHY_ARTIFACT_TOOL: null }), false);
  assert.equal(M.isEnabled(null), true, 'env||{} 收敛为缺 key → 默认开');
  assert.equal(M.isEnabled(undefined), true);
});

// ── validateInput ──────────────────────────────────────────────────────

test('validateInput: 缺 action 归一为 create，空 content 拒绝', () => {
  const r = M.validateInput({});
  assert.equal(r.action, 'create');
  assert.equal(r.ok, false);
  assert.match(r.error, /create 需要非空 content/);
});

test('validateInput: action 归一大小写与空白；未知值消息带原文', () => {
  assert.deepEqual(M.validateInput({ action: ' LIST ', }), { ok: true, action: 'list', error: null });
  const r = M.validateInput({ action: 'Bogus' });
  assert.equal(r.action, 'bogus', '返回归一后的 action');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('Bogus'), '错误消息内插的是原始大小写');
});

test('validateInput: create 空串 / read 空白名 各自的必填校验', () => {
  assert.equal(M.validateInput({ action: 'create', content: '' }).ok, false);
  assert.equal(M.validateInput({ action: 'create', content: 'x' }).ok, true);
  assert.equal(M.validateInput({ action: 'read', name: '  ' }).error, 'read 需要 name(已存在的工件名)');
  assert.equal(M.validateInput({ action: 'read', name: 'a.txt' }).ok, true);
});

test('validateInput: 非对象输入不抛，收敛为 create 校验路径', () => {
  for (const bad of [null, undefined, 'str', 42]) {
    const r = M.validateInput(bad);
    assert.equal(r.action, 'create');
    assert.equal(r.ok, false);
  }
});

// ── deriveSafeName（目录穿越防线） ─────────────────────────────────────

test('deriveSafeName: 路径穿越样本全部剥成末段安全名', () => {
  assert.equal(M.deriveSafeName({ name: '../../etc/passwd' }), 'passwd.txt');
  assert.equal(M.deriveSafeName({ name: 'evil/../../x', kind: 'js' }), 'x.js');
  assert.equal(M.deriveSafeName({ name: 'C:\\evil\\dir\\payload.py' }), 'payload.py');
  assert.equal(M.deriveSafeName({ name: '..\\..\\windows\\system32\\run.dll' }), 'run.dll');
  for (const out of ['passwd.txt', 'x.js', 'payload.py', 'run.dll']) {
    assert.ok(!out.includes('/') && !out.includes('\\') && !out.includes('..'), `结果不含路径成分:${out}`);
  }
});

test('deriveSafeName: 先取末段再清洗（中段路径成分随末段一起消失）', () => {
  assert.equal(M.deriveSafeName({ name: 'a b/../c' }), 'c.txt', '末段是 c，前面的空格与 ../ 一起被剥掉');
  assert.equal(M.deriveSafeName({ name: 'a b/c d' }), 'c_d.txt', '末段内部空格 → 下划线');
});

test('deriveSafeName: 清洗细节按实现事实', () => {
  assert.equal(M.deriveSafeName({ name: '中文标题' }), '____.txt');
  assert.equal(M.deriveSafeName({ name: 'a....b' }), 'a.b', '连续点压缩后 .b 被当成扩展名 → 不再补 .txt（真实语义）');
  assert.equal(M.deriveSafeName({ name: '.hidden' }), 'hidden.txt');
  assert.equal(M.deriveSafeName({ name: 'endswithdots.' }), 'endswithdots.txt');
});

test('deriveSafeName: 已有扩展名不重复补；无扩展名按 kind 映射', () => {
  assert.equal(M.deriveSafeName({ name: 'data.json', kind: 'md' }), 'data.json');
  assert.equal(M.deriveSafeName({ name: 'script', kind: 'Python' }), 'script.py');
  assert.equal(M.deriveSafeName({ name: 'file', kind: 'zzz' }), 'file.txt', '未知 kind → .txt');
});

test('deriveSafeName: 清洗后为空回退 fallbackStem+kind 扩展名', () => {
  assert.equal(M.deriveSafeName({ name: '???' , kind: 'sh' }), '___.sh', '?→_ 不空，走补扩展名');
  assert.equal(M.deriveSafeName({ name: '...' }), 'artifact.txt', '全点清洗成空 → 默认 stem');
  assert.equal(M.deriveSafeName({ name: '', fallbackStem: 'my report', kind: 'yaml' }), 'my_report.yaml');
});

test('deriveSafeName: 128 截断先于补扩展名，最终长可 >128（真实语义）', () => {
  const out = M.deriveSafeName({ name: 'a'.repeat(200), kind: 'js' });
  assert.equal(out.length, 131, "128 个 a + '.js'");
  assert.ok(out.endsWith('.js'));
});

test('deriveSafeName: 任意输入绝不抛', () => {
  for (const bad of [null, undefined, 'str', {}, { name: 123 }, { kind: {} }]) {
    assert.equal(typeof M.deriveSafeName(bad), 'string');
  }
});

// ── 结果构造器 ─────────────────────────────────────────────────────────

test('buildCreateResult: 缺省形状 + 诚实回执措辞（本地路径，非云链接）', () => {
  const r = M.buildCreateResult();
  assert.equal(r.success, true);
  assert.equal(r.action, 'create');
  assert.equal(r.name, null);
  assert.equal(r.path, null);
  assert.equal(r.bytes, 0);
  assert.match(r.note, /本地工件/);
  assert.match(r.note, /非云端分享链接/);
  assert.ok(!JSON.stringify(r).includes('http'), '绝不出现 URL');
});

test('buildCreateResult: bytes 非有限 → 0；name/path 强转字符串', () => {
  assert.equal(M.buildCreateResult({ bytes: NaN }).bytes, 0);
  assert.equal(M.buildCreateResult({ bytes: Infinity }).bytes, 0);
  assert.equal(M.buildCreateResult({ name: 7, path: 8, bytes: 12.5 }).name, '7');
  assert.equal(M.buildCreateResult({ bytes: 12.5 }).bytes, 12.5, '有限小数原样保留');
});

test('buildListResult: 非对象条目滤掉；bytes 非有限 → 0；undefined name 变字面', () => {
  const r = M.buildListResult([{ name: 'a', bytes: 3 }, null, 'str', { bytes: NaN }]);
  assert.equal(r.count, 2);
  assert.deepEqual(r.artifacts[0], { name: 'a', bytes: 3 });
  assert.deepEqual(r.artifacts[1], { name: 'undefined', bytes: 0 });
  assert.deepEqual(M.buildListResult(undefined), { success: true, action: 'list', count: 0, artifacts: [] });
});

test('buildReadResult / buildErrorResult 形状契约', () => {
  assert.deepEqual(M.buildReadResult(), { success: true, action: 'read', name: null, path: null, content: '' });
  assert.equal(M.buildReadResult({ content: 'x' }).content, 'x');
  assert.equal(M.buildErrorResult(null).error, '未知错误');
  assert.deepEqual(M.buildErrorResult(new Error('boom')), { success: false, error: 'Error: boom' }, 'String() 不剥 Error 前缀（真实语义）');
});

// ── describeActivity（TUI 行） ─────────────────────────────────────────

test('describeActivity: 三动作各一行，读不到名字打问号', () => {
  assert.equal(M.describeActivity({ action: 'list' }), '列出本地工件');
  assert.equal(M.describeActivity({ action: 'read', name: 'a.txt' }), '读取工件:a.txt');
  assert.equal(M.describeActivity({ action: 'read' }), '读取工件:?');
  assert.equal(M.describeActivity({}), '保存本地工件');
  assert.equal(M.describeActivity({ name: 'n' }), '保存本地工件:n');
});
