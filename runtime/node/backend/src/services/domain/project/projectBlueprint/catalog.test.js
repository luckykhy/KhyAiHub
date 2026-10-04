'use strict';

// Co-located contract tests for projectBlueprint/catalog.js.
// Two modes are used: (a) the real src/blueprints/ tree (proves the 4-level climb that
// used to silently load an empty table), and (b) fs.readdirSync/readFileSync patched to a
// synthetic listing so the fail-soft / cache / matching branches are provable. The fs patch
// is always installed and removed around a single synchronous test body.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TPL_ID = require.resolve('../../../projectTemplateService');
const prevTpl = require.cache[TPL_ID];
const templates = {
  list: [
    {
      name: 'spring-boot-mybatis',
      triggers: ['spring boot', 'java web'],
      files: [{ path: 'src/main/java/{groupPath}/App.java' }, { path: 'pom.xml' }],
    },
  ],
  loadTemplates() {
    templates.calls += 1;
    return templates.list;
  },
};
templates.calls = 0;
templates.renderTemplate = () => [];
require.cache[TPL_ID] = {
  id: TPL_ID, filename: TPL_ID, loaded: true, exports: templates, children: [], paths: [],
};

const catalog = require('./catalog');

after(() => {
  if (prevTpl) require.cache[TPL_ID] = prevTpl; else delete require.cache[TPL_ID];
  catalog._resetCache();
});

const realReaddir = fs.readdirSync;
const realReadFile = fs.readFileSync;

// Replaces the blueprint dir listing with `spec` = { '<basename>.json': object | '<raw text>' }.
function withFakeBlueprints(spec, body) {
  const dirs = { archetypes: [], concepts: [] };
  fs.readdirSync = function patched(dir, opts) {
    const base = String(dir);
    const key = base.endsWith('archetypes') ? 'archetypes' : base.endsWith('concepts') ? 'concepts' : null;
    if (!key) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (spec[key] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    dirs[key] = spec[key];
    return Object.keys(spec[key]);
  };
  fs.readFileSync = function patched(file, enc) {
    const base = path.basename(String(file));
    const key = String(file).includes('archetypes') ? 'archetypes' : 'concepts';
    const entry = spec[key] ? spec[key][base] : undefined;
    if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return typeof entry === 'string' ? entry : JSON.stringify(entry);
  };
  catalog._resetCache();
  try {
    return body();
  } finally {
    fs.readdirSync = realReaddir;
    fs.readFileSync = realReadFile;
    catalog._resetCache();
  }
}

test('真实 blueprints 目录被装载（历史上 2 级 climb 指错目录，整表静默为空）', () => {
  assert.equal(fs.existsSync(catalog.BLUEPRINTS_DIR), true);
  assert.deepEqual(
    catalog.listArchetypes().map((a) => a.id).sort(),
    ['ssm', 'vue-multipage'],
  );
  assert.ok(catalog.listConcepts().length >= 19);
  assert.ok(catalog.listArchetypes().every((a) => a.kind === 'archetype' && /json$/.test(a._filename)));
});

test('_loadDir 的 fail-soft：坏 JSON / 缺 id / kind 不符逐条跳过，绝不整表抛', () => {
  const spec = {
    archetypes: {
      'good.json': { id: 'good', kind: 'archetype' },
      'broken.json': '{ not json',
      'noid.json': { kind: 'archetype', label: 'x' },
      'wrongkind.json': { id: 'nope', kind: 'concept' },
      'kindless.json': { id: 'kindless' },
      'notobj.json': '[1,2,3]',
      'null.json': 'null',
    },
  };
  const out = withFakeBlueprints(spec, () => catalog.listArchetypes().map((a) => [a.id, a.kind]));
  assert.deepEqual(out, [['good', 'archetype'], ['kindless', 'archetype']]);
});

test('概念目录同样只收 .json，且缺失目录返回空表而不是抛', () => {
  const out = withFakeBlueprints({ concepts: { 'mvc.json': { id: 'mvc' } } }, () => ({
    concepts: catalog.listConcepts().map((c) => c.id),
    archetypes: catalog.listArchetypes(),
  }));
  assert.deepEqual(out.concepts, ['mvc']);
  assert.deepEqual(out.archetypes, []);
});

test('getArchetype / getConcept 大小写不敏感，假 id 与垃圾 id 一律 null', () => {
  const spec = {
    archetypes: { 'SSM.json': { id: 'ssm', kind: 'archetype' } },
    concepts: { 'rag.json': { id: 'RAG', kind: 'concept' } },
  };
  withFakeBlueprints(spec, () => {
    assert.equal(catalog.getArchetype('SSM').id, 'ssm');
    assert.equal(catalog.getArchetype(' ssm '), null);
    assert.equal(catalog.getConcept('rag').id, 'RAG');
    assert.equal(catalog.getArchetype('missing'), null);
    for (const bad of [null, undefined, 0, '', false, NaN]) {
      assert.equal(catalog.getArchetype(bad), null);
      assert.equal(catalog.getConcept(bad), null);
    }
  });
});

test('KNOWN-DEFECT: 表项是缓存里的活引用，调用方一改就写穿整张真源表', () => {
  const spec = {
    archetypes: { 'a.json': { id: 'a', kind: 'archetype', triggers: ['x'], milestones: [{ id: 'm1' }] } },
    concepts: { 'c.json': { id: 'c', kind: 'concept', triggers: ['t'] } },
  };
  withFakeBlueprints(spec, () => {
    const viaList = catalog.listArchetypes();
    const viaGet = catalog.getArchetype('A');
    const viaMatch = catalog.matchArchetype('please use x');
    // listArchetypes 只 .slice() 了数组（catalog.js:103），条目本体是缓存里的同一个对象。
    assert.equal(viaList[0] === viaGet, true);
    assert.equal(viaMatch === viaGet, true);
    viaMatch.triggers.push('INJECTED');
    viaMatch.milestones[0].title = '被外部改掉的里程碑';
    assert.deepEqual(catalog.getArchetype('a').triggers, ['x', 'INJECTED']);
    assert.equal(catalog.listArchetypes()[0].milestones[0].title, '被外部改掉的里程碑');
    // 命中结果还会被 index.js 继续渲染进模型上下文：一个消费者的临时改动会永久留在
    // 本进程的蓝图表里（直到下次 _resetCache），影响后续所有用户。
    const c = catalog.matchConcept('t');
    assert.equal(c === catalog.getConcept('c'), true);
  });
});

test('templateFor / templateFiles：走 projectTemplateService，缺模板名或抛错都收敛为 null/[]', () => {
  const spec = {
    archetypes: {
      'with.json': { id: 'with', kind: 'archetype', templateName: 'spring-boot-mybatis' },
      'ghost.json': { id: 'ghost', kind: 'archetype', templateName: 'does-not-exist' },
      'bare.json': { id: 'bare', kind: 'archetype' },
    },
  };
  withFakeBlueprints(spec, () => {
    const before = templates.calls;
    assert.deepEqual(catalog.templateFiles(catalog.getArchetype('with')), [
      'src/main/java/{groupPath}/App.java', 'pom.xml',
    ]);
    assert.ok(templates.calls > before);
    assert.equal(catalog.templateFor(catalog.getArchetype('ghost')), null);
    assert.equal(catalog.templateFor(catalog.getArchetype('bare')), null);
    assert.deepEqual(catalog.templateFiles(catalog.getArchetype('ghost')), []);
    assert.equal(catalog.templateFor(null), null);
    assert.equal(catalog.templateFor(undefined), null);
    assert.deepEqual(catalog.templateFiles('not-an-object'), []);

    templates.loadTemplates = () => { throw new Error('templates dir gone'); };
    assert.equal(catalog.templateFor(catalog.getArchetype('with')), null);
    assert.deepEqual(catalog.templateFiles(catalog.getArchetype('with')), []);
    templates.loadTemplates = () => templates.list;

    templates.list = [{ name: 'broken', files: 'not-an-array' }];
    assert.deepEqual(catalog.templateFiles({ id: 'z', templateName: 'broken' }), []);
    templates.list = [{ name: 'nofiles' }];
    assert.deepEqual(catalog.templateFiles({ id: 'z', templateName: 'nofiles' }), []);
    templates.list = [{ name: 'spring-boot-mybatis', triggers: ['spring boot'], files: [{ path: 'pom.xml' }] }];
  });
});

test('matchArchetype = 自身 triggers ∪ 模板 triggers ∪ id（大小写不敏感子串）', () => {
  templates.list = [
    { name: 'tpl-a', triggers: ['From-Template'], files: [] },
    { name: 'other', triggers: ['zzz'], files: [] },
  ];
  const spec = {
    archetypes: {
      'a.json': { id: 'aaa', kind: 'archetype', templateName: 'tpl-a', triggers: ['SSM', '三层架构'] },
      'b.json': { id: 'bbb', kind: 'archetype', triggers: [] },
      'c.json': { id: 'ccc', kind: 'archetype' },
    },
  };
  withFakeBlueprints(spec, () => {
    assert.equal(catalog.matchArchetype('帮我搭个 SSM 后台').id, 'aaa');
    assert.equal(catalog.matchArchetype('要三层架构').id, 'aaa');
    // 模板触发词并入自身集合：文本里出现 from-template 也命中 aaa。
    assert.equal(catalog.matchArchetype('A FROM-TEMPLATE project').id, 'aaa');
    // 没有自身触发词时，id 本身就是触发词。
    assert.equal(catalog.matchArchetype('用 ccc 那条').id, 'ccc');
    assert.equal(catalog.matchArchetype('nothing matches qqq'), null);
    for (const bad of ['', null, undefined, 0, false, '   ']) {
      assert.equal(catalog.matchArchetype(bad), null);
    }
  });
});

test('matchConcept 命中 triggers/id/name 三者之一', () => {
  const spec = {
    concepts: {
      'rag.json': { id: 'rag', kind: 'concept', name: '检索增强生成', triggers: ['retrieval'] },
      'plain.json': { id: 'plain', kind: 'concept' },
    },
  };
  withFakeBlueprints(spec, () => {
    assert.equal(catalog.matchConcept('用 Retrieval 方案').id, 'rag');
    assert.equal(catalog.matchConcept('讲讲检索增强生成').id, 'rag');
    assert.equal(catalog.matchConcept('用 plain 描述').id, 'plain'); // id 本身也是触发词
    assert.equal(catalog.matchConcept('随便写点什么'), null);
    assert.equal(catalog.matchConcept(false), null);
  });
});

test('KNOWN-DEFECT: 蓝图 JSON 的 triggers 写成非可迭代值时，matchArchetype/matchConcept 抛 TypeError', () => {
  const spec = {
    archetypes: { 'a.json': { id: 'a', kind: 'archetype', triggers: 123 } },
    concepts: { 'c.json': { id: 'c', kind: 'concept', triggers: { 0: 'x', length: 1 } } },
  };
  withFakeBlueprints(spec, () => {
    // catalog.js:20 承诺「任何单条 JSON 损坏只跳过该条，绝不让整表加载失败」——装载侧确实
    // fail-soft，但 _archetypeTriggers(catalog.js:156) 与 matchConcept(catalog.js:198) 的
    // for..of 没有 Array.isArray 守卫：一个形状写错的 triggers 让整条查询链路抛穿给调用方。
    assert.throws(() => catalog.matchArchetype('anything'), TypeError);
    assert.throws(() => catalog.matchConcept('anything'), TypeError);
  });
});

test('_resetCache 让改动后的目录被重新读取，缓存不跨调用泄漏', () => {
  const spec = { archetypes: { 'a.json': { id: 'a', kind: 'archetype' } } };
  withFakeBlueprints(spec, () => {
    assert.deepEqual(catalog.listArchetypes().map((x) => x.id), ['a']);
    assert.deepEqual(catalog.listArchetypes().map((x) => x.id), ['a']);
  });
  const spec2 = { archetypes: { 'b.json': { id: 'b', kind: 'archetype' } } };
  withFakeBlueprints(spec2, () => {
    assert.deepEqual(catalog.listArchetypes().map((x) => x.id), ['b']);
  });
});

test('thresholds 从 env 取整：仅 >0 的整数生效，坏值/空串/负数回退默认', () => {
  const id = require.resolve('./catalog');
  const prevEntry = require.cache[id];
  const keys = ['KHY_BLUEPRINT_SLICE_CHARS', 'KHY_BLUEPRINT_CONCEPT_MAX_CHARS'];
  const prevEnv = {};
  for (const k of keys) prevEnv[k] = process.env[k];

  function loadWith(env) {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
    }
    delete require.cache[id];
    return require('./catalog').thresholds;
  }

  try {
    assert.deepEqual(loadWith({}), { defaultSliceChars: 5000, conceptSummaryMaxChars: 1200 });
    assert.equal(loadWith({ KHY_BLUEPRINT_SLICE_CHARS: '250' }).defaultSliceChars, 250);
    assert.equal(loadWith({ KHY_BLUEPRINT_SLICE_CHARS: '0' }).defaultSliceChars, 5000);
    assert.equal(loadWith({ KHY_BLUEPRINT_SLICE_CHARS: '-5' }).defaultSliceChars, 5000);
    assert.equal(loadWith({ KHY_BLUEPRINT_SLICE_CHARS: '' }).defaultSliceChars, 5000);
    assert.equal(loadWith({ KHY_BLUEPRINT_SLICE_CHARS: '  ' }).defaultSliceChars, 5000);
    assert.equal(loadWith({ KHY_BLUEPRINT_SLICE_CHARS: 'abc' }).defaultSliceChars, 5000);
    assert.equal(loadWith({ KHY_BLUEPRINT_SLICE_CHARS: '12.9' }).defaultSliceChars, 12);
    assert.equal(loadWith({ KHY_BLUEPRINT_CONCEPT_MAX_CHARS: '1e9' }).conceptSummaryMaxChars, 1);
  } finally {
    for (const k of keys) {
      if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k];
    }
    delete require.cache[id];
    if (prevEntry) require.cache[id] = prevEntry;
  }
});

test('KNOWN-DEFECT: thresholds 是导出且可写的活对象，任何消费者都能静默改写全局切片预算', () => {
  const before = catalog.thresholds.defaultSliceChars;
  const planner = require('./milestonePlanner');
  const fake = { id: 'x', milestones: [{ id: 'm1', title: 'T', steps: ['s'], files: ['f'] }] };
  assert.equal(planner.milestoneSlice(fake, 0, {}).charBudget, before);
  catalog.thresholds.defaultSliceChars = 999999;
  // milestonePlanner.js:105 每次调用都现读 catalog.thresholds —— 改的是同一个对象。
  assert.equal(planner.milestoneSlice(fake, 0, {}).charBudget, 999999);
  catalog.thresholds.defaultSliceChars = before;
});
