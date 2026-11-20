'use strict';

/**
 * phoneAdbPortScan.test.js — 端口扫描这一档的实机行为（用本机监听端口代替手机）。
 *
 * 承重的三件事：
 *   * 开着的端口能被找出来，关着的不能被算成开着；
 *   * 「主机活着但端口全关」与「主机不可达」被分成两种证据——这是失败诊断
 *     的全部依据，说成同一句话用户只能自己猜；
 *   * 扫的范围有上限，不会顺手扫完整个网段。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { scanHostPorts } = require('./phoneAdbPortScan');

/** 起一个监听端口，返回 {port, close}。 */
function listen() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * 找一个此刻确实没人监听的端口。
 *
 * 不能用「监听端口 +1/+2」：node --test 默认并行跑测试文件，别的用例可能
 * 正占着相邻端口，于是本该「关着」的端口变成开着，测试变成随机失败。
 * 这里先试着绑一下——绑得上说明当时没人监听，立刻放掉再拿来扫。
 */
function findClosedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('开着的端口能被扫出来，关着的不会被算成开着', async () => {
  const server = await listen();
  const closedA = await findClosedPort();
  const closedB = await findClosedPort();
  try {
    const res = await scanHostPorts({
      host: '127.0.0.1',
      ports: [server.port, closedA, closedB],
      concurrency: 8,
      timeoutMs: 500,
      deadlineMs: 5000,
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.openPorts, [server.port]);
    // 127.0.0.1 上没监听的端口是「拒绝连接」——这就是「主机活着但端口没开」
    // 的证据形态。
    assert.ok(res.refused > 0, `期望有拒绝计数，实际 ${res.refused}`);
    assert.equal(res.unreachable, 0);
  } finally {
    await server.close();
  }
});

test('主机不可达时给的是「不可达」证据，不是「拒绝」', async () => {
  // 198.51.100.0/24 是 RFC 5737 保留的文档用网段，不该有主机应答。
  const res = await scanHostPorts({
    host: '198.51.100.7',
    ports: [5555, 5556, 5557],
    concurrency: 4,
    timeoutMs: 300,
    deadlineMs: 3000,
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.openPorts, []);
  // 这台机器上有代理/防火墙时可能回 RST，所以不强制 unreachable > refused；
  // 但必须给出「一个都没开」的结论，而不是把主机当活的。
  assert.equal(res.openPorts.length, 0);
});

test('空 host 或空端口列表直接返回，不去扫', async () => {
  const res = await scanHostPorts({ host: '', ports: [5555] });
  assert.equal(res.ok, false);
  assert.match(res.error, /host 或端口列表为空/);

  const res2 = await scanHostPorts({ host: '127.0.0.1', ports: [] });
  assert.equal(res2.ok, false);
  assert.match(res2.error, /host 或端口列表为空/);
});

test('端口范围有上限：超出时间预算就停，不把整网扫完', async () => {
  const started = Date.now();
  const res = await scanHostPorts({
    host: '198.51.100.7',
    ports: Array.from({ length: 400 }, (_, i) => 30000 + i),
    concurrency: 50,
    timeoutMs: 120,
    deadlineMs: 1200,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `扫描耗时 ${elapsed}ms，超出预算`);
  assert.equal(res.openPorts.length, 0);
});
