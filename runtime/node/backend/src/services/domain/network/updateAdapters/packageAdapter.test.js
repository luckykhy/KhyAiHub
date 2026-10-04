'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');

const pa = require('./packageAdapter');

// packageAdapter talks to pip/npm and the network. Every test here drives it
// through the documented `opts` injection seams (execFile / fetch / fs) so no
// subprocess is spawned and no socket is opened. Nothing touches the repo.

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fakeResponse(chunks, meta = {}) {
  const { ok = true, status = 200, readable = true } = meta;
  let i = 0;
  const body = readable
    ? {
        getReader() {
          return {
            read() {
              if (i < chunks.length) return Promise.resolve({ value: chunks[i++], done: false });
              return Promise.resolve({ done: true });
            },
            cancel() {
              return Promise.resolve();
            },
          };
        },
      }
    : {};
  return { ok, status, body };
}

function fakeWritable(rec) {
  return {
    write(chunk) {
      rec.chunks.push(chunk);
      return true;
    },
    once() {},
    end(cb) {
      rec.ended = true;
      if (cb) cb();
    },
    destroy() {
      rec.destroyed = true;
    },
  };
}

function fakeFs(over = {}) {
  return Object.assign(
    {
      readFileSync: () => {
        throw new Error('no file');
      },
      writeFileSync: () => {},
      existsSync: () => true,
      mkdirSync: () => {},
      rmSync: () => {},
      renameSync: () => {},
      readdirSync: () => [],
    },
    over
  );
}

describe('packageAdapter — _findPipArtifact', () => {
  test('规范化包名与版本变体命中 wheel/sdist/zip', () => {
    assert.equal(pa._findPipArtifact(['khy_os-1.2.3-py3-none-any.whl'], 'khy-os', '1.2.3'), 'khy_os-1.2.3-py3-none-any.whl');
    assert.equal(pa._findPipArtifact(['khy-os-1.2.3.tar.gz'], 'khy_os', '1.2.3'), 'khy-os-1.2.3.tar.gz');
    assert.equal(pa._findPipArtifact(['khy_os-1.2.3.zip'], 'khy-os', '1.2.3'), 'khy_os-1.2.3.zip');
  });
  test('无匹配 → null；空/非数组 files → null', () => {
    assert.equal(pa._findPipArtifact(['other-9.9.whl'], 'khy-os', '1.2.3'), null);
    assert.equal(pa._findPipArtifact(null, 'khy-os', '1.2.3'), null);
    assert.equal(pa._findPipArtifact(undefined, 'khy-os', '1.2.3'), null);
  });
  test('KNOWN-DEFECT: 版本前缀过匹配——请求 1.2 命中 1.25 产物', () => {
    // packageAdapter.js:44 tests `normalizedStem.startsWith(pkg_v)` WITHOUT a
    // segment boundary, so version '1.2' matches a '1.25' artifact. Mitigated in
    // production because `pip download pkg==1.2` only emits the exact version,
    // but the selector itself is wrong.
    assert.equal(pa._findPipArtifact(['khy_os-1.25-py3.whl'], 'khy-os', '1.2'), 'khy_os-1.25-py3.whl');
  });
});

describe('packageAdapter — _findNpmArtifact', () => {
  test('精确后缀匹配（无过匹配）', () => {
    assert.equal(pa._findNpmArtifact(['khy-os-khy-os-1.2.3.tgz'], '1.2.3'), 'khy-os-khy-os-1.2.3.tgz');
    // exact endsWith means a 1.2.3 query never grabs a 1.2.35 file
    assert.equal(pa._findNpmArtifact(['khy-os-1.2.35.tgz'], '1.2.3'), null);
    assert.equal(pa._findNpmArtifact(null, '1.2.3'), null);
    assert.equal(pa._findNpmArtifact([], '1.2.3'), null);
  });
});

describe('packageAdapter — _packageArtifactFilename', () => {
  test('从 URL 取 basename；显式 filename 合法', () => {
    assert.equal(pa._packageArtifactFilename({ url: 'https://x/repo/dl/pkg.whl' }), 'pkg.whl');
    assert.equal(pa._packageArtifactFilename({ url: 'https://x/a.tgz', filename: 'renamed.tgz' }), 'renamed.tgz');
  });
  test('路径穿越/子目录/反斜杠 → 抛错', () => {
    assert.throws(() => pa._packageArtifactFilename({ url: 'https://x/a', filename: '../../evil' }), /basename/);
    assert.throws(() => pa._packageArtifactFilename({ url: 'https://x/a', filename: 'a\\b' }), /basename/);
    assert.throws(() => pa._packageArtifactFilename({ url: 'https://x/a', filename: 'sub/dir/f' }), /basename/);
  });
  test('非法 URL 抛（Invalid URL）', () => {
    assert.throws(() => pa._packageArtifactFilename({ url: 'not a url' }));
    assert.throws(() => pa._packageArtifactFilename(null));
  });
});

describe('packageAdapter — _cacheRoot', () => {
  test('cacheDir + 目标版本安全段', () => {
    assert.equal(pa._cacheRoot({ target: { version: '1.2.3' } }, { cacheDir: '/c' }), path.join('/c', 'package', '1.2.3'));
  });
  test('回退 commit；皆缺 → unknown；非法字符替换为下划线', () => {
    assert.equal(pa._cacheRoot({ target: { commit: 'abc123' } }, { cacheDir: '/c' }), path.join('/c', 'package', 'abc123'));
    assert.equal(pa._cacheRoot({}, { cacheDir: '/c' }), path.join('/c', 'package', 'unknown'));
    assert.equal(pa._cacheRoot({ target: { version: 'a/b:c*' } }, { cacheDir: '/c' }), path.join('/c', 'package', 'a_b_c_'));
  });
});

describe('packageAdapter — readDescriptor / validateDescriptor', () => {
  test('readDescriptor：schema=1&type=package 才返回，否则/坏 JSON → null', () => {
    const good = fakeFs({ readFileSync: () => JSON.stringify({ schemaVersion: 1, type: 'package', version: '1', artifacts: {} }) });
    assert.ok(pa.readDescriptor('/p', { fs: good }));
    assert.equal(pa.readDescriptor('/p', { fs: fakeFs({ readFileSync: () => JSON.stringify({ schemaVersion: 2, type: 'package' }) }) }), null);
    assert.equal(pa.readDescriptor('/p', { fs: fakeFs({ readFileSync: () => JSON.stringify({ schemaVersion: 1, type: 'portable' }) }) }), null);
    assert.equal(pa.readDescriptor('/p', { fs: fakeFs({ readFileSync: () => '{bad' }) }), null);
  });
  test('validateDescriptor：版本不符/未知 channel/相对路径/无产物 → not ok', () => {
    const st = { target: { version: '1.2.3' } };
    const fsOk = fakeFs({ existsSync: () => true });
    assert.equal(pa.validateDescriptor(st, { version: '9.9.9', artifacts: { npm: '/a' } }, { fs: fsOk }).ok, false);
    assert.equal(pa.validateDescriptor(st, null).ok, false);
    assert.equal(pa.validateDescriptor(st, { version: '1.2.3', artifacts: { foo: '/abs' } }, { fs: fsOk }).ok, false);
    assert.equal(pa.validateDescriptor(st, { version: '1.2.3', artifacts: { npm: 'rel/x' } }, { fs: fsOk }).ok, false);
    assert.equal(pa.validateDescriptor(st, { version: '1.2.3', artifacts: { npm: '/abs' } }, { fs: fakeFs({ existsSync: () => false }) }).ok, false);
    assert.equal(pa.validateDescriptor(st, { version: '1.2.3', artifacts: {} }, { fs: fsOk }).ok, false);
    assert.equal(pa.validateDescriptor(st, { version: '1.2.3', artifacts: { npm: '/abs/x' } }, { fs: fsOk }).ok, true);
  });
  test('validateDescriptor：pip 包不在允许列表 → not ok', () => {
    const r = pa.validateDescriptor({ target: { version: '1' } }, { version: '1', package: 'evil-pkg', artifacts: { npm: '/a' } }, { fs: fakeFs() });
    assert.equal(r.ok, false);
    assert.match(r.error, /allowlist/);
  });
});

describe('packageAdapter — _downloadPackageArtifact', () => {
  test('非 HTTPS / 无 fetch → 抛', async () => {
    await assert.rejects(() => pa._downloadPackageArtifact({ url: 'http://x/a' }, '/d'), /HTTPS/);
    await assert.rejects(() => pa._downloadPackageArtifact(null, '/d'), /HTTPS/);
    await assert.rejects(() => pa._downloadPackageArtifact({ url: 'https://x/a' }, '/d', { fetch: {} }), /requires fetch/);
  });
  test('HTTP 非 ok → 抛（含状态）', async () => {
    await assert.rejects(
      () => pa._downloadPackageArtifact({ url: 'https://x/a' }, '/d', { fetch: async () => fakeResponse([], { ok: false, status: 404 }) }),
      /HTTP 404/
    );
  });
  test('成功：校验 size+sha256 通过后落盘 rename', async () => {
    const chunk = Buffer.from('hello world payload');
    const rec = { chunks: [], ended: false, renamed: null, removed: [] };
    const fsImpl = fakeFs({
      createWriteStream: () => fakeWritable(rec),
      renameSync: (from, to) => {
        rec.renamed = to;
      },
    });
    const artifact = { url: 'https://x/a.whl', size: chunk.length, sha256: sha256hex(chunk) };
    const res = await pa._downloadPackageArtifact(artifact, '/d/a.whl', { fetch: async () => fakeResponse([chunk]), fs: fsImpl });
    assert.equal(res.size, chunk.length);
    assert.equal(res.sha256, artifact.sha256);
    assert.equal(rec.renamed, '/d/a.whl');
  });
  test('size 不符 → 抛并清理临时文件', async () => {
    const chunk = Buffer.from('abcd');
    const rec = { chunks: [] };
    const removed = [];
    const fsImpl = fakeFs({ createWriteStream: () => fakeWritable(rec), rmSync: (p) => removed.push(p) });
    const artifact = { url: 'https://x/a', size: 999, sha256: sha256hex(chunk) };
    await assert.rejects(() => pa._downloadPackageArtifact(artifact, '/d/a', { fetch: async () => fakeResponse([chunk]), fs: fsImpl }), /size mismatch/);
    assert.ok(removed.length > 0);
  });
  test('sha256 不符 → 抛', async () => {
    const chunk = Buffer.from('abcd');
    const rec = { chunks: [] };
    const fsImpl = fakeFs({ createWriteStream: () => fakeWritable(rec) });
    const artifact = { url: 'https://x/a', size: chunk.length, sha256: 'deadbeef' };
    await assert.rejects(() => pa._downloadPackageArtifact(artifact, '/d/a', { fetch: async () => fakeResponse([chunk]), fs: fsImpl }), /sha256 mismatch/);
  });
  test('无 getReader 的 body → 抛不可读', async () => {
    const rec = { chunks: [] };
    const fsImpl = fakeFs({ createWriteStream: () => fakeWritable(rec) });
    await assert.rejects(
      () => pa._downloadPackageArtifact({ url: 'https://x/a', size: 1, sha256: 'x' }, '/d/a', { fetch: async () => fakeResponse([], { readable: false }), fs: fsImpl }),
      /unreadable/
    );
  });
});

describe('packageAdapter — stagePackageUpdate', () => {
  test('缺版本或缺渠道 → 软失败', async () => {
    assert.deepEqual(
      await pa.stagePackageUpdate({}, { fs: fakeFs() }),
      { success: false, error: 'package target or installed channel is missing' }
    );
    assert.match((await pa.stagePackageUpdate({ target: { version: '1' }, source: {} }, { fs: fakeFs() })).error, /missing/);
  });
  test('pip 包不在允许列表 → 软失败', async () => {
    const r = await pa.stagePackageUpdate({ target: { version: '1' }, source: { packages: { pip: { name: 'evil' } } } }, { fs: fakeFs() });
    assert.equal(r.success, false);
    assert.match(r.error, /allowlist/);
  });
  test('npm run 路径：execFile 被调用、产物命中、写 STAGED.json', async () => {
    const calls = [];
    let written = null;
    const fsImpl = fakeFs({
      readdirSync: () => ['khy-os-khy-os-2.0.0.tgz'],
      writeFileSync: (p, data) => {
        written = { p, data };
      },
    });
    const execFile = (file, args) => {
      calls.push([file, args]);
      return '';
    };
    const r = await pa.stagePackageUpdate(
      { target: { version: '2.0.0' }, source: { packages: { npm: { name: '@khy-os/khy-os' } } } },
      { fs: fsImpl, execFile, cacheDir: '/c' }
    );
    assert.equal(r.success, true);
    assert.equal(calls[0][0], 'npm');
    assert.ok(calls[0][1].includes('pack'));
    assert.ok(written.p.endsWith('STAGED.json'));
    const desc = JSON.parse(written.data);
    assert.equal(desc.type, 'package');
    assert.ok(desc.artifacts.npm.endsWith('khy-os-khy-os-2.0.0.tgz'));
  });
  test('npm run 后目录无匹配产物 → 软失败', async () => {
    const r = await pa.stagePackageUpdate(
      { target: { version: '2.0.0' }, source: { packages: { npm: {} } } },
      { fs: fakeFs({ readdirSync: () => ['somethingelse.tgz'] }), execFile: () => '', cacheDir: '/c' }
    );
    assert.equal(r.success, false);
    assert.match(r.error, /npm pack did not produce/);
  });
});

describe('packageAdapter — applyPackageUpdate', () => {
  const st = (extra) =>
    Object.assign({ target: { version: '2.0.0' }, stagedPath: '/staged', source: { packages: {} } }, extra);

  test('校验不过直接软失败', () => {
    const r = pa.applyPackageUpdate(
      { target: { version: '2.0.0' }, stagedPath: '/x', source: {} },
      { fs: fakeFs({ readFileSync: () => JSON.stringify({ schemaVersion: 1, type: 'package', version: '1.1.1', artifacts: { npm: '/a' } }) }) }
    );
    assert.equal(r.success, false);
    assert.match(r.error, /does not match/);
  });
  test('npm-only：直接全局安装并报告变更', () => {
    const calls = [];
    const fsImpl = fakeFs({
      readFileSync: () => JSON.stringify({ schemaVersion: 1, type: 'package', version: '2.0.0', artifacts: { npm: '/abs/pkg.tgz' } }),
    });
    const r = pa.applyPackageUpdate(
      { target: { version: '2.0.0' }, stagedPath: '/x', source: { packages: { npm: { name: '@khy-os/khy-os', version: '1.0.0' } } } },
      { fs: fsImpl, execFile: (file, args) => { calls.push([file, args]); return 'added 1 package'; } }
    );
    assert.equal(r.success, true);
    assert.equal(r.changed, true);
    assert.equal(r.to, '2.0.0');
    assert.equal(calls[0][0], 'npm');
    assert.ok(calls[0][1].includes('install'));
  });
  test('npm 安装抛错 → 软失败', () => {
    const fsImpl = fakeFs({
      readFileSync: () => JSON.stringify({ schemaVersion: 1, type: 'package', version: '2.0.0', artifacts: { npm: '/abs/pkg.tgz' } }),
    });
    const r = pa.applyPackageUpdate(
      { target: { version: '2.0.0' }, stagedPath: '/x', source: { packages: { npm: { name: 'n', version: '1' } } } },
      { fs: fsImpl, execFile: () => { throw new Error('EACCES'); } }
    );
    assert.equal(r.success, false);
    assert.match(r.error, /npm update failed/);
  });
  test('pip + selfUpdate 委托，且本地 npm 追加为第二渠道', () => {
    const selfUpdate = { applyUpdate: () => ({ success: true, changed: true, channels: [{ channel: 'pip' }] }) };
    const fsImpl = fakeFs({
      readFileSync: () => JSON.stringify({ schemaVersion: 1, type: 'package', version: '2.0.0', package: 'khy-os', artifacts: { pip: '/abs/p.whl', npm: '/abs/n.tgz' } }),
    });
    const stFull = { target: { version: '2.0.0' }, stagedPath: '/x', source: { packages: { pip: { name: 'khy-os', version: '1' }, npm: { name: '@khy-os/khy-os', version: '1' } } } };
    const r = pa.applyPackageUpdate(stFull, { fs: fsImpl, selfUpdate, execFile: () => '' });
    assert.equal(r.success, true);
    assert.ok(r.channels.some((c) => c.channel === 'npm'));
    assert.ok(r.channels.some((c) => c.channel === 'pip'));
  });
  test('selfUpdate 失败时短路返回其结果', () => {
    const selfUpdate = { applyUpdate: () => ({ success: false, error: 'pip boom' }) };
    const fsImpl = fakeFs({
      readFileSync: () => JSON.stringify({ schemaVersion: 1, type: 'package', version: '2.0.0', package: 'khy-os', artifacts: { pip: '/abs/p.whl' } }),
    });
    const stPip = { target: { version: '2.0.0' }, stagedPath: '/x', source: { packages: { pip: { name: 'khy-os' } } } };
    const r = pa.applyPackageUpdate(stPip, { fs: fsImpl, selfUpdate });
    assert.equal(r.success, false);
    assert.equal(r.error, 'pip boom');
  });
});
