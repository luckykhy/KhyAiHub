'use strict';

// Co-located unit test for amooWorkspacePlan.js — the pure leaf of the
// bidirectional sync workspace. No adb, no phone, no filesystem: argv shapes,
// manifest diffing and the Chinese copy are all asserted here.

const test = require('node:test').test;
const assert = require('node:assert/strict');

const leaf = require('./amooWorkspacePlan');

const SERIAL = '192.168.2.46:33743';

test('workspace 参数解析：空参落 status，未知词明确拒绝', () => {
  assert.equal(leaf.parseWorkspaceArgv([]).action, 'status');
  const bad = leaf.parseWorkspaceArgv(['pushh']);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /未知工作区动作/);
  assert.match(bad.error, /push \/ pull \/ status/);
});

test('push 没有目录时报错并给出正确用法', () => {
  const res = leaf.parseWorkspaceArgv(['push']);
  assert.equal(res.ok, false);
  assert.match(res.error, /push 需要本地目录/);
});

test('push / pull / status 的参数各自落位', () => {
  assert.deepEqual(
    { action: leaf.parseWorkspaceArgv(['push', 'D:/x']).action, dir: leaf.parseWorkspaceArgv(['push', 'D:/x']).localDir },
    { action: 'push', dir: 'D:/x' }
  );
  assert.equal(leaf.parseWorkspaceArgv(['push', 'D:/x', '/sdcard/other']).remoteDir, '/sdcard/other');
  assert.equal(leaf.parseWorkspaceArgv(['pull']).action, 'pull');
  assert.equal(leaf.parseWorkspaceArgv(['pull']).localDir, '');
  assert.equal(leaf.parseWorkspaceArgv(['status']).action, 'status');
  assert.equal(leaf.parseWorkspaceArgv(['help']).action, 'help');
});

test('argv 构造与 amooBridgePolicy 同构（单字符串 device-shell 命令）', () => {
  assert.deepEqual(leaf.buildRemoteListArgv(SERIAL, '/sdcard/amoo-dev'), [
    '-s',
    SERIAL,
    'shell',
    'ls -1 /sdcard/amoo-dev 2>/dev/null',
  ]);
  assert.deepEqual(leaf.buildPushArgv(SERIAL, 'D:/x/a.js', '/sdcard/amoo-dev/a.js'), [
    '-s',
    SERIAL,
    'push',
    'D:/x/a.js',
    '/sdcard/amoo-dev/a.js',
  ]);
  assert.deepEqual(leaf.buildPullArgv(SERIAL, '/sdcard/amoo-dev/a.js', 'D:/y/a.js'), [
    '-s',
    SERIAL,
    'pull',
    '/sdcard/amoo-dev/a.js',
    'D:/y/a.js',
  ]);
});

test('manifest：空/坏 JSON/非对象都按空处理，不挡住第一次同步', () => {
  assert.deepEqual(leaf.readManifest(''), { version: 1, files: {} });
  assert.deepEqual(leaf.readManifest('{oops'), { version: 1, files: {} });
  assert.deepEqual(leaf.readManifest('[1,2]'), { version: 1, files: {} });
  assert.deepEqual(leaf.readManifest(null), { version: 1, files: {} });
  const good = leaf.readManifest(leaf.writeManifest({ 'a.js': { sha256: 'ff', size: 3 } }));
  assert.equal(good.files['a.js'].sha256, 'ff');
  // 写出来的文本能原样读回（round-trip）
  assert.deepEqual(leaf.readManifest(leaf.writeManifest(good.files)).files, good.files);
});

test('planPush：新增进 upload、未变跳过、本地删了的只报告不擅自删', () => {
  const files = [
    { name: 'a.js', sha256: 'aa', size: 1 },
    { name: 'b.js', sha256: 'bb', size: 2 },
    { name: '.amoo-workspace.json', sha256: 'zz', size: 9 },
  ];
  const manifest = { files: { 'a.js': { sha256: 'aa' }, 'gone.js': { sha256: 'gg' } } };
  const plan = leaf.planPush(files, manifest);
  assert.deepEqual(plan.upload, ['b.js']);
  assert.deepEqual(plan.skip, ['a.js']);
  assert.deepEqual(plan.remove, ['gone.js']);
  // manifest 自己永远不进 upload
  assert.equal(plan.upload.includes('.amoo-workspace.json'), false);
});

test('planPush：空 manifest 全量上传；空入参不炸', () => {
  assert.deepEqual(leaf.planPush([{ name: 'x', sha256: 's' }], { files: {} }).upload, ['x']);
  assert.deepEqual(leaf.planPush([], { files: {} }), { upload: [], skip: [], remove: [] });
  assert.deepEqual(leaf.planPush(undefined, undefined), { upload: [], skip: [], remove: [] });
});

test('文案：help 覆盖三个动作与约定，status 标注远端来源', () => {
  const help = leaf.renderWorkspaceHelp();
  assert.match(help, /workspace push/);
  assert.match(help, /workspace pull/);
  assert.match(help, /扁平文件/);
  const text = leaf.renderWorkspaceStatus({
    localDir: 'D:/x',
    remoteDir: '/sdcard/amoo-dev',
    local: [{ name: 'a.js' }],
    remote: [{ name: 'b.js', size: 12 }],
    remoteSource: 'bridge',
    error: null,
  });
  assert.match(text, /手机文件：1 个（来源：桥 ls）/);
  assert.match(text, /b\.js（12 B）/);
});

test('文案：push 结果分桶，pull 结果区分成功与失败', () => {
  const pushed = leaf.renderPushResult({ upload: ['a.js'], skip: ['b.js'], remove: ['c.js'], remoteDir: '/sdcard/amoo-dev' });
  assert.match(pushed, /已上传 1 个文件/);
  assert.match(pushed, /\+ a\.js/);
  assert.match(pushed, /跳过 1 个/);
  assert.match(pushed, /未擅自动手机上文件/);
  const pulled = leaf.renderPullResult({ pulled: ['a.js'], failed: ['b.js'], localDir: 'D:/y' });
  assert.match(pulled, /v a\.js/);
  assert.match(pulled, /x b\.js（拉取失败）/);
});
