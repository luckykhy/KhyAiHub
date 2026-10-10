'use strict';

// Co-located tests for deploy/deploy/index.js (the deploy orchestrator).
// Every dependency (detect/sync/runStep/launch/ledger/now/fs/cp) is injected
// through opts.deps, so the pipeline is exercised purely as decision logic:
// nothing spawns, nothing syncs real dirs, nothing writes to the repo.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');
const orchestrator = require('./index');

function basePlan(over = {}) {
  return {
    type: 'node',
    signals: ['package.json'],
    packageManager: 'npm',
    install: { exe: 'npm.cmd', args: ['ci'], display: 'npm.cmd ci' },
    build: null,
    start: { exe: 'node', args: ['server.js'], display: 'node server.js' },
    port: 8080,
    notes: ['note-a'],
    ...over,
  };
}

function makeHarness(opts = {}) {
  const calls = { detect: [], sync: [], runStep: [], launch: [], upsert: [], steps: [] };
  const deps = {
    fs: {},
    cp: {},
    platform: 'linux',
    detect: (dir, o) => { calls.detect.push([dir, o]); return opts.plan || basePlan(); },
    sync: (s, t, o) => {
      calls.sync.push([s, t]);
      if (opts.syncThrows) throw new Error('源与目标相同，已拒绝');
      return { copied: ['a.js', 'b.js'], skipped: ['node_modules'], dirs: 2, bytes: 99 };
    },
    runStep: (cmd, o) => {
      calls.runStep.push([cmd, o]);
      if (opts.runStepFails && opts.runStepFails.includes(cmd.display)) {
        return { ok: false, code: 1, signal: null, output: 'x'.repeat(700) + 'ENDTAIL', command: cmd.display };
      }
      return { ok: true, code: 0, signal: null, output: 'done', command: cmd.display };
    },
    launch: (cmd, o) => {
      calls.launch.push([cmd, o]);
      return opts.noPid ? { pid: null, logFile: o.logFile, command: cmd.display } : { pid: 4321, logFile: o.logFile, command: cmd.display };
    },
    ledger: { upsert: (r) => { calls.upsert.push(r); if (opts.ledgerThrows) throw new Error('disk full'); } },
    now: () => '2026-02-03T04:05:06.000Z',
    cwd: '/test-cwd',
    ...(opts.deps || {}),
  };
  const deployOpts = { target: '/deploy/myapp', deps, onStep: (s) => calls.steps.push(s), ...(opts.deployOpts || {}) };
  return { calls, deployOpts, run: () => orchestrator.deployProject(deployOpts) };
}

describe('参数防线', () => {
  test('缺 target（含空串）直接抛错，任何阶段都不执行', () => {
    const h = makeHarness();
    assert.throws(() => orchestrator.deployProject({ ...h.deployOpts, target: undefined }), /部署目标路径未指定/);
    assert.throws(() => orchestrator.deployProject({ ...h.deployOpts, target: '' }), /部署目标路径未指定/);
    assert.throws(() => orchestrator.deployProject(), /部署目标路径未指定/);
  });

  test('safeName：非法字符折成下划线，根路径回退 app', () => {
    assert.equal(orchestrator.safeName('/deploy/My App!'), 'My_App_');
    assert.equal(orchestrator.safeName('/'), 'app');
    assert.equal(orchestrator.safeName('/deploy/plain'), 'plain');
  });

  test('parseCommandOverride：多空格折叠；空/空白返回 null', () => {
    assert.deepEqual(orchestrator.parseCommandOverride('  node   app.js  --x '), { exe: 'node', args: ['app.js', '--x'], display: 'node app.js --x' });
    assert.equal(orchestrator.parseCommandOverride(''), null);
    assert.equal(orchestrator.parseCommandOverride('   '), null);
    assert.deepEqual(orchestrator.parseCommandOverride('python -m http.server'), { exe: 'python', args: ['-m', 'http.server'], display: 'python -m http.server' });
  });

  test('KNOWN-DEFECT: parseCommandOverride(null/0) 把字面量 "null"/"0" 当作可执行命令', () => {
    // index.js:37 — String(str) coerces null/undefined/0 into visible text and
    // the function then returns a command whose exe is the string 'null',
    // instead of the documented null for "no override".
    assert.deepEqual(orchestrator.parseCommandOverride(null), { exe: 'null', args: [], display: 'null' });
    assert.deepEqual(orchestrator.parseCommandOverride(undefined), { exe: 'undefined', args: [], display: 'undefined' });
    assert.equal(orchestrator.parseCommandOverride(0).exe, '0');
  });
});

describe('主流水线 detect→sync→install→build→start', () => {
  test('带 start 的成功部署：状态 running、账本落 startCmd/startedAt', () => {
    const h = makeHarness({ deployOpts: { start: true } });
    const r = h.run();
    assert.equal(r.ok, true);
    assert.equal(r.status, 'running');
    assert.equal(r.pid, 4321);
    assert.equal(r.port, 8080, 'opts.port 缺省时取 plan.port');
    assert.equal(r.name, 'myapp');
    assert.equal(r.logFile, path.resolve('/deploy/myapp') + path.sep + '.khy-deploy' + path.sep + 'myapp.log');
    assert.deepEqual(h.calls.steps.map((s) => s.name), ['detect', 'sync', 'install', 'build', 'start']);
    assert.deepEqual(h.calls.steps.map((s) => s.status), ['ok', 'ok', 'ok', 'skipped', 'ok']);
    const rec = h.calls.upsert[0];
    assert.equal(rec.startCmd, 'node server.js');
    assert.equal(rec.startedAt, '2026-02-03T04:05:06.000Z');
    assert.equal(rec.status, 'running');
    assert.equal(rec.pid, 4321);
  });

  test('detect 收到 source 与注入 fs/platform；sync 收到解析后的 source/target', () => {
    const h = makeHarness({ deployOpts: { source: '/src/proj' } });
    h.run();
    assert.equal(h.calls.detect[0][0], path.resolve('/src/proj'));
    assert.equal(h.calls.detect[0][1].platform, 'linux');
    assert.deepEqual(h.calls.sync[0], [path.resolve('/src/proj'), path.resolve('/deploy/myapp')]);
  });

  test('未给 source 时落到 deps.cwd', () => {
    const h = makeHarness();
    const r = h.run();
    assert.equal(r.source, path.resolve('/test-cwd'));
  });

  test('不 start 时状态 deployed，账本仍记 plan.start.display 且 startedAt null', () => {
    const h = makeHarness();
    const r = h.run();
    assert.equal(r.status, 'deployed');
    assert.equal(h.calls.steps[4].detail, '未指定 --start');
    assert.equal(h.calls.upsert[0].startCmd, 'node server.js');
    assert.equal(h.calls.upsert[0].startedAt, null);
    assert.equal(h.calls.launch.length, 0);
  });

  test('opts.port 优先于 plan.port；opts.name 覆盖 safeName', () => {
    // logFile is only produced on the start branch (index.js:182-185), so the
    // name override must be observed through an actual --start run.
    const h = makeHarness({ deployOpts: { port: 3000, name: 'custom', start: true } });
    const r = h.run();
    assert.equal(r.port, 3000);
    assert.equal(r.name, 'custom');
    assert.equal(r.logFile, path.join(path.resolve('/deploy/myapp'), '.khy-deploy', 'custom.log'));
    assert.equal(h.calls.upsert[0].port, 3000);
    assert.equal(h.calls.upsert[0].name, 'custom');
  });

  test('install/build 透传 target 作 cwd 并合并 opts.env', () => {
    const plan = basePlan({ build: { exe: 'npm.cmd', args: ['run', 'build'], display: 'npm.cmd run build' } });
    const h = makeHarness({ plan, deployOpts: { env: { KHY_DEPLOY_TEST: '1' } } });
    h.run();
    assert.equal(h.calls.runStep.length, 2);
    assert.equal(h.calls.runStep[0][1].cwd, path.resolve('/deploy/myapp'));
    assert.equal(h.calls.runStep[0][1].env.KHY_DEPLOY_TEST, '1');
    assert.equal(h.calls.runStep[0][1].env.PATH, process.env.PATH);
    assert.equal(h.calls.runStep[1][0].display, 'npm.cmd run build');
  });

  test('startCmd 覆盖计划启动命令并进入账本', () => {
    const h = makeHarness({ deployOpts: { start: true, startCmd: 'python -m http.server 9000' } });
    const r = h.run();
    assert.equal(h.calls.launch[0][0].exe, 'python');
    assert.deepEqual(h.calls.launch[0][0].args, ['-m', 'http.server', '9000']);
    assert.equal(h.calls.upsert[0].startCmd, 'python -m http.server 9000');
    assert.equal(r.status, 'running');
  });
});

describe('失败与旁路路径', () => {
  test('sync 失败 → 立即终止：ok:false、后续阶段零调用、账本不落', () => {
    const h = makeHarness({ syncThrows: true, deployOpts: { start: true } });
    const r = h.run();
    assert.equal(r.ok, false);
    assert.equal(r.status, 'failed');
    assert.deepEqual(h.calls.steps.map((s) => s.name), ['detect', 'sync']);
    assert.equal(h.calls.steps[1].status, 'failed');
    assert.equal(h.calls.runStep.length, 0);
    assert.equal(h.calls.launch.length, 0);
    assert.equal(h.calls.upsert.length, 0, '失败的部署不进账本（当前设计）');
  });

  test('install 失败 → fail-safe 停摆，detail 带命令与 600 字符尾部输出', () => {
    const h = makeHarness({ runStepFails: ['npm.cmd ci'], deployOpts: { start: true } });
    const r = h.run();
    assert.equal(r.status, 'failed');
    const step = h.calls.steps[2];
    assert.equal(step.name, 'install');
    assert.equal(step.status, 'failed');
    assert.ok(step.detail.startsWith('npm.cmd ci\n'));
    assert.equal(step.detail.length, 'npm.cmd ci\n'.length + 600);
    assert.ok(step.detail.endsWith('ENDTAIL'), 'tail(600) keeps the freshest output lines');
    assert.equal(h.calls.runStep.length, 1, 'install 失败后不得再跑 build');
    assert.equal(h.calls.launch.length, 0);
  });

  test('build 失败同样硬停', () => {
    const plan = basePlan({ build: { exe: 'make', args: ['build'], display: 'make build' } });
    const h = makeHarness({ plan, runStepFails: ['make build'], deployOpts: { start: true } });
    const r = h.run();
    assert.equal(r.status, 'failed');
    assert.equal(h.calls.steps[3].name, 'build');
    assert.equal(h.calls.steps[3].status, 'failed');
  });

  test('--no-install/--no-build 显示跳过原因且不调 runStep', () => {
    const plan = basePlan({ build: { exe: 'make', args: ['build'], display: 'make build' } });
    const h = makeHarness({ plan, deployOpts: { install: false, build: false } });
    h.run();
    assert.equal(h.calls.runStep.length, 0);
    assert.equal(h.calls.steps[2].detail, '已通过 --no-install 跳过');
    assert.equal(h.calls.steps[3].detail, '已通过 --no-build 跳过');
  });

  test('计划无 install 命令 → skipped 文案为"无依赖安装步骤"而非 --no-install', () => {
    const h = makeHarness({ plan: basePlan({ install: null }) });
    h.run();
    assert.equal(h.calls.steps[2].detail, '该项目类型无依赖安装步骤');
  });

  test('start 无可用命令 → 部署保持 deployed，start 步骤 failed', () => {
    const h = makeHarness({ plan: basePlan({ start: null }), deployOpts: { start: true } });
    const r = h.run();
    assert.equal(r.ok, true);
    assert.equal(r.status, 'deployed');
    assert.equal(h.calls.steps[4].detail, '无法确定启动命令，请用 --cmd "<命令>" 指定');
    assert.equal(h.calls.upsert[0].startCmd, null);
  });

  test('launch 拿不到 pid → 状态 failed 但文件已部署', () => {
    const h = makeHarness({ noPid: true, deployOpts: { start: true } });
    const r = h.run();
    assert.equal(r.status, 'failed');
    assert.equal(r.pid, null);
    assert.equal(h.calls.steps[4].status, 'failed');
    assert.match(h.calls.steps[4].detail, /启动失败: node server.js/);
    assert.equal(h.calls.upsert[0].status, 'failed');
  });

  test('账本写失败被吞：部署结果不受影响（best-effort 承诺）', () => {
    const h = makeHarness({ ledgerThrows: true });
    const r = h.run();
    assert.equal(r.ok, true);
    assert.equal(r.status, 'deployed');
    assert.equal(h.calls.upsert.length, 1);
  });

  test('result.notes 是副本：改写不影响 plan.notes', () => {
    const plan = basePlan();
    const h = makeHarness({ plan });
    const r = h.run();
    r.notes.push('mutated');
    assert.equal(plan.notes.length, 1);
  });

  test('port 兜底链：plan.port null → result.port null', () => {
    const h = makeHarness({ plan: basePlan({ port: null }) });
    assert.equal(h.run().port, null);
  });
});
