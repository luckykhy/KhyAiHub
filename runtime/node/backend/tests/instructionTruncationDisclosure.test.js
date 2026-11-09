'use strict';

/**
 * instructionTruncationDisclosure — 截断与丢弃必须在注入文本里留痕（bp-6 回归锁）。
 *
 * 断点：readFileSafe 对超限指令文件只做 slice，loadInstructions 装配时全程不读
 * truncated 标志 —— 模型拿到前半份规则却以为读全了，而唯一告知（/memory 的「(截断)」）
 * 只给人看、不进提示词；@include 目标的截断连标志都不置。appendQuickMemory 超限写入
 * 同样无声：UI 一路报「已记住」，内容永远到不了模型。
 *
 * 这些用例锁的是那条判据本身：标记 / 声明 / warning 任一被改回无声，这里就红。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 全局层落在 app home。用 env 指到临时目录，避免读到开发机上的真实 khy.md；
// 必须在 require 之前设 —— getAppHome() 进程内缓存。
const APP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-trunc-home-'));
process.env.KHY_APP_HOME = APP_HOME;
// own 层用例关掉生态层：本文件只锁 khy 自己那三层的留痕，生态层另有一个 corner 用例
// 单独开门（生态层的门控默认开，开发机 home 下若躺着别人的规则文件会窜改预算）。
process.env.KHY_RULES_ECOSYSTEM = '0';

const instr = require('../src/services/instructionFileService');
const reg = require('../src/services/instructionEcosystemRegistry');

/** Run body with env vars applied, then restore. */
function withEnv(vars, body) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

/** 生态 corner 用例的开门条件：开生态层，但关掉三个会读 home 的家族（codex/gemini/qwen），
 *  只留纯项目源，避免开发机 home 下的第三方规则文件窜改层内预算。 */
const ECO_PROJECT_ONLY = {
  KHY_RULES_ECOSYSTEM: '1',
  KHY_RULES_ECO_CODEX: '0',
  KHY_RULES_ECO_GEMINI: '0',
  KHY_RULES_ECO_QWEN: '0',
};

let _n = 0;
function freshProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `khy-trunc-${_n++}-`));
  return dir;
}

function clearAppHome() {
  for (const name of fs.readdirSync(APP_HOME)) {
    fs.rmSync(path.join(APP_HOME, name), { recursive: true, force: true });
  }
}

describe('instructionFileService 截断留痕', () => {
  beforeEach(clearAppHome);
  afterEach(clearAppHome);

  test('超限的 own 层文件在注入文本里留下截断标记，且标记自身占预算', () => {
    const tmp = freshProject();
    fs.writeFileSync(path.join(tmp, 'khy.md'), 'x'.repeat(9159), 'utf-8');
    const merged = instr.loadInstructions(tmp);
    assert.match(merged, /\[TRUNCATED: 该文件原文 \d+ 字符，超过单文件上限 8000/);
    assert.match(merged, /完整内容用 Read 工具直接读该文件/);
    // 标记不能把内容顶出单文件上限：注入的内容段仍然 <= MAX_FILE_CHARS
    const content = merged.slice(merged.indexOf('\n') + 1);
    assert.ok(
      content.length <= instr.MAX_FILE_CHARS,
      `内容段 ${content.length} 字符，超出单文件上限 ${instr.MAX_FILE_CHARS}`
    );
    // /memory 的人读视图不变：仍然只列真实文件，不列 notice
    const summary = instr.getInstructionSummary(tmp);
    assert.equal(summary.length, 1);
    assert.equal(summary[0].truncated, true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('@include 目标的截断同样留痕（外层文件的 truncated 标志并不置）', () => {
    const tmp = freshProject();
    fs.writeFileSync(path.join(tmp, 'khy.md'), 'rules\n\n@big.md\n', 'utf-8');
    fs.writeFileSync(path.join(tmp, 'big.md'), 'y'.repeat(9000), 'utf-8');
    const merged = instr.loadInstructions(tmp);
    assert.match(merged, /\[TRUNCATED: 该文件原文 9000 字符/);
    // 外层 khy.md 只有 12 字符 —— truncated 仍为 false，标记是唯一告知途径
    assert.equal(instr.getInstructionSummary(tmp)[0].truncated, false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('.khy/rules 里的超限文件留痕，内容仍不超单文件上限', () => {
    const tmp = freshProject();
    const dir = path.join(tmp, '.khy', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'big.md'), 'y'.repeat(54313), 'utf-8');
    const rules = instr.discoverRuleFiles(tmp);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].truncated, true);
    assert.equal(rules[0].content.length, instr.MAX_FILE_CHARS);
    assert.match(rules[0].content, /\[TRUNCATED: 该文件原文 54313 字符/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('未超限文件的注入逐字节不变（不给正常路径加噪声）', () => {
    const tmp = freshProject();
    const file = path.join(tmp, 'khy.md');
    fs.writeFileSync(file, '# rules\n- keep it small\n', 'utf-8');
    assert.equal(instr.loadInstructions(tmp), `[目录指令 - ${file}]\n# rules\n- keep it small\n`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('总预算切掉的文件在注入文本里声明切了多少', () => {
    fs.writeFileSync(path.join(APP_HOME, 'khy.md'), 'g'.repeat(instr.MAX_FILE_CHARS), 'utf-8');
    const tmp = freshProject();
    fs.writeFileSync(path.join(tmp, 'khy.md'), 'd'.repeat(instr.MAX_FILE_CHARS), 'utf-8');
    fs.writeFileSync(path.join(tmp, '.cursorrules'), 'c'.repeat(reg.ECO_MAX_FILE_CHARS), 'utf-8');
    fs.writeFileSync(path.join(tmp, '.rules'), 'z'.repeat(reg.ECO_MAX_FILE_CHARS), 'utf-8');
    withEnv(ECO_PROJECT_ONLY, () => {
      const merged = instr.loadInstructions(tmp);
      // 最后一个生态文件被总预算切短：必须有名有姓还有切掉多少
      assert.match(merged, /⚠ \[BUDGET\][^\n]*\\?\.rules[^\n]*仅注入前 \d+ 字符/);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('生态层总预算装不下一条声明时，该文件整体出局并被记账', () => {
    const tmp = freshProject();
    fs.writeFileSync(path.join(tmp, '.cursorrules'), 'c'.repeat(reg.ECO_MAX_FILE_CHARS), 'utf-8');
    fs.writeFileSync(path.join(tmp, '.rules'), 'z'.repeat(reg.ECO_MAX_FILE_CHARS - 40), 'utf-8');
    fs.writeFileSync(path.join(tmp, 'CONVENTIONS.md'), 'a'.repeat(reg.ECO_MAX_FILE_CHARS), 'utf-8');
    withEnv(ECO_PROJECT_ONLY, () => {
      const out = instr.discoverEcosystemInstructionFiles(tmp, new Set());
      const injected = out.filter((f) => f.kind !== 'notice');
      const total = injected.reduce((n, f) => n + f.content.length, 0);
      // 塞整条声明会把 budget 压成负数、层内合计顶穿 ECO_MAX_TOTAL_CHARS
      assert.ok(
        total <= reg.ECO_MAX_TOTAL_CHARS,
        `层内合计 ${total} 超出 ${reg.ECO_MAX_TOTAL_CHARS}`
      );
      assert.ok(injected.every((f) => f.content.length <= reg.ECO_MAX_FILE_CHARS));
      assert.ok(
        !injected.some((f) => f.path.endsWith('CONVENTIONS.md')),
        '装不下声明的文件不得注入'
      );
      const notice = out.find((f) => f.kind === 'notice');
      assert.ok(notice, '被预算挤掉的文件必须出现在汇总里');
      assert.match(notice.content, /\[SKIPPED: budget\][^\n]*CONVENTIONS\.md/);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('instructionFileService.appendQuickMemory 超限告知', () => {
  beforeEach(clearAppHome);
  afterEach(clearAppHome);

  test('超过单文件上限时 success 仍为真，但带 warning 点名文件与字符数', () => {
    const tmp = freshProject();
    fs.writeFileSync(path.join(tmp, 'khy.md'), 'x'.repeat(instr.MAX_FILE_CHARS + 159), 'utf-8');
    const res = instr.appendQuickMemory('第一条记忆：部署前必须跑测试', { cwd: tmp });
    assert.equal(res.success, true);
    assert.match(res.warning, /超过单文件上限 8000/);
    assert.match(res.warning, /超出部分不会进入系统提示词/);
    // 写入本身确实落在磁盘上（不是写入失败），只是到不了模型
    assert.match(fs.readFileSync(res.file, 'utf-8'), /第一条记忆：部署前必须跑测试/);
    assert.equal(instr.loadInstructions(tmp).includes('第一条记忆'), false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('未超限时不出现 warning 字段（正常路径零噪声）', () => {
    const tmp = freshProject();
    const res = instr.appendQuickMemory('小记忆', { cwd: tmp });
    assert.equal(res.success, true);
    assert.equal('warning' in res, false);
    assert.equal(instr.loadInstructions(tmp).includes('小记忆'), true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
