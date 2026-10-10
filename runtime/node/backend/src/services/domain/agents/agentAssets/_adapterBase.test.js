'use strict';

/**
 * _adapterBase.test.js — 钉死三家外部 agent 适配器的公共底座：根目录探测、fail-soft IO、
 * 有界遍历、frontmatter 解析/序列化。
 *
 * 为什么这支套件必须存在：文件头把自己规定成「fail-soft 分层：本层的每个函数要么返回值
 * 要么返回 null/空数组，绝不抛」，而 6 个适配器的每一个调用点都**没有** try/catch
 * （adapters/*.js 里 listMemories/listTools/listSkills 直接串接本层函数）。一旦本层某处
 * 抛出去，整条 discover/import 链路就会以未捕获异常崩掉，而不是回报「这家读不出来」。
 * 故抛/不抛的方向逐函数钉死。
 *
 * 实测更正（与注释/直觉不同处，按真实语义钉死）：
 *   · probeRoot 的 env 覆盖变量指向不存在的目录时**立即返回错误**，不再尝试任何默认候选
 *     （源码注释明说「悄悄换地方写比报错更糟」），所以「设置了但写错」永远拿不到默认路径。
 *   · walkFiles 的 exts 数组里放非字符串会让 `e.toLowerCase()` 抛出（见 KNOWN-DEFECT 两条）。
 *   · serializeFrontmatter 只要 rawFrontmatter 非空就**无条件**回吐原文，完全不比对 data
 *     是否被改过——文件头「data 未被改动时优先回吐」的那半句并不存在。
 *   · readText 对目录返回 null（把 _shared.readIfExists 的 EISDIR 吞在本层），
 *     而 _shared 本身是抛出的一层——分层收敛点就在这里。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const B = require('./_adapterBase');

const ROOTS = [];

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-base-'));
  const target = name ? path.join(dir, name) : dir;
  fs.mkdirSync(target, { recursive: true });
  ROOTS.push(dir);
  return target;
}

function touch(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

after(() => {
  for (const dir of ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ── 导出面 ────────────────────────────────────────────────────────────────

test('_adapterBase 恰导出 18 个符号（适配器契约面）', () => {
  assert.deepStrictEqual(Object.keys(B).sort(), [
    'WALK_MAX_DEPTH',
    'WALK_MAX_FILES',
    'expandHome',
    'homeDir',
    'isDir',
    'isFile',
    'mtimeIso',
    'parseFrontmatter',
    'probeRoot',
    'readJson',
    'readText',
    'removeDir',
    'removeFile',
    'serializeFrontmatter',
    'toRelPath',
    'walkFiles',
    'writeText',
    'xdgConfigHome',
  ].sort());
  assert.strictEqual(B.WALK_MAX_DEPTH, 6);
  assert.strictEqual(B.WALK_MAX_FILES, 2000);
});

// ── expandHome / homeDir / xdgConfigHome ──────────────────────────────────

test('expandHome 委托 _shared：~ 与 ~/ 展开、其余原样、falsy 不进展开分支', () => {
  const env = { HOME: '/fake-home' };
  assert.strictEqual(B.expandHome('~', env), '/fake-home');
  assert.strictEqual(B.expandHome('~/a/b', env), path.join('/fake-home', 'a/b'));
  assert.strictEqual(B.expandHome('/etc/passwd', env), '/etc/passwd');
  assert.strictEqual(B.expandHome('~nope', env), '~nope');
  assert.strictEqual(B.expandHome('', env), '');
  assert.strictEqual(B.expandHome(null, env), null);
});

test('homeDir / xdgConfigHome 全从传入 env 推算，绝不读真实用户目录', () => {
  assert.strictEqual(B.homeDir({ HOME: '/h1' }), '/h1');
  assert.strictEqual(B.homeDir({}), os.homedir());
  assert.strictEqual(B.xdgConfigHome({ XDG_CONFIG_HOME: '/xdg' }), '/xdg');
  assert.strictEqual(
    B.xdgConfigHome({ HOME: '/h2' }),
    path.join('/h2', '.config'),
    '无 XDG_CONFIG_HOME 时应回退 <home>/.config'
  );
  // 缺省 env 走 process.env：本机的 XDG_CONFIG_HOME 是真实用户环境的一部分，
  // 套件只断言「不抛且拿到绝对路径」，不把某台机器的桌面环境钉成通用结论。
  const dflt = B.xdgConfigHome();
  assert.ok(path.isAbsolute(dflt));
  assert.strictEqual(B.xdgConfigHome(undefined), dflt);
});

// ── probeRoot ─────────────────────────────────────────────────────────────

test('probeRoot：覆盖变量指向真实目录 → ok，via 报出变量名，checked 含该位置', () => {
  const root = tmpDir('ovr');
  const res = B.probeRoot({
    env: { KHY_TEST_ROOT: root },
    envKeys: ['KHY_TEST_ROOT'],
    candidates: [{ path: tmpDir('never'), why: '不该被用到的默认位' }],
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.root, root);
  assert.strictEqual(res.via, 'env:KHY_TEST_ROOT');
  assert.strictEqual(res.checked.length, 1, '命中即停，默认候选不该被探测');
  assert.strictEqual(res.checked[0].why, '环境变量 KHY_TEST_ROOT 覆盖');
});

test('probeRoot：覆盖变量指向不存在目录 → 硬报错且不回退默认候选（写了位置就不许换）', () => {
  const def = tmpDir('default-used');
  const res = B.probeRoot({
    env: { KHY_TEST_ROOT: path.join(def, 'does-not-exist') },
    envKeys: ['KHY_TEST_ROOT'],
    candidates: [{ path: def, why: '默认' }],
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /KHY_TEST_ROOT 指向的目录不存在/);
  assert.ok(res.error.includes(path.join(def, 'does-not-exist')), '报错要带上那个不存在的路径');
  assert.strictEqual(res.checked.length, 1, '覆盖变量失败后不得继续探测默认候选');
});

test('probeRoot：变量未设置则记账为 $NAME 并继续走默认候选', () => {
  const def = tmpDir('two-cands');
  const res = B.probeRoot({
    env: {},
    envKeys: ['KHY_MISSING_A', 'KHY_MISSING_B'],
    candidates: [
      { path: path.join(def, 'nope-1'), why: '第一个默认位' },
      { path: def, why: '第二个默认位' },
    ],
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.root, def);
  assert.strictEqual(res.via, 'default');
  assert.deepStrictEqual(res.checked.map((c) => c.location).slice(0, 2), ['$KHY_MISSING_A', '$KHY_MISSING_B']);
  assert.strictEqual(res.checked[3].why, '第二个默认位');
});

test('probeRoot：多变量按优先级取第一个命中；前一个指向坏目录即终止', () => {
  const good = tmpDir('prio');
  const res = B.probeRoot({
    env: { K1: path.join(good, 'ghost'), K2: good },
    envKeys: ['K1', 'K2'],
    candidates: [],
  });
  assert.strictEqual(res.ok, false, 'K1 命中但目录不存在 → 立即失败，不许滑到 K2');
  assert.match(res.error, /K1/);
});

test('probeRoot：全落空时报错带上「找过几处目录」与可用变量名', () => {
  const base = tmpDir('misses');
  const res = B.probeRoot({
    env: {},
    envKeys: ['KHY_X_ROOT'],
    candidates: [
      { path: path.join(base, 'm1'), why: '位置一' },
      { path: path.join(base, 'm2') },
    ],
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /已查找 2 处目录/);
  assert.ok(res.error.includes(path.join(base, 'm1')));
  assert.match(res.error, /可用环境变量 KHY_X_ROOT 显式指定资产根/);
  assert.strictEqual(res.checked[2].why, '默认候选位置', '无 why 的候选要有兜底说明');
});

test('probeRoot 垃圾入参一律不抛：null / 非数组 envKeys / 候选缺 path 都被跳过', () => {
  const only = B.probeRoot();
  assert.strictEqual(only.ok, false);
  assert.match(only.error, /未检测到该工具的资产目录/);

  const strKeys = B.probeRoot({ env: { K: 'v' }, envKeys: 'K', candidates: [] });
  assert.strictEqual(strKeys.ok, false, 'envKeys 传字符串时按空数组处理，不该误命中');

  const badCands = B.probeRoot({
    env: {},
    envKeys: [],
    candidates: [null, {}, { path: '   ' }, { path: 0 }],
  });
  assert.strictEqual(badCands.ok, false);
  assert.match(badCands.error, /已查找 0 处目录:\(无候选\)/);
});

test('probeRoot 的 checked 是当次新建数组（不把内部状态交给调用方）', () => {
  const a = B.probeRoot({ env: {}, envKeys: [], candidates: [] });
  const b = B.probeRoot({ env: {}, envKeys: [], candidates: [] });
  assert.notStrictEqual(a.checked, b.checked);
  a.checked.push({ location: 'tampered' });
  const c = B.probeRoot({ env: {}, envKeys: [], candidates: [] });
  assert.deepStrictEqual(c.checked, [], '前一次调用被改写不该影响后一次探测');
});

// ── isDir / isFile / IO 包装 ──────────────────────────────────────────────

test('isDir / isFile 对不存在、空串、类型错入参一律回 false 不抛', () => {
  const dir = tmpDir('kinds');
  const file = touch(dir, 'a.txt', 'x');
  assert.strictEqual(B.isDir(dir), true);
  assert.strictEqual(B.isDir(file), false);
  assert.strictEqual(B.isFile(file), true);
  assert.strictEqual(B.isFile(dir), false);
  assert.strictEqual(B.isFile(path.join(dir, 'ghost')), false);
  assert.strictEqual(B.isDir(''), false);
  assert.strictEqual(B.isFile(''), false);
  assert.strictEqual(B.isDir(undefined), false);
  assert.strictEqual(B.isDir(null), false);
});

test('readText：存在给原文、缺失给 null、读目录（下层抛 EISDIR）也收成 null', () => {
  const dir = tmpDir('rt');
  const file = touch(dir, 'body.md', 'hello-正文');
  assert.strictEqual(B.readText(file), 'hello-正文');
  assert.strictEqual(B.readText(path.join(dir, 'ghost.md')), null);
  assert.strictEqual(B.readText(dir), null, '目录不是「读坏了」也不是「不存在」，但本层必须不抛');
  assert.strictEqual(B.readText(''), null);
  assert.strictEqual(B.readText(undefined), null);
});

test('readJson：缺失 null、BOM 容忍、语法错回 {_parseError} 且不抛', () => {
  const dir = tmpDir('rj');
  const bom = touch(dir, 'bom.json', '﻿{"k":1}');
  assert.deepStrictEqual(B.readJson(bom), { k: 1 });
  const plain = touch(dir, 'plain.json', '[1,2,3]');
  assert.deepStrictEqual(B.readJson(plain), [1, 2, 3]);
  const broken = touch(dir, 'broken.json', '{oops,');
  const res = B.readJson(broken);
  assert.strictEqual(typeof res._parseError, 'string');
  assert.ok(res._parseError.length > 0, '解析失败必须带上原因文本');
  assert.strictEqual(B.readJson(path.join(dir, 'ghost.json')), null);
  assert.strictEqual(B.readJson(dir), null, '目录形态也不许抛');
});

test('writeText / removeFile / removeDir：真实落盘与幂等删除都回布尔，失败不抛', () => {
  const dir = tmpDir('io');
  const target = path.join(dir, 'nested', 'deep', 'cfg.json');
  assert.strictEqual(B.writeText(target, '{"a":1}'), true);
  assert.strictEqual(B.readText(target), '{"a":1}');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(target)).filter((f) => f.includes('.tmp-')), []);

  // 父路径被一个普通文件占住 → mkdirSync 必然失败 → 本层收成 false
  const blocker = touch(dir, 'blocker', 'x');
  assert.strictEqual(B.writeText(path.join(blocker, 'kid.txt'), 'y'), false);

  assert.strictEqual(B.removeFile(target), true);
  assert.strictEqual(B.removeFile(target), true, '不存在也算成功（幂等）');
  assert.strictEqual(B.removeDir(path.join(dir, 'nested')), true);
  assert.strictEqual(B.removeDir(path.join(dir, 'nested')), true);
  assert.strictEqual(B.removeFile(undefined), false, '非路径入参收成 false 不抛');
  assert.strictEqual(B.removeDir(undefined), false);
});

test('mtimeIso：存在给 ISO 串，缺失或目录外入参给空串', () => {
  const dir = tmpDir('mt');
  const file = touch(dir, 't.md', 'x');
  const iso = B.mtimeIso(file);
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.strictEqual(new Date(iso).getTime(), fs.statSync(file).mtime.getTime());
  assert.strictEqual(B.mtimeIso(path.join(dir, 'ghost')), '');
  assert.strictEqual(B.mtimeIso(''), '');
  assert.strictEqual(B.mtimeIso(null), '');
});

// ── toRelPath ─────────────────────────────────────────────────────────────

test('toRelPath：root 内给 POSIX 相对路径，root 外如实给 ../（不做越界拦截）', () => {
  const dir = tmpDir('rel');
  const inside = touch(dir, path.join('a', 'b.md'), 'x');
  assert.strictEqual(B.toRelPath(dir, inside), path.join('a', 'b.md').split(path.sep).join('/'));
  const outside = path.resolve(path.dirname(dir), 'elsewhere.md');
  assert.match(B.toRelPath(dir, outside), /^\.\.[/\\]/, '越界路径以 .. 开头原样回报，调用方需自己判');
  assert.strictEqual(B.toRelPath(undefined, undefined), '', '非字符串入参收成空串');
  assert.strictEqual(B.toRelPath(dir, dir), '');
});

// ── walkFiles ─────────────────────────────────────────────────────────────

function buildWalkTree() {
  const dir = tmpDir('walk');
  touch(dir, 'root.md', '1');
  touch(dir, 'root.txt', '2');
  touch(dir, 'nested/child.md', '3');
  touch(dir, 'nested/deeper/grand.md', '4');
  touch(dir, 'node_modules/pkg/bad.md', '5');
  touch(dir, '.git/config.md', '6');
  touch(dir, 'dist/built.md', '7');
  touch(dir, '.hidden-dir/secret.md', '8');
  touch(dir, '.dotfile.md', '9');
  touch(dir, 'no-extension', '10');
  return dir;
}

test('walkFiles：返回排序后的 POSIX 相对路径，跳过依赖目录/点目录、保留点文件', () => {
  const dir = buildWalkTree();
  const all = B.walkFiles(dir);
  assert.deepStrictEqual(all, [
    '.dotfile.md',
    'nested/child.md',
    'nested/deeper/grand.md',
    'no-extension',
    'root.md',
    'root.txt',
  ]);
  assert.ok(!all.some((p) => p.includes('node_modules') || p.startsWith('.git/') || p.startsWith('dist/')),
    'SKIP_DIR_NAMES 与点目录必须整棵剪掉');
});

test('walkFiles：exts 过滤大小写不敏感、无扩展名被剔除；空 exts 数组等于不过滤', () => {
  const dir = buildWalkTree();
  assert.deepStrictEqual(B.walkFiles(dir, { exts: ['.MD'] }), [
    '.dotfile.md',
    'nested/child.md',
    'nested/deeper/grand.md',
    'root.md',
  ]);
  assert.deepStrictEqual(B.walkFiles(dir, { exts: [] }), B.walkFiles(dir),
    'exts:[] 走的是「没给过滤」分支，不是「什么都不匹配」');
});

test('walkFiles：maxDepth 是硬上界（0 只给顶层，越界静默停住而非报错）', () => {
  const dir = buildWalkTree();
  assert.deepStrictEqual(B.walkFiles(dir, { maxDepth: 0 }), ['.dotfile.md', 'no-extension', 'root.md', 'root.txt']);
  assert.deepStrictEqual(B.walkFiles(dir, { maxDepth: 1, exts: ['.md'] }),
    ['.dotfile.md', 'nested/child.md', 'root.md']);
  assert.deepStrictEqual(B.walkFiles(dir, { maxDepth: -1 }), [], '负上界让第 0 层就被拒');
});

test('walkFiles：maxFiles 截断到上界即停，且不返回超出的一项', () => {
  const dir = buildWalkTree();
  assert.strictEqual(B.walkFiles(dir, { maxFiles: 2 }).length, 2);
  assert.deepStrictEqual(B.walkFiles(dir, { maxFiles: 0 }), [], '0 是合法上界（第 0 层入口即停）');
});

test('walkFiles 对缺失根/文件当根/垃圾入参一律回空数组', () => {
  const dir = tmpDir('walk-empty');
  assert.deepStrictEqual(B.walkFiles(path.join(dir, 'ghost')), []);
  const file = touch(dir, 'f.md', 'x');
  assert.deepStrictEqual(B.walkFiles(file), []);
  assert.deepStrictEqual(B.walkFiles(''), []);
  assert.deepStrictEqual(B.walkFiles(undefined), []);
  assert.deepStrictEqual(B.walkFiles(null, null), []);
});

test('KNOWN-DEFECT: _adapterBase.js:223 walkFiles 的 exts 非字符串元素直接抛 TypeError，违背本层「绝不抛」契约', () => {
  // File: services/backend/src/services/domain/agents/agentAssets/_adapterBase.js:223
  // `o.exts.map((e) => e.toLowerCase())` assumes every element is a string; a numeric or
  // null element throws before any IO happens. The module header promises "本层的每个函数
  // 要么返回值要么返回 null/空数组,绝不抛", and no adapter call site wraps this in try/catch,
  // so one malformed exts entry (e.g. exts read from a JSON config where ".md" was written
  // unquoted) crashes the whole discovery chain instead of degrading to "nothing found".
  const dir = buildWalkTree();
  assert.throws(() => B.walkFiles(dir, { exts: [1] }), TypeError);
  assert.throws(() => B.walkFiles(dir, { exts: [null] }), TypeError);
  // Contrast: the same module tolerates a non-array exts, so the throw is an inconsistency.
  assert.deepStrictEqual(B.walkFiles(dir, { exts: '.md' }), B.walkFiles(dir));
});

// ── parseFrontmatter ──────────────────────────────────────────────────────

test('parseFrontmatter：标量、引号、行内数组、块数组、嵌套映射一次解析到位', () => {
  const text = [
    '---',
    'name: alpha',
    'title: "带 空格 的标题"',
    'tags: [a, b, a]',
    'count: 0',
    'nested:',
    '  scope: global',
    '  type: fact',
    'list:',
    '  - one',
    '  - two',
    '---',
    '正文第一行',
    '正文第二行',
  ].join('\n');
  const fm = B.parseFrontmatter(text);
  assert.strictEqual(fm.parsed, true);
  assert.deepStrictEqual(fm.data, {
    name: 'alpha',
    title: '带 空格 的标题',
    tags: ['a', 'b', 'a'],
    count: '0',
    nested: { scope: 'global', type: 'fact' },
    list: ['one', 'two'],
  });
  assert.strictEqual(fm.body, '正文第一行\n正文第二行');
  assert.strictEqual(fm.raw, [
    'name: alpha',
    'title: "带 空格 的标题"',
    'tags: [a, b, a]',
    'count: 0',
    'nested:',
    '  scope: global',
    '  type: fact',
    'list:',
    '  - one',
    '  - two',
  ].join('\n'));
});

test('parseFrontmatter：count 0 与空串都保留为字符串，不会被当成缺失', () => {
  const fm = B.parseFrontmatter('---\nzero: 0\nflag: false\n---\nbody');
  assert.strictEqual(fm.data.zero, '0');
  assert.strictEqual(fm.data.flag, 'false');
});

test('parseFrontmatter：无 frontmatter / 空 / 非字符串 → data {} 且 body 原样回吐', () => {
  assert.deepStrictEqual(B.parseFrontmatter('plain body'), { data: {}, body: 'plain body', raw: '', parsed: false });
  assert.deepStrictEqual(B.parseFrontmatter(''), { data: {}, body: '', raw: '', parsed: false });
  assert.deepStrictEqual(B.parseFrontmatter(null).body, '');
  assert.deepStrictEqual(B.parseFrontmatter(undefined).data, {});
  assert.deepStrictEqual(B.parseFrontmatter(123).body, '');
  assert.deepStrictEqual(B.parseFrontmatter({}).body, '', '对象入参不是字符串，正文取空串');
});

test('parseFrontmatter：只有开栏没有闭栏 → 整块落进正文，parsed=false', () => {
  const fm = B.parseFrontmatter('---\nname: orphan\nstill body');
  assert.strictEqual(fm.parsed, false);
  assert.deepStrictEqual(fm.data, {});
  assert.strictEqual(fm.body, '---\nname: orphan\nstill body');
});

test('parseFrontmatter：注释与空行跳过；认不出的行只把 parsed 置 false，已解析字段保留', () => {
  const fm = B.parseFrontmatter(['---', '# 说明', '', 'name: kept', 'this is not yaml', '---', 'body'].join('\n'));
  assert.deepStrictEqual(fm.data, { name: 'kept' });
  assert.strictEqual(fm.parsed, false);
});

test('parseFrontmatter：CRLF 与结尾无换行的闭栏都能识别，正文不被 \r 污染', () => {
  const fm = B.parseFrontmatter('---\r\nname: crlf\r\n---\r\n正文');
  assert.strictEqual(fm.parsed, true);
  assert.strictEqual(fm.data.name, 'crlf');
  assert.strictEqual(fm.body, '正文');
  assert.ok(!fm.raw.includes('\r'), 'raw 是纯 LF 文本，序列化时才可逐字节回吐');
});

test('parseFrontmatter：块里既无项也无子键时该键落成空串（弱解析器的如实边界）', () => {
  const fm = B.parseFrontmatter('---\ndesc:\n  只有一行裸文本\nname: x\n---\nbody');
  assert.strictEqual(fm.data.desc, '');
  assert.strictEqual(fm.data.name, 'x');
  assert.strictEqual(fm.parsed, false);
});

// ── serializeFrontmatter ──────────────────────────────────────────────────

test('serializeFrontmatter：data 为空只吐正文；标量/数组/嵌套各按其形', () => {
  assert.strictEqual(B.serializeFrontmatter({}, '只有正文', ''), '只有正文');
  assert.strictEqual(B.serializeFrontmatter(null, 'b', ''), 'b');
  assert.strictEqual(B.serializeFrontmatter('not-an-object', 'b', ''), 'b');
  assert.strictEqual(
    B.serializeFrontmatter({ name: 'x', tags: ['a', 'b'], meta: { scope: 'global' } }, '正文', ''),
    '---\nname: x\ntags:\n  - a\n  - b\nmeta:\n  scope: global\n---\n正文'
  );
});

test('serializeFrontmatter：null/undefined 值写成空值行，0 与 false 如实留字面量', () => {
  const out = B.serializeFrontmatter({ a: null, b: undefined, c: 0, d: false }, '', '');
  assert.strictEqual(out, '---\na: \nb: \nc: 0\nd: false\n---\n');
});

test('serializeFrontmatter：正文非字符串被收成空串（不会拼出 undefined 字样）', () => {
  assert.strictEqual(B.serializeFrontmatter({ k: 'v' }, null, ''), '---\nk: v\n---\n');
  assert.strictEqual(B.serializeFrontmatter({ k: 'v' }, 42, ''), '---\nk: v\n---\n');
});

test('parseFrontmatter → serializeFrontmatter 原文回吐逐字节等价（往返无损）', () => {
  const src = '---\nname: round\nlist:\n  - 1\n---\n正文\n最后一行\n';
  const fm = B.parseFrontmatter(src);
  assert.strictEqual(B.serializeFrontmatter(fm.data, fm.body, fm.raw), src);
});

// ── 垃圾入参保底 ──────────────────────────────────────────────────────────

test('KNOWN-DEFECT: _adapterBase.js:398 serializeFrontmatter 遇 Symbol 值抛 TypeError，本层并非「绝不抛」', () => {
  // File: _adapterBase.js:398 — the scalar branch interpolates the value into a template
  // string, and String coercion of a Symbol throws. data reaching here can come from
  // asset.metadata / asset.raw, which validateAsset only checks for "plain object"
  // (assetModel.js:122), so a symbol-valued key is not rejected upstream and the
  // fail-soft adapter layer blows up at write time instead of returning false-ish output.
  assert.throws(() => B.serializeFrontmatter({ k: Symbol('s') }, 'b', ''), TypeError);
  // Arrays go through the same template interpolation, so a symbol nested one level down
  // throws as well — the guard simply does not exist at either branch.
  assert.throws(() => B.serializeFrontmatter({ k: [Symbol('s')] }, 'b', ''), TypeError);
  assert.strictEqual(B.serializeFrontmatter({ k: ['x', 1] }, 'b', ''), '---\nk:\n  - x\n  - 1\n---\nb');
});
