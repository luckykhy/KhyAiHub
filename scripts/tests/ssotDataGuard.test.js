'use strict';

/**
 * scripts/tests/ssotDataGuard.test.js — 数据单一真源守卫（LAYOUT-008）的单测。
 *
 * 测的是**纯核心** scripts/lib/ssotDataGuard.js（零 IO、确定性），不 spawn 守卫 CLI。
 * 每条用例都对着一个真实踩过的坑写：进制误读、地板误判、排除规则失效 ——
 * 这三处若回归，守卫会开始误报，而误报的守卫比没有守卫更坏。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../lib/ssotDataGuard');

describe('取值：默认字面量的识别', () => {
  test('parseInt 的进制不能被当成默认值', () => {
    // 端口 9090 在前、进制 10 在后。认错一个，这条事实的「真值」就是错的。
    const got = guard.extractDefaultLiteral("parseInt(process.env.KHY_DAEMON_PORT || '9090', 10)");
    assert.equal(got.value, '9090');
  });

  test('无 || 时取第一个字面量', () => {
    assert.equal(guard.extractDefaultLiteral('8090').value, 8090);
    assert.equal(guard.extractDefaultLiteral('Number(import.meta.env.VITE_AI_FRONTEND_PORT || 8090)').value, 8090);
  });

  test('字符串字面量按字符串取', () => {
    assert.equal(guard.extractDefaultLiteral("process.env.OLLAMA_HOST || 'http://localhost:11434'").value,
      'http://localhost:11434');
  });
});

describe('取值：按 kind 取真源里的值', () => {
  test('js-const', () => {
    const src = "const AI_BACKEND_DEFAULT_PORT = parseInt(process.env.KHY_DAEMON_PORT || '9090', 10);";
    assert.equal(guard.resolveValue(src, 'js-const', 'AI_BACKEND_DEFAULT_PORT').value, '9090');
  });

  test('py-const 取最后一个字面量（环境变量名在前、默认值在后）', () => {
    const src = "DEFAULT_PORT = int(os.environ.get('INFERENCE_SERVER_PORT', '8765'))";
    assert.equal(guard.resolveValue(src, 'py-const', 'DEFAULT_PORT').value, '8765');
  });

  test('json-pointer', () => {
    const src = JSON.stringify({ meta: { ruleCount: 96 }, rules: [1, 2, 3] });
    assert.equal(guard.resolveValue(src, 'json-pointer', '/meta/ruleCount').value, 96);
  });

  test('json-count 取数组长度（真源自洽判据的取数方式）', () => {
    const src = JSON.stringify({ meta: { ruleCount: 3 }, rules: [1, 2, 3] });
    assert.equal(guard.resolveValue(src, 'json-count', '/rules').value, 3);
  });

  test('指针解析不出来时返回 null（判据失效必须报红，不能静默跳过）', () => {
    assert.equal(guard.resolveValue('{"a":1}', 'json-pointer', '/nope'), null);
    assert.equal(guard.resolveValue('not json', 'json-pointer', '/a'), null);
  });
});

describe('矛盾判定：只认直接形态，宁可漏判不误判', () => {
  test('直接兜底能判出矛盾', () => {
    assert.equal(guard.extractAnchoredValue("const P = process.env.X || '9091'", 'X'), '9091');
  });

  test('下限地板不是默认值 —— 不得判成矛盾', () => {
    // Math.max(1, Number(X) || 1) 里的 1 是地板，不是 X 的默认值。
    assert.equal(guard.extractAnchoredValue('const w = Math.max(1, Number(X) || 1)', 'X'), null);
  });

  test('词边界拦住不同名的环境变量', () => {
    // AI_MGMT_PORT_RETRY 是另一个事实，不能命中 AI_MGMT_PORT。
    assert.equal(guard.extractAnchoredValue('const n = Number(process.env.AI_MGMT_PORT_RETRY || 10)', 'AI_MGMT_PORT'), null);
  });

  test('对象属性形态能判出矛盾', () => {
    assert.equal(guard.extractAnchoredValue('  BRIDGE_PORT: 8897,', 'BRIDGE_PORT'), 8897);
  });
});

describe('影子副本判定：数字按边界匹配', () => {
  test('9090 不得命中 19090', () => {
    assert.equal(guard.containsLiteral('const port = 19090;', 9090), false);
    assert.equal(guard.containsLiteral('const port = 9090;', 9090), true);
  });
});

describe('排除规则：前缀通配必须落到路径段上', () => {
  test('`**/test/**` 必须命中嵌套目录里的测试文件', () => {
    // 曾把 `**/test/**` 当普通前缀做 startsWith —— 永不成立，于是测试里的假端口被当成真矛盾。
    assert.equal(guard.isExcluded('delivery/web/ai-frontend/test/backendDiscovery.test.mjs', ['**/test/**']), true);
    assert.equal(guard.isExcluded('runtime/node/backend/tests/x.test.js', ['**/tests/**']), true);
  });

  test('末段通配命中测试文件', () => {
    assert.equal(guard.isExcluded('a/b/x.test.js', ['**/*.test.js']), true);
    assert.equal(guard.isExcluded('a/b/x.js', ['**/*.test.js']), false);
  });

  test('普通目录前缀匹配仓根下的目录', () => {
    assert.equal(guard.isExcluded('runtime/node/backend/dist/x.js', ['runtime/node/backend/dist/**']), true);
    assert.equal(guard.isExcluded('runtime/node/backend/src/x.js', ['runtime/node/backend/dist/**']), false);
  });
});

describe('主判定：影子副本 / 矛盾 / 镜像失步 / 判据失效', () => {
  const registry = {
    sources: [{ path: 'ssot.js', kind: 'code', title: '真源' }],
    facts: [{
      id: 'demo-port',
      title: '演示端口',
      ssot: { path: 'ssot.js', kind: 'js-const', pointer: 'DEMO_PORT' },
      mirrors: [{ path: 'mirror.js', kind: 'js-const', pointer: 'MIRROR_PORT', reason: '独立包，无法 import' }],
      detect: { identifiers: ['DEMO_PORT', 'MIRROR_PORT'], paths: ['app/'] },
    }],
  };

  const files = [
    { relPath: 'ssot.js', text: 'const DEMO_PORT = 9090;' },
    { relPath: 'mirror.js', text: "const MIRROR_PORT = process.env.X || '9090';" },
    { relPath: 'app/other.js', text: "const P = process.env.DEMO_PORT || '9090';" },
    { relPath: 'app/bad.js', text: "const P = process.env.DEMO_PORT || '9091';" },
  ];

  test('真源之外的再声明判影子副本（warning）', () => {
    const { findings } = guard.assess({ registry, files });
    const copies = findings.filter((f) => f.id === 'ssot-shadow-copy');
    assert.equal(copies.length, 1);
    assert.equal(copies[0].file, 'app/other.js');
    assert.equal(copies[0].severity, 'warning');
  });

  test('同一事实两个值判矛盾（error）', () => {
    const { findings } = guard.assess({ registry, files });
    const contradictions = findings.filter((f) => f.id === 'ssot-value-contradiction');
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0].file, 'app/bad.js');
    assert.equal(contradictions[0].severity, 'error');
  });

  test('授权镜像必须与真源锁步', () => {
    const drift = guard.assess({
      registry,
      files: files.map((f) => (f.relPath === 'mirror.js'
        ? { relPath: 'mirror.js', text: "const MIRROR_PORT = process.env.X || '9099';" }
        : f)),
    }).findings.filter((f) => f.id === 'ssot-mirror-drift');
    assert.equal(drift.length, 1);
    assert.equal(drift[0].severity, 'error');
  });

  test('真源文件不存在必须报红（判据失效 ≠ 通过）', () => {
    const { findings } = guard.assess({
      registry: { ...registry, sources: [{ path: 'missing.js', kind: 'code' }] },
      files,
    });
    assert.ok(findings.some((f) => f.id === 'ssot-source-missing' && f.severity === 'error'));
  });

  test('登记表缺字段判非法（无理由的镜像 = 事实上的第二真源）', () => {
    const bad = {
      sources: [],
      facts: [{
        id: 'x',
        ssot: { path: 'a.js', kind: 'js-const', pointer: 'X' },
        mirrors: [{ path: 'm.js', kind: 'js-const', pointer: 'M' }],
        detect: { identifiers: ['X'] },
      }],
    };
    const findings = guard.validateRegistry(bad);
    assert.ok(findings.some((f) => f.message.includes('reason')));
  });

  test('真源自相矛盾：自报计数与实际条目数不符', () => {
    const selfRegistry = {
      sources: [],
      facts: [{
        id: 'count',
        ssot: { path: 'reg.json', kind: 'json-count', pointer: '/rules', declaredPointer: '/meta/ruleCount' },
        mirrors: [],
        detect: { identifiers: [], paths: [] },
      }],
    };
    const { findings } = guard.assess({
      registry: selfRegistry,
      files: [{ relPath: 'reg.json', text: JSON.stringify({ meta: { ruleCount: 96 }, rules: [1, 2, 3] }) }],
    });
    const self = findings.filter((f) => f.id === 'ssot-self-contradiction');
    assert.equal(self.length, 1);
    assert.equal(self[0].severity, 'error');
  });
});

describe('值锚定补网：只认代码里的裸字面量', () => {
  const registry = {
    sources: [],
    facts: [{
      id: 'demo-port',
      title: '演示端口',
      ssot: { path: 'ssot.js', kind: 'js-const', pointer: 'DEMO_PORT' },
      mirrors: [],
      detect: { identifiers: ['DEMO_PORT'], paths: ['app/'], valueAnchor: true },
    }],
  };
  const files = [
    { relPath: 'ssot.js', text: 'const DEMO_PORT = 9090;' },
    { relPath: 'app/alias.js', text: 'const TEMP_ALIAS_PORT = 9090;' },
  ];

  test('未登记别名的裸字面量副本要被抓到', () => {
    const { findings } = guard.assess({ registry, files });
    const unanchored = findings.filter((f) => f.id === 'ssot-unanchored-literal');
    assert.equal(unanchored.length, 1);
    assert.equal(unanchored[0].file, 'app/alias.js');
    assert.equal(unanchored[0].severity, 'warning');
  });

  test('字符串里的示例不是声明（帮助文本 / 案例记录不判）', () => {
    const { findings } = guard.assess({
      registry,
      files: [
        { relPath: 'ssot.js', text: 'const DEMO_PORT = 9090;' },
        { relPath: 'app/help.js', text: "console.log('  用法: start [--port 9090]');" },
        { relPath: 'app/cases.js', text: "const note = '两条路径都绑定 9090 端口';" },
      ],
    });
    assert.equal(findings.filter((f) => f.id === 'ssot-unanchored-literal').length, 0);
  });

  test('提到登记标识符的行不重复报（已由 D1/D2 判过）', () => {
    const { findings } = guard.assess({
      registry,
      files: [
        { relPath: 'ssot.js', text: 'const DEMO_PORT = 9090;' },
        { relPath: 'app/known.js', text: 'const P = process.env.DEMO_PORT || 9090;' },
      ],
    });
    assert.equal(findings.filter((f) => f.id === 'ssot-unanchored-literal').length, 0);
    assert.equal(findings.filter((f) => f.id === 'ssot-shadow-copy').length, 1);
  });

  test('值区分度不够（<100）时不启用补网', () => {
    // 实测值 10（端口漂移窗口）走补网会捞出 242 条噪声 —— 小整数没有区分度。
    const small = {
      sources: [],
      facts: [{
        id: 'window',
        ssot: { path: 'ssot.js', kind: 'js-const', pointer: 'WINDOW' },
        mirrors: [],
        detect: { identifiers: ['WINDOW'], paths: ['app/'], valueAnchor: true },
      }],
    };
    const { findings } = guard.assess({
      registry: small,
      files: [
        { relPath: 'ssot.js', text: 'const WINDOW = 10;' },
        { relPath: 'app/x.js', text: 'const N = 10;' },
      ],
    });
    assert.equal(findings.filter((f) => f.id === 'ssot-unanchored-literal').length, 0);
  });

  test('未开启 valueAnchor 的事实没有这层网', () => {
    const off = {
      sources: [],
      facts: [{
        id: 'off',
        ssot: { path: 'ssot.js', kind: 'js-const', pointer: 'DEMO_PORT' },
        mirrors: [],
        detect: { identifiers: ['DEMO_PORT'], paths: ['app/'] },
      }],
    };
    const { findings } = guard.assess({
      registry: off,
      files: [
        { relPath: 'ssot.js', text: 'const DEMO_PORT = 9090;' },
        { relPath: 'app/alias.js', text: 'const TEMP_ALIAS_PORT = 9090;' },
      ],
    });
    assert.equal(findings.filter((f) => f.id === 'ssot-unanchored-literal').length, 0);
  });
});

describe('假阳性防护：数字字符串与模板插值', () => {
  test('真源值是数字字符串时必须按边界匹配（子串匹配会误报）', () => {
    // 真源常是 `process.env.PORT || '3000'` —— 取出来是字符串 '3000'。
    // 若按子串判，'13000' / '30000' 全会被算成命中（实测 bundleArtifacts.js
    // 三行误报的成因）。
    assert.equal(guard.containsLiteral('BACKEND_PORT=13000', '3000'), false);
    assert.equal(guard.containsLiteral('PORT: 3000', '3000'), true);
    assert.equal(guard.containsLiteral('const p = 19090;', 9090), false);
  });

  test('模板插值不是字面量值，不得判成矛盾', () => {
    // init.js 把 OLLAMA_HOST 嵌进生成代码：`"${OLLAMA_HOST}"`。
    // 插值取的是运行时才知道的东西，拿它跟真源比只会造出假矛盾。
    assert.equal(
      guard.extractAnchoredValue('const u=new URL((process.env.OLLAMA_HOST||"${OLLAMA_HOST}"));', 'OLLAMA_HOST'),
      null,
    );
    // 真兜底仍然是字面量 → 照常判出矛盾
    assert.equal(
      guard.extractAnchoredValue("const P = process.env.OLLAMA_HOST || '11435';", 'OLLAMA_HOST'),
      '11435',
    );
  });
});

describe('跨语言镜像与镜像可比性', () => {
  test('text-const 能读出 Dart 的 const String NAME = "值"', () => {
    const dart = "const String kDefaultOllamaBaseUrl = 'http://localhost:11434';";
    const got = guard.resolveValue(dart, 'text-const', 'kDefaultOllamaBaseUrl');
    assert.equal(got.value, 'http://localhost:11434');
  });

  test('真值是数字端口、镜像是一整条 URL 时，按数字成分判锁步', () => {
    assert.equal(guard.mirrorMatches('11434', 'http://localhost:11434'), true);
    assert.equal(guard.mirrorMatches('11434', 'http://localhost:11435'), false);
    assert.equal(guard.mirrorMatches('9090', 'http://localhost:11434'), false);
  });
});

describe('作用域可达性：静默失效必须报红', () => {
  test('detect.paths 指向不存在的路径 → error（否则这条事实永远 0 finding）', () => {
    const registry = {
      sources: [],
      facts: [{
        id: 'ghost',
        ssot: { path: 'ssot.js', kind: 'js-const', pointer: 'X' },
        mirrors: [],
        detect: { identifiers: ['X'], paths: ['runtime/node/backend/'], valueAnchor: true },
      }],
    };
    const findings = guard.validateScopes(registry, (rel) => rel !== 'runtime/node/backend');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'ssot-scope-missing');
    assert.equal(findings[0].severity, 'error');
  });

  test('作用域全部存在 → 不报', () => {
    const registry = {
      sources: [],
      facts: [{
        id: 'ok',
        ssot: { path: 'ssot.js', kind: 'js-const', pointer: 'X' },
        mirrors: [],
        detect: { identifiers: ['X'], paths: ['runtime/node/backend/'] },
      }],
    };
    assert.equal(guard.validateScopes(registry, () => true).length, 0);
  });

  test('无作用域的事实（json-count 自洽判据）不算失效', () => {
    const registry = {
      sources: [],
      facts: [{
        id: 'count',
        ssot: { path: 'reg.json', kind: 'json-count', pointer: '/rules', declaredPointer: '/meta/ruleCount' },
        mirrors: [],
        detect: { identifiers: [], paths: [] },
      }],
    };
    assert.equal(guard.validateScopes(registry, () => false).length, 0);
  });
});

describe('登记表本身不登记值', () => {
  test('事实条目里不得出现值字段（登记表若存值，它自己就是第二真源）', () => {
    const fs = require('fs');
    const path = require('path');
    const abs = path.resolve(__dirname, '..', '..', 'docs', '10_规范', 'registry', 'DATA-SSOT.json');
    const registry = JSON.parse(fs.readFileSync(abs, 'utf8'));
    for (const fact of registry.facts || []) {
      for (const key of Object.keys(fact)) {
        assert.ok(!['value', 'default', 'expected'].includes(key),
          `事实 ${fact.id} 不该登记 ${key}：值必须运行时从真源读`);
      }
      assert.ok(!('value' in (fact.ssot || {})), `事实 ${fact.id} 的 ssot 不该登记 value`);
    }
  });
});
