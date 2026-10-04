'use strict';

// Co-located tests for resourceTask.js. The task orchestrator / runtime store
// / resourceManager singletons are stubbed via require.cache BEFORE the module
// loads (all three are top-level requires), so nothing touches sqlite, the
// network, or the real resource home.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const orchId = require.resolve('../../../../tasks/largeTaskOrchestrator');
const rtId = require.resolve('../../../../tasks/largeTaskRuntimeStore');
const mgrId = require.resolve('./resourceManager');
const origOrch = require.cache[orchId];
const origRt = require.cache[rtId];
const origMgr = require.cache[mgrId];

let createManagerCalls = 0;
require.cache[orchId] = { id: orchId, filename: orchId, loaded: true, exports: { __placeholder: true } };
require.cache[rtId] = { id: rtId, filename: rtId, loaded: true, exports: { __placeholder: true } };
require.cache[mgrId] = {
  id: mgrId, filename: mgrId, loaded: true,
  exports: { createResourceManager: () => { createManagerCalls += 1; return { manifest: { resources: [] }, platform: 'none', ensure: async () => ({ status: 'missing' }), resolve: () => ({ status: 'missing' }) }; } },
};

const { createResourceTaskAdapter } = require('./resourceTask');

after(() => {
  if (origOrch === undefined) delete require.cache[orchId]; else require.cache[orchId] = origOrch;
  if (origRt === undefined) delete require.cache[rtId]; else require.cache[rtId] = origRt;
  if (origMgr === undefined) delete require.cache[mgrId]; else require.cache[mgrId] = origMgr;
});

function makeItem(over = {}) {
  return {
    id: 'rid', kind: 'runtime', version: '1.0.0',
    platforms: { 'linux-x64': { sha256: 'a'.repeat(64), sources: ['https://origin.test/rid.bin'], size: 1000, format: 'file', sentinel: null, ...over.variant } },
    ...over.item,
  };
}

function makeHarness(opts = {}) {
  const state = {
    tasks: opts.tasks || [],
    created: [],
    runCalls: [],
    updates: [],
    ensures: [],
    resolves: [],
    ctx: { signal: { orch: true }, taskId: 't1', cancelled: 0, progress: [] },
    manager: {
      manifest: { resources: [opts.item || makeItem()] },
      platform: 'linux-x64',
      ensure: async (id, ensureOptions) => {
        state.ensures.push({ id, ensureOptions });
        if (opts.onEnsure) opts.onEnsure(ensureOptions, state.ctx);
        return opts.resource || { status: 'provisioned', id, path: 'P' };
      },
      resolve: (id) => {
        state.resolves.push(id);
        return { status: 'resolved', id };
      },
    },
    orchestrator: {
      createTask: (rec) => {
        state.created.push(rec);
        if (opts.createThrows === true || opts.createThrows === 'once') throw new Error('db locked');
        const task = { id: `task-${state.created.length}`, status: 'queued', ...rec };
        state.tasks.push(task);
        return task;
      },
      runTask: async (id, fn, meta) => {
        state.runCalls.push({ id, meta });
        if (opts.runThrows) throw new Error('run refused');
        const result = await fn(state.ctx);
        return { result };
      },
    },
    runtime: {
      listTasks: (filter) => state.tasks.filter((t) => !filter || t.type === filter.type),
      getTask: (id) => state.tasks.find((t) => t.id === id) || state.tasks[0],
      updateTaskFields: (id, fields) => {
        state.updates.push({ id, fields });
        const t = state.tasks.find((x) => x.id === id) || state.tasks[0];
        if (t) Object.assign(t, fields);
      },
    },
  };
  state.ctx.ensureNotCancelled = () => { state.ctx.cancelled += 1; };
  state.ctx.reportProgress = (p) => { state.ctx.progress.push(p); };
  state.adapter = createResourceTaskAdapter({
    orchestrator: state.orchestrator,
    runtime: state.runtime,
    manager: state.manager,
  });
  return state;
}

describe('createResourceTaskAdapter 构造', () => {
  test('未注入 manager 时才创建真实 manager；注入后 createResourceManager 未被调用', () => {
    const before = createManagerCalls;
    const h = makeHarness();
    assert.ok(h.adapter);
    assert.equal(createManagerCalls, before);
  });
});

describe('fetch 任务生命周期', () => {
  test('未知资源直接 reject，不创建任务', async () => {
    const h = makeHarness();
    await assert.rejects(() => h.adapter.fetch('ghost'), /unknown resource: ghost/);
    assert.equal(h.created.length, 0);
  });

  test('排队任务走完整链路：idempotency key 与 payload 完整', async () => {
    const h = makeHarness();
    const out = await h.adapter.fetch('rid', {});
    assert.equal(h.created.length, 1);
    const rec = h.created[0];
    assert.equal(rec.type, 'resource_download');
    assert.equal(rec.idempotency_key, `resource:rid:1.0.0:linux-x64:${'a'.repeat(64)}`);
    assert.equal(rec.max_attempts, 3);
    assert.equal(rec.payload_json.total_bytes, 1000);
    assert.equal(rec.payload_json.resource_id, 'rid');
    assert.equal(out.result.status, 'provisioned');
    assert.equal(h.runCalls.length, 1);
    assert.equal(h.runCalls[0].meta.dry_run, false);
    assert.equal(h.runCalls[0].meta.idle_timeout_ms, 0);
  });

  test('maxAttempts 透传', async () => {
    const h = makeHarness();
    await h.adapter.fetch('rid', { maxAttempts: 7 });
    assert.equal(h.created[0].max_attempts, 7);
  });

  test('已成功任务短路返回 last_result，不再 run', async () => {
    const done = { id: 'done-1', type: 'resource_download', status: 'succeeded', last_result: { marker: 'X' }, idempotency_key: `resource:rid:1.0.0:linux-x64:${'a'.repeat(64)}` };
    const h = makeHarness({ tasks: [done] });
    const out = await h.adapter.fetch('rid', {});
    assert.equal(out.result, done.last_result);
    assert.equal(h.runCalls.length, 0);
    assert.equal(h.created.length, 0);
    assert.equal(h.resolves.length, 0);
  });

  test('失败/取消态触发重建；运行中态不重跑只 resolve', async () => {
    const failed = { id: 'f1', type: 'resource_download', status: 'failed', idempotency_key: 'k1' };
    const h = makeHarness({ tasks: [failed] });
    await h.adapter.fetch('rid', {});
    assert.equal(h.created.length, 1, 'failed task must be recreated');
    const running = { id: 'r1', type: 'resource_download', status: 'running', idempotency_key: `resource:rid:1.0.0:linux-x64:${'a'.repeat(64)}` };
    const h2 = makeHarness({ tasks: [running] });
    const out2 = await h2.adapter.fetch('rid', {});
    assert.equal(h2.created.length, 0);
    assert.equal(h2.runCalls.length, 0);
    assert.deepEqual(out2.result, { status: 'resolved', id: 'rid' });
  });

  test('createTask 撞唯一约束（竞态）时回退到既有任务继续跑', async () => {
    // The catch at resourceTask.js:31-33 re-reads the task after a failed
    // create; simulate the race where the row appears only after the throw.
    const raced = { id: 'ex1', type: 'resource_download', status: 'queued', idempotency_key: `resource:rid:1.0.0:linux-x64:${'a'.repeat(64)}` };
    const h = makeHarness({ createThrows: 'once' });
    let listCount = 0;
    h.runtime.listTasks = () => { listCount += 1; return listCount === 1 ? [] : [raced]; };
    h.runtime.getTask = (id) => (id === 'ex1' ? raced : undefined);
    const out = await h.adapter.fetch('rid', {});
    assert.equal(out.task, raced);
    assert.equal(h.runCalls.length, 1);
    assert.equal(h.runCalls[0].id, 'ex1');
  });

  test('createTask 抛错且无既有任务时错误原样上抛', async () => {
    const h = makeHarness({ createThrows: true });
    await assert.rejects(() => h.adapter.fetch('rid', {}), /db locked/);
  });

  test('unsupported 平台：key 带 unsupported，total_bytes 为 null，进度不受 throttle', async () => {
    const item = makeItem({ variant: { noSources: true } });
    delete item.platforms['linux-x64'];
    const h = makeHarness({
      item,
      onEnsure: (eo) => { eo.onProgress(10, null); eo.onProgress(20, null); },
    });
    await h.adapter.fetch('rid', {});
    assert.equal(h.created[0].idempotency_key, 'resource:rid:1.0.0:linux-x64:unsupported');
    assert.equal(h.created[0].payload_json.total_bytes, null);
    assert.deepEqual(h.ctx.progress.slice(0, 2), [0, 0], 'unknown total must report 0% each time, no throttling');
  });
});

describe('fetch 进度与取消', () => {
  test('onProgress：百分比封顶 99，250ms 内的中间进度被节流，终报 100', async () => {
    const h = makeHarness({
      onEnsure: (eo) => {
        eo.onSource('https://origin.test/fallback.bin');
        eo.onProgress(100, 1000);   // first call always passes (lastUpdate=0)
        eo.onProgress(200, 1000);   // throttled (<250ms, partial)
        eo.onProgress(1500, 1000);  // passes: downloaded >= total
        eo.onProgress(300, 1000);   // throttled again
      },
    });
    await h.adapter.fetch('rid', {});
    // progress: [10, 99(capped), 100] from ctx plus final 100 before return
    assert.deepEqual(h.ctx.progress, [10, 99, 100]);
    assert.equal(h.ctx.cancelled, 2, 'ensureNotCancelled checked on each accepted progress');
    const lastPayload = h.updates[h.updates.length - 1].fields.payload_json;
    assert.equal(lastPayload.downloaded_bytes, 1500);
    assert.equal(lastPayload.total_bytes, 1000);
    assert.equal(lastPayload.source, 'https://origin.test/fallback.bin');
  });

  test('fetchOptions.onSource 回调被链接', async () => {
    const seen = [];
    const h = makeHarness({ onEnsure: (eo) => eo.onSource('https://origin.test/rid.bin') });
    await h.adapter.fetch('rid', { onSource: (s) => seen.push(s) });
    assert.deepEqual(seen, ['https://origin.test/rid.bin']);
  });

  test('ctx.signal 覆盖 fetchOptions.signal 传入 ensure，runTask meta 仍带用户 signal', async () => {
    const h = makeHarness();
    await h.adapter.fetch('rid', { signal: { user: true } });
    const passed = h.ensures[0].ensureOptions;
    assert.equal(passed.signal, h.ctx.signal, 'ensure must receive the orchestrator ctx signal (resourceTask.js:42)');
    assert.deepEqual(h.runCalls[0].meta.signal, { user: true });
  });

  test('ensure 返回 busy 时工作函数以状态错误失败上抛', async () => {
    const h = makeHarness({ resource: { status: 'busy' } });
    await assert.rejects(() => h.adapter.fetch('rid', {}), /resource fetch ended with busy/);
  });

  test('ensure 返回 failed 时透传其 error 文本', async () => {
    const h = makeHarness({ resource: { status: 'failed', error: 'SHA256 mismatch' } });
    await assert.rejects(() => h.adapter.fetch('rid', {}), /SHA256 mismatch/);
  });

  test('present 状态也视为成功', async () => {
    const h = makeHarness({ resource: { status: 'present', path: 'P' } });
    const out = await h.adapter.fetch('rid', {});
    assert.equal(out.result.status, 'present');
  });

  test('runTask 抛错原样上抛', async () => {
    const h = makeHarness({ runThrows: true });
    await assert.rejects(() => h.adapter.fetch('rid', {}), /run refused/);
  });
});

describe('KNOWN-DEFECT 钉桩', () => {
  test('KNOWN-DEFECT: 合法的 size 0 被 `&& ||` 链吞成 null', async () => {
    // resourceTask.js:28 — `total_bytes: value && value.size || null` collapses
    // a legitimate size of 0 into null (same family as `String(x || '')`).
    const item = makeItem({ variant: { size: 0 } });
    const h = makeHarness({ item });
    await h.adapter.fetch('rid', {});
    assert.equal(h.created[0].payload_json.total_bytes, null, 'defect: 0 is swallowed instead of recorded as 0');
  });
});
