'use strict';

// Co-located contract tests for taskStore.js (Sequelize CRUD for web-frontend-eval).
// '@khy/shared/models' and 'sequelize' are stubbed through require.cache: the real
// models boot SQLite (~17s) and a live DB, neither of which a unit suite may touch.
// Every value asserted below is MEASURED from the module, not restated from its source.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const MODELS_ID = require.resolve('@khy/shared/models');

// The real `sequelize` package is kept (it is only the Op symbol table — no I/O),
// because its require.resolve() id does not round-trip through require.cache.
const { Op } = require('sequelize');

const state = {
  dialect: 'sqlite',
  calls: [],
  rows: [{ id: 1, name: 'pkg-a' }],
  count: 7,
  taskById: null,
  runById: null,
  taskDestroyErr: null,
  runCreateResult: { id: 41 },
};

function mkModel(name, kind) {
  return {
    findAndCountAll: async (q) => {
      state.calls.push({ m: `${name}.findAndCountAll`, q });
      return { rows: state.rows, count: state.count };
    },
    findByPk: async (id, q) => {
      state.calls.push({ m: `${name}.findByPk`, id, q });
      if (kind === 'task') return state.taskById;
      return state.runById;
    },
    create: async (data) => {
      state.calls.push({ m: `${name}.create`, data });
      return kind === 'task' ? { id: 7, ...data } : { ...state.runCreateResult, ...data };
    },
    count: async (q) => {
      state.calls.push({ m: `${name}.count`, q });
      return 3;
    },
    destroy: async (q) => {
      state.calls.push({ m: `${name}.destroy`, q });
      if (kind === 'run' && state.runRowsErr) throw new Error('rows boom');
      return 1;
    },
  };
}

const WebFrontendEvalTask = mkModel('Task', 'task');
const WebFrontendEvalRun = mkModel('Run', 'run');

const modelsStub = {
  WebFrontendEvalTask,
  WebFrontendEvalRun,
  sequelize: { getDialect: () => state.dialect },
};

const prevModels = require.cache[MODELS_ID];
require.cache[MODELS_ID] = {
  id: MODELS_ID, filename: MODELS_ID, loaded: true, exports: modelsStub, children: [], paths: [],
};

const store = require('./taskStore');

after(() => {
  if (prevModels) require.cache[MODELS_ID] = prevModels; else delete require.cache[MODELS_ID];
});

function lastCall(prefix) {
  for (let i = state.calls.length - 1; i >= 0; i -= 1) {
    if (state.calls[i].m.startsWith(prefix)) return state.calls[i];
  }
  return null;
}

function reset() {
  state.calls.length = 0;
  state.dialect = 'sqlite';
  state.taskById = null;
  state.runById = null;
  state.taskDestroyErr = null;
  state.runRowsErr = null;
}

test('listTasks 缺省参数走 page=1 / pageSize=20 / offset=0', async () => {
  reset();
  const r = await store.listTasks();
  assert.equal(r.success, true);
  const c = lastCall('Task.findAndCountAll');
  assert.equal(c.q.limit, 20);
  assert.equal(c.q.offset, 0);
  assert.deepEqual(c.q.order, [['createdAt', 'DESC']]);
  assert.deepEqual(r.data, { tasks: state.rows, total: 7, page: 1, pageSize: 20 });
});

test('listTasks 翻页 offset = (page-1)*pageSize', async () => {
  reset();
  await store.listTasks({ page: 3, pageSize: 5 });
  assert.equal(lastCall('Task.findAndCountAll').q.offset, 10);
});

test('listTasks 把 level/category/status 原样落进 where', async () => {
  reset();
  await store.listTasks({ level: 'L3', category: '3d', status: 'active' });
  assert.deepEqual(lastCall('Task.findAndCountAll').q.where, {
    level: 'L3', category: '3d', status: 'active',
  });
});

test('listTasks 空串过滤值被当成「未提供」，where 里不留键', async () => {
  reset();
  await store.listTasks({ level: '', status: '', q: '', tag: '' });
  assert.deepEqual(lastCall('Task.findAndCountAll').q.where, {});
});

test('listTasks q：sqlite 用 Op.like，postgres 用 Op.iLike', async () => {
  reset();
  await store.listTasks({ q: 'abc' });
  let where = lastCall('Task.findAndCountAll').q.where;
  assert.deepEqual(Object.keys(where), ['name']);
  assert.equal(where.name[Op.like], '%abc%');

  reset();
  state.dialect = 'postgres';
  await store.listTasks({ q: 'Abc' });
  where = lastCall('Task.findAndCountAll').q.where;
  assert.equal(where.name[Op.iLike], '%Abc%');
  assert.equal(where.name[Op.like], undefined);
});

test('listTasks tag：postgres 走 Op.contains 数组，sqlite 走带引号的 LIKE', async () => {
  reset();
  await store.listTasks({ tag: 'react' });
  assert.equal(lastCall('Task.findAndCountAll').q.where.tags[Op.like], '%"react"%');

  reset();
  state.dialect = 'postgres';
  await store.listTasks({ tag: 'react' });
  assert.deepEqual(lastCall('Task.findAndCountAll').q.where.tags[Op.contains], ['react']);
});

test('listTasks tag 不做转义：引号/通配符可原样进入 LIKE 模式', async () => {
  reset();
  await store.listTasks({ tag: 'a"%,b' });
  // taskStore.js:46 直接把 tag 拼进 `%"${tag}"%`，SQLite 的 LIKE 里 % 是通配符：
  // 一个带 % 的 tag 会匹配到别的标签组合（宽匹配），不是注入但会返回错行。
  assert.equal(lastCall('Task.findAndCountAll').q.where.tags[Op.like], '%"a"%,b"%');
});

test('listTasks opts=null 不抛：_safeAsync 把解构失败收敛成 success:false', async () => {
  reset();
  const r = await store.listTasks(null);
  assert.equal(r.success, false);
  assert.match(r.message, /Cannot read properties of null/);
});

test('KNOWN-DEFECT: listTasks 的负数/超大 pageSize 原样透传给 limit，不做取值域收敛', async () => {
  reset();
  await store.listTasks({ pageSize: -1, page: -2 });
  const c = lastCall('Task.findAndCountAll').q;
  // pageSize:-1 → SQLite 语义是「无 LIMIT」，整表外传给调用方；
  // page:-2 → offset = (-2-1)*(-1) = 3，一个从未被请求过的偏移。
  assert.equal(c.limit, -1);
  assert.equal(c.offset, 3);
  // taskStore.js:49-55 —— page/pageSize 只做默认值，不做 >0 校验即交给 findAndCountAll。
});

test('getTask 带上 runs 关联（limit 20、倒序），并把 findByPk 结果透传', async () => {
  reset();
  state.taskById = { id: 9, name: 't' };
  const r = await store.getTask(9);
  assert.equal(r.data, state.taskById);
  const c = lastCall('Task.findByPk');
  assert.equal(c.id, 9);
  assert.deepEqual(c.q.include, [
    { model: WebFrontendEvalRun, as: 'runs', limit: 20, order: [['createdAt', 'DESC']] },
  ]);
});

test('getTask 未命中返回 success:true / data:null（不是 success:false）', async () => {
  reset();
  state.taskById = null;
  const r = await store.getTask(404);
  assert.equal(r.success, true);
  assert.equal(r.data, null);
});

test('createTask 把 data 逐字节交给 Model.create（无字段白名单、无默认值）', async () => {
  reset();
  const payload = { name: 'x', level: 'L9', injection: { $where: '1=1' } };
  const r = await store.createTask(payload);
  assert.equal(r.success, true);
  assert.equal(lastCall('Task.create').data, payload);
  assert.deepEqual(r.data.injection, { $where: '1=1' });
});

test('updateTask 未命中 → success:false + Task not found；命中则 update(data)', async () => {
  reset();
  state.taskById = null;
  const miss = await store.updateTask(1, { name: 'a' });
  assert.equal(miss.success, false);
  assert.equal(miss.message, 'Task not found');

  reset();
  const updates = [];
  state.taskById = { id: 1, update: async (d) => { updates.push(d); } };
  const hit = await store.updateTask(1, { name: 'b' });
  assert.equal(hit.success, true);
  assert.deepEqual(updates, [{ name: 'b' }]);
});

test('deleteTask 先清 Run 再删 Task，条件锁在 task_id', async () => {
  reset();
  state.taskById = { id: 5, destroy: async () => state.calls.push({ m: 'task.destroy' }) };
  const r = await store.deleteTask(5);
  assert.equal(r.success, true);
  const order = state.calls.map((c) => c.m);
  assert.deepEqual(order, ['Task.findByPk', 'Run.destroy', 'task.destroy']);
  assert.deepEqual(lastCall('Run.destroy').q.where, { task_id: 5 });
});

test('KNOWN-DEFECT: deleteTask 删子 Run 成功后若 Task.destroy 抛错，子记录已不可恢复（半删）', async () => {
  reset();
  state.taskById = { id: 6, destroy: async () => { throw new Error('fk violation'); } };
  const r = await store.deleteTask(6);
  assert.equal(r.success, false);
  assert.equal(r.message, 'fk violation');
  // taskStore.js:85-94 —— Run.destroy 已执行、task.destroy 失败，无事务包裹：
  // 该 task 的标注记录已物理消失，而重试删除仍会失败，用户被卡在「删不掉的空任务」上。
  assert.ok(lastCall('Run.destroy'), 'Run.destroy 已经被调用（子记录已丢）');
});

test('createRun / getRun：Run 关联 task 时只带 4 个展示字段', async () => {
  reset();
  await store.createRun({ task_id: 3, status: 'annotating' });
  assert.deepEqual(lastCall('Run.create').data, { task_id: 3, status: 'annotating' });

  reset();
  state.runById = { id: 41 };
  const r = await store.getRun(41);
  assert.equal(r.data.id, 41);
  assert.deepEqual(lastCall('Run.findByPk').q.include[0].attributes, [
    'id', 'name', 'level', 'category',
  ]);
});

test('updateRun 未命中 → Run not found；命中则写回并返回实例', async () => {
  reset();
  assert.equal((await store.updateRun(99, { status: 'x' })).message, 'Run not found');
  reset();
  const seen = [];
  state.runById = { id: 3, update: async (d) => seen.push(d) };
  const ok = await store.updateRun(3, { qc_score: 0.9 });
  assert.equal(ok.success, true);
  assert.deepEqual(seen, [{ qc_score: 0.9 }]);
});

test('listRuns 组合过滤：status/taskId 落 where，倒序 + 分页', async () => {
  reset();
  const r = await store.listRuns({ status: 'reviewing', taskId: 12, page: 2, pageSize: 3 });
  const c = lastCall('Run.findAndCountAll').q;
  assert.deepEqual(c.where, { status: 'reviewing', task_id: 12 });
  assert.equal(c.offset, 3);
  assert.equal(c.limit, 3);
  assert.equal(r.data.total, 7);
});

test('KNOWN-DEFECT: listRuns 的 annotatorId=0 被真值门吞掉，无法筛出默认标注员', async () => {
  reset();
  await store.listRuns({ annotatorId: 0 });
  const c = lastCall('Run.findAndCountAll').q;
  // taskStore.js:137-139 用 `if (annotatorId)`，而 webFrontendEval/index.js:76 恰恰把
  // 未指定标注员的 run 写成 annotator_id: 0 —— 于是「只看默认标注员的 run」这条查询
  // 返回的是全体 run（跨标注员串数据），过滤条件静默失效。
  assert.equal(c.where.annotator_id, undefined);
  assert.deepEqual(c.where, {});
});

test('getStats 发 6 个 count 并按 run/task 两组归形', async () => {
  reset();
  const r = await store.getStats();
  assert.deepEqual(r.data, {
    runs: { total: 3, annotating: 3, completed: 3, rejected: 3 },
    tasks: { total: 3, active: 3 },
  });
  const counts = state.calls.filter((c) => c.m.endsWith('.count'));
  assert.equal(counts.length, 6);
  assert.deepEqual(counts.map((c) => [c.m, c.q && c.q.where]).slice(1), [
    ['Run.count', { status: 'annotating' }],
    ['Run.count', { status: 'completed' }],
    ['Run.count', { status: 'rejected' }],
    ['Task.count', undefined],
    ['Task.count', { status: 'active' }],
  ]);
});

test('_safeAsync 对空 message / 非 Error 抛出统一收敛为 Operation failed', async () => {
  reset();
  WebFrontendEvalTask.findByPk = async () => { throw new Error(''); };
  const empty = await store.getTask(1);
  assert.deepEqual(empty, { success: false, message: 'Operation failed' });

  reset();
  WebFrontendEvalRun.create = async () => { throw 'just a string'; };
  const str = await store.createRun({});
  assert.equal(str.success, false);
  assert.equal(str.message, 'Operation failed');

  reset();
  WebFrontendEvalTask.findByPk = async () => { throw { message: 0 }; };
  assert.equal((await store.getTask(1)).message, 'Operation failed');

  // restore for any later suite in this process
  WebFrontendEvalTask.findByPk = mkModel('Task', 'task').findByPk;
  WebFrontendEvalRun.create = mkModel('Run', 'run').create;
});

test('垃圾入参不污染模型：getTask/listRuns 收到对象/数组时原样交给 findByPk', async () => {
  reset();
  await store.getTask({ id: 1 });
  assert.deepEqual(lastCall('Task.findByPk').id, { id: 1 });
  reset();
  await store.listRuns([]);
  // [] 解构不到 page → 走默认值，where 为空
  assert.deepEqual(lastCall('Run.findAndCountAll').q.where, {});
});
