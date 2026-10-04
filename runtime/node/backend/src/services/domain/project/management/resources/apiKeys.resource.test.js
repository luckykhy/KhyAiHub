'use strict';

/**
 * apiKeys.resource.js contract tests — the manage funnel for the API key pool.
 *
 * utils/dataHome and services/apiKeyPool are replaced in require.cache (keyed by
 * their fully resolved absolute paths) before this resource is required, and the
 * originals are put back in `after`. Nothing is read from or written to the real
 * pool file: the only path the module can see is an mkdtemp scratch directory,
 * which is never populated.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const P = {
  self: require.resolve('./apiKeys.resource'),
  dataHome: require.resolve('../../../../../utils/dataHome'),
  pool: require.resolve('../../../../apiKeyPool'),
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-manage-apikeys-'));
const savedCache = {};

function stubModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

const R = {};
const calls = [];

function resetPool() {
  calls.length = 0;
  R.status = [{ provider: 'anthropic', total: 1, enabled: 1 }];
  R.addKey = 'key-1';
  R.removeKey = true;
  R.enableKey = true;
  R.disableKey = true;
  R.poolFile = path.join(TMP, 'elsewhere', 'pool.json');
}

const poolStub = {};
function installPoolStub() {
  poolStub.getAllStatus = (...a) => {
    calls.push({ fn: 'getAllStatus', args: a });
    return R.status;
  };
  poolStub.addKey = (provider, opts) => {
    calls.push({ fn: 'addKey', provider, opts });
    return typeof R.addKey === 'function' ? R.addKey(provider, opts) : R.addKey;
  };
  poolStub.removeKey = (provider, keyId) => {
    calls.push({ fn: 'removeKey', provider, keyId });
    return R.removeKey;
  };
  poolStub.enableKey = (provider, keyId) => {
    calls.push({ fn: 'enableKey', provider, keyId });
    return R.enableKey;
  };
  poolStub.disableKey = (provider, keyId) => {
    calls.push({ fn: 'disableKey', provider, keyId });
    return R.disableKey;
  };
  // The real pool resolves its own location; the contract must not need to.
  poolStub.getPoolFilePath = () => R.poolFile;
}

const dataHomeStub = { getDataHome: () => TMP };

let contract = null;
const lastCall = () => calls[calls.length - 1];

describe('management/resources/apiKeys.resource', () => {
  before(() => {
    for (const key of Object.keys(P)) {
      savedCache[key] = Object.prototype.hasOwnProperty.call(require.cache, P[key]) ? require.cache[P[key]] : undefined;
      delete require.cache[P[key]];
    }
    require.cache[P.dataHome] = stubModule(P.dataHome, dataHomeStub);
    installPoolStub();
    require.cache[P.pool] = stubModule(P.pool, poolStub);
    resetPool();
    contract = require(P.self);
  });

  after(() => {
    for (const key of Object.keys(P)) {
      if (savedCache[key]) require.cache[P[key]] = savedCache[key];
      else delete require.cache[P[key]];
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetPool();
    installPoolStub();
  });

  it('出厂契约声明：file 真源 + 五个能力 + provider/keyId 的入参 schema', () => {
    assert.equal(contract.id, 'api-keys');
    assert.equal(contract.label, 'API 密钥池');
    assert.equal(contract.source, 'file');
    assert.deepEqual(contract.capabilities, ['list', 'add', 'remove', 'enable', 'disable']);
    assert.deepEqual(Object.keys(contract.ops), ['list', 'add', 'remove', 'enable', 'disable']);
    assert.deepEqual(Object.keys(contract.schema).sort(), ['add', 'disable', 'enable', 'remove']);
    assert.deepEqual(contract.schema.remove, {
      provider: { type: 'string', required: true },
      keyId: { type: 'string', required: true },
    });
    assert.deepEqual(contract.schema.add.priority, { type: 'number', required: false });
  });

  it('契约通过 resourceContract 的真·校验', () => {
    const { validateContract } = require('../resourceContract');
    assert.deepEqual(validateContract(contract), { ok: true, errors: [] });
  });

  it('sourceDetail 由 getDataHome() 拼出 api_keys.json', () => {
    assert.equal(contract.sourceDetail, path.join(TMP, 'api_keys.json'));
  });

  it('KNOWN-DEFECT: sourceDetail 自己重拼文件名，完全不问 apiKeyPool.getPoolFilePath()', () => {
    // Measured: the pool exposes getPoolFilePath() as the authority on where the
    // keys live, but the contract ignores it and joins 'api_keys.json' onto
    // getDataHome() at load time. If the pool ever relocates (env override,
    // portable layout), the declared source silently stops matching the writes.
    assert.notEqual(contract.sourceDetail, poolStub.getPoolFilePath());
    R.poolFile = path.join(TMP, 'api_keys.json');
    assert.equal(contract.sourceDetail, poolStub.getPoolFilePath(), 'they only agree by coincidence of the literal');
  });

  it('list 把 getAllStatus() 的数组包成 { providers } 并原样透传引用', async () => {
    const r = await contract.ops.list();
    assert.equal(r.providers, R.status);
    assert.deepEqual(Object.keys(r), ['providers']);
    assert.deepEqual(calls, [{ fn: 'getAllStatus', args: [] }]);
  });

  it('list 忽略调用方传入的 args 与 ctx，也不做任何鉴权分支', async () => {
    const r = await contract.ops.list({ provider: 'anthropic' }, { source: 'web', user: 'root' });
    assert.deepEqual(r, { providers: R.status });
    assert.deepEqual(calls[0].args, [], 'the pool is asked for everything, unfiltered');
  });

  it('KNOWN-DEFECT: list 不归一化池子的异常返回，providers 可以是 null 或字符串', async () => {
    // Measured: `{ providers: apiKeyPool.getAllStatus() }` wraps whatever comes
    // back — including null, which the cron resource is equally guilty of.
    for (const junk of [null, undefined, 'oops', 0, false]) {
      R.status = junk;
      assert.deepEqual(await contract.ops.list(), { providers: junk }, `getAllStatus → ${String(junk)}`);
    }
  });

  it('getAllStatus 抛错原样上抛', async () => {
    poolStub.getAllStatus = () => {
      throw new Error('pool file corrupt');
    };
    await assert.rejects(() => contract.ops.list(), { message: 'pool file corrupt' });
  });

  it('add 先查 provider 再查 key：两句话不会串台', async () => {
    await assert.rejects(() => contract.ops.add(undefined), { message: 'provider is required' });
    await assert.rejects(() => contract.ops.add(null), { message: 'provider is required' });
    await assert.rejects(() => contract.ops.add({}), { message: 'provider is required' });
    // Both missing → the provider line wins, the key line is never reached.
    await assert.rejects(() => contract.ops.add({ key: '' }), { message: 'provider is required' });
    await assert.rejects(() => contract.ops.add({ provider: 'anthropic' }), { message: 'key is required' });
    await assert.rejects(() => contract.ops.add({ provider: 'anthropic', key: '' }), { message: 'key is required' });
    await assert.rejects(() => contract.ops.add({ provider: 0, key: 'sk-1' }), { message: 'provider is required' });
    assert.equal(calls.length, 0, 'nothing reaches the pool when a gate fires');
  });

  it('add 把 provider 作首参、其余四个字段作白名单对象转发', async () => {
    const r = await contract.ops.add({
      provider: 'anthropic',
      key: 'sk-test',
      endpoint: 'https://example.invalid/v1',
      priority: 5,
      label: 'backup',
      keyId: 'caller-chosen',
      enabled: true,
    });
    assert.deepEqual(r, { keyId: 'key-1' });
    assert.equal(calls.length, 1);
    assert.equal(lastCall().fn, 'addKey');
    assert.equal(lastCall().provider, 'anthropic');
    assert.deepEqual(Object.keys(lastCall().opts), ['key', 'endpoint', 'priority', 'label']);
    assert.deepEqual(lastCall().opts, {
      key: 'sk-test',
      endpoint: 'https://example.invalid/v1',
      priority: 5,
      label: 'backup',
    });
    assert.equal('provider' in lastCall().opts, false, 'provider is not repeated inside the options object');
    assert.equal('keyId' in lastCall().opts, false, 'a caller-chosen keyId is dropped, the pool assigns it');
  });

  it('未提供的可选字段以 undefined 键的形式传给 addKey', async () => {
    await contract.ops.add({ provider: 'p', key: 'k' });
    assert.deepEqual(Object.keys(lastCall().opts), ['key', 'endpoint', 'priority', 'label']);
    assert.equal(lastCall().opts.endpoint, undefined);
    assert.equal(lastCall().opts.priority, undefined);
    assert.equal(lastCall().opts.label, undefined);
  });

  it('KNOWN-DEFECT: provider/key 只过真值闸门，空白串与控制对象原样进池', async () => {
    // Measured: provider '   ' passes; key {} passes and is forwarded verbatim.
    await contract.ops.add({ provider: '   ', key: {} });
    assert.equal(lastCall().provider, '   ');
    assert.deepEqual(lastCall().opts.key, {});
    // Non-string truthy values survive the whole way.
    await contract.ops.add({ provider: 42, key: 7 });
    assert.equal(lastCall().provider, 42);
    assert.equal(lastCall().opts.key, 7);
  });

  it('KNOWN-DEFECT: schema 声明 priority 为 number，字符串优先级照单全收', async () => {
    await contract.ops.add({ provider: 'p', key: 'k', priority: '5' });
    assert.equal(lastCall().opts.priority, '5');
    await contract.ops.add({ provider: 'p', key: 'k', priority: NaN });
    assert.ok(Number.isNaN(lastCall().opts.priority));
  });

  it('KNOWN-DEFECT: addKey 返回 undefined 时回执是 { keyId: undefined }，键在值不在', async () => {
    // Measured: the op echoes whatever addKey yields, with no success check.
    R.addKey = undefined;
    const r = await contract.ops.add({ provider: 'p', key: 'k' });
    assert.deepEqual(r, { keyId: undefined });
    assert.equal('keyId' in r, true);
    R.addKey = null;
    assert.deepEqual(await contract.ops.add({ provider: 'p', key: 'k' }), { keyId: null });
  });

  it('addKey 抛错原样上抛，ops 不加兜底文案', async () => {
    R.addKey = () => {
      throw new Error('pool write failed');
    };
    await assert.rejects(() => contract.ops.add({ provider: 'p', key: 'k' }), { message: 'pool write failed' });
  });

  it('remove / enable / disable 必须同时给 provider 与 keyId，缺哪个都是同一句话', async () => {
    for (const op of ['remove', 'enable', 'disable']) {
      for (const args of [undefined, null, {}, { provider: 'p' }, { keyId: 'k' }, { provider: '', keyId: 'k' }, { provider: 'p', keyId: '' }, { provider: 0, keyId: 'k' }]) {
        await assert.rejects(() => contract.ops[op](args), { message: 'provider and keyId are required' }, `${op}`);
      }
    }
    assert.equal(calls.length, 0);
  });

  it('remove / enable / disable 各归各的方法，provider 与 keyId 按位转发', async () => {
    assert.deepEqual(await contract.ops.remove({ provider: 'anthropic', keyId: 'k1' }), { removed: 'k1' });
    assert.deepEqual(lastCall(), { fn: 'removeKey', provider: 'anthropic', keyId: 'k1' });
    assert.deepEqual(await contract.ops.enable({ provider: 'anthropic', keyId: 'k2' }), { enabled: 'k2' });
    assert.deepEqual(lastCall(), { fn: 'enableKey', provider: 'anthropic', keyId: 'k2' });
    assert.deepEqual(await contract.ops.disable({ provider: 'anthropic', keyId: 'k3' }), { disabled: 'k3' });
    assert.deepEqual(lastCall(), { fn: 'disableKey', provider: 'anthropic', keyId: 'k3' });
    assert.equal(calls.length, 3);
  });

  it('KNOWN-DEFECT: 三个变更操作都丢弃池子的返回值，删不存在的键也报「已删」', async () => {
    // Measured: removeKey → false still yields { removed: keyId }; the pool's
    // verdict never reaches the caller, so CLI and Web both report success for a
    // no-op. Same for enableKey / disableKey returning false or throwing nothing.
    R.removeKey = false;
    assert.deepEqual(await contract.ops.remove({ provider: 'p', keyId: 'ghost' }), { removed: 'ghost' });
    R.enableKey = false;
    assert.deepEqual(await contract.ops.enable({ provider: 'p', keyId: 'ghost' }), { enabled: 'ghost' });
    R.disableKey = undefined;
    assert.deepEqual(await contract.ops.disable({ provider: 'p', keyId: 'ghost' }), { disabled: 'ghost' });
    assert.equal(calls.length, 3, 'the pool really was asked, and really said no');
    assert.equal(lastCall().fn, 'disableKey');
  });

  it('KNOWN-DEFECT: 池子方法抛错时上抛，但抛之前键可能已经被改（无事务）', async () => {
    // Measured: removeKey throwing propagates as-is, while the sibling success
    // path above reports success without checking anything.
    poolStub.removeKey = () => {
      throw new Error('ENOENT pool file');
    };
    await assert.rejects(() => contract.ops.remove({ provider: 'p', keyId: 'k' }), { message: 'ENOENT pool file' });
  });

  it('provider/keyId 不做类型校验，非字符串原样进出并回显引用', async () => {
    const weirdKey = { id: 'k' };
    const r = await contract.ops.remove({ provider: { p: 1 }, keyId: weirdKey });
    assert.equal(r.removed, weirdKey, 'the echoed value is the caller object, not a string');
    assert.equal(lastCall().provider.p, 1);
    assert.equal(lastCall().keyId, weirdKey);
    // keyId 0 is falsy → gated out, so the numeric id never reaches the pool.
    await assert.rejects(() => contract.ops.enable({ provider: 'p', keyId: 0 }), {
      message: 'provider and keyId are required',
    });
    assert.equal(lastCall().fn, 'removeKey');
    assert.equal(calls.length, 1);
  });
});
