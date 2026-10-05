'use strict';

/**
 * check-toplevel-side-effects 测试（`RUNTIME-012` / `[DESIGN-ARCH-178]` §3.1 §4）。
 *
 * 跑法：`npm run test:scripts`（= `node --test "scripts/tests/**\/*.test.js"`）
 * 单跑：`node --test scripts/tests/check-toplevel-side-effects.test.js`
 *
 * ⚠ 本仓另一套 runner 是 jest。这里用 `node:test`，因为守卫本身是 `scripts/` 下的
 * Node 脚本，与同目录既有守卫测试（check-tui-cadence / check-commit-timing 等）一致。
 *
 * ## 覆盖重点
 *
 * 1. **阶段真的生效**：同一输入在 S1 与 S3 下的 error 数**必须不同**。没有这条，
 *    `STAGE` 常量就是装饰 —— 升到 S3 后仍不拦截，而所有守卫全绿。
 * 2. **判据是「同步可达」不是「文本出现过」**：惰性 thunk（`() => require('x')`）
 *    与入口守卫（`if (require.main === module)`）必须**放行**。这是原型 v1 的
 *    误报根源（实测 7 条命中里 2 条是假警报），必须钉死。
 * 3. **方言必须被 ruleguard 解析**：`[WARN ]` 行带尾随文字会被 `FINDING_LINE` 的
 *    `\s*$` 静默丢弃 —— 那时「肉眼看到报了 N 条，门里 counts=0」，两边都绿。
 * 4. **`--changed` 语义**：改动集未触及源根 ⇒ 恒静默；`--files=` 空值不得静默
 *    fall through 到真实暂存集。
 * 5. **扫描器精度**：多行实参列表续行（`router.post(\n [\n body('x')`）**不得**
 *    被当成顶层语句 —— 那是我用 acorn oracle 对拍时抓到的第一批误报。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-toplevel-side-effects.js');
const guard = require(path.join(ROOT, 'scripts', 'lib', 'toplevelSideEffectGuard.js'));

/**
 * 跑一个场景。`stage` 传非 'S1' 时，临时拷一份改掉 STAGE 常量（模拟升阶）。
 *
 * ⚠ 结果按 (stage, args) 缓存：本文件有 20+ 用例、每个 spawn 一个 Node 子进程。
 * 全量 `npm run test:scripts` 的并发压力下个别 spawn 会超时（表现为间歇 not ok，
 * 单独跑必绿）。判定本身是纯函数，重复 spawn 本就是在测 Node 而不是测判据。
 */
const _cache = new Map();
function run(args = [], opts = {}) {
  const stage = opts.stage || 'S1';
  const key = JSON.stringify({ stage, args });
  if (_cache.has(key)) return _cache.get(key);
  const r = cp.spawnSync(process.execPath, [scriptFor(stage), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /Summary: (\d+) error\(s\), (\d+) warning\(s\)\./.exec(output);
  const out = {
    status: r.status,
    output,
    errors: m ? Number(m[1]) : -1,
    warnings: m ? Number(m[2]) : -1,
  };
  _cache.set(key, out);
  return out;
}

/**
 * 取某阶段对应的脚本路径。S1 用真身；其余用临时改过常量的副本。
 *
 * ⚠ 副本**不能**落在 `scripts/ci/` 下：那正是 `check-wiring.js` 的检查器扫描范围，
 * 测试跑的那几秒里另一个终端跑 `check:wiring` 会看到它「零接线」而报 error。
 * ⇒ 落 `scripts/.toplevel-side-effect-tmp/`。
 */
const TMP_DIR = path.join(ROOT, 'scripts', '.toplevel-side-effect-tmp');
const _tmpCache = new Map();
function scriptFor(stage) {
  if (stage === 'S1') return SCRIPT;
  if (_tmpCache.has(stage)) return _tmpCache.get(stage);
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const patched = src.replace(/^const STAGE = 'S1';/m, `const STAGE = '${stage}';`);
  assert.notEqual(patched, src, `无法把 STAGE 常量改成 ${stage}（源码形状变了？）`);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, `_toplevel-side-effect-${stage}.js`);
  fs.writeFileSync(p, patched, 'utf8');
  _tmpCache.set(stage, p);
  return p;
}

process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

const ev = (src, p = 'synth/x.js') => guard.evaluate({ files: [{ path: p, src }] }, { stage: 'S1' });

// ── 1. 阶段真的生效 ─────────────────────────────────────────────────────────

describe('check-toplevel-side-effects — 阶段真的生效（STAGE 不是装饰）', () => {
  test('同一输入在 S1 与 S3 下 error 数必须不同', () => {
    const s1 = run(['--scenario=eager'], { stage: 'S1' });
    const s3 = run(['--scenario=eager'], { stage: 'S3' });
    assert.notEqual(s1.errors, s3.errors, `S1 与 S3 的 error 数相同（${s1.errors}）—— STAGE 没生效\n${s1.output}`);
    assert.equal(s1.errors, 0, `S1 必须 0 error（PP-3 只记录不阻断）\n${s1.output}`);
    assert.ok(s3.errors > 0, `S3 必须派生 error\n${s3.output}`);
  });

  test('退出码语义：S1 恒 0，S3 有 error 才 1', () => {
    assert.equal(run(['--scenario=eager'], { stage: 'S1' }).status, 0);
    assert.equal(run(['--scenario=eager'], { stage: 'S3' }).status, 1);
    assert.equal(run([], { stage: 'S1' }).status, 0, 'baseline 在 S1 恒 0');
  });

  test('severityFor 是单点派生：未知判据降 warning，已裁决命中恒 info', () => {
    assert.equal(guard.severityFor('toplevel-side-effect', 'S1'), 'warning');
    assert.equal(guard.severityFor('toplevel-side-effect', 'S3'), 'error');
    assert.equal(guard.severityFor('toplevel-side-effect-known', 'S3'), 'info', '已裁决不得升 error');
    assert.equal(guard.severityFor('toplevel-call-imported', 'S3'), 'info', '盲区盘点不得升 error');
    assert.equal(guard.severityFor('不存在的判据', 'S3'), 'warning', '未知判据必须降级，禁 fail-open');
  });

  test('真实 baseline 在 S3 下仍然 0 error（存量全部已裁决）', () => {
    const s3 = run([], { stage: 'S3' });
    assert.equal(s3.errors, 0, `存量 4 条应全部命中白名单 ⇒ S3 也不该报 error\n${s3.output}`);
  });
});

// ── 2. 不误伤：判据是「同步可达」，不是「文本出现过」──────────────────────────

describe('check-toplevel-side-effects — 不误伤（判据不是恒真）', () => {
  test('真实仓库 baseline 0 error / 0 warning', () => {
    const r = run([]);
    assert.equal(r.errors, 0, r.output);
    assert.equal(r.warnings, 0, r.output);
  });

  test('反例矩阵 7/7 通过（含 4 个「应放行」对照）', () => {
    const r = run(['--scenario=matrix']);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /反例矩阵：7\/7 通过/);
  });

  test('惰性 thunk（() => require("x")）必须放行 —— 原型 v1 的误报根源', () => {
    assert.equal(ev(guard.SYNTH_LAZY_THUNK).length, 0,
      '箭头函数体内的 require 是惰性的，不得报');
    // 反向对照：把 require 挪到箭头外必须立刻报 —— 否则上面那条是空转
    const eager = guard.SYNTH_LAZY_THUNK.replace(
      "    create: (opts) => require('./feishuAdapter').create(opts),",
      "    const m = require('./feishuAdapter');",
    );
    assert.notEqual(eager, guard.SYNTH_LAZY_THUNK, '替换锚点失效');
    assert.equal(ev(eager).length, 1, 'require 移出箭头后必须报');
  });

  test('入口守卫（if (require.main === module) { main(); }）必须放行', () => {
    assert.equal(ev(guard.SYNTH_ENTRY_GUARDED).length, 0,
      '被 require.main 守卫的调用不是模块加载期副作用');
  });

  test('顶层调用无副作用的函数必须放行', () => {
    assert.equal(ev(guard.SYNTH_PLAIN_TOPLEVEL).length, 0);
  });

  test('多行实参列表续行不得被当成顶层语句（acorn 对拍抓到的第一批误报）', () => {
    const src = [
      "const { body } = require('express-validator');",
      "router.post('/x', [",
      "  body('a').trim(),",
      "  body('b').isEmail(),",
      ']);',
    ].join('\n');
    const found = ev(src);
    assert.equal(found.length, 0, `续行里的 body() 不是顶层语句\n${JSON.stringify(found, null, 2)}`);
  });
});

// ── 3. 反例命中 ─────────────────────────────────────────────────────────────

describe('check-toplevel-side-effects — 反例命中', () => {
  test('eager（顶层 initRedis 同步 require redis）→ 1 条 warning', () => {
    const r = run(['--scenario=eager']);
    assert.equal(r.warnings, 1, r.output);
    assert.match(r.output, /toplevel-side-effect /);
    assert.match(r.output, /synth\/eager\.js:12/);
  });

  test('cacheService 病灶形态（require + createClient + connect）三形态都识别', () => {
    const found = ev(guard.SYNTH_EAGER);
    assert.equal(found.length, 1);
    assert.equal(found[0].criterion, 'toplevel-side-effect');
    assert.match(found[0].via, /require\(\)/);
    assert.match(found[0].via, /createClient\(\)/);
    assert.match(found[0].via, /\.connect\(\)/);
  });

  test('已裁决命中降为 info，**不得**报 warning（告警疲劳防线）', () => {
    const known = Object.keys(guard.KNOWN_TOPLEVEL_SIDE_EFFECTS)[0];
    const [file, name] = known.split('|');
    assert.ok(file && name, `白名单 key 形状异常：${known}`);
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const found = ev(src, file);
    const hit = found.find((f) => f.name === name);
    assert.ok(hit, `${file} 应命中 ${name}`);
    assert.equal(hit.severity, 'info', '已裁决命中必须降 info');
    assert.match(hit.message, /已裁决保留/, '必须带出处，无出处的降级等于关掉判据');
  });

  test('跨文件导入的被调方只盘点，不判违规', () => {
    const found = ev(guard.SYNTH_IMPORTED);
    assert.equal(found.length, 1);
    assert.equal(found[0].criterion, 'toplevel-call-imported');
    assert.equal(found[0].severity, 'info');
  });

  test('读不到的源 → source-unreadable（聚合方言，不伪造行号）', () => {
    const found = guard.evaluate({ files: [{ path: 'a/b.js', error: 'ENOENT' }] }, { stage: 'S1' });
    assert.equal(found.length, 1);
    assert.equal(found[0].criterion, 'source-unreadable');
    assert.equal(found[0].line, 0, '无行号时必须是 0，不得伪造');
  });
});

// ── 4. 方言必须被 ruleguard 解析（最贵的一类假绿）────────────────────────────

describe('check-toplevel-side-effects — finding 方言被 ruleguard 解析', () => {
  const ruleguard = (() => {
    try { return require(path.join(ROOT, 'scripts', 'ruleguard', 'lib', 'run.js')); } catch { return null; }
  })();

  test('逐项方言（有行号）能被解析出 1 条 warning', () => {
    if (!ruleguard) return; // ruleguard 不在时跳过（不假装通过）
    const r = run(['--scenario=eager']);
    const parsed = ruleguard.parseFindings(r.output);
    assert.equal(parsed.length, 1, `ruleguard 解析数 ≠ 肉眼可见数\n${r.output}`);
    assert.equal(parsed[0].finding, 'toplevel-side-effect');
    assert.equal(parsed[0].severity, 'warning');
    assert.equal(parsed[0].file, 'synth/eager.js');
    assert.equal(parsed[0].line, 12);
  });

  test('逐项方言行不得带尾随文字（否则 FINDING_LINE 的 \\s*$ 失配）', () => {
    const r = run(['--scenario=eager']);
    const line = r.output.split(/\r?\n/).find((l) => l.startsWith('[WARN ]'));
    assert.ok(line, r.output);
    assert.match(line, /^\[WARN \] \S+ \S+:\d+$/, `方言行带了尾随文字：${line}`);
  });

  test('聚合方言（无行号）能被解析出 1 条 warning', () => {
    if (!ruleguard) return;
    const r = run(['--scenario=unreadable']);
    const parsed = ruleguard.parseFindings(r.output);
    assert.equal(parsed.length, 1, `聚合方言未被解析\n${r.output}`);
    assert.equal(parsed[0].finding, 'source-unreadable');
    assert.equal(parsed[0].line, 0, '聚合方言的 line 必须是 0');
  });

  test('info 行不参与方言（不得伪装成 ERROR/WARN）', () => {
    const r = run(['--list']);
    const infoLines = r.output.split(/\r?\n/).filter((l) => l.startsWith('[INFO ]'));
    assert.ok(infoLines.length > 0, `baseline 应有 info 盘点\n${r.output}`);
    for (const l of infoLines) assert.ok(!/^\[(ERROR|WARN )\]/.test(l), l);
  });

  test('默认输出不含 info（信噪比防线：存量盘点不得每次提交重报）', () => {
    const plain = run([]);
    assert.ok(!/toplevel-call-imported/.test(plain.output), `默认输出混入了 info 盘点\n${plain.output}`);
    const listed = run(['--list']);
    assert.match(listed.output, /toplevel-call-imported/, '--list 必须能看到全部');
  });
});

// ── 5. --changed 语义 ───────────────────────────────────────────────────────

describe('check-toplevel-side-effects — --changed 语义', () => {
  test('改动集未触及源根 ⇒ 恒静默', () => {
    const r = run(['--changed', '--files=docs/README.md']);
    assert.equal(r.warnings, 0, r.output);
    assert.match(r.output, /未触及顶层副作用面/);
  });

  test('改动集触及源根 ⇒ 跑全量判定', () => {
    const r = run(['--changed', '--files=runtime/node/backend/src/services/cacheService.js']);
    assert.ok(!/未触及顶层副作用面/.test(r.output), `触及了却跳过\n${r.output}`);
    assert.match(r.output, /Summary:/);
  });

  test('--files= 空值是「显式空集」，不得 fall through 到真实暂存集', () => {
    const r = run(['--changed', '--files=']);
    assert.equal(r.warnings, 0, r.output);
    assert.match(r.output, /未触及顶层副作用面/);
  });
});

// ── 6. 纯叶子：绝不抛 ───────────────────────────────────────────────────────

describe('check-toplevel-side-effects — 纯叶子绝不抛', () => {
  test('垃圾输入不抛', () => {
    for (const bad of [null, undefined, 0, '', 'x', [], {},
      { files: null }, { files: [null] }, { files: [{ path: null, src: null }] },
      { files: [{ path: 'a.js', src: '}}}' }] }]) {
      assert.doesNotThrow(() => guard.evaluate(bad, { stage: 'S1' }));
      assert.doesNotThrow(() => guard.summarize(bad));
    }
    assert.doesNotThrow(() => guard.blankNonCode(null));
    assert.doesNotThrow(() => guard.scanSource(undefined));
    assert.doesNotThrow(() => guard.scanSource('const s = "未闭合'));
    assert.doesNotThrow(() => guard.scanSource('/* 未闭合'));
    assert.doesNotThrow(() => guard.scanSource('const r = /未闭合'));
  });

  test('词法：字符串 / 模板 / 注释 / 正则里的 require 不算代码', () => {
    const cases = [
      'const a = "require(\'x\')";',
      "const b = 'require(" + '"y")' + "';",
      'const c = `require("z")`;',
      '// require("comment")\nconst d = 1;',
      '/* require("block") */\nconst e = 1;',
      'const f = /require\\(/g;',
    ];
    for (const src of cases) {
      const blanked = guard.blankNonCode(src);
      assert.ok(!/\brequire\b/.test(blanked.replace(/\brequire\b(?=[^"']*")/g, '')),
        `未涂白：${src}\n→ ${blanked}`);
      assert.equal(blanked.length, src.length, '涂白必须等长（保偏移与行号）');
    }
  });

  test('词法：除号不被误判成正则起始', () => {
    const src = 'const a = 10 / 2; const b = a / 5;\nfunction g() {\n  require("x");\n}\ng();';
    const found = guard.evaluate({ files: [{ path: 's.js', src }] }, { stage: 'S1' });
    assert.equal(found.length, 1, `除号误判会吃掉后面的代码\n${JSON.stringify(found)}`);
  });

  test('括号深度：三种深度同时为 0 才算顶层语句', () => {
    const src = [
      'function f() {',
      "  require('x');",
      '}',
      'f();',
    ].join('\n');
    const r = guard.scanSource(src);
    assert.deepEqual(r.topLevelCalls.map((c) => c.name), ['f']);
  });
});
