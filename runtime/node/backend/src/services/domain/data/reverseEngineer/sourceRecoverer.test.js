'use strict';

/**
 * sourceRecoverer.test.js — 自包含产物源码还原 契约共置测试（批次 27）。
 *
 * 这一层是「防呆④：解包永不逃逸沙箱」的落点，也是「khy 自验 khy 产物」最强的一条路径，
 * 所以测试分两类：
 *   A. 纯护栏（_isSafeEntry / _isWithinDest / _classifyMember）——逐条打到边界；
 *   B. 真解包（node-stream-zip 驱动的 zip 路径）——用手搓的合成 zip 在系统临时区实测，
 *      绝不把工作区当解包目标，也绝不执行任何抽出来的代码。
 * 期望值全部来自实测（含上游库自己先拒绝穿越条目这一条）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const rec = require('./sourceRecoverer');

const SCAN_ZIP = { format: 'archive-zip', markers: [], recoverability: 'source' };

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-b27-${tag}-`));
}

/**
 * 手搓一个 store(未压缩) ZIP：不引入打包依赖，且 CRC/中央目录逐字段自己算，
 * 这样「测试是否真的读到了条目」不取决于任何第三方工具是否可用。
 * @param {Array<{name:string, data:Buffer}>} entries
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 8); // method = store
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10); // method
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function writeZip(root, name, entries) {
  const p = path.join(root, name);
  fs.writeFileSync(p, makeZip(entries));
  return p;
}

// ── A. 护栏：路径穿越 / 绝对路径 / 盘符 ───────────────────────────────────

test('_isSafeEntry 放行相对路径，含 ./ 前缀与反斜杠形态', () => {
  assert.strictEqual(rec._isSafeEntry('a/b.js'), true);
  assert.strictEqual(rec._isSafeEntry('a\\b\\c.js'), true);
  assert.strictEqual(rec._isSafeEntry('./a.js'), true);
  assert.strictEqual(rec._isSafeEntry('a/./b/../..') === false, true, '含 .. 即拒');
  assert.strictEqual(rec._isSafeEntry('hello.js'), true);
});

test('_isSafeEntry 逐条拒绝：空值、非字符串、绝对路径、上跳、盘符', () => {
  assert.strictEqual(rec._isSafeEntry(''), false);
  assert.strictEqual(rec._isSafeEntry(null), false);
  assert.strictEqual(rec._isSafeEntry(undefined), false);
  assert.strictEqual(rec._isSafeEntry(123), false);
  assert.strictEqual(rec._isSafeEntry('/etc/passwd'), false);
  assert.strictEqual(rec._isSafeEntry('C:\\Windows\\x.js'), false);
  assert.strictEqual(rec._isSafeEntry('../evil.js'), false);
  assert.strictEqual(rec._isSafeEntry('a/../../evil.js'), false);
  assert.strictEqual(rec._isSafeEntry('a\\..\\b.js'), false);
  assert.strictEqual(rec._isSafeEntry('C:payload.js'), false, '盘符形态（POSIX 下非绝对）也要拒');
});

test('_isWithinDest 只认目标目录之内，边界本身算命中，逃逸与近似前缀不算', () => {
  const dest = path.join(tmpRoot('dest'), 'out');
  assert.strictEqual(rec._isWithinDest(path.join(dest, 'a.js'), dest), true);
  assert.strictEqual(rec._isWithinDest(dest, dest), true);
  assert.strictEqual(rec._isWithinDest(path.join(dest, 'sub', 'a.js'), dest), true);
  assert.strictEqual(rec._isWithinDest(path.join(dest, '..', 'a.js'), dest), false);
  // 近似前缀（dest 的同级兄弟目录）不得因为 startsWith 字符串相似就放行。
  assert.strictEqual(rec._isWithinDest(`${dest}-evil`, dest), false);
  assert.strictEqual(rec._isWithinDest(`${dest}x`, dest), false);
});

test('_classifyMember 按扩展名分三档，大小写不敏感；无扩展名归 asset', () => {
  assert.strictEqual(rec._classifyMember('a/b.JS'), 'source');
  assert.strictEqual(rec._classifyMember('Main.java'), 'source');
  assert.strictEqual(rec._classifyMember('app.vue'), 'source');
  assert.strictEqual(rec._classifyMember('Foo.Class'), 'bytecode');
  assert.strictEqual(rec._classifyMember('mod.pyc'), 'bytecode');
  assert.strictEqual(rec._classifyMember('native.DLL'), 'bytecode');
  assert.strictEqual(rec._classifyMember('logo.png'), 'asset');
  assert.strictEqual(rec._classifyMember('LICENSE'), 'asset');
  assert.strictEqual(rec._classifyMember('data.bin'), 'asset');
  // 集合本身是公开契约（保真度比对的主集合）。
  assert.strictEqual(rec.SOURCE_EXTS.has('.ts'), true);
  assert.strictEqual(rec.SOURCE_EXTS.has('.class'), false);
  assert.strictEqual(rec.BYTECODE_EXTS.has('.exe'), true);
});

test('总量与条目上限默认值（未设 env 时）', () => {
  if (!process.env.KHY_RE_MAX_BYTES) {
    assert.strictEqual(rec.MAX_RECOVER_BYTES, 64 * 1024 * 1024);
  }
  assert.ok(Number.isInteger(rec.MAX_RECOVER_BYTES) && rec.MAX_RECOVER_BYTES > 0);
});

// ── B. zip 真解包：只编目 / 落盘 / fail-closed ────────────────────────────

test('listOnly（默认）：目录条目被排除，三类成员各归其档，字节数只算非目录', async () => {
  const root = tmpRoot('zip-list-');
  const file = writeZip(root, 'pkg.zip', [
    { name: 'a/hello.js', data: Buffer.from('console.log(1)') },
    { name: 'a/', data: Buffer.alloc(0) },
    { name: 'lib.class', data: Buffer.from('xx') },
    { name: 'icon.png', data: Buffer.from('yy') },
  ]);
  const r = await rec.recover(file, SCAN_ZIP, {});
  assert.deepStrictEqual(
    r.members.map((m) => [m.name, m.kind]),
    [
      ['a/hello.js', 'source'],
      ['lib.class', 'bytecode'],
      ['icon.png', 'asset'],
    ]
  );
  assert.strictEqual(r.totalBytes, 18);
  assert.strictEqual(r.skipped, 0);
  assert.strictEqual(r.format, 'zip');
  assert.strictEqual(r.ok, true);
  // 未给 outDir 时绝不落盘，也不写 extractedTo。
  assert.strictEqual('extractedTo' in r.members[0], false);
  assert.deepStrictEqual(fs.readdirSync(root), ['pkg.zip']);
});

test('给 outDir 才抽取：逐成员落盘并保留目录结构，成员带 extractedTo', async () => {
  const root = tmpRoot('zip-out-');
  const file = writeZip(root, 'pkg.zip', [
    { name: 'src/index.js', data: Buffer.from('const a=1;') },
    { name: 'assets/logo.svg', data: Buffer.from('<svg/>') },
  ]);
  const outDir = path.join(root, 'recovered');
  fs.mkdirSync(outDir, { recursive: true });
  const r = await rec.recover(file, SCAN_ZIP, { outDir });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.members.length, 2);
  assert.strictEqual(r.members[0].extractedTo, path.join(outDir, 'src/index.js'));
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'src', 'index.js'), 'utf8'), 'const a=1;');
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'assets', 'logo.svg'), 'utf8'), '<svg/>');
});

test('上游 node-stream-zip 先拒穿越条目：整包 fail-closed，逐条 skip 分支对 zip 不可达', async () => {
  const root = tmpRoot('zip-evil-');
  const file = writeZip(root, 'evil.zip', [
    { name: 'ok.js', data: Buffer.from('safe') },
    { name: '../escaped.js', data: Buffer.from('boom') },
  ]);
  const r = await rec.recover(file, SCAN_ZIP, {});
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /recover failed/);
  assert.deepStrictEqual(r.members, []);
  // 关键：一个恶意条目会让**整包**还原失败（而非跳过它继续还原其余成员）。
  // 结果是安全的，但 _recoverZip 里 skipped++ 那道逐条护栏对 zip 永远走不到 ——
  // 已登记为已知边界（批次 27），护栏的真实价值由上面的 _isSafeEntry 单测承担。
});

test('非 zip 内容 / 不存在的文件：recover 绝不抛，一律降级为 {ok:false}', async () => {
  const root = tmpRoot('zip-bad-');
  const garbage = path.join(root, 'notzip.zip');
  fs.writeFileSync(garbage, Buffer.from('PK\x03\x04 then nothing at all', 'binary'));
  const r = await rec.recover(garbage, SCAN_ZIP, {});
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /recover failed/);
  const missing = await rec.recover(path.join(root, 'absent.zip'), SCAN_ZIP, {});
  assert.strictEqual(missing.ok, false);
  assert.match(missing.reason, /recover failed|ENOENT/);
  assert.deepStrictEqual(missing.members, []);
});

test('条目数上限走 env：超限整包拒绝且不返回半份清单', async () => {
  const root = tmpRoot('zip-cap-');
  const entries = Array.from({ length: 5 }, (_, i) => ({
    name: `e${i}.js`,
    data: Buffer.from('x'),
  }));
  const file = writeZip(root, 'five.zip', entries);
  // 上限常量在模块加载时读取 env，因此用「设 env → 重新 require」拿到受限实例。
  const previous = process.env.KHY_RE_MAX_ENTRIES;
  process.env.KHY_RE_MAX_ENTRIES = '3';
  delete require.cache[require.resolve('./sourceRecoverer')];
  let capped;
  try {
    capped = require('./sourceRecoverer');
    assert.strictEqual(capped !== rec, true, '前置：必须拿到按新 env 初始化的实例');
    const r = await capped.recover(file, SCAN_ZIP, {});
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /entry count 5 exceeds cap 3/);
    assert.deepStrictEqual(r.members, []);
  } finally {
    if (previous === undefined) delete process.env.KHY_RE_MAX_ENTRIES;
    else process.env.KHY_RE_MAX_ENTRIES = previous;
    delete require.cache[require.resolve('./sourceRecoverer')];
  }
});

test('解压总量上限走 env：超限如实标 truncated，并保留已编目的部分', async () => {
  const root = tmpRoot('zip-bytes-');
  const file = writeZip(root, 'big.zip', [
    { name: 'a.js', data: Buffer.alloc(10) },
    { name: 'b.js', data: Buffer.alloc(10) },
  ]);
  const previous = process.env.KHY_RE_MAX_BYTES;
  process.env.KHY_RE_MAX_BYTES = '15';
  delete require.cache[require.resolve('./sourceRecoverer')];
  let capped;
  try {
    capped = require('./sourceRecoverer');
    const r = await capped.recover(file, SCAN_ZIP, {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.truncated, true);
    assert.match(r.reason, /uncompressed size exceeds cap 15/);
    // 与条目上限不同：这里 members 里已编目的第一条是**保留**的。
    assert.deepStrictEqual(r.members.map((m) => m.name), ['a.js']);
  } finally {
    if (previous === undefined) delete process.env.KHY_RE_MAX_BYTES;
    else process.env.KHY_RE_MAX_BYTES = previous;
    delete require.cache[require.resolve('./sourceRecoverer')];
  }
});

// ── B2. 非 zip 的还原策略分派 ─────────────────────────────────────────────

test('shebang 脚本：本身就是源码，登记为单成员并指向原文件', async () => {
  const root = tmpRoot('script-');
  const file = path.join(root, 'run.sh');
  const src = Buffer.from('#!/bin/sh\necho hi\n');
  fs.writeFileSync(file, src);
  const r = await rec.recover(file, { format: 'script-shebang', markers: [], recoverability: 'source' }, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.format, 'script');
  assert.deepStrictEqual(r.members, [
    { name: 'run.sh', size: src.length, kind: 'source', extractedTo: file },
  ]);
  assert.match(r.note, /already source/);
});

test('shebang 但文件已被删：statSync 抛被兜住，降级为 ok:false', async () => {
  const root = tmpRoot('script-gone-');
  const file = path.join(root, 'gone.sh');
  fs.writeFileSync(file, Buffer.from('#!/bin/sh\n'));
  fs.unlinkSync(file);
  const r = await rec.recover(file, { format: 'script-shebang', markers: [], recoverability: 'source' }, {});
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /recover failed/);
});

test('PyInstaller 不重写 CArchive 解析：如实 deferred 并点名外部工具', async () => {
  const r = await rec.recover('whatever', { format: 'elf', markers: ['pyinstaller'], recoverability: 'source' }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.deferred, true);
  assert.strictEqual(r.delegateTool, 'pyinstxtractor');
  assert.strictEqual(r.format, 'pyinstaller');
  assert.deepStrictEqual(r.members, []);
  assert.match(r.reason, /需外部 pyinstxtractor/);
});

test('Node 自包含可执行同样 deferred：源在 snapshot 里，策略交字符串层', async () => {
  const r = await rec.recover('whatever', { format: 'pe', markers: ['node-sea'], recoverability: 'source' }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.deferred, true);
  assert.strictEqual(r.format, 'node-bundle');
  assert.match(r.reason, /V8 snapshot/);
});

test('不可还原档位（native/bytecode）不硬凑：说清「带上没有源码」并指向工具层', async () => {
  for (const recoverability of ['native', 'bytecode', 'archive', 'unknown']) {
    const r = await rec.recover('x.bin', { format: 'elf', markers: [], recoverability }, {});
    assert.strictEqual(r.ok, false, recoverability);
    assert.deepStrictEqual(r.members, [], recoverability);
    assert.strictEqual(r.reason, `recoverability=${recoverability}: no in-band source to extract; rely on toolOrchestrator/reconstructionPort`);
  }
});

test('标记优先于「无源码」兜底：archive-zip 带 pyinstaller 标记仍走 zip 主路径', async () => {
  const root = tmpRoot('order-');
  const file = writeZip(root, 'p.zip', [{ name: 'a.js', data: Buffer.from('x') }]);
  const r = await rec.recover(file, { format: 'archive-zip', markers: ['pyinstaller'], recoverability: 'source' }, {});
  assert.strictEqual(r.format, 'zip', 'format 分支在标记分支之前，zip 才是真路径');
  assert.strictEqual(r.ok, true);
});

test('mkRecoverDir 一律开在系统临时区、带 khy- 前缀、可重复调用', () => {
  const a = rec.mkRecoverDir('b27a');
  const b = rec.mkRecoverDir('b27b');
  try {
    assert.strictEqual(fs.existsSync(a), true);
    assert.strictEqual(path.basename(a).startsWith('khy-b27a-'), true);
    assert.strictEqual(path.dirname(a), path.resolve(fs.realpathSync(os.tmpdir())));
    assert.notStrictEqual(a, b);
  } finally {
    for (const d of [a, b]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* 临时区自清，不必强求 */
      }
    }
  }
});
