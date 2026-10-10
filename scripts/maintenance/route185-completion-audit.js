'use strict';

/**
 * completion-audit.js — 把 [DESIGN-ARCH-185] 的每条**可机判**判据重新跑一遍。
 *
 * 存在的理由：§16 的回执写了三十多轮，里面已经有过「写下的期望是错的」「接线在死支路」
 * 「尺子读的是不存在的字段」三类自误。回执是叙述，叙述会过期；这份脚本只做事实现场测量，
 * 每条都印出「命令 + 实测 + 判定」，不接受任何「上面某节说过 ✅」。
 *
 * 用法：npm run audit:route185-completion（= node scripts/maintenance/route185-completion-audit.js）
 * 退出码恒 0（它是审计仪器，不是门；判据不可执行的项如实标 NEEDS-TRAFFIC / OWNED-BY-HUMAN）。
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BE = path.join(ROOT, 'runtime', 'node', 'backend');
const OUT = [];

function rec(item, cmd, evidence, verdict) {
  OUT.push({ item, cmd, evidence, verdict });
}

function sh(cmd, args, cwd) {
  const r = cp.spawnSync(cmd, args, { cwd: cwd || ROOT, encoding: 'utf8', timeout: 590000 });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 探测本身死掉的三种形态必须与「零命中」可区分：spawn 失败(r.error)、超时/被杀(r.status===null)、
// grep 用法或读盘出错(status>1；0=有命中，1=无命中)。此前这些全部塌成空 stdout ⇒ n=0 ⇒ 判 PASS，
// 与 §16.4at 刚修的 CI 引用探测是同一类病（红线 R3–R10 共 7 格都走这条路）。
const PROBE_FAULTS = [];
function probeFault(r, tag) {
  if (!r.error && r.status !== null && r.status <= 1) return null;
  const why = (r.error && r.error.code) || ('status=' + r.status + ' signal=' + r.signal) || 'unknown';
  const msg = tag + ': ' + why;
  PROBE_FAULTS.push(msg);
  return msg;
}

function grepCount(pattern, paths) {
  const r = cp.spawnSync('grep', ['-rnE', pattern, ...paths, '--include=*.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
  });
  const f = probeFault(r, 'grepCount(' + pattern + ')');
  if (f) return { n: -1, sample: ['GREP-FAILED ' + f], fault: f };
  const lines = (r.stdout || '').split('\n').filter(Boolean);
  return { n: lines.length, sample: lines.slice(0, 2) };
}

// ── 1. 测试入口与守卫（现场跑，不引用历史读数）────────────────────────────
const entry = require(path.join(BE, 'package.json')).scripts['test:routing-185'].split(' ');
const entryRun = sh(entry[0], [entry[1], ...entry.slice(2)], BE);
const entryCounts = (entryRun.out.match(/# (tests|pass|fail) \d+/g) || []).join(' ');
rec('§11 特性入口', 'npm run test:routing-185',
  `文件 ${entry.length - 2} 份｜rc=${entryRun.rc}｜${entryCounts}`,
  entryRun.rc === 0 ? 'PASS' : 'FAIL');

const replayRun = sh(process.execPath, ['--test', 'scripts/ci/route-replay.test.js']);
rec('§6.3 route-replay 自测', 'npm run test:route-replay',
  (replayRun.out.match(/# (tests|pass|fail) \d+/g) || []).join(' ') + `｜rc=${replayRun.rc}`,
  replayRun.rc === 0 ? 'PASS' : 'FAIL');

for (const g of ['check-agent-rules', 'check-agent-feedback', 'check-repo-layout', 'check-rollout-stage',
  'check-flag-registry', 'check-wiring', 'check-version-sync']) {
  const args = [path.join('scripts', 'ci', g + '.js')];
  if (g.startsWith('check-agent')) args.push('--changed');
  const r = sh(process.execPath, args);
  rec(g === 'check-wiring' ? '§11 A11（replay 有门引用）' : `守卫 ${g}`,
    `node scripts/ci/${g}.js${args.includes('--changed') ? ' --changed' : ''}`,
    `rc=${r.rc} ${((r.out.match(/Summary: [^\n]*/) || [''])[0])}`.trim(),
    r.rc === 0 ? 'PASS' : 'FAIL');
}

// ── 2. 红线 R3–R10（每条都是 grep，现场重跑）─────────────────────────────
// 判据必须**分注释与代码**：本方案的红线是「不许引入实现」，注释里解释「为什么抄不动」
// 是允许的（§15 R3/R10 的原始口径就是这么写的）。第一版我拿全 src 粗 grep，
// R3 印出「154 命中」却判 PASS —— 那是判定与证据自相矛盾，属于仪器错。
const FILES_185 = [
  'runtime/node/backend/src/services/gateway/routingMode.js',
  'runtime/node/backend/src/services/gateway/routeDemand.js',
  'runtime/node/backend/src/services/gateway/autoModelRouting.js',
  'runtime/node/backend/src/services/gateway/autoModelSelect.js',
  'runtime/node/backend/src/services/gateway/routeContextSignals.js',
  'runtime/node/backend/src/services/modelPricing.js',
  'runtime/node/backend/config/models/routing-modes.json',
  'runtime/node/backend/config/models/pricing.json',
];
function grepCode(pattern, paths) {
  const r = cp.spawnSync('grep', ['-rnE', pattern, ...paths], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  const f = probeFault(r, 'grepCode(' + pattern + ')');
  // 同 grepCount：故障时 total/code 一律 -1，任何 `code === 0 ? 'PASS'` 都翻不成 PASS。
  if (f) return { total: -1, code: -1, prose: 0, codeSample: ['GREP-FAILED ' + f], fault: f };
  const all = (r.stdout || '').split('\n').filter(Boolean);
  const isProse = (l) => /\d:\s*(\/\/|\*|\/\*)/.test(l) || /注释|实测|截图|例如|e\.g\./i.test(l);
  const code = all.filter((l) => !isProse(l));
  return { total: all.length, code: code.length, codeSample: code.slice(0, 2), prose: all.length - code.length };
}

const r3 = grepCode('lightgbm|onnx|require\\(["\']child_process|python3? ', FILES_185);
const SRC = ['runtime/node/backend/src', 'scripts/ci'];
rec('R3 无 Python/LightGBM/外部分类服务', 'grep -rnE 分注释/代码（185 文件集）',
  `命中 ${r3.total}，其中注释 ${r3.prose}、代码 ${r3.code}｜代码样本 ${JSON.stringify(r3.codeSample)}`,
  r3.code === 0 ? 'PASS' : 'CHECK');

const r4 = grepCode('ensemble|aggregator|\\bk: *[2-9]', FILES_185);
rec('R4 首版不做集成路由 (K>1)', 'grep -rnE（185 文件集）',
  `命中 ${r4.total}（代码 ${r4.code}）｜providerPresets 里的 'aggregator' 是**渠道类别**，不是集成路由`,
  r4.code === 0 ? 'PASS' : 'CHECK');

const r5 = grepCode('[0-9](\\.[0-9]+)?\\s*[×xX]', FILES_185);
rec('R5 不写死成本倍率字面量', 'grep -rnE（185 文件集，分注释/代码）',
  `命中 ${r5.total}，代码 ${r5.code}｜其余为注释（如 routingMode.js:373 描述截图位置）`,
  r5.code === 0 ? 'PASS' : 'CHECK');

rec('R7 论文数字不入对外表述', "grep -rnE '99\\.96|88\\.9' src scripts",
  JSON.stringify(grepCount('99\\.96|88\\.9', SRC).sample),
  grepCount('99\\.96|88\\.9', SRC).n === 0 ? 'PASS' : 'CHECK');

rec('R8 不把 share-of-spend 当判据', "grep -rniE 'share.of.spend|spend' gateway",
  JSON.stringify(grepCount('share[- ]of[- ]spend', ['runtime/node/backend/src/services/gateway']).n),
  grepCount('share[- ]of[- ]spend', ['runtime/node/backend/src/services/gateway']).n === 0 ? 'PASS' : 'CHECK');

// R9：结果有没有被喂回打分（observeOutcome 的下游）
const r9 = grepCount('successRate|winRate|feed.*score', ['runtime/node/backend/src/services/gateway']);
rec('R9 不承诺在线学习路由器', "grep -rnE 'successRate|winRate' gateway", JSON.stringify(r9.sample),
  r9.n === 0 ? 'PASS' : 'CHECK');

// ── 3. 判据的可机判部分 ────────────────────────────────────────────────
// A3 路由开销：探针脚本存在则跑，否则如实标缺件
const probe = path.join(ROOT, 'scripts', 'ci', 'route-overhead-probe.js');
if (fs.existsSync(probe)) {
  const p = sh(process.execPath, [probe]);
  rec('A3 路由自身开销 / 零外呼', 'node scripts/ci/route-overhead-probe.js',
    (p.out.split('\n').filter(Boolean).slice(-2).join(' / ')).slice(0, 240),
    p.rc === 0 ? 'PASS' : 'CHECK');
} else {
  rec('A3 路由自身开销', '—', '探针文件不存在（scripts/ci/route-overhead-probe.js）', 'MISSING-INSTRUMENT');
}

// A8 价格真源。**设计文档 §11 的 A8 写的是 estimateCost()，全仓没有这个导出**
// （真实 API：estimateCostDetailed / resolvePrice / isCostUsable / priceCoverage），
// 所以照文档原样跑必然 TypeError —— 那是文档的命令写错了，不是功能没做。已按真实 API 量，
// 并把这个命名漂移记进 §19 的订正表。
const a8 = sh(process.execPath, ['-e', [
  "const s=require(" + JSON.stringify(path.join(BE, 'src/services/modelPricing.js')) + ");",
  // 第一版这里有两个仪器错：① 照 §11 原文调 estimateCost()（全仓无此导出，真名
  //    estimateCostDetailed）；② priceCoverage() 不传参恒回 total:0 —— 它要的是候选数组，
  //    生产调用点 autoModelRouting.js:363 传的是 candidates.map(x=>x.model)。都不算产品缺陷。
  "const x=s.estimateCostDetailed(20000,2000,'gpt-4o-mini');",
  "const y=s.estimateCostDetailed(20000,2000,'deepseek-chat');",
  "const u=s.estimateCostDetailed(20000,2000,'claude-opus-4-7');",
  "const c=s.priceCoverage(['gpt-4o-mini','deepseek-chat','glm-4-plus','gpt-4o','kimi-k2']);",
  "process.stdout.write(JSON.stringify({bothPriced:x.state==='priced'&&y.state==='priced',",
  "differ:x.costUSD!==y.costUSD, usd:[x.costUSD,y.costUSD], unkState:u.state, unkNull:u.costUSD===null,",
  "cov:{total:c.total,usable:c.usable,byState:c.byState}}));",
].join(' ')], BE);
const a8ok = /"bothPriced":true,"differ":true/.test(a8.out) && /"unkState":"unknown","unkNull":true/.test(a8.out);
rec('A8 同 token 数不同模型费用不再相等（且不可知者不得编数）', 'node -e estimateCostDetailed × 3 模型 + priceCoverage(候选数组)',
  a8.out.slice(0, 300), a8ok ? 'PASS' : 'CHECK');

// R1/§8 与 β/π 的活路径证据都在这两个文件里
for (const [item, file] of [
  ['§8 回退矩阵 ①–⑥ + R1 旁路', 'tests/gateway/routeRollbackMatrix.test.js'],
  ['§8-⑦ 能力门槛（含正对照）', 'tests/gateway/routeCapabilityGate.test.js'],
  ['§15-2 执行状态两侧闭合', 'tests/gateway/routeSoftFailE2E.test.js'],
  ['§5.2 π 生产入口 + 钉选让位钉行', 'tests/gateway/routeVerbosityLive.test.js'],
  ['§5.2 β 载体读数（写手白名单落盘）', 'src/services/gateway/autoModelRouting.test.js'],
]) {
  const r = sh(process.execPath, ['--test', file], BE);
  rec(item, `node --test ${file}`,
    (r.out.match(/# (tests|pass|fail) \d+/g) || []).join(' ') + `｜rc=${r.rc}`,
    r.rc === 0 ? 'PASS' : 'FAIL');
}

// ── 3b. §7 接线点 ①–⑭ 的「现场在位性」：文档说过「已接」不算，只看这一刻文件里有没有 ──
// 期望值取自 §16.4q 订正后的**真名**（不是 §7 计划里的名字），并把三条实质偏差写成
// 「必须不含」—— 若哪天 `switchPenalty` / `KHY_ROUTE_STICKY` 又冒出来，说明有人按计划名补了个没人读的槽。
const _rd = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; }
};
const PTS = [
  ['①', 'runtime/node/backend/config/models/routing-modes.json',
    [/economy/, /perf/, /extreme/, /strongShare/, /capabilityFloor|floor/], [], '档卡真源含四档与 strongShare（档名以卡为准：卡里是 `perf`，不是 §7 计划写的 `performance`）'],
  ['②', 'runtime/node/backend/src/services/gateway/routingMode.js',
    [/function resolveMode|resolveMode\s*[=(]/, /requestModeIntent/, /derivePromptPolicy/, /deriveThinking/, /applyEscalation/, /pinnedBypass/, /isApplyEnabled/, /listModes/],
    [/^\s*function floorOf/m], '§16.4q：floor/ceiling 是 resolveMode 的返回属性，不是 floorOf()'],
  ['③', 'runtime/node/backend/src/services/gateway/autoModelSelect.js',
    [/rankAutoModels/], [/switchPenalty/], '§14-D5 裁决阈值保持 0 ⇒ 该槽不该存在'],
  // 「不该存在」要覆盖**排序真走的那条路**：改道后来落在 autoModelRouting.rank，
  // 只扫 autoModelSelect.js 的话，有人在那边补一个没人读的 penalty 槽也不会变红。
  ['③c', 'runtime/node/backend/src/services/gateway/autoModelRouting.js',
    [/function rank|rank\s*\(/], [/switchPenalty/], '同上：排序的另一条落点'],
  ['③b', 'runtime/node/backend/src/services/gateway/autoModelRouting.js',
    [/priceCoverage|priceStates/, /require\(['"]\.\.\/modelPricing/], [], '§7-③ 写的「priceState 入参」实际落在这里（§16.4q 第 7 处漂移）'],
  ['⑤', 'runtime/node/backend/src/services/gateway/routeDemand.js',
    [/stateInputs/, /capability|capabilityRequired/], [/margin/], 'margin 只在连续打分里存在（§16.4q）'],
  ['⑥', 'runtime/node/backend/src/services/gateway/aiGatewayGenerateMethod.js',
    [/autoModelRouting/, /_routeHasImage/, /routingMode/], [], 'auto 分支的模式轴（行号不钉）'],
  ['⑦', 'runtime/node/backend/src/services/gateway/autoModelRouting.js',
    [/turnId/, /observeSelection/, /observeOutcome|beginTurn/], [], 'P3 join key 与观测两侧'],
  ['⑧', 'runtime/node/backend/src/services/modelTier.js',
    [/harnessProfile/, /modeIntent/], [/resolveHarnessProfile/], '§16.4q：真名 harnessProfile(tier, opts.modeIntent)'],
  ['⑨', 'runtime/node/backend/src/services/gateway/autoModelSelect.js', [/buildModeChoices/], [], '四行选择器供数'],
  ['⑩', 'runtime/node/backend/src/cli/handlers/gatewayModelChoices.js', [/buildModeChoices/], [], '供数点确实调到 ⑨'],
  ['⑪', 'runtime/node/backend/src/cli/handlers/gateway.js', [/GATEWAY_ROUTING_MODE/, /persistGatewayPreference/], [], '持久化回路写档位键'],
  ['⑫', 'runtime/node/backend/config/models/pricing.json', [/"families"/, /"match"/, /"price"/], [], '价格真源是新文件而非 features.json'],
  ['⑫b', 'runtime/node/backend/src/services/tokenPricing.js', [/pricing\.json|require\(.*pricing/, /priceState/], [], 'estimateCost 委托真源并给三态'],
  ['⑬', 'runtime/node/backend/src/utils/flagRegistry/index.js', [/KHY_ROUTING_MODES/, /KHY_ROUTE_DEMAND/], [/KHY_ROUTE_STICKY/], '⑬ 故意不登记 sticky（E1）'],
  ['⑭', 'scripts/ci/route-replay.js', [/turnId/, /strongShare|capability/, /margin/], [], '读数侧消费 join key、目标占比与 margin 分布（§16.4ak）'],
];
const ptProblems = [];
for (const [no, rel, must, mustNot] of PTS) {
  const txt = _rd(rel);
  if (txt === null) { ptProblems.push(`${no} 文件不存在 ${rel}`); continue; }
  for (const re of must) if (!re.test(txt)) ptProblems.push(`${no} 缺 ${re.source} @ ${rel}`);
  for (const re of mustNot) if (re.test(txt)) ptProblems.push(`${no} 不该出现 ${re.source} @ ${rel}`);
}
rec('§7 接线点 ①–⑭ 现场在位性', 'node scripts/maintenance/route185-completion-audit.js（本行）',
  ptProblems.length ? `偏离 ${ptProblems.length} 处：${ptProblems.slice(0, 6).join(' ｜ ')}` : `${PTS.length} 格全在位（含「必须不含」三格）`,
  ptProblems.length ? 'FAIL' : 'PASS');

// ⑫ 的非空转检查：`models` 是精确覆盖表（可以为空，家族匹配才是主路），
// 但 `families` 一旦为空，A8 的「同 token 不同模型费用不等」就建在空表上——那正是本仓抓过的假绿形态。
const pricing = JSON.parse(_rd('runtime/node/backend/config/models/pricing.json'));
rec('§7-⑫ 价格表不是空表', 'node -e "require(config/models/pricing.json)"',
  `families ${pricing.families.length} 条｜models 精确覆盖 ${Object.keys(pricing.models).length} 条｜unit=${pricing.unit}`,
  pricing.families.length > 0 ? 'PASS' : 'FAIL');

// ④ 单独一条：它的「偏差」是可验证的事实主张（零生产调用方），不是命名漂移。
// 尺子必须是 **require 语句**，不是名字出现次数：名字在注释与门注册表里的提及
// 不构成调用方（第一版数名字 ⇒ 报出 3 个「引用文件」全是注释，把成立的主张读成 FAIL）。
// 第二版改投 `grep -rnE "require\(…"`，在 spawnSync 下报 `Unmatched ( or \(`（本仓抓过的
// 「grep 参数被吞」形态），错误文本还被当成一条命中 ⇒ 又是一个假红。
// 现在**不经过 shell、不依赖 grep**：在 Node 里走 src/ 目录，逐文件找 require 语句。
const _walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      _walk(p, acc);
    } else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
};
const callers = _walk(path.join(BE, 'src'))
  .filter((f) => !/enhancedModelSelector(\.test)?\.js$/.test(f))
  .filter((f) => /require\(['"][^'"]*enhancedModelSelector/.test(_rd(path.relative(ROOT, f)) || ''))
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
rec('§7-④ enhancedModelSelector 仍零生产调用方', 'Node 侧走 src/ 找 require(...enhancedModelSelector)',
  `调用方 ${callers.length} 处${callers.length ? '：' + callers.join(' ｜ ') : ''}｜去留等人裁决（§20.1 证据包）`,
  callers.length === 0 ? 'DEVIATION-HOLDS' : 'FAIL');

// §16.5 的第 1 条系统级发现对本方案的直接影响：CI 跑的是 `npm run test:node`
// = `node --test tests/**/*.test.js`，只覆盖 `tests/`。入口里 8/15 份文件住在 `src/` 旁边，
// 而入口本身没有任何 workflow 引用 ⇒ 这些锁红了也不会拦下任何一次合并。
// 这里只**报可见性**，不动流水线：把 `test:routing-185` 加进 CI 是改共享门的决定（归人）。
{
  const files = require(path.join(BE, 'package.json')).scripts['test:routing-185'].trim().split(/\s+/).slice(2);
  const inSrc = files.filter((f) => f.startsWith('src/')).length;
  const inTests = files.filter((f) => f.startsWith('tests/')).length;
  let wf = '';
  // 必须用 spawnSync 而不是 execSync：execSync 在 Windows 上走 cmd，`2>/dev/null` 被当成
  // 一个不存在的路径 ⇒ cmd 在「系统找不到指定的路径」之后**根本不执行 grep**，`wf` 恒为空串，
  // 于是「引用本入口的 workflow：无」这一格在任何 OS 上都永远说实话说不说实话无从证伪
  // （本机 21:27 的合并输出里那行乱码就是它的尸体；同一命令改 spawnSync 后 status=1、stdout 真空，
  // 而换成 CI 里确实存在的 `test:node` 则返回文件列表 ⇒ 这台仪器现在才真的在测）。
  try {
    const r = cp.spawnSync('grep', ['-rl', 'test:routing-185', '.github/workflows'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const f = probeFault(r, 'CI workflow 引用探测');
    wf = f ? 'GREP-FAILED' : (r.stdout || '').trim();
  } catch {
    wf = 'GREP-FAILED';
  }
  rec('§16.5-1 本方案测试对 CI 的可见性', '解析 test:routing-185 + grep .github/workflows',
    `入口 ${files.length} 份：CI 的 \`test:node\` glob 覆盖 tests/ 下 ${inTests} 份，src/ 旁 ${inSrc} 份不在其中`
    + `｜引用本入口的 workflow：${wf === 'GREP-FAILED' ? '探测未执行(仪器故障)' : (wf || '无')}`,
    inSrc > 0 || !wf || wf === 'GREP-FAILED' ? 'COVERAGE-GAP-CI' : 'PASS');
}

// §15 R10 与「样本只追加」这两条从前只有人肉 grep 的 ✅，现在有机判形态。
// R10：外部路由器机制（NotDiamond/Martian/AutoMix/llama-router）不得被实现；注释里作旁证允许。
const r10 = sh('grep', ['-rniE', 'notdiamond|martian|llama-?router|automix', 'runtime/node/backend/src/services/gateway', '--include=*.js']);
const r10Lines = (r10.out || '').split('\n').filter(Boolean);
// rc===null ⇒ spawn 都没起来；>1 ⇒ grep 自身报错。两者都必须与「零命中」分开，
// 否则这条红线在坏机器上会拿 stderr 那一行当「非注释命中」判 FAIL，或更糟判 PASS。
const r10Fault = (r10.rc === null || r10.rc > 1) ? 'R10 grep: rc=' + r10.rc : null;
if (r10Fault) PROBE_FAULTS.push(r10Fault);
const r10Code = r10Lines.filter((l) => {
  const body = l.split(':').slice(2).join(':').trim();
  return !/^\/\/|^\*|^\/\*/.test(body);
});
rec('§15 R10 不引用外部路由器机制', 'grep -rniE notdiamond|martian|llama-router|automix …/gateway',
  `命中 ${r10Lines.length} 行，其中非注释 ${r10Code.length} 行`
  + (r10Fault ? '｜探测未起来 rc=' + r10.rc : r10Code.length ? '：' + r10Code.slice(0, 3).join(' ｜ ') : '（全部是注释里的方向旁证）'),
  r10Fault ? 'PROBE-FAILED' : (r10Code.length === 0 ? 'PASS' : 'FAIL'));

// 只追加 + 裁剪不销毁：写样本的那条路径上，超限裁剪必须先把被丢的那半段归档
const amrSrc = _rd('runtime/node/backend/src/services/gateway/autoModelRouting.js') || '';
const archives = /archive\.jsonl/.test(amrSrc) && /appendFileSync\(file \+ '\.archive\.jsonl'/.test(amrSrc);
const destructive = /writeFileSync\(file, keep\.slice/.test(amrSrc) && !archives;
rec('§15 R6（对本方案账本）裁剪不销毁证据', '扫 _appendObservation 的裁剪分支是否先归档',
  `归档写 Present=${archives}｜裸裁剪 Present=${destructive}｜`
  + '锁：src/services/gateway/autoModelRouting.rotation.test.js（真实 2MB+ 夹具触发裁剪，断言热+归档=裁剪前+1 且归档首行 seq=0）',
  archives && !destructive ? 'PASS' : 'FAIL');
// ── 4. 明确不可机判的：不假装，逐条标归属 ────────────────────────────────
rec('A2 / A5 / A9 / A10 成本与成功率类', 'npm run check:route-replay -- --require-samples=20 --strict',
  '需要 ≥20 条真实任务样本；真账本现为 24 行全是接线前 ev:"failure"，select 0 行 ⇒ 分母 0'
  + '（§16.4ai：这个 `=` 形态在 2026-10-08 之前被 _arg() 静默忽略，阈值从未生效）',
  'NEEDS-TRAFFIC');
rec('§14 D1–D4 / D6–D10 / D12 人工裁决', '—',
  '阈值数字、档名定稿、词表口径、budgetRatio 来源、verifyFailed/irreversible 触发器、档默认写 reasoning_effort 归用户',
  'OWNED-BY-HUMAN');
// git 不可用时这里原先是裸 execSync ⇒ 整台审计带着栈崩掉，人拿不到任何一格的读数。
// 崩是响的，但一份报表比一次崩溃有用，所以改成显式故障态。
let g12 = '';
try {
  g12 = JSON.stringify(cp.execSync('git status --porcelain -- runtime/node/backend/src/services/tool/toolUseLoopCore.js', { cwd: ROOT, encoding: 'utf8' }).trim());
} catch (e) {
  const msg = '#12 git status: ' + (e && e.code || e && e.message || 'FAILED').toString().slice(0, 60);
  PROBE_FAULTS.push(msg);
  g12 = 'GIT-PROBE-FAILED(本项判定不可信)';
}
rec('#12 循环侧 userMessage 透传', '—',
  `闸件 toolUseLoopCore.js 现仍在他线在途：` + g12,
  'BLOCKED-BY-OTHER-LANE');
rec('#22「π 在 warm 进程失效」', 'node --test tests/gateway/routeVerbosityLive.test.js',
  '§16.4ah 三层自问后判定为探针假象：裸 node -e 绕过 bootstrap.init()，按生产启动序三轮长度全等且 intent=null ⇒ 无产品缺陷',
  'CLOSED-AS-PROBE-ARTIFACT');
// §5.5 的两个「无生产方」触发器：这是 §14-D9/D10 的已知事实，但**事实会过期**——
// 若哪天有人给 `options.verifyFailed` / `options.irreversible` 接上了写入方，
// 触发器会立刻变成活的（升档=花钱），而文档还写着「无生产方」。所以这里机判它。
// 尺子只认**写入形态**：`verifyFailed: true` / `.irreversible = …`；
// 把 `!!options.X` 往后传的透传行（消费者的正常形状）不算生产方。
const prodHits = [];
for (const f of _walk(path.join(BE, 'src'))) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  if (/\.test\.js$/.test(rel)) continue;
  const txt = _rd(rel) || '';
  txt.split('\n').forEach((line, i) => {
    const t = line.trim();
    // 注释行不参与判定（第一版没排除，把 `// --- irreversible: the highest bar ---`
    // 这种分节注释读成「有人写入了生产方」，报出 DOC-DRIFT-RECHECK 假红）。
    if (/^(\/\/|\*|\/\*)/.test(t)) return;
    if (!/(verifyFailed|irreversible)/.test(t)) return;
    const kv = t.match(/(verifyFailed|irreversible)\s*:\s*([^,}\n]+)/);
    const asg = /\boptions\.(verifyFailed|irreversible)\s*=[^=]/.test(t);
    // 先把值**取出来**再判形态：用「负向前查 + 无主体」的正则会因回溯而恒真
    // （`verifyFailed: !!options.x` 也被算成生产方），这类错本方案已经抓过几次。
    const rhs = kv ? kv[2].trim().replace(/^!+/, '').replace(/^[([{]+/, '').trimStart() : '';
    const passthrough = kv && (/^(options|ctx|req\.|request)\b/.test(rhs) || /^(undefined|null)$/.test(kv[2].trim()));
    if (asg || (kv && !passthrough)) {
      prodHits.push(`${rel}:${i + 1} ${t.slice(0, 70)}`);
    }
  });
}
// 候选输入的名册也要跟着印：主张「没有生产方」可以成立，但「接线的工程量」会被读成「要造一个信号」。
// 实测（§16.4am）：不可逆分级已在生产里跑（riskClassifier 有 2 处 require 方），只是没喂给网关。
const reqHits = [];
for (const f of _walk(path.join(BE, 'src'))) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  if (/riskClassifier(\.test)?\.js$/.test(rel)) continue;
  if (/require\(['"][^'"]*riskClassifier/.test(_rd(rel) || '')) reqHits.push(rel);
}
rec('§5.5 触发器输入的生产方现状（§14-D9/D10）', 'Node 侧走 src/ 找 verifyFailed/irreversible 的写入形态',
  prodHits.length ? `出现 ${prodHits.length} 处写入方：${prodHits.slice(0, 4).join(' ｜ ')}`
    : `写入方 0 处（consumer/透传在 routingMode.js:477/481 与 aiGatewayGenerateMethod.js:2772-2773）⇒ 文档「无生产方」仍成立`
    + `｜候选输入已在生产里：require(riskClassifier) ${reqHits.length} 处（${reqHits.join(' , ') || '无'}）`,
  prodHits.length ? 'DOC-DRIFT-RECHECK' : 'KNOWN-GAP-D9-D10');
rec('§16.4x 存证寻址合同', 'node scripts/ci/check-agent-feedback.js --changed',
  '默认读 works/data/khy/feedback/adhoc（不存在），同级 346 个 task-id 目录；点名已落，改调用约定归 PROCESS-008',
  'PARTIAL-OWNED-BY-HUMAN');

// §16.4au：把「这条锁被证明过能红吗」变成机判项，而不是靠我记得哪几把控制打过哪个靶。
// 判据可查：入口里的测试文件名有没有出现在变异控制脚本中（被当过靶子）。
// 没出现**不等于**测试无效，只等于它从未被展示过能红 —— 而本方案最贵的一类假绿正是
// 「跑过了、绿了、但没人证明它会红」（§16.6 第 5 变体）。
{
  const CTL = path.join(ROOT, 'scripts', 'maintenance', 'route185-mutation-controls.js');
  const entryFiles = entry.slice(2).filter((f) => f.endsWith('.js'));
  let ctlSrc = '';
  let ctlFault = null;
  try {
    ctlSrc = fs.readFileSync(CTL, 'utf8');
    if (!/audit:route185-mutations/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))) {
      ctlFault = '控制脚本没接进 npm 入口';
    }
  } catch (e) {
    ctlFault = '控制脚本读不到: ' + (e && e.code || e);
  }
  const covered = entryFiles.filter((f) => ctlSrc.includes(path.basename(f)));
  const bare = entryFiles.filter((f) => !ctlSrc.includes(path.basename(f)));
  rec('§16.4au 锁的可复跑控制覆盖（仓内有没有靶子）', '入口文件名 × route185-mutation-controls.js 的靶子清单',
    ctlFault ? 'PROBE-FAILED ' + ctlFault
      : `入口 ${entryFiles.length} 份：仓内有可原样重跑的变异靶子的 ${covered.length} 份｜其余 ${bare.length} 份的「能红」`
        + '只在会话里临时展示过（M1–M36 那类一次性对照，跑完即弃）或压根没展示过，仓库里没有靶子：'
        + bare.slice(0, 8).map((f) => path.basename(f)).join(', ') + (bare.length > 8 ? ' …' : ''),
    ctlFault ? 'PROBE-FAILED' : (bare.length === 0 ? 'PASS' : 'COVERAGE-GAP-CONTROLS'));
}

// ── 输出 ──
// 仪器自检行（§16.4at 之后新增，第 35 项）：探测本身死了必须单独出声。
// 没有它时，一次 spawn 失败只会把某格的证据串变成「命中 0」，而判级式读不出那是坏消息 ——
// 记分板全绿、其中一格其实从未测量。
rec('探测存活自检（grep 族）', 'PROBE_FAULTS 汇总（grepCount / grepCode / R10 / CI 引用探测）',
  PROBE_FAULTS.length ? PROBE_FAULTS.slice(0, 4).join(' / ')
    : '全部存活：无 spawn 失败、无超时、无 grep 用法错误(status>1)',
  PROBE_FAULTS.length ? 'PROBE-FAILED' : 'PASS');

const w = (s, n) => String(s).padEnd(n);
process.stdout.write(w('项', 34) + w('判定', 24) + '实测\n');
process.stdout.write('-'.repeat(110) + '\n');
for (const r of OUT) {
  process.stdout.write(w(r.item, 34) + w(r.verdict, 24) + String(r.evidence).slice(0, 260) + '\n');
}
const tally = OUT.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] || 0) + 1), a), {});
process.stdout.write('-'.repeat(110) + `\n合计 ${OUT.length} 项：${JSON.stringify(tally)}\n`);
