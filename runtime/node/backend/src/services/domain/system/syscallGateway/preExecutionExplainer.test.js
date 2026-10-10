'use strict';

/**
 * preExecutionExplainer.test.js — 执行前说明生成契约（深浅分级、fail-soft，绝不抛）。
 *
 * fail 方向：fail-**soft**——describe 抛错时降级为安全 L2 detailed 说明；工作区采集失败
 * → workspace=null。说明永远拿得到一个可渲染对象。**关键**：所有用例注入 describe / workspace /
 * collectWorkspace 桩，避免真实工作区采集（git）IO，保持确定性。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  explain,
  renderText,
  _gradeFromIntent,
  _depthOf,
  _gitHazardHint,
  ACTION_WHAT,
  GIT_HAZARD_HINTS,
} = require('./preExecutionExplainer');

const WS = { branch: 'main', clean: true };

test('ACTION_WHAT 与 GIT_HAZARD_HINTS 非空（输入面不得为空表）', () => {
  assert.ok(Object.keys(ACTION_WHAT).length > 0);
  assert.ok(GIT_HAZARD_HINTS.length > 0);
  assert.deepStrictEqual(GIT_HAZARD_HINTS.map((h) => h.key), ['force-push', 'reset-hard', 'clean-fd']);
});

test('explain 只读 L0 → brief 单行、不附工作区', () => {
  const e = explain({ action: 'read', scope: 'project', tool: 'Read', resource: 'x.js', raw: {} });
  assert.strictEqual(e.level, 'L0');
  assert.strictEqual(e.depth, 'brief');
  assert.strictEqual(e.workspace, null);
  assert.strictEqual(e.text, e.headline);
});

test('explain 系统级删除 L2 → detailed，附后果与撤销', () => {
  const e = explain({ action: 'delete', scope: 'system', tool: 'Bash', resource: 'rm x', raw: {} }, { workspace: WS });
  assert.strictEqual(e.level, 'L2');
  assert.strictEqual(e.depth, 'detailed');
  assert.ok(e.risks.some((r) => r.includes('无法找回')));
  assert.ok(e.howToUndo.includes('git restore'));
});

test('explain 注入 describe 覆盖分级来源', () => {
  const e = explain(
    { action: 'read', scope: 'project', tool: 'R', resource: '', raw: {} },
    { describe: () => ({ isRedLine: false, level: 'L1', summary: 's', reasons: ['why'] }), workspace: WS }
  );
  assert.strictEqual(e.level, 'L1');
  assert.deepStrictEqual(e.reasons, ['why']);
});

test('explain describe 抛错 fail-soft 降级 L2 detailed', () => {
  const e = explain(
    { action: 'delete', scope: 'system', tool: 'B', resource: 'x', raw: {} },
    { describe: () => { throw new Error('bad'); }, workspace: WS }
  );
  assert.strictEqual(e.level, 'L2');
  assert.strictEqual(e.depth, 'detailed');
  assert.deepStrictEqual(e.reasons, []);
});

test('explain git 强推命中 hazard：what/risks/undo 用专项文案', () => {
  const e = explain(
    { action: 'write', scope: 'project', tool: 'Bash', resource: 'git push --force', isDestructive: true, raw: {} },
    { workspace: WS }
  );
  assert.strictEqual(e.whatHappens, '强制推送——用本地历史覆盖远程分支');
  assert.strictEqual(e.depth, 'detailed');
  assert.ok(e.risks.some((r) => r.includes('覆盖远程')));
  assert.ok(e.howToUndo.includes('reflog'));
});

test('explain 破坏性非删除动作追加泛化风险', () => {
  const e = explain(
    { action: 'write', scope: 'system', tool: 'W', resource: 'x', isDestructive: true, raw: {} },
    { workspace: WS }
  );
  assert.ok(e.risks.some((r) => r.includes('破坏性')));
});

test('_gradeFromIntent 反映只读易/删除难/写入中', () => {
  assert.deepStrictEqual(_gradeFromIntent({ action: 'read', isReadOnly: true }, 'L0'), { importance: 'low', difficulty: 'easy' });
  assert.deepStrictEqual(_gradeFromIntent({ action: 'delete' }, 'L2'), { importance: 'high', difficulty: 'hard' });
  assert.deepStrictEqual(_gradeFromIntent({ action: 'write', scope: 'project' }, 'L1'), { importance: 'medium', difficulty: 'moderate' });
});

test('_depthOf 取重要程度与难易中更高者', () => {
  assert.strictEqual(_depthOf('high', 'easy'), 'detailed');
  assert.strictEqual(_depthOf('low', 'hard'), 'detailed');
  assert.strictEqual(_depthOf('medium', 'easy'), 'standard');
  assert.strictEqual(_depthOf('low', 'easy'), 'brief');
});

test('_gitHazardHint 三类命中 + 无命中 + null', () => {
  assert.strictEqual(_gitHazardHint({ resource: 'git push origin main -f' }).key, 'force-push');
  assert.strictEqual(_gitHazardHint({ resource: 'git reset --hard HEAD' }).key, 'reset-hard');
  assert.strictEqual(_gitHazardHint({ resource: 'git clean -fd' }).key, 'clean-fd');
  assert.strictEqual(_gitHazardHint({ resource: 'git status' }), null);
  assert.strictEqual(_gitHazardHint(null), null);
});

test('renderText 三档深浅结构不同', () => {
  assert.strictEqual(renderText({ depth: 'brief', headline: 'H' }), 'H');
  const std = renderText({ depth: 'standard', headline: 'H', howToUndo: 'U', workspace: 'W' });
  assert.ok(std.includes('撤销方式：U') && std.includes('当前工作区：'));
  const det = renderText({ depth: 'detailed', headline: 'H', reasons: ['r1'], risks: ['k1'], howToUndo: 'U', workspace: 'W' });
  assert.ok(det.includes('为什么需要你确认') && det.includes('可能的后果'));
});

test('explain 缺 workspace 时主动采集（注入桩，非 git）', () => {
  const e = explain(
    { action: 'write', scope: 'project', tool: 'W', resource: 'x', raw: {} },
    { collectWorkspace: () => ({ isGitRepo: false, root: 'collect-root' }) }
  );
  assert.strictEqual(typeof e.workspace, 'string');
  assert.ok(e.workspace.includes('collect-root'));
});

test('explain 采集抛错 fail-soft → workspace=null', () => {
  const e = explain(
    { action: 'write', scope: 'project', tool: 'W', resource: 'x', raw: {} },
    { collectWorkspace: () => { throw new Error('fs'); } }
  );
  assert.strictEqual(e.workspace, null);
});
