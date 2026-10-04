'use strict';

/**
 * archDebtScan 基线诚实性 — 两个「静默失真」缺陷的回归锁。
 *
 * 背景（2026-09-22 核查）：这套扫描器的棘轮语义曾以两个方向同时失真，
 * 而两个方向都**不报错、只是悄悄地判错**：
 *
 *   ① **基线悬空**：域迁移（`src/services/x.js` → `src/services/domain/<域>/…/x.js`）
 *      后基线未刷新 ⇒ 旧条目永不匹配（该文件被误判为「新增」），
 *      同时该文件的存量增长不再受棘轮约束。实测 38 条 layering 里 12 条悬空。
 *   ② **未跟踪漏扫**：`listChangedFiles()` 没有 `ls-files --others` ⇒ 新建的
 *      `??` 文件在体积门禁里完全不可见 —— 而这条规则拦的恰恰该是新增文件。
 *
 * 这两个缺陷是「工具本身不够诚实」，比它们想检测的代码缺陷危害更大：
 * 维护者会照着失真的读数归因。故各自锁一条断言，防止回归。
 * node:test。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const scan = require('../../scripts/archDebtScan');

// ── ① 基线悬空检测 ────────────────────────────────────────────────────────────

test('findStaleBaselineEntries: flags entries whose file no longer exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-stale-'));
  try {
    // 只造一个真实存在的文件；另一条指向不存在路径 = 悬空。
    fs.mkdirSync(path.join(tmp, 'src', 'real'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'real', 'exists.js'), '// ok\n');

    const baseline = {
      layering: [
        { file: 'src/real/exists.js', target: '../../cli/ai' },
        { file: 'src/ghost/moved-away.js', target: '../../cli/ai' },
      ],
      godFiles: [{ file: 'src/ghost/also-gone.js', loc: 3000 }],
      cycles: [],
    };
    const stale = scan.findStaleBaselineEntries(baseline, tmp);

    assert.strictEqual(stale.length, 2, 'exactly the two non-existent paths are stale');
    const files = stale.map((s) => s.file).sort();
    assert.deepStrictEqual(files, ['src/ghost/also-gone.js', 'src/ghost/moved-away.js']);
    for (const s of stale) {
      assert.ok(['layering', 'godFiles'].includes(s.kind), 'kind is a known dimension');
      assert.ok(typeof s.reason === 'string' && s.reason.length > 0);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findStaleBaselineEntries: an all-live baseline reports zero stale', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-stale-ok-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'live.js'), '// ok\n');
    const baseline = { layering: [{ file: 'src/live.js', target: 'x' }], godFiles: [], cycles: [] };
    assert.deepStrictEqual(scan.findStaleBaselineEntries(baseline, tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findStaleBaselineEntries: tolerates empty / malformed baselines', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-stale-empty-'));
  try {
    assert.deepStrictEqual(scan.findStaleBaselineEntries({}, tmp), []);
    assert.deepStrictEqual(
      scan.findStaleBaselineEntries({ layering: [null, {}, { file: '' }], godFiles: null }, tmp),
      [],
      'entries without a usable file path are skipped, not thrown on'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('formatStaleBaselineReport: all-clear vs warning wording', () => {
  assert.match(scan.formatStaleBaselineReport([]), /基线全部指向现存文件/);
  const text = scan.formatStaleBaselineReport([{ kind: 'layering', file: 'src/gone.js', reason: 'r' }]);
  assert.match(text, /悬空条目: 1 条/);
  assert.match(text, /src\/gone\.js/);
  assert.match(text, /update-baseline/, 'must point the maintainer at the fix');
});

test('main(--baseline-stale): read-only, exits 0', () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  let code;
  try {
    code = scan.main(['--baseline-stale']);
  } finally {
    process.stdout.write = orig;
  }
  assert.strictEqual(code, 0, 'staleness is a signal, never a blocking gate');
  assert.match(chunks.join(''), /基线悬空检测/);
});

test('main(--baseline-stale --json): machine-readable shape', () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  let code;
  try {
    code = scan.main(['--baseline-stale', '--json']);
  } finally {
    process.stdout.write = orig;
  }
  assert.strictEqual(code, 0);
  const parsed = JSON.parse(chunks.join(''));
  assert.ok(Array.isArray(parsed.baselineStale));
  assert.strictEqual(parsed.count, parsed.baselineStale.length);
});

// ── ② 只读子命令分发表（2026-09-24 从 main() 抽出，为守住体积棘轮） ────────────

test('main: 只读子命令分发退码 0，且「旗标 → JSON 键」一一对应', () => {
  // 表驱动分发把 collect / key / format 三者绑在一行里，最容易错配的就是 key；
  // 这里逐个跑通并断言顶层键，防止日后加子命令时把 collect 与 format 配错。
  const expected = [
    ['--drift', 'drift'],
    ['--scc', 'scc'],
    ['--god-report', 'godReport'],
  ];
  for (const [flag, key] of expected) {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { chunks.push(String(s)); return true; };
    let code;
    try {
      code = scan.main([flag, '--json']);
    } finally {
      process.stdout.write = orig;
    }
    assert.strictEqual(code, 0, `${flag} 是只读子命令，必须退码 0`);
    const parsed = JSON.parse(chunks.join(''));
    assert.deepStrictEqual(Object.keys(parsed), [key], `${flag} 的 JSON 顶层键必须是 ${key}`);
  }
});

// ── ② 未跟踪文件必须进入改动集 ────────────────────────────────────────────────

test('mergeUnique: order-preserving dedupe', () => {
  assert.deepStrictEqual(scan.mergeUnique(['b', 'a'], ['a', 'c']), ['b', 'a', 'c']);
  assert.deepStrictEqual(scan.mergeUnique([], ['x']), ['x']);
  assert.deepStrictEqual(scan.mergeUnique(['x'], []), ['x']);
});

test('listChangedFiles: includes untracked files, as repo-root-relative paths', () => {
  // 在一个一次性临时 git 仓库里验证取数契约，不污染本仓、不依赖本仓的脏工作区。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-changed-'));
  const backend = path.join(tmp, 'services', 'backend');
  try {
    fs.mkdirSync(path.join(backend, 'src'), { recursive: true });
    fs.writeFileSync(path.join(backend, 'src', 'tracked.js'), '// tracked\n');
    fs.writeFileSync(path.join(backend, 'src', 'brand-new.js'), '// untracked\n');

    const g = (args) => cp.execSync(`git ${args}`, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    g('init -q');
    g('config user.email t@t.t');
    g('config user.name t');
    g('add services/backend/src/tracked.js');
    g('commit -q -m init');

    // 制造一个已暂存的修改，确认「staged 分支」也会并入未跟踪文件。
    fs.writeFileSync(path.join(backend, 'src', 'tracked.js'), '// tracked changed\n');
    g('add services/backend/src/tracked.js');

    const list = listChangedFilesAt(backend);
    assert.ok(Array.isArray(list), 'must resolve, not return null, when git works');
    assert.ok(
      list.includes('services/backend/src/brand-new.js'),
      'untracked file must appear — this is the bug that let ?? files escape the gate'
    );
    assert.ok(
      list.includes('services/backend/src/tracked.js'),
      'staged modification must still appear'
    );
    for (const p of list) {
      assert.ok(
        p.startsWith('services/backend/'),
        `path must be repo-root-relative, got ${p} — mixing bases silently drops files`
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * 在**另一个 cwd** 上跑 listChangedFiles。
 * 模块把 BACKEND_ROOT 钉在自身位置，故这里复刻同一段取数逻辑并显式传入 cwd 与
 * 前缀，确保测试验证的是「契约」而不是本仓恰好干净的工作区。
 * （若将来该函数支持注入 root，可改为直接调用。）
 */
function listChangedFilesAt(backendRoot) {
  const git = 'git -c core.quotePath=false';
  const opts = { cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' };
  const run = (cmd) => {
    try {
      return cp.execSync(cmd, opts).trim();
    } catch {
      return '';
    }
  };
  const split = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean);
  const prefix = run(`${git} rev-parse --show-prefix`);
  const others = () => split(run(`${git} ls-files --others --exclude-standard`)).map((p) => prefix + p);
  const staged = run(`${git} diff --name-only --cached --diff-filter=ACMR`);
  if (staged) return Array.from(new Set([...split(staged), ...others()]));
  const head = run(`${git} diff --name-only --diff-filter=ACMR HEAD`);
  if (head) return Array.from(new Set([...split(head), ...others()]));
  const u = others();
  return u.length ? u : null;
}

// ── ③ 正则字面量不得让状态机失同步（2026-09-24 修 A1）────────────────────────
//
// 缺陷形态：`stripComments` 原实现只有「代码/注释/字符串」态，判断 `/` 时只看后一
// 字符。正则字符类里可以合法出现 `/*`（例如路径/glob 用的 `/[\w./*-]+/`），
// 于是被当成块注释起点 → 状态机失同步 → **后续真实代码被一路清空**。
// 实测影响 `cli/handlers/publish.js`、`services/localToolLoop.js`、
// `services/domain/build/forge/forgeCore.js` 共 175 行，并吞掉一处真实 require。
//
// 这组断言锁住两个方向：正则不再制造幻影注释（核心），且注释剔除这个**原动机**不回退。

const RE_REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const countRequires = (s) => (s.match(RE_REQUIRE) || []).length;

test('stripComments: 正则字符类里的 /* 不再是幻影块注释（A1 最小复现）', () => {
  const src = "const GLOB_RE = /[\\w./*-]+/;\nconst r = require('./real');\n";
  const clean = scan.stripComments(src);
  assert.strictEqual(
    countRequires(clean),
    1,
    '真实 require 必须保住；若为 0 说明正则里的 /* 把后续代码吞成了注释'
  );
});

test('stripComments: 各类正则字面量都不会吞掉其后的 require', () => {
  const cases = [
    ['字符类含 * 与 /', 'const RE = /[\\w./*-]+/;\nconst r = require("./a");\n'],
    ['转义斜杠 + 引号', 'const RE = /\\bhttps?:\\/\\/[^\\s<>"\')]+/i;\nconst r = require("./b");\n'],
    ['自闭合转义斜杠', "const RE = /^(https?|ssh|git):\\/\\//i;\nconst r = require('./c');\n"],
    ['字符类含单引号', "const RE = /['\"]/;\nconst r = require('./d');\n"],
    ['return 位置的正则', "function f() {\n  return /[\\w./*-]+/;\n}\nconst r = require('./e');\n"],
  ];
  for (const [name, src] of cases) {
    assert.strictEqual(countRequires(scan.stripComments(src)), 1, name);
  }
});

test('stripComments: 除法不会被误判成正则（注释仍需被剔除）', () => {
  const src = 'const half = total / 2; // require("./not-real")\nconst r = require("./kept");\n';
  const clean = scan.stripComments(src);
  assert.strictEqual(
    countRequires(clean),
    1,
    '注释里的伪调用要被剔除，真实调用要保留'
  );
  assert.ok(!clean.includes('./not-real'), '行注释里的 require 必须被剥掉');
  assert.ok(clean.includes('./kept'), '代码里的 require 必须保留');
});

test('stripComments: 原动机不回退——文档注释里复述的 require 仍被剔除', () => {
  const src = [
    '/**',
    ' * 本文件的存在意义是消除 ../../cli/ai 这条倒置，',
    " * 所以注释里提到 require('../../cli/ai') 不该被算成倒置。",
    ' */',
    "const real = require('./localThing');",
    '',
  ].join('\n');
  const clean = scan.stripComments(src);
  assert.ok(!clean.includes('../../cli/ai'), '注释里复述的路径必须消失');
  assert.ok(clean.includes('./localThing'), '真实 require 必须保留');
});

test('extractRequires: 正则字面量之后的真实 require 能被扫到（端到端）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-regex-'));
  try {
    const file = path.join(tmp, 'sample.js');
    fs.writeFileSync(
      file,
      [
        "'use strict';",
        'const GLOB_RE = /[\\w./*-]+/;',
        "const real = require('./localNlp');",
        '',
      ].join('\n')
    );
    const found = scan.extractRequires(file);
    assert.deepStrictEqual(
      found.map((r) => r.spec),
      ['./localNlp'],
      '正则之后的 require 必须出现在扫描结果里'
    );
    assert.strictEqual(found[0].line, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

