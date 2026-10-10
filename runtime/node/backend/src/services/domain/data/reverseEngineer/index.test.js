'use strict';

/**
 * index.test.js — 逆向引擎门面与授权边界 契约共置测试（批次 27）。
 *
 * 门面唯一不可让的契约有两条（DESIGN-ARCH-054）：
 *   防呆⑥ 授权边界：定位不到 khy 构建清单且未显式 authorized ⇒ **只做只读分诊**，
 *      绝不驱动源码还原、外部反编译与深度重建；
 *   自验闭环：产物 ↔ 构建清单比对 ⇒ 保真度评分（这是「khy 验 khy 自己生成的软件」那条路）。
 * 另加 fail-soft：任何阶段失败都降级成部分报告，门面承诺「绝不抛」。
 * 全部期望值实测而来；所有产物都写在系统临时区，不碰工作区。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const engine = require('./index');
const ledger = require('./verificationLedger');

const { ReverseEngineer, analyze } = engine;

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-b27-facade-${tag}-`));
}

/** 造一个 shebang 脚本产物：SOURCE 档、零外部依赖、还原路径最短。 */
function writeScript(root, name, body) {
  const p = path.join(root, name);
  fs.writeFileSync(p, body);
  return p;
}

function writeManifestFor(root, artifactPath, sources, shaOverride) {
  const manifest = {
    manifestVersion: ledger.MANIFEST_VERSION,
    artifact: {
      name: path.basename(artifactPath),
      sha256: shaOverride || crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex'),
    },
    sources: sources.map((name) => ({ name })),
  };
  const out = path.join(root, ledger.MANIFEST_BASENAME);
  ledger.writeManifest(manifest, out);
  return { file: out, manifest };
}

const UNAUTHORIZED = /未授权模式/;

// ── 边界 0：产物不存在 / 不是普通文件 ──────────────────────────────────────

test('产物不存在：ok=false，判级 no-artifact，且给出明确警示而非静默空报告', async () => {
  const missing = path.join(tmpRoot('miss-'), 'ghost.bin');
  const r = await analyze(missing);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.artifact, missing);
  assert.strictEqual(r.authorized, false);
  assert.strictEqual(r.scan.exists, false);
  assert.strictEqual(r.scan.sha256, null, '不存在的产物不该有哈希');
  assert.deepStrictEqual(r.warnings, ['Artifact not found or not a regular file.']);
  assert.deepStrictEqual(r.verification, {
    hasBaseline: false,
    verdict: 'no-artifact',
    message: '产物不存在。',
    fidelity: null,
  });
});

test('把目录当产物交给门面：与「不存在」同一降级，不抛', async () => {
  const dir = tmpRoot('dir-');
  const r = await analyze(dir);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.verification.verdict, 'no-artifact');
});

// ── 边界 1：授权门（防呆⑥）────────────────────────────────────────────────

test('未授权：只给只读分诊结论，还原/编排/清单核对一律不开', async () => {
  const root = tmpRoot('unauth-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\necho hi\n'));
  const r = await analyze(file);
  assert.strictEqual(r.ok, true, '未授权也是合法结论，不是失败');
  assert.strictEqual(r.authorized, false);
  assert.strictEqual(r.manifestPath, null);
  assert.strictEqual(r.scan.exists, true);
  assert.deepStrictEqual([r.scan.format, r.scan.family], ['script-shebang', 'script']);
  assert.match(r.warnings[0], UNAUTHORIZED);
  assert.match(r.warnings[0], /authorized:true/);
  // 这三样是「深度能力」，未授权时必须完全没跑。
  assert.strictEqual(r.recovery, null);
  assert.strictEqual(r.verification, r.verification, 'verification 必须是个对象，下游不必判空');
  assert.strictEqual(r.orchestration, null);
  assert.strictEqual(r.reconstruction.source, 'evidence-only');
  assert.deepStrictEqual(r.reconstruction.modules, []);
  assert.strictEqual(r.verification.hasBaseline, false);
  assert.strictEqual(r.verification.verdict, 'no-baseline');
});

test('同目录存在 khy 构建清单即视为自验：无需 authorized 也能开深度能力', async () => {
  const root = tmpRoot('autodiscover-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\n'));
  const { file: mf } = writeManifestFor(root, file, ['run.sh']);
  const r = await analyze(file);
  assert.strictEqual(r.authorized, true);
  assert.strictEqual(r.manifestPath, mf);
  assert.strictEqual(r.warnings.length, 0, '已授权不该留未授权警示');
});

test('authorized:true 显式授权：走完整流水线，但仍如实标注「无基线」', async () => {
  const root = tmpRoot('explicit-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\n'));
  const r = await analyze(file, { authorized: true });
  assert.strictEqual(r.authorized, true);
  assert.strictEqual(r.manifestPath, null);
  assert.strictEqual(r.recovery.ok, true);
  assert.deepStrictEqual(r.recovery.members.map((m) => m.name), ['run.sh']);
  assert.strictEqual(r.verification.hasBaseline, false);
  assert.strictEqual(r.verification.verdict, 'no-baseline');
});

test('编排层默认只探活不开火（runTools 未给 ⇒ attempted=false）', async () => {
  const root = tmpRoot('probeonly-');
  const file = writeScript(root, 'a.sh', Buffer.from('#!/bin/sh\n'));
  const r = await analyze(file, { authorized: true });
  assert.strictEqual(r.orchestration.attempted, false);
  assert.deepStrictEqual(r.orchestration.evidence, []);
  // script 家族本就无外部反编译计划：如实说「无登记计划」而不是假装探到工具。
  assert.match(r.orchestration.hint, /无登记的外部工具计划/);
});

test('runTools 且本机无工具时，缺口收敛成一个 curated depId 供上层申请批准', async () => {
  const root = tmpRoot('runtools-');
  const elf = path.join(root, 'a.out');
  const body = Buffer.alloc(64, 0);
  body.set(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), 0);
  fs.writeFileSync(elf, body);
  const r = await analyze(elf, { authorized: true, runTools: true });
  assert.strictEqual(r.orchestration.attempted, false);
  // 与纯函数 recommendInstall 同一把尺（两处不许漂移）。
  const rec = engine.toolOrchestrator.recommendInstall(r.scan.family);
  assert.ok(rec, 'elf 族必须有申请建议');
  assert.deepStrictEqual(r.orchestration.missingDependency, rec);
  assert.strictEqual(typeof r.orchestration.missingDependency.depId, 'string');
});

test('计划为空的家族不硬造安装建议（missingDependency 缺席而非 null 猜测）', async () => {
  const root = tmpRoot('nodeps-');
  const file = writeScript(root, 'b.sh', Buffer.from('#!/bin/sh\n'));
  const r = await analyze(file, { authorized: true, runTools: true });
  assert.strictEqual('missingDependency' in r.orchestration, false);
});

// ── 自验闭环：产物 ↔ 构建清单 ─────────────────────────────────────────────

test('闭环全绿：哈希一致 + 源全覆盖 ⇒ verified / fidelity 100', async () => {
  const root = tmpRoot('gold-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\necho hi\n'));
  writeManifestFor(root, file, ['run.sh']);
  const r = await analyze(file);
  assert.strictEqual(r.verification.hasBaseline, true);
  assert.strictEqual(r.verification.verdict, 'verified');
  assert.strictEqual(r.verification.fidelity, 100);
  assert.strictEqual(r.verification.artifactHashMatch, true);
  assert.deepStrictEqual([r.verification.matchedCount, r.verification.missingCount, r.verification.extra], [1, 0, []]);
  assert.match(r.verification.message, /高保真自验通过/);
});

test('清单哈希与产物不符：覆盖仍满分但保真度腰斩，判级不再 verified', async () => {
  const root = tmpRoot('hashbad-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\n'));
  writeManifestFor(root, file, ['run.sh'], 'deadbeef');
  const r = await analyze(file);
  assert.strictEqual(r.verification.artifactHashMatch, false);
  assert.deepStrictEqual([r.verification.fidelity, r.verification.verdict], [50, 'partial']);
});

test('清单里有产物中不存在的源文件：missing 逐条点名，不许含糊', async () => {
  const root = tmpRoot('missing-src-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\n'));
  writeManifestFor(root, file, ['run.sh', 'gone.js']);
  const r = await analyze(file);
  assert.deepStrictEqual([r.verification.matchedCount, r.verification.missingCount], [1, 1]);
  assert.deepStrictEqual(r.verification.missing, ['gone.js']);
  assert.strictEqual(r.verification.coverage, 0.5);
  // 哈希一致保底 50 + 覆盖 25 = 75。
  assert.strictEqual(r.verification.fidelity, 75);
});

test('还原出但清单未登记的源码算 extra（防「清单漏登记」被当成完美）', async () => {
  const root = tmpRoot('extra-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\n'));
  writeManifestFor(root, file, []);
  const r = await analyze(file);
  assert.deepStrictEqual(r.verification.extra, ['run.sh']);
  assert.strictEqual(r.verification.coverage, 0);
});

test('outDir：可还原产物真的落盘到指定目录，报告里带 extractedTo', async () => {
  const root = tmpRoot('outdir-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\necho hi\n'));
  const outDir = path.join(root, 'recovered');
  fs.mkdirSync(outDir, { recursive: true });
  const r = await analyze(file, { authorized: true, outDir });
  assert.strictEqual(r.recovery.ok, true);
  // script 档「还原」就是指向原文件本身，不复制——报告不许谎称写出去了。
  assert.strictEqual(r.recovery.members[0].extractedTo, file);
  assert.deepStrictEqual(fs.readdirSync(outDir), []);
});

// ── 模型注入与证据/推断分离 ───────────────────────────────────────────────

test('无 brain：重建层退化为纯证据报告，绝不臆造模块', async () => {
  const root = tmpRoot('nobrain-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\n'));
  const r = await analyze(file, { authorized: true });
  assert.strictEqual(r.reconstruction.source, 'evidence-only');
  assert.match(r.reconstruction.purposeSummary, /未启用模型推断/);
  assert.ok(Array.isArray(r.reconstruction.caveats) && r.reconstruction.caveats.length >= 2);
});

test('注入 brain：模型产出落进推断区，证据区（scan/strings）一字未改', async () => {
  const root = tmpRoot('brain-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\n'));
  const before = { format: null };
  const eng = new ReverseEngineer({
    brain: async (prompt) => {
      assert.match(prompt, /EVIDENCE:/);
      return JSON.stringify({
        inferredLanguage: 'Shell',
        modules: [{ name: 'run.sh', role: 'entry', evidenceRef: 'sampleStrings' }],
        confidence: 0.8,
      });
    },
  });
  const r = await eng.analyze(file, { authorized: true });
  before.format = r.scan.format;
  assert.strictEqual(r.reconstruction.source, 'model');
  assert.strictEqual(r.reconstruction.inferredLanguage, 'Shell');
  assert.strictEqual(r.reconstruction.confidence, 0.8);
  assert.deepStrictEqual(r.reconstruction.modules, [
    { name: 'run.sh', role: 'entry', evidenceRef: 'sampleStrings' },
  ]);
  // 证据区仍是确定性事实，没被模型的结论改写。
  assert.strictEqual(r.scan.format, before.format);
  assert.strictEqual(r.scan.format, 'script-shebang');
});

test('brain 超时：门面不挂死，回退到证据报告并说明原因', async () => {
  const root = tmpRoot('timeout-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\n'));
  const eng = new ReverseEngineer({ brain: () => new Promise(() => {}), brainTimeoutMs: 30 });
  const r = await eng.analyze(file, { authorized: true });
  assert.strictEqual(r.reconstruction.source, 'evidence-only');
  assert.match(r.reconstruction.caveats[0], /Model timed out/);
});

test('brain 输出散文：不是 JSON 就如实回退，不把猜测当结论', async () => {
  const root = tmpRoot('prose-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\n'));
  const eng = new ReverseEngineer({ brain: async () => 'looks like a script to me' });
  const r = await eng.analyze(file, { authorized: true });
  assert.strictEqual(r.reconstruction.source, 'evidence-only');
  assert.match(r.reconstruction.caveats[0], /not valid JSON/);
});

// ── 字符串证据与确定性语言推断贯通 ────────────────────────────────────────

test('工具链指纹贯通到门面：GCC 串让无模型报告也敢报 C/C++（置信度 0.5）', async () => {
  const root = tmpRoot('fingerprints-');
  const body = Buffer.concat([
    Buffer.from('#!/bin/sh\n'),
    Buffer.from('GCC: (GNU) 12.2.0 x86_64-pc-linux-gnu\n'),
    Buffer.from('https://example.org/aiohttp/x.py\n'),
  ]);
  const file = writeScript(root, 'build.sh', body);
  const r = await analyze(file, { authorized: true });
  assert.ok(r.strings.toolchains.includes('gcc'), `实测指纹=${JSON.stringify(r.strings.toolchains)}`);
  assert.ok(r.strings.classified.url.length >= 1);
  assert.strictEqual(r.reconstruction.inferredLanguage, 'C/C++');
  assert.strictEqual(r.reconstruction.confidence, 0.5);
});

test('字符串窗口只读头部：窗口大小由 env 决定，报告不许因此抛', async () => {
  const root = tmpRoot('window-');
  const file = writeScript(root, 'big.sh', Buffer.concat([Buffer.from('#!/bin/sh\n'), Buffer.alloc(4096, 0x41)]));
  const eng = new ReverseEngineer();
  const win = eng._readStringWindow(file, 16);
  assert.ok(Buffer.isBuffer(win));
  assert.ok(win.length <= 16, `窗口应被收紧，实测 ${win.length}`);
  const r = await eng.analyze(file, { authorized: true });
  assert.strictEqual(r.strings.total > 0, true);
  const missing = eng._readStringWindow(path.join(root, 'nope'), 16);
  assert.ok(Buffer.isBuffer(missing) && missing.length === 0, '读不到就交空 Buffer，绝不抛');
});

// ── 门面导出的稳定性 ─────────────────────────────────────────────────────

test('门面再导出五个子模块 + 类，工具层按名取用不会取到 undefined', () => {
  for (const key of ['scanner', 'stringHarvester', 'sourceRecoverer', 'toolOrchestrator', 'reconstructionPort', 'ledger']) {
    assert.strictEqual(typeof engine[key], 'object', key);
  }
  assert.strictEqual(typeof ReverseEngineer, 'function');
  assert.strictEqual(typeof analyze, 'function');
  // 便捷函数与新实例的行为逐字段一致（不许两条路径漂移）。
  const root = tmpRoot('parity-');
  const file = writeScript(root, 'run.sh', Buffer.from('#!/bin/sh\n'));
  return Promise.all([analyze(file), new ReverseEngineer().analyze(file)]).then(([a, b]) => {
    assert.deepStrictEqual(
      { ok: a.ok, authorized: a.authorized, format: a.scan.format, verdict: a.verification.verdict },
      { ok: b.ok, authorized: b.authorized, format: b.scan.format, verdict: b.verification.verdict }
    );
  });
});
