'use strict';

// Co-located tests for archiveInstaller.js. child_process is stubbed via
// require.cache BEFORE the module is loaded (it destructures spawnSync at
// load time), so no process is ever spawned. All disk I/O stays inside an
// os.tmpdir() mkdtemp sandbox.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const os = require('os');
const fs = require('fs');
const path = require('path');

const cpKey = require.resolve('child_process');
const origCpEntry = require.cache[cpKey];
const spawnCalls = [];
let spawnResult = { error: null, status: 0, stderr: '' };
require.cache[cpKey] = {
  id: cpKey,
  filename: cpKey,
  loaded: true,
  exports: { spawnSync: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return spawnResult; } },
};

const installer = require('./archiveInstaller');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-arch-'));

after(() => {
  require.cache[cpKey] = origCpEntry;
  if (origCpEntry === undefined) delete require.cache[cpKey];
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp sandbox */ }
});

function freshDir(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

const passthroughExe = (name) => `C:/fake/bin/${name}`;

describe('extractArchive', () => {
  test('file 格式直接复制为 payload，不调用任何子进程', () => {
    const dir = freshDir('file-basic');
    const arch = makeFile(dir, 'blob.bin', 'hello-payload');
    const dest = path.join(dir, 'out');
    installer.extractArchive(arch, dest, 'file', { filename: 'payload.bin' });
    assert.equal(fs.readFileSync(path.join(dest, 'payload.bin'), 'utf8'), 'hello-payload');
    assert.equal(spawnCalls.length, 0);
  });

  test('KNOWN-DEFECT: file 格式的 options.filename 未做路径约束，../ 可逃逸目标目录', () => {
    // archiveInstaller.js:16 — path.join(destDir, options.filename) with no
    // containment check: a '../'-bearing filename writes outside destDir
    // (same zip-slip class this module guards elsewhere via assertContainedPath).
    const dir = freshDir('file-slip');
    const arch = makeFile(dir, 'blob.bin', 'evil');
    const dest = path.join(dir, 'dest');
    installer.extractArchive(arch, dest, 'file', { filename: '../escaped.txt' });
    assert.ok(fs.existsSync(path.join(dir, 'escaped.txt')), 'escape actually lands one level above dest');
    assert.ok(!fs.existsSync(path.join(dest, 'escaped.txt')));
  });

  test('tar.gz 组装 tar -xzf 命令并透传默认超时/maxBuffer', () => {
    spawnCalls.length = 0;
    const dir = freshDir('tarz');
    const dest = path.join(dir, 'out');
    installer.extractArchive(path.join(dir, 'a.tgz'), dest, 'tar.gz', { searchExecutable: passthroughExe });
    assert.equal(spawnCalls.length, 1);
    const call = spawnCalls[0];
    assert.equal(call.cmd, 'C:/fake/bin/tar');
    assert.deepEqual(call.args, ['-xzf', path.join(dir, 'a.tgz'), '-C', dest]);
    assert.equal(call.opts.timeout, 5 * 60 * 1000);
    assert.equal(call.opts.maxBuffer, 8 * 1024 * 1024);
    assert.ok(fs.existsSync(dest));
  });

  test('tar 格式用 -xf；options.timeoutMs 覆盖默认超时', () => {
    spawnCalls.length = 0;
    const dir = freshDir('tar1');
    installer.extractArchive(path.join(dir, 'a.tar'), path.join(dir, 'out'), 'tar', { searchExecutable: passthroughExe, timeoutMs: 1234 });
    assert.deepEqual(spawnCalls[0].args, ['-xf', path.join(dir, 'a.tar'), '-C', path.join(dir, 'out')]);
    assert.equal(spawnCalls[0].opts.timeout, 1234);
  });

  test('zip 走当前平台分支且 PowerShell 单引号被成对转义', () => {
    spawnCalls.length = 0;
    const dir = freshDir('zip1');
    const dest = path.join(dir, 'out');
    const arch = path.join(dir, "we'ird.zip");
    installer.extractArchive(arch, dest, 'zip', { searchExecutable: passthroughExe });
    assert.equal(spawnCalls.length, 1);
    const call = spawnCalls[0];
    if (process.platform === 'win32') {
      assert.equal(call.cmd, 'C:/fake/bin/powershell');
      assert.equal(call.args[0], '-NoProfile');
      assert.ok(call.args[2].includes("we''ird.zip"), "single quote must be doubled inside '...' literal");
      assert.ok(call.args[2].startsWith('Expand-Archive -LiteralPath'));
    } else {
      assert.equal(call.cmd, 'C:/fake/bin/unzip');
      assert.deepEqual(call.args, ['-q', '-o', arch, '-d', dest]);
    }
  });

  test('找不到解压器时抛 extractor not found', () => {
    const dir = freshDir('noexe');
    assert.throws(
      () => installer.extractArchive(path.join(dir, 'a.tgz'), path.join(dir, 'out'), 'tar.gz', { searchExecutable: () => null }),
      /extractor not found for tar\.gz/
    );
  });

  test('不支持的格式（含垃圾入参）抛 unsupported archive format', () => {
    const dir = freshDir('badfmt');
    assert.throws(() => installer.extractArchive(path.join(dir, 'a.rar'), path.join(dir, 'out'), 'rar', { searchExecutable: passthroughExe }), /unsupported archive format: rar/);
    assert.throws(() => installer.extractArchive(path.join(dir, 'a'), path.join(dir, 'out'), undefined, { searchExecutable: passthroughExe }), /unsupported archive format: undefined/);
    assert.throws(() => installer.extractArchive(path.join(dir, 'a'), path.join(dir, 'out'), 123, { searchExecutable: passthroughExe }), /unsupported archive format/);
  });

  test('spawnSync 返回 error 时包装为 extraction failed 消息', () => {
    const dir = freshDir('spawnerr');
    spawnResult = { error: new Error('kaboom'), status: null, stderr: '' };
    assert.throws(() => installer.extractArchive(path.join(dir, 'a.tgz'), path.join(dir, 'out'), 'tar', { searchExecutable: passthroughExe }), /extraction failed: kaboom/);
    spawnResult = { error: null, status: 0, stderr: '' };
  });

  test('非零退出码时消息含退出码与截断后的 stderr', () => {
    const dir = freshDir('badexit');
    spawnResult = { error: null, status: 2, stderr: 'x'.repeat(600) };
    assert.throws(
      () => installer.extractArchive(path.join(dir, 'a.tgz'), path.join(dir, 'out'), 'tar', { searchExecutable: passthroughExe }),
      (err) => /extraction failed \(exit 2\)/.test(err.message) && err.message.length <= 'extraction failed (exit 2): '.length + 400
    );
    spawnResult = { error: null, status: 0, stderr: '' };
  });
});

describe('locatePayloadRoot', () => {
  test('sentinel 直接位于 staging 根时返回根', () => {
    const dir = freshDir('lr-root');
    makeFile(dir, 'PKG-SENTINEL', 'x');
    assert.equal(installer.locatePayloadRoot(dir, 'PKG-SENTINEL'), dir);
  });

  test('hint 命中子目录时优先返回 hint 目录', () => {
    const dir = freshDir('lr-hint');
    makeFile(dir, 'sub/PKG-SENTINEL', 'x');
    makeFile(dir, 'other/PKG-SENTINEL', 'x');
    assert.equal(installer.locatePayloadRoot(dir, 'PKG-SENTINEL', 'sub'), path.join(dir, 'sub'));
  });

  test('hint 为 . 时按 BFS 找到深层目录', () => {
    const dir = freshDir('lr-bfs');
    makeFile(dir, 'a1/a2/a3/PKG-SENTINEL', 'x');
    assert.equal(installer.locatePayloadRoot(dir, 'PKG-SENTINEL', '.'), path.join(dir, 'a1', 'a2', 'a3'));
  });

  test('深度超过 5 层的 sentinel 不被发现，返回 null', () => {
    const dir = freshDir('lr-deep');
    makeFile(dir, 'd1/d2/d3/d4/d5/d6/PKG-SENTINEL', 'x');
    assert.equal(installer.locatePayloadRoot(dir, 'PKG-SENTINEL'), null);
  });

  test('不存在 sentinel / staging 目录本身缺失 / 垃圾入参均返回 null', () => {
    const dir = freshDir('lr-none');
    makeFile(dir, 'x/y.txt', 'y');
    assert.equal(installer.locatePayloadRoot(dir, 'NOPE'), null);
    assert.equal(installer.locatePayloadRoot(path.join(dir, 'ghost'), 'NOPE'), null);
    assert.equal(installer.locatePayloadRoot(dir, 'PKG-SENTINEL', ''), null);
    assert.ok(fs.existsSync(dir), 'root dir still there after null returns');
  });
});

describe('copyPayload', () => {
  test('正常嵌套目录被复制且内容一致', () => {
    const dir = freshDir('cp-basic');
    const src = path.join(dir, 'src');
    makeFile(src, 'a/b.txt', 'content-b');
    makeFile(src, 'top.txt', 'content-top');
    const dst = path.join(dir, 'dst');
    installer.copyPayload(src, dst);
    assert.equal(fs.readFileSync(path.join(dst, 'a', 'b.txt'), 'utf8'), 'content-b');
    assert.equal(fs.readFileSync(path.join(dst, 'top.txt'), 'utf8'), 'content-top');
  });

  test('KNOWN-DEFECT: archiveInstaller.js:83 errorOnExist 形同虚设，目标同名文件被静默覆盖', () => {
    // cpSync is called with errorOnExist:true but `force` is not set to false
    // and defaults to true, so an existing destination file is silently
    // replaced instead of throwing EEXIST — the anti-clobber guard never fires.
    // (Current callers copy into unique staging paths, which limits the blast
    // radius; any future caller relying on "errorOnExist protects my files"
    // is unprotected.)
    const dir = freshDir('cp-oe');
    const src = path.join(dir, 'src');
    makeFile(src, 'a/b.txt', 'content-b');
    const dst = path.join(dir, 'dst');
    installer.copyPayload(src, dst);
    fs.writeFileSync(path.join(dst, 'a', 'b.txt'), 'LOCAL-DATA');
    assert.doesNotThrow(() => installer.copyPayload(src, dst));
    assert.equal(fs.readFileSync(path.join(dst, 'a', 'b.txt'), 'utf8'), 'content-b', 'silent overwrite proves errorOnExist never engaged');
  });

  test('空 payload 目录只创建目标目录，不抛错', () => {
    const dir = freshDir('cp-empty');
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    const dst = path.join(dir, 'dst');
    installer.copyPayload(src, dst);
    assert.ok(fs.existsSync(dst));
  });

  test('src 目录不存在时抛 ENOENT（不静默跳过）', () => {
    const dir = freshDir('cp-missing');
    assert.throws(() => installer.copyPayload(path.join(dir, 'ghost'), path.join(dir, 'dst')), (err) => err.code === 'ENOENT');
  });
});

describe('applyChmod', () => {
  test('win32 上是彻底 no-op；非 win32 对存在条目 chmod 0o755', () => {
    const dir = freshDir('chmod1');
    const target = path.join(dir, 't');
    const f = makeFile(target, 'run.sh', '#!/bin/sh');
    assert.doesNotThrow(() => installer.applyChmod(target, ['run.sh', 'missing.bin', '../outside']));
    if (process.platform === 'win32') {
      // win32 early-return: the list is never walked, so even junk entries pass.
      assert.doesNotThrow(() => installer.applyChmod(target, [null]));
      assert.doesNotThrow(() => installer.applyChmod(target, null));
      assert.doesNotThrow(() => installer.applyChmod(target, undefined));
      assert.ok(fs.existsSync(f));
    } else {
      assert.equal(fs.statSync(f).mode & 0o111, 0o111);
    }
  });
});
