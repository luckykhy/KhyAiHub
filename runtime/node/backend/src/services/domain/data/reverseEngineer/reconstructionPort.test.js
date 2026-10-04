'use strict';

/**
 * reconstructionPort.test.js — 证据→重建 契约共置测试（批次 27）。
 *
 * 这套测试守的是 DESIGN-ARCH-054 的三条铁律里最容易被写坏的两条：
 *   1. 证据 ≠ 推断：模型产出必须全部落在 inference 侧且带 confidence，绝不混进证据区；
 *   2. 无模型也能跑：任何模型失效形态（抛/拒/null/空串/散文/超时）都必须收敛成
 *      「纯证据报告」而不是抛出，因为整条逆向流水线是 fail-soft 的。
 * 期望值一律来自当前实测（探针跑过），不是设想。
 */

const test = require('node:test');
const assert = require('node:assert');

const rp = require('./reconstructionPort');

const { reconstruct, buildEvidencePack, _deterministicReport, _inferLanguageDeterministic, SYSTEM_PROMPT } = rp;

const REPORT_KEYS = [
  'source',
  'inferredLanguage',
  'inferredToolchain',
  'purposeSummary',
  'modules',
  'entryPoints',
  'reconstructedSkeleton',
  'dependencies',
  'confidence',
  'caveats',
];

// ── buildEvidencePack：把各层结果压成紧凑证据包 ─────────────────────────────

test('buildEvidencePack() 无输入时 13 个键全在（含 undefined），JSON 侧自动脱落', () => {
  const pack = buildEvidencePack();
  assert.deepStrictEqual(Object.keys(pack), [
    'format',
    'family',
    'recoverability',
    'arch',
    'sizeBytes',
    'sha256',
    'markers',
    'toolchainFingerprints',
    'classifiedStrings',
    'sampleStrings',
    'recoveredMembers',
    'recoveredSourceCount',
    'disasm',
  ]);
  // 这三项是数组/对象默认值，必须是空集合而非 undefined——下游模型提示直接吃它们。
  assert.deepStrictEqual(pack.markers, []);
  assert.deepStrictEqual(pack.arch, {});
  assert.deepStrictEqual(pack.toolchainFingerprints, []);
  assert.deepStrictEqual(pack.classifiedStrings, { urls: [], paths: [], versions: [] });
  assert.deepStrictEqual(pack.disasm, []);
  assert.strictEqual(pack.recoveredSourceCount, 0);
  // undefined 值仍在对象上，但进提示词时由 JSON.stringify 掉掉，不会打印 "undefined"。
  assert.strictEqual('format' in pack, true);
  assert.strictEqual(pack.format, undefined);
  assert.strictEqual(JSON.stringify(pack).includes('format'), false);
});

test('buildEvidencePack 的裁剪上限：15/20/15/30/80（输入必须真的超上限才算测到）', () => {
  const many = (n, pfx) => Array.from({ length: n }, (_, i) => ({ text: `${pfx}${i}` }));
  const strings = {
    classified: {
      url: many(40, 'u'),
      path: many(40, 'p'),
      version: many(40, 'v'),
    },
    samples: many(90, 's'),
    toolchains: ['gcc', 'go'],
  };
  const recover = {
    members: Array.from({ length: 120 }, (_, i) => ({
      name: `m${i}.js`,
      kind: 'source',
      size: i,
    })),
  };
  const pack = buildEvidencePack({ strings, recover });
  assert.strictEqual(strings.classified.url.length, 40, '前置条件：输入超上限');
  assert.strictEqual(strings.samples.length, 90);
  assert.strictEqual(recover.members.length, 120);
  assert.deepStrictEqual([
    pack.classifiedStrings.urls.length,
    pack.classifiedStrings.paths.length,
    pack.classifiedStrings.versions.length,
    pack.sampleStrings.length,
    pack.recoveredMembers.length,
  ], [15, 20, 15, 30, 80]);
  // 只留文本，不留 offset/enc —— 证据包是给模型读的，坐标信息在此层被有意丢弃。
  assert.deepStrictEqual(pack.classifiedStrings.urls[0], 'u0');
  assert.deepStrictEqual(pack.sampleStrings[29], 's29');
  assert.deepStrictEqual(pack.recoveredMembers[0], { name: 'm0.js', kind: 'source', size: 0 });
});

test('buildEvidencePack 的 sourceCount 数全体而非裁剪后的 80 条', () => {
  const members = Array.from({ length: 120 }, (_, i) => ({
    name: `m${i}.js`,
    kind: i < 100 ? 'source' : 'asset',
  }));
  const pack = buildEvidencePack({ recover: { members } });
  assert.strictEqual(pack.recoveredMembers.length, 80);
  assert.strictEqual(pack.recoveredSourceCount, 100);
});

test('buildEvidencePack 只收 ok 且有输出的工具证据，每条样本文本裁到 6000', () => {
  const orchestration = {
    evidence: [
      { tool: 'objdump', ok: true, kind: 'disasm', output: 'a'.repeat(9000) },
      { tool: 'nm', ok: false, kind: 'symbols', output: 'should-not-appear' },
      { tool: 'readelf', ok: true, kind: 'headers', output: '' },
      { tool: 'radare2', ok: true, kind: 'functions' },
    ],
  };
  const pack = buildEvidencePack({ orchestration });
  assert.strictEqual(pack.disasm.length, 1);
  assert.deepStrictEqual(Object.keys(pack.disasm[0]), ['tool', 'kind', 'sample']);
  assert.strictEqual(pack.disasm[0].tool, 'objdump');
  assert.strictEqual(pack.disasm[0].sample.length, 6000);
});

// ── _inferLanguageDeterministic：纯证据推断，置信度分级 ─────────────────────

test('工具链指纹优先于格式家族，且按登记顺序取第一个命中', () => {
  const pack = {
    family: 'java',
    markers: [],
    toolchainFingerprints: ['rustc', 'go', 'gcc', 'dotnet'],
  };
  const r = _inferLanguageDeterministic(pack);
  assert.deepStrictEqual(r, { language: 'Go', toolchain: 'go toolchain', confidence: 0.5 });
});

test('python/node 指纹按 marker 细分工具链名（PyInstaller / Node SEA），无 marker 走通用名', () => {
  const base = { family: 'pe', toolchainFingerprints: [] };
  const py = { ...base, toolchainFingerprints: ['python'], markers: ['pyinstaller'] };
  assert.deepStrictEqual(_inferLanguageDeterministic(py), {
    language: 'Python',
    toolchain: 'PyInstaller',
    confidence: 0.5,
  });
  assert.deepStrictEqual(
    _inferLanguageDeterministic({ ...py, markers: [] }).toolchain,
    'CPython'
  );
  const node = { ...base, toolchainFingerprints: ['node'], markers: ['node-sea'] };
  assert.strictEqual(_inferLanguageDeterministic(node).toolchain, 'Node SEA/pkg');
  assert.strictEqual(
    _inferLanguageDeterministic({ ...node, markers: [] }).toolchain,
    'Node.js'
  );
});

test('家族兜底档只覆盖 java/wasm/dotnet，其余 11 个家族全落 unknown/0.1', () => {
  const mk = (family) => ({ family, markers: [], toolchainFingerprints: [] });
  assert.deepStrictEqual(_inferLanguageDeterministic(mk('java')), {
    language: 'Java/JVM',
    toolchain: 'JVM',
    confidence: 0.4,
  });
  assert.deepStrictEqual(_inferLanguageDeterministic(mk('wasm')), {
    language: 'WebAssembly',
    toolchain: 'wasm',
    confidence: 0.4,
  });
  assert.deepStrictEqual(_inferLanguageDeterministic(mk('dotnet')), {
    language: 'C#/.NET',
    toolchain: '.NET',
    confidence: 0.4,
  });
  // artifactScanner 实际可能给出的家族是封闭集合（已实测，见下方 scannerFamilies；
  // 另加签名未命中时的默认值 'unknown'），这 11 个都没有兜底档。
  for (const family of [
    'archive',
    'dalvik',
    'elf',
    'go',
    'macho',
    'node',
    'pe',
    'python',
    'rust',
    'script',
    'unknown',
  ]) {
    assert.deepStrictEqual(_inferLanguageDeterministic(mk(family)), {
      language: 'unknown',
      toolchain: 'unknown',
      confidence: 0.1,
    });
  }
  assert.strictEqual(_inferLanguageDeterministic(mk('undefined')).confidence, 0.1);
  // 'dotnet' 不在 FORMATS 的家族里，但 EMBEDDED_MARKERS 的 dotnet 标记会把 family 升级为
  // 'dotnet'（实测 PE+BSJB → family=dotnet，见 artifactScanner.test.js），故此档可达。
  // scanner 可能给出的家族全集 = FORMATS 家族 ∪ MARKER 家族（13 个，均非原型键）
  // ∪ 签名未命中时的默认值 'unknown' = 14 个。14 − 兜底档 3 = 本条循环覆盖的 11 个。
  const registry = require('./formatRegistry');
  const scannerFamilies = new Set([
    ...registry.listFormats().map((f) => f.family),
    ...registry.EMBEDDED_MARKERS.map((m) => m.family),
  ]);
  assert.deepStrictEqual([...scannerFamilies].sort(), [
    'archive',
    'dalvik',
    'dotnet',
    'elf',
    'go',
    'java',
    'macho',
    'node',
    'pe',
    'python',
    'rust',
    'script',
    'wasm',
  ]);
  assert.strictEqual(_inferLanguageDeterministic(mk('dotnet')).confidence, 0.4);
  // 把「11」钉成可机读的算术，而不是标题里的口头数字。兜底档由置信度 >0.1 反推，不硬列。
  const reachable = new Set([...scannerFamilies, 'unknown']);
  const hasFallback = (f) => _inferLanguageDeterministic(mk(f)).confidence > 0.1;
  assert.strictEqual(reachable.size, 14);
  assert.deepStrictEqual(
    [...reachable].filter((f) => !hasFallback(f)).sort(),
    ['archive', 'dalvik', 'elf', 'go', 'macho', 'node', 'pe', 'python', 'rust', 'script', 'unknown']
  );
  assert.deepStrictEqual([...reachable].filter(hasFallback).sort(), ['dotnet', 'java', 'wasm']);
});

test('家族表是普通对象字面量：非封闭家族名会命中原型链（已知边界，如实钉住）', () => {
  // FAMILY_LANG[pack.family] 未做 hasOwnProperty 判定。artifactScanner 给出的
  // family 取自封闭集合（上一条实测 14 个，均非原型链键），故流水线内不可达；但本函数已导出，
  // 直接调用可传任意串。实测：'constructor' 不抛，却给出 language/toolchain 皆
  // undefined 而 confidence 仍 0.4 的报告 —— 一个「有置信度但无结论」的伪报告。
  // 已登记在 khy.module.json → knownBoundaries（批次 27），非本批修复项。
  const r = _inferLanguageDeterministic({
    family: 'constructor',
    markers: [],
    toolchainFingerprints: [],
  });
  assert.strictEqual(r.language, undefined);
  assert.strictEqual(r.confidence, 0.4);
  // 真正的家族名不受影响（防这条测试退化成「整个函数都坏」的误读）。
  assert.strictEqual(_inferLanguageDeterministic({ family: 'elf', markers: [], toolchainFingerprints: [] }).confidence, 0.1);
});

// ── _deterministicReport：无模型的证据报告 ─────────────────────────────────

test('_deterministicReport 不臆造结构：数组全空、骨架为空串、来源标 evidence-only', () => {
  const pack = buildEvidencePack({ scan: { family: 'java', recoverability: 'source' } });
  const r = _deterministicReport(pack);
  assert.deepStrictEqual(Object.keys(r), REPORT_KEYS);
  assert.strictEqual(r.source, 'evidence-only');
  assert.deepStrictEqual([r.modules, r.entryPoints, r.dependencies, r.reconstructedSkeleton], [
    [],
    [],
    [],
    '',
  ]);
  assert.match(r.purposeSummary, /未启用模型推断/);
  assert.strictEqual(r.caveats.length, 2);
  assert.strictEqual(r.caveats[0], 'No model attached: structural reconstruction skipped.');
  assert.match(r.caveats[1], /inspect recoveredMembers directly/);
});

test('_deterministicReport 对原生产物换成「外部反编译器」这条提示', () => {
  const r = _deterministicReport(buildEvidencePack({ scan: { family: 'elf', recoverability: 'native' } }));
  assert.match(r.caveats[1], /Native binary/);
  assert.match(r.caveats[1], /external disassembler/);
});

// ── reconstruct：无模型 / 有模型的收敛行为 ─────────────────────────────────

test('reconstruct 无 brain：结果等于 _deterministicReport（同一把尺）', async () => {
  const pack = buildEvidencePack({ scan: { family: 'wasm' }, strings: { toolchains: [] } });
  assert.deepStrictEqual(await reconstruct(pack, {}), _deterministicReport(pack));
  assert.deepStrictEqual(await reconstruct(pack, { brain: 'not-a-function' }), _deterministicReport(pack));
});

test('reconstruct 把 brain 的 JSON 收进推断区，未知键一律丢弃', async () => {
  const brain = async (prompt) =>
    JSON.stringify({
      inferredLanguage: 'Go',
      inferredToolchain: 'go build',
      purposeSummary: 'a cli',
      modules: [{ name: 'main', role: 'entry', evidenceRef: 'strings' }],
      entryPoints: ['main.main'],
      reconstructedSkeleton: 'func main() {}',
      dependencies: ['fmt'],
      confidence: 0.62,
      caveats: ['no dw'],
      inventedKey: 'must not survive',
    });
  const r = await reconstruct(buildEvidencePack({ scan: { family: 'elf' } }), { brain });
  assert.deepStrictEqual(Object.keys(r), REPORT_KEYS);
  assert.strictEqual(r.source, 'model');
  assert.strictEqual(r.confidence, 0.62);
  assert.strictEqual('inventedKey' in r, false);
  assert.strictEqual(r.modules[0].evidenceRef, 'strings');
  // 提示词必须是「系统约定 + 证据包 JSON」，且证据包真的进去了。
  let seen = '';
  await reconstruct(buildEvidencePack({ scan: { family: 'elf', format: 'x' } }), {
    brain: async (p) => {
      seen = p;
      return '{"confidence":0.1}';
    },
  });
  assert.strictEqual(seen.startsWith(SYSTEM_PROMPT), true);
  assert.match(seen, /EVIDENCE:\n\{/);
  assert.ok(seen.includes('"format": "x"'), '证据包要真的渲染进提示词');
});

test('reconstruct 接受 brain 直接返回对象（不必是字符串）', async () => {
  const r = await reconstruct(buildEvidencePack(), {
    brain: async () => ({ inferredLanguage: 'C', confidence: 0.9 }),
  });
  assert.strictEqual(r.source, 'model');
  assert.strictEqual(r.inferredLanguage, 'C');
  assert.strictEqual(r.inferredToolchain, 'unknown', '缺字段回退到 unknown 而非 undefined');
  assert.deepStrictEqual([r.modules, r.dependencies, r.caveats], [[], [], []]);
});

test('reconstruct 解析 markdown 围栏内的 JSON（模型常见形态）', async () => {
  const r = await reconstruct(buildEvidencePack(), {
    brain: async () => '```json\n{"inferredLanguage":"Rust","confidence":0.7}\n```',
  });
  assert.strictEqual(r.source, 'model');
  assert.strictEqual(r.inferredLanguage, 'Rust');
});

test('reconstruct 的 confidence 钳制在 [0,1]：超界截断，非数归 0', async () => {
  const grab = async (confidence) => {
    const r = await reconstruct(buildEvidencePack(), {
      brain: async () => JSON.stringify({ confidence }),
    });
    return r.confidence;
  };
  assert.strictEqual(await grab(42), 1);
  assert.strictEqual(await grab(-5), 0);
  assert.strictEqual(await grab('0.5'), 0.5, '字符串数字被 Number() 接住');
  assert.strictEqual(await grab('abc'), 0);
  assert.strictEqual(await grab(undefined), 0);
});

test('reconstruct 对模型数组产出设上限：模块 100 / 入口 50 / 依赖 200 / 注意 30，骨架 64 KiB', async () => {
  const r = await reconstruct(buildEvidencePack(), {
    brain: async () =>
      JSON.stringify({
        modules: Array.from({ length: 150 }, (_, i) => ({ name: `m${i}` })),
        entryPoints: Array.from({ length: 60 }, (_, i) => `e${i}`),
        dependencies: Array.from({ length: 250 }, (_, i) => `d${i}`),
        caveats: Array.from({ length: 40 }, (_, i) => `c${i}`),
        reconstructedSkeleton: 'z'.repeat(70 * 1024),
        confidence: 0.3,
      }),
  });
  assert.deepStrictEqual(
    [r.modules.length, r.entryPoints.length, r.dependencies.length, r.caveats.length, r.reconstructedSkeleton.length],
    [100, 50, 200, 30, 64 * 1024]
  );
});

test('模型失效的六种形态全部收敛为证据报告，绝不抛出', async () => {
  const pack = buildEvidencePack({ scan: { family: 'java' } });
  const probes = {
    '同步抛错': async () => {
      throw new Error('boom');
    },
    'promise 拒绝': () => Promise.reject(new Error('nope')),
    '返回 null': async () => null,
    '返回空串': async () => '',
    '返回散文': async () => 'the model rambled without json',
    '永不 resolve（超时）': () => new Promise(() => {}),
  };
  for (const [name, brain] of Object.entries(probes)) {
    const r = await reconstruct(pack, { brain, timeoutMs: 30 });
    assert.strictEqual(r.source, 'evidence-only', `${name} 应退化为证据报告`);
    assert.deepStrictEqual(Object.keys(r), REPORT_KEYS, name);
    // 前三者与空串共用「Model failed」；散文是「not valid JSON」；超时单列。
    const expected =
      name === '永不 resolve（超时）'
        ? /Model timed out/
        : name === '返回散文'
          ? /not valid JSON/
          : /Model failed/;
    assert.match(r.caveats[0], expected, `${name} 的首条 caveat 要说明退化原因`);
    assert.strictEqual(r.caveats.length, 3, `${name}：退化提示前插，原两条证据提示保留`);
  }
});

test('证据报告的语言结论在退化路径上仍保留（不因失败而抹掉确定性事实）', async () => {
  const pack = buildEvidencePack({
    scan: { family: 'elf' },
    strings: { toolchains: ['go'], classified: {}, samples: [] },
  });
  const r = await reconstruct(pack, { brain: async () => 'ramble' });
  assert.strictEqual(r.inferredLanguage, 'Go');
  assert.strictEqual(r.confidence, 0.5);
});

test('SYSTEM_PROMPT 里写着「只输出 JSON」与「不得臆造」两条约定', () => {
  assert.match(SYSTEM_PROMPT, /Output ONLY a JSON object/);
  assert.match(SYSTEM_PROMPT, /Do NOT invent file names, functions, or APIs/);
  assert.match(SYSTEM_PROMPT, /"confidence": 0\.0/);
});
