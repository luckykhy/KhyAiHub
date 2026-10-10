'use strict';

/**
 * scripts/ci/check-delegation-boundary.js 的规则测试。
 *
 * 重点覆盖 finding id 7 `delegation-bypass-spawn` 的**判据边界**：
 * 它用 SPAWN_CALL_RE（含 `exec\b`）逐行找外部 CLI 的进程拉起点，而 JS 里
 * `/…/i.exec(s)` 这种**正则方法调用**会被 `exec\b` 命中，且 slug 解析行天然含
 * `claude` 字样 —— 二者同时出现即产生纯误报（曾实测把
 * `runtime/node/backend/src/utils/format/ccModelName.js` 的 slug 正则报成「旁路拉起 claude」）。
 *
 * 本文件把这条边界钉成回归：正则字面量不得被判为 spawn 点，而真旁路
 * （含与正则同行的真 spawn、含除法之后的真 spawn）必须照旧被抓 ——
 * 只断「修完变绿」而不断「真信号仍在」，就分不清「修好」与「修没了」。
 *
 * 刻意**不**对着真实仓库跑：真仓库的状态会随治理进度变化。每个用例建一个临时
 * 仓库当 fixture，用 KHY_DELEGATION_ROOT 把守卫指过去，只注入一处变量。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-delegation-boundary.js');
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/**
 * 最小 fixture：让 checkSsotAndGates / checkInjectedText / checkNudgeGate /
 * checkBoundaryIsCalled 各自能通过（否则输出里会混入别的 finding，干扰断言）。
 * 各用例只在 bypass-spawn 的判据输入上做一处变化。
 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-delg-'));
  tempDirs.push(root);
  writeFile(root, 'runtime/node/backend/src/services/externalAgentDirective.js', "'use strict';\n");
  writeFile(root, 'runtime/node/backend/src/tools/AgentTool/delegation.js', "'use strict';\n");
  return root;
}

function runGuard(root) {
  const result = cp.spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KHY_DELEGATION_ROOT: root },
    timeout: 120000,
  });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

/** 抽出输出里 delegation-bypass-spawn 命中的文件（相对路径，去重）。 */
function bypassHits(out) {
  return [
    ...new Set(
      out
        .split('\n')
        .filter((l) => l.includes('delegation-bypass-spawn'))
        .map((l) => (l.match(/runtime\/node\/backend\/src\/[^\s:]+/) || [''])[0])
        .filter(Boolean),
    ),
  ];
}

describe('check-delegation-boundary: bypass-spawn 判据边界', () => {
  test('真旁路：spawnSync("claude", …) 必须被抓', () => {
    const root = makeFixture();
    const f = 'runtime/node/backend/src/services/foo/realBypass.js';
    writeFile(
      root,
      f,
      [
        "'use strict';",
        "const { spawnSync } = require('child_process');",
        "const probe = () => spawnSync('claude', ['--version'], { encoding: 'utf8' });",
        'module.exports = { probe };',
        '',
      ].join('\n'),
    );
    assert.ok(bypassHits(runGuard(root)).includes(f), '真旁路漏检');
  });

  test('正则字面量：/^claude-…/i.exec(raw) 不得被判为 spawn 点（历史误报）', () => {
    const root = makeFixture();
    const f = 'runtime/node/backend/src/utils/format/slugParse.js';
    writeFile(
      root,
      f,
      [
        "'use strict';",
        'function fmt(model){',
        '  const raw = String(model);',
        '  const m = /^claude-(opus|sonnet|haiku)-(\\d+)/i.exec(raw);',
        '  return m ? m[2] : raw;',
        '}',
        'module.exports = { fmt };',
        '',
      ].join('\n'),
    );
    assert.deepEqual(bypassHits(runGuard(root)), [], '正则字面量被误报为旁路 spawn');
  });

  test('正则与真旁路同行：真信号不得被正则剥除逻辑吞掉', () => {
    const root = makeFixture();
    const f = 'runtime/node/backend/src/services/foo/mixed.js';
    writeFile(
      root,
      f,
      [
        "'use strict';",
        "const { spawn } = require('child_process');",
        'const RE = /^claude-(\\d+)/i;',
        "const go = (raw) => (RE.exec(raw) ? spawn('claude', ['-p', raw]) : null);",
        'module.exports = { go };',
        '',
      ].join('\n'),
    );
    assert.ok(bypassHits(runGuard(root)).includes(f), '同行有正则时真旁路被漏检');
  });

  test('除法不是正则：`a / b` 之后的真旁路不得被漏检', () => {
    const root = makeFixture();
    const f = 'runtime/node/backend/src/services/foo/divThenSpawn.js';
    writeFile(
      root,
      f,
      [
        "'use strict';",
        "const { execFileSync } = require('child_process');",
        'const run = (a, b) => {',
        '  const ratio = a / b;',
        "  return execFileSync('codex', ['--version']) + ratio;",
        '};',
        'module.exports = { run };',
        '',
      ].join('\n'),
    );
    assert.ok(bypassHits(runGuard(root)).includes(f), '除法被误判为正则起点导致真旁路漏检');
  });

  test('白名单目录（src/cli/）内的外部 CLI 拉起不报', () => {
    const root = makeFixture();
    writeFile(
      root,
      'runtime/node/backend/src/cli/probe.js',
      [
        "'use strict';",
        "const { spawnSync } = require('child_process');",
        "module.exports = () => spawnSync('claude', ['--version']);",
        '',
      ].join('\n'),
    );
    assert.deepEqual(bypassHits(runGuard(root)), [], '白名单目录被误报');
  });

  test('行内 khy-allow-PROCESS-004 抑制生效（理由非空）', () => {
    const root = makeFixture();
    writeFile(
      root,
      'runtime/node/backend/src/services/foo/suppressed.js',
      [
        "'use strict';",
        "const { spawnSync } = require('child_process');",
        '// khy-allow-PROCESS-004: fixture 里这是唯一入口，已过三闸门',
        "const probe = () => spawnSync('claude', ['--version']);",
        'module.exports = { probe };',
        '',
      ].join('\n'),
    );
    assert.deepEqual(bypassHits(runGuard(root)), [], '合法抑制未生效');
  });
});
