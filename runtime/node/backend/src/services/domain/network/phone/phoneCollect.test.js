'use strict';

/**
 * phoneCollect.test.js — 采集判定的纯函数层（不碰设备）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const collect = require('./phoneCollect');

test('按扩展名归类：图片/音频/视频/JSON/文本各自归位，未知不采', () => {
  assert.equal(collect.classifyFile('/sdcard/DCIM/Camera/a.JPG'), 'image');
  assert.equal(collect.classifyFile('/sdcard/Music/song.mp3'), 'audio');
  assert.equal(collect.classifyFile('/sdcard/Movies/clip.mp4'), 'video');
  assert.equal(collect.classifyFile('/sdcard/Download/data.json'), 'json');
  assert.equal(collect.classifyFile('/sdcard/Download/notes.md'), 'text');
  assert.equal(collect.classifyFile('/sdcard/Download/archive.zip'), null);
  assert.equal(collect.classifyFile('/sdcard/Download/noext'), null);
});

test('只采指定类型、目录内、深度不过头的文件', () => {
  const paths = [
    '/sdcard/DCIM/a.jpg',
    '/sdcard/DCIM/b.mp4',
    '/sdcard/DCIM/sub/deep/c.png',
    '/sdcard/DCIM/x/y/z/too-deep.jpg',
    '/sdcard/Movies/kept.mp4',
    '/sdcard/Other/outside.jpg',
    '/sdcard/DCIM/a.jpg',
  ];
  const picked = collect.selectFiles({
    paths,
    remoteDir: '/sdcard/DCIM',
    types: ['image'],
    maxDepth: 5,
  });
  const remotePaths = picked.map((p) => p.remotePath);
  assert.deepEqual(remotePaths, ['/sdcard/DCIM/a.jpg', '/sdcard/DCIM/sub/deep/c.png']);
  // 目录外的同名目录不能混进来；重复路径只算一次；过深的不要
  assert.equal(remotePaths.includes('/sdcard/Other/outside.jpg'), false);
  assert.equal(remotePaths.includes('/sdcard/DCIM/x/y/z/too-deep.jpg'), false);
});

test('类型留空时采全部已知类型', () => {
  const picked = collect.selectFiles({
    paths: ['/sdcard/DCIM/a.jpg', '/sdcard/DCIM/b.bin', '/sdcard/DCIM/c.mp4'],
    remoteDir: '/sdcard/DCIM',
    types: [],
  });
  assert.deepEqual(picked.map((p) => p.type), ['image', 'video']);
});

test('find 的 argv 走 shell，路径是参数不是命令串', () => {
  assert.deepEqual(collect.buildFindArgv({ serial: 'x' }, '/sdcard/DCIM'), [
    'shell', 'find', '/sdcard/DCIM', '-type', 'f',
  ]);
});

test('时间窗：7d/48h/2w 都能解析成起始时间戳，空串不设窗', () => {
  const now = 1700000000000;
  assert.equal(collect.parseSince('7d', now), now - 7 * 86400000);
  assert.equal(collect.parseSince('48h', now), now - 48 * 3600000);
  assert.equal(collect.parseSince('2w', now), now - 2 * 604800000);
  assert.equal(collect.parseSince('', now), null);
  assert.equal(collect.parseSince('abc', now), null);
});

test('时间窗：窗外的丢进 dropped，mtime 缺失的照采但计数', () => {
  const now = 1700000000000;
  const files = [
    { remotePath: '/sdcard/DCIM/new.jpg', mtimeMs: now - 3600000 },
    { remotePath: '/sdcard/DCIM/old.jpg', mtimeMs: now - 30 * 86400000 },
    { remotePath: '/sdcard/DCIM/unknown.jpg', mtimeMs: null },
  ];
  const res = collect.filterBySince(files, now - 7 * 86400000);
  assert.deepEqual(res.kept.map((f) => f.remotePath), [
    '/sdcard/DCIM/new.jpg',
    '/sdcard/DCIM/unknown.jpg',
  ]);
  assert.deepEqual(res.dropped.map((f) => f.remotePath), ['/sdcard/DCIM/old.jpg']);
  assert.equal(res.unknown, 1);
});

test('清单带上采集的文件、跳过的条目与各类型计数', () => {
  const manifest = collect.buildManifest({
    remoteDir: '/sdcard/DCIM',
    localDir: 'out/dcim',
    types: ['image'],
    counts: { image: 2 },
    files: [{ remotePath: '/sdcard/DCIM/a.jpg', localPath: 'out/dcim/a.jpg', type: 'image', bytes: 10 }],
    skipped: [{ remotePath: '/sdcard/DCIM/b.mp4', reason: 'too_large', bytes: 999 }],
  });
  assert.equal(manifest.schema, 'khy-phone-collect/1');
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.skipped[0].reason, 'too_large');
  assert.deepEqual(manifest.counts, { image: 2 });
});
