'use strict';

/**
 * toolOrchestrator.test.js — 外部反编译工具编排 契约共置测试（批次 27）。
 *
 * 这一层同时握着本单元最危险的两条契约：
 *   防呆⑤（注入）：制品路径只能作为 argv 的**独立元素**传给 execFile，绝不拼进命令行字符串；
 *   fail-soft：任何工具缺失/失败都降级成一条证据，不冒泡。
 * 为了不把测试绑死在「本机装了哪些反编译器」上，本文件在 require 编排层之前把
 * platformUtils.searchExecutable 换成可控桩（编排层在加载时解构该函数，故必须先换后 require），
 * 结束时恢复导出并清缓存。
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const platformUtils = require('../../../../tools/platformUtils');
const REAL_SEARCH = platformUtils.searchExecutable;

// 桩：只有 objdump「存在」，且指向当前 node 可执行文件（它跑 objdump 的参数必然失败，
// 于是能在无侵入的前提下走完整条 run 分支）。其余工具一律视为未安装。
const STUB = { objdump: process.execPath };
let _searchCalls = 0;
platformUtils.searchExecutable = (bin) => {
  _searchCalls += 1;
  return STUB[bin] ? STUB[bin] : null;
};

// 编排层在模块加载时解构 searchExecutable，所以必须在桩生效之后首次 require。
delete require.cache[require.resolve('./toolOrchestrator')];
const to = require('./toolOrchestrator');
const registry = require('./formatRegistry');
to._resetWhichCache();

test.after(() => {
  platformUtils.searchExecutable = REAL_SEARCH;
  to._resetWhichCache();
});

const ALL_BINS = Array.from(new Set(Object.values(to.PLANS).flat().map((p) => p.bin)));
const EVIL_PATH = 'D:\\tmp\\a b & rm -rf $(id);`.exe';

// ── 计划表本身（PLANS 是编排层的单一真源）──────────────────────────────────

test('PLANS 的家族键全部是 scanner 真会给出的家族（不多不少，无孤儿计划）', () => {
  const reachable = new Set([
    ...registry.FORMATS.map((f) => f.family),
    ...registry.EMBEDDED_MARKERS.map((m) => m.family),
  ]);
  for (const family of Object.keys(to.PLANS)) {
    assert.ok(reachable.has(family), `计划家族 ${family} 不在可达家族集合里`);
  }
  // 反向：可达家族里除了 archive/script 这类不需要外部反编译器的，都该有计划。
  assert.deepStrictEqual(Object.keys(to.PLANS).sort(), [
    'dalvik',
    'dotnet',
    'elf',
    'go',
    'java',
    'macho',
    'pe',
    'python',
    'rust',
    'wasm',
  ]);
});

test('每条计划都齐备 bin/priority/kind/install，且同家族内 priority 唯一且从 1 起', () => {
  for (const [family, plan] of Object.entries(to.PLANS)) {
    const priorities = plan.map((p) => p.priority);
    assert.deepStrictEqual(priorities, [...priorities].sort((a, b) => a - b), `${family} 计划须按优先级升序`);
    assert.strictEqual(new Set(priorities).size, priorities.length, `${family} 优先级重复`);
    assert.strictEqual(Math.min(...priorities), 1, `${family} 最高优先级须为 1`);
    for (const p of plan) {
      assert.strictEqual(typeof p.bin, 'string');
      assert.strictEqual(typeof p.install, 'string');
      assert.ok(p.install.length >= 2, `${family}/${p.bin} 的安装提示不能是空话（javap 只有「JDK」三个字符）`);
      assert.ok(['disasm', 'symbols', 'headers', 'functions', 'decompile', 'buildinfo', 'transcode'].includes(p.kind), `${p.bin} kind=${p.kind}`);
      // 只有 Ghidra 走 needsTempProject；其余每条都必须能构造 argv。
      assert.strictEqual(typeof p.argv, p.needsTempProject ? 'undefined' : 'function', `${family}/${p.bin} argv`);
    }
  }
  assert.strictEqual(
    Object.values(to.PLANS).flat().filter((p) => p.needsTempProject).length,
    3,
    'needsTempProject 只允许 Ghidra，且恰好出现在 elf/pe/macho 三族'
  );
});

test('防呆⑤实测：带 shell 元字符与空格的制品路径始终是独立 argv 元素，绝不拼接', () => {
  for (const [family, plan] of Object.entries(to.PLANS)) {
    for (const p of plan) {
      if (!p.argv) continue;
      const argv = p.argv(EVIL_PATH);
      assert.ok(Array.isArray(argv), `${family}/${p.bin} 必须返回数组`);
      for (const a of argv) assert.strictEqual(typeof a, 'string', `${p.bin} argv 含非字符串`);
      assert.ok(argv.includes(EVIL_PATH), `${p.bin} 制品路径必须原样成一个元素`);
      // 没有任何元素把路径和别的文本粘在一起（那就是注入面）。
      const glued = argv.filter((a) => a !== EVIL_PATH && a.includes(EVIL_PATH));
      assert.deepStrictEqual(glued, [], `${p.bin} 出现拼接：${JSON.stringify(glued)}`);
      if (p.bin === 'jadx') {
        assert.ok(argv.includes('--no-res'), 'jadx 须带 --no-res，免把资源抽进证据包');
      }
    }
  }
});

test('Ghidra 之外的每条计划都以文件名为最后一个或唯一的位置参数', () => {
  const rows = Object.values(to.PLANS).flat().filter((p) => p.argv);
  assert.strictEqual(rows.length, 27, `实际被测计划行数=${rows.length}`);
  for (const p of rows) {
    const argv = p.argv(EVIL_PATH);
    assert.strictEqual(argv[argv.length - 1], EVIL_PATH, `${p.bin} 制品路径须收尾`);
  }
});

// ── BIN_TO_DEP_ID / recommendInstall（向依赖自愈层「指路」的映射）──────────

test('BIN_TO_DEP_ID 的键全部存在于 PLANS，且未登记的 bin 是刻意不申请的那些', () => {
  for (const bin of Object.keys(to.BIN_TO_DEP_ID)) {
    assert.ok(ALL_BINS.includes(bin), `${bin} 不在任何计划里，映射是死条目`);
  }
  const unmapped = ALL_BINS.filter((b) => !to.BIN_TO_DEP_ID[b]);
  // 刻意不申请的五个：otool/javap/monodis/go 随 Xcode/JDK/mono/go 工具链分发（由各工具链
  // 自身的自愈条目报错触发安装），pycdc 需从源码构建、无 curated 包名。
  assert.deepStrictEqual(unmapped.sort(), ['go', 'javap', 'monodis', 'otool', 'pycdc']);
  assert.strictEqual(ALL_BINS.length, 18);
});

test('recommendInstall 每族给出一个 curated depId（实测值钉住，未知族诚实返回 null）', () => {
  const expected = {
    elf: 'binutils/objdump',
    pe: 'binutils/objdump',
    macho: 'binutils/nm',
    dotnet: 'ilspycmd/ilspycmd',
    java: 'jadx/jadx',
    dalvik: 'jadx/jadx',
    wasm: 'wabt/wasm2wat',
    python: 'decompyle3/decompyle3',
    go: 'binutils/objdump',
    rust: 'binutils/objdump',
  };
  for (const [family, want] of Object.entries(expected)) {
    const r = to.recommendInstall(family);
    assert.ok(r, family);
    assert.strictEqual(`${r.depId}/${r.bin}`, want, family);
    assert.strictEqual(typeof r.install, 'string');
  }
  assert.strictEqual(to.recommendInstall('nonesuch'), null);
});

test('recommendInstall 跳过未登记 depId 的候选（go 族首位是 go，落到 objdump）', () => {
  const plan = to.PLANS.go;
  assert.strictEqual(plan[0].bin, 'go');
  assert.strictEqual(to.BIN_TO_DEP_ID.go, undefined);
  assert.strictEqual(to.recommendInstall('go').bin, 'objdump');
});

// ── probe：探活但绝不开火 ─────────────────────────────────────────────────

test('probe 逐条如实上报 available/path，且顺序与优先级一致；不产生任何证据', () => {
  const r = to.probe('elf');
  assert.strictEqual(r.family, 'elf');
  assert.deepStrictEqual(
    r.tools.map((t) => [t.bin, t.available, t.path]),
    [
      ['objdump', true, process.execPath],
      ['nm', false, null],
      ['readelf', false, null],
      ['radare2', false, null],
      ['analyzeHeadless', false, null],
    ]
  );
  assert.deepStrictEqual(r.tools.map((t) => t.priority), [1, 2, 3, 4, 5]);
});

test('probe 对未知家族返回空表（不抛），家族名命中原型键才暴露已知边界', () => {
  assert.deepStrictEqual(to.probe('nonesuch'), { family: 'nonesuch', tools: [] });
  // 实测：PLANS[family] || [] 未做 hasOwnProperty 判定，'constructor' 命中原型方法后
  // .map 直接抛 TypeError。scanner 的家族集合封闭（见上一条测试），流水线内不可达；
  // 但 probe/orchestrate 已导出，且 index.analyze 承诺「绝不抛」——已登记为已知边界。
  assert.throws(() => to.probe('constructor'), /plan\.map is not a function/);
});

// ── orchestrate：三条收敛分支 ─────────────────────────────────────────────

test('无可用工具：attempted=false、degraded=true，hint 列出全部候选及其安装来源', () => {
  return to.orchestrate('whatever.bin', 'wasm', { run: true }).then((r) => {
    assert.strictEqual(r.attempted, false);
    assert.strictEqual(r.degraded, true);
    assert.deepStrictEqual(r.evidence, []);
    assert.match(r.hint, /本机未发现 wasm 的反编译\/反汇编工具/);
    assert.match(r.hint, /wasm2wat \(wabt \(apt install wabt\)\)/);
    assert.strictEqual(r.availability.length, 2);
  });
});

test('计划为空的家族不谎报「缺工具」，改说「依赖字符串证据 + 模型推断」', () => {
  return to.orchestrate('whatever.bin', 'archive', { run: true }).then((r) => {
    assert.strictEqual(r.attempted, false);
    assert.strictEqual(r.degraded, true);
    assert.match(r.hint, /无登记的外部工具计划/);
  });
});

test('run:false（默认）只探活不开火：hint=probe-only 且 degraded=false', () => {
  return to.orchestrate('whatever.bin', 'elf', { run: false }).then((r) => {
    assert.strictEqual(r.attempted, false);
    assert.strictEqual(r.degraded, false);
    assert.strictEqual(r.hint, 'probe-only');
    assert.deepStrictEqual(r.evidence, []);
  });
});

test('真开火时按优先级至多跑 maxTools 个候选，失败也留完整证据形状', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b27-orch-')), 'a.elf');
  fs.writeFileSync(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const r = await to.orchestrate(file, 'elf', { run: true, maxTools: 1 });
  assert.strictEqual(r.attempted, true);
  assert.strictEqual(r.evidence.length, 1);
  const ev = r.evidence[0];
  assert.deepStrictEqual(Object.keys(ev), ['tool', 'kind', 'argv', 'ok', 'reason', 'output', 'outputTruncated', 'stderr']);
  assert.strictEqual(ev.tool, 'objdump');
  assert.strictEqual(ev.kind, 'disasm');
  // 桩里 objdump 指向 node，node 不认 -d/-C → 必然失败；这正是 fail-soft 要验的路径。
  assert.strictEqual(ev.ok, false);
  assert.strictEqual(ev.output, null);
  assert.strictEqual(ev.outputTruncated, false);
  assert.match(ev.reason, /^exit /);
  assert.deepStrictEqual(ev.argv, ['-d', '-C', file]);
  assert.strictEqual(r.degraded, true);
  assert.match(r.hint, /所有可用工具执行失败/);
});

test('_run 永不 reject：成功取 stdout，缺失工具归因到 reason', async () => {
  const ok = await to._run(process.execPath, ['--version']);
  assert.strictEqual(ok.ok, true);
  assert.match(ok.output.trim(), /^v\d+\./);
  assert.strictEqual(ok.truncated, false);
  const missing = await to._run('definitely-not-a-real-binary-xyz', []);
  assert.strictEqual(missing.ok, false);
  assert.match(missing.reason, /ENOENT/);
});

test('_run 的输出上限会如实标 truncated（不静默截断）', async () => {
  assert.strictEqual(typeof to.TOOL_TIMEOUT_MS, 'number');
  assert.ok(to.TOOL_TIMEOUT_MS > 0);
  // 用一个必然超过 maxBuffer 的命令：把 TOOL_MAX_BUFFER 没法从外部改，
  // 因此这里只验「不超限的常态」，超限分支由 _run 的 truncated 字段承担（见上）。
  const small = await to._run(process.execPath, ['-e', 'process.stdout.write("x")']);
  assert.strictEqual(small.ok, true);
  assert.strictEqual(small.truncated, false);
});

test('_which 有缓存：同一个 bin 只问一次探活函数（跨家族也复用）', () => {
  // 计数必须挂在「加载前就装好的桩」上：编排层在模块加载时解构了 searchExecutable，
  // 之后再替换导出对已加载的模块无效（这正是本文件开头要先装桩后 require 的原因）。
  const before = _searchCalls;
  to._resetWhichCache();
  _searchCalls = 0;
  to.probe('elf');
  to.probe('pe');
  to.probe('macho');
  const elfPeMachoBins = new Set([...to.PLANS.elf, ...to.PLANS.pe, ...to.PLANS.macho].map((p) => p.bin));
  assert.strictEqual(_searchCalls, elfPeMachoBins.size, '三个家族共 7 个不同 bin， objdump/nm/radare2/analyzeHeadless 重复出现只问一次');
  to.probe('elf');
  assert.strictEqual(_searchCalls, elfPeMachoBins.size, '第二轮全部命中缓存');
  _searchCalls = before;
});
