'use strict';

/**
 * check-agent-feedback.test.js — 模态判定的反例矩阵（`RUNTIME-007/008/009` 执行器）。
 *
 * 复现的真实缺陷：`ENTRY_HINTS` 那一权重原先只看路径、不看改动状态，
 * 于是**修改**一个 `src/cli/handlers/*.js` 也被记作「新增顶层入口 +0.30」，
 * BUILD 压过 FIX → 守卫改去索要 requirement-5q.md，而矩阵里唯一的 error 级
 * 判据 `fix-without-repro` 在最常见的改代码路径上永远轮不到。
 *
 * 全部离线：只调纯函数 `detectMode()`，不 spawn、不读盘。
 *
 * 2026-11-05 增补：存证定位（`--task` / `KHY_TASK_ID` / 分支名回退）的回归锁。
 * 定位逻辑本身走纯函数；接线只 spawn 一次，证明 `--task` 真的改变了读取目录，
 * 而不是被吞掉后继续读 `feedback/adhoc`（与 evidence-storage 测试同法）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const {
  detectMode,
  SCENARIOS,
  resolveEvidenceDir,
  missingEvidenceNote,
} = require('../ci/check-agent-feedback.js');

const REPO = path.resolve(__dirname, '..', '..');
const CHECKER = path.join(REPO, 'scripts', 'ci', 'check-agent-feedback.js');

const HANDLER = 'runtime/node/backend/src/cli/handlers/receipts.js';
const ROUTE = 'runtime/node/backend/src/routes/export.js';
const PLAIN = 'runtime/node/backend/src/services/foo.js';

// ── 缺陷本体：入口路径的权重必须绑定「新增」状态 ──────────────────────────────

test('修改 CLI handler + 「修复」语句 → FIX，且不在混合带', () => {
  const det = detectMode([{ status: 'M', path: HANDLER }], '修复 receipts 动词槽 typo 静默渲染列表');
  assert.equal(det.mode, 'FIX');
  assert.equal(det.ambiguous, false, `混合带会逼着写 mode.json 并让 Rule 5 让位：${det.reasons}`);
});

test('修改 routes 入口 → 不再被记作「新增顶层入口」', () => {
  const det = detectMode([{ status: 'M', path: ROUTE }], '修复导出页报错');
  assert.equal(det.mode, 'FIX');
  assert.equal(det.reasons.filter((r) => r.includes('新增顶层入口')).length, 0);
});

test('删除 CLI handler → DELETE 单模态（曾被入口权重拖进混合带）', () => {
  const det = detectMode([{ status: 'D', path: HANDLER }], '随便改点什么');
  assert.equal(det.mode, 'DELETE');
  assert.equal(det.ambiguous, false);
});

test('正向对照：新增 CLI handler 仍是 BUILD（入口权重没有丢失）', () => {
  const det = detectMode([{ status: 'A', path: HANDLER }], '帮我加一个批量导出功能');
  assert.equal(det.mode, 'BUILD');
  assert.ok(
    det.reasons.some((r) => r.includes('新增顶层入口')),
    `入口权重应当只对 A 生效：${det.reasons}`
  );
});

test('非入口路径的修改行为不变（未被本次修复波及）', () => {
  const det = detectMode([{ status: 'M', path: PLAIN }], '这个命令没有反应');
  assert.equal(det.reasons.filter((r) => r.includes('新增顶层入口')).length, 0);
});

// ── 词表：Rule 5 的正文用词必须能命中 FIX ────────────────────────────────────

test('「修复」计入 FIX（AGENTS.md 规则 5 的原话是「修复 bug」）', () => {
  const bare = detectMode([], '修复一个东西');
  const hit = bare.reasons.find((r) => r.startsWith('FIX +'));
  assert.ok(hit, `修复 未命中 FIX 词表：${bare.reasons}`);
  assert.equal(bare.mode, 'FIX');
});

test('既有 FIX 词表未被改动（报错/失败/异常 仍计 FIX）', () => {
  for (const s of ['登录偶尔报错', '导出失败', '网关异常']) {
    assert.equal(detectMode([], s).mode, 'FIX', `${s} 应判 FIX`);
  }
});

test('BUILD 词表不因新增 FIX 词而漂移', () => {
  for (const s of ['加一个导出功能', '新增命令', '支持批量']) {
    assert.equal(detectMode([], s).mode, 'BUILD', `${s} 应判 BUILD`);
  }
});

// ── 场景矩阵防漂移：每个预置场景的主模态就是它要演示的那个 ────────────────────

const SCENARIO_MODES = {
  'fix-no-repro': 'FIX',
  'fix-with-repro': 'FIX',
  'build-no-questions': 'BUILD',
  'delete-mass': 'DELETE',
  'delete-documented': 'DELETE',
  mixed: 'DELETE',
  ambiguous: 'FIX',
};

test('内置场景的主模态逐个保持（改分类逻辑不许把演示样本改掉）', () => {
  for (const [name, expected] of Object.entries(SCENARIO_MODES)) {
    const preset = SCENARIOS[name];
    assert.ok(preset, `场景 ${name} 不存在`);
    const changes = preset.files.map((s) => ({
      status: s.slice(0, 1).toUpperCase(),
      path: s.slice(2),
    }));
    assert.equal(detectMode(changes, preset.say).mode, expected, `${name} 主模态漂移`);
  }
});

test('ambiguous 场景仍留在混合带（本次修复不许顺手抹掉它要演示的东西）', () => {
  const preset = SCENARIOS.ambiguous;
  const changes = preset.files.map((s) => ({
    status: s.slice(0, 1).toUpperCase(),
    path: s.slice(2),
  }));
  assert.equal(detectMode(changes, preset.say).ambiguous, true);
});

// ── 存证定位：门必须能被指向「本次任务」，而不是恒读 adhoc ─────────────────────

/** 临时存证根；KHY_FEEDBACK_DIR 与 hqStore.feedbackDir() 共用同一个覆盖点。 */
function withFeedbackRoot(fn) {
  const prev = process.env.KHY_FEEDBACK_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-locator-'));
  process.env.KHY_FEEDBACK_DIR = root;
  try {
    return fn(root);
  } finally {
    if (prev === undefined) delete process.env.KHY_FEEDBACK_DIR;
    else process.env.KHY_FEEDBACK_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('定位优先级：--evidence > --task > 分支回退 > adhoc', () => {
  withFeedbackRoot((root) => {
    const explicit = path.join(root, 'by-evidence');
    assert.deepEqual(resolveEvidenceDir({ explicit, taskId: 'task-A' }), { dir: explicit, locatedBy: 'evidence' });
    assert.deepEqual(resolveEvidenceDir({ taskId: 'task-A' }), {
      dir: path.join(root, 'task-A'),
      locatedBy: 'task',
    });
    assert.deepEqual(resolveEvidenceDir({}), { dir: path.join(root, 'adhoc'), locatedBy: 'none' });
  });
});

test('任务名只接受目录名：路径分隔与 .. 不得借道', () => {
  withFeedbackRoot((root) => {
    for (const bad of ['../evil', 'a/b', '..', '.', '-x']) {
      assert.deepEqual(
        resolveEvidenceDir({ taskId: bad }),
        { dir: path.join(root, 'adhoc'), locatedBy: 'none' },
        `${bad} 不应被当成任务目录`
      );
    }
  });
});

test('分支名里的 T-<n> 只在目录真实存在时采用（不猜不存在的任务）', () => {
  withFeedbackRoot((root) => {
    assert.equal(resolveEvidenceDir({ branch: 'task/T-031-foo' }).locatedBy, 'none');
    fs.mkdirSync(path.join(root, 'T-031'));
    assert.deepEqual(resolveEvidenceDir({ branch: 'task/T-031-foo' }), {
      dir: path.join(root, 'T-031'),
      locatedBy: 'branch',
    });
    // scenario 演示读自己那份预置存证，不被当前分支劫走
    assert.equal(resolveEvidenceDir({ branch: 'task/T-031-foo', scenario: 'fix-no-repro' }).locatedBy, 'none');
  });
});

test('未定位 / 指错目录的措辞都点明「不是证据缺失」，缺具体文件时不抢话', () => {
  withFeedbackRoot((root) => {
    const none = missingEvidenceNote(path.join(root, 'adhoc'), 'none');
    assert.match(none, /未能定位本次任务的存证目录（不是证据缺失）/);
    assert.match(none, /--task=<task-id>|KHY_TASK_ID/);

    const wrong = missingEvidenceNote(path.join(root, 'nope'), 'task');
    assert.match(wrong, /指定的存证目录不存在.*不是证据缺失/);

    const present = path.join(root, 'task-A');
    fs.mkdirSync(present);
    assert.equal(missingEvidenceNote(present, 'task'), '');
  });
});

test('接线：--task 指向任务目录时门真的从那里读（不再落 adhoc）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-locator-e2e-'));
  try {
    const task = path.join(root, 'task-A');
    fs.mkdirSync(task, { recursive: true });
    fs.writeFileSync(
      path.join(task, 'requirement-5q.md'),
      [
        '# 需求五问',
        '### Q1 谁用？',
        '唯一维护者本人，他在同一台机器上跑 khy 的自动选路；回答来自其原话而非推测。',
        'source: 「希望把 khyos 的 auto 模式拆成几个模式」',
        '### Q2 什么时候用？',
        '每次请求进入网关选路时读取当前档位，并据此决定能力下界与上界，不在别的入口生效。',
        'source: 「希望把 khyos 的 auto 模式拆成几个模式」',
        '### Q3 现在的替代做法是什么？',
        '现状只有一个 auto 档加手工钉渠道，降本与质量无法同时表达，因此必须新增档位。',
        'source: 「智能路由怎么做」',
        '### Q4 成功长什么样？',
        '命令 npm run test:routing-185 全绿，且 khy gateway status 能显示本次档位与原因行。',
        'source: 「先把现有结论整理成完整设计方案」',
        '### Q5 不做会怎样？',
        '不做则四档语义全部落在 auto 内部，降本与质量权衡无处表达，账单读数继续无法归因。',
        'source: 「自我对抗式实现这个方案」',
      ].join('\n'),
      'utf8'
    );

    const r = cp.spawnSync(
      process.execPath,
      [
        CHECKER,
        '--files=A:runtime/node/backend/src/services/gateway/routeDemand.js',
        '--say=帮我新增一个四档模式与智能路由方案',
        '--task=task-A',
      ],
      { cwd: REPO, encoding: 'utf8', env: { ...process.env, KHY_FEEDBACK_DIR: root } }
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /missing-requirement-5q/, `--task 被吞掉，仍读了 adhoc：\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /未能定位本次任务的存证目录/, r.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
