'use strict';

/**
 * uninstallPlan.test.js — 钉死卸载残留位置单一真源：门控、候选构造、按解析后
 * 绝对路径去重、homes/pointer 覆盖优先序。零 IO 零桩，homedir 全程注入假值。
 *
 * 为什么必须钉死：这份清单是「只删程序自己铺过的地方」的允许清单本体——
 * 多一项会误删用户文件，少一项会留残留；两者的回归都无声无息。
 *
 * 实测钉死的怪异行为（非理想行为）：
 *   · 默认位置与解析位置同路径时**静默去重**，只剩一条（first-wins：解析位的
 *     id 先落位，默认位的 id 消失）——只有异盘/改 env 才会有 *-default 孪生条目。
 *   · 「未设置 KHY_UNINSTALL」与「设为空串」都是开；关词表比 installLedger 的
 *     CANON 多出 disable/disabled 两员。
 *   · pointerFile 非法时兜底 `~/.khy/.location.json` 字面拼接，不跟 homes.dataHome
 *     的覆盖走（dataHome 迁到 D 盘，兜底指针仍在 ~/.khy 下）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const U = require('./uninstallPlan');

const HOME = path.resolve('/fake/home'); // 假家目录，永不触盘
const P = (s) => path.resolve(HOME, s);

function ids(targets) {
  return targets.map((t) => t.id);
}
function byId(targets, id) {
  return targets.find((t) => t.id === id);
}

test('uninstallEnabled：缺省/空串开；off/disable 家族关；其余值开（含大小写与空白）', () => {
  assert.equal(U.uninstallEnabled({}), true);
  assert.equal(U.uninstallEnabled({ KHY_UNINSTALL: '' }), true);
  for (const w of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    assert.equal(U.uninstallEnabled({ KHY_UNINSTALL: w }), false, w);
  }
  assert.equal(U.uninstallEnabled({ KHY_UNINSTALL: ' OFF ' }), false, 'trim+lowercase 后仍命中关词');
  assert.equal(U.uninstallEnabled({ KHY_UNINSTALL: 'yes' }), true);
});

test('门关 / homedir 非法 → 空清单（handler 据此回退「命令不可用」）', () => {
  assert.deepEqual(U.buildUninstallTargets({ homedir: HOME }, { KHY_UNINSTALL: 'off' }), []);
  assert.deepEqual(U.buildUninstallTargets({}, {}), []);
  assert.deepEqual(U.buildUninstallTargets({ homedir: 42 }, {}), []);
  assert.deepEqual(U.buildUninstallTargets(null, {}), []);
});

test('默认家目录画像：同路径静默去重，只剩 6 条；data 全 irreversible、runtime/alias/pointer 可逆', () => {
  const t = U.buildUninstallTargets({ homedir: HOME }, {});
  assert.deepEqual(ids(t), [
    'data-home',
    'legacy-app-home',
    'base-home',
    'runtime-home',
    'visible-alias-home',
    'location-pointer',
  ]);
  assert.equal(byId(t, 'data-home').path, P('.khy'));
  assert.equal(byId(t, 'legacy-app-home').path, P('.khyquant'));
  assert.equal(byId(t, 'base-home').path, P('.khyos'));
  assert.equal(byId(t, 'runtime-home').kind, U.KIND.RUNTIME);
  assert.equal(byId(t, 'runtime-home').reversible, true);
  assert.equal(byId(t, 'data-home').reversible, false);
  assert.equal(byId(t, 'visible-alias-home').kind, 'alias');
  assert.equal(byId(t, 'location-pointer').path, path.join(P('.khy'), '.location.json'));
});

test('homes 覆盖产生 *-default 孪生（解析位与默认位都列），且覆盖项优先落位', () => {
  const t = U.buildUninstallTargets({ homedir: HOME, homes: { dataHome: 'D:/data/.khy' } }, {});
  assert.ok(ids(t).includes('data-home-default'), '异盘时默认位置必须补列');
  assert.equal(byId(t, 'data-home').path, path.resolve('D:/data/.khy'));
  assert.equal(byId(t, 'data-home-default').path, P('.khy'));
  assert.ok(ids(t).indexOf('data-home') < ids(t).indexOf('data-home-default'));
});

test('legacy 家三级优先：legacyAppHome > appHome > ~/.khyquant', () => {
  const t = U.buildUninstallTargets({ homedir: HOME, homes: { appHome: 'E:/app' } }, {});
  assert.equal(byId(t, 'legacy-app-home').path, path.resolve('E:/app'));
  const t2 = U.buildUninstallTargets({ homedir: HOME, homes: { appHome: 'E:/app', legacyAppHome: 'F:/legacy' } }, {});
  assert.equal(byId(t2, 'legacy-app-home').path, path.resolve('F:/legacy'));
});

test('pointer 迁移位置单列；与已列路径同点则被去重吞掉', () => {
  const t = U.buildUninstallTargets(
    { homedir: HOME, pointer: { dataHome: 'G:/moved/.khy', projectDataHome: 'G:/moved/.khy-project' } },
    {}
  );
  assert.equal(byId(t, 'relocated-data-home').path, path.resolve('G:/moved/.khy'));
  assert.equal(byId(t, 'relocated-project-home').path, path.resolve('G:/moved/.khy-project'));
  assert.equal(byId(t, 'relocated-data-home').kind, 'data');
  // pointer.dataHome 与默认 ~/.khy 同点 → 不重复列
  const dup = U.buildUninstallTargets({ homedir: HOME, pointer: { dataHome: P('.khy') } }, {});
  assert.equal(ids(dup).filter((i) => i === 'relocated-data-home').length, 0);
});

test('homes.projectDataHome 走独立 id；pointerFile 覆盖指针路径但不覆盖其兜底拼接', () => {
  const t = U.buildUninstallTargets(
    { homedir: HOME, homes: { projectDataHome: 'H:/proj/.khy-project', dataHome: 'D:/data/.khy' }, pointerFile: 'D:/ptr/.location.json' },
    {}
  );
  assert.equal(byId(t, 'project-data-home').path, path.resolve('H:/proj/.khy-project'));
  assert.equal(byId(t, 'location-pointer').path, path.resolve('D:/ptr/.location.json'));
  // 怪异点：dataHome 迁了，pointerFile 兜底仍钉在 ~/.khy/.location.json
  const t2 = U.buildUninstallTargets({ homedir: HOME, homes: { dataHome: 'D:/data/.khy' } }, {});
  assert.equal(byId(t2, 'location-pointer').path, path.join(P('.khy'), '.location.json'));
});

test('一切 path 输出均为解析后绝对路径（相对 homes 锚定 cwd，不裸露相对形）', () => {
  const t = U.buildUninstallTargets({ homedir: 'relative/home', homes: { baseHome: 'b/se' } }, {});
  for (const e of t) {
    assert.ok(path.isAbsolute(e.path), e.id);
  }
  assert.equal(t[0].path, path.resolve('relative/home', '.khy'));
  assert.ok(byId(t, 'base-home'));
  assert.equal(byId(t, 'base-home').path, path.resolve('b/se'));
});
