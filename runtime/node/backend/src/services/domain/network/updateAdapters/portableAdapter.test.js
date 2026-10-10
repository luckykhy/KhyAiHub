'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// portableAdapter pulls in a provider extension, node-stream-zip and the update
// index protocol at load time. Stub all three before requiring it so no real
// download / unzip / provider lookup happens, then restore the cache.
const providerPath = require.resolve('../../extensions/extensions/providerModule');
const indexPath = require.resolve('../../../updateIndexProtocol');
const zipPath = require.resolve('node-stream-zip');

const saved = {
  provider: require.cache[providerPath],
  index: require.cache[indexPath],
  zip: require.cache[zipPath],
};

const providerCtl = {
  normalizeTarget: (p, a) => ({ platform: p, arch: a }),
  verifyArtifactManifest: async () => ({ ok: true, manifest: { version: '9.9.9', source: { commit: 'c' } } }),
  runHealthCheck: async () => ({ ok: true }),
};
const indexCtl = { ok: true, errors: [] };
const zipCtl = { entries: async () => ({}), extracted: [], closed: false };

require.cache[providerPath] = {
  id: providerPath,
  filename: providerPath,
  loaded: true,
  paths: [],
  exports: {
    requireFromProvider: () => ({
      normalizeTarget: (p, a) => providerCtl.normalizeTarget(p, a),
      verifyArtifactManifest: (r) => providerCtl.verifyArtifactManifest(r),
      runHealthCheck: (o) => providerCtl.runHealthCheck(o),
    }),
  },
};
require.cache[indexPath] = {
  id: indexPath,
  filename: indexPath,
  loaded: true,
  paths: [],
  exports: { validateUpdateIndex: () => ({ ok: indexCtl.ok, errors: indexCtl.errors }) },
};
require.cache[zipPath] = {
  id: zipPath,
  filename: zipPath,
  loaded: true,
  paths: [],
  exports: {
    async: function () {
      return {
        entries: () => zipCtl.entries(),
        extract: (n, t) => {
          zipCtl.extracted.push([n, t]);
          return Promise.resolve();
        },
        close: () => {
          zipCtl.closed = true;
          return Promise.resolve();
        },
      };
    },
  },
};

const pa = require('./portableAdapter');
const { SWAP_SCRIPT_BODY } = require('./windowsSwapScript');

let TMP;
function tmp() {
  if (!TMP) TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-portable-'));
  return TMP;
}
function sha(buf) {
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

after(() => {
  delete require.cache[require.resolve('./portableAdapter')];
  if (saved.provider) require.cache[providerPath] = saved.provider;
  else delete require.cache[providerPath];
  if (saved.index) require.cache[indexPath] = saved.index;
  else delete require.cache[indexPath];
  if (saved.zip) require.cache[zipPath] = saved.zip;
  else delete require.cache[zipPath];
  if (TMP) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('portableAdapter — _rootFor', () => {
  test('cacheDir + portable + 安全化目标', () => {
    assert.equal(pa._rootFor({ target: { version: '1.2.3' } }, { cacheDir: '/c' }), path.join('/c', 'portable', '1.2.3'));
    assert.equal(pa._rootFor({ target: { commit: 'abc' } }, { cacheDir: '/c' }), path.join('/c', 'portable', 'abc'));
    assert.equal(pa._rootFor({}, { cacheDir: '/c' }), path.join('/c', 'portable', 'unknown'));
    assert.equal(pa._rootFor({ target: { version: 'a/b*' } }, { cacheDir: '/c' }), path.join('/c', 'portable', 'a_b_'));
  });
});

describe('portableAdapter — _resolveIndexUrl', () => {
  test('显式 indexUrl 必须 HTTPS', async () => {
    assert.equal(await pa._resolveIndexUrl('stable', { indexUrl: 'https://x/i.json' }), 'https://x/i.json');
    await assert.rejects(() => pa._resolveIndexUrl('stable', { indexUrl: 'http://x/i.json' }), /HTTPS/);
  });
  test('stable/dev 用 releases 派生默认（无字面量硬编码）', async () => {
    const s = await pa._resolveIndexUrl('stable', {});
    assert.match(s, /releases\/latest\/download\/update-index-stable\.json$/);
    const d = await pa._resolveIndexUrl('dev', {});
    assert.match(d, /releases\/download\/dev-channel\/update-index-dev\.json$/);
  });
  test('env 覆盖仓库地址', async () => {
    const r = await pa._resolveIndexUrl('stable', { env: { KHY_UPDATE_GITHUB_REPOSITORY: 'me/repo' } });
    assert.ok(r.includes('me/repo'));
  });
  test('preview 通道从 releases API 选带 preview 资产的 prerelease', async () => {
    const releases = [
      { prerelease: false, draft: false, assets: [] },
      {
        prerelease: true,
        draft: false,
        assets: [{ name: 'update-index-preview.json', browser_download_url: 'https://gh/preview.json' }],
      },
    ];
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => releases });
    const picked = await pa._resolveIndexUrl('preview', { fetch: fetchImpl });
    assert.equal(picked, 'https://gh/preview.json');
  });
  test('preview 无可用资产 → 抛', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [] });
    await assert.rejects(() => pa._resolveIndexUrl('preview', { fetch: fetchImpl }), /unavailable/);
  });
});

describe('portableAdapter — _selectArtifact', () => {
  const index = (platform, arch, extra = {}) => ({
    release: { version: '9.9.9', commit: 'c' },
    portable: [Object.assign({ kind: 'portable-runtime', target: { platform, arch }, version: '9.9.9', commit: 'c', url: 'https://x/a.zip' }, extra)],
  });
  test('唯一匹配返回该产物', () => {
    const t = providerCtl.normalizeTarget(process.platform, process.arch === 'arm64' ? 'arm64' : 'x64');
    const a = pa._selectArtifact(index(t.platform, t.arch), {});
    assert.equal(a.url, 'https://x/a.zip');
  });
  test('零匹配/多匹配 → 抛 no unique', () => {
    assert.throws(() => pa._selectArtifact({ release: {}, portable: [] }, {}), /no unique/);
    const t = providerCtl.normalizeTarget(process.platform, 'x64');
    const dup = { release: {}, portable: [
      { kind: 'portable-runtime', target: { platform: t.platform, arch: t.arch }, version: '1', commit: 'c', url: 'a' },
      { kind: 'portable-runtime', target: { platform: t.platform, arch: t.arch }, version: '1', commit: 'c', url: 'b' },
    ] };
    assert.throws(() => pa._selectArtifact(dup, {}), /no unique/);
  });
  test('产物版本与 release 不符 → 抛', () => {
    const t = providerCtl.normalizeTarget(process.platform, 'x64');
    const bad = index(t.platform, 'x64', { version: '0.0.1' });
    assert.throws(() => pa._selectArtifact(bad, {}), /does not match release/);
  });
});

describe('portableAdapter — _downloadFile', () => {
  test('非 HTTPS / 无 fetch / 无 body → 抛', async () => {
    await assert.rejects(() => pa._downloadFile('http://x/a', path.join(tmp(), 'd'), {}), /HTTPS/);
    await assert.rejects(() => pa._downloadFile('https://x/a', path.join(tmp(), 'd'), {}, { fetch: {} }), /requires fetch/);
    await assert.rejects(() => pa._downloadFile('https://x/a', path.join(tmp(), 'dfile'), {}, { fetch: async () => fakeResponse([], { readable: false }) }), /unreadable/);
  });
  test('成功写入 tmp 并 rename，校验 size+sha256', async () => {
    const chunk = Buffer.from('portable-bytes-xyz');
    const dest = path.join(tmp(), 'dl', 'a.zip');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await pa._downloadFile('https://x/a.zip', dest, { size: chunk.length, sha256: sha(chunk) }, { fetch: async () => fakeResponse([chunk]) });
    assert.equal(res.size, chunk.length);
    assert.equal(res.sha256, sha(chunk));
    assert.equal(fs.existsSync(dest), true);
  });
  test('size/sha 不符 → 抛并清理', async () => {
    const chunk = Buffer.from('abc');
    const dest = path.join(tmp(), 'dl2', 'a.zip');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await assert.rejects(() => pa._downloadFile('https://x/a.zip', dest, { size: 999, sha256: sha(chunk) }, { fetch: async () => fakeResponse([chunk]) }), /size mismatch/);
    await assert.rejects(() => pa._downloadFile('https://x/a.zip', dest, { size: chunk.length, sha256: 'bad' }, { fetch: async () => fakeResponse([chunk]) }), /sha256 mismatch/);
    assert.equal(fs.existsSync(dest), false);
  });
});

describe('portableAdapter — _extractZip（路径穿越防护）', () => {
  test('相对 .. 逃逸抛错', async () => {
    zipCtl.entries = async () => ({ '../evil': { name: '../evil' } });
    await assert.rejects(() => pa._extractZip('z.zip', tmp()), /escapes root/);
  });
  test('绝对名抛错', async () => {
    zipCtl.entries = async () => ({ '/abs/x': { name: '/abs/x' } });
    await assert.rejects(() => pa._extractZip('z.zip', tmp()), /escapes root/);
  });
  test('反斜杠归一后含 .. 也抛', async () => {
    zipCtl.entries = async () => ({ 'a\\..\\b': { name: 'a\\..\\b' } });
    await assert.rejects(() => pa._extractZip('z.zip', tmp()), /escapes root/);
  });
  test('合法条目被解出', async () => {
    zipCtl.entries = async () => ({ 'dir/f.txt': { name: 'dir/f.txt' } });
    zipCtl.extracted = [];
    zipCtl.closed = false;
    const dest = path.join(tmp(), 'ex');
    fs.mkdirSync(dest, { recursive: true });
    await pa._extractZip('z.zip', dest);
    assert.equal(zipCtl.extracted.length, 1);
    assert.equal(zipCtl.closed, true);
  });
});

describe('portableAdapter — 延迟交换调度', () => {
  test('_scheduleDeferredRollback 缺路径 → scheduled:false', () => {
    assert.equal(pa._scheduleDeferredRollback({ live: '', backup: '' }).scheduled, false);
    assert.equal(pa._scheduleDeferredRollback({ live: '/a', backup: '' }).scheduled, false);
  });
  test('委托给 opts.scheduleDeferredSwap（若提供）', () => {
    const out = pa._scheduleDeferredRollback({
      live: '/a/live',
      backup: '/a/bak',
    }, { scheduleDeferredSwap: ({ live, incoming, backup, parentPid }) => ({ delegated: true, live, incoming, backup, parentPid }) });
    assert.equal(out.delegated, true);
    assert.equal(out.live, '/a/live');
    // rollback: the existing backup becomes the incoming payload, and a fresh
    // rollback target is minted for the current live dir.
    assert.equal(out.incoming, '/a/bak');
    assert.match(out.backup, /khy-rollback/);
    assert.equal(typeof out.parentPid, 'number');
  });
  test('默认分支：写脚本到 live 同目录并以 argv 数组 spawn（空格/反斜杠路径各占独立参数，不拼接成命令串）', () => {
    const dir = path.join(tmp(), 'a dir with space');
    fs.mkdirSync(dir, { recursive: true });
    const live = path.join(dir, 'my live root');
    const spawnCalls = [];
    const fakeChild = { unref: () => {} };
    const res = pa._scheduleDeferredRollback(
      { live, backup: path.join(dir, 'old backup') },
      { spawn: (file, args) => { spawnCalls.push([file, args]); return fakeChild; } }
    );
    assert.equal(res.scheduled, true);
    assert.equal(spawnCalls[0][0], 'powershell.exe');
    const args = spawnCalls[0][1];
    // Every path must be its OWN argv element, never embedded in a longer
    // concatenated string — this is what keeps spaces/backslashes safe.
    assert.ok(args.includes('-File'));
    assert.ok(args.includes(live), 'live path must appear as a discrete argv token');
    assert.ok(args.includes(res.resultPath));
    const joined = args.filter((a) => typeof a === 'string' && (a.includes('-Live ') || a.includes(' -File ')));
    assert.equal(joined.length, 0);
    // The generated script body is the exact static constant, written under tmp.
    const scriptPath = args[args.indexOf('-File') + 1];
    assert.ok(scriptPath.startsWith(dir));
    assert.equal(fs.readFileSync(scriptPath, 'utf8'), SWAP_SCRIPT_BODY);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('portableAdapter — applyPortable 校验闸', () => {
  test('descriptor 非 portable/版本不符/root 缺失 → 软失败且不动 live', async () => {
    const t = tmp();
    const bad = path.join(t, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, type: 'package', version: '9.9.9', root: t }));
    const r = await pa.applyPortable({ stagedPath: bad, target: { version: '9.9.9' }, source: { root: path.join(t, 'live') } });
    assert.equal(r.success, false);
    assert.match(r.error, /invalid/);

    const noRoot = path.join(t, 'noroot.json');
    fs.writeFileSync(noRoot, JSON.stringify({ schemaVersion: 1, type: 'portable', version: '9.9.9', root: path.join(t, 'missing-dir') }));
    const r2 = await pa.applyPortable({ stagedPath: noRoot, target: { version: '9.9.9' }, source: { root: path.join(t, 'live') } });
    assert.equal(r2.success, false);
  });
});

describe('portableAdapter — checkPortable / stagePortable（索引无效路径）', () => {
  test('validateUpdateIndex 不过 → checkPortable indeterminate', async () => {
    indexCtl.ok = false;
    indexCtl.errors = ['bad field'];
    const r = await pa.checkPortable({ channel: 'stable' }, { indexUrl: 'https://x/i.json', fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    assert.equal(r.indeterminate, true);
    assert.match(r.error, /invalid portable update index/);
    indexCtl.ok = true;
    indexCtl.errors = [];
  });
  test('fetch 抛错 → checkPortable indeterminate', async () => {
    const r = await pa.checkPortable({}, { indexUrl: 'https://x/i.json', fetch: async () => { throw new Error('net down'); } });
    assert.equal(r.indeterminate, true);
  });
  test('有效索引 → available 依 compareVersions', async () => {
    const t = providerCtl.normalizeTarget(process.platform, process.arch === 'arm64' ? 'arm64' : 'x64');
    const idx = { release: { version: '9.9.9', commit: 'c' }, portable: [{ kind: 'portable-runtime', target: { platform: t.platform, arch: t.arch }, version: '9.9.9', commit: 'c', url: 'https://x/a.zip' }] };
    const r = await pa.checkPortable({ version: '1.0.0', channel: 'stable' }, { indexUrl: 'https://x/i.json', fetch: async () => ({ ok: true, status: 200, json: async () => idx }) });
    assert.equal(r.available, true);
    assert.equal(r.targetVersion, '9.9.9');
  });
  test('stagePortable：索引无效 → 软失败', async () => {
    indexCtl.ok = false;
    const r = await pa.stagePortable({}, { index: {} });
    assert.equal(r.success, false);
    assert.match(r.error, /invalid portable update index/);
    indexCtl.ok = true;
  });
});
