'use strict';

/**
 * agentServer 的双向能力协商测试（[MGMT-RPT-035] L7，借鉴 goose `acp/server.rs`）。
 *
 * 这一半解决的是 [DESIGN-ARCH-184] §0 术语红线「想要而没给机制」的那一格：
 * 面 A（khy 作为 ACP agent）将来若要发 ACP v1 稳定面之外的 khy 自有更新，
 * 必须先让客户端声明收得到。否则就是往标准协议里渗私有方言。
 *
 * 三条必须钉住的不变量：
 *   1. **fail-closed**：未握手 / 未声明 / 声明为非 true ⇒ 一律 false。
 *      误发比漏发严重得多——漏发只是少一个特性，误发是污染协议。
 *   2. **latch 一次**：第二次 initialize 不翻转已协商结果。
 *      否则同一进程被第二个客户端重连时，「发/不发」会随时序漂移。
 *   3. **实例隔离**：状态在工厂闭包里，不在模块级。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAgentServer } = require('../../src/services/domain/messaging/agentclient/agentServer');

/** 最小假通道：initialize 路径不写帧，有 write 就够。 */
function fakeChannel() {
  return { write() {} };
}

function makeServer() {
  return createAgentServer({ channel: fakeChannel(), version: '9.9.9' });
}

async function initialize(server, params) {
  const r = await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params });
  return r;
}

describe('extractClientKhyCaps', () => {
  it('从标准字段 clientCapabilities.khy 里取声明，不新造协议字段', () => {
    const s = makeServer();
    assert.deepStrictEqual(
      s.extractClientKhyCaps({ clientCapabilities: { khy: { sessionTelemetry: true } } }),
      { sessionTelemetry: true }
    );
  });

  it('缺省/畸形一律返回空对象，绝不抛', () => {
    const s = makeServer();
    assert.deepStrictEqual(s.extractClientKhyCaps(undefined), {});
    assert.deepStrictEqual(s.extractClientKhyCaps(null), {});
    assert.deepStrictEqual(s.extractClientKhyCaps({}), {});
    assert.deepStrictEqual(s.extractClientKhyCaps({ clientCapabilities: null }), {});
    assert.deepStrictEqual(s.extractClientKhyCaps({ clientCapabilities: 'nope' }), {});
    assert.deepStrictEqual(s.extractClientKhyCaps({ clientCapabilities: {} }), {});
    assert.deepStrictEqual(s.extractClientKhyCaps({ clientCapabilities: { khy: null } }), {});
    assert.deepStrictEqual(s.extractClientKhyCaps({ clientCapabilities: { khy: [] } }), {});
    assert.deepStrictEqual(s.extractClientKhyCaps({ clientCapabilities: { khy: 'yes' } }), {});
    assert.deepStrictEqual(s.extractClientKhyCaps('not an object'), {});
  });
});

describe('clientSupports — fail-closed', () => {
  it('握手之前一律 false', async () => {
    const s = makeServer();
    assert.strictEqual(s.clientSupports('anything'), false);
    assert.strictEqual(s.clientSupports(''), false);
    assert.strictEqual(s.clientSupports(null), false);
    assert.strictEqual(s.clientSupports(undefined), false);
  });

  it('initialize 不带 clientCapabilities ⇒ 仍然全 false', async () => {
    const s = makeServer();
    await initialize(s, undefined);
    assert.strictEqual(s.clientSupports('sessionTelemetry'), false);
  });

  it('initialize 带了但没声明 khy 命名空间 ⇒ 全 false', async () => {
    const s = makeServer();
    await initialize(s, { clientCapabilities: { fs: true, terminal: true } });
    assert.strictEqual(s.clientSupports('sessionTelemetry'), false);
  });

  it('声明为非 true（字符串/数字/对象）不算声明', async () => {
    const s = makeServer();
    await initialize(s, {
      clientCapabilities: { khy: { a: 'yes', b: 1, c: {}, d: null, e: false } },
    });
    for (const k of ['a', 'b', 'c', 'd', 'e']) {
      assert.strictEqual(s.clientSupports(k), false, `${k} 不应算作声明`);
    }
  });

  it('显式声明 true 才放行', async () => {
    const s = makeServer();
    await initialize(s, {
      clientCapabilities: { khy: { sessionTelemetry: true, somethingElse: false } },
    });
    assert.strictEqual(s.clientSupports('sessionTelemetry'), true);
    assert.strictEqual(s.clientSupports('somethingElse'), false);
    assert.strictEqual(s.clientSupports('neverDeclared'), false);
  });
});

describe('clientSupports — latch 一次', () => {
  it('第二次 initialize 不翻转已协商结果', async () => {
    const s = makeServer();
    await initialize(s, { clientCapabilities: { khy: { sessionTelemetry: true } } });
    assert.strictEqual(s.clientSupports('sessionTelemetry'), true);

    // 第二个客户端重连并声明了更多——已协商的不许被静默改掉
    await initialize(s, { clientCapabilities: { khy: { sessionTelemetry: false, extra: true } } });
    assert.strictEqual(s.clientSupports('sessionTelemetry'), true, 'latch 后不许被翻转成 false');
    assert.strictEqual(s.clientSupports('extra'), false, 'latch 后不许新增能力');
  });

  it('两个 server 实例的状态互相独立（状态在工厂闭包，不在模块级）', async () => {
    const a = makeServer();
    const b = makeServer();
    await initialize(a, { clientCapabilities: { khy: { sessionTelemetry: true } } });
    assert.strictEqual(a.clientSupports('sessionTelemetry'), true);
    assert.strictEqual(b.clientSupports('sessionTelemetry'), false, 'b 没握手过，必须还是 false');
  });
});

describe('initialize 响应形状不变', () => {
  it('协议版本/agentCapabilities/agentInfo/authMethods 与协商前一致', async () => {
    const s = makeServer();
    const r = await initialize(s, { clientCapabilities: { khy: { x: true } } });
    assert.strictEqual(r.protocolVersion, 1);
    assert.deepStrictEqual(r.agentCapabilities, { loadSession: false });
    assert.strictEqual(r.agentInfo.name, 'khy-os');
    assert.strictEqual(r.agentInfo.version, '9.9.9');
    assert.deepStrictEqual(r.authMethods, []);
  });
});
