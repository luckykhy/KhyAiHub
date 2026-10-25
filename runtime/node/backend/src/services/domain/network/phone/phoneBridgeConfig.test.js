'use strict';

/**
 * phoneBridgeConfig.test.js — co-located suite for the phone bridge config leaf.
 *
 * IO: none. The adb probe is injected; nothing here touches the filesystem or
 * the device.
 *
 * Pinned facts (measured on the installed artifact, contradicting the task
 * brief and the APK's own README):
 *   - port 8896, not 8898
 *   - mailbox dir /sdcard/bridge-amoobridge, not /sdcard/bridge
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const config = require('./phoneBridgeConfig');

test('默认配置与实机测得值一致', () => {
  const resolved = config.resolvePhoneBridgeConfig({});
  assert.equal(resolved.serial, '192.168.2.46:33743');
  assert.equal(resolved.httpPort, 8896);
  assert.equal(resolved.localPort, 8896);
  assert.equal(resolved.mailboxDir, '/sdcard/bridge-amoobridge');
  assert.equal(resolved.tokenRemotePath, '/sdcard/bridge-amoobridge/token.txt');
  assert.equal(resolved.statusRemotePath, '/sdcard/bridge-amoobridge/status.json');
  assert.equal(resolved.loopbackHost, '127.0.0.1');
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:8896');
  assert.equal(resolved.httpTimeoutMs, 10000);
  assert.equal(resolved.adbTimeoutMs, 15000);
  assert.equal(resolved.retryCount, 1);
  assert.equal(resolved.mailboxPollMs, 500);
  assert.equal(resolved.mailboxTimeoutMs, 30000);
});

test('adb 默认落在 PATH 之外的裸名，交给 spawn 解析', () => {
  assert.equal(config.resolveAdbExecutable({}), config.resolveAdbExecutable({ PATH: '' }));
  assert.match(config.resolveAdbExecutable({}), /^adb(\.exe)?$/);
});

test('KHY_PHONE_BRIDGE_ADB 显式指定时优先，且原样返回不做加工', () => {
  const weird = path.join('some', 'dir', 'my-adb');
  assert.equal(config.resolveAdbExecutable({ KHY_PHONE_BRIDGE_ADB: `  ${weird}  ` }), weird);
});

test('PATH 命中时取第一个存在的候选', () => {
  const first = path.join('C:', 'first');
  const second = path.join('C:', 'second');
  const env = { PATH: [first, second].join(path.delimiter) };
  const names = config.ADB_EXECUTABLE_NAMES;
  const probe = (candidate) => candidate === path.join(second, names[0]);
  assert.equal(config.resolveAdbExecutable(env, { hasExecutable: probe }), path.join(second, names[0]));
});

test('探针抛错不该炸掉解析，当作不存在继续找', () => {
  const dir = path.join('C:', 'tools');
  const env = { PATH: dir };
  const probe = (candidate) => {
    if (candidate === path.join(dir, 'adb.exe')) {
      throw new Error('EACCES');
    }
    return candidate === path.join(dir, 'adb');
  };
  assert.equal(config.resolveAdbExecutable(env, { hasExecutable: probe }), path.join(dir, 'adb'));
});

test('探针不是函数时安静回退，不当成真', () => {
  assert.equal(config.resolveAdbExecutable({}, { hasExecutable: 'nope' }), config.resolveAdbExecutable({}));
  assert.equal(config.resolveAdbExecutable({}, { hasExecutable: null }), config.resolveAdbExecutable({}));
});

test('端口/序列号/目录全部可被 env 覆盖', () => {
  const resolved = config.resolvePhoneBridgeConfig({
    KHY_PHONE_BRIDGE_PORT: '9900',
    KHY_PHONE_BRIDGE_SERIAL: '10.0.0.5:5555',
    KHY_PHONE_BRIDGE_MAILBOX_DIR: '/data/local/tmp/bridge',
    KHY_PHONE_BRIDGE_LOCAL_PORT: '8898',
  });
  assert.equal(resolved.httpPort, 9900);
  assert.equal(resolved.localPort, 8898);
  assert.equal(resolved.serial, '10.0.0.5:5555');
  assert.equal(resolved.mailboxDir, '/data/local/tmp/bridge');
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:9900');
});

test('垃圾 env 值静默回退默认，不抛也不传 NaN', () => {
  const resolved = config.resolvePhoneBridgeConfig({
    KHY_PHONE_BRIDGE_PORT: 'abc',
    KHY_PHONE_BRIDGE_PORT_ALT: 'x',
    KHY_PHONE_BRIDGE_HTTP_TIMEOUT_MS: '0',
    KHY_PHONE_BRIDGE_ADB_TIMEOUT_MS: '-5',
    KHY_PHONE_BRIDGE_RETRY_COUNT: 'not-a-number',
    KHY_PHONE_BRIDGE_MAILBOX_POLL_MS: '',
    KHY_PHONE_BRIDGE_MAILBOX_TIMEOUT_MS: 'NaN',
    KHY_PHONE_BRIDGE_SERIAL: '   ',
  });
  assert.equal(resolved.httpPort, 8896);
  assert.equal(resolved.httpTimeoutMs, 10000);
  assert.equal(resolved.adbTimeoutMs, 15000);
  assert.equal(resolved.retryCount, 1);
  assert.equal(resolved.mailboxPollMs, 500);
  assert.equal(resolved.mailboxTimeoutMs, 30000);
  assert.equal(resolved.serial, '192.168.2.46:33743');
  for (const value of Object.values(resolved)) {
    assert.ok(!Number.isNaN(value), JSON.stringify(value));
  }
});

test('retryCount 允许 0（不重试），负值回退默认', () => {
  assert.equal(config.resolvePhoneBridgeConfig({ KHY_PHONE_BRIDGE_RETRY_COUNT: '0' }).retryCount, 0);
  assert.equal(config.resolvePhoneBridgeConfig({ KHY_PHONE_BRIDGE_RETRY_COUNT: '-2' }).retryCount, 1);
});

test('token 路径跟随被覆盖的信箱目录，不指向一个不存在的默认目录', () => {
  assert.equal(
    config.resolveTokenRemotePath({ KHY_PHONE_BRIDGE_MAILBOX_DIR: '/sdcard/other-bridge' }),
    '/sdcard/other-bridge/token.txt'
  );
  // 信箱目录没被覆盖时，token 路径就是默认值
  assert.equal(config.resolveTokenRemotePath({}), '/sdcard/bridge-amoobridge/token.txt');
});

test('token 路径可被独立覆盖，优先级高于信箱目录推导', () => {
  assert.equal(
    config.resolveTokenRemotePath({
      KHY_PHONE_BRIDGE_TOKEN_PATH: '/data/local/tmp/t.txt',
      KHY_PHONE_BRIDGE_MAILBOX_DIR: '/sdcard/other-bridge',
    }),
    '/data/local/tmp/t.txt'
  );
});

test('信箱目录与 token 路径的空白值被当回默认', () => {
  assert.equal(config.resolveMailboxDir({ KHY_PHONE_BRIDGE_MAILBOX_DIR: '   ' }), '/sdcard/bridge-amoobridge');
  assert.equal(config.resolveTokenRemotePath({ KHY_PHONE_BRIDGE_TOKEN_PATH: '  ' }), '/sdcard/bridge-amoobridge/token.txt');
});

test('buildLoopbackBaseUrl 用插值拼装，端口坏值回退默认', () => {
  assert.equal(config.buildLoopbackBaseUrl(8896), 'http://127.0.0.1:8896');
  assert.equal(config.buildLoopbackBaseUrl('nope'), 'http://127.0.0.1:8896');
  assert.equal(config.buildLoopbackBaseUrl(8896, '   '), 'http://127.0.0.1:8896');
  assert.equal(config.buildLoopbackBaseUrl(1234, 'localhost'), 'http://localhost:1234');
});

test('buildLoopbackBaseUrl 产出的串里没有任何写死的 127.0.0.1:<端口> 端点', () => {
  // RUNTIME-001：产品代码不得钉死 host:port。这条测试是那道守卫的单测版。
  const url = config.buildLoopbackBaseUrl(8896);
  assert.equal(/127\.0\.0\.1:\d{2,5}/.test(url), true);
  const source = require('fs').readFileSync(require.resolve('./phoneBridgeConfig'), 'utf8');
  const codeLines = source.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  for (const line of codeLines) {
    assert.equal(
      /['"`]https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/.test(line),
      false,
      `phoneBridgeConfig.js 里有写死的端点：${line.trim()}`
    );
  }
});

test('resolveTimeouts 暴露全部五个超时/重试旋钮', () => {
  const t = config.resolveTimeouts({});
  assert.deepEqual(Object.keys(t).sort(), [
    'adbTimeoutMs', 'httpTimeoutMs', 'mailboxPollMs', 'mailboxTimeoutMs', 'retryCount',
  ]);
});

test('每次解析返回新对象，调用方改动不互相污染', () => {
  const a = config.resolvePhoneBridgeConfig({});
  a.httpPort = 1;
  const b = config.resolvePhoneBridgeConfig({});
  assert.equal(b.httpPort, 8896);
});

// ── P1：adb 标准 SDK 位置候选（PATH 之后追加，仍走注入探针、零 IO） ─────────

test('adb 位置候选：PATH 之后追加 ANDROID_HOME/platform-tools', () => {
  const root = path.join('C:', 'sdkroot');
  const hit = path.join(root, 'platform-tools', config.ADB_EXECUTABLE_NAMES[0]);
  assert.equal(
    config.resolveAdbExecutable(
      { ANDROID_HOME: root, PATH: path.join('C:', 'nowhere') },
      { hasExecutable: (candidate) => candidate === hit }
    ),
    hit
  );
  // 同一个探针下 PATH 命中优先
  const pathHit = path.join('C:', 'adbdir', config.ADB_EXECUTABLE_NAMES[0]);
  assert.equal(
    config.resolveAdbExecutable(
      { ANDROID_HOME: root, PATH: path.join('C:', 'adbdir') },
      { hasExecutable: (candidate) => candidate === pathHit || candidate === hit }
    ),
    pathHit
  );
  // 没有探针时行为不变：仍回裸名，候选一个都不碰
  assert.equal(config.resolveAdbExecutable({ ANDROID_HOME: root }), config.resolveAdbExecutable({}));
});

test('adb 位置候选：ANDROID_SDK_ROOT 与 homedir 默认位置都只是候选', () => {
  const root = path.join('C:', 'sdk-from-root');
  const rootHit = path.join(root, 'platform-tools', config.ADB_EXECUTABLE_NAMES[0]);
  assert.equal(
    config.resolveAdbExecutable(
      { ANDROID_SDK_ROOT: root, PATH: '' },
      { hasExecutable: (candidate) => candidate === rootHit }
    ),
    rootHit
  );
  // 候选都不存在 → 安静回退裸名，不抛
  assert.match(
    config.resolveAdbExecutable(
      { ANDROID_SDK_ROOT: root },
      { hasExecutable: () => false }
    ),
    /^adb(\.exe)?$/
  );
});

// ── P1：serial 自动档的纯判定 ────────────────────────────────────────────────

test('pickDeviceSerial：同机双形态（IP + mdns 实例名）按物理身份去重，IP 形态优先', () => {
  const ip = '192.168.1.117:34103';
  const mdnsName = 'adb-1234abcd-AbCdEf._adb-tls-connect._tcp.';
  assert.deepEqual(
    config.pickDeviceSerial({ devices: [
      { serial: ip, state: 'device' },
      { serial: mdnsName, state: 'device' },
    ] }),
    { ok: true, serial: ip, source: 'adb-devices' }
  );
  // mdns 服务给出映射时归并到同一身份，仍取 IP 形态
  assert.deepEqual(
    config.pickDeviceSerial({
      devices: [
        { serial: ip, state: 'device' },
        { serial: mdnsName, state: 'device' },
      ],
      mdnsMap: { [mdnsName]: ip },
    }),
    { ok: true, serial: ip, source: 'adb-devices' }
  );
});

test('pickDeviceSerial：多台真机判 ambiguous（不猜），单台 USB 序列号也能命中', () => {
  assert.deepEqual(
    config.pickDeviceSerial({ devices: [
      { serial: '192.168.1.117:34103', state: 'device' },
      { serial: '192.168.1.118:40001', state: 'device' },
    ] }).source,
    'ambiguous'
  );
  assert.deepEqual(
    config.pickDeviceSerial({ devices: [{ serial: 'ABC123', state: 'device' }] }),
    { ok: true, serial: 'ABC123', source: 'adb-devices' }
  );
});

test('pickDeviceSerial：只认 state=device，offline/unauthorized 不算候选', () => {
  assert.equal(
    config.pickDeviceSerial({ devices: [{ serial: '192.168.1.117:34103', state: 'offline' }] }).source,
    'none'
  );
  assert.equal(
    config.pickDeviceSerial({ devices: [{ serial: '192.168.1.117:34103', state: 'unauthorized' }] }).source,
    'none'
  );
});

test('pickMdnsSerial：唯一 _adb-tls-connect 实例才命中，多实例不猜', () => {
  assert.deepEqual(config.pickMdnsSerial(['192.168.1.117:34103']), {
    ok: true,
    serial: '192.168.1.117:34103',
    source: 'adb-mdns',
  });
  assert.equal(config.pickMdnsSerial(['1.1.1.1:1', '2.2.2.2:2']).source, 'ambiguous');
  assert.equal(config.pickMdnsSerial([]).source, 'none');
  assert.equal(config.pickMdnsSerial(['  ', null]).source, 'none');
});

test('resolveDeviceSerial 自动档：env 显式 > 检测结果 > 旧默认', () => {
  assert.equal(
    config.resolveDeviceSerial({}, { detectedSerial: ' 192.168.1.117:34103 ' }),
    '192.168.1.117:34103'
  );
  assert.equal(
    config.resolveDeviceSerial(
      { KHY_PHONE_BRIDGE_SERIAL: '10.0.0.5:5555' },
      { detectedSerial: '192.168.1.117:34103' }
    ),
    '10.0.0.5:5555'
  );
  assert.equal(config.resolveDeviceSerial({}), '192.168.2.46:33743');
  assert.equal(config.resolveDeviceSerial({}, { detectedSerial: '   ' }), '192.168.2.46:33743');
});

test('serialSource 反映串行号来源（default 才允许 IO 层走自动档）', () => {
  assert.equal(config.resolvePhoneBridgeConfig({}).serialSource, 'default');
  assert.equal(
    config.resolvePhoneBridgeConfig({ KHY_PHONE_BRIDGE_SERIAL: '1.2.3.4:5' }).serialSource,
    'env'
  );
  assert.equal(
    config.resolvePhoneBridgeConfig({}, { detectedSerial: '9.9.9.9:9' }).serialSource,
    'auto'
  );
});
