#!/usr/bin/env node
'use strict';

/**
 * route185-mutation-controls.js — 六把「新测能不能红」的变异对照（§16.4ai / §16.4ak / §16.4al / §16.4an / §16.4at / §16.4au）。
 *
 * 存在的理由：本方案反复出现同一种错——仪器全绿，但它测的东西根本不成立。
 * 一句「测试过了」不算证据，**把被测代码改坏、看那行断言变红**才算。
 * 这里放六把当场用过的变异对照，都能原样重跑（打印的「几把」由 lines.length 得出，不手写——
 * §16.4ai/at 就在这类计数上漂移过两次）：
 *   1) `_arg()` 的 `--name=value` 分支 —— 摘掉后 `--require-samples=2` 必须变成「静默忽略」；
 *   2) `route-replay` 的 margin 累加 —— 摘掉后 margin 那两行测必须变红；
 *   3) `route-replay` 的 escalateReason 累加 —— 摘掉后触发器那两行测必须变红；
 *   4) `route-replay` 的 flag_rules 命中累加 —— 摘掉后 flag 那两行测必须变红。
 *   5) 完成度审计器的探测故障分支 —— 摘掉后四种死法必须退回「命中 0」（旧行为），
 *      而真件必须读成 -1 且合法零命中仍是 0（防修法过紧）。测的是审计器自己。
 *   6) `autoModelSelect.headRevert` 的「默认路径与 HEAD 逐字节一致」锁 —— 先跑未变异基线（必须 0 红），
 *      再把现行侧输出反置（临时件里编译，仓库里的模块一个字节不动），必须恰红 8 条 = 2 池 × 4 任务。
 * 变异件写进 `os.tmpdir()` 用完即删，仓库里不落任何副本。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REPLAY = path.join(ROOT, 'scripts', 'ci', 'route-replay.js');
const REPLAY_TEST = path.join(ROOT, 'scripts', 'ci', 'route-replay.test.js');
const BE = path.join(ROOT, 'runtime', 'node', 'backend');

const FIXTURE = [
  JSON.stringify({ ev: 'select', v: 1, pid: '9', turnId: '9:s:1', rec: { tier: 'T1' }, legacy: {} }),
  JSON.stringify({ ev: 'outcome', v: 1, pid: '9', turnId: '9:s:1', ok: true, priceState: 'priced', costUSD: 0.01 }),
].join('\n') + '\n';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route185-mutations-'));
const lines = [];
let allOk = true;

const run = (file, args) =>
  execFileSync(process.execPath, [file, ...args], { cwd: ROOT, encoding: 'utf8' });

try {
  // ── 控制 1：_arg 的 `=` 形态 ──────────────────────────────────────────
  const src = fs.readFileSync(REPLAY, 'utf8');
  const EQ = "  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));\n  if (eq !== undefined) return eq.slice(`--${name}=`.length);\n";
  const ledger = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(ledger, FIXTURE, 'utf8');
  if (!src.includes(EQ)) {
    lines.push('argform ｜ 变异未适用：源码里找不到 `=` 分支（_arg 已被改写，本控制需同步订正）');
    allOk = false;
  } else {
    const mutant = path.join(dir, 'replay.no-eq-arg.js');
    fs.writeFileSync(mutant, src.replace(EQ, ''), 'utf8');
    const hit = (out) => (/未达标（实际 1）/.test(out) ? '阈值生效' : '阈值被静默忽略');
    // 阈值取 2 而样本只有 1 条：达标就不报，两臂会同报「静默忽略」⇒ 空对照
    const mEq = hit(run(mutant, ['--file', ledger, '--require-samples=2']));
    const mSp = hit(run(mutant, ['--file', ledger, '--require-samples', '2']));
    const rEq = hit(run(REPLAY, ['--file', ledger, '--require-samples=2']));
    const rSp = hit(run(REPLAY, ['--file', ledger, '--require-samples', '2']));
    const ok = mEq === '阈值被静默忽略' && mSp === '阈值生效' && rEq === '阈值生效' && rSp === '阈值生效';
    if (!ok) allOk = false;
    lines.push(`argform ｜ 变异件 =形态:${mEq}/空格:${mSp} → 真件 =形态:${rEq}/空格:${rSp} ⇒ ${ok ? '红绿如预期' : '不如预期（控制失效）'}`);
  }

  // ── 控制 2：route-replay 的 margin 累加 ───────────────────────────────
  const src2 = fs.readFileSync(REPLAY, 'utf8');
  if (!/\/\/ margin 三格分开/.test(src2)) {
    lines.push('margin  ｜ 变异未适用：找不到 margin 累加块');
    allOk = false;
  } else {
    const mutant2 = path.join(dir, 'replay.no-margin.js');
    fs.writeFileSync(
      mutant2,
      src2.replace(/    \/\/ margin 三格分开[\s\S]*?\n    \}\n  \}/, '    // MUTANT: margin 累加被摘掉\n  }'),
      'utf8'
    );
    const testMut = path.join(dir, 'route-replay.test.js');
    fs.writeFileSync(
      testMut,
      fs.readFileSync(REPLAY_TEST, 'utf8').replace(
        "const TOOL = path.join(__dirname, 'route-replay.js');",
        `const TOOL = ${JSON.stringify(mutant2)};`
      ),
      'utf8'
    );
    let out = '';
    try {
      out = execFileSync(process.execPath, ['--test', testMut], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
    }
    const red = (out.match(/^not ok \d+ - margin.*$/gm) || []);
    const ok2 = red.length === 2;
    if (!ok2) allOk = false;
    lines.push(`margin  ｜ 摘掉累加后变红的 margin 测 ${red.length} 条（预期 2）⇒ ${ok2 ? '这两行是真锁' : '至少一行是恒绿空话'}`);
  }
  // ── 控制 3：route-replay 的升档触发器命中累加 ─────────────────────────
  const src3 = fs.readFileSync(REPLAY, 'utf8');
  if (!/\/\/ 触发器命中逐条数/.test(src3)) {
    lines.push('reasons ｜ 变异未适用：找不到 escalateReason 累加块');
    allOk = false;
  } else {
    const mutant3 = path.join(dir, 'replay.no-reasons.js');
    fs.writeFileSync(
      mutant3,
      src3.replace(
        /    \/\/ 触发器命中逐条数[\s\S]*?\n    \}\n  \}/,
        '    // MUTANT: reasons 累加被摘掉\n  }'
      ),
      'utf8'
    );
    const testMut3 = path.join(dir, 'route-replay.r.test.js');
    fs.writeFileSync(
      testMut3,
      fs.readFileSync(REPLAY_TEST, 'utf8').replace(
        "const TOOL = path.join(__dirname, 'route-replay.js');",
        `const TOOL = ${JSON.stringify(mutant3)};`
      ),
      'utf8'
    );
    let out3 = '';
    try {
      out3 = execFileSync(process.execPath, ['--test', testMut3], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      out3 = (e.stdout || '') + (e.stderr || '');
    }
    const red3 = (out3.match(/^not ok \d+ - (升档触发器|声明了却零命中).*$/gm) || []);
    const ok3 = red3.length === 2;
    if (!ok3) allOk = false;
    lines.push(`reasons ｜ 摘掉累加后变红的触发器测 ${red3.length} 条（预期 2）⇒ ${ok3 ? '这两行是真锁' : '至少一行是恒绿空话'}`);
  }
  // ── 控制 4：route-replay 的 flag_rules 命中累加 ───────────────────────
  const src4 = fs.readFileSync(REPLAY, 'utf8');
  if (!/\/\/ flag_rules 命中：/.test(src4)) {
    lines.push('flags   ｜ 变异未适用：找不到 flag 命中累加块');
    allOk = false;
  } else {
    const mutant4 = path.join(dir, 'replay.no-flags.js');
    fs.writeFileSync(
      mutant4,
      src4.replace(
        /    \/\/ flag_rules 命中：[\s\S]*?\n    \} else report\.flags\.rowsWithout \+= 1;\n  \}/,
        '    // MUTANT: flag 命中累加被摘掉\n  }'
      ),
      'utf8'
    );
    const testMut4 = path.join(dir, 'route-replay.f.test.js');
    fs.writeFileSync(
      testMut4,
      fs.readFileSync(REPLAY_TEST, 'utf8').replace(
        "const TOOL = path.join(__dirname, 'route-replay.js');",
        `const TOOL = ${JSON.stringify(mutant4)};`
      ),
      'utf8'
    );
    let out4 = '';
    try {
      out4 = execFileSync(process.execPath, ['--test', testMut4], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      out4 = (e.stdout || '') + (e.stderr || '');
    }
    const red4 = (out4.match(/^not ok \d+ - (flag_rules 命中|pass 接入了却一轮都没命中).*$/gm) || []);
    const ok4 = red4.length === 2;
    if (!ok4) allOk = false;
    lines.push(`flags   ｜ 摘掉累加后变红的 flag 测 ${red4.length} 条（预期 2）⇒ ${ok4 ? '这两行是真锁' : '至少一行是恒绿空话'}`);
  }

  // ── 控制 5：审计器「探测死了」不得冒充零命中（§16.4at）───────────────
  // 这把测的不是 route-replay 而是**完成度审计器自己**：一台坏机器（PATH 里没有 grep、grep 超时、
  // 正则写错）让六条红线格读出「命中 0」，旧判级式 `n === 0 ? 'PASS'` 就此装绿。
  // 不复制实现：把真源里 probeFault / grepCount / grepCode 三段**函数体抠出来**在沙箱里实例化，
  // 所以改坏 helper 的故障分支、或把修法做得过紧（连合法零命中都判故障），这把都会红。
  const AUDIT = path.join(ROOT, 'scripts', 'maintenance', 'route185-completion-audit.js');
  const srcA = fs.readFileSync(AUDIT, 'utf8');
  const segs = [
    srcA.match(/function probeFault[\s\S]*?\n}/),
    srcA.match(/function grepCount[\s\S]*?\n}/),
    srcA.match(/function grepCode[\s\S]*?\n}/),
  ];
  const FAULT_ANCHORS = [
    / {2}if \(f\) return \{ n: -1,[^\n]*\n/,
    / {2}if \(f\) return \{ total: -1,[^\n]*\n/,
  ];
  if (!segs.every(Boolean)) {
    lines.push('probe   ｜ 变异未适用：审计源里抠不到 probeFault/grepCount/grepCode 三段');
    allOk = false;
  } else {
    const body = segs.map((m) => m[0]).join('\n');
    let mutBody = body;
    let removed = 0;
    for (const re of FAULT_ANCHORS) {
      if (!re.test(mutBody)) { removed = -1; break; }
      mutBody = mutBody.replace(re, '');
      removed += 1;
    }
    if (removed !== 2) {
      lines.push(`probe   ｜ 变异未适用：两处故障返回锚点命中 ${removed}（需要 2）——先确认 §16.4at 的修法还在源里`);
      allOk = false;
    } else {
      const factory = (text) => new Function('cp', 'PROBE_FAULTS', 'ROOT', text + '\nreturn { grepCount, grepCode };');
      const real = factory(body);
      const mut = factory(mutBody);
      const DEATHS = [
        ['ENOENT', { error: { code: 'ENOENT' }, status: null, signal: null, stdout: '', stderr: '' }],
        ['超时', { error: undefined, status: null, signal: 'SIGTERM', stdout: '', stderr: '' }],
        ['用法错', { error: undefined, status: 2, signal: null, stdout: '', stderr: '' }],
        // 本仓的真实形态：全仓 grep 的输出会超过 spawnSync 默认 1MB maxBuffer ⇒ error=ENOBUFS、
        // stdout 为 null。旧读法把这当成「零命中」，于是命中越多反而越像干净。
        ['缓冲溢出', { error: { code: 'ENOBUFS' }, status: null, signal: null, stdout: null, stderr: '' }],
      ];
      const read = (api0, res) => {
        const PROBE_FAULTS = [];
        const api = api0({ spawnSync: () => res }, PROBE_FAULTS, ROOT);
        const g = api.grepCount('x', ['p']);
        const c = api.grepCode('x', ['p']);
        return { n: g.n, code: c.code, faults: PROBE_FAULTS.length };
      };
      const deadReal = DEATHS.map(([k, res]) => {
        const r = read(real, res);
        return `${k}(n=${r.n},code=${r.code},册=${r.faults})`;
      });
      const deadMut = DEATHS.map(([k, res]) => {
        const r = read(mut, res);
        return `${k}(n=${r.n},code=${r.code})`;
      });
      const zero = read(real, { error: undefined, status: 1, signal: null, stdout: '', stderr: '' });
      const hit = read(real, { error: undefined, status: 0, signal: null, stdout: 'a.js:1: foo()\nb.js:2: // bar\n', stderr: '' });
      // 一次 read() 会跑 grepCount + grepCode 两个探测 ⇒ 每种死法登记 2 条故障（不是 1 条：
      // 第一版按 1 条断言，这把控制自己红了一次，红得对——它证明控制会哭，也证明计数要当场量不能猜）。
      const ok5 = deadReal.every((s) => /n=-1,code=-1,册=2/.test(s))
        && deadMut.every((s) => /n=0,code=0/.test(s))
        && zero.n === 0 && zero.code === 0 && zero.faults === 0
        && hit.n === 2 && hit.faults === 0;
      if (!ok5) allOk = false;
      lines.push(
        `probe   ｜ 四种死法 真件 ${deadReal.join(' ')} ｜ 变异件 ${deadMut.join(' ')}`
        + ` ⇒ 真件把死法读成 -1（判级式装不了绿），变异件复现旧行为 n=0（旧式即 PASS）`
        + `；合法零命中 ${zero.n}/${zero.code}/册=${zero.faults}、有命中 ${hit.n}/册=${hit.faults}`
        + ` ⇒ ${ok5 ? '修法既堵死法又没过紧' : '不成立：故障分支或过紧判定有问题'}`
      );
    }
  }
  // ── 控制 6：§7-⑥ 的「默认路径与 HEAD 逐字节一致」锁能不能红 ────────────
  // 这台锁比的是 HEAD 版模块与现行版模块在同池同任务下的输出。先跑**未变异的基线**（必须 0 红，
  // 否则变异件的 8 条红就说不清是谁的功劳），再把**现行侧**的输出反置：在临时件里编译一份
  // 尾部追加反置的模块，让锁的 `cur` 指向它。两把都是非破坏的：仓库里的 autoModelSelect.js 一个字节不动。
  const LOCK = path.join(BE, 'src', 'services', 'gateway', 'autoModelSelect.headRevert.test.js');
  const MODREL = path.join(BE, 'src', 'services', 'gateway', 'autoModelSelect.js');
  const lockSrc = fs.readFileSync(LOCK, 'utf8');
  const modSrc = fs.readFileSync(MODREL, 'utf8');
  const CUR_ANCHOR = "const cur = require('./autoModelSelect');";
  const SELF_ANCHOR = "const SELF = path.join(__dirname, 'autoModelSelect.js');";
  if (!lockSrc.includes(CUR_ANCHOR) || !lockSrc.includes(SELF_ANCHOR) || !/rankAutoModels/.test(modSrc)) {
    lines.push('revert  ｜ 变异未适用：锁里找不到现行侧 require / SELF 锚点，或模块里没有 rankAutoModels');
    allOk = false;
  } else {
    // 反置块挂得上与否不由我猜：若覆盖是空操作，变异件的 8 条红就变 0 条；
    // 若追加的语句让文件加载即抛，那个测试文件里的「HEAD 版模块可编译」也会一起红 ⇒ 两个断言兜住。
    const OVERRIDE = ';{const _o = module.exports.rankAutoModels;'
      + ' module.exports.rankAutoModels = function (t, p) { return _o(t, p).slice().reverse(); };}';
      const mutantMod = path.join(dir, 'autoModelSelect.reversed.js');
      fs.writeFileSync(mutantMod, modSrc + '\n' + OVERRIDE, 'utf8');
      // 临时测试件里的 SELF 必须指回**真实模块路径**：否则 git 的 REL 会算到 tmpdir 上，
      // HEAD 取不到 ⇒ 8 条对照因「没得比」而红，测的就不是默认路径了。
      const loader = 'const cur = (() => { const M2 = require("module");'
        + ` const src = require("fs").readFileSync(${JSON.stringify(mutantMod)}, "utf8");`
        + ' const mm = new M2(SELF, null); mm.filename = SELF;'
        + ' mm.paths = M2._nodeModulePaths(path.dirname(SELF)); mm._compile(src, SELF); return mm.exports; })();';
      const testMut6 = path.join(dir, 'headRevert.mutant.test.js');
      fs.writeFileSync(testMut6,
        lockSrc.replace(SELF_ANCHOR, `const SELF = ${JSON.stringify(MODREL)};`).replace(CUR_ANCHOR, loader),
        'utf8');
      const runTest = (file) => {
        try {
          return execFileSync(process.execPath, ['--test', file], { cwd: ROOT, encoding: 'utf8' });
        } catch (e) {
          return (e.stdout || '') + (e.stderr || '');
        }
      };
      const baseOut = runTest(LOCK);
      const baseRed = (baseOut.match(/^not ok \d+ - 默认路径与 HEAD 逐字节一致.*$/gm) || []).length;
      const baseCompileOk = !/^not ok \d+ - HEAD 版模块可编译.*$/m.test(baseOut);
      const mutOut = runTest(testMut6);
      const mutRed = (mutOut.match(/^not ok \d+ - 默认路径与 HEAD 逐字节一致.*$/gm) || []).length;
      const mutCompileOk = !/^not ok \d+ - HEAD 版模块可编译.*$/m.test(mutOut);
      const ok6 = baseRed === 0 && baseCompileOk && mutRed === 8 && mutCompileOk;
      if (!ok6) allOk = false;
      lines.push(
        `revert  ｜ 基线红 ${baseRed} 条（预期 0，编译测试在位 ${baseCompileOk}）`
        + ` → 把现行侧输出反置后红 ${mutRed} 条（预期 8 = 2 池 × 4 任务，实测每边输出长度都是 4），`
        + `编译测试仍 ${mutCompileOk} ⇒ ${ok6 ? '这台锁真能拦住默认路径被改坏' : '不成立：要么基线就不绿，要么反置打不红它（恒绿空话）'}`
      );
  }

  // ── 控制 7：`routingMode` 的「floor/ceiling 写反判卡坏」护栏有没有测试守着 ──
  // §8 的红线是「写反 ⇒ 判卡坏返回 null」，而不是「将错就错把全池滤光」（后者表现为
  // 「auto 选不出模型」，用户看不出是配置错了）。摘掉那行守卫，写反那条测必须红。
  // 双向：先跑未变异基线（必须 0 红），再比 `# tests` 总数一致（防止「加载即抛」冒充变红）。
  const RMOD = path.join(BE, 'src', 'services', 'gateway', 'routingMode.js');
  const RTEST = path.join(BE, 'src', 'services', 'gateway', 'routingMode.test.js');
  const rmodSrc = fs.readFileSync(RMOD, 'utf8');
  const rtestSrc = fs.readFileSync(RTEST, 'utf8');
  const GUARD = '    if (_TIER_IDX[floor] < _TIER_IDX[ceiling]) return null;';
  const R_ANCHOR = "const rm = require('./routingMode');";
  if (!rmodSrc.includes(GUARD) || !rtestSrc.includes(R_ANCHOR)) {
    lines.push('band    ｜ 变异未适用：routingMode 里找不到反带守卫，或测试里没有 `require(\'./routingMode\')` 锚点');
    allOk = false;
  } else {
    const mutant7 = path.join(dir, 'routingMode.no-band-guard.js');
    fs.writeFileSync(mutant7, rmodSrc.replace(GUARD, '    // MUTANT: 反带守卫被摘掉'), 'utf8');
    // 变异测试件必须落在**真实目录**：这个测试文件里还有 `require('../../utils/flagRegistry')`、
    // `require('../modelPricing')` 等相对引用，放到 tmpdir 会让整文件加载即抛，
    // 报出来的「红」就与护栏无关了（第一版就是这么红的：# tests 从 29 掉到 1）。
    const loader7 = 'const rm = (() => { const M3 = require("module"); const P = require("path");'
      + ` const src = require("fs").readFileSync(${JSON.stringify(mutant7)}, "utf8");`
      + ` const mm = new M3(${JSON.stringify(RMOD)}, null); mm.filename = ${JSON.stringify(RMOD)};`
      + ` mm.paths = M3._nodeModulePaths(P.dirname(${JSON.stringify(RMOD)}));`
      + ' mm._compile(src, mm.filename); return mm.exports; })();';
    const testMut7 = path.join(path.dirname(RTEST), 'tmpRoutingModeBandMutant.test.js');
    const rm7 = () => { try { fs.rmSync(testMut7, { force: true }); } catch { /* 尽力而为 */ } };
    rm7();
    fs.writeFileSync(testMut7, rtestSrc.replace(R_ANCHOR, loader7), 'utf8');
    let base7 = '';
    let mut7 = '';
    try {
      const run7 = (file) => {
        try {
          return execFileSync(process.execPath, ['--test', file], { cwd: BE, encoding: 'utf8' });
        } catch (e) {
          return (e.stdout || '') + (e.stderr || '');
        }
      };
      base7 = run7(RTEST);
      mut7 = run7(testMut7);
    } finally {
      rm7();
    }
    const count = (o) => Number((o.match(/# tests (\d+)/) || [])[1] || 0);
    const baseRed7 = (base7.match(/^not ok \d+ .*$/gm) || []).length;
    const targetRed7 = (mut7.match(/^not ok \d+ - floor\/ceiling 写反.*$/gm) || []).length;
    const sameRun7 = count(base7) > 0 && count(mut7) === count(base7);
    const ok7 = baseRed7 === 0 && targetRed7 === 1 && sameRun7;
    if (!ok7) allOk = false;
    lines.push(
      `band    ｜ 基线红 ${baseRed7} 条（预期 0，# tests ${count(base7)}）→ 摘掉反带守卫后 `
      + `「floor/ceiling 写反判卡坏」那条测红 ${targetRed7} 条（预期 1），# tests 仍 ${count(mut7)}（相等才说明不是加载即抛冒充变红）`
      + ` ⇒ ${ok7 ? '这条护栏确实有测试守着' : '不成立：要么基线不绿，要么摘掉护栏没人报红（护栏无测试）'}`
    );
  }

  // ── 控制 8：`routeDemand` 的「打分失败落中间值 0.5，不落 0」有没有测试守着 ──
  // 那行注释把方向写死了：0 = 判成最便宜，而打分器自己坏掉时「最便宜」是危险方向（§5.6 软失败落中间档）。
  // 摘掉 ⇒ routing 侧那条 `打分内部异常落中间值 0.5,不落 0` 必须红。
  const DMOD = path.join(BE, 'src', 'services', 'gateway', 'routeDemand.js');
  const DTEST = path.join(BE, 'src', 'services', 'gateway', 'routeDemand.test.js');
  const FALLBACK = '    return 0.5; // 打分失败 → 中间值,而不是 0(0 = 判成最便宜,那是危险方向)';
  const D_ANCHOR = "const rd = require('./routeDemand');";
  const dmodSrc = fs.readFileSync(DMOD, 'utf8');
  const dtestSrc = fs.readFileSync(DTEST, 'utf8');
  if (!dmodSrc.includes(FALLBACK) || !dtestSrc.includes(D_ANCHOR)) {
    lines.push('soft    ｜ 变异未适用：routeDemand 里找不到 0.5 兜底行，或测试里没有 `require(\'./routeDemand\')` 锚点');
    allOk = false;
  } else {
    const mutant8 = path.join(dir, 'routeDemand.soft-zero.js');
    fs.writeFileSync(mutant8, dmodSrc.replace(FALLBACK, '    return 0; // MUTANT: 打分失败被改成最低档'), 'utf8');
    // 测试文件里有**两处**同名 require（模块级 + 某条测体内），只换第一处会让那条测体拿到未变异的真模块
    // ⇒ 红不起来却测不出原因。所以全量替换。
    const loader8 = 'const rd = (() => { const M4 = require("module"); const P4 = require("path");'
      + ` const src = require("fs").readFileSync(${JSON.stringify(mutant8)}, "utf8");`
      + ` const mm = new M4(${JSON.stringify(DMOD)}, null); mm.filename = ${JSON.stringify(DMOD)};`
      + ` mm.paths = M4._nodeModulePaths(P4.dirname(${JSON.stringify(DMOD)}));`
      + ' mm._compile(src, mm.filename); return mm.exports; })();';
    const testMut8 = path.join(path.dirname(DTEST), 'tmpRouteDemandSoftZero.test.js');
    const rm8 = () => { try { fs.rmSync(testMut8, { force: true }); } catch { /* 尽力而为 */ } };
    rm8();
    fs.writeFileSync(testMut8, dtestSrc.split(D_ANCHOR).join(loader8), 'utf8');
    let base8 = '';
    let mut8 = '';
    try {
      const run8 = (file) => {
        try {
          return execFileSync(process.execPath, ['--test', file], { cwd: BE, encoding: 'utf8' });
        } catch (e) {
          return (e.stdout || '') + (e.stderr || '');
        }
      };
      base8 = run8(DTEST);
      mut8 = run8(testMut8);
    } finally {
      rm8();
    }
    const c8 = (o) => Number((o.match(/# tests (\d+)/) || [])[1] || 0);
    const baseRed8 = (base8.match(/^not ok \d+ .*$/gm) || []).length;
    const targetRed8 = (mut8.match(/^not ok \d+ - 打分器抛异常落中间值 0\.5.*$/gm) || []).length;
    const ok8 = baseRed8 === 0 && targetRed8 === 1 && c8(base8) > 0 && c8(mut8) === c8(base8);
    if (!ok8) allOk = false;
    lines.push(
      `soft    ｜ 基线红 ${baseRed8} 条（预期 0，# tests ${c8(base8)}）→ 把 0.5 兜底改成 0 后 `
      + `「打分器抛异常落中间值 0.5(catch 路径)」红 ${targetRed8} 条（预期 1），# tests 仍 ${c8(mut8)}（总红 ${ (mut8.match(/^not ok \d+ .*$/gm) || []).length }）`
      + ` ⇒ ${ok8 ? '危险方向的兜底有测试守着' : '不成立：基线不绿 / 摘掉兜底没人报红 / 运行数不一致（可能加载即抛）'}`
    );
  }

  // ── 控制 9：`softFail` 有没有真的进账本白名单（M11/M15 那一族的机器版） ──
  // 本方案栽过两次同一形态：字段在内存里算出来了，但样本投影的白名单没收它 ⇒
  // 落盘里没有这一列，读数侧（`route-replay` 的软失败统计）就是一条恒 0 的假绿。
  // 把投影里的 `softFail` 钉成 null ⇒ `autoModelRouting.test.js` 那条「必须真的落盘」必须红。
  const AMOD = path.join(BE, 'src', 'services', 'gateway', 'autoModelRouting.js');
  const ATEST = path.join(BE, 'src', 'services', 'gateway', 'autoModelRouting.test.js');
  const SF_RE = /^(\s*)softFail: ctx\.softFail \? String\(ctx\.softFail\) : null,$/m;
  const A_ANCHOR = "const amr = require('./autoModelRouting');";
  const amodSrc = fs.readFileSync(AMOD, 'utf8');
  const atestSrc = fs.readFileSync(ATEST, 'utf8');
  if (!SF_RE.test(amodSrc) || !atestSrc.includes(A_ANCHOR)) {
    lines.push('whitelist｜ 变异未适用：投影里找不到 softFail 那行（写法变了要同步订正本控制），或测试没有 require 锚点');
    allOk = false;
  } else {
    const mutant9 = path.join(dir, 'autoModelRouting.no-softfail.js');
    fs.writeFileSync(mutant9, amodSrc.replace(SF_RE, '$1softFail: null, // MUTANT: 白名单被摘掉'), 'utf8');
    if (!/softFail: null, \/\/ MUTANT/.test(fs.readFileSync(mutant9, 'utf8'))) {
      lines.push('whitelist｜ 变异未适用：替换后标记不在位，变异件其实没被改动');
      allOk = false;
    } else {
      const loader9 = 'const amr = (() => { const M5 = require("module"); const P5 = require("path");'
        + ` const src = require("fs").readFileSync(${JSON.stringify(mutant9)}, "utf8");`
        + ` const mm = new M5(${JSON.stringify(AMOD)}, null); mm.filename = ${JSON.stringify(AMOD)};`
        + ` mm.paths = M5._nodeModulePaths(P5.dirname(${JSON.stringify(AMOD)}));`
        + ' mm._compile(src, mm.filename); return mm.exports; })();';
      const testMut9 = path.join(path.dirname(ATEST), 'tmpAutoModelRoutingNoSoftFail.test.js');
      const rm9 = () => { try { fs.rmSync(testMut9, { force: true }); } catch { /* 尽力而为 */ } };
      rm9();
      fs.writeFileSync(testMut9, atestSrc.split(A_ANCHOR).join(loader9), 'utf8');
      let base9 = '';
      let mut9 = '';
      try {
        const run9 = (file) => {
          try {
            return execFileSync(process.execPath, ['--test', file], { cwd: BE, encoding: 'utf8' });
          } catch (e) {
            return (e.stdout || '') + (e.stderr || '');
          }
        };
        base9 = run9(ATEST);
        mut9 = run9(testMut9);
      } finally {
        rm9();
      }
      const c9 = (o) => Number((o.match(/# tests (\d+)/) || [])[1] || 0);
      const r9 = (o) => (o.match(/^not ok \d+ - .*softFail 必须真的落盘.*$/gm) || []).length;
      const all9 = (o) => (o.match(/^not ok \d+ .*$/gm) || []).length;
      const ok9 = all9(base9) === 0 && r9(mut9) === 1 && c9(base9) > 0 && c9(mut9) === c9(base9) && all9(mut9) === 1;
      if (!ok9) allOk = false;
      lines.push(
        `whitelist｜ 基线红 ${all9(base9)} 条（预期 0，# tests ${c9(base9)}）→ 把投影里的 softFail 钉成 null 后 `
        + `「softFail 必须真的落盘」红 ${r9(mut9)} 条（预期 1），总红 ${all9(mut9)}、# tests 仍 ${c9(mut9)}`
        + ` ⇒ ${ok9 ? '这一列真的被白名单收着，读数侧不是恒 0 假绿' : '不成立：白名单落盘这条没有独占的测守着（或运行数不一致）'}`
      );
    }
  }

  // ── 控制 10：负价格声明必须被拒（§14 价表红线「不可知者不得编数」的一半）──
  // 判负的那一行是数学叶子里唯一的闸：`n >= 0`。摘掉它，倒贴钱的声明就成了合法价，
  // 路由器会把坏配置当最便宜档 —— 症状与 §5.6 的「算不出来 ≠ 简单」同族。
  // 期望独占红 :147 那条；若同时红别条，说明多测共守这一行（记录，不算失败）。
  const PMOD = path.join(BE, 'src', 'services', 'modelPricing.js');
  const PTEST = path.join(BE, 'src', 'services', 'modelPricing.test.js');
  const NEG_ANCHOR = ' && n >= 0;';
  const pmodSrc = fs.readFileSync(PMOD, 'utf8');
  const ptestSrc = fs.readFileSync(PTEST, 'utf8');
  const P_ANCHOR = "const mp = require('./modelPricing');";
  const negHits = (pmodSrc.match(/&& n >= 0;/g) || []).length;
  if (negHits !== 1 || !ptestSrc.includes(P_ANCHOR)) {
    lines.push(`price   ｜ 变异未适用：\`&& n >= 0;\` 命中 ${negHits} 处（需要恰好 1 处），或测试没有 require 锚点`);
    allOk = false;
  } else {
    const mutant10 = path.join(dir, 'modelPricing.allow-negative.js');
    fs.writeFileSync(mutant10, pmodSrc.replace(NEG_ANCHOR, '; // MUTANT: 负价不再被拒'), 'utf8');
    const loader10 = 'const mp = (() => { const M6 = require("module"); const P6 = require("path");'
      + ` const src = require("fs").readFileSync(${JSON.stringify(mutant10)}, "utf8");`
      + ` const mm = new M6(${JSON.stringify(PMOD)}, null); mm.filename = ${JSON.stringify(PMOD)};`
      + ` mm.paths = M6._nodeModulePaths(P6.dirname(${JSON.stringify(PMOD)}));`
      + ' mm._compile(src, mm.filename); return mm.exports; })();';
    const testMut10 = path.join(path.dirname(PTEST), 'tmpModelPricingAllowNegative.test.js');
    const rm10 = () => { try { fs.rmSync(testMut10, { force: true }); } catch { /* 尽力而为 */ } };
    rm10();
    fs.writeFileSync(testMut10, ptestSrc.split(P_ANCHOR).join(loader10), 'utf8');
    let base10 = '';
    let mut10 = '';
    try {
      const run10 = (file) => {
        try {
          return execFileSync(process.execPath, ['--test', file], { cwd: BE, encoding: 'utf8' });
        } catch (e) {
          return (e.stdout || '') + (e.stderr || '');
        }
      };
      base10 = run10(PTEST);
      mut10 = run10(testMut10);
    } finally {
      rm10();
    }
    const c10 = (o) => Number((o.match(/# tests (\d+)/) || [])[1] || 0);
    const r10 = (o) => (o.match(/^not ok \d+ - .*负价格声明必须被拒.*$/gm) || []).length;
    const all10 = (o) => (o.match(/^not ok \d+ .*$/gm) || []).length;
    const ok10 = all10(base10) === 0 && r10(mut10) === 1 && c10(base10) > 0 && c10(mut10) === c10(base10);
    if (!ok10) allOk = false;
    lines.push(
      `price   ｜ 基线红 ${all10(base10)} 条（预期 0，# tests ${c10(base10)}）→ 摘掉 \`n >= 0\` 后 `
      + `「负价格声明必须被拒」红 ${r10(mut10)} 条（预期 1），总红 ${all10(mut10)}（>1 = 多测共守这一行）、# tests 仍 ${c10(mut10)}`
      + ` ⇒ ${ok10 ? '倒贴钱的坏声明会被闸住，不会伪装成最便宜档' : '不成立：这条闸没有测守着，或运行数不一致（可能加载即抛）'}`
    );
  }

  // ── 控制 11：§16.4aj 那条「形状锁」到底咬不咬得动 ─────────────────────
  // routeModeListTruthSource.test.js:82 用 `assert.doesNotMatch(src, /ORDER\s*=\s*\['auto/)` 守
  // 「档名只有档位卡一份真源」。形状锁是最容易伪装成绿的锁：正则写宽/写窄都照样全绿，
  // 而真源分叉时它一声不响。所以这把控制**不改仓库文件**，只把那条测里 readFileSync 的路径
  // 换成临时目录里的变异件（恢复硬编码 ORDER），其余 require 全部保持真实路径。
  const CMOD = path.join(BE, 'src', 'cli', 'handlers', 'gatewayModelChoices.js');
  const CTEST = path.join(BE, 'tests', 'gateway', 'routeModeListTruthSource.test.js');
  const ORDER_LINE = 'const ORDER = routingMode.listModes({ card });';
  const READ_PATH = "path.join(BE, 'src/cli/handlers/gatewayModelChoices.js')";
  const cmodSrc = fs.readFileSync(CMOD, 'utf8');
  const ctestSrc = fs.readFileSync(CTEST, 'utf8');
  if (!cmodSrc.includes(ORDER_LINE) || !ctestSrc.includes(READ_PATH)) {
    lines.push('shapesrc｜ 变异未适用：供数点里没有 listModes 那行，或形状锁不是按该路径读源码');
    allOk = false;
  } else {
    const mutant11 = path.join(dir, 'gatewayModelChoices.hardcoded-order.js');
    fs.writeFileSync(
      mutant11,
      cmodSrc.replace(ORDER_LINE, "const ORDER = ['auto', 'extreme', 'performance', 'economy']; // MUTANT"),
      'utf8'
    );
    if (!/ORDER = \['auto'/.test(fs.readFileSync(mutant11, 'utf8'))) {
      lines.push('shapesrc｜ 变异未适用：替换后硬编码 ORDER 不在位，变异件其实没被改动');
      allOk = false;
    } else {
      const testMut11 = path.join(path.dirname(CTEST), 'tmpTruthSourceShapeLock.test.js');
      const rm11 = () => { try { fs.rmSync(testMut11, { force: true }); } catch { /* 尽力而为 */ } };
      rm11();
      // 测件必须留在原目录：它用 __dirname 推 BE，挪走会让别的 require 断链（第 7 把踩过）
      fs.writeFileSync(testMut11, ctestSrc.replace(READ_PATH, JSON.stringify(mutant11)), 'utf8');
      let base11 = '';
      let mut11 = '';
      try {
        const run11 = (file) => {
          try {
            return execFileSync(process.execPath, ['--test', file], { cwd: BE, encoding: 'utf8' });
          } catch (e) {
            return (e.stdout || '') + (e.stderr || '');
          }
        };
        base11 = run11(CTEST);
        mut11 = run11(testMut11);
      } finally {
        rm11();
      }
      const c11 = (o) => Number((o.match(/# tests (\d+)/) || [])[1] || 0);
      const r11 = (o) => (o.match(/^not ok \d+ - 供数点不再有第二份档名真源.*$/gm) || []).length;
      const all11 = (o) => (o.match(/^not ok \d+ .*$/gm) || []).length;
      const ok11 = all11(base11) === 0 && r11(mut11) === 1 && c11(base11) > 0 && c11(mut11) === c11(base11);
      if (!ok11) allOk = false;
      lines.push(
        `shapesrc｜ 基线红 ${all11(base11)} 条（预期 0，# tests ${c11(base11)}）→ 让形状锁去读「恢复硬编码 ORDER」的变异件后 `
        + `锁红 ${r11(mut11)} 条（预期 1），总红 ${all11(mut11)}、# tests 仍 ${c11(mut11)}`
        + ` ⇒ ${ok11 ? '形状锁咬得动：第二份档名真源一出现就报红' : '不成立：形状锁咬不动（正则写宽/写窄都会伪装成绿）'}`
      );
    }
  }

  // ── 控制 12：窗口不可知时 ctxRatio 必须是 null，不是 0 ────────────────
  // 与 softFail 同族的方向错：0 会被下游 routeDemand 读成「上下文很空」⇒ 判成可以留在便宜档。
  // 「不知道」和「很少」在路由里必须不同值，这是 §5 那条「省需要证据，花不需要」的最小形态。
  const SMOD = path.join(BE, 'src', 'services', 'gateway', 'routeContextSignals.js');
  const STEST = path.join(BE, 'src', 'services', 'gateway', 'routeContextSignals.test.js');
  const NULL_GUARD = /^(\s*)(ctxRatio = t\.window > 0 \? t\.usageRatio :) null;$/m;
  const S_ANCHOR = "const rcs = require('./routeContextSignals');";
  const smodSrc = fs.readFileSync(SMOD, 'utf8');
  const stestSrc = fs.readFileSync(STEST, 'utf8');
  if (!NULL_GUARD.test(smodSrc) || !stestSrc.includes(S_ANCHOR)) {
    lines.push('nullzero｜ 变异未适用：找不到 ctxRatio 的 null 兜底行，或测试没有 require 锚点');
    allOk = false;
  } else {
    const mutant12 = path.join(dir, 'routeContextSignals.zero-instead-of-null.js');
    fs.writeFileSync(mutant12, smodSrc.replace(NULL_GUARD, '$1$2 0; // MUTANT'), 'utf8');
    // 源文里冒号前有空格（`t.usageRatio : null`），标记匹配要容忍冒号两侧空白：
    // 写死成 `usageRatio: 0` 会让控制因自己的正则太窄而报「变异未适用」（本机 22:52 实测到的一次）。
    if (!/usageRatio\s*:\s*0;\s*\/\/ MUTANT/.test(fs.readFileSync(mutant12, 'utf8'))) {
      lines.push('nullzero｜ 变异未适用：替换标记不在位，变异件其实没被改动');
      allOk = false;
    } else {
      const loader12 = 'const rcs = (() => { const M7 = require("module"); const P7 = require("path");'
        + ` const src = require("fs").readFileSync(${JSON.stringify(mutant12)}, "utf8");`
        + ` const mm = new M7(${JSON.stringify(SMOD)}, null); mm.filename = ${JSON.stringify(SMOD)};`
        + ` mm.paths = M7._nodeModulePaths(P7.dirname(${JSON.stringify(SMOD)}));`
        + ' mm._compile(src, mm.filename); return mm.exports; })();';
      const testMut12 = path.join(path.dirname(STEST), 'tmpRouteContextSignalsZero.test.js');
      const rm12 = () => { try { fs.rmSync(testMut12, { force: true }); } catch { /* 尽力而为 */ } };
      rm12();
      fs.writeFileSync(testMut12, stestSrc.split(S_ANCHOR).join(loader12), 'utf8');
      let base12 = '';
      let mut12 = '';
      try {
        const run12 = (file) => {
          try {
            return execFileSync(process.execPath, ['--test', file], { cwd: BE, encoding: 'utf8' });
          } catch (e) {
            return (e.stdout || '') + (e.stderr || '');
          }
        };
        base12 = run12(STEST);
        mut12 = run12(testMut12);
      } finally {
        rm12();
      }
      const c12 = (o) => Number((o.match(/# tests (\d+)/) || [])[1] || 0);
      const r12 = (o) => (o.match(/^not ok \d+ - derive：没有窗口.*$/gm) || []).length;
      const all12 = (o) => (o.match(/^not ok \d+ .*$/gm) || []).length;
      const ok12 = all12(base12) === 0 && r12(mut12) === 1 && c12(base12) > 0 && c12(mut12) === c12(base12);
      if (!ok12) allOk = false;
      lines.push(
        `nullzero｜ 基线红 ${all12(base12)} 条（预期 0，# tests ${c12(base12)}）→ 把不可知窗口的 null 兜底改成 0 后 `
        + `「没有窗口 ⇒ ctxRatio 是 null 而不是 0」红 ${r12(mut12)} 条（预期 1），总红 ${all12(mut12)}、# tests 仍 ${c12(mut12)}`
        + ` ⇒ ${ok12 ? '「不知道」与「很少」在数据上是两个值，方向错不了' : '不成立：null-vs-0 这条没有独占的测守着'}`
      );
    }
  }

  // ── 控制 13：λ 未标定时成本项必须整项退出（源文注释点名的那个错写法）──
  // `autoModelSelect.js:315` 写着：不能用 Number(opts.lambda) 判定，因为 Number(null) === 0
  // 会把「未标定」当成「λ=0 参与打分」。第一版把这把刀砍在 :317 的 `Number.isFinite(lambda)` 上，
  // **0 条红**——不是测是空话，而是 :313 先把非 number 收敛成了 NaN，:317 只是第二道闸（摘了没差别）。
  // 所以真正的靶是 :313 那道收敛：把它改成注释禁止的 `Number(...)` 写法。
  const LMOD = path.join(BE, 'src', 'services', 'gateway', 'autoModelSelect.js');
  const LTEST = path.join(BE, 'src', 'services', 'gateway', 'autoModelSelect.test.js');
  const SANITIZER_RE = /^(\s*)const lambda = typeof \(opts && opts\.lambda\) === 'number' \? opts\.lambda : NaN;$/m;
  const lmodSrc = fs.readFileSync(LMOD, 'utf8');
  const ltestSrc = fs.readFileSync(LTEST, 'utf8');
  const L_ANCHOR = "const sel = require('./autoModelSelect');";
  if (!SANITIZER_RE.test(lmodSrc) || !ltestSrc.includes(L_ANCHOR)) {
    lines.push('lambda  ｜ 变异未适用：找不到 :313 的 typeof 收敛行，或测试没有 require 锚点');
    allOk = false;
  } else {
    const mutant13 = path.join(dir, 'autoModelSelect.number-lambda.js');
    fs.writeFileSync(
      mutant13,
      lmodSrc.replace(SANITIZER_RE, '$1const lambda = Number(opts && opts.lambda); // MUTANT'),
      'utf8'
    );
    const mut13Src = fs.readFileSync(mutant13, 'utf8');
    if (!/Number\(opts && opts\.lambda\);\s*\/\/ MUTANT/.test(mut13Src)
      || /typeof \(opts && opts\.lambda\) === 'number' \? opts\.lambda : NaN/.test(mut13Src)) {
      lines.push('lambda  ｜ 变异未适用：收敛行仍在或标记不在位，替换没落到点上');
      allOk = false;
    } else {
      const loader13 = 'const sel = (() => { const M8 = require("module"); const P8 = require("path");'
        + ` const src = require("fs").readFileSync(${JSON.stringify(mutant13)}, "utf8");`
        + ` const mm = new M8(${JSON.stringify(LMOD)}, null); mm.filename = ${JSON.stringify(LMOD)};`
        + ` mm.paths = M8._nodeModulePaths(P8.dirname(${JSON.stringify(LMOD)}));`
        + ' mm._compile(src, mm.filename); return mm.exports; })();';
      const testMut13 = path.join(path.dirname(LTEST), 'tmpAutoModelSelectNumberLambda.test.js');
      const rm13 = () => { try { fs.rmSync(testMut13, { force: true }); } catch { /* 尽力而为 */ } };
      rm13();
      fs.writeFileSync(testMut13, ltestSrc.split(L_ANCHOR).join(loader13), 'utf8');
      let base13 = '';
      let mut13 = '';
      try {
        const run13 = (file) => {
          try {
            return execFileSync(process.execPath, ['--test', file], { cwd: BE, encoding: 'utf8' });
          } catch (e) {
            return (e.stdout || '') + (e.stderr || '');
          }
        };
        base13 = run13(LTEST);
        mut13 = run13(testMut13);
      } finally {
        rm13();
      }
      const c13 = (o) => Number((o.match(/# tests (\d+)/) || [])[1] || 0);
      const r13 = (o) => (o.match(/^not ok \d+ - λ 非有限.*$/gm) || []).length;
      const all13 = (o) => (o.match(/^not ok \d+ .*$/gm) || []).length;
      const ok13 = all13(base13) === 0 && r13(mut13) === 1 && c13(base13) > 0 && c13(mut13) === c13(base13);
      if (!ok13) allOk = false;
      lines.push(
        `lambda  ｜ 基线红 ${all13(base13)} 条（预期 0，# tests ${c13(base13)}）→ 把 :313 的 typeof 收敛改成注释禁止的 Number(...) 写法后 `
        + `「λ 非有限时成本项整项退出」红 ${r13(mut13)} 条（预期 1），总红 ${all13(mut13)}、# tests 仍 ${c13(mut13)}`
        + ` ⇒ ${ok13 ? '未标定与 λ=0 是两个状态，注释里的禁令有测兜底' : '不成立：这条闸没有独占的测守着，或别处也依赖它（看总红数）'}`
      );
    }
  }

  // ── 控制 14：循环侧的 β 接缝与钉选旁路（§5.2 / §15-1 在 tool-use 循环里的那两处）──
  // 22:15 探针实测：把 `_modeIntent = …staticIntentForTier(…)` 改成常量 null 之后，
  // 恰有两条测红——「mode intent reaches the loop profile…」与「pinned channel bypasses the mode axis
  // at the loop profile (§15-1)」。本方案在循环侧的两个承诺就是由这两行守着的，所以靶点是它。
  // 变异件写在**模块自己的目录**里（不是 tmpdir）：这个模块用相对 require 取 routingMode/modelTier，
  // 挪走会让 require 断链；测件同理，落在原目录才能保住 `__dirname` 推出的路径。
  const PCMOD = path.join(BE, 'src/services/domain/catalog/toolUseLoop/protocolContext.js');
  const PCTEST = path.join(BE, 'src/services/domain/catalog/toolUseLoop/protocolContext.test.js');
  const PC_ANCHOR = "_modeIntent = require('../../../gateway/routingMode').staticIntentForTier(_tierForProfile);";
  const PC_SPEC = "require('./protocolContext')";
  const pcmutMod = path.join(path.dirname(PCMOD), 'tmpPCBetaSevered.js');
  const pcmutTest = path.join(path.dirname(PCTEST), 'tmpPCBetaSevered.test.js');
  const rm14 = () => {
    for (const f of [pcmutMod, pcmutTest]) { try { fs.unlinkSync(f); } catch { /* 本来就没有 */ } }
  };
  const pcSrc = fs.readFileSync(PCMOD, 'utf8');
  const pcTest = fs.readFileSync(PCTEST, 'utf8');
  if (!pcSrc.includes(PC_ANCHOR) || !pcTest.includes(PC_SPEC)) {
    lines.push('loopbeta｜ 变异未适用：循环侧找不到 staticIntentForTier 接缝，或测试没有该 require 形状');
    allOk = false;
  } else {
    try {
      rm14();
      fs.writeFileSync(pcmutMod, pcSrc.replace(PC_ANCHOR, '_modeIntent = null; // MUTANT'), 'utf8');
      if (!/_modeIntent = null;\s*\/\/ MUTANT/.test(fs.readFileSync(pcmutMod, 'utf8'))) {
        lines.push('loopbeta｜ 变异未适用：替换标记不在位');
        allOk = false;
      } else {
        fs.writeFileSync(pcmutTest, pcTest.split(PC_SPEC).join("require('./tmpPCBetaSevered')"), 'utf8');
        const run14 = (f) => {
          try {
            return execFileSync(process.execPath, ['--test', f], { encoding: 'utf8' });
          } catch (e) {
            return (e.stdout || '') + (e.stderr || '');
          }
        };
        const base14 = run14(PCTEST);
        const mut14 = run14(pcmutTest);
        const c14 = (o) => Number((o.match(/# tests (\d+)/) || [])[1] || 0);
        const all14 = (o) => (o.match(/^not ok \d+ - .*$/gm) || []);
        const want14 = (o) => all14(o).filter((l) => /mode intent reaches the loop profile|pinned channel bypasses the mode axis/.test(l)).length;
        const ok14 = all14(base14).length === 0 && want14(mut14) === 2 && all14(mut14).length === 2
          && c14(base14) > 0 && c14(mut14) === c14(base14);
        if (!ok14) allOk = false;
        lines.push(
          `loopbeta｜ 基线红 ${all14(base14).length} 条（预期 0，# tests ${c14(base14)}）→ 把循环侧 β 接缝改成常量 null 后 `
          + `目标两条红 ${want14(mut14)} 条（预期 2：mode-interval 到达循环 profile + 钉选旁路），总红 ${all14(mut14).length}、# tests 仍 ${c14(mut14)}`
          + ` ⇒ ${ok14 ? '§5.2 β 与 §15-1 钉选在循环侧的两个承诺都有测守着' : '不成立：接缝断了没人报红，或红的不是那两条'}`
        );
      }
    } finally {
      rm14();
    }
  }

  // ── 控制 15：π 的接缝（选了「经济」档 ⇒ 脚手架真的变薄）──
  // `dynamicPromptAssembler.js:613` 的注释写明：这份 profile 此前不带 modeIntent，
  // 于是调用方知道 lean 而 calibrateScaffolding 收不到 ⇒ 档选了、提示词没变薄。
  // 把 `modeIntent: _modeIntent` 改成 `modeIntent: null` 就是回到缺陷态：
  // 经济档两条测（:67 与中文别名 :79）必须红，而 :56 那条「模式轴关掉时不得出现 lean」的
  // 反向对照**必须仍绿**——它绿说明变异没有把 lean 变成常开，只是把档名与它解了绑。
  const ASM = path.join(BE, 'src/services/dynamicPromptAssembler.js');
  const PI_TEST = path.join(BE, 'tests/gateway/routeVerbositySeam.test.js');
  const USE_SITE = 'modeIntent: _modeIntent,';
  const PI_SPEC = "require(BE + '/src/services/dynamicPromptAssembler')";
  const piMutMod = path.join(path.dirname(ASM), 'tmpPiSeamSevered.js');
  const piMutTest = path.join(path.dirname(PI_TEST), 'tmpPiSeamSevered.test.js');
  const rm15 = () => {
    for (const f of [piMutMod, piMutTest]) { try { fs.unlinkSync(f); } catch { /* 本来就没有 */ } }
  };
  const asmSrc = fs.readFileSync(ASM, 'utf8');
  const piTestSrc = fs.readFileSync(PI_TEST, 'utf8');
  const useHits = (asmSrc.match(/modeIntent: _modeIntent,/g) || []).length;
  if (useHits !== 1 || !piTestSrc.includes(PI_SPEC)) {
    lines.push(`pi      ｜ 变异未适用：modeIntent 使用点命中 ${useHits} 处（需要恰好 1 处），或测里不是那个 require 形状`);
    allOk = false;
  } else {
    try {
      rm15();
      fs.writeFileSync(piMutMod, asmSrc.replace(USE_SITE, 'modeIntent: null, // MUTANT: 档名与脚手架脱钩'), 'utf8');
      if (!/modeIntent: null,\s*\/\/ MUTANT/.test(fs.readFileSync(piMutMod, 'utf8'))) {
        lines.push('pi      ｜ 变异未适用：替换标记不在位');
        allOk = false;
      } else {
        fs.writeFileSync(piMutTest, piTestSrc.split(PI_SPEC).join("require(BE + '/src/services/tmpPiSeamSevered')"), 'utf8');
        const run15 = (f) => {
          try {
            return execFileSync(process.execPath, ['--test', f], { encoding: 'utf8' });
          } catch (e) {
            return (e.stdout || '') + (e.stderr || '');
          }
        };
        const base15 = run15(PI_TEST);
        const mut15 = run15(piMutTest);
        const c15 = (o) => Number((o.match(/# tests (\d+)/) || [])[1] || 0);
        const all15 = (o) => (o.match(/^not ok \d+ - .*$/gm) || []);
        const want15 = (o) => all15(o).filter((l) => /经济档必须真的把脚手架等级打下来|中文档名「经济」走同一条接缝/.test(l)).length;
        const negStillGreen = !/前置条件/.test(all15(mut15).join('\n'));
        const ok15 = all15(base15).length === 0 && want15(mut15) === 2 && all15(mut15).length === 2
          && negStillGreen && c15(base15) > 0 && c15(mut15) === c15(base15);
        if (!ok15) allOk = false;
        lines.push(
          `pi      ｜ 基线红 ${all15(base15).length} 条（预期 0，# tests ${c15(base15)}）→ 把 modeIntent 接成 null 后 `
          + `经济档两条测红 ${want15(mut15)} 条（预期 2），总红 ${all15(mut15).length}，反向对照「模式轴关掉时不得出现 lean」仍绿=${negStillGreen}，# tests 仍 ${c15(mut15)}`
          + ` ⇒ ${ok15 ? 'π 的接缝断了会报红，且变异只是解绑、没把 lean 变成常开' : '不成立：断了没人报红 / 红的不是那两条 / 反向对照被一起打红（说明变异过界）'}`
        );
      }
    } finally {
      rm15();
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 计数从 lines.length 来，不在文案里写死「几把」——本会话就在「四把/五把」上漂移过一次（§16.4ai/at）。
process.stdout.write(lines.join('\n')
  + `\n合计：${lines.length} 把控制，${allOk ? '全部成立' : '有控制不成立 ⇒ 相关断言不可信'}\n`);
process.exitCode = allOk ? 0 : 1;
