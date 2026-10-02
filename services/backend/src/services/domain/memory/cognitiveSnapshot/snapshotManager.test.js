'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sm = require('./snapshotManager.js');

const { SNAPSHOT_VERSION, STATUS, build, persist, load, markComplete, hotStart, formatInjection } = sm;

const DATA_HOME = require.resolve('../../../../utils/dataHome.js');
let tmpRoot = '';
let savedDataHome = null;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b45e-'));
  savedDataHome = require.cache[DATA_HOME];
  require.cache[DATA_HOME] = {
    id: DATA_HOME,
    filename: DATA_HOME,
    loaded: true,
    exports: { getProjectDataDir: () => tmpRoot },
  };
});

after(() => {
  if (savedDataHome) require.cache[DATA_HOME] = savedDataHome;
  else delete require.cache[DATA_HOME];
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const minimal = () => ({ taskId: 'task-a', ultimateGoal: '把备份域迁完' });

describe('build 快照七要素', () => {
  test('最小输入补齐全部缺省字段并冻结版本', () => {
    const s = build(minimal());
    assert.equal(s.version, SNAPSHOT_VERSION);
    assert.equal(s.status, STATUS.ACTIVE);
    assert.equal(s.taskId, 'task-a');
    assert.equal(s.step, 0);
    assert.equal(s.ultimateGoal, '把备份域迁完');
    assert.deepEqual(s.compressedHistory, []);
    assert.equal(s.nextInstruction, '');
    assert.deepEqual(s.offloadPointers, []);
    assert.equal(s.retryCount, 0);
    assert.deepEqual(s.entities, []);
    assert.deepEqual(s.lessons, []);
    assert.equal(typeof s.timestamp, 'number');
    assert.deepEqual(Object.keys(s.constraints).sort(), ['model', 'notes', 'workspace']);
    assert.equal(s.constraints.workspace, process.cwd());
  });

  test('缺 taskId 或 ultimateGoal 直接抛（指南针不可空是硬前提）', () => {
    assert.throws(() => build(), /taskId 必填/);
    assert.throws(() => build({ taskId: 'x' }), /ultimateGoal 必填/);
    assert.throws(() => build({ ultimateGoal: 'g' }), /taskId 必填/);
    assert.throws(() => build(null), TypeError);
  });

  test('status/model/notes 覆盖生效，未知 status 原样保留', () => {
    const s = build({ ...minimal(), status: 'emergency', model: 'glm-4', notes: '演练' });
    assert.equal(s.status, 'emergency');
    assert.equal(s.constraints.model, 'glm-4');
    assert.equal(s.constraints.notes, '演练');
  });

  test('非数组的 offloadPointers / entities / lessons 一律收敛为空数组', () => {
    for (const junk of ['x', 0, {}, null, new Map()]) {
      const s = build({ ...minimal(), offloadPointers: junk, entities: junk, lessons: junk });
      assert.deepEqual(s.offloadPointers, [], JSON.stringify(junk));
      assert.deepEqual(s.entities, []);
      assert.deepEqual(s.lessons, []);
    }
  });

  test('KNOWN-DEFECT: step / retryCount 用 Number.isFinite 判串，"3" 被折成 0，进度在快照里归零', () => {
    // snapshotManager.js:72 and :77 → `Number.isFinite(input.step) ? input.step : 0`.
    // A step count that arrives as a string (env, JSON, CLI arg) is a real progress
    // value yet collapses to 0, and hotStart then replays the task from the beginning.
    const s = build({ ...minimal(), step: '3', retryCount: '2' });
    assert.equal(s.step, 0);
    assert.equal(s.retryCount, 0);
    assert.equal(build({ ...minimal(), step: 3 }).step, 3);
  });

  test('KNOWN-DEFECT: 负数与超大 step 被当成合法进度写入快照', () => {
    // snapshotManager.js:72 — Number.isFinite passes -1e21 and 1e21, so an impossible
    // progress marker is persisted as the task's authoritative state.
    assert.equal(build({ ...minimal(), step: -50 }).step, -50);
    assert.equal(build({ ...minimal(), retryCount: Number.MAX_VALUE }).retryCount, Number.MAX_VALUE);
  });

  test('KNOWN-DEFECT: 数字 0 的 taskId / ultimateGoal 被 ! 判成缺失，合法 ID 无法建快照', () => {
    // snapshotManager.js:61 and :64 use falsiness, while :71/:73 String()-ify the
    // values anyway — so taskId 0 ("the zeroth task") throws even though "0" is a
    // perfectly usable filename and goal "0" would have been accepted.
    assert.throws(() => build({ taskId: 0, ultimateGoal: 'g' }), /taskId 必填/);
    assert.throws(() => build({ taskId: 't', ultimateGoal: 0 }), /ultimateGoal 必填/);
    assert.equal(build({ taskId: '0', ultimateGoal: '0' }).taskId, '0');
  });

  test('KNOWN-DEFECT: 数组字段按引用入库，调用方后续改动直接写穿快照真源', () => {
    // snapshotManager.js:74-80 keeps the caller's arrays instead of copying them
    // (buildManifest at backupManifest.js:129-131 does slice()), so a snapshot sharing
    // state with the engine's live offloadPointers lets any consumer of the returned
    // object mutate the truth source the next persist() will serialize.
    const pointers = ['p1'];
    const s = build({ ...minimal(), offloadPointers: pointers, entities: pointers, compressedHistory: pointers });
    assert.equal(s.offloadPointers, pointers);
    pointers.push('p2');
    assert.equal(s.offloadPointers.length, 2);
    assert.equal(s.entities.length, 2);
    assert.equal(s.compressedHistory.length, 2);
  });

  test('对象带 constructor / __proto__ / toString 键时不污染快照字段判定', () => {
    const weird = JSON.parse('{"taskId":"t","ultimateGoal":"g","__proto__":{"step":99},"status":"done"}');
    const s = build(weird);
    assert.equal(s.step, 0);
    assert.equal(s.status, 'done');
    assert.equal(Object.getPrototypeOf(s), Object.prototype);
  });
});

describe('persist / load 原子落盘', () => {
  test('写成功后返回 ok+file，读回内容与写入逐字段一致', () => {
    const s = build({ ...minimal(), taskId: 'round-trip', step: 4, nextInstruction: '继续' });
    const res = persist(s);
    assert.equal(res.ok, true, String(res.error));
    assert.ok(res.file.startsWith(tmpRoot));
    assert.equal(path.basename(res.file), 'round-trip.json');
    const back = load('round-trip');
    assert.deepEqual(back, s);
    assert.equal(JSON.parse(fs.readFileSync(res.file, 'utf-8')).step, 4);
  });

  test('落盘文本是 2 空格缩进 JSON（人可读的盘上真源）', () => {
    const res = persist(build({ ...minimal(), taskId: 'pretty' }));
    const text = fs.readFileSync(res.file, 'utf-8');
    assert.equal(text, JSON.stringify(load('pretty'), null, 2));
    assert.match(text, /\n  "version": 1,/);
  });

  test('缺 taskId 的快照返回结构化失败而不是抛', () => {
    assert.deepEqual(persist(null), { ok: false, error: 'missing taskId' });
    assert.deepEqual(persist(undefined), { ok: false, error: 'missing taskId' });
    assert.deepEqual(persist({}), { ok: false, error: 'missing taskId' });
    assert.deepEqual(persist({ taskId: '' }), { ok: false, error: 'missing taskId' });
  });

  test('目标位被目录占据时 rename 失败，fail-soft 上报 error（契约：绝不抛）', () => {
    // Occupy the destination path with a directory so the final rename cannot land.
    fs.mkdirSync(path.join(tmpRoot, 'blocked.json'), { recursive: true });
    const res = persist(build({ ...minimal(), taskId: 'blocked' }));
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, 'string');
    assert.equal('file' in res, false);
    assert.equal(res.error.length > 0, true);
    fs.rmSync(path.join(tmpRoot, 'blocked.json'), { recursive: true, force: true });
  });

  test('dataHome 解析抛错时回落到系统临时目录，绝不落在仓库内', () => {
    require.cache[DATA_HOME] = {
      id: DATA_HOME,
      filename: DATA_HOME,
      loaded: true,
      exports: {
        getProjectDataDir: () => {
          throw new Error('no project home');
        },
      },
    };
    const file = path.join(os.tmpdir(), 'khy-cognitive-snapshots', 'fallback-t.json');
    try {
      const res = persist(build({ ...minimal(), taskId: 'fallback-t' }));
      assert.equal(res.ok, true, String(res.error));
      assert.equal(res.file, file);
      assert.equal(res.file.startsWith(tmpRoot), false);
      assert.equal(res.file.includes(path.join('services', 'backend')), false);
    } finally {
      fs.rmSync(file, { force: true });
      require.cache[DATA_HOME] = {
        id: DATA_HOME,
        filename: DATA_HOME,
        loaded: true,
        exports: { getProjectDataDir: () => tmpRoot },
      };
    }
  });

  test('load 缺失 / 损坏 / 垃圾 taskId 一律返回 null（绝不抛）', () => {
    assert.equal(load('not-there'), null);
    const file = path.join(tmpRoot, 'corrupt.json');
    fs.writeFileSync(file, '{不是 JSON');
    assert.equal(load('corrupt'), null);
    assert.equal(load(undefined), null);
    assert.equal(load(null), null);
    assert.equal(load(0), null);
    assert.equal(load([]), null);
  });

  test('穿越型 taskId 被文件名安全化吃掉，落点仍在桶目录内', () => {
    const evil = '../../../etc/passwd';
    const res = persist(build({ taskId: evil, ultimateGoal: 'g' }));
    assert.equal(res.ok, true, String(res.error));
    assert.equal(path.dirname(res.file), tmpRoot);
    const base = path.basename(res.file);
    assert.equal(base.includes('/'), false);
    assert.equal(base.includes('\\'), false);
    assert.equal(path.resolve(tmpRoot, base) === res.file, true);
    assert.equal(load(evil).taskId, evil);
  });
});

describe('markComplete / hotStart 接力', () => {
  test('标记完成后 hotStart 不再热启，时间戳被刷新', () => {
    const s = build({ ...minimal(), taskId: 'finishing', step: 7 });
    persist(s);
    const r = markComplete('finishing');
    assert.equal(r.ok, true, String(r.error));
    const back = load('finishing');
    assert.equal(back.status, STATUS.DONE);
    assert.equal(back.step, 7);
    assert.ok(back.timestamp >= s.timestamp);
    const hs = hotStart('finishing');
    assert.deepEqual(
      { found: hs.found, resumable: hs.resumable, reason: hs.reason },
      { found: true, resumable: false, reason: 'task already done' }
    );
  });

  test('未完成任务返回 resumable + 注入提示，指南针与断点指令都在文本里', () => {
    persist(
      build({
        ...minimal(),
        taskId: 'resumable',
        step: 12,
        nextInstruction: '把 WAL 边车删掉',
        lessons: ['step3: EPERM 权限不足'],
        entities: ['file:src/a.js'],
        offloadPointers: [{ ref: '<offloaded ref="x" />' }, '裸串'],
        compressedHistory: [{ step: 1, level: 'L1' }],
      })
    );
    const hs = hotStart('resumable');
    assert.equal(hs.found, true);
    assert.equal(hs.resumable, true);
    assert.equal(hs.snapshot.step, 12);
    assert.match(hs.injectionPrompt, /SESSION HOT-START/);
    assert.match(hs.injectionPrompt, /把备份域迁完/);
    assert.match(hs.injectionPrompt, /已到第 12 步 · 重试计数 0/);
    assert.match(hs.injectionPrompt, /step3: EPERM 权限不足/);
    assert.match(hs.injectionPrompt, /file:src\/a\.js/);
    assert.match(hs.injectionPrompt, /裸串/);
    assert.match(hs.injectionPrompt, /"level":"L1"/);
    assert.match(hs.injectionPrompt, /把 WAL 边车删掉/);
  });

  test('无快照时 found=false 且不带 snapshot 字段', () => {
    const hs = hotStart('ghost-task');
    assert.deepEqual(hs, { found: false, resumable: false, reason: 'no snapshot' });
  });

  test('markComplete 打不开快照时结构化失败', () => {
    assert.deepEqual(markComplete('never-existed'), { ok: false, error: 'not found' });
    assert.deepEqual(markComplete(null), { ok: false, error: 'not found' });
  });

  test('KNOWN-DEFECT: 盘上 offloadPointers 含 null 条目时 hotStart 直接抛穿，防呆⑥ 失效', () => {
    // snapshotManager.js:190 (`typeof r === 'string' ? r : r.ref`) runs unguarded over
    // whatever load() deserialized; load is documented 绝不抛 but formatInjection is not
    // wrapped, so one null element in a hand-edited or half-written snapshot turns
    // every later hot start into an uncaught TypeError.
    fs.writeFileSync(
      path.join(tmpRoot, 'poisoned.json'),
      JSON.stringify({ taskId: 'poisoned', ultimateGoal: 'g', step: 1, offloadPointers: [null] })
    );
    assert.throws(() => hotStart('poisoned'), TypeError);
    assert.throws(() => formatInjection({ taskId: 'p', ultimateGoal: 'g', offloadPointers: [null] }), TypeError);
  });

  test('KNOWN-DEFECT: 盘上 lessons/entities 若是字符串，map 抛穿 hotStart', () => {
    // snapshotManager.js:178-181 guards only truthiness + `.length`, and a string has
    // both, so `lessons: "abc"` from disk reaches String.prototype.map → TypeError.
    fs.writeFileSync(
      path.join(tmpRoot, 'stringish.json'),
      JSON.stringify({ taskId: 'stringish', ultimateGoal: 'g', lessons: 'abc' })
    );
    assert.throws(() => hotStart('stringish'), TypeError);
  });
});

describe('formatInjection 注入提示渲染', () => {
  test('null / undefined 返回空串而不是抛', () => {
    assert.equal(formatInjection(null), '');
    assert.equal(formatInjection(undefined), '');
  });

  test('全空快照只渲染四段骨架，缺省断点指令给中文兜底', () => {
    const text = formatInjection({ taskId: 't', ultimateGoal: 'g', step: 0, retryCount: 0 });
    assert.equal(text.split('\n\n').length, 4);
    assert.match(text, /无显式指令/);
    assert.equal(text.includes('错误教训'), false);
    assert.equal(text.includes('压缩历史流'), false);
  });

  test('超长压缩历史在 2000 字符处截断并加省略号', () => {
    const history = [{ step: 1, blob: 'x'.repeat(4000) }];
    const text = formatInjection({ taskId: 't', ultimateGoal: 'g', compressedHistory: history });
    const jsonSection = text.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(jsonSection, 'expected a fenced json section');
    assert.equal(jsonSection[1].length, 2001);
    assert.ok(jsonSection[1].endsWith('…'));
  });

  test('KNOWN-DEFECT: 注入提示对缺 step/retryCount 的快照渲染字面 undefined，且数字 0 指令被 || 吞掉', () => {
    // snapshotManager.js:175 interpolates snapshot.step / snapshot.retryCount raw, so a
    // snapshot that never went through build() (hand-edited or older schema) injects
    // "已到第 undefined 步 · 重试计数 undefined" into the model context.
    // snapshotManager.js:194 uses `nextInstruction || 兜底`, so a legitimate numeric 0
    // instruction is replaced by the fallback text.
    const text = formatInjection({ taskId: 't', ultimateGoal: 'g', nextInstruction: 0 });
    assert.match(text, /已到第 undefined 步 · 重试计数 undefined/);
    assert.match(text, /无显式指令/);
    assert.equal(formatInjection({ taskId: 't', ultimateGoal: 'g', nextInstruction: '0' }).includes('0'), true);
  });
});
