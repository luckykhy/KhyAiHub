'use strict';

/**
 * extensionRoots.discover() 的直接契约测试 —— [MGMT-RPT-035] L3 的验收落地。
 *
 * 为什么值得单开一套：`discover()` 是「文件系统即注册表」这条核心语义的唯一实现，
 * 但现有 `pluginContribResolver.test.js` **把 discover 整个 stub 掉**（注释明写
 * 「真 discover() 会扫本仓 delivery/extension/ 等真实根」）。于是深度上限、同名
 * 优先、禁用态、坏 manifest 容错这几条真正决定「装在哪、谁能看见」的规则，
 * 一直没有机器钉住——改坏了只有用户投诉才会发现。
 *
 * 沿用同夹 `contribToolLifecycle.test.js` 的既有模式：**每个用例起一个子进程**。
 * 原因该文件已写明：resolver 有目录扫描缓存、KHY_EXTENSION_PATH 这类 env 只在模块
 * 加载时读一次，同进程内先测「在」再测「不在」读到的是缓存而不是契约。
 *
 * 机制部分一律用临时目录当 fixture，**不对着真实 delivery/extension/ 测**——
 * 否则任何人往仓库里放一个拓展都可能让用例飘绿或飘红。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const BACKEND = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(BACKEND, '..', '..');
const tempDirs = [];

after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

/** 在 base 下造一个带 canonical manifest 的拓展目录，返回其绝对路径。 */
function makeExt(base, rel, id, extra = {}) {
  const dir = path.join(base, ...String(rel).split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'khy.extension.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', kind: 'runtime', main: 'index.js', ...extra }, null, 2),
    'utf8'
  );
  return dir;
}

/**
 * 在子进程里对 extensionRoots 提问，返回它最后一行打印的 JSON。
 * `extraEnv` 里可带 KHY_DATA_HOME 等，用于隔离 state 文件。
 */
function ask(root, script, extraEnv = {}) {
  const res = cp.spawnSync(process.execPath, ['-e', script], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: {
      ...process.env,
      KHY_EXTENSION_PATH: root,
      // 关掉仓库内根：否则测试会连带看见 delivery/extension/ 下的真拓展，
      // 任何人在仓库里增删拓展都会让这套用例飘动。
      KHY_EXTENSION_REPO_ROOT: '0',
      KHY_APP_ROOT: REPO,
      ...extraEnv,
    },
  });
  if (res.status !== 0) {
    throw new Error(`子进程退出 ${res.status}:\n${res.stdout}\n${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

const E = "const e=require('./src/services/domain/extensions/extensions/extensionRoots.js');";
const DUMP = "console.log(JSON.stringify(e.discover(";
const TAIL = ')))';

describe('discover：文件系统就是注册表', () => {
  test('目录在 + manifest 可解析 → 被发现，不需要任何 state 条目为它背书', () => {
    const root = tmp('khy-disc-');
    makeExt(root, 'khy-fixture', 'khy-fixture');
    const out = ask(root, E + DUMP + TAIL);
    assert.deepStrictEqual(out.map((x) => x.id), ['khy-fixture']);
    assert.strictEqual(out[0].category, null, '顶层拓展没有分类名');
  });

  test('没有 manifest 的目录不产生拓展（空目录/杂物目录自然无产出）', () => {
    const root = tmp('khy-disc-');
    fs.mkdirSync(path.join(root, 'just-a-folder'), { recursive: true });
    fs.writeFileSync(path.join(root, 'just-a-folder', 'readme.txt'), 'hi', 'utf8');
    const out = ask(root, E + DUMP + TAIL);
    assert.deepStrictEqual(out, []);
  });

  test('坏 JSON manifest 被跳过且绝不抛', () => {
    const root = tmp('khy-disc-');
    const bad = path.join(root, 'khy-broken');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'khy.extension.json'), '{ this is not json', 'utf8');
    makeExt(root, 'khy-good', 'khy-good');
    const out = ask(root, E + DUMP + TAIL);
    assert.deepStrictEqual(out.map((x) => x.id), ['khy-good'], '坏的那条跳过，好的那条照常被发现');
  });
});

describe('discover：深度上限 MAX_DEPTH', () => {
  test('MAX_DEPTH 常量就是 2（有人改成 3 必须有人看见）', () => {
    const root = tmp('khy-disc-');
    const out = ask(root, E + "console.log(JSON.stringify({d:e.MAX_DEPTH}))");
    assert.strictEqual(out.d, 2);
  });

  test('分类目录下探一层：root/<cat>/<id> 被发现且 category 记父目录名', () => {
    const root = tmp('khy-disc-');
    makeExt(root, 'bridges/khy-trae-bridge', 'khy-trae-bridge');
    const out = ask(root, E + DUMP + TAIL);
    assert.deepStrictEqual(out.map((x) => x.id), ['khy-trae-bridge']);
    assert.strictEqual(out[0].category, 'bridges');
  });

  test('第三层永不被扫：root/<cat>/<sub>/<id> 不产生拓展', () => {
    const root = tmp('khy-disc-');
    // 两层分类前缀 —— 写成单段就测不到这条边界
    makeExt(root, 'bridges/nested/khy-too-deep', 'khy-too-deep');
    const out = ask(root, E + DUMP + TAIL);
    assert.deepStrictEqual(out, [], 'MAX_DEPTH=2 ⇒ 第三层不该被下探到');
  });

  test('自己就是拓展的目录不再下探（其子目录里的 manifest 不产生第二个拓展）', () => {
    const root = tmp('khy-disc-');
    makeExt(root, 'khy-outer', 'khy-outer');
    makeExt(root, 'khy-outer/khy-inner', 'khy-inner');
    const out = ask(root, E + DUMP + TAIL);
    assert.deepStrictEqual(out.map((x) => x.id), ['khy-outer'], '外层已是拓展 ⇒ 不下探');
  });

  test('多级分类前缀只下探到第二层：root/a/b 的 b 当分类名，b 之下的不进', () => {
    const root = tmp('khy-disc-');
    makeExt(root, 'tools/markdown/khy-md', 'khy-md');
    const out = ask(root, E + DUMP + TAIL);
    assert.deepStrictEqual(out, [], 'tools/markdown 已在第三层，不该被发现');
  });
});

describe('discover：id 取自目录名，不取自 manifest 字段', () => {
  test('manifest 里写的 id 被忽略，真正的 id 是 path.basename(dir)', () => {
    const root = tmp('khy-disc-');
    // 目录名 khy-real，manifest 里却写 id: khy-LIAR
    makeExt(root, 'khy-real', 'khy-LIAR');
    const out = ask(root, E + DUMP + TAIL);
    assert.deepStrictEqual(out.map((x) => x.id), ['khy-real'], 'id 必须来自目录名');
    assert.strictEqual(out[0].name, 'khy-LIAR', 'name 仍可来自 manifest（id 与 name 是两回事）');
  });

  test('推论：改目录名就是改拓展 id —— 所以同名冲突的判据是目录名而非 manifest id', () => {
    const root = tmp('khy-disc-');
    // 两个目录都声明 manifest id = khy-same，但目录名不同 ⇒ 是两个不同拓展，不是冲突。
    makeExt(root, 'dir-one', 'khy-same');
    makeExt(root, 'dir-two', 'khy-same');
    const out = ask(root, E + DUMP + TAIL);
    assert.deepStrictEqual(out.map((x) => x.id).sort(), ['dir-one', 'dir-two']);
  });
});

describe('discover：同名冲突 first-wins', () => {
  test('目录名相同 ⇒ 同一个 id ⇒ 只出现一次，赢家由目录名排序决定', () => {
    const root = tmp('khy-disc-');
    // 两个目录都叫 khy-dup（一个在顶层、一个在 bridges 分类下）⇒ 同一个 id。
    // 'bridges' < 'khy-dup' ⇒ bridges/khy-dup 先被扫到 ⇒ 它赢。
    // 这条钉的是一个反直觉点：**顶层不享有优先级**，冲突赢家取决于目录名字母序。
    // （_listDirNames 显式 .sort()，注释写着「冲突裁决因此确定可复现」——
    //   可复现不等于「符合直觉」，所以要用测试把真实规则写下来。）
    makeExt(root, 'khy-dup', 'khy-dup', { version: '9.9.9' });
    makeExt(root, 'bridges/khy-dup', 'khy-dup', { version: '1.0.0' });
    const out = ask(root, E + DUMP + TAIL);
    assert.strictEqual(out.length, 1, '同名（同目录名）只能出现一次');
    assert.strictEqual(out[0].version, '1.0.0', 'bridges 字母序在前 ⇒ 分类里那个赢');
    assert.strictEqual(out[0].category, 'bridges');
  });

  test('把顶层目录改名到字母序前面，赢家就换成顶层 —— 证明判据是排序而非深度', () => {
    const root = tmp('khy-disc-');
    makeExt(root, 'aaa-dup', 'aaa-dup', { version: '9.9.9' });
    makeExt(root, 'zzz-bridges/aaa-dup', 'aaa-dup', { version: '1.0.0' });
    const out = ask(root, E + DUMP + TAIL);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].version, '9.9.9', '顶层那个现在字母序在前 ⇒ 它赢');
    assert.strictEqual(out[0].category, null);
  });
});

describe('discover：禁用态', () => {
  test('state 里 enabled:false 压住在位目录；includeDisabled 才放行', () => {
    const root = tmp('khy-disc-');
    makeExt(root, 'khy-off', 'khy-off');
    // 先问出 state 文件落在哪（getAppHome 的解析链不该由测试猜）
    const where = ask(root, E + "console.log(JSON.stringify({p:e.stateFilePath()}))", {
      KHY_DATA_HOME: tmp('khy-state-'),
    });
    fs.writeFileSync(where.p, JSON.stringify({ 'khy-off': { enabled: false } }, null, 2), 'utf8');

    const on = ask(root, E + DUMP + TAIL, { KHY_DATA_HOME: path.dirname(where.p) });
    assert.deepStrictEqual(on.map((x) => x.id), [], '显式禁用必须压住在位的目录');

    const withDisabled = ask(root, E + DUMP + '{includeDisabled:true}' + TAIL, {
      KHY_DATA_HOME: path.dirname(where.p),
    });
    assert.deepStrictEqual(withDisabled.map((x) => x.id), ['khy-off']);
    assert.strictEqual(withDisabled[0].enabled, false, '读得出禁用态，而不是假装启用');
  });

  test('state 残留不让已删目录复活（文件系统即注册表的另一半）', () => {
    const root = tmp('khy-disc-');
    makeExt(root, 'khy-alive', 'khy-alive');
    const where = ask(root, E + "console.log(JSON.stringify({p:e.stateFilePath()}))", {
      KHY_DATA_HOME: tmp('khy-state-'),
    });
    // state 里有一条目录已经不存在的条目
    fs.writeFileSync(where.p, JSON.stringify({ 'khy-deleted': { enabled: true } }, null, 2), 'utf8');
    const out = ask(root, E + DUMP + TAIL, { KHY_DATA_HOME: path.dirname(where.p) });
    assert.deepStrictEqual(out.map((x) => x.id), ['khy-alive'], 'state 里的残留不得让目录复活');

    const orphans = ask(
      root,
      E + "console.log(JSON.stringify({o:e.findOrphanState()}))",
      { KHY_DATA_HOME: path.dirname(where.p) }
    );
    assert.deepStrictEqual(orphans.o, ['khy-deleted'], '孤儿条目要被点名，好让人去清理');
  });
});

describe('discover：manifest 三形态', () => {
  test('canonical khy.extension.json 优先；三种名字都是 MANIFEST_NAMES 成员', () => {
    const root = tmp('khy-disc-');
    const names = ask(root, E + "console.log(JSON.stringify({n:e.MANIFEST_NAMES}))");
    assert.ok(names.n.includes('khy.extension.json'), 'canonical 名必须在表里');
    assert.ok(names.n.includes('package.json'), 'package.json 形态（pi 同款）必须在表里');
    assert.ok(names.n.includes('openclaw.plugin.json'), 'legacy 名必须仍在表里（不破坏存量）');
  });

  test('package.json 形态可被发现 —— 这是「npm pack 后在干净环境被认出」的载体', () => {
    const root = tmp('khy-disc-');
    const dir = path.join(root, 'khy-npm-style');
    fs.mkdirSync(dir, { recursive: true });
    // 不写 khy.extension.json，只写带 khy 键的 package.json（对齐 pi 的做法：
    // manifest 不是新文件格式，而是挂进既有 package.json）
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'khy-npm-style', version: '2.0.0', khy: { id: 'khy-npm-style', kind: 'runtime', main: 'index.js' } }, null, 2),
      'utf8'
    );
    const out = ask(root, E + DUMP + TAIL);
    assert.deepStrictEqual(out.map((x) => x.id), ['khy-npm-style']);
    assert.strictEqual(out[0].version, '2.0.0');
  });
});
