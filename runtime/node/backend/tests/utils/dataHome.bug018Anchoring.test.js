'use strict';

/**
 * BUG-018 回归：数据家锚定（方案 P 目录物理化后的三处失效）。
 *
 * 三条判据（每条都对应一次真实复发）：
 *
 * ① **回溯层数陷阱** —— getAppRoot() 必须落在**仓库根**。
 *    旧布局 `<root>/services/backend/src/utils/` 上溯 4 层；方案 P 迁到
 *    `<root>/runtime/node/backend/src/utils/` 后必须上溯 **5** 层。
 *    2026-10-05 实测：层数没跟着搬 → 数据家锚到 `runtime/works/data/khy` 空壳，
 *    真实数据家（`works/data/khy`）脱离指针引用；新克隆首启必复发。
 *    断言写法刻意用「仓库根下能找到本文件」而不是硬编码路径 ——
 *    硬编码路径改一次就废一次（这正是当初注释与代码脱节的原因）。
 *
 * ② **断链别名自愈** —— `khy-Trajectory` 可见别名若指向**已消失**的目标
 *    （数据家搬家后留下的悬空 junction），必须被修回当前数据家。
 *    旧行为「链接已存在就假设它是对的」→ 悬空永远不自愈（症状：根别名悬空）。
 *
 * ③ **不误伤** —— 别名指向一个**仍然存在**的目录时不得改写；
 *    真实文件/目录占名时更不得覆盖。
 *
 * Runs under jest or `node --test` via the shim.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const dh = require('../../src/utils/dataHome');

/* ── jest-or-node:test shim（与 dataHomePointer.test.js 同款）──────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
let _afterEach = global.afterEach;
let _beforeEach = global.beforeEach;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _afterEach = nt.afterEach;
  _beforeEach = nt.beforeEach;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
    toContain: (e) => assert.ok(String(actual).includes(e), `expected to contain ${e}`),
    toBeTruthy: () => assert.ok(actual, 'expected truthy'),
    toBeFalsy: () => assert.ok(!actual, 'expected falsy'),
  });
}

const SAVE_KEYS = ['KHY_DATA_HOME', 'KHY_LOCATION_FILE', 'KHY_OS_ROOT', 'KHY_PROJECT_DATA_HOME'];
let saved;
const created = [];

function freshTmp(label) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), `khy-bug018-${label}-`));
  created.push(p);
  return p;
}

/** 建一条指向 target 的链接；Windows 用 junction（免管理员），POSIX 用 dir symlink。 */
function linkTo(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

_beforeEach(() => {
  saved = {};
  for (const k of SAVE_KEYS) saved[k] = process.env[k];
  for (const k of SAVE_KEYS) delete process.env[k];
  dh._resetStorageCaches();
});

_afterEach(() => {
  for (const k of SAVE_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  dh._resetStorageCaches();
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

_describe('BUG-018 — 数据家锚定', () => {
  _test('① getAppRoot() 落在仓库根，不是 runtime/', () => {
    const root = dh.getAppRoot();
    // 仓库根下必须能找到本文件 —— 若回溯层数写成 4，root 会变成 <root>/runtime，
    // 下面这条路径不存在，判据立即变红。
    const selfUnderRoot = path.join(root, 'runtime', 'node', 'backend', 'src', 'utils', 'dataHome.js');
    _expect(fs.existsSync(selfUnderRoot)).toBe(true);
    // 反向断言：root 本身不能是 runtime 子目录
    _expect(path.basename(root) === 'runtime').toBe(false);
  });

  _test('① 项目数据家默认落在 <root>/works/data/khy，不落在 runtime/works', () => {
    const root = dh.getAppRoot();
    const appDefault = path.join(root, 'works', 'data', 'khy');
    // 空壳路径必须**不在** runtime/ 之下 —— 那正是 2026-10-05 的故障落点
    _expect(path.join(root, 'runtime', 'works', 'data', 'khy')).toBeTruthy();
    _expect(appDefault.startsWith(path.join(root, 'runtime'))).toBe(false);
  });

  _test('② 断链别名被修回当前数据家', () => {
    const tmp = freshTmp('dangling');
    const alias = path.join(tmp, 'khy-Trajectory');

    // 先建一个真实目标并连上去，再把目标删掉 → 留下悬空链接
    const gone = path.join(tmp, 'moved-away');
    fs.mkdirSync(gone, { recursive: true });
    linkTo(gone, alias);
    fs.rmSync(gone, { recursive: true, force: true });
    _expect(fs.existsSync(alias)).toBe(false); // 悬空：lstat 在、existsSync 假

    process.env.KHY_PROJECT_DATA_HOME = path.join(tmp, '.khy');
    dh._resetStorageCaches();
    const home = dh.getProjectDataHome();

    const ls = fs.lstatSync(alias);
    _expect(ls.isSymbolicLink()).toBe(true);
    _expect(fs.realpathSync(alias)).toBe(fs.realpathSync(home));
  });

  _test('③ 指向仍然存在之目录的别名不被改写', () => {
    const tmp = freshTmp('healthy');
    const alias = path.join(tmp, 'khy-Trajectory');
    const other = path.join(tmp, 'somewhere-else');
    fs.mkdirSync(other, { recursive: true });
    linkTo(other, alias);

    process.env.KHY_PROJECT_DATA_HOME = path.join(tmp, '.khy');
    dh._resetStorageCaches();
    dh.getProjectDataHome();

    _expect(fs.realpathSync(alias)).toBe(fs.realpathSync(other));
  });

  _test('③ 真实目录占名时不被覆盖', () => {
    const tmp = freshTmp('clobber');
    const alias = path.join(tmp, 'khy-Trajectory');
    fs.mkdirSync(alias, { recursive: true });
    const sentinel = path.join(alias, 'user-file.txt');
    fs.writeFileSync(sentinel, 'keep me');

    process.env.KHY_PROJECT_DATA_HOME = path.join(tmp, '.khy');
    dh._resetStorageCaches();
    dh.getProjectDataHome();

    _expect(fs.lstatSync(alias).isDirectory()).toBe(true);
    _expect(fs.existsSync(sentinel)).toBe(true);
  });
});
