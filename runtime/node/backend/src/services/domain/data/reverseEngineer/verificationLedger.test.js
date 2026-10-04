'use strict';

/**
 * verificationLedger.test.js — 构建清单与保真度评分的契约。
 *
 * 真源规范：DESIGN-ARCH-054 §3.7（「khy 生成的软件也可以由 khy 更好地验证」）。
 * 落盘只在 os.tmpdir() 的一次性目录里，绝不对真工作树写文件；用例结束后回收。
 * 重点是评分算术：产物同一性 50% + 源覆盖 50%，以及「无清单不阻断」的降级形状。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ledger = require('./verificationLedger');

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b27-ledger-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('清单常量：版本 1、约定文件名以点开头（不污染目录列表）', () => {
  assert.strictEqual(ledger.MANIFEST_VERSION, 1);
  assert.strictEqual(ledger.MANIFEST_BASENAME, '.khy-build-manifest.json');
});

test('_basenameKey 去目录、统一大小写，跨 Windows/POSIX 斜杠都能对上', () => {
  assert.strictEqual(ledger._basenameKey('a/b/C.JS'), 'c.js');
  assert.strictEqual(ledger._basenameKey('C:\\proj\\App.Ts'), 'app.ts');
  assert.strictEqual(ledger._basenameKey('plain.txt'), 'plain.txt');
  assert.strictEqual(ledger._basenameKey(undefined), 'undefined');
});

test('buildManifest 记录源文件哈希与大小，缺失文件两字段皆 null', () =>
  withTemp((dir) => {
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)', 'utf8');
    const m = ledger.buildManifest({
      rootDir: dir,
      artifactPath: path.join(dir, 'dist', 'app.exe'),
      sourceFiles: ['app.js', 'gone.js'],
      entry: 'app.js',
      toolchain: 'node-sea',
    });
    assert.strictEqual(m.manifestVersion, 1);
    assert.strictEqual(m.sourceCount, 2);
    assert.strictEqual(m.artifact.name, 'app.exe');
    assert.strictEqual(m.artifact.sha256, null); // 产物不存在 → null，绝不抛
    assert.deepStrictEqual(m.entry, 'app.js');
    assert.deepStrictEqual(m.toolchain, 'node-sea');
    const [app, gone] = m.sources;
    assert.strictEqual(app.name, 'app.js'); // 相对化且用正斜杠
    assert.strictEqual(app.sha256, sha(Buffer.from('console.log(1)', 'utf8')));
    assert.strictEqual(app.size, 14);
    assert.deepStrictEqual([gone.sha256, gone.size], [null, null]);
  }));

test('buildManifest 不认得 spec 时用 cwd 兜底，且无 artifactPath 时 name/sha 均 null', () => {
  const m = ledger.buildManifest({ sourceFiles: [] });
  assert.strictEqual(m.sourceCount, 0);
  assert.deepStrictEqual(m.sources, []);
  assert.strictEqual(m.artifact.name, null);
  assert.strictEqual(m.artifact.sha256, null);
  assert.strictEqual(m.entry, null);
});

test('writeManifest → loadManifest 往返一致；损坏/无版本/不存在一律 null', () =>
  withTemp((dir) => {
    const m = ledger.buildManifest({ rootDir: dir, sourceFiles: [] });
    const out = ledger.writeManifest(m, path.join(dir, ledger.MANIFEST_BASENAME));
    assert.strictEqual(out, path.join(dir, ledger.MANIFEST_BASENAME));
    assert.deepStrictEqual(ledger.loadManifest(out), m);
    // 坏 JSON / 缺 manifestVersion / 路径不存在 → null，绝不抛。
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{oops', 'utf8');
    assert.strictEqual(ledger.loadManifest(bad), null);
    const noVer = path.join(dir, 'nover.json');
    fs.writeFileSync(noVer, JSON.stringify({ sources: [] }), 'utf8');
    assert.strictEqual(ledger.loadManifest(noVer), null);
    assert.strictEqual(ledger.loadManifest(path.join(dir, 'missing.json')), null);
  }));

test('findManifestFor 只认产物同目录的约定文件名', () =>
  withTemp((dir) => {
    const artifact = path.join(dir, 'app.exe');
    fs.writeFileSync(artifact, 'MZ', 'ascii');
    assert.strictEqual(ledger.findManifestFor(artifact), null);
    const man = path.join(dir, ledger.MANIFEST_BASENAME);
    fs.writeFileSync(man, JSON.stringify({ manifestVersion: 1, sources: [] }), 'utf8');
    assert.strictEqual(ledger.findManifestFor(artifact), man);
    assert.strictEqual(ledger.findManifestFor(null), null);
  }));

test('verify 无清单时不阻断：no-baseline 且 fidelity null', () => {
  for (const m of [null, undefined, {}, { sources: 'not-an-array' }]) {
    const r = ledger.verify({ sha256: 'x' }, { members: [] }, m);
    assert.deepStrictEqual(
      { hasBaseline: r.hasBaseline, verdict: r.verdict, fidelity: r.fidelity },
      { hasBaseline: false, verdict: 'no-baseline', fidelity: null }
    );
  }
  assert.ok(ledger.verify(null, null, null).message.includes('无构建清单基线'));
});

test('verify：哈希一致 + 全覆盖 → verified / fidelity 100', () => {
  const s = 'a'.repeat(64);
  const manifest = {
    manifestVersion: 1,
    artifact: { sha256: s },
    sources: [{ name: 'src/app.js' }, { name: 'src/util.js' }],
  };
  const recover = {
    members: [
      { name: 'app.js', kind: 'source' },
      { name: 'util.js', kind: 'source' },
    ],
  };
  const r = ledger.verify({ sha256: s }, recover, manifest);
  assert.deepStrictEqual(
    {
      verdict: r.verdict,
      fidelity: r.fidelity,
      artifactHashMatch: r.artifactHashMatch,
      coverage: r.coverage,
      matchedCount: r.matchedCount,
      missingCount: r.missingCount,
    },
    {
      verdict: 'verified',
      fidelity: 100,
      artifactHashMatch: true,
      coverage: 1,
      matchedCount: 2,
      missingCount: 0,
    }
  );
});

test('verify 的算术：哈希一致占 50 分，覆盖占 50 分；无哈希基线时只按覆盖给分', () => {
  const manifest = (sha256, n) => ({
    manifestVersion: 1,
    artifact: { sha256 },
    sources: Array.from({ length: n }, (_, i) => ({ name: `f${i}.js` })),
  });
  const half = { members: [{ name: 'f0.js', kind: 'source' }] };
  // 一致 + 覆盖 1/2 → 50 + 25 = 75，判 partial。
  const a = ledger.verify({ sha256: 'x' }, half, manifest('x', 2));
  assert.deepStrictEqual([a.fidelity, a.verdict, a.coverage], [75, 'partial', 0.5]);
  // 不一致 + 覆盖 1/2 → 0 + 25 = 25，判 mismatch。
  const b = ledger.verify({ sha256: 'y' }, half, manifest('x', 2));
  assert.deepStrictEqual([b.fidelity, b.verdict], [25, 'mismatch']);
  // 清单没有产物哈希 → artifactHashMatch null，分数退化为纯覆盖（0.5×100=50）。
  // 判级却仍走「coverage ≥ 0.6 或哈希一致」这道门：无哈希基线时 50 分覆盖判 mismatch。
  // 即 fidelity 与 verdict 分档并非同一把尺（已登记为本单元已知边界，非本批修复）。
  const c = ledger.verify({ sha256: 'z' }, half, manifest(null, 2));
  assert.deepStrictEqual([c.fidelity, c.artifactHashMatch, c.verdict], [50, null, 'mismatch']);
  // 同一把门的另一侧：无哈希基线但覆盖到 0.6 → partial（分数 60，与判级终于自洽）。
  const six = { members: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'].map((n) => ({ name: `${n}.js`, kind: 'source' })) };
  const e = ledger.verify({ sha256: 'z' }, six, manifest(null, 10));
  assert.deepStrictEqual([e.fidelity, e.coverage, e.verdict], [60, 0.6, 'partial']);
  // 一致但覆盖 0：仍 partial（50 分保底），fidelity 50。
  const d = ledger.verify({ sha256: 'x' }, { members: [] }, manifest('x', 2));
  assert.deepStrictEqual([d.fidelity, d.verdict, d.missingCount], [50, 'partial', 2]);
});

test('verify 把 scan 缺 sha256 判成「不一致」而不是「无法判定」', () => {
  const manifest = {
    manifestVersion: 1,
    artifact: { sha256: 'x' },
    sources: [{ name: 'a.js' }],
  };
  const r = ledger.verify({}, { members: [{ name: 'a.js', kind: 'source' }] }, manifest);
  assert.strictEqual(r.artifactHashMatch, false);
  assert.strictEqual(r.fidelity, 50);
});

test('verify 只把 kind=source 的还原成员算进 extra，资产与字节码不报额外', () => {
  const manifest = { manifestVersion: 1, artifact: {}, sources: [{ name: 'a.js' }] };
  const r = ledger.verify(
    {},
    {
      members: [
        { name: 'a.js', kind: 'source' },
        { name: 'extra.js', kind: 'source' },
        { name: 'logo.png', kind: 'asset' },
        { name: 'Foo.class', kind: 'bytecode' },
      ],
    },
    manifest
  );
  assert.deepStrictEqual(r.extra, ['extra.js']);
  assert.deepStrictEqual(r.matched, ['a.js']);
});

test('verify 的清单比较按 basename 归一：大小写与目录差异都算命中', () => {
  const manifest = {
    manifestVersion: 1,
    artifact: {},
    sources: [{ name: 'src/App.js' }],
  };
  const r = ledger.verify({}, { members: [{ name: 'build\\app.JS', kind: 'source' }] }, manifest);
  assert.strictEqual(r.matchedCount, 1);
  assert.strictEqual(r.extra.length, 0);
});

test('verify 对空清单源数组给 coverage 0（不是 NaN），members 缺失按空处理', () => {
  const r = ledger.verify({}, {}, { manifestVersion: 1, artifact: {}, sources: [] });
  assert.deepStrictEqual([r.coverage, r.fidelity, r.verdict], [0, 0, 'mismatch']);
  assert.deepStrictEqual([r.matchedCount, r.missingCount, r.extra.length], [0, 0, 0]);
});
