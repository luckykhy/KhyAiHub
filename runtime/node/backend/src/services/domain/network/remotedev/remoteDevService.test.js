'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('./remoteDevService');

// remoteDevService is a thin orchestration shell: every collaborator is
// injectable via opts, so the real daemon/bridge/ssh/store are never touched.

function makeRemote(overrides = {}) {
  const o = overrides;
  return {
    sshConfigService: {
      getConfigPath: () => o.sshConfigPath || '/home/u/.ssh/config',
      listHosts: o.listHosts || (() => ({ configPath: '/cfg', hosts: [] })),
    },
    remoteStatePersistence: {
      getStatePath: () => o.statePath || '/data/state.json',
    },
    remoteStateSyncService: {
      getSnapshot: o.getSnapshot || (() => ({ active_remote_sessions: [], pending_remote_approvals: [] })),
    },
    sshCredentialGuard: {
      validateHostCredentials:
        o.validateHostCredentials ||
        ((h) => ({ ok: true })),
    },
    remoteWorkspaceResolver: {
      resolveWorkspace: o.resolveWorkspace || (() => o.workspace || '/remote/ws'),
    },
    sshConnectionManager: {
      connect: o.connect || ((a) => ({ connectionId: 'cid', hostAlias: a.hostEntry.alias, host: a.hostEntry.host, port: a.hostEntry.port, workspace: a.workspace })),
      clearAll: o.clearAll || (() => {}),
    },
  };
}

function makeStore(desc = null) {
  const writes = [];
  return {
    _writes: writes,
    readPointer: () => desc,
    writePointer: (d) => {
      writes.push(d);
      return d;
    },
    clearPointer: () => true,
  };
}

describe('remoteDevService — isEnabled', () => {
  test('默认开，仅 KHY_REMOTEDEV==="0" 关闭', () => {
    assert.equal(svc.isEnabled({}), true);
    assert.equal(svc.isEnabled({ KHY_REMOTEDEV: '0' }), false);
    assert.equal(svc.isEnabled({ KHY_REMOTEDEV: '1' }), true);
    assert.equal(svc.isEnabled({ KHY_REMOTEDEV: 'false' }), true); // 只认 '0'
    assert.equal(svc.isEnabled(undefined), true);
  });
});

describe('remoteDevService — resolveConfig', () => {
  test('端口优先取活动值，回落 env，绝不造字面量', () => {
    const deps = { remote: makeRemote(), env: { KHY_DAEMON_PORT: '9999', BRIDGE_PORT: '8888' } };
    const c = svc.resolveConfig(deps, { port: 3000 }, { url: 'http://x:1234' });
    assert.equal(c.daemonPort, 3000); // live wins
    assert.equal(c.bridgePort, 1234); // from url
    assert.equal(c.sshConfigPath, '/home/u/.ssh/config');
    assert.equal(c.statePath, '/data/state.json');
  });
  test('无活动端口时用 env；env 也空则 null', () => {
    const deps = { remote: makeRemote(), env: { KHY_DAEMON_PORT: '9999' } };
    const c = svc.resolveConfig(deps, {}, {});
    assert.equal(c.daemonPort, '9999');
    assert.equal(c.bridgePort, null);
  });
  test('空 env 串视为未设', () => {
    const deps = { remote: makeRemote(), env: { KHY_DAEMON_PORT: '', BRIDGE_PORT: '' } };
    const c = svc.resolveConfig(deps, {}, {});
    assert.equal(c.daemonPort, null);
    assert.equal(c.bridgePort, null);
  });
  test('allowlist/workspace 逗号列表切分并去空', () => {
    const deps = { remote: makeRemote(), env: { KHY_REMOTE_SSH_ALLOWLIST: 'a, ,b,,', KHY_REMOTE_WORKSPACE_ALLOWLIST: '/x' } };
    const c = svc.resolveConfig(deps, {}, {});
    assert.deepStrictEqual(c.allowlist, ['a', 'b']);
    assert.deepStrictEqual(c.workspaceAllowlist, ['/x']);
  });
  test('exec/persist 仅 "1"/"true" 为真', () => {
    const yes = svc.resolveConfig({ remote: makeRemote(), env: { KHY_REMOTE_SSH_ENABLE_EXEC: 'true', KHY_REMOTE_SSH_PERSIST_STATE: '1' } }, {}, {});
    assert.equal(yes.execEnabled, true);
    assert.equal(yes.persistEnabled, true);
    const no = svc.resolveConfig({ remote: makeRemote(), env: { KHY_REMOTE_SSH_ENABLE_EXEC: 'yes' } }, {}, {});
    assert.equal(no.execEnabled, false);
  });
  test('bridgePinSet 反映 env 是否非空', () => {
    assert.equal(svc.resolveConfig({ remote: makeRemote(), env: { BRIDGE_PIN: '1234' } }, {}, {}).bridgePinSet, true);
    assert.equal(svc.resolveConfig({ remote: makeRemote(), env: {} }, {}, {}).bridgePinSet, false);
  });
  test('子系统抛错时 best-effort 回落 null，不抛出', () => {
    const remote = makeRemote();
    remote.sshConfigService.getConfigPath = () => {
      throw new Error('boom');
    };
    remote.remoteStatePersistence.getStatePath = () => {
      throw new Error('boom2');
    };
    const c = svc.resolveConfig({ remote, env: {} }, {}, {});
    assert.equal(c.sshConfigPath, null);
    assert.equal(c.statePath, null);
  });
});

describe('remoteDevService — getUnifiedStatus', () => {
  test('聚合各快照折成统一模型（含指针）', async () => {
    const opts = {
      daemonManager: { daemonStatus: async () => ({ running: true, pid: 1, port: 3000, uptime: 10, health: 'ok' }) },
      bridge: { getStatusSnapshot: () => ({ running: true, url: 'http://x:9', clientCount: 1 }) },
      remote: makeRemote({ getSnapshot: () => ({ active_remote_sessions: [{ connectionId: 'cid', host: 'h' }], pending_remote_approvals: [] }) }),
      store: makeStore({ connectionId: 'cid', host: 'h' }),
      env: {},
    };
    const u = await svc.getUnifiedStatus(opts);
    assert.equal(u.daemon.running, true);
    assert.equal(u.bridge.clientCount, 1);
    assert.equal(u.session.state, 'live');
    assert.equal(u.session.connectionId, 'cid');
    assert.ok(Array.isArray(u.discoverability));
  });
  test('子系统全抛错仍产出骨架不 reject', async () => {
    const opts = {
      daemonManager: { daemonStatus: async () => { throw new Error('d'); } },
      bridge: { getStatusSnapshot: () => { throw new Error('b'); } },
      remote: (() => { const r = makeRemote(); r.remoteStateSyncService.getSnapshot = () => { throw new Error('s'); }; r.sshConfigService.listHosts = () => { throw new Error('h'); }; return r; })(),
      store: makeStore(null),
      env: {},
    };
    const u = await svc.getUnifiedStatus(opts);
    assert.equal(u.daemon.running, false);
    assert.equal(u.session.state, 'none');
  });
});

describe('remoteDevService — connect', () => {
  test('空别名 → missing_host', async () => {
    const r = await svc.connect('', { env: {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'missing_host');
  });
  test('非白名单主机 → host_not_allowed', async () => {
    const r = await svc.connect('evil', { env: { KHY_REMOTE_SSH_ALLOWLIST: 'good,other' }, remote: makeRemote() });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'host_not_allowed');
  });
  test('配置读取抛错 → config_read_failed', async () => {
    const remote = makeRemote();
    remote.sshConfigService.listHosts = () => { throw new Error('no config'); };
    const r = await svc.connect('h', { env: {}, remote, store: makeStore() });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'config_read_failed');
  });
  test('找不到主机别名 → host_not_found', async () => {
    const remote = makeRemote({ listHosts: () => ({ configPath: '/c', hosts: [{ alias: 'x' }] }) });
    const r = await svc.connect('y', { env: {}, remote, store: makeStore() });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'host_not_found');
  });
  test('凭证检查不过 → credential_invalid 并带状态', async () => {
    const remote = makeRemote({
      listHosts: () => ({ hosts: [{ alias: 'h', host: 'hh' }] }),
      validateHostCredentials: () => ({ ok: false, code: 'no_key', message: '缺私钥' }),
    });
    const r = await svc.connect('h', { env: {}, remote, store: makeStore() });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no_key');
    assert.equal(r.credentialStatus.ok, false);
  });
  test('工作目录解析抛错 → 携带 err.code', async () => {
    const remote = makeRemote({
      listHosts: () => ({ hosts: [{ alias: 'h' }] }),
      resolveWorkspace: () => { const e = new Error('bad ws'); e.code = 'ws_denied'; throw e; },
    });
    const r = await svc.connect('h', { env: {}, remote, store: makeStore() });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ws_denied');
  });
  test('connect 抛错 → connect_failed', async () => {
    const remote = makeRemote({
      listHosts: () => ({ hosts: [{ alias: 'h', host: 'hh', port: 22 }] }),
      connect: () => { throw new Error('socket refused'); },
    });
    const r = await svc.connect('h', { env: {}, remote, store: makeStore() });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'connect_failed');
  });
  test('成功：写指针 + 返回 unified/descriptor', async () => {
    const remote = makeRemote({
      listHosts: () => ({ hosts: [{ alias: 'h', host: 'hh', port: 22 }] }),
    });
    const store = makeStore();
    const opts = {
      env: {},
      remote,
      store,
      daemonManager: { daemonStatus: async () => ({ running: false }) },
      bridge: { getStatusSnapshot: () => ({ running: false }) },
    };
    const r = await svc.connect('h', opts);
    assert.equal(r.ok, true);
    assert.equal(store._writes.length, 1);
    assert.equal(store._writes[0].connectionId, 'cid');
    assert.equal(r.descriptor.host, 'hh');
    assert.ok(r.unified);
  });
  test('空 allowlist 不拦任意主机（opt-in 语义，非缺陷但钉住）', async () => {
    const remote = makeRemote({ listHosts: () => ({ hosts: [{ alias: 'anyhost' }] }) });
    const r = await svc.connect('anyhost', { env: { KHY_REMOTE_SSH_ALLOWLIST: '' }, remote, store: makeStore(), daemonManager: { daemonStatus: async () => ({ running: false }) }, bridge: { getStatusSnapshot: () => ({}) } });
    assert.equal(r.ok, true);
  });
});

describe('remoteDevService — attach', () => {
  test('指定 connectionId 且活动命中 → 刷新指针 ok', async () => {
    const remote = makeRemote({ getSnapshot: () => ({ active_remote_sessions: [{ connectionId: 'abc', host: 'h' }] }) });
    const store = makeStore();
    const opts = { env: {}, remote, store, daemonManager: { daemonStatus: async () => ({ running: false }) }, bridge: { getStatusSnapshot: () => ({}) } };
    const r = await svc.attach({ ...opts, connectionId: 'abc' });
    assert.equal(r.ok, true);
    assert.equal(r.reconciled.state, 'live');
    assert.equal(store._writes.length, 1);
  });
  test('指定 id 但注册表无 → session_not_live', async () => {
    const remote = makeRemote({ getSnapshot: () => ({ active_remote_sessions: [{ connectionId: 'x' }] }) });
    const r = await svc.attach({ env: {}, remote, store: makeStore(), connectionId: 'nope' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'session_not_live');
  });
  test('无 id 且有指针 → 复用指针', async () => {
    const remote = makeRemote({ getSnapshot: () => ({ active_remote_sessions: [{ connectionId: 'cid', host: 'h' }] }) });
    const store = makeStore({ connectionId: 'cid', host: 'h' });
    const opts = { env: {}, remote, store, daemonManager: { daemonStatus: async () => ({ running: false }) }, bridge: { getStatusSnapshot: () => ({}) } };
    const r = await svc.attach(opts);
    assert.equal(r.ok, true);
    assert.equal(r.descriptor.connectionId, 'cid');
  });
  test('无 id 无指针 → no_session', async () => {
    const remote = makeRemote();
    const r = await svc.attach({ env: {}, remote, store: makeStore(null) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no_session');
  });
  test('快照抛错仍按无活动会话处理', async () => {
    const remote = makeRemote();
    remote.remoteStateSyncService.getSnapshot = () => { throw new Error('down'); };
    const r = await svc.attach({ env: {}, remote, store: makeStore(null) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no_session');
  });
});

describe('remoteDevService — logs', () => {
  test('getLogPath 抛错 → logPath null lines 空', () => {
    const opts = { daemonManager: { getLogPath: () => { throw new Error('no daemon'); } }, env: {} };
    const r = svc.logs(opts);
    assert.equal(r.logPath, null);
    assert.deepStrictEqual(r.lines, []);
  });
  test('无 logPath → 不读文件', () => {
    const r = svc.logs({ daemonManager: { getLogPath: () => null }, env: {} });
    assert.equal(r.logPath, null);
    assert.equal(r.error, null);
  });
});

describe('remoteDevService — stop', () => {
  test('默认 scope=session 清会话与指针', async () => {
    let cleared = false;
    const remote = makeRemote({ clearAll: () => { cleared = true; } });
    const r = await svc.stop({ remote, store: makeStore(), env: {}, daemonManager: {}, bridge: {} });
    assert.equal(r.scope, 'session');
    assert.equal(cleared, true);
    assert.equal(r.bridgeStopped, false);
    assert.equal(r.daemonStopped, false);
  });
  test('非法 scope 回落 session', async () => {
    const r = await svc.stop({ scope: 'nuke', remote: makeRemote(), store: makeStore(), env: {}, daemonManager: {}, bridge: {} });
    assert.equal(r.scope, 'session');
  });
  test('scope=all 触达 bridge+daemon', async () => {
    let bridgeStopped = false;
    let daemonStopped = false;
    const r = await svc.stop({
      scope: 'all',
      remote: makeRemote(),
      store: makeStore(),
      env: {},
      bridge: { stopBridgeServer: async () => { bridgeStopped = true; } },
      daemonManager: { daemonStop: () => { daemonStopped = true; return true; } },
    });
    assert.equal(r.bridgeStopped, true);
    assert.equal(r.daemonStopped, true);
  });
  test('bridge stop 抛错被吞，bridgeStopped 保持 false', async () => {
    const r = await svc.stop({ scope: 'bridge', remote: makeRemote(), store: makeStore(), env: {}, daemonManager: {}, bridge: { stopBridgeServer: async () => { throw new Error('busy'); } } });
    assert.equal(r.bridgeStopped, false);
  });
});
