'use strict';

/**
 * sessionGroupService 的回归测试（[DESIGN-ARCH-183] 自动分组）。
 *
 * 这个文件要钉住的东西（每条都写成「实现退回到旧行为就会红」）：
 *
 * 1. **自动分组真的发生**：带来源标记的会话落到来源组，没有来源的历史会话落到
 *    时间桶 —— 旧实现是「全部落在未分组」，那正是用户报的「分组不会自动按规则分组」。
 * 2. **显式归属压过自动规则**：用户手动拖进自己建的组，就该待在那里。
 * 3. **系统组不可改**：改名/删除/手动归入一律在服务层被拒（多端一致，UI 只是
 *    同步禁用）。
 * 4. **删组不删会话**：组没了，组内会话回到自动规则，而不是消失。
 * 5. **迁移幂等**：旧 localStorage 分组重复导入不产生重复组/重复成员。
 *
 * 跑法：node --test src/services/sessionGroupService.test.js
 * 隔离：进程内先把 KHY_PROJECT_DATA_HOME 指到临时目录（数据家解析结果会缓存，
 * 必须早于任何 require），绝不碰用户的活体数据家。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── 隔离数据家（必须在 require 数据家解析器之前）────────────────────────
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-session-group-test-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;
process.env.KHY_DATA_HOME = TMP_HOME;

const sessionPersistence = require('./sessionPersistence');
const svc = require('./sessionGroupService');

const DAY = 24 * 60 * 60 * 1000;

/** 写一份会话快照（列表读的就是它）。 */
function writeSession(id, { source, updatedAt, cwd = 'C:/tmp/proj' } = {}) {
  const bucket = cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
  const dir = path.join(TMP_HOME, 'T1-domains', 'sessions', 'sessions', bucket);
  fs.mkdirSync(dir, { recursive: true });
  const metadata = { cwd };
  if (source) metadata.source = source;
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      sessionId: id,
      title: id,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      messageCount: 1,
      metadata,
      createdAt: updatedAt,
      updatedAt,
    }),
    'utf8'
  );
}

const groupIdOf = (res, sessionId) => res.assignment[sessionId];

test('系统组：固定 ID + 固定名 + 不可改名', () => {
  const groups = svc.listGroups();
  const ids = groups.filter((g) => g.kind === 'system').map((g) => g.id);
  assert.ok(ids.includes('khyos-default-group-automation'), '缺定时任务组');
  assert.ok(ids.includes('khyos-default-group-offpeak'), '缺闲时任务组');
  assert.ok(ids.includes('khyos-default-group-manual'), '缺手动会话组');
  assert.ok(ids.includes('khyos-default-group-today'), '缺今天组');
  assert.ok(ids.includes('khyos-default-group-week'), '缺本周组');
  assert.ok(ids.includes('khyos-default-group-older'), '缺更早组');

  const renamed = svc.updateGroup('khyos-default-group-today', { title: '改个名' });
  assert.strictEqual(renamed.ok, false, '系统组不允许改名');
  assert.match(renamed.error || '', /系统分组/, '失败原因要说清是系统组的限制');
  const deleted = svc.deleteGroup('khyos-default-group-automation');
  assert.strictEqual(deleted.ok, false, '系统组不允许删除');
});

test('自动分组：来源标记 → 来源组；无来源 → 时间桶', () => {
  writeSession('s-auto', { source: { type: 'automation', id: 'job-1' }, updatedAt: Date.now() });
  writeSession('s-manual', { source: { type: 'manual' }, updatedAt: Date.now() });
  writeSession('s-today', { updatedAt: Date.now() });
  writeSession('s-week', { updatedAt: Date.now() - 3 * DAY });
  writeSession('s-old', { updatedAt: Date.now() - 40 * DAY });

  const res = svc.listSessionsWithGroups({ limit: 50 });
  assert.strictEqual(res.ok, true, `读取分组失败：${res.error || ''}`);
  assert.strictEqual(groupIdOf(res, 's-auto'), 'khyos-default-group-automation', '定时任务会话应落到定时任务组');
  assert.strictEqual(groupIdOf(res, 's-manual'), 'khyos-default-group-manual', '手动会话应落到手动会话组');
  assert.strictEqual(groupIdOf(res, 's-today'), 'khyos-default-group-today', '今天的会话应落到今天组');
  assert.strictEqual(groupIdOf(res, 's-week'), 'khyos-default-group-week', '近 7 天的会话应落到本周组');
  assert.strictEqual(groupIdOf(res, 's-old'), 'khyos-default-group-older', '更早的会话应落到更早组');
  assert.deepStrictEqual(res.ungrouped, [], '自动分组后不该有会话留在未分组');
});

test('显式归属压过自动规则，且系统组不可手动归入', () => {
  const created = svc.createGroup({ title: '技术调研', color: 'blue' });
  assert.strictEqual(created.ok, true, `建组失败：${created.error || ''}`);
  const gid = created.group.id;

  const moved = svc.moveSession('s-today', gid);
  assert.strictEqual(moved.ok, true, `归组失败：${moved.error || ''}`);
  let res = svc.listSessionsWithGroups({ limit: 50 });
  assert.strictEqual(groupIdOf(res, 's-today'), gid, '手动归组后应留在用户组里');

  const intoSystem = svc.moveSession('s-today', 'khyos-default-group-today');
  assert.strictEqual(intoSystem.ok, false, '系统组不可手动归入');
});

test('删组不删会话：组内会话回到自动规则', () => {
  const created = svc.createGroup({ title: '临时组' });
  const gid = created.group.id;
  svc.moveSession('s-week', gid);
  let res = svc.listSessionsWithGroups({ limit: 50 });
  assert.strictEqual(groupIdOf(res, 's-week'), gid);

  const del = svc.deleteGroup(gid);
  assert.strictEqual(del.ok, true, `删组失败：${del.error || ''}`);
  res = svc.listSessionsWithGroups({ limit: 50 });
  assert.strictEqual(groupIdOf(res, 's-week'), 'khyos-default-group-week', '删组后应回到时间桶，而不是消失');
  assert.ok(res.assignment['s-week'], '会话不能从列表里消失');
});

test('旧 localStorage 分组导入幂等：重复导入不产生重复组/重复成员', () => {
  const payload = {
    groups: [{ id: 'g_legacy_1', name: '旧分组', sortOrder: 0 }],
    assignments: { 's-old': 'g_legacy_1' },
  };
  const first = svc.importLegacyGroups(payload);
  assert.strictEqual(first.ok, true, `导入失败：${first.error || ''}`);
  const second = svc.importLegacyGroups(payload);
  assert.strictEqual(second.ok, true, `重复导入失败：${second.error || ''}`);

  const res = svc.listSessionsWithGroups({ limit: 50 });
  const legacy = res.groups.filter((g) => g.id === 'g_legacy_1');
  assert.strictEqual(legacy.length, 1, '重复导入产生了重复组');
  assert.strictEqual(groupIdOf(res, 's-old'), 'g_legacy_1', '导入的成员关系应生效');
});

test('空名 / 超长名 / 未知组都要被服务层挡住并说清原因', () => {
  const empty = svc.createGroup({ title: '   ' });
  assert.strictEqual(empty.ok, false);
  assert.match(empty.error || '', /名称/, '失败原因要说清是名字的问题');

  const tooLong = svc.createGroup({ title: 'x'.repeat(80) });
  assert.strictEqual(tooLong.ok, false);

  const missing = svc.moveSession('s-old', 'g_not_exist');
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error || '', /不存在/, '失败原因要说清组不存在');
});

test('来源标记随会话落盘写入快照（真实写入路径）', () => {
  const id = sessionPersistence.persistSession('s-persist-src', {
    messages: [{ role: 'user', content: '自动化跑出来的会话' }],
    metadata: { cwd: 'C:/tmp/proj', source: { type: 'automation', id: 'job-9' } },
    title: '',
  });
  assert.ok(id, 'persistSession 应返回会话 id');
  const res = svc.listSessionsWithGroups({ limit: 100 });
  assert.strictEqual(groupIdOf(res, 's-persist-src'), 'khyos-default-group-automation', '落盘的来源标记应决定分组');
});
