'use strict';

// Co-located contract tests for index.js (WebFrontendEvalService facade).
// The facade's three collaborators (taskStore / trajectoryPackager / qcEngine) and the
// heavy '@khy/shared/models' barrel are stubbed through require.cache, so this suite
// asserts only what the facade DECIDES: which store call it makes with what payload.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const MODELS_ID = require.resolve('@khy/shared/models');
const STORE_ID = require.resolve('./taskStore');
const PACKAGER_ID = require.resolve('./trajectoryPackager');
const QC_ID = require.resolve('./qcEngine');

const log = [];
const ctl = {
  task: { success: true, data: { id: 1, status: 'active' } },
  run: { success: true, data: { id: 9, task_id: 1, package_path: '/pkg' } },
  create: { success: true, data: { id: 55 } },
  update: { success: true, data: {} },
  validation: { valid: true, missing: [] },
  qc: { passed: true, score: 0.9, verdict: 'pass', defects: [] },
  zipResult: '/pkg.zip',
  zipErr: null,
};

function rec(name) {
  return (...args) => {
    log.push({ call: name, args });
    const last = log[log.length - 1];
    if (name === 'store.getTask') return Promise.resolve(ctl.task);
    if (name === 'store.getRun') return Promise.resolve(ctl.run);
    if (name === 'store.createTask') return Promise.resolve(ctl.create);
    if (name === 'store.updateTask') return Promise.resolve({ success: true, data: { id: 1 } });
    if (name === 'store.updateRun') return Promise.resolve(ctl.update);
    if (name === 'store.deleteTask') return Promise.resolve({ success: true });
    if (name === 'store.createRun') return Promise.resolve({ success: true, data: { id: 77 } });
    if (name === 'store.listTasks') return Promise.resolve({ success: true, data: { tasks: [] } });
    if (name === 'store.listRuns') return Promise.resolve({ success: true, data: { runs: [] } });
    if (name === 'store.getStats') return Promise.resolve({ success: true, data: { runs: {} } });
    if (name === 'packager.validateStructure') return ctl.validation;
    if (name === 'packager.generateManifest') return { v: 1, package: { apiCallCount: 2 } };
    if (name === 'packager.writeManifest') return null;
    if (name === 'packager.zipPackage') {
      if (ctl.zipErr) throw ctl.zipErr;
      return ctl.zipResult;
    }
    if (name === 'qc.runQC') return ctl.qc;
    last.unhandled = true;
    return undefined;
  };
}

const storeStub = {};
for (const m of ['listTasks', 'getTask', 'createTask', 'updateTask', 'deleteTask',
  'createRun', 'getRun', 'listRuns', 'updateRun', 'getStats']) {
  storeStub[m] = rec(`store.${m}`);
}
const packagerStub = {
  validateStructure: rec('packager.validateStructure'),
  generateManifest: rec('packager.generateManifest'),
  writeManifest: rec('packager.writeManifest'),
  zipPackage: rec('packager.zipPackage'),
};
const qcStub = { runQC: rec('qc.runQC') };

const prev = {
  [MODELS_ID]: require.cache[MODELS_ID],
  [STORE_ID]: require.cache[STORE_ID],
  [PACKAGER_ID]: require.cache[PACKAGER_ID],
  [QC_ID]: require.cache[QC_ID],
};
require.cache[MODELS_ID] = {
  id: MODELS_ID, filename: MODELS_ID, loaded: true,
  exports: { WebFrontendEvalTask: {}, WebFrontendEvalRun: {}, sequelize: {} }, children: [], paths: [],
};
require.cache[STORE_ID] = { id: STORE_ID, filename: STORE_ID, loaded: true, exports: storeStub, children: [], paths: [] };
require.cache[PACKAGER_ID] = {
  id: PACKAGER_ID, filename: PACKAGER_ID, loaded: true, exports: packagerStub, children: [], paths: [],
};
require.cache[QC_ID] = { id: QC_ID, filename: QC_ID, loaded: true, exports: qcStub, children: [], paths: [] };

const svc = require('./index');

after(() => {
  for (const id of Object.keys(prev)) {
    if (prev[id]) require.cache[id] = prev[id]; else delete require.cache[id];
  }
});

function reset() {
  log.length = 0;
  ctl.task = { success: true, data: { id: 1, status: 'active' } };
  ctl.run = { success: true, data: { id: 9, task_id: 1, package_path: '/pkg' } };
  ctl.create = { success: true, data: { id: 55 } };
  ctl.update = { success: true, data: {} };
  ctl.validation = { valid: true, missing: [] };
  ctl.qc = { passed: true, score: 0.9, verdict: 'pass', defects: [] };
  ctl.zipResult = '/pkg.zip';
  ctl.zipErr = null;
}

function callsOf(name) {
  return log.filter((e) => e.call === name);
}

test('任务 CRUD 逐方法透传给本地 taskStore（不是 guiEval 的那一份）', async () => {
  reset();
  await svc.listTasks({ page: 2 });
  await svc.getTask(3);
  await svc.deleteTask(4);
  await svc.getRun(5);
  await svc.listRuns({ status: 'reviewing' });
  await svc.getStats();
  assert.deepEqual(log.map((e) => [e.call, e.args]), [
    ['store.listTasks', [{ page: 2 }]],
    ['store.getTask', [3]],
    ['store.deleteTask', [4]],
    ['store.getRun', [5]],
    ['store.listRuns', [{ status: 'reviewing' }]],
    ['store.getStats', []],
  ]);
});

test('KNOWN-DEFECT: createTask 漏 await，写后回读（getTask）从不发生', async () => {
  reset();
  const r = await svc.createTask({ name: 'x' });
  // index.js:34 `const result = taskStore.createTask(data)` 拿到的是 Promise：
  // result.success 恒 undefined → 走 `return result` 分支 → :38 的 getTask 回读永远不执行。
  // 调用方拿到的是 create 的裸返回值（没有 runs 关联、没有服务端默认列），而不是文档承诺的新任务。
  assert.equal(callsOf('store.createTask').length, 1);
  assert.equal(callsOf('store.getTask').length, 0);
  assert.deepEqual(r, ctl.create);
});

test('KNOWN-DEFECT: updateTask 同样漏 await，改后回读被静默跳过', async () => {
  reset();
  const r = await svc.updateTask(1, { name: 'y' });
  assert.equal(callsOf('store.updateTask').length, 1);
  assert.equal(callsOf('store.getTask').length, 0);
  assert.deepEqual(r, { success: true, data: { id: 1 } });
});

test('createTask 失败时把失败信封原样交回（不经回读）', async () => {
  reset();
  storeStub.createTask = () => Promise.resolve({ success: false, message: 'name required' });
  const r = await svc.createTask({});
  assert.deepEqual(r, { success: false, message: 'name required' });
  storeStub.createTask = rec('store.createTask');
});

test('startRun：任务不存在 / 状态不对都短路，绝不建 run', async () => {
  reset();
  ctl.task = { success: false, message: 'db down' };
  assert.deepEqual(await svc.startRun(1), { success: false, message: 'db down' });
  assert.equal(callsOf('store.createRun').length, 0);

  reset();
  ctl.task = { success: true, data: null };
  assert.deepEqual(await svc.startRun(404), { success: false, message: 'Task not found' });
  assert.equal(callsOf('store.createRun').length, 0);

  reset();
  ctl.task = { success: true, data: { id: 2, status: 'archived' } };
  const r = await svc.startRun(2);
  assert.equal(r.success, false);
  assert.equal(r.message, 'Task status is "archived", cannot start');
  assert.equal(callsOf('store.createRun').length, 0);
});

test('startRun：active 任务建 run 的载荷是固定形状（缺省 aiModel=null / annotatorId=0）', async () => {
  reset();
  const r = await svc.startRun(1, { aiModel: 'claude', annotatorId: 8 });
  assert.deepEqual(r, { success: true, data: { id: 77 } });
  assert.deepEqual(callsOf('store.createRun')[0].args[0], {
    task_id: 1, ai_model: 'claude', annotator_id: 8, status: 'annotating', api_call_rounds: 0,
  });

  reset();
  await svc.startRun(1);
  assert.deepEqual(callsOf('store.createRun')[0].args[0], {
    task_id: 1, ai_model: null, annotator_id: 0, status: 'annotating', api_call_rounds: 0,
  });
});

test('startRun 传 opts=null 直接抛（默认参数只挡 undefined）', async () => {
  reset();
  await assert.rejects(() => svc.startRun(1, null), /Cannot read properties of null/);
});

test('assemblePackage：run/task 缺失、无 package_path 各有专属文案', async () => {
  reset();
  ctl.run = { success: false, message: 'run db down' };
  assert.deepEqual(await svc.assemblePackage(9), { success: false, message: 'run db down' });

  reset();
  ctl.run = { success: true, data: null };
  assert.deepEqual(await svc.assemblePackage(9), { success: false, message: 'Run not found' });

  reset();
  ctl.task = { success: false, message: 'task db down' };
  assert.deepEqual(await svc.assemblePackage(9), { success: false, message: 'task db down' });

  reset();
  ctl.run = { success: true, data: { id: 9, task_id: 1, package_path: '' } };
  assert.deepEqual(await svc.assemblePackage(9), {
    success: false, message: 'Run has no package_path set',
  });
  assert.equal(callsOf('packager.validateStructure').length, 0);
});

test('assemblePackage：结构不合法时报出缺失项且不再跑 QC / 不写 manifest', async () => {
  reset();
  ctl.validation = { valid: false, missing: ['qc/', 'env/'] };
  const r = await svc.assemblePackage(9);
  assert.equal(r.success, false);
  assert.equal(r.message, 'Package structure invalid: qc/, env/');
  assert.equal(callsOf('packager.generateManifest').length, 0);
  assert.equal(callsOf('qc.runQC').length, 0);
  assert.equal(callsOf('store.updateRun').length, 0);
});

test('KNOWN-DEFECT: 校验结果缺 missing 数组时门面直接崩溃（Promise reject 而非结构化失败）', async () => {
  reset();
  ctl.validation = { valid: false };
  // index.js:119 无条件 `validation.missing.join(', ')`；packager 的契约返回的是
  // {valid, missing}，但任何返回 {valid:false} 的实现（含 validateStructure 抛错前的
  // 半成品）都会把这层门面炸成 unhandled rejection，API 侧收到 500 而不是 400 文案。
  await assert.rejects(() => svc.assemblePackage(9), /validation\.missing\.join|Cannot read properties/);
});

test('assemblePackage：QC 通过 → reviewing，QC 不过 → rejected，两者都写 qc_score', async () => {
  reset();
  const ok = await svc.assemblePackage(9);
  assert.equal(ok.success, true);
  assert.deepEqual(ok.data.qcResult, ctl.qc);
  assert.deepEqual(callsOf('store.updateRun')[0].args, [9, {
    status: 'reviewing', qc_result: ctl.qc, qc_score: 0.9,
  }]);

  reset();
  ctl.qc = { passed: false, score: 0.2, verdict: 'fail', defects: [{ key: 'x' }] };
  const bad = await svc.assemblePackage(9);
  assert.equal(callsOf('store.updateRun')[0].args[1].status, 'rejected');
  assert.equal(bad.success, true);
  assert.equal(bad.data.qcResult.score, 0.2);
  // 注意：qcResult.verdict==='needs_rework'（passed:true）时状态同样落 'reviewing'，
  // 门面只看 passed 位，从不读 verdict —— 需要返工的包与完美包在库里无法区分。
});

test('completeRun：先改状态再压包，压缩失败被吞但仍回写 zip 路径', async () => {
  reset();
  const r = await svc.completeRun(9, { totalDuration: 120, notes: 'ok' });
  assert.deepEqual(r, { success: true });
  assert.deepEqual(callsOf('store.updateRun')[0].args, [9, {
    status: 'completed', delivered_at: callsOf('store.updateRun')[0].args[1].delivered_at,
    total_duration: 120, notes: 'ok',
  }]);
  assert.equal(callsOf('packager.zipPackage')[0].args[0], '/pkg');
  assert.deepEqual(callsOf('store.updateRun')[1].args[1], {
    package_zipped: true, package_path: '/pkg.zip',
  });

  reset();
  ctl.zipErr = new Error('powershell missing');
  const zipped = await svc.completeRun(9);
  assert.deepEqual(zipped, { success: true }); // 压缩失败对用户不可见
  assert.equal(callsOf('store.updateRun').length, 1);
});

test('KNOWN-DEFECT: completeRun 的 totalDuration=0 被真值门改写成 null（合法 0 落不成盘）', async () => {
  reset();
  await svc.completeRun(9, { totalDuration: 0, notes: '' });
  const payload = callsOf('store.updateRun')[0].args[1];
  // index.js:148-149 —— `opts.totalDuration || null`：0 秒/空备注这类合法值被吞成 null，
  // 库里记的是「未知时长」而不是「0」。错值直接落盘。
  assert.equal(payload.total_duration, null);
  assert.equal(payload.notes, null);
});

test('completeRun 状态更新失败即短路，绝不压包', async () => {
  reset();
  ctl.update = { success: false, message: 'locked row' };
  const r = await svc.completeRun(9);
  assert.deepEqual(r, { success: false, message: 'locked row' });
  assert.equal(callsOf('packager.zipPackage').length, 0);
});

test('rejectRun / submitSelfCheck 的载荷形状与缺省文案', async () => {
  reset();
  await svc.rejectRun(9, '截图不足');
  assert.deepEqual(callsOf('store.updateRun')[0].args[1], {
    status: 'rejected', rejection_reason: '截图不足',
  });
  reset();
  await svc.rejectRun(9);
  assert.equal(callsOf('store.updateRun')[0].args[1].rejection_reason, '未通过 QC');
  reset();
  await svc.rejectRun(9, '');
  assert.equal(callsOf('store.updateRun')[0].args[1].rejection_reason, '未通过 QC');

  reset();
  await svc.submitSelfCheck(9, { items: 3 });
  assert.deepEqual(callsOf('store.updateRun')[0].args[1], { self_check: { items: 3 }, status: 'reviewing' });
});

test('KNOWN-DEFECT: submitSelfCheck(null) 仍把 run 推进到 reviewing（自检位形同虚设）', async () => {
  reset();
  const r = await svc.submitSelfCheck(9, null);
  assert.equal(callsOf('store.updateRun')[0].args[1].self_check, null);
  assert.equal(callsOf('store.updateRun')[0].args[1].status, 'reviewing');
  assert.equal(r.success, true);
  // index.js:182-185 —— 空载荷也能把状态推进到「待审核」，而 qcEngine 读的是磁盘上的
  // qc/self_check.md，两者无一致性校验：库里 reviewing 的 run 可能一个自检字节都没有。
});

test('门面自身不做参数校验：svc.getTask()/assemblePackage() 把 undefined 交给 store', async () => {
  reset();
  await svc.getTask();
  assert.deepEqual(callsOf('store.getTask')[0].args, [undefined]);
  reset();
  ctl.run = { success: true, data: { id: undefined, task_id: 1, package_path: '/pkg' } };
  const r = await svc.assemblePackage();
  assert.equal(callsOf('store.updateRun')[0].args[0], undefined);
  assert.equal(r.success, true);
});

test('getStats 原样透传（不做形状修饰）', async () => {
  reset();
  assert.deepEqual(await svc.getStats(), { success: true, data: { runs: {} } });
});
