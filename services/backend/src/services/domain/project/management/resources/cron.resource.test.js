'use strict';

/**
 * cron.resource.js contract tests — the manage funnel for scheduled cron jobs.
 *
 * utils/dataHome and jobs/cronScheduler are replaced in require.cache (keyed by
 * their fully resolved absolute paths) before this resource is required; the
 * resource's own sourceDetail is resolved from dataHome at load time, so a fresh
 * require is taken per env-precedence case. Everything is restored in `after`
 * and the only filesystem the module can see is an mkdtemp scratch directory —
 * no jobs file is ever created.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const P = {
  self: require.resolve('./cron.resource'),
  dataHome: require.resolve('../../../../../utils/dataHome'),
  cron: require.resolve('../../../../../jobs/cronScheduler'),
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-manage-cron-'));
const ENV_KEYS = ['KHY_CRON_JOBS_FILE', 'KHY_CRON_GROWTH_DIR'];
const savedEnv = {};
const savedCache = {};

function stubModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

const C = {};
const calls = [];

function resetScheduler() {
  calls.length = 0;
  C.jobs = [{ id: 'j1', cron: '0 * * * *', prompt: 'p' }];
  C.addResult = { id: 'new-1' };
  C.removeResult = true;
  C.enableResult = true;
  C.disableResult = false;
}

const cronStub = {};
function installCronStub() {
  cronStub.listJobs = (...a) => {
    calls.push({ fn: 'listJobs', args: a });
    return C.jobs;
  };
  cronStub.addJob = (o) => {
    calls.push({ fn: 'addJob', job: o });
    return C.addResult;
  };
  cronStub.removeJob = (id) => {
    calls.push({ fn: 'removeJob', id });
    return C.removeResult;
  };
  cronStub.enableJob = (id) => {
    calls.push({ fn: 'enableJob', id });
    return C.enableResult;
  };
  cronStub.disableJob = (id) => {
    calls.push({ fn: 'disableJob', id });
    return C.disableResult;
  };
}

const dataHomeStub = { getDataHome: () => TMP };

let contract = null;

// Fresh require of the resource under the current env, so the load-time
// sourceDetail resolution is what each case observes.
function loadFresh() {
  delete require.cache[P.self];
  return require(P.self);
}

function setEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const lastCall = () => calls[calls.length - 1];

describe('management/resources/cron.resource', () => {
  before(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    for (const key of Object.keys(P)) {
      savedCache[key] = Object.prototype.hasOwnProperty.call(require.cache, P[key]) ? require.cache[P[key]] : undefined;
      delete require.cache[P[key]];
    }
    require.cache[P.dataHome] = stubModule(P.dataHome, dataHomeStub);
    installCronStub();
    require.cache[P.cron] = stubModule(P.cron, cronStub);
    resetScheduler();
    contract = loadFresh();
  });

  after(() => {
    for (const k of ENV_KEYS) setEnv(k, savedEnv[k]);
    for (const key of Object.keys(P)) {
      if (savedCache[key]) require.cache[P[key]] = savedCache[key];
      else delete require.cache[P[key]];
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetScheduler();
    installCronStub();
    for (const k of ENV_KEYS) delete process.env[k];
    contract = loadFresh();
  });

  it('出厂契约声明：file 真源 + 五个能力 + add/remove/enable/disable 的入参 schema', () => {
    assert.equal(contract.id, 'cron');
    assert.equal(contract.label, '定时任务');
    assert.equal(contract.source, 'file');
    assert.deepEqual(contract.capabilities, ['list', 'add', 'remove', 'enable', 'disable']);
    assert.deepEqual(Object.keys(contract.ops), ['list', 'add', 'remove', 'enable', 'disable']);
    assert.deepEqual(Object.keys(contract.schema).sort(), ['add', 'disable', 'enable', 'remove']);
    assert.deepEqual(contract.schema.remove, { id: { type: 'string', required: true } });
    assert.deepEqual(contract.schema.add.cron, { type: 'string', required: true });
    assert.deepEqual(contract.schema.add.maxRuntimeMs, { type: 'number', required: false });
  });

  it('契约通过 resourceContract 的真·校验', () => {
    const { validateContract } = require('../resourceContract');
    assert.deepEqual(validateContract(contract), { ok: true, errors: [] });
  });

  it('sourceDetail 默认为 getDataHome()/growth/cron_jobs.json', () => {
    assert.equal(contract.sourceDetail, path.join(TMP, 'growth', 'cron_jobs.json'));
  });

  it('KHY_CRON_GROWTH_DIR 覆盖目录，KHY_CRON_JOBS_FILE 覆盖整条路径且优先级最高', () => {
    const dirOver = path.join(TMP, 'other-growth');
    process.env.KHY_CRON_GROWTH_DIR = dirOver;
    assert.equal(loadFresh().sourceDetail, path.join(dirOver, 'cron_jobs.json'));

    const fileOver = path.join(TMP, 'explicit.json');
    process.env.KHY_CRON_JOBS_FILE = fileOver;
    assert.equal(loadFresh().sourceDetail, fileOver, 'the explicit file wins and is not joined');

    // Measured: an empty-string override counts as "unset" (truthiness gate).
    process.env.KHY_CRON_JOBS_FILE = '';
    process.env.KHY_CRON_GROWTH_DIR = '';
    assert.equal(loadFresh().sourceDetail, path.join(TMP, 'growth', 'cron_jobs.json'));
  });

  it('list 把 cronScheduler.listJobs() 的结果包成 { jobs }', async () => {
    const r = await contract.ops.list();
    assert.equal(r.jobs, C.jobs);
    assert.deepEqual(Object.keys(r), ['jobs']);
    assert.deepEqual(calls, [{ fn: 'listJobs', args: [] }]);
  });

  it('list 接受任意参数并原样丢弃，只调一次 listJobs', async () => {
    const r = await contract.ops.list({ id: 'j1' }, { source: 'web' });
    assert.deepEqual(r, { jobs: C.jobs });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [], 'the scheduler is called with no arguments');
  });

  it('KNOWN-DEFECT: list 不归一化 listJobs 的异常返回，jobs 可以是 null 或字符串', async () => {
    // Measured: `{ jobs: cron().listJobs() }` wraps whatever comes back, so a
    // scheduler returning null yields { jobs: null } rather than { jobs: [] }.
    for (const junk of [null, undefined, 'oops', 0, false]) {
      C.jobs = junk;
      const r = await contract.ops.list();
      assert.deepEqual(r, { jobs: junk }, `listJobs → ${String(junk)}`);
    }
    // Same for a non-array, which every consumer of `jobs` would have to expect.
    C.jobs = { unexpected: 'object' };
    assert.deepEqual(await contract.ops.list(), { jobs: { unexpected: 'object' } });
  });

  it('listJobs 抛错原样上抛，不做 fail-soft', async () => {
    cronStub.listJobs = () => {
      throw new Error('jobs file corrupt');
    };
    await assert.rejects(() => contract.ops.list(), { message: 'jobs file corrupt' });
  });

  it('add 缺 cron 或 prompt 时抛同一句话，且绝不落到 cronScheduler', async () => {
    for (const args of [undefined, null, {}, { cron: '0 * * * *' }, { prompt: 'p' }, { cron: '', prompt: 'p' }, { cron: 'x', prompt: '' }, { cron: 0, prompt: 'p' }]) {
      await assert.rejects(() => contract.ops.add(args), { message: 'cron and prompt are required' });
    }
    assert.equal(calls.length, 0);
  });

  it('add 只转发 schema 声明的六个字段，未知字段被丢弃', async () => {
    const r = await contract.ops.add({
      cron: '0 * * * *',
      prompt: 'p',
      channel: 'wechat',
      noAgent: true,
      contextFrom: 'sess-1',
      maxRuntimeMs: 60000,
      id: 'caller-chosen',
      name: 'ignored',
    });
    assert.equal(r, C.addResult, 'addJob\'s return value is passed straight through');
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0].job), ['cron', 'prompt', 'channel', 'noAgent', 'contextFrom', 'maxRuntimeMs']);
    assert.deepEqual(calls[0].job, {
      cron: '0 * * * *',
      prompt: 'p',
      channel: 'wechat',
      noAgent: true,
      contextFrom: 'sess-1',
      maxRuntimeMs: 60000,
    });
  });

  it('未提供的可选字段以 undefined 键的形式照样传给 addJob', async () => {
    await contract.ops.add({ cron: 'x', prompt: 'y' });
    const job = calls[0].job;
    assert.deepEqual(Object.keys(job), ['cron', 'prompt', 'channel', 'noAgent', 'contextFrom', 'maxRuntimeMs']);
    assert.equal(job.channel, undefined);
    assert.equal(job.contextFrom, undefined);
    assert.equal(job.maxRuntimeMs, undefined);
  });

  it('KNOWN-DEFECT: noAgent 用严格 === true 收敛，字符串 "true"/1 被静默降级为「走 agent」', async () => {
    // Measured: noAgent:'true' → false, noAgent:1 → false, noAgent:'yes' → false.
    for (const truthy of ['true', 1, 'yes', {}, [1]]) {
      await contract.ops.add({ cron: 'x', prompt: 'y', noAgent: truthy });
      assert.equal(lastCall().job.noAgent, false, `noAgent=${String(truthy)} became false`);
    }
    await contract.ops.add({ cron: 'x', prompt: 'y', noAgent: false });
    assert.equal(lastCall().job.noAgent, false);
    await contract.ops.add({ cron: 'x', prompt: 'y', noAgent: undefined });
    assert.equal(lastCall().job.noAgent, false);
  });

  it('KNOWN-DEFECT: schema 声明 maxRuntimeMs 为 number，但字符串与 NaN 原样透传不校验', async () => {
    // Measured: '60000' arrives as the string '60000'; {} survives too.
    await contract.ops.add({ cron: 'x', prompt: 'y', maxRuntimeMs: '60000' });
    assert.equal(lastCall().job.maxRuntimeMs, '60000');
    await contract.ops.add({ cron: 'x', prompt: 'y', maxRuntimeMs: NaN });
    assert.ok(Number.isNaN(lastCall().job.maxRuntimeMs));
    await contract.ops.add({ cron: 'x', prompt: 'y', channel: 42 });
    assert.equal(lastCall().job.channel, 42, 'channel is declared string but unchecked');
  });

  it('addJob 返回 undefined 时 ops.add 就返回 undefined，没有任何回执', async () => {
    C.addResult = undefined;
    const r = await contract.ops.add({ cron: 'x', prompt: 'y' });
    assert.equal(r, undefined);
  });

  it('remove / enable / disable 缺 id 时抛 id is required', async () => {
    for (const op of ['remove', 'enable', 'disable']) {
      for (const args of [undefined, null, {}, { id: '' }, { id: 0 }, { jobId: 'j1' }]) {
        await assert.rejects(() => contract.ops[op](args), { message: 'id is required' }, `${op} ${String(args && args.id)}`);
      }
      assert.equal(calls.length, 0, `${op} must not reach the scheduler`);
    }
  });

  it('remove / enable / disable 各归各的方法，返回体是 { 动作: 调度器结果, id }', async () => {
    assert.deepEqual(await contract.ops.remove({ id: 'j1' }), { removed: true, id: 'j1' });
    assert.deepEqual(calls, [{ fn: 'removeJob', id: 'j1' }]);
    assert.deepEqual(await contract.ops.enable({ id: 'j2' }), { enabled: true, id: 'j2' });
    assert.deepEqual(calls[1], { fn: 'enableJob', id: 'j2' });
    assert.deepEqual(await contract.ops.disable({ id: 'j3' }), { disabled: false, id: 'j3' });
    assert.deepEqual(calls[2], { fn: 'disableJob', id: 'j3' });
  });

  it('KNOWN-DEFECT: 调度器返回 false/undefined 时回执仍带着回显的 id，看不出任务不存在', async () => {
    // Measured: disableJob → false yields { disabled: false, id } (truthful),
    // but an unscheduled removeJob returning undefined yields
    // { removed: undefined, id } — the key exists, the verdict does not.
    C.disableResult = false;
    assert.deepEqual(await contract.ops.disable({ id: 'nope' }), { disabled: false, id: 'nope' });
    C.removeResult = undefined;
    const r = await contract.ops.remove({ id: 'nope' });
    assert.deepEqual(r, { removed: undefined, id: 'nope' });
    assert.equal('removed' in r, true, 'the key is present even when the scheduler said nothing');
  });

  it('KNOWN-DEFECT: id 不做类型校验，对象/数字原样进出并回显同一个引用', async () => {
    // Measured: schema says string, ops only checks truthiness.
    const weird = { toString: () => 'j9' };
    const r = await contract.ops.remove({ id: weird });
    assert.equal(r.id, weird);
    assert.deepEqual(calls[0], { fn: 'removeJob', id: weird });
    C.enableResult = 'truthy-string';
    assert.deepEqual(await contract.ops.enable({ id: 12 }), { enabled: 'truthy-string', id: 12 });
  });

  it('KNOWN-DEFECT: sourceDetail 在 require 时被冻结，之后改环境变量只会让声明与真源背离', () => {
    // Measured: contract.sourceDetail is computed once at module load. After a
    // fresh load, changing KHY_CRON_JOBS_FILE leaves the declared source pointing
    // at the old path while cronScheduler resolves the new one on every call —
    // parityGuard's uniqueness check therefore compares a stale address.
    const before = contract.sourceDetail;
    assert.equal(before, path.join(TMP, 'growth', 'cron_jobs.json'));
    process.env.KHY_CRON_JOBS_FILE = path.join(TMP, 'elsewhere', 'jobs.json');
    assert.equal(contract.sourceDetail, before, 'the already-loaded contract does not move');
    // A genuinely new location only shows up after a reload of the resource.
    assert.equal(loadFresh().sourceDetail, path.join(TMP, 'elsewhere', 'jobs.json'));
  });
});
