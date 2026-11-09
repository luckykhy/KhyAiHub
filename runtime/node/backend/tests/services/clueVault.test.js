'use strict';

/**
 * clueVault — 线索保全的守护测试（node:test；jest 按 jest.config.js 自动跳过本文件）。
 *
 * 锁的口径（谁改谁先红）：
 *   ① 门控 KHY_CLUE_VAULT 默认开、仅 CANON 4 词关；关 → buildDigest/系统提示块返 ''
 *      （接缝逐字节回退）。
 *   ② 四类判据（约束/决策/锚/未决）的确定性识别 + 否定语境 veto（「不需要」「没有新决定」
 *      「还没决定」不得误判）。
 *   ③ 去重保留最早、来源标注保真；台账可被再次识别（跨轮压缩不丢、不涨）。
 *   ④ 预算：每类条数上限 + 总字符 ≤ maxChars（含 footer 预留）。
 *   ⑤ 阶段常量字面量（check-rollout-stage.js 用同一正则找它比对登记表）。
 *   ⑥ 三接缝载重：contextCompressor（摘要输入/增量摘要/cycle boundary/回流消息）与
 *      agenticHarnessService（checkpoint contextSummary）。
 *   ⑦ **字节回退对照**：不可变基线 commit（889920fe = 本机制落地前的最后一版，其
 *      contextCompressor 不含 clueVault）与本版在同一夹具、门控关下跑 compress()，摘要
 *      提示与输出消息逐字节一致；门控开则注入真实出现。基线取不到、或基线已含 clueVault
 *      → 判红（不许静默 skip，防「对照空跑 8 条全绿」的旧坑——见
 *      autoModelSelect.headRevert.test.js 的教训）。**勿把基线改回 `HEAD`**：本改动一提交
 *      HEAD 版即含 clueVault，对照会退化成「新代码对新代码」的空对照（复核 mustFix #2）。
 *   ⑧ LIVE wiring（集成锁，参照 confidenceCalibration.test.js 同款）：flagRegistry 登记、
 *      selfProfile A 层注入、FEATURE-OWNERSHIP 阶段登记——在共享登记文件的 registryPatches
 *      落地前会红，这是刻意的「接线是否真发生」机器判据，首绿即接线完成。
 */

process.env.KHY_COMPACT_AUDIT = '0'; // 测试不写审计台账
process.env.KHY_COMPACT_NOTICE = '0'; // 测试不打提示行

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const cv = require('../../src/services/clueVault');
const cc = require('../../src/services/contextCompressor');

const BACKEND_ROOT = path.resolve(__dirname, '../../');
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SERVICES_DIR = path.join(BACKEND_ROOT, 'src', 'services');
const CC_REL = 'runtime/node/backend/src/services/contextCompressor.js';
/**
 * 字节对照基线（**不可变 commit**，复核 mustFix #2）：889920fe = 本机制落地前的最后一版。
 * 别改回 `HEAD`——本改动一提交，HEAD 版即含 clueVault，对照会退化成「新代码对新代码」的
 * 空对照；也别删下面「基线不含 clueVault」的断言（它防对照失效被锁成正确）。
 */
const BASELINE_SHA = '889920fef1b37f2631ba8320ba95fa99aec26da7';
const HARNESS_PATH = path.join(SERVICES_DIR, 'agenticHarnessService.js');

const FIXTURE = () => [
  { role: 'system', content: 'You are khy.' },
  {
    role: 'user',
    content:
      '帮我优化启动速度。必须保持 CLI 行为不变，不要动 runtime/node/backend/src/cli/router.js 的路由面。',
  },
  { role: 'assistant', content: '收到，先看启动链。' },
  { role: 'user', content: '继续' },
  {
    role: 'assistant',
    content:
      '决定: 改用惰性 require 因为启动 require 图太大。\n下一步要确认 KHY_BOOT_PREFETCH 默认值。',
  },
  { role: 'assistant', content: '读取了 bootstrap/init.js，跑了一次时间统计。' },
  { role: 'user', content: '好' },
];

const EST = (text) => Math.ceil(String(text || '').length / 4);

// ── ① 门控 ────────────────────────────────────────────────────────────────
test('KHY_CLUE_VAULT 默认开，仅 CANON 4 词关；坏 env 绝不抛', () => {
  assert.strictEqual(cv.isEnabled({}), true);
  assert.strictEqual(cv.isEnabled({ KHY_CLUE_VAULT: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(cv.isEnabled({ KHY_CLUE_VAULT: off }), false, `'${off}'`);
  }
  assert.strictEqual(cv.isEnabled({ KHY_CLUE_VAULT: '1' }), true);
  assert.doesNotThrow(() => cv.isEnabled(null));
  assert.doesNotThrow(() => cv.isEnabled(42));
});

// ── ② 阶段常量（check-rollout-stage.js 的字面量契约）───────────────────────
test('阶段常量是字面量 S1，getStage 只认 S2/S3 且绝不 fail-open', () => {
  const src = fs.readFileSync(path.join(SERVICES_DIR, 'clueVault.js'), 'utf8');
  const hit = /const\s+KHY_CLUE_VAULT_STAGE\s*=\s*['"](S[1-4])['"]/.exec(src);
  assert.ok(hit, 'clueVault.js 必须有 const KHY_CLUE_VAULT_STAGE = \'S1\' 字面量（守卫靠它比对登记表）');
  assert.strictEqual(hit[1], cv.KHY_CLUE_VAULT_STAGE);
  assert.strictEqual(cv.getStage({}), 'S1');
  assert.strictEqual(cv.getStage({ KHY_CLUE_VAULT_STAGE: 'S2' }), 'S2');
  assert.strictEqual(cv.getStage({ KHY_CLUE_VAULT_STAGE: 'S3' }), 'S3');
  assert.strictEqual(cv.getStage({ KHY_CLUE_VAULT_STAGE: 'S9' }), 'S1', '非法值回落 S1');
  assert.strictEqual(cv.getStage({ KHY_CLUE_VAULT_STAGE: 's2' }), 'S2', '大小写归一');
});

// ── ③ SSOT 冻结 ───────────────────────────────────────────────────────────
test('CLUE_KINDS / PER_KIND_LIMIT / 抽取结果全部冻结（对外只读真源）', () => {
  assert.ok(Object.isFrozen(cv.CLUE_KINDS));
  for (const k of cv.CLUE_KINDS) {
    assert.ok(Object.isFrozen(k));
    assert.ok(typeof k.why === 'string' && k.why.length > 0, '每类必须声明丢失代价 why');
  }
  assert.ok(Object.isFrozen(cv.PER_KIND_LIMIT));
  const clues = cv.extractClues(FIXTURE(), {});
  assert.ok(Object.isFrozen(clues));
  for (const c of clues) assert.ok(Object.isFrozen(c));
  assert.throws(() => {
    clues.push({});
  });
});

// ── ④ 判据：四类识别 + veto ───────────────────────────────────────────────
test('四类判据确定性识别；否定语境 veto 不误判', () => {
  const msgs = [
    { role: 'user', content: '不要修改 router.js，必须跑一遍回归' },
    { role: 'assistant', content: '决定: 改用 node:test 因为 jest 不可用' },
    { role: 'assistant', content: '待确认 KHY_CLUE_VAULT_STAGE 的默认值' },
    { role: 'assistant', content: '看 `boulderState.js` 的 schema v4' },
    { role: 'assistant', content: '今天下午聊了聊天气，没什么特别的事' },
  ];
  const clues = cv.extractClues(msgs, {});
  const kinds = clues.map((c) => c.kind);
  assert.deepStrictEqual(kinds, ['constraint', 'decision', 'open', 'anchor']);
  assert.ok(clues[3].text.includes('boulderState.js'), '锚类保原文');

  // veto：否定语境不是线索（或不落入被否决的类别）
  const vetoed = cv.extractClues(
    [
      { role: 'assistant', content: '不需要再包一层兼容 shim' },
      { role: 'assistant', content: '目前没有新决定，按原方案继续' },
      { role: 'assistant', content: '还没决定用什么框架' },
    ],
    {}
  );
  const vetoKinds = vetoed.map((c) => `${c.kind}:${c.text}`);
  assert.ok(
    !vetoKinds.some((s) => s.startsWith('constraint:') && s.includes('不需要')),
    '「不需要」不得判为约束'
  );
  assert.ok(
    !vetoKinds.some((s) => s.startsWith('decision:') && s.includes('没有新决定')),
    '「没有新决定」不得判为决策'
  );
  assert.ok(
    vetoKinds.some((s) => s.startsWith('open:') && s.includes('还没决定')),
    '「还没决定」应判为未决（被保下来，而非丢弃）'
  );
});

test('去重保留最早、来源保真、重复计数 hits', () => {
  const msg = { role: 'user', content: '必须保持向后兼容' };
  const clues = cv.extractClues([msg, msg, { role: 'assistant', content: '必须保持向后兼容' }], {});
  assert.strictEqual(clues.length, 1, '同一线索只保留一条');
  assert.strictEqual(clues[0].hits, 3);
  assert.strictEqual(clues[0].source, '用户#1', '来源取最早出现');
});

// ── ⑤ 渲染：格式、预算、上限 ─────────────────────────────────────────────
test('renderLedger：空线索返空串；格式 `- [类别·来源] 文本`；预算内截断', () => {
  assert.strictEqual(cv.renderLedger([], {}), '');
  const out = cv.buildDigest(FIXTURE(), { env: {} });
  assert.ok(out.startsWith(cv.CLUE_LEDGER_MARKER), '首行是台账标记');
  assert.ok(/- \[约束·用户#2\]/u.test(out), '格式与来源标注');
  assert.ok(out.includes('必须保持 CLI 行为不变'), 'constraint 原文在');
  assert.ok(out.includes('决定: 改用惰性 require'), 'decision 原文在');
  // 预算：超多线索时 ≤ maxChars 且给出「超预算未列」尾行
  const many = [];
  for (let i = 0; i < 40; i++) {
    many.push({ role: 'user', content: `必须保留第 ${i} 项约束，不得省略` });
  }
  const big = cv.buildDigest(many, { env: {}, maxChars: 600 });
  assert.ok(big.length <= 600, `digest 超预算: ${big.length}`);
  assert.ok(/超出预算未列出/u.test(big), '截断必须如实标注');
  // 每类上限：12 条约束 ≥ PER_KIND_LIMIT.constraint(8) → 至多 8 条 + 尾行
  const keptLines = big.split('\n').filter((l) => l.startsWith('- [约束'));
  assert.ok(keptLines.length <= cv.PER_KIND_LIMIT.constraint, 'per-kind 上限生效');
});

test('buildDigest 确定性：同输入两次调用逐字节一致；门控关返空串', () => {
  const a = cv.buildDigest(FIXTURE(), { env: {} });
  const b = cv.buildDigest(FIXTURE(), { env: {} });
  assert.strictEqual(a, b);
  assert.strictEqual(cv.buildDigest(FIXTURE(), { env: { KHY_CLUE_VAULT: 'off' } }), '');
  assert.strictEqual(cv.buildDigest(null, { env: {} }), '');
  assert.strictEqual(cv.buildDigest([], { env: {} }), '');
});

// ── ⑥ 跨轮回流：不丢、不涨、来源保真 ────────────────────────────────────
test('台账回流：再次抽取逐字节一致（跨轮压缩线索不丢不涨）', () => {
  const digest1 = cv.buildDigest(FIXTURE(), { env: {} });
  assert.ok(digest1.length > 0);
  const ledgerMsg = {
    role: 'assistant',
    content: `<${cv.CLUE_LEDGER_TAG}>\n[automated] earlier clues.\n\n${digest1}\n</${cv.CLUE_LEDGER_TAG}>`,
  };
  // 第二轮：原始消息已被折叠，只剩台账 + 新对话
  const digest2 = cv.buildDigest(
    [ledgerMsg, { role: 'assistant', content: '进展：按原方案继续推进。' }],
    { env: {} }
  );
  assert.strictEqual(digest2, digest1, '回流块内的线索原样带回（含原始来源标注）');
});

test('buildDigestWithCarry：承接上一轮台账（来源保真）+ 并入新线索；派生正文不参与', () => {
  const digest1 = cv.buildDigest(FIXTURE(), { env: {} });
  assert.ok(digest1.includes('- [约束·用户#2]'));
  const prior = `[Compressed context summary]\n模型写的摘要正文（必须不参与抽取）。\n${digest1}`;
  const next = [{ role: 'assistant', content: '决定: 改用增量摘要 因为全文重写太贵。' }];
  const merged = cv.buildDigestWithCarry(prior, next, { env: {} });
  assert.ok(merged.includes('- [约束·用户#2]'), '上一轮约束被承接且来源保真');
  assert.ok(merged.includes('- [决策·助手#1]'), '新线索并入');
  assert.ok(!merged.includes('必须不参与抽取'), '摘要正文（派生文本）不得被当成新线索');
  // 同 kind+文本去重保留首见
  const dedup = cv.buildDigestWithCarry(prior, [next[0], next[0]], { env: {} });
  assert.strictEqual((dedup.match(/改用增量摘要/g) || []).length, 1, '去重保留首见');
  // prior 不含台账 → 不承接任何内容
  const none = cv.buildDigestWithCarry('[Compressed context summary]\n正文。', next, { env: {} });
  assert.ok(!none.includes('必须保持 CLI 行为不变'), '无台账的 prior 不贡献线索');
  // 门控关 → 逐字节回退
  assert.strictEqual(cv.buildDigestWithCarry(prior, next, { env: { KHY_CLUE_VAULT: 'off' } }), '');
});

// ── ⑦ 系统提示块 ─────────────────────────────────────────────────────────
test('formatForSystemPrompt：开→标记+纪律；关→逐字节回退空串', () => {
  const on = cv.formatForSystemPrompt({ env: {} });
  assert.ok(on.includes(cv.CLUE_VAULT_MARKER));
  assert.ok(on.includes(cv.CLUE_LEDGER_MARKER), '块内点名 [CLUE-LEDGER v1]');
  assert.ok(/继续有效|抵触/u.test(on), '含「与台账抵触要显式说明」纪律');
  assert.ok(/决策: |未决: /u.test(on), '含线索书写格式纪律');
  assert.strictEqual(cv.formatForSystemPrompt({ env: { KHY_CLUE_VAULT: '0' } }), '');
  assert.strictEqual(cv.formatForSystemPrompt(null), cv.formatForSystemPrompt({ env: {} }));
});

// ── ⑧ 绝不抛 ─────────────────────────────────────────────────────────────
test('绝不抛：坏输入全部 fail-soft', () => {
  assert.doesNotThrow(() => cv.extractClues(undefined, {}));
  assert.doesNotThrow(() => cv.extractClues([{ role: 'user' }, null, 42, {}], {}));
  assert.doesNotThrow(() => cv.renderLedger(null, {}));
  assert.doesNotThrow(() => cv.renderLedger([{ kind: 'nope' }], {}));
  assert.doesNotThrow(() => cv.summarize(null));
  assert.doesNotThrow(() => cv.formatForSystemPrompt(undefined));
  const s = cv.summarize({ env: {} });
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.stage, 'S1');
});

// ── ⑨ 三接缝载重（源级断言）─────────────────────────────────────────────
test('contextCompressor 三处接缝都 require clueVault 并接门控语义', () => {
  const src = fs.readFileSync(path.join(SERVICES_DIR, 'contextCompressor.js'), 'utf8');
  assert.ok(/require\(['"]\.\/clueVault['"]\)/.test(src), 'contextCompressor requires clueVault');
  assert.ok(/\[Clues that must survive compression/.test(src), '主摘要提示注入段存在');
  assert.ok(/「丢了会出错」线索\(确定性抽取,务必并入摘要/u.test(src), '增量摘要提示注入段存在');
  assert.ok(/_clueLedgerSection\(/.test(src), '压缩结果摘要块内的台账段存在');
  assert.ok(/cycleClueDigest/.test(src), 'cycle boundary 兜底追加存在');
});

test('agenticHarnessService 的 checkpoint contextSummary 由 buildDigest 填充', () => {
  const src = fs.readFileSync(HARNESS_PATH, 'utf8');
  assert.ok(/require\(['"]\.\/clueVault['"]\)/.test(src), 'harness requires clueVault');
  const hits = src.match(/buildDigest\(/g) || [];
  assert.ok(hits.length >= 2, '两个 checkpoint 生产点都接 buildDigest');
  assert.ok(
    /info\.contextSummary \|\|[\s\S]{0,120}buildDigest\(info\.messages/.test(src),
    '中断 checkpoint 以 digest 填充（info.contextSummary 优先透传不变）'
  );
  assert.ok(
    /loopResult\?\.contextSummary \|\|[\s\S]{0,120}buildDigest\(loopResult\?\.conversationMessages/.test(
      src
    ),
    '续跑轮 checkpoint 以 digest 填充'
  );
});

test('证据锚点声明可解析（防锚点漂移被锁成正确）+ seamMarkers 逐接缝消费', () => {
  const anchors = cv.EVIDENCE_ANCHORS;
  assert.ok(Object.isFrozen(anchors) && Object.isFrozen(anchors.seams));
  for (const rel of anchors.seams) {
    assert.ok(fs.existsSync(path.join(BACKEND_ROOT, rel)), `接缝 '${rel}' 必须真实存在`);
  }
  assert.ok(anchors.gates.includes('KHY_CLUE_VAULT'));

  // seamMarkers 消费（复核 mustFix #3）：每个接缝文件必须真实接线（标记齐备），
  // 防「整合时整条丢失」——此前该字段零消费者，形同虚设。
  // ⚠ selfProfile.js 的 A 层注入以 registryPatches 交付（共享文件，本工作区按规则未改）；
  // 它在补丁落盘前判红是刻意的（「接线是否真发生」的机器判据，首绿即接线完成），
  // 不是放行理由——删断言不许，接线才许。
  for (const rel of anchors.seams) {
    const markers = anchors.seamMarkers[rel];
    assert.ok(Array.isArray(markers) && markers.length > 0, `接缝 '${rel}' 必须声明接线标记`);
    const src = fs.readFileSync(path.join(BACKEND_ROOT, rel), 'utf8');
    for (const m of markers) {
      assert.ok(src.includes(m), `接缝 '${rel}' 缺少接线标记 ${JSON.stringify(m)}（整条丢失/接线被删）`);
    }
  }
  assert.ok(Object.isFrozen(anchors.seamMarkers), 'seamMarkers 冻结');
});

// ── ⑩ 跨轮不丢 + 不可变基线字节对照（本测试即 probe 的核心）─────────────────
test('两轮连续压缩：最初定的规矩仍在台账里（跨轮不丢、来源保真）', async () => {
  const run = async (messages) =>
    cc.compress(messages, {
      estimateTokensFn: EST,
      callModelFn: async () => ({ reply: '摘要（测试桩）：保留任务目标、约束与待办。'.repeat(2) }),
      contextWindowTokens: 60,
      force: true,
    });
  const prev = process.env.KHY_CLUE_VAULT;
  try {
    delete process.env.KHY_CLUE_VAULT;
    const first = await run(FIXTURE());
    const text1 = JSON.stringify(first.compressed);
    assert.ok(text1.includes('[CLUE-LEDGER v1]'), '第一轮已注入台账');

    // 第二轮：在第一轮结果上继续追加对话，再压缩一次
    const grown = [
      ...first.compressed,
      { role: 'user', content: '继续第三步' },
      { role: 'assistant', content: '跑了一次构建，耗时偏长，先记录。' },
      { role: 'assistant', content: '决定: 缓存 require 图 因为重复解析成本高。' },
      { role: 'user', content: '好' },
    ];
    const second = await run(grown);
    const text2 = JSON.stringify(second.compressed);
    assert.ok(text2.includes('[CLUE-LEDGER v1]'), '第二轮台账仍在');
    assert.ok(text2.includes('帮我优化启动速度'), '首轮约束原文经两轮压缩仍留存');
    assert.ok(text2.includes('[约束·用户#2]'), '来源标注跨轮保真（未被改写成新位次）');
  } finally {
    if (prev === undefined) delete process.env.KHY_CLUE_VAULT;
    else process.env.KHY_CLUE_VAULT = prev;
  }
});

test('gate off → 与基线版 compress() 逐字节一致；gate on → 注入真实出现', async () => {
  const oldSrc = execSync(`git show ${BASELINE_SHA}:${CC_REL}`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.ok(
    !/clueVault/.test(oldSrc),
    `基线 ${BASELINE_SHA.slice(0, 8)} 已含 clueVault —— 对照失效（基线必须是不含本机制的改前形态；基线被污染请修基线来源，勿静默去掉断言）`
  );

  const tmpCopy = path.join(SERVICES_DIR, 'contextCompressor.__headcopy.for-test.js');
  let oldMod;
  try {
    fs.writeFileSync(tmpCopy, oldSrc, 'utf-8');
    oldMod = require(tmpCopy);
  } finally {
    try {
      fs.unlinkSync(tmpCopy);
    } catch {
      /* already gone */
    }
  }

  const run = async (mod, messages) => {
    const prompts = [];
    const result = await mod.compress(messages, {
      estimateTokensFn: EST,
      callModelFn: async (text) => {
        prompts.push(text);
        return { reply: '摘要（测试桩）：保留任务目标、约束与待办。'.repeat(2) };
      },
      contextWindowTokens: 60,
      force: true,
    });
    return { prompts, result: JSON.parse(JSON.stringify(result)) };
  };

  const prev = process.env.KHY_CLUE_VAULT;
  try {
    // ── 门控关：新旧两版在全链路（摘要提示 + 输出消息）上逐字节一致 ──
    process.env.KHY_CLUE_VAULT = 'off';
    const offOld = await run(oldMod, FIXTURE());
    const offNew = await run(cc, FIXTURE());
    assert.strictEqual(offNew.prompts.length, 1, '对照必须真的走到摘要模型调用（否则空跑）');
    assert.deepStrictEqual(offNew.prompts, offOld.prompts, '门控关：摘要提示必须逐字节回退');
    assert.deepStrictEqual(offNew.result, offOld.result, '门控关：压缩输出必须逐字节回退');
    assert.ok(!offNew.prompts[0].includes('[CLUE-LEDGER'), '门控关：提示里不得有台账');

    // ── 门控开：注入真实出现（证明机制非空转）──
    delete process.env.KHY_CLUE_VAULT;
    const onNew = await run(cc, FIXTURE());
    assert.ok(onNew.prompts[0].includes('[CLUE-LEDGER v1]'), '门控开：摘要提示含线索台账');
    const summaryMsg = onNew.result.compressed.find(
      (m) => typeof m.content === 'string' && m.content.includes('<compressed_context>')
    );
    assert.ok(summaryMsg, '压缩结果含自动摘要块');
    assert.ok(
      summaryMsg.content.includes(`<${cv.CLUE_LEDGER_TAG}>`) &&
        summaryMsg.content.includes('[CLUE-LEDGER v1]'),
      '门控开：摘要块内含 <clue_ledger> 台账段'
    );
    assert.strictEqual(
      onNew.result.compressed.length,
      offNew.result.compressed.length,
      '台账并入摘要块——消息条数与门控关一致（不改变下游桥接结构）'
    );
    assert.notStrictEqual(
      JSON.stringify(onNew.result),
      JSON.stringify(offNew.result),
      '开/关输出必须可区分（否则机制是空转）'
    );
  } finally {
    if (prev === undefined) {
      delete process.env.KHY_CLUE_VAULT;
    } else {
      process.env.KHY_CLUE_VAULT = prev;
    }
  }
});

test('增量摘要路径：gate off 与 HEAD 逐字节一致；gate on 注入线索段', async () => {
  const mkIncrementalFixture = () => [
    { role: 'system', content: 'You are khy.' },
    {
      role: 'user',
      content:
        '[Compressed context summary]\n此前摘要：优化启动速度。必须保持 CLI 行为不变，不要动 router.js。',
    },
    {
      role: 'assistant',
      content: '决定: 改用惰性 require 因为启动 require 图太大。\n待确认 KHY_BOOT_PREFETCH。',
    },
    { role: 'user', content: '好' },
    { role: 'assistant', content: '又读了一遍 init.js。' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '跑了一次时间统计。' },
    { role: 'user', content: '继续推进' },
    { role: 'assistant', content: '还在看启动链。' },
  ];

  const oldSrc = execSync(`git show ${BASELINE_SHA}:${CC_REL}`, { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.ok(
    !/clueVault/.test(oldSrc),
    `基线 ${BASELINE_SHA.slice(0, 8)} 已含 clueVault —— 增量路径对照失效（同 test 16 的判据，勿删）`
  );
  const tmpCopy = path.join(SERVICES_DIR, 'contextCompressor.__headcopy.for-test.js');
  let oldMod;
  try {
    fs.writeFileSync(tmpCopy, oldSrc, 'utf-8');
    oldMod = require(tmpCopy);
  } finally {
    try {
      fs.unlinkSync(tmpCopy);
    } catch {
      /* already gone */
    }
  }

  const run = async (mod, messages) => {
    const prompts = [];
    const result = await mod.compress(messages, {
      estimateTokensFn: () => 2000,
      callModelFn: async (text) => {
        prompts.push(text);
        return { reply: '增量摘要（测试桩）：合并约束与决策。'.repeat(2) };
      },
      contextWindowTokens: 100,
      force: true,
    });
    return { prompts, result: JSON.parse(JSON.stringify(result)) };
  };

  const prev = process.env.KHY_CLUE_VAULT;
  try {
    process.env.KHY_CLUE_VAULT = 'off';
    const offOld = await run(oldMod, mkIncrementalFixture());
    const offNew = await run(cc, mkIncrementalFixture());
    assert.strictEqual(offNew.prompts.length, 1, '对照必须真的走到增量摘要模型调用（否则空跑）');
    assert.deepStrictEqual(offNew.prompts, offOld.prompts, '门控关：增量提示逐字节回退');
    assert.deepStrictEqual(offNew.result, offOld.result, '门控关：增量输出逐字节回退');

    delete process.env.KHY_CLUE_VAULT;
    const onNew = await run(cc, mkIncrementalFixture());
    assert.ok(onNew.prompts[0].includes('「丢了会出错」线索'), '门控开：增量提示含线索段');
    const summaryOn = onNew.result.compressed.find(
      (m) => typeof m.content === 'string' && m.content.includes('[Compressed context summary]')
    );
    assert.ok(summaryOn, '增量结果含摘要消息');
    assert.ok(summaryOn.content.includes('[CLUE-LEDGER v1]'), '替换摘要时台账回流（不随旧文本丢）');

    // 承接上一轮台账：prior 摘要自带台账行 → 增量替换后该行仍在（来源保真）
    const withPriorLedger = () => {
      const fx = mkIncrementalFixture();
      fx[1] = {
        role: 'user',
        content:
          '[Compressed context summary]\n此前摘要：优化启动速度。\n[CLUE-LEDGER v1] 1 条\n- [约束·用户#9] 不要动 router.js 的路由面',
      };
      return fx;
    };
    const carried = await run(cc, withPriorLedger());
    const carriedSummary = carried.result.compressed.find(
      (m) => typeof m.content === 'string' && m.content.includes('[Compressed context summary]')
    );
    assert.ok(
      carriedSummary.content.includes('[约束·用户#9] 不要动 router.js 的路由面'),
      '上一轮台账被承接（含原始来源标注）'
    );
  } finally {
    if (prev === undefined) delete process.env.KHY_CLUE_VAULT;
    else process.env.KHY_CLUE_VAULT = prev;
  }
});

test('cycle boundary：gate off briefing 逐字节回退；gate on 含台账且不越预算', async () => {
  const mk = () => [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '必须保持 CLI 行为不变，不要动 router.js。' },
    { role: 'assistant', content: '决定: 改用惰性 require 因为启动图太大。' },
    { role: 'user', content: '继续' },
  ];
  const estFn = () => 100000; // 单条即越 CYCLE_THRESHOLD_TOKENS

  const prev = process.env.KHY_CLUE_VAULT;
  try {
    process.env.KHY_CLUE_VAULT = 'off';
    const off = await cc.triggerCycleBoundary(mk(), { estimateTokensFn: estFn });
    assert.strictEqual(off.cycleTriggered, true);
    const offBrief = off.messages[off.messages.length - 1];
    const boundOff = off.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('<cycle_boundary')
    );
    assert.ok(boundOff, 'cycle boundary 消息存在');
    assert.ok(!boundOff.content.includes('[CLUE-LEDGER'), '门控关：briefing 不得含台账');

    delete process.env.KHY_CLUE_VAULT;
    const on = await cc.triggerCycleBoundary(mk(), { estimateTokensFn: estFn });
    const boundOn = on.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('<cycle_boundary')
    );
    assert.ok(boundOn.content.includes('[CLUE-LEDGER v1]'), '门控开：briefing 含确定性台账');
    assert.ok(boundOn.content.includes('必须保持 CLI 行为不变'), '约束原文被保下来');
    // 除 cycle_boundary 正文外，消息骨架开/关一致（只增不改）
    assert.strictEqual(on.messages.length, off.messages.length);
    assert.strictEqual(
      JSON.stringify(on.messages.map((m) => m.role)),
      JSON.stringify(off.messages.map((m) => m.role))
    );
    assert.ok(offBrief && JSON.stringify(offBrief) === JSON.stringify(on.messages[on.messages.length - 1]));
  } finally {
    if (prev === undefined) delete process.env.KHY_CLUE_VAULT;
    else process.env.KHY_CLUE_VAULT = prev;
  }
});

// ── ⑪ LIVE wiring（集成锁，同 confidenceCalibration.test.js 及 selfAuditRegistry.test.js 同款）─
// ⚠ 以下 3 条在共享登记文件的 registryPatches 落地前会红 —— 这是刻意的：它们就是
// 「接线是否真发生」的机器判据，首绿即接线完成。删断言不许，接线才许。
test('wiring: flagRegistry 登记 KHY_CLUE_VAULT（default-on / CANON）', () => {
  const flags = require('../../src/utils/flagRegistry');
  const hit = flags.listFlags().find((f) => f.name === 'KHY_CLUE_VAULT');
  assert.ok(hit, 'flag registered in FLAGS (CANON dialect)');
  assert.strictEqual(hit.mode, 'default-on');
  assert.strictEqual(hit.off, 'CANON');
});

test('wiring: selfProfile 注入 A 层块（开→标记；关→逐字节回退）', () => {
  const selfProfile = require('../../src/services/selfProfile');
  const marker = cv.CLUE_VAULT_MARKER;
  const prev = process.env.KHY_CLUE_VAULT;
  // 不调 getFullProfile(全盘探测,数十秒);注入块只看 env,不依赖 profile 内容。
  const minimalProfile = { runtime: {}, identity: {} };
  try {
    delete process.env.KHY_CLUE_VAULT;
    const on = selfProfile.formatForSystemPrompt(minimalProfile);
    assert.ok(on.includes(marker), 'gate-on system prompt carries the CLUE-LEDGER directive');
    process.env.KHY_CLUE_VAULT = '0';
    const off = selfProfile.formatForSystemPrompt(minimalProfile);
    assert.ok(!off.includes(marker), 'gate-off system prompt has no CLUE-LEDGER directive');
    const block = cv.formatForSystemPrompt({ env: {} });
    assert.strictEqual(
      off,
      on.replace('\n\n' + block, ''),
      'gate-off output is byte-identical to gate-on minus the block（逐字节回退）'
    );
  } finally {
    if (prev === undefined) delete process.env.KHY_CLUE_VAULT;
    else process.env.KHY_CLUE_VAULT = prev;
  }
});

test('wiring: FEATURE-OWNERSHIP 登记 clue-vault（S1 + rollback + executorStage）', () => {
  const p = path.join(REPO_ROOT, 'docs/10_规范/registry/FEATURE-OWNERSHIP.json');
  const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const mech = ((reg.rollout && reg.rollout.mechanisms) || []).find((m) => m.id === 'clue-vault');
  assert.ok(mech, 'mechanism registered in rollout.mechanisms');
  assert.strictEqual(mech.stage, 'S1', 'starts as S1 observer (PROCESS-008)');
  assert.ok(String(mech.rollback || '').trim(), 'rollback action registered (PP-4)');
  assert.ok(mech.executorStage && mech.executorStage.file, 'executorStage file declared');
  assert.strictEqual(mech.executorStage.constant, 'KHY_CLUE_VAULT_STAGE');
});
