'use strict';

/**
 * Co-located tests for installRunner.js — isolated execution of an install plan.
 * No test here spawns a process: the runner seam is stubbed, and the pure helpers
 * (_managerOf / _buildExecInvocation / _classifyExecError / _tail) are asserted directly.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ir = require('./installRunner');
const {
  runInstall,
  managerMissingMessage,
  MANAGER_DOCS,
  DEFAULT_TIMEOUT_MS,
  _internal,
} = ir;
const { _managerOf, _buildExecInvocation, _classifyExecError, _tail } = _internal;

describe('DEFAULT_TIMEOUT_MS', () => {
  test('env 未设时为正的默认值（解析自字符串常量）', () => {
    assert.strictEqual(typeof DEFAULT_TIMEOUT_MS, 'number');
    assert.ok(Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0);
  });
});

describe('_managerOf', () => {
  test('取 argv 首词、小写、剥 .cmd/.bat/.exe 后缀', () => {
    assert.strictEqual(_managerOf(['NPM', 'install', 'x']), 'npm');
    assert.strictEqual(_managerOf(['npm.cmd', 'i']), 'npm');
    assert.strictEqual(_managerOf(['PIP.EXE', 'install', 'x']), 'pip');
    assert.strictEqual(_managerOf(['C:\\tools\\npm.bat', 'x']), 'c:\\tools\\npm');
  });

  test('垃圾输入归空串：null/undefined/空数组/非数组首元素', () => {
    assert.strictEqual(_managerOf(null), '');
    assert.strictEqual(_managerOf(undefined), '');
    assert.strictEqual(_managerOf([]), '');
    assert.strictEqual(_managerOf([0, 'x']), '');
    assert.strictEqual(_managerOf([null, 'x']), '');
    assert.strictEqual(_managerOf({}), '');
  });
});

describe('managerMissingMessage', () => {
  test('已知带 url 的包管理器给出官方安装链接', () => {
    const msg = managerMissingMessage('npm');
    assert.ok(msg.includes('Node.js'));
    assert.ok(msg.includes('https://nodejs.org/'));
    assert.ok(msg.includes('npm'));
  });

  test('os 类型无 url → 回落通用文案', () => {
    const msg = managerMissingMessage('os');
    assert.ok(!msg.includes('http'));
    assert.ok(msg.includes('os'));
  });

  test('未知 manager 走通用分支，不抛', () => {
    assert.ok(managerMissingMessage('wat').includes('wat'));
    assert.strictEqual(typeof managerMissingMessage(''), 'string');
    assert.strictEqual(typeof managerMissingMessage(null), 'string');
  });
});

describe('_buildExecInvocation', () => {
  test('POSIX：直接用 bin 作可执行，args 去掉首词', () => {
    const out = _buildExecInvocation(['npm', 'install', 'x'], 'linux');
    assert.strictEqual(out.exe, 'npm');
    assert.deepStrictEqual(out.args, ['install', 'x']);
  });

  test('win32：经 cmd.exe /d /s /c 包裹整条 argv（不传 shell:true）', () => {
    const out = _buildExecInvocation(['npm', 'install', 'x'], 'win32');
    assert.strictEqual(out.exe, process.env.COMSPEC || 'cmd.exe');
    assert.deepStrictEqual(out.args, ['/d', '/s', '/c', 'npm', 'install', 'x']);
    // 红线：绝不出现 shell 选项键。
    assert.strictEqual('shell' in out, false);
  });

  test('win32 单元素 argv 也只包 bin 自身', () => {
    const out = _buildExecInvocation(['cargo'], 'win32');
    assert.deepStrictEqual(out.args, ['/d', '/s', '/c', 'cargo']);
  });
});

describe('_classifyExecError', () => {
  test('ENOENT → manager-not-found', () => {
    const err = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
    assert.strictEqual(_classifyExecError(err, '', 'npm'), 'manager-not-found');
  });

  test('killed → timeout', () => {
    assert.strictEqual(_classifyExecError({ killed: true }, '', 'npm'), 'timeout');
  });

  test('win32「不是内部或外部命令」且提及 manager → manager-not-found', () => {
    const err = new Error("bash: 'npm' 不是内部或外部命令");
    assert.strictEqual(_classifyExecError(err, "'npm' 不是内部或外部命令", 'npm'), 'manager-not-found');
    assert.strictEqual(_classifyExecError(new Error('x'), 'npm: command not found', 'npm'), 'manager-not-found');
  });

  test('提及「not recognized」但未点名该 manager → 仍判 exit-nonzero', () => {
    assert.strictEqual(_classifyExecError(new Error('x'), "'git' is not recognized", 'npm'), 'exit-nonzero');
  });

  test('其它非零退出 → exit-nonzero', () => {
    assert.strictEqual(_classifyExecError(new Error('boom'), 'some failure', 'npm'), 'exit-nonzero');
    assert.strictEqual(_classifyExecError(null, '', 'npm'), 'exit-nonzero');
    assert.strictEqual(_classifyExecError(undefined, undefined, undefined), 'exit-nonzero');
  });

  test('KNOWN-DEFECT: manager 名以非单词字符结尾（如 g++）时 \\b 边界永不命中，缺失被误判为 exit-nonzero', () => {
    // installRunner.js:80 用 `\\b${escaped}\\b` 匹配 manager。'g++' 结尾 '+' 是非单词字符，
    // 其后无单词字符 → 尾部 \\b 永不成立，即便 stderr 明写 "g++ ... command not found" 也匹配不上，
    // 本应是 manager-not-found 的缺失被降级成 exit-nonzero，用户拿不到「先装运行时」的精准归因。
    assert.strictEqual(_classifyExecError(new Error('x'), "'g++' command not found", 'g++'), 'exit-nonzero');
    assert.strictEqual(_classifyExecError(new Error('x'), 'g++: command not found', 'g++'), 'exit-nonzero');
  });
});

describe('_tail', () => {
  test('短串原样，超长按尾部截断', () => {
    assert.strictEqual(_tail('hello'), 'hello');
    assert.strictEqual(_tail('hello', 3), 'llo');
  });

  test('null/undefined/数字经 String 归一，0 被吞成空串', () => {
    assert.strictEqual(_tail(null), '');
    assert.strictEqual(_tail(undefined), '');
    // String(s || '') —— 数字 0 是 falsy，被替换为 ''。
    assert.strictEqual(_tail(0), '');
    assert.strictEqual(_tail(''), '');
  });
});

describe('runInstall', () => {
  const ok = (argv) => ({ ok: true, code: 0, stdout: 'done', stderr: '' });

  test('无计划 / 空 command 数组 → no-plan，不调用 runner', () => {
    let called = 0;
    const runner = () => { called += 1; return ok([]); };
    return Promise.all([
      runInstall(null, { runner }).then((r) => assert.deepStrictEqual(r, { ok: false, steps: [], command: '', error: 'no-plan' })),
      runInstall({ command: [] }, { runner }).then((r) => assert.strictEqual(r.error, 'no-plan')),
      runInstall({ command: 'not-array' }, { runner }).then((r) => assert.strictEqual(r.error, 'no-plan')),
    ]).then(() => assert.strictEqual(called, 0));
  });

  test('单步成功：steps 记录 argv，command 回显主命令', async () => {
    const seen = [];
    const runner = (argv) => { seen.push(argv.join(' ')); return ok(argv); };
    const res = await runInstall({ command: ['npm', 'install', 'x'] }, { runner });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.command, 'npm install x');
    assert.strictEqual(res.steps.length, 1);
    assert.strictEqual(res.steps[0].command, 'npm install x');
    assert.deepStrictEqual(seen, ['npm install x']);
  });

  test('followUp 追加为第二步，全部成功才 ok', async () => {
    const seq = [];
    const runner = (argv) => { seq.push(argv.join(' ')); return ok(argv); };
    const res = await runInstall(
      { command: ['npm', 'install', 'puppeteer'], followUp: ['npx', 'puppeteer', 'browsers', 'install', 'chrome'] },
      { runner },
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.steps.length, 2);
    assert.deepStrictEqual(seq, ['npm install puppeteer', 'npx puppeteer browsers install chrome']);
  });

  test('主命令失败即短路：followUp 不执行，透传 hint', async () => {
    let calls = 0;
    const runner = () => {
      calls += 1;
      return { ok: false, code: 127, stdout: '', stderr: 'npm: command not found', error: 'manager-not-found', hint: '装 Node.js' };
    };
    const res = await runInstall(
      { command: ['npm', 'install', 'x'], followUp: ['npx', 'y'] },
      { runner },
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'manager-not-found');
    assert.strictEqual(res.hint, '装 Node.js');
    assert.strictEqual(calls, 1); // followUp 未跑
  });

  test('runner 抛异常 → 归类为 runner-threw，永不抛穿', async () => {
    const runner = () => { throw new Error('kaboom'); };
    const res = await runInstall({ command: ['npm', 'x'] }, { runner });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.steps[0].error, 'runner-threw');
    assert.strictEqual(res.error, 'runner-threw');
    assert.ok(res.steps[0].stderr.includes('kaboom'));
  });

  test('runner 返回缺 error 的失败 → 兜底 exit-nonzero', async () => {
    const res = await runInstall({ command: ['npm', 'x'] }, { runner: () => ({ ok: false, stdout: '', stderr: 'x' }) });
    assert.strictEqual(res.error, 'exit-nonzero');
  });

  test('MANAGER_DOCS 是真源映射表', () => {
    assert.strictEqual(MANAGER_DOCS.npm.url, 'https://nodejs.org/');
    assert.strictEqual(MANAGER_DOCS.os.url, null);
    assert.ok(MANAGER_DOCS.pip.runtime.includes('Python'));
  });
});
