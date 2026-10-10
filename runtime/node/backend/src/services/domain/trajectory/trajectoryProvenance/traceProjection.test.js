'use strict';

/**
 * traceProjection.test.js — 溯源记录人读投影（DESIGN-ARCH-047 §3 PHASE 1/5）的本目录单测。
 *
 * 字形集是**显示契约**：`✓`(U+2713) / `⟳`(U+27F3) / `⚠`(U+26A0) 同一份常量被 TUI 的工具行、
 * REPL 的内联标签与 `khy trace` 回放列表共用，改任何一个码点都会让三个渲染面同时错位，
 * 所以这里按 codePointAt 钉死，而不是按「看起来像个勾」钉。
 *
 * 覆盖面：labelText（未导出，只能经 replayRow().label 观察）与 inlineLabel 的「字形 + 空格 + 文字」
 * 组合关系、producerId 的 `producer:id` 形式、矛盾行模板、chainStatusLine 与 traceChain.verify()
 * 真实返回值的往返（串味即红）、以及两处**登记不修**的缺陷：
 *   ① 模块头宣称「纯函数：同输入同输出，无 IO」，但 replayRow 对无有效信封的条目会读时钟；
 *   ② 信封坏掉/缺失时投影一律回落成 `✓ KHY executed` —— 显示层的 fail-safe-to-ours
 *      等于把「无法判定来路」显示成「本地已验证」。
 *
 * 唯一的 IO 是为 chainStatusLine 往返准备的一条真链，落在 mkdtemp 临时根里，after() 删除；
 * 不写仓库、不碰 .khy/sessions、不设任何数据目录 env。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const proj = require('./traceProjection');
const khyTrace = require('./khyTrace');
const traceChain = require('./traceChain');

const { TRUST, PRODUCER, KIND } = khyTrace;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-traceproj-'));
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** 直接手写一个结构合法的信封条目（不经 makeTrace，以免归一化替我们把畸形输入修好）。 */
function entry(trace, extra = {}) {
  return { role: 'assistant', ...extra, _khyTrace: trace };
}
function envelope(over = {}) {
  return {
    v: khyTrace.TRACE_VERSION,
    producer: PRODUCER.KHY_LOCAL,
    producerId: null,
    trust: TRUST.VERIFIED,
    kind: KIND.TEXT,
    at: 1000,
    contradictions: [],
    seal: null,
    ...over,
  };
}

// ───────────────────────────────── 导出面与字形契约 ─────────────────────────────────

test('导出面恰为 5 个符号；labelText 未导出（只能经 replayRow().label 观察）', () => {
  assert.deepStrictEqual(Object.keys(proj).sort(), [
    'GLYPH',
    'chainStatusLine',
    'contradictionLabels',
    'inlineLabel',
    'replayRow',
  ]);
  assert.equal('labelText' in proj, false, 'labelText 是内部函数：外部只能用 inlineLabel 或 replayRow');
});

test('GLYPH 三键 frozen，码点逐字钉死（与 TUI/REPL 共享的显示契约）', () => {
  assert.ok(Object.isFrozen(proj.GLYPH));
  assert.deepStrictEqual(Object.keys(proj.GLYPH).sort(), ['claimed', 'quarantined', 'verified'].sort());
  assert.strictEqual(proj.GLYPH[TRUST.VERIFIED].codePointAt(0), 0x2713); // ✓
  assert.strictEqual(proj.GLYPH[TRUST.CLAIMED].codePointAt(0), 0x27f3); // ⟳
  assert.strictEqual(proj.GLYPH[TRUST.QUARANTINED].codePointAt(0), 0x26a0); // ⚠
  assert.strictEqual(proj.GLYPH[TRUST.VERIFIED].length, 1, '字形必须是单个码点，否则对齐宽度会飘');
  assert.strictEqual(proj.GLYPH[TRUST.CLAIMED].length, 1);
  assert.strictEqual(proj.GLYPH[TRUST.QUARANTINED].length, 1);
});

test('GLYPH 的键集合恰好等于 TRUST 的值集合 —— `|| "·"` 兜底当前不可达（前向兼容哨兵，非意外死码）', () => {
  // 结构证明：inlineLabel/replayRow 的字形只可能来自 traceOf()，而 traceOf 要么返回
  // 通过 isTrace() 的信封（isTrace 要求 trust ∈ TRUST 值集），要么返回 makeTrace 的
  // khy-local/verified 默认。两者都保证 trust 是 GLYPH 的键 → 兜底永不触发。
  assert.deepStrictEqual(
    Object.keys(proj.GLYPH).sort(),
    Object.values(TRUST).sort(),
    '若给 TRUST 加第四个值而忘了配字形，这条会先红 —— 而不是等到线上出现 "·"'
  );
  // 行为证明：把所有能构造出的（含畸形的）信封都投一遍，字形只准出现那三个。
  const shapes = [
    undefined, null, {}, 'string', 42, [],
    entry(envelope()),
    entry(envelope({ trust: TRUST.CLAIMED, producer: PRODUCER.CODEX })),
    entry(envelope({ trust: TRUST.QUARANTINED, producer: PRODUCER.RELAY, producerId: 'x' })),
    entry(envelope({ trust: 'bogus' })),
    entry(envelope({ trust: 'VERIFIED' })),
    entry(envelope({ trust: null })),
    entry(envelope({ producer: 'totally-unknown' })),
    entry(envelope({ producer: null, trust: TRUST.CLAIMED })),
    entry({}), // _khyTrace 是空对象
    { _khyTrace: null },
    { _khyTrace: 'not-an-object' },
  ];
  const allowed = new Set(Object.values(proj.GLYPH));
  for (const s of shapes) {
    const line = proj.inlineLabel(s);
    assert.ok(allowed.has(line[0]), `出现集合外字形 " ${line[0]} "（来自 ${JSON.stringify(s)}）：${line}`);
    assert.notEqual(line[0], '·', '"·" 应当不可达');
    assert.equal(proj.replayRow(s).glyph, line[0]);
  }
});

// ─────────────────────────────── inlineLabel / labelText ───────────────────────────────

test('inlineLabel 三形态精确串；producerId 存在时走 `producer:id claims`', () => {
  assert.strictEqual(proj.inlineLabel(entry(envelope())), '✓ KHY executed');
  assert.strictEqual(
    proj.inlineLabel(entry(envelope({ producer: PRODUCER.CODEX, trust: TRUST.CLAIMED }))),
    '⟳ codex claims'
  );
  assert.strictEqual(
    proj.inlineLabel(entry(envelope({ producer: PRODUCER.RELAY, producerId: 'codex-9', trust: TRUST.CLAIMED }))),
    '⟳ relay:codex-9 claims'
  );
  assert.strictEqual(
    proj.inlineLabel(entry(envelope({ producer: PRODUCER.CLAUDE_CODE, trust: TRUST.QUARANTINED }))),
    '⚠ quarantined'
  );
});

test('inlineLabel === 字形 + 单个空格 + labelText：隔离/验证态不带 producer', () => {
  const cases = [
    envelope(),
    envelope({ producer: PRODUCER.CODEX, trust: TRUST.CLAIMED }),
    envelope({ producer: PRODUCER.RELAY, producerId: 'zzz', trust: TRUST.CLAIMED }),
    envelope({ producer: PRODUCER.RELAY, producerId: 'zzz', trust: TRUST.QUARANTINED }),
  ];
  for (const env of cases) {
    const e = entry(env);
    const row = proj.replayRow(e); // row.label 即 labelText(entry)
    assert.match(row.label, /^[^\s]/, 'labelText 不得带字形前缀，也不得以前导空格开头');
    assert.strictEqual(proj.inlineLabel(e), `${row.glyph} ${row.label}`);
    assert.equal(row.label.includes(row.glyph), false, '文字部分不许掺进字形（否则拼不出内联标签）');
  }
  // 四种文字形态互不重叠（隔离文案绝不泄露被隔离调用的 payload，只给标签）。
  const texts = new Set(cases.map((c) => proj.replayRow(entry(c)).label));
  assert.deepStrictEqual(
    [...texts].sort(),
    ['KHY executed', 'codex claims', 'quarantined', 'relay:zzz claims'].sort()
  );
});

test('verified 恒显 "KHY executed"，与 producer 字段无关；quarantined 恒显 "quarantined"', () => {
  assert.strictEqual(
    proj.inlineLabel(entry(envelope({ trust: TRUST.VERIFIED, producer: PRODUCER.CODEX }))),
    '✓ KHY executed'
  );
  assert.strictEqual(
    proj.inlineLabel(entry(envelope({ trust: TRUST.VERIFIED, producer: PRODUCER.RELAY, producerId: 'x' }))),
    '✓ KHY executed'
  );
  assert.strictEqual(
    proj.inlineLabel(entry(envelope({ trust: TRUST.QUARANTINED, producer: PRODUCER.KHY_LOCAL }))),
    '⚠ quarantined'
  );
});

test('fail-safe-to-ours 渲染：无信封条目显示成 `✓ KHY executed`（并登记为显示面缺陷）', () => {
  assert.strictEqual(proj.inlineLabel({ role: 'user', content: 'hi' }), '✓ KHY executed');
  assert.strictEqual(proj.inlineLabel({}), '✓ KHY executed');
  assert.strictEqual(proj.inlineLabel(null), '✓ KHY executed');
  // 缺陷面（登记，不修）：信封被丢弃/被写坏（trust 不在枚举、producer 不在枚举、
  // _khyTrace 整体不是对象）时，isTrace 判假 → traceOf 回落 khy-local/verified，
  // 于是一条**外部中转**记录只要信封残缺就显示成「本地已验证」。
  const relayed = entry(envelope({ producer: PRODUCER.CODEX, trust: TRUST.CLAIMED }));
  assert.strictEqual(proj.inlineLabel(relayed), '⟳ codex claims');
  assert.strictEqual(proj.inlineLabel({ ...relayed, _khyTrace: { producer: 'codex', trust: 'claimd' } }), '✓ KHY executed');
  assert.strictEqual(proj.inlineLabel({ ...relayed, _khyTrace: { producer: null, trust: TRUST.CLAIMED } }), '✓ KHY executed');
  assert.strictEqual(proj.inlineLabel({ ...relayed, _khyTrace: { trust: TRUST.CLAIMED } }), '✓ KHY executed');
  assert.equal(khyTrace.isTrace(relayed), true);
  assert.equal(khyTrace.isTrace({ ...relayed, _khyTrace: { producer: 'codex', trust: 'claimd' } }), false);
});

// ─────────────────────────────── contradictionLabels ───────────────────────────────

test('contradictionLabels：逐条给一行，模板含引号内的声称与未运行的工具名', () => {
  const e = entry(
    envelope({
      producer: PRODUCER.CODEX,
      trust: TRUST.CLAIMED,
      contradictions: [{ claim: 'ran the test suite', expectedTool: 'Shell' }],
    })
  );
  assert.deepStrictEqual(proj.contradictionLabels(e), [
    '⚠ unverified claim: "ran the test suite" (no Shell ran)',
  ]);
  assert.equal(proj.contradictionLabels(e)[0][0], proj.GLYPH[TRUST.QUARANTINED], '矛盾行用 ⚠（与隔离同一字形）');
  // 多条声称 → 多行，顺序保持。
  const many = entry(
    envelope({
      trust: TRUST.CLAIMED,
      producer: PRODUCER.CODEX,
      contradictions: [
        { claim: 'a', expectedTool: 'TA' },
        { claim: 'b', expectedTool: 'TB' },
      ],
    })
  );
  assert.deepStrictEqual(proj.contradictionLabels(many), [
    '⚠ unverified claim: "a" (no TA ran)',
    '⚠ unverified claim: "b" (no TB ran)',
  ]);
});

test('contradictionLabels 退化：缺 claim → "claimed action"，缺 expectedTool → "tool"，非数组/缺失 → []', () => {
  const partial = entry(
    envelope({
      producer: PRODUCER.CODEX,
      trust: TRUST.CLAIMED,
      contradictions: [{}, { claim: 'only claim' }, { expectedTool: 'OnlyTool' }, null, { claim: 0 }, { claim: false }],
    })
  );
  assert.deepStrictEqual(proj.contradictionLabels(partial), [
    '⚠ unverified claim: "claimed action" (no tool ran)',
    '⚠ unverified claim: "only claim" (no tool ran)',
    '⚠ unverified claim: "claimed action" (no OnlyTool ran)',
    '⚠ unverified claim: "claimed action" (no tool ran)',
    '⚠ unverified claim: "claimed action" (no tool ran)', // 0 是 falsy → 也走兜底
    '⚠ unverified claim: "claimed action" (no tool ran)', // false 同理
  ]);
  assert.deepStrictEqual(proj.contradictionLabels(entry(envelope({ contradictions: 'nope' }))), []);
  assert.deepStrictEqual(proj.contradictionLabels(entry(envelope({ contradictions: null }))), []);
  assert.deepStrictEqual(proj.contradictionLabels({}), [], '无信封 → 默认信封的 contradictions 是 []');
  assert.deepStrictEqual(proj.contradictionLabels(null), []);
  // 对抗面：合法的一条不会因上面的退化而消失。
  assert.equal(
    proj.contradictionLabels(entry(envelope({ trust: TRUST.CLAIMED, producer: 'codex', contradictions: [{ claim: 'x', expectedTool: 'y' }] }))).length,
    1
  );
});

test('contradictionLabels 对非字符串 claim 走 String()：数字与数组都被拉平成文本', () => {
  const e = entry(envelope({ producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, contradictions: [{ claim: 42, expectedTool: ['Shell', 'Read'] }] }));
  assert.deepStrictEqual(proj.contradictionLabels(e), ['⚠ unverified claim: "42" (no Shell,Read ran)']);
});

// ─────────────────────────────── replayRow ───────────────────────────────

test('replayRow 八字段形状：index/glyph/trust/producer/kind/at/label/contradictions', () => {
  const e = entry(
    envelope({
      producer: PRODUCER.RELAY,
      producerId: 'claude-7',
      trust: TRUST.CLAIMED,
      kind: KIND.TOOL_CALL,
      at: 2024,
      contradictions: [{ claim: 'wrote the file', expectedTool: 'Write' }],
    })
  );
  const row = proj.replayRow(e, 5);
  assert.deepStrictEqual(Object.keys(row), ['index', 'glyph', 'trust', 'producer', 'kind', 'at', 'label', 'contradictions']);
  assert.deepStrictEqual(row, {
    index: 5,
    glyph: '⟳',
    trust: TRUST.CLAIMED,
    producer: 'relay:claude-7',
    kind: KIND.TOOL_CALL,
    at: 2024,
    label: 'relay:claude-7 claims',
    contradictions: ['⚠ unverified claim: "wrote the file" (no Write ran)'],
  });
  assert.strictEqual(proj.replayRow(e).index, null, 'index 缺省 null（不是 0，也不省略键）');
});

test('replayRow 对本地/隔离记录的正确投影，producer 不带 :id 时不拼冒号', () => {
  const local = proj.replayRow(entry(envelope({ producer: PRODUCER.KHY_LOCAL, trust: TRUST.VERIFIED })), 0);
  assert.deepStrictEqual([local.glyph, local.trust, local.producer, local.label], ['✓', TRUST.VERIFIED, 'khy-local', 'KHY executed']);
  assert.equal(local.producer.includes(':'), false);
  const q = proj.replayRow(entry(envelope({ producer: PRODUCER.CODEX, trust: TRUST.QUARANTINED, kind: KIND.TOOL_CALL })), 1);
  assert.deepStrictEqual([q.glyph, q.trust, q.producer, q.kind, q.label], ['⚠', TRUST.QUARANTINED, 'codex', KIND.TOOL_CALL, 'quarantined']);
  // 对抗面：同一 producer 换 trust，glyph 与 label 一起变（投影不缓存上一条）。
  assert.notDeepStrictEqual(proj.replayRow(entry(envelope({ producer: PRODUCER.CODEX, trust: TRUST.CLAIMED })), 1), q);
});

test('登记缺陷①（不修）：replayRow 并非纯函数 —— 缺有效信封时读时钟，两次调用结果不同', () => {
  const withEnvelope = entry(envelope({ at: 777 }));
  assert.deepStrictEqual(proj.replayRow(withEnvelope, 1), proj.replayRow(withEnvelope, 1), '有信封时才谈得上同输入同输出');

  const bare = { role: 'assistant', content: 'relay 正文，但信封丢了' };
  const realNow = Date.now;
  let tick = realNow.call(Date);
  let reads = 0;
  Date.now = () => {
    reads += 1;
    tick += 1000;
    return tick;
  };
  try {
    const r1 = proj.replayRow(bare);
    assert.ok(reads > 0, 'replayRow 竟然没读时钟 —— 本用例的判据失效，需要重查');
    const readsAfterOneRow = reads;
    const r2 = proj.replayRow(bare);
    assert.notStrictEqual(r1.at, r2.at, '模块头宣称「纯函数：同输入同输出，无 IO」，但 traceOf 回落路径读 Date.now()');
    assert.strictEqual(r2.at - r1.at, 1000 * readsAfterOneRow, '一次 replayRow 的每次内部归一各读一次时钟');
  } finally {
    Date.now = realNow;
  }
  // 真时钟下的可观测形式：两次调用都「接近现在」，所以肉眼看不出漂移。
  const a = proj.replayRow(bare).at;
  const b = proj.replayRow(bare).at;
  assert.ok(Math.abs(a - b) <= 50, `at=${a}/${b} 应当都贴着当前时钟`);
  assert.ok(a >= Date.now() - 5000 && a <= Date.now() + 5000);
  assert.strictEqual(proj.replayRow(withEnvelope).at, 777, '有合法信封时 at 原样透传（不读时钟）');
});

// ─────────────────────────────── chainStatusLine ───────────────────────────────

test('chainStatusLine 三种判决的精确文案，含「无 reason」变体与 #undefined 退化', () => {
  assert.strictEqual(proj.chainStatusLine(null), 'chain: unavailable');
  assert.strictEqual(proj.chainStatusLine(undefined), 'chain: unavailable');
  assert.strictEqual(proj.chainStatusLine({ available: false }), 'chain: unavailable');
  assert.strictEqual(proj.chainStatusLine({ available: false, ok: true, length: 9 }), 'chain: unavailable', 'available:false 压过 ok');
  assert.strictEqual(proj.chainStatusLine({ available: true, ok: true, length: 0 }), '✓ chain intact (0 entries)');
  assert.strictEqual(proj.chainStatusLine({ available: true, ok: true, length: 3 }), '✓ chain intact (3 entries)');
  assert.strictEqual(
    proj.chainStatusLine({ ok: false, available: true, length: 3, brokenAt: 1, reason: 'prevHash 断链于 #1' }),
    '⚠ chain broken @ #1 — prevHash 断链于 #1'
  );
  assert.strictEqual(proj.chainStatusLine({ ok: false, available: true, length: 3, brokenAt: 2 }), '⚠ chain broken @ #2');
  // 退化面（登记）：既没 ok 也没 available:false 的空对象会走 broken 分支，报出 #undefined。
  assert.strictEqual(proj.chainStatusLine({}), '⚠ chain broken @ #undefined');
  assert.strictEqual(proj.chainStatusLine(''), 'chain: unavailable');
});

test('chainStatusLine 与 traceChain.verify() 真实返回值往返：完好链', () => {
  const f = path.join(ROOT, `intact${traceChain.CHAIN_EXT}`);
  for (let i = 0; i < 3; i++) {
    assert.equal(traceChain.append(f, { uuid: `u${i}`, producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: `b${i}` }).ok, true);
  }
  const v = traceChain.verify(f);
  assert.ok(v.length > 0, '反空转护栏：链必须非空，否则 "intact" 是真空绿');
  assert.equal(v.ok, true);
  assert.strictEqual(proj.chainStatusLine(v), '✓ chain intact (3 entries)');
});

test('chainStatusLine 与 verify() 往返：篡改链把判据原文带到页脚（串味即红）', () => {
  const f = path.join(ROOT, `broken${traceChain.CHAIN_EXT}`);
  for (let i = 0; i < 3; i++) {
    traceChain.append(f, { uuid: `u${i}`, producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: `b${i}` });
  }
  const arr = traceChain.read(f);
  arr[2].trust = TRUST.VERIFIED; // 把「外部声称」洗成「本地已验证」
  fs.writeFileSync(f, JSON.stringify(arr));
  const v = traceChain.verify(f);
  assert.ok(v.length > 0);
  assert.equal(v.ok, false);
  const line = proj.chainStatusLine(v);
  assert.strictEqual(line, '⚠ chain broken @ #2 — 内容哈希不匹配于 #2（疑似篡改）');
  assert.ok(line.includes(String(v.brokenAt)));
  assert.ok(line.includes(v.reason), '页脚必须原样携带 verify 的 reason，不许改写判据');
});

test('chainStatusLine 与 verify() 往返：缺文件 → unavailable；空链 → intact (0 entries)（真空绿在 UI 上的样子）', () => {
  const missing = path.join(ROOT, `ghost${traceChain.CHAIN_EXT}`);
  assert.strictEqual(proj.chainStatusLine(traceChain.verify(missing)), 'chain: unavailable');
  const empty = path.join(ROOT, `empty${traceChain.CHAIN_EXT}`);
  fs.writeFileSync(empty, JSON.stringify([]));
  const v = traceChain.verify(empty);
  assert.equal(v.ok, true);
  assert.equal(v.length, 0);
  assert.strictEqual(proj.chainStatusLine(v), '✓ chain intact (0 entries)');
  // 对抗面：同一路径写入两条真记录后必须换成 2 entries —— 证明上一行不是硬编码。
  traceChain.append(empty, { uuid: 'a', producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'x' });
  traceChain.append(empty, { uuid: 'b', producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'y' });
  assert.strictEqual(proj.chainStatusLine(traceChain.verify(empty)), '✓ chain intact (2 entries)');
});

test('投影与隔离判决一致：quarantine 的记录渲染成 ⚠，allow/claimed 渲染成 ⟳', () => {
  const policy = require('./quarantinePolicy');
  const q = policy.decide({ producer: PRODUCER.CODEX, gateEnabled: true, interactive: false });
  const g = policy.decide({ producer: PRODUCER.CODEX, gateEnabled: true, interactive: true });
  assert.strictEqual(proj.inlineLabel(entry(envelope({ producer: PRODUCER.CODEX, trust: q.trust }))), '⚠ quarantined');
  assert.strictEqual(proj.inlineLabel(entry(envelope({ producer: PRODUCER.CODEX, trust: g.trust }))), '⟳ codex claims');
  // 对抗面：判决被逃生口放行时（ALLOW/CLAIMED），显示仍是「外部声称」，不随放行升格。
  const off = policy.decide({ producer: PRODUCER.CODEX, gateEnabled: false });
  assert.equal(off.action, policy.ACTION.ALLOW);
  assert.strictEqual(proj.inlineLabel(entry(envelope({ producer: PRODUCER.CODEX, trust: off.trust }))), '⟳ codex claims');
});
