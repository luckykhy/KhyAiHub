'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./remoteDevState');

// remoteDevState is a PURE LEAF: no fs, no net, no clock. These tests exercise
// the deterministic folds only.

describe('remoteDevState — 常量与导出', () => {
  test('VALID_STOP_SCOPES 固定四值', () => {
    assert.deepStrictEqual(leaf.VALID_STOP_SCOPES, ['session', 'bridge', 'daemon', 'all']);
  });
  test('SESSION_STATE 三个裁决值', () => {
    assert.deepStrictEqual(leaf.SESSION_STATE, {
      LIVE: 'live',
      RECOVERABLE: 'recoverable',
      NONE: 'none',
    });
  });
});

describe('remoteDevState — reconcileSession', () => {
  test('无指针 → NONE', () => {
    for (const p of [null, undefined, {}, { connectionId: '' }, 0, 'x', []]) {
      const r = leaf.reconcileSession(p, []);
      assert.equal(r.state, leaf.SESSION_STATE.NONE);
      assert.equal(r.live, false);
      assert.equal(r.connectionId, null);
    }
  });
  test('指针命中活动注册表 → LIVE，live 字段覆盖指针', () => {
    const pointer = { connectionId: 'abc', host: 'h1', status: 'stale' };
    const live = [{ connectionId: 'abc', status: 'connected', lastActivityAt: 'now' }];
    const r = leaf.reconcileSession(pointer, live);
    assert.equal(r.state, leaf.SESSION_STATE.LIVE);
    assert.equal(r.live, true);
    assert.equal(r.connectionId, 'abc');
    assert.equal(r.session.status, 'connected'); // live precedence
    assert.equal(r.session.host, 'h1'); // pointer carries identity fields
    assert.equal(r.session.lastActivityAt, 'now');
  });
  test('指针存活但注册表丢失 → RECOVERABLE，status 改 recoverable', () => {
    const r = leaf.reconcileSession({ connectionId: 'zz', host: 'h' }, [{ connectionId: 'other' }]);
    assert.equal(r.state, leaf.SESSION_STATE.RECOVERABLE);
    assert.equal(r.live, false);
    assert.equal(r.session.status, 'recoverable');
    assert.equal(r.session.host, 'h');
  });
  test('liveSessions 非数组按空数组处理', () => {
    const r = leaf.reconcileSession({ connectionId: 'a' }, 'not-array');
    assert.equal(r.state, leaf.SESSION_STATE.RECOVERABLE);
    const r2 = leaf.reconcileSession({ connectionId: 'a' }, null);
    assert.equal(r2.state, leaf.SESSION_STATE.RECOVERABLE);
  });
  test('connectionId 数字与字符串等价匹配（_str 归一）', () => {
    const r = leaf.reconcileSession({ connectionId: 42 }, [{ connectionId: '42' }]);
    assert.equal(r.state, leaf.SESSION_STATE.LIVE);
  });
  test('注册表元素含 null/无 connectionId 不误命中', () => {
    const r = leaf.reconcileSession({ connectionId: 'a' }, [null, {}, { connectionId: 'b' }]);
    assert.equal(r.state, leaf.SESSION_STATE.RECOVERABLE);
  });
});

describe('remoteDevState — buildSessionDescriptor', () => {
  test('session 优先于 hostEntry，缺失回落 host 再回落 null', () => {
    const d = leaf.buildSessionDescriptor({
      session: { connectionId: 'c', host: 'sh', hostAlias: 'sa', port: 22, remoteUser: 'u', connectedAt: 't' },
      hostEntry: { alias: 'ha', host: 'hh', port: 2222, user: 'hu' },
      workspace: '/ws',
      savedAt: '2026-01-01T00:00:00Z',
    });
    assert.equal(d.connectionId, 'c');
    assert.equal(d.hostAlias, 'sa');
    assert.equal(d.host, 'sh');
    assert.equal(d.port, 22);
    assert.equal(d.remoteUser, 'u');
    assert.equal(d.remoteWorkspace, '/ws');
    assert.equal(d.purpose, 'development');
    assert.equal(d.savedAt, '2026-01-01T00:00:00Z');
  });
  test('hostEntry 填充 session 缺失字段', () => {
    const d = leaf.buildSessionDescriptor({
      session: { connectionId: 'c' },
      hostEntry: { alias: 'ha', host: 'hh', port: 2222, user: 'hu' },
    });
    assert.equal(d.hostAlias, 'ha');
    assert.equal(d.host, 'hh');
    assert.equal(d.port, 2222);
    assert.equal(d.remoteUser, 'hu');
    assert.equal(d.remoteWorkspace, null);
    assert.equal(d.savedAt, null);
  });
  test('port=0 保留为 0；缺省字段回落 null，非数字 port 收敛 null', () => {
    const d0 = leaf.buildSessionDescriptor({ session: { connectionId: 'c', port: 0 } });
    assert.equal(d0.port, 0);
    assert.equal(d0.remoteWorkspace, null);
    const dBad = leaf.buildSessionDescriptor({ session: { connectionId: 'c', port: 'abc' } });
    assert.equal(dBad.port, null);
    const dEmpty = leaf.buildSessionDescriptor({});
    assert.equal(dEmpty.connectionId, null);
    assert.equal(dEmpty.purpose, 'development');
  });
  test('KNOWN-DEFECT: buildSessionDescriptor 无参调用抛 TypeError，而同级 buildUnifiedState 有 ={} 默认', () => {
    // remoteDevState.js:80 destructures its argument without a `= {}` default,
    // so a bare call throws. buildUnifiedState (line 108) guards this. Every
    // in-repo caller passes an object, so this is low severity, but the leaf
    // contract ("pure, never throws on garbage") is asymmetric here.
    assert.throws(() => leaf.buildSessionDescriptor(), TypeError);
    assert.doesNotThrow(() => leaf.buildUnifiedState());
  });
});

describe('remoteDevState — buildUnifiedState', () => {
  const base = () => ({
    daemon: { running: true, pid: 100, port: 3000, uptime: 5000, health: 'ok' },
    bridge: { running: true, url: 'http://x:9000', pin: '1234', clientCount: 2, tokenShort: 'ab' },
    remoteSnapshot: {
      active_remote_sessions: [{ connectionId: 'c', host: 'h' }],
      pending_remote_approvals: [{}, {}],
      summary: { persistence_enabled: true },
    },
    hosts: [{ alias: 'a', host: 'h', port: 22, user: 'u', remoteWorkspace: '/w' }],
    pointer: { connectionId: 'c', host: 'h' },
    config: { daemonPort: 3000 },
    nowIso: 'NOW',
  });
  test('完整快照折成规范化模型', () => {
    const u = leaf.buildUnifiedState(base());
    assert.equal(u.generatedAt, 'NOW');
    assert.equal(u.daemon.running, true);
    assert.equal(u.daemon.port, 3000);
    assert.equal(u.daemon.uptimeMs, 5000);
    assert.equal(u.bridge.clientCount, 2);
    assert.equal(u.session.state, leaf.SESSION_STATE.LIVE);
    assert.equal(u.session.connectionId, 'c');
    assert.equal(u.remote.activeSessionCount, 1);
    assert.equal(u.remote.pendingApprovalCount, 2);
    assert.equal(u.remote.persistenceEnabled, true);
    assert.equal(u.hosts.length, 1);
    assert.equal(u.hosts[0].alias, 'a');
    assert.ok(Array.isArray(u.discoverability));
  });
  test('空对象入参不抛，产出零值骨架', () => {
    const u = leaf.buildUnifiedState();
    assert.equal(u.generatedAt, null);
    assert.equal(u.daemon.running, false);
    assert.equal(u.daemon.port, null);
    assert.equal(u.bridge.clientCount, 0);
    assert.equal(u.session.state, leaf.SESSION_STATE.NONE);
    assert.equal(u.remote.activeSessionCount, 0);
    assert.equal(u.hosts.length, 0);
  });
  test('clientCount=0 保留，不被 ||0 语义吞成默认（仍是 0）', () => {
    const u = leaf.buildUnifiedState({ bridge: { running: true, clientCount: 0 } });
    assert.equal(u.bridge.clientCount, 0);
  });
  test('非数组 hosts/active_sessions 收敛为空', () => {
    const u = leaf.buildUnifiedState({ hosts: 'nope', remoteSnapshot: { active_remote_sessions: 5 } });
    assert.equal(u.hosts.length, 0);
    assert.equal(u.remote.activeSessionCount, 0);
    assert.equal(u.session.state, leaf.SESSION_STATE.NONE);
  });
});

describe('remoteDevState — discoverabilityReport', () => {
  test('固定 9 行、每行都有 label/env', () => {
    const rows = leaf.discoverabilityReport({});
    assert.equal(rows.length, 9);
    for (const r of rows) {
      assert.equal(typeof r.label, 'string');
      assert.equal(typeof r.env, 'string');
      assert.ok(r.label.length > 0 && r.env.length > 0);
    }
  });
  test('未设值渲染 null；端口 0 渲染 "0"', () => {
    const rows = leaf.discoverabilityReport({ daemonPort: 0, bridgePinSet: false, allowlist: [] });
    const port = rows.find((r) => r.env === 'KHY_DAEMON_PORT');
    assert.equal(port.value, '0');
    const pin = rows.find((r) => r.env === 'BRIDGE_PIN');
    assert.equal(pin.value, null);
    const wl = rows.find((r) => r.env === 'KHY_REMOTE_SSH_ALLOWLIST');
    assert.equal(wl.value, null);
  });
  test('allowlist 非数组/空 → null；非空 → 逗号连接', () => {
    assert.equal(leaf.discoverabilityReport({ allowlist: 'x' }).find((r) => r.env === 'KHY_REMOTE_SSH_ALLOWLIST').value, null);
    const r = leaf.discoverabilityReport({ allowlist: ['a', 'b'] });
    assert.equal(r.find((x) => x.env === 'KHY_REMOTE_SSH_ALLOWLIST').value, 'a, b');
  });
  test('execEnabled/persistEnabled 渲染开关文案', () => {
    const r = leaf.discoverabilityReport({ execEnabled: true, persistEnabled: false });
    assert.equal(r.find((x) => x.env === 'KHY_REMOTE_SSH_ENABLE_EXEC').value, 'enabled');
    assert.equal(r.find((x) => x.env === 'KHY_REMOTE_SSH_PERSIST_STATE').value, 'disabled');
    const r2 = leaf.discoverabilityReport({});
    assert.equal(r2.find((x) => x.env === 'KHY_REMOTE_SSH_ENABLE_EXEC').value, 'disabled (dry-run)');
  });
  test('config 传 null/垃圾不抛', () => {
    assert.equal(leaf.discoverabilityReport(null).length, 9);
    assert.equal(leaf.discoverabilityReport('x').length, 9);
  });
});

describe('remoteDevState — summarizeConnection', () => {
  test('无 connectionId → 未连接文案', () => {
    assert.match(leaf.summarizeConnection({ session: {} }), /未连接/);
    assert.match(leaf.summarizeConnection(), /未连接/);
    assert.match(leaf.summarizeConnection({ session: { state: leaf.SESSION_STATE.NONE, connectionId: 'x' } }), /未连接/);
  });
  test('活动会话一行含 host/alias/user/port/workspace/cid', () => {
    const line = leaf.summarizeConnection({
      session: {
        connectionId: 'abcdef12345',
        state: leaf.SESSION_STATE.LIVE,
        host: 'h',
        hostAlias: 'al',
        remoteUser: 'u',
        port: 22,
        remoteWorkspace: '/ws',
      },
    });
    assert.match(line, /al → /);
    assert.match(line, /u@h:22/);
    assert.match(line, /工作目录 \/ws/);
    assert.match(line, /会话 abcdef12/);
    assert.match(line, /（活动）/);
  });
  test('RECOVERABLE 标注可恢复；别名与主机相同不重复渲染', () => {
    const line = leaf.summarizeConnection({
      session: { connectionId: 'cid123456', state: leaf.SESSION_STATE.RECOVERABLE, host: 'h', hostAlias: 'h' },
    });
    assert.match(line, /元数据可恢复/);
    assert.equal(line.includes(' → '), false);
    assert.match(line, /工作目录 ~/); // workspace 缺省
  });
  test('connectionId 短于 8 字符不越界', () => {
    const line = leaf.summarizeConnection({ session: { connectionId: 'ab', state: leaf.SESSION_STATE.LIVE, host: 'h' } });
    assert.match(line, /会话 ab$/);
  });
});
