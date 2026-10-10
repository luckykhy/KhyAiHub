'use strict';

/**
 * autoModelSelect.headRevert.test.js — 把「不传新参数时与改动前逐字节一致」变成活的锁。
 *
 * 上一版这条只写在 `autoModelSelect.test.js` 的注释里：「把 HEAD 版模块复制成临时探针实跑对照过，
 * 之后删除探针」。那是一次性人工验证——默认路径以后被人改坏时，没有任何东西会红。
 *
 * 做法：`git show HEAD:<path>` 取旧源码，在**真实目录内**用 Module 编译它（相对 require 才解析得了），
 * 全程不往仓库落临时文件；再拿同池同任务类型比对新旧输出（比 JSON 串，键序也算在承诺里）。
 *
 * 取不到 HEAD 时**必须红，不许 skip**：skip 会把这些对照报成 ok，
 * 而「一条从不真正比较的对照」正是本文件存在的理由所要防止的东西。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const cp = require('child_process');

const SELF = path.join(__dirname, 'autoModelSelect.js');
const ROOT = cp.execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const REL = path.relative(ROOT, SELF).split(path.sep).join('/');

const cur = require('./autoModelSelect');

let head = null;
let headErr = '';
try {
  const src = cp.execSync(`git show HEAD:${REL}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const m = new Module(SELF, null);
  m.filename = SELF;
  m.paths = Module._nodeModulePaths(path.dirname(SELF));
  m._compile(src, SELF);
  head = m.exports;
} catch (e) {
  headErr = (e && e.message ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200);
}

const POOLS = {
  mixed: [
    { model: 'gpt-4o-mini', adapter: 'api', tier: 'T3', source: 'remote', status: 'active' },
    { model: 'deepseek-chat', adapter: 'api', tier: 'T1', source: 'remote', status: 'active' },
    { model: 'claude-sonnet-4', adapter: 'claude', tier: 'T1', source: 'remote', status: 'active' },
    { model: 'claude-opus-4-7', adapter: 'claude', tier: 'T0', source: 'remote', status: 'active' },
  ],
  // 同档乱序 + 一个无 tier 的候选：默认路径的稳定性最容易在这里破
  messy: [
    { model: 'b-same', adapter: 'api', tier: 'T2', source: 'remote', status: 'active' },
    { model: 'a-same', adapter: 'api', tier: 'T2', source: 'remote', status: 'active' },
    { model: 'no-tier', adapter: 'api', source: 'remote', status: 'active' },
    { model: 'z-low', adapter: 'api', tier: 'T3', source: 'remote', status: 'active' },
  ],
};
const TASKS = ['code', 'conversation', 'analysis', 'reason'];

test(`HEAD 版模块可编译（取不到就是环境事实，判红不判 skip）｜REL=${REL}`, () => {
  assert.ok(head, `拿不到 HEAD 版 autoModelSelect.js：${headErr}`);
  assert.strictEqual(typeof head.rankAutoModels, 'function', 'HEAD 版没导出 rankAutoModels ⇒ 对照无意义');
});

for (const [poolName, pool] of Object.entries(POOLS)) {
  for (const task of TASKS) {
    test(`默认路径与 HEAD 逐字节一致：pool=${poolName} task=${task}`, () => {
      assert.ok(head, `无 HEAD 版可比对，这条对照没有执行：${headErr}`);
      const a = cur.rankAutoModels(task, pool);
      const b = head.rankAutoModels(task, pool);
      assert.ok(a.length > 0 && b.length > 0, '空输出会让这条对照恒真');
      assert.strictEqual(
        JSON.stringify(a),
        JSON.stringify(b),
        `不传 band/lambda 时新旧输出不同 ⇒ 默认路径被改坏（§7-⑥ 红线）\n  new=${JSON.stringify(a)}\n  head=${JSON.stringify(b)}`
      );
    });
  }
}
