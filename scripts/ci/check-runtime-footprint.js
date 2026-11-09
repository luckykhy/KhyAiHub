#!/usr/bin/env node
/**
 * check-runtime-footprint.js — 运行时重量预算守卫
 *
 * 契约真源：docs/10_规范/registry/CORE-LAYERS.json 的 `runtimeFootprint` 段
 *
 * ## 为什么要有这条守卫
 *
 * 洋葱分层的重量轴此前只有**静态**度量（`check-core-layers.js` 测冷闭包）。
 * 但静态图是估算：「如果全加载会进多少」。运行时才是事实：「实际进了多少」。
 *
 * 实测（2026-10-30）：
 *   khy --version      静态冷闭包 3 文件 2602 行  → 运行时 11 文件 7805 行
 *   khy ai -p "hi"     静态全可达 2178 文件      → 运行时 468 文件 21 万行
 *
 * 差 80 倍，**但静态分析没有盲区**（实测盲区 = 0 个模块）——
 * 差在懒加载边于运行期被求值。两者都不可省：
 *   静态冷闭包  = 启动瞬间的重量
 *   运行时足迹  = 一条真实命令路径的总重量
 *
 * 本守卫跑真实命令、读真实 `require.cache`，与预算比对。**只许减不许增。**
 *
 * ## 用法
 *   node scripts/ci/check-runtime-footprint.js            # 检查，error 退出 1
 *   node scripts/ci/check-runtime-footprint.js --report   # 只报告，不判违规
 *   node scripts/ci/check-runtime-footprint.js --json     # 机器可读
 *   node scripts/ci/check-runtime-footprint.js --update   # 重写基线（须显式）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = process.env.KHY_REPO_LAYOUT_ROOT
  ? path.resolve(process.env.KHY_REPO_LAYOUT_ROOT)
  : path.resolve(__dirname, '..', '..');

const CONTRACT_PATH = path.join(REPO_ROOT, 'docs/10_规范/registry/CORE-LAYERS.json');
const BACKEND = path.join(REPO_ROOT, 'runtime/node/backend');
const PROBE = path.join(REPO_ROOT, 'scripts/lib/runtimeFootprint.js');

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const REPORT_ONLY = args.includes('--report');
const UPDATE = args.includes('--update');

let contract;
try {
  contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
} catch (e) {
  console.error(`[runtime-footprint] 无法读取契约 ${path.relative(REPO_ROOT, CONTRACT_PATH)}: ${e.message}`);
  process.exit(2);
}

const scenarios = (contract.runtimeFootprint && contract.runtimeFootprint.scenarios) || [];
const os = process.platform;

/**
 * 跑一个场景并采集运行时足迹。
 * 探针作为 --require 预挂，进程退出时把快照写到临时文件。
 */
function measure(scenario) {
  const outFile = path.join(
    REPO_ROOT,
    'works/data/khy/T4-transient/tmp',
    `footprint-${process.pid}-${scenario.id}.json`
  );
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
  } catch {
    /* 目录建不了就退回 stderr 模式 */
  }

  const env = {
    ...process.env,
    KHY_FOOTPRINT_OUT: outFile,
    KHY_FOOTPRINT_ROOT: BACKEND,
    KHY_FOOTPRINT_LABEL: scenario.id,
  };

  const cmd = scenario.argv || [];
  const res = spawnSync(process.execPath, ['-r', PROBE, ...cmd], {
    cwd: scenario.cwd ? path.join(REPO_ROOT, scenario.cwd) : BACKEND,
    env,
    encoding: 'utf8',
    timeout: scenario.timeoutMs || 120000,
    // 交互式命令不能有 stdin，否则会挂住
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let snap = null;
  let probeError = null;
  try {
    snap = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch {
    // 探针没写成 → 该场景本轮不可测（探针默认不写 stderr，避免污染被测命令的用户可见输出）
    snap = null;
  }
  try {
    // 探针自己失败时会留 .err 痕迹 —— 必须读出来，否则会把「探针崩了」
    // 误当成「这次没加载多少」= 重量下降，白送一次棘轮放松。
    probeError = fs.readFileSync(outFile + '.err', 'utf8');
  } catch {
    probeError = null;
  }
  try {
    fs.unlinkSync(outFile);
  } catch {
    /* 临时文件清不掉不是致命问题 */
  }
  try {
    fs.unlinkSync(outFile + '.err');
  } catch {
    /* 同上 */
  }
  return { snap, res, probeError };
}

const findings = [];
const measurements = [];

for (const scenario of scenarios) {
  if (scenario.platforms && !scenario.platforms.includes(os)) continue;
  if (!fs.existsSync(path.join(BACKEND, 'bin/khy.js'))) continue;

  const { snap, res, probeError } = measure(scenario);
  if (!snap) {
    findings.push({
      rule: 'runtime-footprint-unmeasurable',
      severity: 'warning',
      scenario: scenario.id,
      message: `场景 ${scenario.id} 未产出足迹快照（退出码 ${res ? res.status : '?'}），本轮不判`,
    });
    continue;
  }
  if (probeError) {
    // 探针自己崩了 —— 快照是残缺的，不能拿来判预算（更不能当作「重量下降」）。
    findings.push({
      rule: 'runtime-footprint-probe-error',
      severity: 'warning',
      scenario: scenario.id,
      message: `场景 ${scenario.id} 的探针自身抛错，快照残缺，本轮不判：${probeError.split('\n')[0]}`,
    });
    continue;
  }

  const budget = scenario.budget || {};
  const rec = {
    scenario: scenario.id,
    files: snap.firstPartyFiles,
    lines: snap.firstPartyLines,
    bytes: snap.firstPartyBytes,
    externalFiles: snap.externalFiles,
    externalBytes: snap.externalBytes,
    preloadedFiles: snap.preloadedFiles,
    preloadedBytes: snap.preloadedBytes,
    heapUsedMB: snap.heapUsedMB,
    rssMB: snap.rssMB,
    maxFiles: budget.maxFiles,
    maxLines: budget.maxLines,
    maxBytes: budget.maxBytes,
    maxExternalFiles: budget.maxExternalFiles,
    maxExternalBytes: budget.maxExternalBytes,
  };
  // 顶层边 / 懒加载边的重量分摊 —— 「该从哪头减」的依据。
  // 此前这些数字只写在契约里没人消费（死契约），现在进守卫输出并参与判预算。
  if (snap.coldVsLazy) {
    rec.coldVsLazy = snap.coldVsLazy;
    rec.topReachFiles = snap.coldVsLazy.topReachFiles;
    rec.topReachLines = snap.coldVsLazy.topReachLines;
    rec.lazyReachFiles = snap.coldVsLazy.lazyReachFiles;
    rec.lazyReachLines = snap.coldVsLazy.lazyReachLines;
  }
  measurements.push(rec);

  if (budget.maxFiles != null && snap.firstPartyFiles > budget.maxFiles) {
    findings.push({
      rule: 'runtime-footprint-files',
      severity: 'error',
      ...rec,
      message: `${scenario.id} 运行时加载 ${snap.firstPartyFiles} 个第一方模块 > 预算 ${budget.maxFiles}`,
    });
  }
  if (budget.maxLines != null && snap.firstPartyLines > budget.maxLines) {
    // 行数用容差：**跨会话会漂**。同一时刻内 4 次实测完全一致（波动 0），
    // 但不同的 AI 回复会走到不同的模块集合，行数会差几十行。
    // 文件数是稳定的硬预算；行数只判「显著超标」（>1%）。
    // 否则守卫会因模型返回内容不同而随机红 —— 那等于没有守卫。
    const pct = ((snap.firstPartyLines - budget.maxLines) / budget.maxLines) * 100;
    if (pct > 1) {
      findings.push({
        rule: 'runtime-footprint-lines',
        severity: 'error',
        ...rec,
        message: `${scenario.id} 运行时加载 ${snap.firstPartyLines} 行（超基线 ${pct.toFixed(2)}%，容差 1%）`,
      });
    }
  }
  if (budget.maxBytes != null && snap.firstPartyBytes > budget.maxBytes) {
    // 字节数用容差：**跨会话会漂**。同一时刻内 4 次实测完全一致（波动 0），
    // 但不同的 AI 回复会走到不同的模块集合，行数与字节数会有几十行的差异。
    // 文件数是稳定的硬预算；字节数只判「显著超标」（>5%），
    // 否则守卫会因模型返回内容不同而随机红 —— 那等于没有守卫。
    const pct = ((snap.firstPartyBytes - budget.maxBytes) / budget.maxBytes) * 100;
    if (pct > 5) {
      findings.push({
        rule: 'runtime-footprint-bytes',
        severity: 'error',
        ...rec,
        message: `${scenario.id} 运行时加载 ${snap.firstPartyBytes} 字节（超基线 ${pct.toFixed(1)}%，容差 5%）`,
      });
    }
  }
  // 外部依赖（node_modules）也是体积的一半：lite 路径实测拉了 419 个外部模块。
  // 只管第一方会漏掉「多 require 了一个重量级依赖」这类膨胀。
  if (budget.maxExternalFiles != null && snap.externalFiles > budget.maxExternalFiles) {
    findings.push({
      rule: 'runtime-footprint-external-files',
      severity: 'error',
      ...rec,
      message: `${scenario.id} 运行时加载 ${snap.externalFiles} 个外部模块 > 预算 ${budget.maxExternalFiles}`,
    });
  }
  if (budget.maxExternalBytes != null && snap.externalBytes > budget.maxExternalBytes) {
    const pct = ((snap.externalBytes - budget.maxExternalBytes) / budget.maxExternalBytes) * 100;
    if (pct > 5) {
      findings.push({
        rule: 'runtime-footprint-external-bytes',
        severity: 'error',
        ...rec,
        message: `${scenario.id} 运行时加载 ${snap.externalBytes} 字节外部依赖（超基线 ${pct.toFixed(1)}%，容差 5%）`,
      });
    }
  }

  // ── 判据：重量分摊预算（顶层边 vs 懒加载边） ──────────────────────────────
  // 「重量 = 冷闭包 + 被触发路径的懒加载边」—— 两项分别计量才知道该动哪一头：
  //   顶层边可达 = 在**模块装载期**求值的部分（动它，走这条路的命令都受益）；
  //   懒加载边可达 = 只在**被触发的路径上**求值的部分（动它，只对那条路径受益）。
  //
  // 这两个数字此前只写在契约里、无人消费（死契约）—— 契约里放了数字但没人读，
  // 就等于没有约束。现在它参与判预算。
  const weightBudgets = ((contract.runtimeFootprint || {}).weightLayers || {}).budget || {};
  const lb = weightBudgets[scenario.id];
  if (lb && rec.coldVsLazy) {
    const checks = [
      ['topReachFiles', 'maxTopReachFiles', 'runtime-weight-layer-top-files', '顶层边可达'],
      ['topReachLines', 'maxTopReachLines', 'runtime-weight-layer-top-lines', '顶层边可达'],
      ['lazyReachFiles', 'maxLazyReachFiles', 'runtime-weight-layer-lazy-files', '懒加载边可达'],
      ['lazyReachLines', 'maxLazyReachLines', 'runtime-weight-layer-lazy-lines', '懒加载边可达'],
    ];
    for (const [mKey, bKey, rule, label] of checks) {
      const max = lb[bKey];
      if (max == null) continue;
      const actual = rec[mKey];
      // 文件数零容差；行数 5% 容差（跨会话读数会漂几十行 —— 那不是膨胀）
      const tol = mKey.endsWith('Files') ? 0 : 5;
      const pct = ((actual - max) / max) * 100;
      if (pct > tol) {
        findings.push({
          rule,
          severity: 'error',
          scenario: scenario.id,
          metric: mKey,
          actual,
          max,
          message:
            `${scenario.id} 的${label} ${actual}`
            + `${mKey.endsWith('Files') ? ' 个模块' : ' 行'} > 预算 ${max}`
            + `${tol ? `（超 ${pct.toFixed(1)}%，容差 ${tol}%）` : ''}`,
        });
      }
    }
  }

  // ── 判据：归因重量闸门 ──────────────────────────────────────────────────────
  // 「重量 = 冷闭包 + 被触发路径上的懒加载边」——静态图答不了「哪条边被触发了」，
  // 运行时归因能答：一个加载者单点拽进了多少第一方重量。
  //
  // **闸门不能是入口本身**：bin/khy.js 是所有路径的根，它天然可达全部模块
  // （实测 lite 路径 444 个），但它是「按需加载的调度者」而非「重量来源」——
  // 拿它当闸门等于把「入口存在」当成违规，无法指导任何瘦身动作。
  //
  // 闸门取**非入口加载者**中拽进最多的那个。实测 lite 路径是 src/cli/ai.js
  // （直接 26 个模块 / 可达 417 个 / 17.9 万行）——它才是重量编排层。
  // 与支配树分析互相印证（cli/ai.js 支配子树 12.7 万行）。
  const gate = budget.attributionGate;
  if (gate && snap.attribution && snap.attribution.length) {
    const entryLoader = gate.excludeEntryLoader || null;
    const candidates = snap.attribution.filter((a) => a.loader !== entryLoader);
    const worst = candidates[0];
    if (worst) {
      rec.worstLoader = worst.loader;
      rec.worstReachable = worst.reachable;
      rec.worstReachableLines = worst.reachableLines;
      if (worst.loader !== gate.expectedLoader) {
        findings.push({
          rule: 'runtime-attribution-gate-moved',
          severity: 'warning',
          ...rec,
          message: `${scenario.id} 的重量闸门从 ${gate.expectedLoader} 变成了 ${worst.loader} —— 需人工判读（新闸门是否更合理）`,
        });
      }
      if (gate.maxReachable != null && worst.reachable > gate.maxReachable) {
        findings.push({
          rule: 'runtime-attribution-gate-files',
          severity: 'error',
          ...rec,
          message: `${scenario.id} 的重量闸门 ${worst.loader} 单点可达 ${worst.reachable} 个模块 > 预算 ${gate.maxReachable}`,
        });
      }
      if (gate.maxReachableLines != null && worst.reachableLines > gate.maxReachableLines) {
        // 同理：闸门的可达行数会跨会话漂（不同 AI 回复走不同模块），
        // 文件数才是稳定量。行数用 5% 容差，只拦「显著变大」。
        const pct = ((worst.reachableLines - gate.maxReachableLines) / gate.maxReachableLines) * 100;
        if (pct > 5) {
          findings.push({
            rule: 'runtime-attribution-gate-lines',
            severity: 'error',
            ...rec,
            message: `${scenario.id} 的重量闸门 ${worst.loader} 单点可达 ${worst.reachableLines} 行（超基线 ${pct.toFixed(1)}%，容差 5%）`,
          });
        }
      }
    }
  }
}

const errors = findings.filter((f) => f.severity === 'error');
const warnings = findings.filter((f) => f.severity === 'warning');

if (JSON_MODE) {
  console.log(JSON.stringify({ ok: errors.length === 0, measurements, findings }, null, 2));
  process.exit(errors.length === 0 ? 0 : 1);
}

console.log('══ 运行时重量预算检查 ══');
console.log(`契约: ${path.relative(REPO_ROOT, CONTRACT_PATH)}`);
console.log(`平台: ${os}\n`);
console.log('── 实际加载 ──');
for (const m of measurements) {
  const fPct = m.maxFiles ? ((m.files / m.maxFiles) * 100).toFixed(1) : '-';
  const lPct = m.maxLines ? ((m.lines / m.maxLines) * 100).toFixed(1) : '-';
  const ePct = m.maxExternalFiles ? ((m.externalFiles / m.maxExternalFiles) * 100).toFixed(1) : '-';
  console.log(
    `  ${m.scenario}`
  );
  console.log(
    `      第一方 模块 ${m.files}${m.maxFiles ? '/' + m.maxFiles : ''} (${fPct}%)  行 ${m.lines}${m.maxLines ? '/' + m.maxLines : ''} (${lPct}%)  字节 ${(m.bytes / 1048576).toFixed(2)}MB`
  );
  console.log(
    `      外部   模块 ${m.externalFiles}${m.maxExternalFiles ? '/' + m.maxExternalFiles : ''} (${ePct}%)  字节 ${(m.externalBytes / 1048576).toFixed(2)}MB${m.maxExternalBytes ? '/' + (m.maxExternalBytes / 1048576).toFixed(2) + 'MB' : ''}`
  );
  console.log(
    `      内存   heap ${m.heapUsedMB}MB  rss ${m.rssMB}MB`
  );
  if (m.coldVsLazy) {
    console.log(
      `      分摊   顶层边可达 ${m.topReachFiles} 文件 / ${m.topReachLines} 行`
      + `   懒加载边可达 ${m.lazyReachFiles} 文件 / ${m.lazyReachLines} 行`
    );
  }
  // 宿主预挂（NODE_OPTIONS=--require 注入）不进任何预算，但要让读数可解释：
  // 否则「探针只算到 12 个外部，守卫却说 14 个」这类差异只能靠猜。
  if (m.preloadedFiles) {
    console.log(
      `      预挂   ${m.preloadedFiles} 个 / ${(m.preloadedBytes / 1024).toFixed(1)}KB（宿主注入，不计入外部依赖）`
    );
  }
}
console.log('');
if (errors.length === 0 && warnings.length === 0) {
  console.log('✅ 运行时重量在预算内');
} else {
  for (const f of warnings) console.log(`⚠️  [${f.rule}] ${f.message}`);
  for (const f of errors) console.log(`❌ [${f.rule}] ${f.message}`);
}

if (REPORT_ONLY) {
  console.log('\n(报告态：违规不判错)');
  process.exit(0);
}

if (UPDATE) {
  for (const m of measurements) {
    const s = scenarios.find((x) => x.id === m.scenario);
    if (!s || !s.budget) continue;
    s.budget.maxFiles = m.files;
    s.budget.maxLines = m.lines;
    s.budget.maxBytes = m.bytes;
    s.budget.baselineFiles = m.files;
    s.budget.baselineLines = m.lines;
    s.budget.baselineBytes = m.bytes;
    // 外部依赖也是预算的一部分 —— 漏掉这两项会让 --update 永远对不上基线
    // （首版就踩了这个坑：更新后 external 预算仍是旧值，守卫持续报红）。
    s.budget.maxExternalFiles = m.externalFiles;
    s.budget.maxExternalBytes = m.externalBytes;
    s.budget.baselineExternalFiles = m.externalFiles;
    s.budget.baselineExternalBytes = m.externalBytes;
  }
  if (contract.runtimeFootprint) {
    contract.runtimeFootprint.measuredAt = new Date().toISOString().slice(0, 10);
    // measured 段是人读的事实快照，也必须跟着更新 —— 否则文档里的数字
    // 与预算里的数字会各说各话（首版就踩了这个坑）。
    if (!contract.runtimeFootprint.measured) contract.runtimeFootprint.measured = {};
    for (const m of measurements) {
      contract.runtimeFootprint.measured[m.scenario] = {
        files: m.files,
        lines: m.lines,
        bytes: m.bytes,
        externalFiles: m.externalFiles,
        externalBytes: m.externalBytes,
        heapUsedMB: m.heapUsedMB,
        rssMB: m.rssMB,
      };
    }
    // 重量分摊的预算与实测（顶层边 vs 懒加载边）—— 此前这段只写不读（死契约）。
    const wl = contract.runtimeFootprint.weightLayers;
    if (wl) {
      if (!wl.budget) wl.budget = {};
      for (const m of measurements) {
        if (!m.coldVsLazy) continue;
        const b = wl.budget[m.scenario] || (wl.budget[m.scenario] = {});
        b.maxTopReachFiles = m.topReachFiles;
        b.maxTopReachLines = m.topReachLines;
        b.maxLazyReachFiles = m.lazyReachFiles;
        b.maxLazyReachLines = m.lazyReachLines;
        b.baselineTopReachFiles = m.topReachFiles;
        b.baselineTopReachLines = m.topReachLines;
        b.baselineLazyReachFiles = m.lazyReachFiles;
        b.baselineLazyReachLines = m.lazyReachLines;
      }
    }
  }
  fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n', 'utf8');
  console.log(`\n基线已更新 → ${path.relative(REPO_ROOT, CONTRACT_PATH)}`);
}

process.exit(errors.length === 0 ? 0 : 1);
