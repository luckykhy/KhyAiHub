'use strict';

/**
 * phonePairCodeReader.test.js — 取配对码这一档的测试。
 *
 * 承重的三件事：
 *   * 只认 khy-os 自己那条通知——别的 App 也可能发「配对码 123456」，认错包会
 *     拿别人的码去换证书（浪费一个 120 秒的一次性码，还可能配错设备）；
 *   * 有多条时取最新那条（桥每次签发会替换通知）；
 *   * 通知栏里没有就是没有——不猜码、不编一个出来。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractPairCode, readPairCodeViaAdb } = require('./phonePairCodeReader');

/** 一份真实形态的 dumpsys notification --noredact 片段。 */
function dumpFor(pkg, text, whenMs) {
  return [
    'Current Notification Manager state:',
    '  Notification List:',
    `    NotificationRecord(0x04074588: pkg=${pkg} user=UserHandle{0} id=4933721 tag=null importance=3 key=0|${pkg}|4933721|null|10231: Notification(channel=msg shortcut=null contentView=null bigContentView=null vibrate=null sound=null defaults=0 flags=AUTO_CANCEL color=0x00000000 vis=PRIVATE))`,
    '      uid=10231 userId=0',
    '      notification=',
    '            fullscreenIntent=null',
    `            when=${whenMs}/${whenMs}`,
    `            android.title=String (khy-os 配对码)`,
    `            android.text=String (${text})`,
    '            android.appInfo=ApplicationInfo (ApplicationInfo{a17b096 com.khyos.khy_os_client})',
  ].join('\n');
}

test('从 khy-os 的通知里取出配对码', () => {
  const dump = dumpFor('com.khyos.khy_os_client', '配对码 030427（120 秒内有效，仅一次）。只在本人操作时填回 PC。', 1794855907696);
  const res = extractPairCode(dump);
  assert.equal(res.ok, true);
  assert.equal(res.code, '030427');
  assert.equal(res.whenMs, 1794855907696);
});

test('别的 App 的「配对码」不会被当成我们的码', () => {
  const dump = [
    dumpFor('com.other.app', '配对码 111111（别的 App 的）', 1794855907696),
    dumpFor('com.khyos.khy_os_client', '配对码 222222（我们的）', 1794855907000),
  ].join('\n');
  const res = extractPairCode(dump);
  assert.equal(res.ok, true);
  assert.equal(res.code, '222222', '只认自己那条通知');
});

test('多条自己家的通知时取最新那条', () => {
  const dump = [
    dumpFor('com.khyos.khy_os_client', '配对码 111111', 1794855900000),
    dumpFor('com.khyos.khy_os_client', '配对码 222222', 1794855999999),
  ].join('\n');
  const res = extractPairCode(dump);
  assert.equal(res.code, '222222');
});

test('通知栏里没有我们家的通知时，如实说没有', () => {
  const res = extractPairCode(dumpFor('com.other.app', '配对码 111111', 1));
  assert.equal(res.ok, false);
  assert.match(res.error, /没有 com\.khyos\.khy_os_client 的通知/);
});

test('空 dump 不炸，也不编一个码出来', () => {
  assert.equal(extractPairCode('').ok, false);
  assert.equal(extractPairCode(undefined).ok, false);
  assert.equal(extractPairCode(null).ok, false);
});

test('通知在但里面没有码时，如实说没有', () => {
  const dump = dumpFor('com.khyos.khy_os_client', '别的通知内容', 1);
  const res = extractPairCode(dump);
  assert.equal(res.ok, false);
  assert.match(res.error, /没有配对码/);
});

test('读通知栏：adb 失败时说清失败原因，不编码', async () => {
  const res = await readPairCodeViaAdb({
    run: async () => ({ ok: false, stderr: 'no devices/emulators found' }),
    argv: ['-s', 'x', 'shell', 'dumpsys', 'notification', '--noredact'],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /no devices\/emulators found/);
});

test('读通知栏：没有 run 通道时如实说没有', async () => {
  const res = await readPairCodeViaAdb({ argv: ['x'] });
  assert.equal(res.ok, false);
  assert.match(res.error, /没有 adb 通道/);
});

test('读通知栏：成功时把码交出去', async () => {
  const dump = dumpFor('com.khyos.khy_os_client', '配对码 654321（120 秒内有效，仅一次）。', 1794855907696);
  const res = await readPairCodeViaAdb({
    run: async () => ({ ok: true, stdout: dump }),
    argv: ['-s', 'x', 'shell', 'dumpsys', 'notification', '--noredact'],
  });
  assert.equal(res.ok, true);
  assert.equal(res.code, '654321');
});
