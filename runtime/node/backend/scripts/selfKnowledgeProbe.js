#!/usr/bin/env node
'use strict';

/**
 * selfKnowledgeProbe.js — 一条命令证明四个「自知识」机制真的生效（只读:不写任何文件）。
 *
 * 四个机制(2026-10-13 整合;设计文档 [DESIGN-ARCH-186]):
 *   1. 确信度校准     confidenceCalibration    — 门控 KHY_CONFIDENCE_CALIBRATION
 *   2. 线索保全       clueVault                — 门控 KHY_CLUE_VAULT
 *   3. 文档 vs 实测   docVsMeasuredPolicy      — 门控 KHY_DOC_VS_MEASURED
 *   4. 延迟工具召回词表 deferredRecallIndex    — 门控 KHY_TOOL_RECALL_INDEX
 *
 * 每个机制断言两件事(接缝级,不是叶子自证):
 *   ON : 对应系统提示块真的出现。前三个走 selfProfile.formatForSystemPrompt 的 A 层接缝;
 *        第四个走 khyUpgradeRuntime.makeSystemPrompt 的 `# Additional Tools` 段。
 *   OFF: 该块逐字节消失。前三个 = 叶子返 '' 且接缝输出 === 开态去掉该块(逐字节回退);
 *        第四个 = 回退为历史裸名清单,且接缝处该段首字节起与历史清单逐字节相等
 *        (该块在门控设计上不是「留白」,而是「回退到没有词表的历史形态」)。
 *
 * 另附登记面与阶段面:四个门控必须在 utils/flagRegistry 登记(default-on/CANON)、四个机制
 * 必须在 FEATURE-OWNERSHIP.json 的 rollout.mechanisms 登记(S1 + rollback + executorStage),
 * 且四个叶子的阶段常量 == 'S1'(登记与代码不许漂移)。
 *
 * 任一条不成立 → 逐条打印 [FAIL](点名失效的是哪一条)并 exit 1;全绿 → exit 0。
 * 契约:只读;运行期间只动这四个门控的 env 并在结束时逐项还原;单个检查抛错不影响其余检查。
 */

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..', '..', '..');
const SERVICES = path.join(BACKEND_ROOT, 'src', 'services');

const GATES = Object.freeze([
  'KHY_CONFIDENCE_CALIBRATION',
  'KHY_CLUE_VAULT',
  'KHY_DOC_VS_MEASURED',
  'KHY_TOOL_RECALL_INDEX',
]);

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
}

function runCheck(name, fn) {
  try {
    const r = fn();
    if (r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, 'ok')) {
      record(name, r.ok, r.detail);
    } else {
      record(name, r, '');
    }
  } catch (e) {
    record(name, false, 'threw: ' + ((e && e.message) || e));
  }
}

// 运行期间管理这四个门控的 env;结束时逐项还原(探针不改用户环境)。
function withGate(gate, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, gate);
  const prev = process.env[gate];
  if (value === undefined) {
    delete process.env[gate];
  } else {
    process.env[gate] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[gate] = prev;
    } else {
      delete process.env[gate];
    }
  }
}

const MINIMAL_PROFILE = { runtime: {}, identity: {} };
const seamPrompt = () => require(path.join(SERVICES, 'selfProfile')).formatForSystemPrompt(MINIMAL_PROFILE);

/**
 * 生成前三个机制的 4 条检查(leaf ON / leaf OFF 空 / seam ON / seam OFF 逐字节回退)。
 * @param {string} tag   检查名前缀,如 'confidence-calibration'
 * @param {string} gate  门控名
 * @param {string} marker 系统提示块定位标记
 * @param {function} formatLeaf (env) => string   叶子的注入块
 * @param {string} blockOn 门控开时的叶子块(seamPrompt 基线同源)
 * @param {string} promptOn 接缝开态系统提示
 */
function pushDirectiveChecks(tag, gate, marker, formatLeaf, blockOn, promptOn) {
  runCheck(tag + '.leaf 门控开→块出现(以标记开头且非空)', () => ({
    ok: typeof blockOn === 'string' && blockOn.length > 0 && blockOn.indexOf(marker) === 0,
  }));
  runCheck(tag + '.leaf 门控关→逐字节为空', () => {
    const off = formatLeaf({ [gate]: '0' });
    return {
      ok: off === '',
      detail: off === '' ? '' : 'gate-off leaf output is not empty (' + String(off).length + ' chars)',
    };
  });
  runCheck(tag + '.seam 门控开→系统提示含对应块', () => ({
    ok: promptOn.includes(marker),
    detail: promptOn.includes(marker) ? '' : 'marker ' + marker + ' not found in system prompt',
  }));
  runCheck(tag + '.seam 门控关→逐字节回退(输出 === 开态去掉该块)', () => {
    const off = withGate(gate, '0', seamPrompt);
    const reverted = off === promptOn.replace('\n\n' + blockOn, '');
    return {
      ok: !off.includes(marker) && reverted,
      detail: off.includes(marker)
        ? 'gate-off prompt still carries the block'
        : reverted
          ? ''
          : 'gate-off prompt differs from (on minus block) beyond the block bytes',
    };
  });
}

async function main() {
  // 探针自己控制这四个门控:先清掉(默认开),运行期间按需置 0 并还原。
  for (const g of GATES) {
    delete process.env[g];
  }

  const cc = require(path.join(SERVICES, 'confidenceCalibration'));
  const cv = require(path.join(SERVICES, 'clueVault'));
  const dvm = require(path.join(SERVICES, 'docVsMeasuredPolicy'));
  const dr = require(path.join(SERVICES, 'tool', 'deferredRecallIndex'));

  const promptOn = seamPrompt();

  console.log('selfKnowledgeProbe — 四机制门控探针(只读)');
  console.log('gates: ' + GATES.join(', '));
  console.log('');

  console.log('-- 1/4 确信度校准 (confidenceCalibration) --');
  const blockA = cc.formatForSystemPrompt({ env: {} });
  pushDirectiveChecks(
    'confidence-calibration',
    'KHY_CONFIDENCE_CALIBRATION',
    cc.CALIBRATION_MARKER,
    (env) => cc.formatForSystemPrompt({ env }),
    blockA,
    promptOn
  );

  console.log('-- 2/4 线索保全 (clueVault) --');
  const blockB = cv.formatForSystemPrompt({ env: {} });
  pushDirectiveChecks(
    'clue-vault',
    'KHY_CLUE_VAULT',
    cv.CLUE_VAULT_MARKER,
    (env) => cv.formatForSystemPrompt({ env }),
    blockB,
    promptOn
  );

  console.log('-- 3/4 文档 vs 实测 (docVsMeasuredPolicy) --');
  const blockD = dvm.formatDisciplineForSystemPrompt({ env: {} });
  pushDirectiveChecks(
    'doc-vs-measured',
    'KHY_DOC_VS_MEASURED',
    dvm.DOC_VS_MEASURED_MARKER,
    (env) => dvm.formatDisciplineForSystemPrompt({ env }),
    blockD,
    promptOn
  );

  console.log('-- 4/4 延迟工具召回词表 (deferredRecallIndex) --');
  runCheck('tool-recall.leaf 门控开→词表行出现(.- Name: 词)', () => {
    const tools = require(path.join(BACKEND_ROOT, 'src', 'tools'));
    const deferred = tools.getDeferredTools();
    const unrevealed = [...deferred.keys()].filter((n) => !tools.getRevealedDeferred().has(n));
    const legacy = dr.legacyHint(unrevealed);
    const on = dr.buildDeferredToolsHint(unrevealed, deferred, { env: {} });
    return {
      ok: unrevealed.length > 0 && on !== legacy && /^- .+: .+/m.test(on),
      detail:
        unrevealed.length > 0
          ? on !== legacy
            ? ''
            : 'gate-on output equals the legacy bare-name list (no vocabulary injected)'
          : 'no unrevealed deferred tools found in the live registry',
    };
  });
  runCheck('tool-recall.leaf 门控关→逐字节等于历史裸名清单', () => {
    const tools = require(path.join(BACKEND_ROOT, 'src', 'tools'));
    const deferred = tools.getDeferredTools();
    const unrevealed = [...deferred.keys()].filter((n) => !tools.getRevealedDeferred().has(n));
    const legacy = dr.legacyHint(unrevealed);
    const off = dr.buildDeferredToolsHint(unrevealed, deferred, { env: { KHY_TOOL_RECALL_INDEX: '0' } });
    return { ok: off === legacy, detail: off === legacy ? '' : 'gate-off output is not byte-identical to legacy' };
  });

  const kr = require(path.join(SERVICES, 'khyUpgradeRuntime'));
  const mkPrompt = () => kr.makeSystemPrompt('', { model: 'deepseek-chat', adapter: 'api' }, [], {});
  const toolsRef = require(path.join(BACKEND_ROOT, 'src', 'tools'));
  const deferredRef = toolsRef.getDeferredTools();
  const unrevealedRef = [...deferredRef.keys()].filter((n) => !toolsRef.getRevealedDeferred().has(n));
  const legacyRef = dr.legacyHint(unrevealedRef);
  let hintOn = '';
  try {
    hintOn = dr.buildDeferredToolsHint(unrevealedRef, deferredRef, { env: {} });
  } catch {
    hintOn = '';
  }
  const vocabLine = hintOn.split('\n').find((l) => l.startsWith('- ')) || '';

  try {
    const promptCOn = await withGate('KHY_TOOL_RECALL_INDEX', '1', mkPrompt);
    runCheck('tool-recall.seam 门控开→提示含词表行', () => ({
      ok: vocabLine.length > 0 && typeof promptCOn === 'string' && promptCOn.includes(vocabLine),
      detail:
        vocabLine.length === 0
          ? 'no vocabulary line derivable from the leaf'
          : typeof promptCOn === 'string' && promptCOn.includes(vocabLine)
            ? ''
            : 'system prompt does not carry the derived vocabulary line',
    }));
    const promptCOff = await withGate('KHY_TOOL_RECALL_INDEX', '0', mkPrompt);
    runCheck('tool-recall.seam 门控关→该段逐字节回退为历史裸名清单', () => {
      const i = typeof promptCOff === 'string' ? promptCOff.indexOf('# Additional Tools') : -1;
      const atSeam = i >= 0 && promptCOff.slice(i).startsWith(legacyRef);
      return {
        ok: atSeam,
        detail: i < 0 ? 'seam "# Additional Tools" section missing' : atSeam ? '' : 'seam bytes differ from the legacy list',
      };
    });
  } catch (e) {
    record('tool-recall.seam 门控开→提示含词表行', false, 'makeSystemPrompt threw: ' + ((e && e.message) || e));
    record('tool-recall.seam 门控关→该段逐字节回退为历史裸名清单', false, 'makeSystemPrompt threw: ' + ((e && e.message) || e));
  }

  console.log('');
  console.log('-- 登记面与阶段面(共享登记文件不许漂移) --');
  runCheck('registry 四门控均已登记(default-on / CANON)', () => {
    const reg = require(path.join(BACKEND_ROOT, 'src', 'utils', 'flagRegistry'));
    const byName = new Map(reg.listFlags().map((f) => [f.name, f]));
    const bad = GATES.filter((g) => {
      const f = byName.get(g);
      return !f || f.mode !== 'default-on' || f.off !== 'CANON';
    });
    return { ok: bad.length === 0, detail: bad.length ? 'not registered as default-on/CANON: ' + bad.join(', ') : '' };
  });
  runCheck('registry 四叶子阶段常量均为 S1', () => {
    const stages = {
      confidenceCalibration: cc.KHY_CONFIDENCE_CALIBRATION_STAGE,
      clueVault: cv.KHY_CLUE_VAULT_STAGE,
      deferredRecallIndex: dr.KHY_TOOL_RECALL_INDEX_STAGE,
      docVsMeasuredPolicy: dvm.STAGE,
    };
    const bad = Object.entries(stages).filter(([, s]) => s !== 'S1');
    return { ok: bad.length === 0, detail: bad.length ? bad.map(([k, s]) => k + '=' + s).join(', ') : '' };
  });
  runCheck('rollout 四机制均已登记(S1 + rollback + executorStage)', () => {
    const p = path.join(REPO_ROOT, 'docs', '10_规范', 'registry', 'FEATURE-OWNERSHIP.json');
    const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const mechs = (reg.rollout && reg.rollout.mechanisms) || [];
    const ids = ['confidence-calibration', 'clue-vault', 'deferred-recall-index', 'doc-vs-measured'];
    const bad = ids.filter((id) => {
      const m = mechs.find((x) => x.id === id);
      return (
        !m ||
        m.stage !== 'S1' ||
        !String(m.rollback || '').trim() ||
        !(m.executorStage && m.executorStage.file && m.executorStage.constant)
      );
    });
    return { ok: bad.length === 0, detail: bad.length ? 'missing/malformed: ' + bad.join(', ') : '' };
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  console.log('');
  for (const r of results) {
    console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? ' — ' + r.detail : ''));
  }
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log('selfKnowledgeProbe: ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length > 0) {
    console.log('FAILED: ' + failed.map((r) => r.name).join(' | '));
    process.exit(1);
  }
  console.log('selfKnowledgeProbe: ALL GREEN (four mechanisms inject on, revert byte-exact off)');
  process.exit(0);
}

main().catch((e) => {
  console.error('selfKnowledgeProbe crashed: ' + ((e && e.stack) || e));
  process.exit(1);
});
