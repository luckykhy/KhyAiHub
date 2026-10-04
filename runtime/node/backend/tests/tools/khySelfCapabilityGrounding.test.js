'use strict';

// 能力域「依据项目实际情况」的契约测试 —— 见
// docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-153] khy 自知面对齐规范.md §7
//
// 这一族测试防的不是「代码写错」,而是**叙述与实现之间没有映射**这件事本身。修前
// selfProfile.capabilityDomains 是一段写死的散文,三类缺陷(事实错误 / 发明分类 / 整片缺席)
// 都因为无人能检而长期存在。这里把每一句都接到一条**能被现场推翻**的来源上:
//   ① 声明不变量 —— 锚点非空、L 或 A 至少有一个、部件 ⊆ 锚点(禁 P 态)
//   ② 锚点漂移可机检 —— 每个锚点必须解析到真实模块;每个门控必须是 flagRegistry 的登记名
//   ③ 覆盖契约 —— src/ 顶层目录必须被锚点伸到或被显式排除(不允许沉默遗漏)
//   ④ 核验不恒绿 —— 故意损坏的锚点必须判失败(否则「已核验」是装饰)
//   ⑤ L 态真的取自现场 —— 工具类别/本地推理后端/技能数必须等于活 SSOT 的值
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(BACKEND_ROOT, 'src');
const SERVICES_DIR = path.join(SRC_DIR, 'services');

const scr = require('../../src/services/selfCapabilityRegistry');
const scv = require('../../src/services/selfCapabilityVerifier');
const evidence = require('../../src/services/selfEvidenceVerifier');
const selfProfile = require('../../src/services/selfProfile');
const sar = require('../../src/services/selfAuditRegistry');
const flagReg = require('../../src/services/flagRegistry');
const toolCategories = require('../../src/tools/_toolCategories');

const DOMAINS = scr.getCapabilityDomains();

// ── ① 声明不变量(禁 P 态) ────────────────────────────────────────────────────
test('G1:域集合冻结、key 唯一非空、label 非空', () => {
  assert.ok(Array.isArray(DOMAINS) && DOMAINS.length >= 20, '至少 20 个能力域');
  // 冻结的是 SSOT 本身(getCapabilityDomains() 返回浅拷贝,元素仍冻结)。
  assert.ok(Object.isFrozen(scr.CAPABILITY_DOMAINS), 'SSOT 外层冻结');
  assert.ok(Object.isFrozen(scr.CAPABILITY_DOMAINS[0]), 'SSOT 元素冻结');
  const seen = new Set();
  for (const d of DOMAINS) {
    assert.ok(Object.isFrozen(d), `${d.key} 冻结`);
    assert.strictEqual(typeof d.key, 'string');
    assert.ok(d.key.length > 0);
    assert.ok(!seen.has(d.key), `${d.key} 唯一`);
    seen.add(d.key);
    assert.ok(typeof d.label === 'string' && d.label.length > 0, `${d.key} 有 label`);
  }
  assert.strictEqual(scr.domainKeys().length, DOMAINS.length);
});

test('G2:每条域都满足 L/A 不变量(纯散文 P 态不得进入)', () => {
  for (const d of DOMAINS) {
    const a = d.evidenceAnchors || {};
    const anchors = [...(a.modules || []), ...(a.gates || [])];
    assert.ok(
      anchors.length > 0,
      `${d.key} 没有任何证据锚点 —— 无可核验来源的断言不得进入能力域清单(§7.2 禁 P 态)`
    );
    assert.ok(
      d.deriveFrom || d.claim,
      `${d.key} 既无 L 态取数标记也无 A 态断言 —— 空域`
    );
    const kind = scr.deriveKind(d);
    assert.ok(['live', 'live+claim', 'anchored'].includes(kind), `${d.key} kind 非法: ${kind}`);
  }
});

test('G2:parts[].module 必须出现在 evidenceAnchors.modules(部件与锚点不可分叉)', () => {
  for (const d of DOMAINS) {
    const mods = ((d.evidenceAnchors || {}).modules || []).slice();
    for (const p of d.parts || []) {
      assert.ok(
        mods.includes(p.module),
        `${d.key} 的部件 '${p.module}' 不在锚点清单里 —— 部件与锚点两份清单会各自漂`
      );
      assert.ok(typeof p.label === 'string' && p.label.length > 0, `${d.key}/${p.module} 有 label`);
    }
  }
});

// ── ② 锚点漂移可机检 ─────────────────────────────────────────────────────────
test('G3:每条域锚点都解析到真实模块(模块搬家后锚点必须同步)', () => {
  for (const d of DOMAINS) {
    for (const name of (d.evidenceAnchors || {}).modules || []) {
      const abs = path.join(SERVICES_DIR, String(name) + '.js');
      assert.ok(
        fs.existsSync(abs),
        `${d.key} 的锚点 '${name}' 解析到 ${path.relative(BACKEND_ROOT, abs)} 但文件不存在 —— 见 [DESIGN-ARCH-153] §7.4`
      );
    }
  }
});

test('G4:声明的门控必须是 flagRegistry 的登记名(否则错字会静默判「开」)', () => {
  // isFlagEnabled('KHY_TOTALLY_BOGUS') === true —— 未知门控默认开。若不做这一步,
  // 一个拼错的门控锚点会永远显示「已核验」,是纯装饰的可核验性。
  const check = (items, pick, tag) => {
    for (const it of items) {
      for (const g of (pick(it) || {}).gates || []) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(flagReg.FLAGS, g),
          `${tag} 声明的门控 '${g}' 不在 flagRegistry.FLAGS 里(共 ${Object.keys(flagReg.FLAGS).length} 个登记名)——错字会被默认开吞掉`
        );
      }
    }
  };
  check(DOMAINS, (d) => d.evidenceAnchors, 'selfCapabilityRegistry');
  check(sar.getSelfAuditItems(), (i) => i.evidenceAnchors, 'selfAuditRegistry');
});

test('G4:门控名做拼错对照实验(证明上一条测的不是恒真)', () => {
  assert.strictEqual(
    flagReg.isFlagEnabled('KHY_TOTALLY_BOGUS_XYZ', {}),
    true,
    '前提:未知门控默认开 —— 这正是需要 G4 存在的原因'
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(flagReg.FLAGS, 'KHY_TOTALLY_BOGUS_XYZ'));
});

// ── ③ 覆盖契约(不允许沉默遗漏) ───────────────────────────────────────────────
test('G5:src/ 顶层目录必须被锚点伸到或被显式排除', () => {
  const covered = new Set();
  for (const d of DOMAINS) {
    for (const name of (d.evidenceAnchors || {}).modules || []) {
      const r = evidence.resolveAnchorPath(name);
      if (!r || !r.ok) {
        continue;
      }
      const rel = path.relative(SRC_DIR, r.abs);
      if (rel && !rel.startsWith('..')) {
        covered.add(rel.split(path.sep)[0]);
      }
    }
  }
  const excluded = new Set(scr.getExcludedDirs().map((x) => x.name));
  const fsDirs = fs
    .readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .map((e) => e.name);

  const uncovered = fsDirs.filter((n) => !covered.has(n) && !excluded.has(n));
  assert.deepStrictEqual(
    uncovered,
    [],
    `这些 src/ 顶层目录既没被能力域锚点覆盖、也没在 excluded 里登记 —— 新能力域不得沉默缺席(§7.4)。补锚点或在 EXCLUDED_DIRS 里写明理由。scope=${scr.getCapabilityMeta().scope}`
  );

  const ghosts = [...covered, ...excluded].filter((n) => !fsDirs.includes(n));
  assert.deepStrictEqual(ghosts, [], `登记了但磁盘上不存在的目录:${ghosts.join(', ')}`);
});

test('G5:排除理由必须用封闭枚举里的 kind', () => {
  const kinds = new Set(scr.EXCLUSION_KINDS);
  assert.ok(kinds.size >= 4);
  for (const x of scr.getExcludedDirs()) {
    assert.ok(typeof x.name === 'string' && x.name.length > 0);
    assert.ok(kinds.has(x.kind), `${x.name} 的 kind '${x.kind}' 不在枚举内`);
    assert.ok(
      typeof x.reason === 'string' && x.reason.trim().length >= 4,
      `${x.name} 必须有非空理由(沉默遗漏的反面是把缺口也说出来)`
    );
  }
});

test('G5:元信息如实声明作用域边界(守住哪一层 + 没守哪一层)', () => {
  const meta = scr.getCapabilityMeta();
  assert.strictEqual(meta.scope, 'src/ 顶层目录');
  assert.ok(meta.domainCount === DOMAINS.length);
  assert.ok(meta.excludedCount === scr.getExcludedDirs().length);
  assert.match(meta.scopeLimit, /services/);
});

// ── ④ 核验不恒绿 ─────────────────────────────────────────────────────────────
test('G6:verifyAll 对全部 20 个域核验通过', () => {
  scv._resetCache();
  const res = scv.verifyAll({ env: {} });
  assert.ok(res && res.results, 'verifier 返回结果');
  const keys = Object.keys(res.results);
  assert.strictEqual(keys.length, DOMAINS.length);
  for (const [key, r] of Object.entries(res.results)) {
    assert.strictEqual(r.verified, true, `${key} 应核验通过,实际 reason=${r.reason}`);
  }
});

test('G6:核验机制能检出失败(不是恒绿装饰)', () => {
  const cases = [
    [undefined, '未声明'],
    [{ modules: [], gates: [] }, '锚点为空'],
    [{ modules: ['definitely/not/a/real/module'], gates: [] }, '模块缺失'],
    [{ modules: ['selfProfile'], gates: ['KHY_SELF_CAPABILITY_EVIDENCE'] }, '门控为关'],
  ];
  for (const [anchors, label] of cases) {
    const env = label === '门控为关' ? { KHY_SELF_CAPABILITY_EVIDENCE: '0' } : {};
    const r = evidence.verifyAnchors(anchors, { env });
    assert.strictEqual(r.verified, false, `${label} 应判失败,实际 reason=${r.reason}`);
    assert.ok(r.reason.length > 0, `${label} 必须给出可读原因(不许静默失败)`);
  }
});

test('G6:门控关闭 → verifyAll 返 null(不显示徽标),且绝不冒充「全部通过」', () => {
  scv._resetCache();
  assert.strictEqual(scv.verifyAll({ env: { KHY_SELF_CAPABILITY_EVIDENCE: '0' } }), null);
  scv._resetCache();
  assert.ok(scv.verifyAll({ env: {} }), '门控开 → 有结果');
});

test('G6:两个模块读同一门控(同一概念不得有两份定义)', () => {
  for (const env of [
    {},
    { KHY_SELF_CAPABILITY_EVIDENCE: '0' },
    { KHY_SELF_CAPABILITY_EVIDENCE: 'false' },
    { KHY_SELF_CAPABILITY_EVIDENCE: '1' },
  ]) {
    assert.strictEqual(
      scr.isEnabled(env),
      scv.isEnabled(env),
      `env=${JSON.stringify(env)} 下 selfCapabilityRegistry 与 selfCapabilityVerifier 的门控判定不一致`
    );
  }
});

test('G6:TTL 缓存生效,且在 TTL 内复用同一对象', () => {
  scv._resetCache();
  const a = scv.verifyAll({ env: { KHY_CAPABILITY_VERIFY_TTL_MS: '600000' } });
  const b = scv.verifyAll({ env: { KHY_CAPABILITY_VERIFY_TTL_MS: '600000' } });
  assert.strictEqual(a.checkedAt, b.checkedAt, 'TTL 内应复用同一份结果');
  scv._resetCache();
  const c = scv.verifyAll({ env: {} });
  assert.ok(c);
});

// ── ⑤ L 态真的取自现场 ───────────────────────────────────────────────────────
test('G7:tools.categories 的键 == tools/_toolCategories 的真实类别(发明的分类不得回归)', () => {
  selfProfile.invalidateStaticCache();
  const doms = selfProfile.getFullProfile({}).capabilityDomains;
  const keys = Object.keys(doms.tools.categories || {}).sort();
  assert.deepStrictEqual(
    keys,
    [...toolCategories.VALID_CATEGORIES].sort(),
    '工具类别键必须来自唯一真源;修前这里用的是 file_ops/git/task/web/code_exec/media/agent/lsp 八个发明标签'
  );
  assert.ok(!keys.includes('file_ops') && !keys.includes('code_exec') && !keys.includes('lsp'));
});

test('G7:本地推理后端链 == localLLMService.LOCAL_LLM_BACKENDS 的实际顺序', () => {
  const llm = require('../../src/services/localLLMService');
  const ids = llm.LOCAL_LLM_BACKENDS.map((b) => b.id);
  assert.deepStrictEqual(ids, ['ollama-runner', 'node-llama-cpp', 'python-server', 'ollama']);
  selfProfile.invalidateStaticCache();
  const d = selfProfile.getFullProfile({}).capabilityDomains.local_inference;
  assert.deepStrictEqual(
    d.backends.map((b) => b.id),
    ids,
    '描述必须现取后端链'
  );
  assert.match(d.description, /ollama-runner → node-llama-cpp → python-server → ollama/);
  assert.ok(
    !/llama-cpp-python/.test(d.description),
    '修前写的 llama-cpp-python 不是任何一个真实 _backend 取值'
  );
});

test('G7:工具数/技能数/命令数取自现场,不是常量', () => {
  selfProfile.invalidateStaticCache();
  const p = selfProfile.getFullProfile({});
  const doms = p.capabilityDomains;
  const tm = require('../../src/tools/index');
  tm.loadTools();
  assert.strictEqual(p.runtime.tools.registered, tm.count(), '注册表工具数应等于活注册表');
  assert.match(doms.tools.summary, new RegExp(String(tm.count())));
  assert.ok(p.runtime.skills.count > 0, '技能数必须取自 src/skills 的加载器(修前恒为 0)');
  assert.match(doms.skills.description, new RegExp(String(p.runtime.skills.count)));
  assert.match(doms.commands.description, new RegExp(`^${p.runtime.commands.routerCount} 路由命令`));
});

test('G7:部件域的描述由存活部件组成,且不可能多于实现', () => {
  selfProfile.invalidateStaticCache();
  const doms = selfProfile.getFullProfile({}).capabilityDomains;
  const ma = DOMAINS.find((d) => d.key === 'multi_agent');
  assert.strictEqual(
    doms.multi_agent.modes.length,
    ma.parts.length,
    '部件全部存活时,模式清单应等于声明部件数'
  );
  assert.ok(doms.multi_agent.modes.length >= 6, '修前只列 3 种,实际实现 ≥6 种');
  for (const key of ['os_operations', 'security', 'app_runtime', 'memory', 'messaging']) {
    const d = doms[key];
    assert.ok(d.description && d.description.length > 0, `${key} 描述不得为空`);
    assert.ok(Array.isArray(d.features) && d.features.length > 0, `${key} features 非空`);
  }
});

test('G7:已知事实错误不得回归(Alpine 构建 / 发明的分类标签)', () => {
  selfProfile.invalidateStaticCache();
  const doms = selfProfile.getFullProfile({}).capabilityDomains;
  const blob = JSON.stringify(doms);
  assert.ok(
    !/Alpine/i.test(blob),
    '「Alpine ISO build」与真实构建器(自写 C 内核 + Limine/GRUB)无关,是事实错误'
  );
  assert.match(doms.os_operations.description, /自写 C 内核/);
  assert.ok(doms.os_operations.features.some((f) => /Limine\/GRUB/.test(f)));
});

test('G7:每个能力域的描述非空(空描述是沉默的空白)', () => {
  selfProfile.invalidateStaticCache();
  const doms = selfProfile.getFullProfile({}).capabilityDomains;
  for (const [key, d] of Object.entries(doms)) {
    assert.ok(
      typeof d.description === 'string' && d.description.trim().length > 0,
      `${key} 描述为空`
    );
    assert.ok(d.summary && d.summary.length > 0, `${key} summary 为空`);
    assert.ok(d.source && d.source.length > 0, `${key} 缺少取数分层标签`);
  }
});

// ── 分面集成 ─────────────────────────────────────────────────────────────────
test('G8:capabilities 分面含 20 个域 + grounding 总览 + 逐域 anchorStatus', () => {
  const f = selfProfile.getSelfFacet('capabilities', { env: {} });
  assert.strictEqual(f.ok, true);
  assert.strictEqual(Object.keys(f.data).length, DOMAINS.length);
  assert.ok(f.grounding && f.grounding.total === DOMAINS.length);
  assert.strictEqual(f.grounding.verified, DOMAINS.length);
  assert.deepStrictEqual(f.grounding.failed, []);
  for (const key of scr.domainKeys()) {
    assert.strictEqual(f.data[key].anchorStatus, 'verified', `${key} 应带 verified 徽标`);
  }
});

test('G8:核验不可用时 anchorStatus 缺席(而不是渲染成通过)', () => {
  scv._resetCache();
  const f = selfProfile.getSelfFacet('capabilities', { env: { KHY_SELF_CAPABILITY_EVIDENCE: '0' } });
  assert.strictEqual(f.ok, true);
  assert.strictEqual(Object.keys(f.data).length, DOMAINS.length, '域清单不因门控关而消失');
  assert.strictEqual(f.grounding.available, false);
  for (const key of scr.domainKeys()) {
    assert.strictEqual(
      f.data[key].anchorStatus,
      undefined,
      `${key} 在未核验时不得带任何徽标(缺席 ≠ 通过)`
    );
  }
  scv._resetCache();
});

test('G8:khy self 的人类输出逐域渲染,且与域清单一一对应', () => {
  selfProfile.invalidateStaticCache();
  const profile = selfProfile.getFullProfile({});
  const human = selfProfile.formatForHuman(profile).split('## 我的局限')[0];
  // 逐个比对**物化后**的 summary(renderer 消费的是它),而不是声明里的 label。
  for (const [key, d] of Object.entries(profile.capabilityDomains)) {
    assert.ok(human.includes(d.summary), `人类输出缺少能力域 ${key} (summary='${d.summary}')`);
  }
  assert.match(human, /证据核验：20\/20 通过/);
  // 硬编码的每域小节清单已删除:新增域无需再改渲染器。
  const src = fs.readFileSync(path.join(SERVICES_DIR, 'selfProfile.js'), 'utf8');
  assert.ok(
    !/sections\.push\(`### AI 网关`\)/.test(src),
    'formatForHuman 不得再手写每域小节标题(那是漂移源)'
  );
});

test('G8:技能指针指向真实加载器(修前指向 governance 叶子 → 恒 0)', () => {
  const sm = require('../../src/skills/index');
  assert.strictEqual(typeof sm.getSkillCommands, 'function');
  assert.ok(sm.getSkillCommands().length > 0, '真实加载器应能列出技能');
  selfProfile.invalidateStaticCache();
  const p = selfProfile.getFullProfile({});
  assert.match(selfProfile.formatBrief(p), /Skills: [1-9]/);
});

test('G8:未传入会话工具清单时 enabled 为 null 且带注册表真值(不得伪造 0)', () => {
  selfProfile.invalidateStaticCache();
  const rt = selfProfile.getFullProfile({}).runtime;
  assert.strictEqual(rt.tools.enabled, null, '未传入应为 null(未知),不是 0');
  assert.ok(rt.tools.registered > 0);
  assert.match(rt.tools.note, /未知/);
  const supplied = selfProfile.getFullProfile({ enabledTools: ['Read', 'Write'] }).runtime;
  assert.strictEqual(supplied.tools.enabled, 2);
  assert.deepStrictEqual(supplied.tools.list, ['Read', 'Write']);
  assert.strictEqual(supplied.tools.note, null);
});

// ── 与既有自知面的兼容 ───────────────────────────────────────────────────────
test('G9:新机制不改变分面数量(SELF_FACETS 仍恰好 8 个)', () => {
  assert.strictEqual(selfProfile.SELF_FACETS.length, 8);
});

test('G9:自审面行为不回归(仍 5 项全核验通过、无 ·核验失败)', () => {
  const res = require('../../src/services/selfAuditVerifier').verifyAll({ env: {} });
  for (const [id, r] of Object.entries(res.results)) {
    assert.strictEqual(r.verified, true, `${id} 应核验通过`);
  }
  const block = selfProfile.formatForSystemPrompt(selfProfile.getFullProfile({}));
  assert.ok(block.includes('## khyos 自我认知'));
  assert.ok(!/·核验失败/.test(block));
});

test('G9:shared verifier 的解析语义未变(两个注册表共用一份实现)', () => {
  assert.strictEqual(require('../../src/services/selfAuditVerifier').isEnabled({}), true);
  const a = evidence.verifyAnchors({ modules: ['selfProfile'], gates: [] }, { env: {} });
  assert.strictEqual(a.verified, true);
  assert.strictEqual(a.reason, '全部证据锚点核验通过');
  assert.ok(a.checks.length > 0);
});

// ── G10:本地推理不可用时必须说实话(RUNTIME-002 §2.2 问题+原因+修复) ──────────
// 此前无论何种原因不可用,人类输出恒打印「安装 Ollama」——那只是若干成因之一,
// 属于「把猜测当结论」。现改为透出 localLLMService.getStatus() 的真实成因与修复。
function renderLlmSection(patch) {
  const llmSvc = require('../../src/services/localLLMService');
  const orig = llmSvc.getStatus;
  llmSvc.getStatus = () => Object.assign(orig.call(llmSvc), patch);
  try {
    selfProfile.invalidateStaticCache();
    const h = selfProfile.formatForHuman();
    const i = h.indexOf('### 本地 LLM 推理');
    const end = h.indexOf('\n\n', i);
    return h.slice(i, end === -1 ? undefined : end);
  } finally {
    llmSvc.getStatus = orig;
    selfProfile.invalidateStaticCache();
  }
}

test('G10:不可用 + 服务给出 importHint → 用真实修复,不写死「安装 Ollama」', () => {
  const HINT = 'SENTINEL-REAL-HINT-FROM-SERVICE';
  const sec = renderLlmSection({
    loaded: false, available: false,
    modelDiscoveryReason: 'not_found', modelImportHint: HINT, modelIncompatible: false,
  });
  assert.ok(sec.includes('原因:'), '必须给出原因');
  assert.ok(sec.includes(HINT), '修复建议必须来自服务,而非硬编码');
  assert.ok(!sec.includes('https://ollama.com/download'), '有真实成因时不得回落到写死的 Ollama 链接');
});

test('G10:不可用 + 无任何成因线索 → 才回落到通用 Ollama 提示', () => {
  const sec = renderLlmSection({
    loaded: false, available: false,
    modelDiscoveryReason: 'not_found', modelImportHint: null, modelIncompatible: false, lastError: null,
  });
  assert.ok(sec.includes('原因: 未发现可运行的本地模型'));
  assert.ok(sec.includes('https://ollama.com/download'), '无线索时通用提示作为兜底仍应出现');
});

test('G10:模型格式不兼容 → 透出诊断,不误报「未找到模型」', () => {
  const sec = renderLlmSection({
    loaded: false, available: false, modelIncompatible: true,
    modelLoadDiagnosis: 'GGUF q2_K not supported', modelDiscoveryReason: 'available',
  });
  assert.ok(sec.includes('不兼容'), '应说明是格式不兼容');
  assert.ok(sec.includes('GGUF q2_K not supported'), '应带真实诊断文本');
  assert.ok(!sec.includes('未发现可运行的本地模型'), '不得把不兼容误报为未找到');
});

test('G10:可用(loaded)→ 不渲染原因/修复两行(避免对正常状态说丧气话)', () => {
  const sec = renderLlmSection({
    loaded: true, available: true, backend: 'ollama',
    modelDiscoveryReason: 'available', modelImportHint: null, modelIncompatible: false,
  });
  assert.ok(sec.includes('✓ 状态: loaded'), '可用应显示 ✓');
  assert.ok(!sec.includes('原因:'), '可用态不得渲染原因行');
  assert.ok(!/ollama\.com\/download|SENTINEL/.test(sec), '可用态不得渲染修复建议');
});

test('G10:getStatus 抛错 → 状态收敛为 unknown,不编造成因', () => {
  const llmSvc = require('../../src/services/localLLMService');
  const orig = llmSvc.getStatus;
  llmSvc.getStatus = () => { throw new Error('probe boom'); };
  let sec = '';
  try {
    selfProfile.invalidateStaticCache();
    const h = selfProfile.formatForHuman();
    const i = h.indexOf('### 本地 LLM 推理');
    sec = h.slice(i, h.indexOf('\n\n', i));
  } finally {
    llmSvc.getStatus = orig;
    selfProfile.invalidateStaticCache();
  }
  assert.ok(sec.includes('unknown'), '探测失败必须如实标 unknown');
  assert.ok(!sec.includes('probe boom'), '异常细节不得泄漏进面向用户的状态');
});