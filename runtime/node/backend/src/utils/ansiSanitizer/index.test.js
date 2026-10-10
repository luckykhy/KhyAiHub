'use strict';

/**
 * ansiSanitizer 单元契约测试（[RESEARCH-018] §2.3 功能单元第 4 件 / 5-3-1 §3）。
 *
 * 第 20 批把真身从 cli/ 归位到 D3，旧路径只剩一行再导出壳。壳型搬迁的风险不是
 * 「改错逻辑」而是「两头不同步 / 边长回来」，所以锁三件事：
 * ① 壳与真身是同一个模块对象；② 导出符号集齐全；③ D3 侧消费者不得再指回 D1。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const SHELL_PATH = require.resolve('../../cli/ansiSanitizer.js');
const STRIP_PATH = require.resolve('../stripAnsi.js');
const truth = require('./index.js');
const shell = require(SHELL_PATH);

test('shell re-exports the very same module object as the truth body', () => {
  assert.strictEqual(shell, truth);
});

test('truth exports the full symbol set and the shell carries zero logic', () => {
  assert.deepStrictEqual(Object.keys(truth).sort(), [
    'RE_BARE_CONTROL',
    'RE_CSI',
    'RE_DCS',
    'RE_ESC_SHORT',
    'RE_OSC',
    'RE_ZERO_WIDTH',
    'hasAnsiSequences',
    'stripAnsiSequences',
  ]);
  const statements = fs
    .readFileSync(SHELL_PATH, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && l !== "'use strict';");
  assert.strictEqual(statements.length, 1, `shell must carry zero logic, got ${statements.length}`);
  assert.ok(/^module\.exports = require\(/.test(statements[0]), statements[0]);
});

test('half-stripped ANSI leaves no visible residue (the BUG the sanitizer exists for)', () => {
  const dirty = String.fromCharCode(27) + '[1m_标题_';
  assert.strictEqual(truth.stripAnsiSequences(dirty), '_标题_');
  assert.strictEqual(truth.hasAnsiSequences(dirty), true);
  assert.strictEqual(truth.hasAnsiSequences('_标题_'), false);
  // 非字符串输入原样返回：契约「绝不抛」。
  assert.strictEqual(truth.stripAnsiSequences(null), null);
});

test('the D3 consumer points at the D3 truth, not back into cli/ (batch-20 edge lock)', () => {
  const src = fs.readFileSync(STRIP_PATH, 'utf8');
  const cliSpec = "require('.." + "/cli/ansiSanitizer')";
  assert.ok(!src.includes(cliSpec), 'utils/stripAnsi.js must not reach into D1 again');
  const stripAnsi = require(STRIP_PATH);
  assert.strictEqual(typeof stripAnsi, 'function');
  assert.strictEqual(stripAnsi(dirtyish()), 'plain');
  function dirtyish() {
    return String.fromCharCode(27) + '[0mplain';
  }
});
