'use strict';

/**
 * painPointScanner.test.js — co-located suite for the 阻力 → 需求 perception stage.
 *
 * IO: the scanner itself performs none; every test injects a spy diagnostician so the sibling
 * selfHeal ErrorDiagnostician is only loaded in the two tests that pin the fail-open seam
 * (B31-E18). No ledger write is possible from this module, and data homes are pinned before
 * require regardless.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   B31-E17  the LOGIC_GAP fallback text contains 核心流转, so every non-diagnosable tool
 *            failure is minted as an L2 constitution edit the engine's own gate then refuses.
 *   B31-E18  `opts.diagnostician || _defaultDiagnostician()` — an injected falsy value silently
 *            loads the real selfHeal diagnostician.
 *   B31-E19  the JSDoc promises null for a meaningless signal; scan() never returns null.
 *   B31-E31  none of the four attributions the scanner mints can reach L1 on their own.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-evo-scanner-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.HOME = TMP;
process.env.XDG_CONFIG_HOME = path.join(TMP, 'config');
if (process.platform === 'win32') {
  process.env.USERPROFILE = TMP;
}

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./painPointScanner');
const evoRequirement = require('./evoRequirement');
const { PainPointScanner, WHY_KIND } = mod;

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** A deterministic stand-in for selfHeal ErrorDiagnostician; records its call protocol. */
function spyDx(result, opts = {}) {
  const calls = [];
  return {
    calls,
    diagnose(error, context) {
      calls.push([error, context]);
      if (opts.throwing) {
        throw new Error('dx exploded');
      }
      return typeof result === 'function' ? result() : result;
    },
  };
}

const scannerWith = (result, opts) => new PainPointScanner({ diagnostician: spyDx(result, opts) });
const PLAIN = { cause: '未归类', detail: 'plain detail', risk: null };

describe('painPointScanner — surface', () => {
  test('module.exports keys are exactly the two documented names', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['PainPointScanner', 'WHY_KIND']);
  });

  test('WHY_KIND is frozen with the three documented root causes plus the logic-gap fallback', () => {
    assert.equal(Object.isFrozen(WHY_KIND), true);
    assert.deepEqual(WHY_KIND, {
      MISSING_TOOL: 'missing-tool',
      RULE_MISFIRE: 'rule-misfire',
      THRESHOLD_RIGID: 'threshold-rigid',
      LOGIC_GAP: 'logic-gap',
    });
  });

  test('construction works with no argument at all', () => {
    assert.equal(new PainPointScanner().constructor.name, 'PainPointScanner');
  });
});

describe('painPointScanner — signal → attribution mapping', () => {
  test('the three non-tool signals get their documented deterministic 归因', () => {
    const s = scannerWith(PLAIN);
    const block = s.scan({ signal: 'interceptor-block', surface: 'guard', error: 'e' });
    assert.equal(block.signal, 'interceptor-block');
    assert.equal(block.attribution.kind, 'rule-misfire');
    assert.match(block.attribution.why, /疑似规则误杀/);

    const loss = s.scan({ signal: 'compression-loss', surface: 'compressor', error: 'e' });
    assert.equal(loss.attribution.kind, 'threshold-rigid');
    assert.match(loss.attribution.why, /压缩提取丢失了核心语义/);

    const melt = s.scan({ signal: 'context-meltdown', surface: 'window', error: 'e' });
    assert.equal(melt.attribution.kind, 'threshold-rigid');
    assert.match(melt.attribution.why, /上下文频繁熔断/);
  });

  test('the diagnosis cause is quoted into the 归因 text, so attribution stays evidence-backed', () => {
    const s = scannerWith({ cause: '依赖缺失（Node 模块 / Python 包未安装）', detail: 'd', risk: 'L1' });
    const r = s.scan({ signal: 'interceptor-block', surface: 'read-file', error: 'e' });
    assert.match(r.attribution.why, /诊断病因：依赖缺失（Node 模块 \/ Python 包未安装）。/);
  });

  test('an unrecognized signal degrades to tool-failure before attribution', () => {
    const s = scannerWith(PLAIN);
    const r = s.scan({ signal: 'made-up-signal', surface: 'x', error: 'e' });
    assert.equal(r.signal, 'tool-failure');
    assert.equal(r.attribution.kind, 'logic-gap');
  });

  test('a tool failure whose diagnosis names a capability hole maps to missing-tool', () => {
    for (const detail of [
      "Cannot find module 'x'",
      'the payload is unsupported',
      '未覆盖格式 zzz',
      '不支持该编码',
      '无法处理该输入',
      'no parser for this',
      'missing dependency',
    ]) {
      const s = scannerWith({ cause: '病因', detail, risk: 'L1' });
      const r = s.scan({ signal: 'tool-failure', surface: 'read-file', error: 'e' });
      assert.equal(r.attribution.kind, 'missing-tool', detail);
      assert.match(r.attribution.why, /能力拓扑存在空洞/);
    }
  });

  test('DEFECT B31-E17 (current behaviour): the fallback LOGIC_GAP text itself contains '
    + '"核心流转", so EVERY non-diagnosable tool failure is minted as an L2 宪法修正 — which the '
    + 'engine then refuses because no caller supplies an l2Plan', () => {
      const s = scannerWith(PLAIN);
      const r = s.scan({ signal: 'tool-failure', surface: 'read-file', error: 'e' });
      assert.equal(r.attribution.kind, 'logic-gap');
      assert.equal(r.attribution.why, '工具调用失败且非已知可修复类——疑似核心流转逻辑死角。诊断病因：未归类。');
      assert.equal(r.level, 'L2', 'the escalation keyword sits in the engine\'s own sentence');
      assert.equal(r._l2.valid, false);
      assert.deepEqual(evoRequirement.validate(r), { valid: false, missing: ['l2Plan(architectureDiff/blastRadius)'] });

      // The same holds for any tool failure whose diagnosis is not one of the hole patterns:
      const real = new PainPointScanner({ diagnostician: { diagnose: () => ({ cause: '工具执行崩溃', detail: 'ENOENT', risk: null }) } });
      assert.equal(real.scan({ signal: 'tool-failure', surface: 'fs', error: 'e' }).level, 'L2');

      // And an empty scan (no friction at all) is also L2 rather than null:
      assert.equal(s.scan().level, 'L2');
    });

  test('DEFECT B31-E31 (current behaviour): not one of the four attributions the scanner mints '
    + 'reaches L1 on its own text — the L1 tier is only reachable when the CALLER happens to put '
    + 'a matching phrase into `surface`, so the "new tool needed" tier is unreachable by design', () => {
      const levels = {};
      for (const signal of ['interceptor-block', 'tool-failure', 'compression-loss', 'context-meltdown']) {
        for (const dx of [
          PLAIN,
          null,
          { cause: '病因', detail: "Cannot find module 'x'", risk: 'L1' },
          { cause: '依赖缺失', detail: 'unsupported', risk: 'L1' },
        ]) {
          const r = scannerWith(dx || PLAIN).scan({ signal, surface: 'read-file', error: 'e' });
          levels[r.level] = (levels[r.level] || 0) + 1;
        }
      }
      assert.equal(levels.L1, undefined, 'no combination produced L1');
      assert.deepEqual(Object.keys(levels).sort(), ['L0', 'L2']);

      // L1 appears only via the free-text surface supplied by the friction producer:
      const s = scannerWith(PLAIN);
      assert.equal(s.scan({ signal: 'interceptor-block', surface: '缺少工具', error: 'e' }).level, 'L1');
      assert.equal(s.scan({ signal: 'tool-failure', surface: '缺少工具', error: 'e' }).level, 'L2', 'L2 keywords win over L1');
      assert.equal(s.scan({ signal: 'tool-failure', surface: 'missing tool', error: 'e' }).level, 'L2');
      assert.equal(s.scan({ signal: 'interceptor-block', surface: 'missing tool', error: 'e' }).level, 'L1');
    });
});

describe('painPointScanner — diagnostician call protocol', () => {
  test('diagnose is called once with (error, context || {})', () => {
    const dx = spyDx({ cause: '诊断因', detail: 'd', risk: 'L0' });
    const s = new PainPointScanner({ diagnostician: dx });
    const err = new Error('boom');
    s.scan({ signal: 'tool-failure', error: err, context: { tool: 't1', sessionId: 's1' } });
    assert.equal(dx.calls.length, 1);
    assert.equal(dx.calls[0][0], err, 'the raw error object is forwarded untouched');
    assert.deepEqual(dx.calls[0][1], { tool: 't1', sessionId: 's1' });

    dx.calls.length = 0;
    s.scan({ signal: 'tool-failure', error: 'plain string' });
    assert.deepEqual(dx.calls[0][1], {}, 'a missing context becomes an empty object');
  });

  test('the diagnostician is skipped when error is null or undefined, but consulted for other falsy errors', () => {
    const dx = spyDx(PLAIN);
    const s = new PainPointScanner({ diagnostician: dx });
    s.scan({ signal: 'tool-failure', surface: 'a' });
    s.scan({ signal: 'tool-failure', surface: 'b', error: null });
    assert.equal(dx.calls.length, 0, '`friction.error != null` gate');
    s.scan({ signal: 'tool-failure', surface: 'c', error: 0 });
    s.scan({ signal: 'tool-failure', surface: 'd', error: '' });
    assert.equal(dx.calls.length, 2, '0 and "" are consulted even though they carry no text');
  });

  test('a diagnostician that throws is swallowed and the scan still mints a requirement', () => {
    const s = new PainPointScanner({ diagnostician: { diagnose: () => { throw new Error('dx exploded'); } } });
    const r = s.scan({ signal: 'tool-failure', surface: 'boom-surface', error: 'e' });
    assert.equal(r.attribution.kind, 'logic-gap');
    assert.match(r.attribution.why, /诊断病因：未归类失败。/);
    assert.equal(r.painPoint, 'boom-surface 遭遇阻力', 'with no diagnosis there is no cause to name');
  });

  test('a diagnosis of null or {} falls back to the per-signal "未归类" wording', () => {
    assert.match(
      scannerWith(null).scan({ signal: 'interceptor-block', error: 'e' }).attribution.why,
      /诊断病因：未归类阻断。/
    );
    assert.equal(
      scannerWith(() => null).scan({ signal: 'compression-loss', error: 'e' }).attribution.kind,
      'threshold-rigid'
    );
  });

  test('DEFECT B31-E18 (current behaviour): `opts.diagnostician || _defaultDiagnostician()` means '
    + 'an injected falsy value loads the REAL selfHeal diagnostician instead of the "none" the '
    + 'caller asked for', () => {
      for (const injected of [null, undefined, false, 0, '']) {
        const s = new PainPointScanner({ diagnostician: injected });
        assert.equal(
          s.diagnostician.constructor.name,
          'ErrorDiagnostician',
          `injected ${JSON.stringify(injected)} did not stay injected`
        );
      }
      // The real diagnostician is evidence-backed and read-only, so containment holds: it merely
      // means "inject a null" cannot be used to run the scanner without selfHeal.
      const real = new PainPointScanner({ diagnostician: null });
      const r = real.scan({
        signal: 'tool-failure',
        surface: 'read-file',
        error: new Error("Cannot find module 'x'"),
        context: { tool: 'read-file' },
      });
      assert.equal(r.attribution.kind, 'missing-tool');
      assert.match(r.painPoint, /^read-file：/);
      assert.equal(r.level, 'L0', 'and the missing-tool wording itself only reaches L0');
    });

  test('the default diagnostician is memoized on the module, so a failed require would stick', () => {
    // Reading-verified companion fact (evoLedger-style cache): _defaultDiagnostician caches
    // `undefined` forever once require() throws (painPointScanner.js:36) and the module exposes
    // no reset hook. Not reproduced here: forcing a require failure needs module-cache surgery
    // inside another unit, which would leak into sibling suites running in the same process.
    const a = new PainPointScanner({ diagnostician: null });
    const b = new PainPointScanner({ diagnostician: null });
    assert.equal(a.diagnostician, b.diagnostician, 'same cached instance across instances');
  });
});

describe('painPointScanner — pain point, surface and impact composition', () => {
  test('surface falls back to context.tool, then to the empty string, and is truncated to 300', () => {
    const s = scannerWith(PLAIN);
    assert.equal(s.scan({ signal: 'tool-failure', error: 'e', context: { tool: 'ctx-tool' } }).attribution.surface, 'ctx-tool');
    assert.equal(s.scan({ signal: 'tool-failure', error: 'e', surface: 'given', context: { tool: 'ctx-tool' } }).attribution.surface, 'given');
    assert.equal(s.scan({ signal: 'tool-failure', error: 'e' }).attribution.surface, '');
    assert.equal(s.scan({ signal: 'tool-failure', error: 'e', surface: 'S'.repeat(500) }).attribution.surface.length, 300);
  });

  test('painPoint precedence: explicit > "<surface>：<cause>" > "<surface|运行态> 遭遇阻力"', () => {
    const s = scannerWith({ cause: '病因X', detail: 'd', risk: 'L0' });
    assert.equal(s.scan({ signal: 'tool-failure', error: 'e', painPoint: '人类写的痛点' }).painPoint, '人类写的痛点');
    assert.equal(s.scan({ signal: 'tool-failure', error: 'e', surface: 'read-file' }).painPoint, 'read-file：病因X');
    assert.equal(s.scan({ signal: 'tool-failure', error: 'e' }).painPoint, '运行态：病因X');
    const blind = scannerWith(null);
    assert.equal(blind.scan({ signal: 'tool-failure', error: 'e' }).painPoint, '运行态 遭遇阻力');
    assert.equal(blind.scan({ signal: 'tool-failure', error: 'e', surface: 'fs' }).painPoint, 'fs 遭遇阻力');
  });

  test('impact is the diagnosis risk when L2, else a per-signal conservative estimate', () => {
    assert.equal(
      scannerWith({ cause: 'c', detail: 'd', risk: 'L2' }).scan({ signal: 'interceptor-block', error: 'e' }).impact,
      '高：触及不可本地修复的系统性风险，可能波及核心流转。'
    );
    assert.match(
      scannerWith({ cause: 'c', detail: 'd', risk: 'L1' }).scan({ signal: 'compression-loss', error: 'e' }).impact,
      /^中：影响长链路任务的记忆完整性与续航/
    );
    assert.match(
      scannerWith({ cause: 'c', detail: 'd', risk: 'L1' }).scan({ signal: 'context-meltdown', error: 'e' }).impact,
      /^中：影响长链路任务的记忆完整性与续航/
    );
    assert.match(
      scannerWith({ cause: 'c', detail: 'd', risk: 'L0' }).scan({ signal: 'interceptor-block', error: 'e' }).impact,
      /^中：误杀阻断正常任务推进/
    );
    assert.match(
      scannerWith({ cause: 'c', detail: 'd', risk: null }).scan({ signal: 'tool-failure', error: 'e' }).impact,
      /^低-中：当前任务受阻/
    );
  });

  test('an explicit impact wins, and modules/criteria are forwarded to the forge untouched', () => {
    const s = scannerWith(PLAIN);
    const r = s.scan({
      signal: 'tool-failure',
      error: 'e',
      impact: '自定义影响',
      proposedModules: ['parser/x'],
      acceptanceCriteria: ['能解析该格式'],
    });
    assert.equal(r.impact, '自定义影响');
    assert.deepEqual(r.proposedModules, ['parser/x']);
    assert.deepEqual(r.acceptanceCriteria, ['能解析该格式']);
  });

  test('an l2Plan supplied on the friction is forwarded and can satisfy 防呆②', () => {
    const s = scannerWith({ cause: '压缩丢失', detail: 'compress', risk: 'L2' });
    const bare = s.scan({ signal: 'compression-loss', error: 'e', surface: 'compressor' });
    assert.equal(bare.level, 'L2');
    assert.equal(bare.l2Valid, false);
    const planned = s.scan({
      signal: 'compression-loss',
      error: 'e',
      surface: 'compressor',
      l2Plan: { architectureDiff: '压缩管线由单段改为分段记忆', blastRadius: '波及所有长链路任务的记忆完整性' },
    });
    assert.equal(planned.l2Valid, true);
    assert.equal(planned.executionLevel, 'L0', 'even a valid L2 plan is force-downgraded');
    assert.equal(planned.validationSteps, 3);
    assert.equal(evoRequirement.validate(planned).valid, true);
  });
});

describe('painPointScanner — output contract', () => {
  test('DEFECT B31-E19 (current behaviour): the JSDoc at painPointScanner.js:96 promises null for a '
    + 'meaningless signal, but scan() always returns a requirement — which makes the `!req` half of '
    + 'frictionBridge.js:84 dead code and gives every meaningless friction the SAME id', () => {
      const s = scannerWith(PLAIN);
      assert.notEqual(s.scan(), null);
      assert.notEqual(s.scan({}), null);
      assert.equal(s.scan({}).id, 'evo_c79cd71920d82c61');
      assert.equal(s.scan().id, s.scan({}).id, 'every empty friction dedups to one observation');
      assert.equal(s.scan({}).level, 'L2', 'a meaningless friction becomes an unusable L2 demand');
      assert.deepEqual(evoRequirement.validate(s.scan({})).missing, ['l2Plan(architectureDiff/blastRadius)']);
    });

  test('the minted object is always a structurally valid EvoRequirement, except for the two '
    + 'attributions whose own wording trips the L2 keyword (B31-E17 and 压缩 loss)', () => {
      const s = scannerWith({ cause: 'c', detail: 'd', risk: 'L0' });
      for (const signal of ['interceptor-block', 'compression-loss', 'context-meltdown', 'tool-failure']) {
        const r = s.scan({ signal, surface: 'span', error: 'e' });
        const verdict = evoRequirement.validate(r);
        if (signal === 'tool-failure' || signal === 'compression-loss') {
          assert.deepEqual(
            verdict.missing,
            ['l2Plan(architectureDiff/blastRadius)'],
            `${signal} is minted as an unplanned L2 (B31-E17 family)`,
          );
        } else {
          assert.deepEqual(verdict, { valid: true, missing: [] }, signal);
        }
        assert.equal(r.signature, r.id);
        assert.equal(typeof r.executionLevel, 'string');
        assert.equal(typeof r.validationSteps, 'number');
      }
    });

  test('repeated friction produces a stable id, so downstream fuse counting is meaningful', () => {
    const s = scannerWith({ cause: 'c', detail: 'd', risk: null });
    const a = s.scan({ signal: 'tool-failure', surface: 'read-file', error: 'e' });
    const b = s.scan({ signal: 'tool-failure', surface: 'read-file', error: 'e' });
    assert.equal(a.id, b.id);
    assert.notEqual(a.id, s.scan({ signal: 'tool-failure', surface: 'write-file', error: 'e' }).id);
  });
});
