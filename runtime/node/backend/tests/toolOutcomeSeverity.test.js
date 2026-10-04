'use strict';

/**
 * 失败严重度分级(2026-09-27)。
 *
 * 锁三件事:
 *   1) 叶子的三档判定与「零假阳性」底线 —— 降档**只能**由生产者显式 `severity:'notice'`
 *      触发,绝不从错误文本里猜;
 *   2) 两个具名生产者的行为:目录工具「路径是文件」、shell「命令跑成了但退出非零」
 *      → notice;且 `success` 仍为 false(循环/恢复/统计语义不变);
 *   3) 呈现层:投影把 notice 译成「非红」且**不把原因写进 error**(否则下游四路布尔式
 *      照样全红);门控关 → 逐字节回退两档。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sev = require('../src/services/tool/toolOutcomeSeverity');

function withEnv(key, val, fn) {
  const prev = process.env[key];
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = val === undefined ? undefined : prev;
  }
}

// ── 叶子:三档判定 ──────────────────────────────────────────────────────
test('displaySeverity:成功 → ok;无显式声明的非成功 → error', () => {
  assert.equal(sev.displaySeverity({ success: true }), 'ok');
  assert.equal(sev.displaySeverity({ success: false, error: 'boom' }), 'error');
  assert.equal(sev.displaySeverity({ success: false, error: 'Not a directory' }), 'error');
});

test('零假阳性:只有显式 severity:"notice" 才降档,文本绝不参与判定', () => {
  // 长得再像「可预期情况」,没显式声明就是 error
  const lookalike = { success: false, error: 'No matches found / 不是目录 / exit code 1' };
  assert.equal(sev.displaySeverity(lookalike), 'error');
  assert.equal(sev.isNotice(lookalike), false);
  // 显式声明才降档
  assert.equal(sev.displaySeverity({ success: false, severity: 'notice' }), 'notice');
});

test('displaySeverity:成功 + 误标 notice → 仍为 ok(矛盾声明按成功处理)', () => {
  assert.equal(sev.displaySeverity({ success: true, severity: 'notice' }), 'ok');
});

test('displaySeverity:无结果对象 → error(缺结果 ≠ 成功,与投影层既有契约一致)', () => {
  assert.equal(sev.displaySeverity(null), 'error');
  assert.equal(sev.displaySeverity(undefined), 'error');
  assert.equal(sev.displaySeverity('x'), 'error');
  // 有对象但没有 success:true → error(与历史 `!(res && res.success)` 等价)
  assert.equal(sev.displaySeverity({}), 'error');
});

test('门控 KHY_TOOL_SEVERITY_TIERS=0 → 逐字节回退两档', () => {
  withEnv('KHY_TOOL_SEVERITY_TIERS', '0', () => {
    assert.equal(sev.isEnabled(), false);
    assert.equal(sev.displaySeverity({ success: false, severity: 'notice' }), 'error');
    assert.equal(sev.displaySeverity({ success: true }), 'ok');
  });
});

test('withNotice:打档但不动 success/error(循环语义不受影响)', () => {
  const out = sev.withNotice({ success: false, error: 'Not a directory: a.txt' }, '它是文件');
  assert.equal(out.success, false, 'success 必须原样保留');
  assert.equal(out.error, 'Not a directory: a.txt', 'error 必须原样保留(模型侧还要看)');
  assert.equal(out.severity, 'notice');
  assert.equal(out.noticeReason, '它是文件');
});

test('noticeText:noticeReason 优先,其次 error/reason/message;结构化 error 取 message', () => {
  assert.equal(sev.noticeText({ noticeReason: 'r', error: 'e' }), 'r');
  assert.equal(sev.noticeText({ error: 'e' }), 'e');
  assert.equal(sev.noticeText({ reason: 'r2' }), 'r2');
  assert.equal(sev.noticeText({ error: { message: 'structured' } }), 'structured');
  assert.equal(sev.noticeText({}), '');
  assert.equal(sev.noticeText(null), '');
});

test('present:三档的呈现三元组单一真源', () => {
  assert.deepEqual(sev.present('notice'), { icon: '•', color: 'yellow', isError: false });
  assert.deepEqual(sev.present('error'), { icon: '✗', color: 'red', isError: true });
  assert.deepEqual(sev.present('ok'), { icon: '✓', color: 'green', isError: false });
});

// ── 生产者 A:目录工具「路径存在但是个文件」 ─────────────────────────────
test('ListDirTool:路径是文件 → notice(不是红色失败),且指明下一步', async () => {
  const tool = require('../src/tools/ListDirTool/index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-sev-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  try {
    const out = await tool.execute({ path: file }, {});
    assert.equal(out.severity, 'notice', '「是文件不是目录」属可预期的边界情况');
    assert.equal(out.success, false, 'success 仍为 false —— 循环/统计语义不变');
    assert.match(out.noticeReason, /Read/, '要指明下一步(用 Read 读它)');
    assert.match(out.noticeReason, /Glob/, '要给出替代工具');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ListDirTool:目录不存在 → 仍是 error(不是可预期的边界情况)', async () => {
  const tool = require('../src/tools/ListDirTool/index');
  const out = await tool.execute({ path: path.join(os.tmpdir(), 'khy-no-such-dir-xyz') }, {});
  assert.equal(out.success, false);
  assert.equal(out.severity, undefined, '缺目录是真失败,不得降档');
});

// ── 生产者 B:shell「命令跑成了,退出码非零」 ─────────────────────────────
test('shell:命令已执行但退出非零 → notice + 如实退出码(不是红色失败)', async () => {
  const tool = require('../src/tools/shellCommand');
  const out = await tool.execute({ command: 'node -e "process.exit(3)"' }, {});
  assert.equal(out.exitCode, 3, '退出码必须如实带上');
  assert.equal(out.success, false, 'success 仍为 false —— 循环/统计语义不变');
  assert.equal(out.severity, 'notice', '非零退出是命令给出的答案,不是调用失败');
  assert.match(out.noticeReason, /3/, '中性说明里要出现退出码');
});

test('shell:成功命令不受影响(仍是 ok 档,无 severity 字段)', async () => {
  const tool = require('../src/tools/shellCommand');
  const out = await tool.execute({ command: 'node -e "process.exit(0)"' }, {});
  assert.equal(out.success, true);
  assert.equal(out.severity, undefined);
});

// ── 呈现层:投影(所有 TUI 红色判定的唯一入口) ──────────────────────────
test('projectToolResultForView:notice → isError:false,原因不写进 error', () => {
  const { projectToolResultForView } = require('../src/cli/tui/hooks/queryBridgeTimeline');
  const projected = projectToolResultForView({
    text: 'stdout body',
    success: false,
    severity: 'notice',
    noticeReason: '命令已执行，退出码 3（这是命令给出的结果，不是调用失败）',
    error: 'Exit code: 3\nstderr...',
  });
  assert.equal(projected.isError, false, 'notice 不得被下游四路布尔式判成红色失败');
  assert.equal(projected.severity, 'notice');
  assert.match(projected.notice, /退出码 3/);
  assert.equal(projected.error, undefined, '原因一旦进了 error,下游 `|| result.error` 照样全红');
});

test('projectToolResultForView:真错误路径逐字节不变', () => {
  const { projectToolResultForView } = require('../src/cli/tui/hooks/queryBridgeTimeline');
  const projected = projectToolResultForView({ text: 't', success: false, error: 'boom' });
  assert.equal(projected.isError, true);
  assert.equal(projected.error, 'boom');
  assert.equal(projected.severity, undefined);
});

test('projectToolResultForView:门控关 → notice 回退为红色失败(逐字节回退)', () => {
  withEnv('KHY_TOOL_SEVERITY_TIERS', '0', () => {
    const { projectToolResultForView } = require('../src/cli/tui/hooks/queryBridgeTimeline');
    const projected = projectToolResultForView({
      text: 't',
      success: false,
      severity: 'notice',
      error: 'exit 3',
    });
    assert.equal(projected.isError, true);
    assert.equal(projected.error, 'exit 3');
  });
});

// ── 呈现层:共享行判定 ──────────────────────────────────────────────────
test('toolDisplayLine:notice 走独立 status(黄 •),不落在 err/ok 任一端', () => {
  const d = require('../src/cli/toolDisplayLine');
  const notice = d.describeToolLine({
    name: 'shell_command',
    input: { command: 'node -e "process.exit(3)"' },
    result: { severity: 'notice', success: false, error: 'Exit code: 3' },
  });
  assert.equal(notice.status, 'notice');
  assert.equal(notice.glyph, '•');
  assert.equal(notice.color, 'yellow');

  const err = d.describeToolLine({ name: 'read', input: { path: 'x' }, result: { success: false, error: 'boom' } });
  assert.equal(err.status, 'err');
  assert.equal(err.glyph, '✗');

  const ok = d.describeToolLine({ name: 'read', input: { path: 'x' }, result: { success: true } });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.glyph, '✓');
});

test('toolDisplayLine:同一组里 notice 不算失败(跨端同形)', () => {
  const d = require('../src/cli/toolDisplayLine');
  const group = d.describeGroupLine([
    { name: 'shell_command', input: { command: 'a' }, result: { severity: 'notice', success: false, error: 'exit 3' } },
  ]);
  assert.equal(group.status, 'ok', 'notice 不得让整组变红');
  assert.equal(group.failed, 0);
});
