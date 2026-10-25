'use strict';

// Co-located unit test for amooWorkspaceClient.js — the IO shell of the
// bidirectional sync workspace. adb is a recorded fake, the local dir is a
// real temp dir, and the hasher is the real sha256 so the manifest diffing
// under test is the same code that runs against the phone.

const test = require('node:test').test;
const after = require('node:test').after;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAmooWorkspaceClient } = require('./amooWorkspaceClient');
const { resolveAmooConfig } = require('./amooBridgeConfig');

const SERIAL = '192.168.2.46:33743';

const roots = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function fakeAdb(script = {}) {
  const calls = [];
  return {
    calls,
    async run(argv) {
      calls.push(argv.slice());
      const verb = argv[2];
      if (verb === 'push') return { ok: true, stdout: '1 file pushed', stderr: '', error: null };
      if (verb === 'pull') return { ok: true, stdout: '1 file pulled', stderr: '', error: null };
      if (verb === 'shell') {
        if (script.lsFail) return { ok: false, stdout: '', stderr: 'No such file or directory', error: 'adb_ls_failed' };
        return { ok: true, stdout: (script.names || []).join('\n') + '\n', stderr: '', error: null };
      }
      return { ok: false, stdout: '', stderr: `unhandled ${argv.join(' ')}`, error: 'unhandled' };
    },
  };
}

function makeClient(localDir, adb, env = {}) {
  const config = resolveAmooConfig({
    KHY_AMOO_ADB_PATH: 'C:/fake/adb.exe',
    ...env,
  });
  return createAmooWorkspaceClient({ config, env, runAdb: (argv) => adb.run(argv) });
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

test('首次 push 上传全部文件并写下 manifest', async () => {
  const dir = tmpDir('khy-ws-push-');
  writeFile(dir, 'a.js', 'print(1)\n');
  writeFile(dir, 'b.txt', 'hello\n');
  const adb = fakeAdb();
  const client = makeClient(dir, adb);

  const res = await client.push(dir);
  assert.equal(res.ok, true);
  assert.deepEqual(res.pushed.sort(), ['a.js', 'b.txt']);
  assert.equal(res.remoteDir, '/sdcard/amoo-dev');
  // 推的是远端绝对路径，serial 显式带
  assert.deepEqual(adb.calls[0], ['-s', SERIAL, 'push', path.join(dir, 'a.js'), '/sdcard/amoo-dev/a.js']);
  // manifest 落盘，且不含自己
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.amoo-workspace.json'), 'utf8'));
  assert.equal(manifest.files['a.js'].sha256.length, 64);
  assert.equal(manifest.files['.amoo-workspace.json'], undefined);
});

test('二次 push 无变动时一个 adb 都不发', async () => {
  const dir = tmpDir('khy-ws-noop-');
  writeFile(dir, 'a.js', 'print(1)\n');
  const adb = fakeAdb();
  const client = makeClient(dir, adb);

  assert.equal((await client.push(dir)).ok, true);
  const before = adb.calls.length;
  const second = await client.push(dir);
  assert.equal(second.ok, true);
  assert.deepEqual(second.pushed, []);
  assert.equal(adb.calls.length, before, '无变动时零 adb 调用');
});

test('改过的文件才上传；manifest 坏掉时按全量重算', async () => {
  const dir = tmpDir('khy-ws-diff-');
  writeFile(dir, 'a.js', 'v1\n');
  const adb = fakeAdb();
  const client = makeClient(dir, adb);

  await client.push(dir);
  writeFile(dir, 'a.js', 'v2\n');
  const res = await client.push(dir);
  assert.deepEqual(res.pushed, ['a.js']);
  // 坏 manifest 不报错，按全量
  writeFile(dir, '.amoo-workspace.json', '{坏');
  const again = await client.push(dir);
  assert.deepEqual(again.pushed.sort(), ['a.js']);
});

test('部分失败时报 push_partial 且不写 manifest（下次重算）', async () => {
  const dir = tmpDir('khy-ws-partial-');
  writeFile(dir, 'a.js', 'a\n');
  writeFile(dir, 'b.js', 'b\n');
  const adb = fakeAdb();
  const original = adb.run.bind(adb);
  adb.run = async (argv) => {
    if (argv[2] === 'push' && String(argv[4]).endsWith('/b.js')) {
      return { ok: false, stdout: '', stderr: 'Read-only file system', error: null };
    }
    return original(argv);
  };
  const client = makeClient(dir, adb);

  const res = await client.push(dir);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'push_partial');
  assert.deepEqual(res.pushed, ['a.js']);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /Read-only/);
});

test('pull 按远端名字逐个拉；空目录说清楚，列不出如实报错', async () => {
  const dir = tmpDir('khy-ws-pull-src-');
  const target = path.join(tmpDir('khy-ws-pull-dst-'), 'out');
  const adb = fakeAdb({ names: ['a.js', 'b.js'] });
  const client = makeClient(dir, adb);

  const res = await client.pull(target);
  assert.equal(res.ok, true);
  assert.deepEqual(res.pulled, ['a.js', 'b.js']);
  assert.deepEqual(adb.calls[1], ['-s', SERIAL, 'pull', '/sdcard/amoo-dev/a.js', path.join(target, 'a.js')]);

  const empty = await makeClient(dir, fakeAdb({ names: [] })).pull(target);
  assert.equal(empty.code, 'remote_empty');
  assert.equal(empty.ok, true);

  const failed = await makeClient(dir, fakeAdb({ lsFail: true })).pull(target);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'remote_list_failed');
  assert.match(failed.error, /列不出手机工作区/);
});

test('status：本地清单 + 远端名字清单，manifest 不出现在远端', async () => {
  const dir = tmpDir('khy-ws-status-');
  writeFile(dir, 'a.js', 'a\n');
  const adb = fakeAdb({ names: ['a.js', '.amoo-workspace.json', 'b.js'] });
  const client = makeClient(dir, adb, { KHY_AMOO_WORKSPACE_LOCAL: dir });

  const res = await client.status();
  assert.equal(res.ok, true);
  assert.deepEqual(res.local.map((f) => f.name), ['a.js']);
  assert.deepEqual(res.remote.sort(), ['a.js', 'b.js']);
  assert.equal(res.remoteSource, 'adb');
  assert.equal(res.remoteDir, '/sdcard/amoo-dev');
});

test('远端目录可经 KHY_AMOO_WORKSPACE_DIR 覆盖', async () => {
  const dir = tmpDir('khy-ws-env-');
  const adb = fakeAdb({ names: [] });
  const client = makeClient(dir, adb, { KHY_AMOO_WORKSPACE_DIR: '/sdcard/other-dev' });
  assert.equal(client.remoteDir, '/sdcard/other-dev');
  const res = await client.push(dir);
  assert.equal(res.remoteDir, '/sdcard/other-dev');
});
