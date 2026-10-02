'use strict';

/**
 * Co-located tests for index.js — the dependency/ facade. The meaningful property of a
 * re-export surface is referential identity to the underlying module symbols: a wrong
 * require path (e.g. the historical cli/commands/registry mix-up noted in the source) or
 * a dropped key is a regression. Asserting === against the real submodules pins that.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const index = require('./index');
const registry = require('./registry');
const resolver = require('./resolver');
const installRunner = require('./installRunner');
const healingLoop = require('./healingLoop');
const toolchainVersions = require('./toolchainVersions');

describe('facade 重导出与子模块逐引用一致', () => {
  test('registry 面', () => {
    assert.strictEqual(index.getDependency, registry.getDependency);
    assert.strictEqual(index.listDependencyIds, registry.listDependencyIds);
    assert.strictEqual(index.listDependencies, registry.listDependencies);
  });

  test('resolver 面', () => {
    assert.strictEqual(index.probe, resolver.probe);
    assert.strictEqual(index.ensure, resolver.ensure);
    assert.strictEqual(index.detectFromError, resolver.detectFromError);
    assert.strictEqual(index.buildInstallPlan, resolver.buildInstallPlan);
    assert.strictEqual(index.MissingDependencyError, resolver.MissingDependencyError);
    assert.strictEqual(index.defaultEnv, resolver.defaultEnv);
  });

  test('install 面', () => {
    assert.strictEqual(index.runInstall, installRunner.runInstall);
  });

  test('healing 面', () => {
    assert.strictEqual(index.isEnabled, healingLoop.isEnabled);
    assert.strictEqual(index.heal, healingLoop.heal);
    assert.strictEqual(index.summarizeForAgent, healingLoop.summarizeForAgent);
    assert.strictEqual(index.createSession, healingLoop.createSession);
    assert.strictEqual(index.resetSession, healingLoop.resetSession);
  });

  test('versionable 面', () => {
    assert.strictEqual(index.parseDepSpec, toolchainVersions.parseDepSpec);
    assert.strictEqual(index.isVersionable, toolchainVersions.isVersionable);
    assert.strictEqual(index.supportedVersions, toolchainVersions.supportedVersions);
    assert.strictEqual(index.listVersionable, toolchainVersions.listVersionable);
    assert.strictEqual(index.describeVersions, toolchainVersions.describeVersions);
  });
});

describe('sub-module 句柄按名暴露', () => {
  test('advanced-use 入口指向各子模块本体', () => {
    assert.strictEqual(index.registry, registry);
    assert.strictEqual(index.resolver, resolver);
    assert.strictEqual(index.installRunner, installRunner);
    assert.strictEqual(index.healingLoop, healingLoop);
    assert.strictEqual(index.toolchainVersions, toolchainVersions);
  });
});

describe('通过 facade 端到端可用', () => {
  test('MissingDependencyError 是 Error 子类且可被 facade 构造', () => {
    const err = new index.MissingDependencyError('no-such-dep', { env: { cwd: '/x', platform: 'linux' } });
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, 'MissingDependencyError');
    assert.strictEqual(err.depId, 'no-such-dep');
    assert.strictEqual(err.autoInstallable, false);
  });

  test('facade 暴露的探测/计划函数与直接调用结果一致（注入 env，无真实 IO）', () => {
    const env = { resolveNodeModule: () => false, searchExecutable: () => null, checkPythonPackage: () => false, platform: 'linux', cwd: '/x' };
    assert.deepStrictEqual(index.probe('ffmpeg', env), resolver.probe('ffmpeg', env));
    assert.deepStrictEqual(
      index.buildInstallPlan('ffmpeg', env, {}),
      resolver.buildInstallPlan('ffmpeg', env, {}),
    );
  });

  test('facade 未列出的私有符号不泄漏（无 _internal / DEPENDENCIES 顶层键）', () => {
    assert.strictEqual('_internal' in index, false);
    assert.strictEqual('DEPENDENCIES' in index, false);
  });
});
