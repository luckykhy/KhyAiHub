'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { SWAP_SCRIPT_BODY } = require('./windowsSwapScript');

// This module is a pure constant: the PowerShell body for the deferred
// portable swap. Paths never appear as literals here — they arrive as bound
// script parameters ($Live/$Incoming/$Backup/$Result), which is precisely what
// keeps a path containing spaces or backslashes from breaking the command.

describe('windowsSwapScript — SWAP_SCRIPT_BODY', () => {
  test('非空字符串且以 CRLF 分行', () => {
    assert.equal(typeof SWAP_SCRIPT_BODY, 'string');
    assert.ok(SWAP_SCRIPT_BODY.length > 0);
    const lines = SWAP_SCRIPT_BODY.split('\r\n');
    assert.ok(lines.length > 10);
    // Every line must be plain script text, no stray lone \n (join used \r\n).
    for (const line of lines) {
      assert.equal(line.includes('\n'), false);
    }
  });

  test('声明五个参数且 ParentPid 为 int', () => {
    const head = SWAP_SCRIPT_BODY.split('\r\n')[0];
    for (const name of ['$ParentPid', '$Live', '$Incoming', '$Backup', '$Result']) {
      assert.ok(head.includes(name), `param decl missing ${name}`);
    }
    assert.ok(head.includes('[int]$ParentPid'));
    for (const s of ['$Live', '$Incoming', '$Backup', '$Result']) {
      assert.ok(head.includes(`[string]${s}`));
    }
  });

  test('所有路径型 cmdlet 均用 -LiteralPath（空格/反斜杠路径不被 glob 或引号破坏）', () => {
    // Path-consuming cmdlets must bind their path via -LiteralPath, never as a
    // positional argument that PowerShell would glob/quote-split.
    const pathCmdlets = ['Test-Path', 'Remove-Item', 'Move-Item', 'Set-Content'];
    for (const cmd of pathCmdlets) {
      const re = new RegExp(`${cmd}(\\s+-\\w+)`, 'g');
      let m;
      while ((m = re.exec(SWAP_SCRIPT_BODY)) !== null) {
        assert.equal(
          m[1],
          ' -LiteralPath',
          `${cmd} invoked without -LiteralPath: ${m[0]}`
        );
      }
    }
    // Sanity: at least one -LiteralPath occurrence exists.
    assert.ok(SWAP_SCRIPT_BODY.includes('-LiteralPath'));
  });

  test('路径只经变量流入，脚本体内不含任何真实文件系统路径字面量', () => {
    // No drive-letter paths, no user dirs, no JS template interpolation of a
    // caller-supplied path value.
    assert.equal(/[A-Za-z]:[\\/]/.test(SWAP_SCRIPT_BODY), false);
    assert.equal(SWAP_SCRIPT_BODY.includes('${'), false);
    // Only the four bound variables may carry a path.
    for (const v of ['$Live', '$Incoming', '$Backup', '$Result']) {
      assert.ok(SWAP_SCRIPT_BODY.includes(v));
    }
  });

  test('失败与成功都写回 Result，且脚本自删临时文件', () => {
    assert.ok(SWAP_SCRIPT_BODY.includes('success = $true'));
    assert.ok(SWAP_SCRIPT_BODY.includes('success = $false'));
    assert.ok(SWAP_SCRIPT_BODY.includes('$_.Exception.Message'));
    assert.ok(SWAP_SCRIPT_BODY.includes('$MyInvocation.MyCommand.Path'));
    assert.ok(/Set-Content -LiteralPath \$Result/.test(SWAP_SCRIPT_BODY));
  });

  test('垃圾入参不影响：模块只导出常量，重复 require 同引用', () => {
    assert.deepStrictEqual(Object.keys(require('./windowsSwapScript')), ['SWAP_SCRIPT_BODY']);
    assert.equal(require('./windowsSwapScript').SWAP_SCRIPT_BODY, SWAP_SCRIPT_BODY);
  });
});
