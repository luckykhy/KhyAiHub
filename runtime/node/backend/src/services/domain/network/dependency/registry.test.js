'use strict';

/**
 * Co-located tests for registry.js — the curated dependency table (single source of truth).
 * Pure data + three accessors; no IO, no env, no child processes touched.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('./registry');
const { PROBE, DEPENDENCIES, getDependency, listDependencyIds, listDependencies } = registry;

describe('PROBE 常量', () => {
  test('三种探测类型字符串稳定', () => {
    assert.deepStrictEqual(PROBE, {
      NODE_MODULE: 'node-module',
      COMMAND: 'system-command',
      PYTHON_PACKAGE: 'python-package',
    });
  });
});

describe('getDependency', () => {
  test('已登记的 depId 返回对应定义对象', () => {
    const dep = getDependency('ffmpeg');
    assert.strictEqual(dep.id, 'ffmpeg');
    assert.strictEqual(dep.kind, 'system-command');
    assert.strictEqual(dep.probe.type, PROBE.COMMAND);
    assert.strictEqual(dep.probe.bin, 'ffmpeg');
    assert.deepStrictEqual(dep.install.command, ['apt-get', 'install', '-y', 'ffmpeg']);
    assert.strictEqual(dep.install.requiresElevation, true);
  });

  test('未知 / 垃圾 depId 返回 null', () => {
    assert.strictEqual(getDependency('nope'), null);
    assert.strictEqual(getDependency(''), null);
    assert.strictEqual(getDependency(0), null);
    assert.strictEqual(getDependency(-1), null);
    assert.strictEqual(getDependency(NaN), null);
    assert.strictEqual(getDependency(null), null);
    assert.strictEqual(getDependency(undefined), null);
    assert.strictEqual(getDependency([]), null);
    assert.strictEqual(getDependency({}), null);
    // 数字/布尔作为键在表里不存在 → null
    assert.strictEqual(getDependency(true), null);
    assert.strictEqual(getDependency(999999999999), null);
  });

  test('KNOWN-DEFECT: getDependency 命中原型链，把 Object.prototype 成员当成依赖返回', () => {
    // registry.js:813-815 `return DEPENDENCIES[depId] || null` 未做 hasOwnProperty 防护。
    // 'constructor' 在 Object.prototype 上是 truthy 函数 → 被当成一个依赖返回，
    // 下游 detectFromError/buildInstallPlan 会拿它当合法 dep 处理。
    assert.strictEqual(typeof getDependency('constructor'), 'function');
    assert.strictEqual(getDependency('constructor'), Object);
    assert.strictEqual(getDependency('__proto__'), Object.prototype);
    // 对比：真实依赖走自身键，垃圾键期望的 null 语义在这里被原型链打破。
    assert.strictEqual(getDependency('hasOwnProperty'), Object.prototype.hasOwnProperty);
  });

  test('KNOWN-DEFECT: getDependency 返回的是注册表活引用而非文档承诺的「冻结副本」', () => {
    // registry.js:812 注释称「返回某 depId 的定义（冻结副本浅引用，调用方不应改写）」，
    // 但实现 (813-815) 直接返回 DEPENDENCIES[depId]，既未冻结也未拷贝：调用方写穿即污染真源。
    const a = getDependency('puppeteer');
    assert.strictEqual(a, DEPENDENCIES.puppeteer); // 同一引用 → 非副本
    assert.strictEqual(Object.isFrozen(a), false); // 也非冻结
  });
});

describe('listDependencyIds / listDependencies', () => {
  test('id 列表与键集一致且包含代表性条目', () => {
    const ids = listDependencyIds();
    assert.deepStrictEqual(ids, Object.keys(DEPENDENCIES));
    for (const want of ['puppeteer', 'ffmpeg', 'gcc', 'openjdk', 'whisper', 'torch']) {
      assert.ok(ids.includes(want), want);
    }
  });

  test('listDependencies 返回全部定义，每条 id 自洽', () => {
    const deps = listDependencies();
    assert.strictEqual(deps.length, ids_len());
    for (const d of deps) {
      assert.strictEqual(d.id, Object.keys(DEPENDENCIES).find((k) => DEPENDENCIES[k] === d));
      assert.ok(Array.isArray(d.matchers), `${d.id} matchers`);
      assert.strictEqual(typeof d.install, 'object', `${d.id} install`);
    }
  });

  test('返回的是新数组，改写不得影响内部表', () => {
    const ids = listDependencyIds();
    const before = ids.length;
    ids.push('INJECTED');
    assert.strictEqual(listDependencyIds().length, before);
  });
});

describe('条目红线：安装命令为 curated argv 数组', () => {
  test('每个 install.command 都是非空字符串数组（绝不拼 shell 字符串）', () => {
    for (const dep of listDependencies()) {
      assert.ok(Array.isArray(dep.install.command) && dep.install.command.length > 0, dep.id);
      for (const tok of dep.install.command) {
        assert.strictEqual(typeof tok, 'string', `${dep.id} argv token`);
      }
    }
  });

  test('scope 只取 project/global；风险只取 low/medium/high', () => {
    for (const dep of listDependencies()) {
      assert.ok(['project', 'global'].includes(dep.install.scope), `${dep.id} scope=${dep.install.scope}`);
      assert.ok(['low', 'medium', 'high'].includes(dep.install.risk), `${dep.id} risk=${dep.install.risk}`);
    }
  });

  test('global 作用域条目均不自动 sudo：requiresElevation 至多为提示标志', () => {
    // 红线（registry.js:15）：全局/系统级安装标 scope:'global'，默认不自动 sudo。
    for (const dep of listDependencies()) {
      if (dep.install.scope === 'global') {
        // requiresElevation 若出现必须是布尔，供上层提高审批强度而非自动提权。
        if ('requiresElevation' in dep.install) {
          assert.strictEqual(typeof dep.install.requiresElevation, 'boolean', dep.id);
        }
      }
    }
  });

  test('probe.type 必须是三种 PROBE 常量之一并带对应载荷', () => {
    for (const dep of listDependencies()) {
      const t = dep.probe.type;
      assert.ok(Object.values(PROBE).includes(t), `${dep.id} probe.type=${t}`);
      if (t === PROBE.NODE_MODULE) assert.strictEqual(typeof dep.probe.module, 'string', dep.id);
      if (t === PROBE.COMMAND) assert.strictEqual(typeof dep.probe.bin, 'string', dep.id);
      if (t === PROBE.PYTHON_PACKAGE) assert.strictEqual(typeof dep.probe.pkg, 'string', dep.id);
    }
  });

  test('matchers 全是 RegExp，可被 resolver 逐条 .test 消费', () => {
    for (const dep of listDependencies()) {
      for (const m of dep.matchers) {
        assert.ok(m instanceof RegExp, `${dep.id} matcher 非正则`);
      }
    }
  });
});

function ids_len() {
  return listDependencyIds().length;
}
