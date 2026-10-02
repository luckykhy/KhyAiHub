'use strict';

/**
 * Co-located tests for resolver.js — probe / detectFromError / buildInstallPlan /
 * MissingDependencyError / ensure. All external seams are injected via `env`, so
 * no test resolves a real module, spawns python, or reads the backend root.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const resolver = require('./resolver');
const { probe, ensure, detectFromError, buildInstallPlan, MissingDependencyError, _internal } = resolver;
const { _extractText, _extractMissingModule } = _internal;

function env(over = {}) {
  return {
    searchExecutable: () => null,
    resolveNodeModule: () => false,
    checkPythonPackage: () => false,
    platform: 'linux',
    cwd: '/inject/cwd',
    ...over,
  };
}

describe('_extractText', () => {
  test('兼容 string / Error / note+hint / 结构化 error 多种失败形状', () => {
    assert.strictEqual(_extractText('plain'), 'plain');
    assert.strictEqual(_extractText(new Error('boom')), 'boom');
    assert.strictEqual(_extractText({ note: 'n', hint: 'h' }), 'n \n h');
    assert.strictEqual(_extractText({ error: { message: 'em', hint: 'eh' } }), 'em \n eh');
    assert.strictEqual(_extractText({ error: 'estr' }), 'estr');
  });

  test('falsy / 空对象 / 非字符串字段 → 空串', () => {
    assert.strictEqual(_extractText(null), '');
    assert.strictEqual(_extractText(undefined), '');
    assert.strictEqual(_extractText(''), '');
    assert.strictEqual(_extractText({}), '');
    assert.strictEqual(_extractText(0), '');
  });

  test('KNOWN-DEFECT: note/hint 为合法的 0/false 时被真值闸门丢弃，报错文本静默丢失', () => {
    // resolver.js:191/196 用 `if (failure.note)` / `if (failure.hint)` 真值判断决定是否纳入文本。
    // 一个值为 0 或 false 的合法 note/hint（例如某些工具把退出码放进 note）会被整体丢弃，
    // 使 detectFromError 拿不到本可用于匹配的信号 → 静默漏检。固化「0/false 被吞」的真实行为。
    assert.strictEqual(_extractText({ note: 0 }), '');
    assert.strictEqual(_extractText({ hint: false }), '');
    assert.strictEqual(_extractText({ message: 'boom', note: 0 }), 'boom');
  });
});

describe('_extractMissingModule', () => {
  test('从 Node 缺失报错抽顶层包名，剥子路径、保留 scope', () => {
    assert.strictEqual(_extractMissingModule("Cannot find module 'foo/sub/path'"), 'foo');
    assert.strictEqual(_extractMissingModule("Cannot find module '@scope/pkg/sub'"), '@scope/pkg');
    assert.strictEqual(_extractMissingModule("MODULE_NOT_FOUND ... for 'puppeteer'"), 'puppeteer');
  });

  test('相对/绝对路径、空串、非法字符 → null', () => {
    assert.strictEqual(_extractMissingModule("Cannot find module '../models'"), null);
    assert.strictEqual(_extractMissingModule("Cannot find module '/abs/path'"), null);
    assert.strictEqual(_extractMissingModule('no module here'), null);
    assert.strictEqual(_extractMissingModule(''), null);
    assert.strictEqual(_extractMissingModule(null), null);
    assert.strictEqual(_extractMissingModule(undefined), null);
    assert.strictEqual(_extractMissingModule("Cannot find module '@scope'"), null);
  });
});

describe('probe', () => {
  test('NODE_MODULE 探针按 resolveNodeModule 结果定 present', () => {
    const miss = probe('cheerio', env({ resolveNodeModule: () => false }));
    assert.strictEqual(miss.present, false);
    assert.strictEqual(miss.kind, 'node-module');
    assert.ok(miss.detail.includes('not resolvable'));
    const hit = probe('cheerio', env({ resolveNodeModule: () => true }));
    assert.strictEqual(hit.present, true);
    assert.strictEqual(hit.detail, 'cheerio');
  });

  test('COMMAND 探针按 searchExecutable 命中路径定 present', () => {
    assert.strictEqual(probe('ffmpeg', env({ searchExecutable: () => '/usr/bin/ffmpeg' })).present, true);
    const miss = probe('ffmpeg', env({ searchExecutable: () => null }));
    assert.strictEqual(miss.present, false);
    assert.ok(miss.detail.includes('not on PATH'));
  });

  test('PYTHON_PACKAGE 探针按 checkPythonPackage 定 present', () => {
    assert.strictEqual(probe('torch', env({ checkPythonPackage: () => true })).present, true);
    assert.strictEqual(probe('torch', env({ checkPythonPackage: () => false })).present, false);
  });

  test('未知 depId → present=false, kind=unknown, detail=unknown dependency', () => {
    assert.deepStrictEqual(probe('nope', env()), {
      id: 'nope', present: false, kind: 'unknown', detail: 'unknown dependency',
    });
  });

  test('探针抛异常被吞成「未就绪」，永不抛穿', () => {
    const e = env({ resolveNodeModule: () => { throw new Error('fs blowup'); } });
    const out = probe('cheerio', e);
    assert.strictEqual(out.present, false);
    assert.strictEqual(out.detail, 'probe error');
  });

  test('env 缺探针函数（垃圾 env）时 COMMAND 依赖抛错被吞，保守判未就绪', () => {
    // probe('ffmpeg', {platform}) → searchExecutable 未定义 → 抛 → catch → present:false。
    // 验证「探针失败绝不抛穿，一律按未就绪」这条红线（resolver.js:131/170-172）。
    const out = probe('ffmpeg', { platform: 'linux' });
    assert.strictEqual(out.present, false);
    assert.strictEqual(out.detail, 'probe error');
  });
});

describe('detectFromError', () => {
  test('结构化 depId 优先，精确命中已收录依赖', () => {
    const out = detectFromError({ depId: 'ffmpeg' });
    assert.strictEqual(out.depId, 'ffmpeg');
    assert.strictEqual(out.dependency.id, 'ffmpeg');
  });

  test('depId 未收录 → 回落文本匹配；无匹配则 null', () => {
    assert.strictEqual(detectFromError({ depId: 'not-a-dep', message: 'ffmpeg not found' }).depId, 'ffmpeg');
    assert.strictEqual(detectFromError({ depId: 'not-a-dep', message: 'totally unrelated' }), null);
  });

  test('正则 matcher 命中报错文本', () => {
    assert.strictEqual(detectFromError(new Error('ffmpeg not found, install ffmpeg')).depId, 'ffmpeg');
    assert.strictEqual(detectFromError('requires puppeteer to run').depId, 'puppeteer');
  });

  test('兜底：Cannot find module 抽包名，仅当已收录（按 probe.module）才接管', () => {
    assert.strictEqual(detectFromError("Cannot find module 'cheerio'").depId, 'cheerio');
    // 未收录的包名绝不据报错自动接管（杜绝 typosquat）。
    assert.strictEqual(detectFromError("Cannot find module 'evil-pkg-xyz'"), null);
  });

  test('空/垃圾输入 → null', () => {
    for (const v of [null, undefined, '', 0, {}, [], NaN]) {
      assert.strictEqual(detectFromError(v), null, String(v));
    }
  });

  test('KNOWN-DEFECT: depId="constructor" 经原型链命中，返回 depId=undefined 的伪检测对象', () => {
    // resolver.js:257-262 `failure.depId` 为 'constructor' 时，getDependency('constructor')
    // 返回 Object.prototype.constructor（registry.js:813 原型链泄漏），truthy 即被当成命中，
    // 于是返回 { depId: dep.id(=undefined), dependency: Object } —— 一个非依赖的伪信号向上传播。
    const out = detectFromError({ depId: 'constructor' });
    assert.strictEqual(out.depId, undefined);
    assert.strictEqual(out.dependency, Object);
  });
});

describe('buildInstallPlan', () => {
  test('无 install 声明 / 未知 depId → null', () => {
    assert.strictEqual(buildInstallPlan('nope', env()), null);
    assert.strictEqual(buildInstallPlan(null, env()), null);
  });

  test('平台差异落到 install.platform 覆盖，命令是 argv 数组', () => {
    const win = buildInstallPlan('ffmpeg', env({ platform: 'win32' }), {});
    assert.deepStrictEqual(win.command, ['winget', 'install', '--id', 'Gyan.FFmpeg', '-e']);
    const linux = buildInstallPlan('ffmpeg', env({ platform: 'linux' }), {});
    assert.deepStrictEqual(linux.command, ['apt-get', 'install', '-y', 'ffmpeg']);
  });

  test('返回的是命令快照，改写不得回灌 registry', () => {
    const plan = buildInstallPlan('puppeteer', env({ platform: 'linux' }), {});
    plan.command.push('INJECTED');
    const fresh = buildInstallPlan('puppeteer', env({ platform: 'linux' }), {});
    assert.strictEqual(fresh.command.includes('INJECTED'), false);
    assert.deepStrictEqual(fresh.followUp, ['npx', 'puppeteer', 'browsers', 'install', 'chrome']);
  });

  test('needsNetwork 仅在显式 false 时才为 false（缺省视为需要网络）', () => {
    assert.strictEqual(buildInstallPlan('ffmpeg', env(), {}).needsNetwork, true);
  });

  test('按需选版本：已收录版本工具链解析出 curated argv 覆盖默认', () => {
    const plan = buildInstallPlan('openjdk', env({ platform: 'linux' }), { version: '17' });
    assert.deepStrictEqual(plan.command, ['apt-get', 'install', '-y', 'openjdk-17-jdk']);
    assert.strictEqual(plan.version, '17');
    assert.strictEqual(plan.requestedVersion, '17');
    assert.strictEqual(plan.versionUnavailable, false);
  });

  test('按需选版本：非版本可选依赖退回默认并标 versionUnavailable', () => {
    const plan = buildInstallPlan('puppeteer', env({ platform: 'win32' }), { version: '17' });
    assert.deepStrictEqual(plan.command, ['npm', 'install', 'puppeteer']);
    assert.strictEqual(plan.version, null);
    assert.strictEqual(plan.requestedVersion, '17');
    assert.strictEqual(plan.versionUnavailable, true);
  });

  test('未请求版本时逐字节走 registry 默认，version 为 null', () => {
    const plan = buildInstallPlan('openjdk', env({ platform: 'linux' }), {});
    assert.deepStrictEqual(plan.command, ['apt-get', 'install', '-y', 'default-jdk']);
    assert.strictEqual(plan.version, null);
    assert.strictEqual(plan.requestedVersion, null);
    assert.strictEqual(plan.versionUnavailable, false);
  });

  test('displayCommand 为 argv 空格拼接', () => {
    assert.strictEqual(buildInstallPlan('ffmpeg', env(), {}).displayCommand, 'apt-get install -y ffmpeg');
  });
});

describe('MissingDependencyError / ensure', () => {
  test('ensure 命中已就绪 → null（不构造错误）', () => {
    assert.strictEqual(ensure('cheerio', env({ resolveNodeModule: () => true })), null);
  });

  test('ensure 缺失 → MissingDependencyError，携 depId 与安装计划', () => {
    const err = ensure('cheerio', env({ resolveNodeModule: () => false }));
    assert.ok(err instanceof MissingDependencyError);
    assert.strictEqual(err.depId, 'cheerio');
    assert.strictEqual(err.name, 'MissingDependencyError');
    assert.strictEqual(err.autoInstallable, true);
    assert.strictEqual(err.installPlan.displayCommand, 'npm install cheerio');
  });

  test('toStructuredResult 产出 MISSING_DEPENDENCY 码的可恢复结构', () => {
    const err = ensure('ffmpeg', env({ searchExecutable: () => null }));
    const res = err.toStructuredResult();
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error.code, 'MISSING_DEPENDENCY');
    assert.ok(res.error.hint.includes('Install with:'));
    assert.strictEqual(res.error.recoverable, true);
  });

  test('不可自动安装的依赖 → installPlan 为 null、autoInstallable false、手动指引', () => {
    // 'no-such' 不在 registry → buildInstallPlan 返 null → 手动指引文案。
    const err = new MissingDependencyError('no-such-dep', { env: env() });
    assert.strictEqual(err.installPlan, null);
    assert.strictEqual(err.autoInstallable, false);
    assert.ok(err.toStructuredResult().error.hint.includes('manually'));
  });
});
