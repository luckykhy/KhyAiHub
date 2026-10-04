'use strict';

/**
 * selfProfile.js — khy OS 自我画像服务（单一事实来源）
 *
 * 设计理念：像人一样，清晰的自我认知让 agent 更明确自己能做什么、怎么做。
 *
 * 三重输出：
 *   formatForSystemPrompt()  → 注入 system prompt，agent 自知（token-efficient）
 *   formatForHuman()         → khy self 命令输出，学习者他知（中文 Markdown）
 *   formatForAPI()           → JSON，供前端/外部系统消费
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Lazy requires (avoid circular deps at startup) ──────────────────────────

let _skillsModule = null;
function getSkillsModule() {
  if (!_skillsModule) {
    // The skill loader (getSkillCommands/loadSkillsFromDir/…) lives at src/skills/, NOT at
    // src/services/skills/ — the latter exports the skill *governance* leaf
    // (journeyTimeline / skillThreatScanner / …). This pointer used to aim at
    // './skills/index', so `getSkillCommands` was never a function, the guard
    // `typeof sm.getSkillCommands === 'function'` was silently false, and every consumer
    // reported `技能 (0 已加载)` / `Skills: 0` as if it were a measured fact. A wrong
    // module pointer + a type guard is a conclusion that can never be checked.
    _skillsModule = require('../skills/index');
  }
  return _skillsModule;
}

let _commandSchema = null;
function getCommandSchema() {
  if (!_commandSchema) {
    _commandSchema = require('../constants/commandSchema');
  }
  return _commandSchema;
}

let _gateway = null;
function getGateway() {
  if (!_gateway) {
    try {
      _gateway = require('./gateway/aiGateway');
    } catch {
      _gateway = null;
    }
  }
  return _gateway;
}

let _localLLM = null;
function getLocalLLM() {
  if (!_localLLM) {
    try {
      _localLLM = require('./localLLMService');
    } catch {
      _localLLM = null;
    }
  }
  return _localLLM;
}

let _knowledgeService = null;
function getKnowledgeService() {
  if (!_knowledgeService) {
    try {
      _knowledgeService = require('./knowledgeTeachingService');
    } catch {
      _knowledgeService = null;
    }
  }
  return _knowledgeService;
}

let _toolsModule = null;
function getToolsModule() {
  if (!_toolsModule) {
    try {
      _toolsModule = require('../tools/index');
    } catch {
      _toolsModule = null;
    }
  }
  return _toolsModule;
}

function getWasmDefaults() {
  return require('../constants/wasmDefaults');
}

let _dataHome = null;
function getDataHome() {
  if (!_dataHome) {
    try {
      _dataHome = require('../utils/dataHome');
    } catch {
      _dataHome = null;
    }
  }
  return _dataHome;
}

let _selfLocation = null;
function getSelfLocation() {
  if (!_selfLocation) {
    try {
      _selfLocation = require('./selfLocation');
    } catch {
      _selfLocation = null;
    }
  }
  return _selfLocation;
}

let _commandCatalog = null;
function getCommandCatalog() {
  if (!_commandCatalog) {
    try {
      _commandCatalog = require('./domain/catalog/commandCatalog/commandCatalog');
    } catch {
      _commandCatalog = null;
    }
  }
  return _commandCatalog;
}

let _selfAuditRegistry = null;
function getSelfAuditRegistry() {
  if (!_selfAuditRegistry) {
    try {
      _selfAuditRegistry = require('./selfAuditRegistry');
    } catch {
      _selfAuditRegistry = null;
    }
  }
  return _selfAuditRegistry;
}

let _selfAuditVerifier = null;
function getSelfAuditVerifier() {
  if (!_selfAuditVerifier) {
    try {
      _selfAuditVerifier = require('./selfAuditVerifier');
    } catch {
      _selfAuditVerifier = null;
    }
  }
  return _selfAuditVerifier;
}

let _selfCapabilityRegistry = null;
function getSelfCapabilityRegistry() {
  if (!_selfCapabilityRegistry) {
    try {
      _selfCapabilityRegistry = require('./selfCapabilityRegistry');
    } catch {
      _selfCapabilityRegistry = null;
    }
  }
  return _selfCapabilityRegistry;
}

let _selfCapabilityVerifier = null;
function getSelfCapabilityVerifier() {
  if (!_selfCapabilityVerifier) {
    try {
      _selfCapabilityVerifier = require('./selfCapabilityVerifier');
    } catch {
      _selfCapabilityVerifier = null;
    }
  }
  return _selfCapabilityVerifier;
}

let _evidenceVerifier = null;
function getEvidenceVerifier() {
  if (!_evidenceVerifier) {
    try {
      _evidenceVerifier = require('./selfEvidenceVerifier');
    } catch {
      _evidenceVerifier = null;
    }
  }
  return _evidenceVerifier;
}

function getPackageVersion() {
  try {
    const pkg = require('../../package.json');
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── Static profile (cacheable, no runtime dependency) ───────────────────────

let _staticCache = null;

/**
 * Derive gateway adapter count and names from the actual registry.
 * Falls back to empty if gateway is not yet initialized.
 */
function _deriveAdapterInfo() {
  const gw = getGateway();
  if (!gw) {
    return { count: 0, names: [] };
  }
  try {
    const status = typeof gw.getStatus === 'function' ? gw.getStatus() : [];
    const all = Array.isArray(status) ? status : [];
    return { count: all.length, names: all.map((a) => a.name || a.key || '').filter(Boolean) };
  } catch {
    return { count: 0, names: [] };
  }
}

/**
 * Derive tool count and category breakdown from the actual tools registry.
 */
function _deriveToolInfo() {
  const tm = getToolsModule();
  if (!tm) {
    return { count: 0, categories: {} };
  }
  try {
    const total = typeof tm.count === 'function' ? tm.count() : 0;
    const grouped = typeof tm.getByCategory === 'function' ? tm.getByCategory() : {};
    const categories = {};
    for (const [cat, tools] of Object.entries(grouped)) {
      categories[cat] = tools.map((t) => t.name || '').filter(Boolean);
    }
    return { count: total, categories };
  } catch {
    return { count: 0, categories: {} };
  }
}

// ─── Capability domains: declaration + live derivation (见 [DESIGN-ARCH-153] §7) ──
//
// 「khyself 不能完全依赖文档自知,而应该依据项目实际情况」的落点。修前 capabilityDomains 是
// 一段写死的散文,三类缺陷都源于同一件事:**叙述没有任何机器可读的映射到实现**,所以既无人能
// 检、也无人会察觉它在漂。三个实测缺陷(D-A/D-B/D-D)见 selfCapabilityRegistry 的文件头。
//
// 修法(L/A/禁P,§7.2):
//   L 态:能现场算出来的就不写散文 —— 适配器/工具类别/本地推理后端/命令计数全部现取;
//   部件域:描述由**存活部件**组成(模块被删,描述里就少一项,而不是继续被声称);
//   A 态:无法派生的断言必须带证据锚点,由 selfCapabilityVerifier 运行时核验;
//   P 态:两者都不成立的纯散文**不得**进入本清单 —— 这是本设计的唯一红线。

/**
 * L 态取数。全部取自既有 SSOT,不新增 IO 类别(adapterInfo/toolInfo 本就在本函数的调用链上)。
 * 任何一项取不到 → 保留零值并由 materialize 阶段如实描述,绝不回填猜测。
 * @returns {object}
 */
function _deriveDomainFacts() {
  const facts = {
    adapters: { count: 0, names: [] },
    tools: { count: 0, categories: {} },
    toolTaxonomy: {},
    toolCategoryKeys: [],
    localBackends: [],
    routerCount: 0,
    slashCount: 0,
    skillCount: 0,
  };
  try {
    facts.adapters = _deriveAdapterInfo();
  } catch {
    /* keep zero value */
  }
  try {
    facts.tools = _deriveToolInfo();
  } catch {
    /* keep zero value */
  }
  try {
    const tc = require('../tools/_toolCategories');
    facts.toolTaxonomy = (tc && tc.CATEGORIES) || {};
    facts.toolCategoryKeys = Array.isArray(tc && tc.VALID_CATEGORIES)
      ? [...tc.VALID_CATEGORIES]
      : Object.keys(facts.toolTaxonomy);
  } catch {
    /* keep zero value */
  }
  try {
    const llm = getLocalLLM();
    facts.localBackends =
      llm && Array.isArray(llm.LOCAL_LLM_BACKENDS) ? llm.LOCAL_LLM_BACKENDS : [];
  } catch {
    /* keep zero value */
  }
  try {
    const cs = getCommandSchema();
    facts.routerCount =
      typeof cs.getRouterCommandNames === 'function' ? cs.getRouterCommandNames().length : 0;
    facts.slashCount =
      typeof cs.getBuiltinSlashCommands === 'function' ? cs.getBuiltinSlashCommands().length : 0;
  } catch {
    /* keep zero value */
  }
  try {
    const sm = getSkillsModule();
    const cmds = typeof sm.getSkillCommands === 'function' ? sm.getSkillCommands() : [];
    facts.skillCount = Array.isArray(cmds) ? cmds.length : 0;
  } catch {
    /* keep zero value */
  }
  return facts;
}

/**
 * 按模块存在性过滤一个域的部件。**「核验不了」不得伪装成「核验为不存在」**:核验器不可解析时
 * 保留全部声明部件,并由调用方标注 `features` 是声明值而非核验结果。
 * @param {object} d 声明的域
 * @returns {{alive:string[], total:number, filtered:boolean}}
 */
function _aliveParts(d) {
  const parts = Array.isArray(d && d.parts) ? d.parts : [];
  if (parts.length === 0) {
    return { alive: [], total: 0, filtered: true };
  }
  const ev = getEvidenceVerifier();
  if (!ev || typeof ev.resolveAnchorPath !== 'function') {
    return { alive: parts.map((p) => p.label), total: parts.length, filtered: false };
  }
  const alive = [];
  for (const p of parts) {
    let ok = false;
    try {
      ok = !!ev.resolveAnchorPath(p.module).ok;
    } catch {
      ok = false;
    }
    if (ok) {
      alive.push(p.label);
    }
  }
  return { alive, total: parts.length, filtered: true };
}

/**
 * 把一条声明 + 现场事实物化成对外形状 `{key,label,summary,description,source,...}`。
 * 保持既有字段(summary/description/categories/modes/abis/features)不变,新增
 * source(取数分层)/label/backends/providers/note。
 * @param {object} d     selfCapabilityRegistry 的声明
 * @param {object} facts _deriveDomainFacts() 的结果
 * @param {object} scr   selfCapabilityRegistry 模块
 * @returns {object}
 */
function _materializeDomain(d, facts, scr) {
  const parts = Array.isArray(d.parts) ? d.parts : [];
  const ap = _aliveParts(d);
  // 部件域的描述由存活部件组成 —— 模块被删,这一项就从描述里消失,而不是继续被声称。
  const partsDesc = parts.length
    ? ap.alive.length
      ? ap.alive.join('、')
      : `（声明的 ${ap.total} 个部件模块均未解析到 —— 该能力域当前不可用）`
    : '';

  const entry = {
    key: d.key,
    label: d.label,
    summary: d.label,
    description: parts.length ? partsDesc : d.claim || '',
    source: scr && typeof scr.deriveKind === 'function' ? scr.deriveKind(d) : 'declared',
  };

  switch (d.key) {
    case 'ai_gateway': {
      entry.summary = '多模型 AI 网关';
      entry.description =
        facts.adapters.count > 0
          ? `${facts.adapters.count} 适配器 (${facts.adapters.names.join(', ')})，自动检测与故障转移`
          : '多模型适配器，自动检测与故障转移（适配器清单本上下文不可解析，未回填猜测）';
      if (facts.adapters.names.length > 0) {
        entry.providers = facts.adapters.names.slice();
      }
      break;
    }
    case 'local_inference': {
      entry.summary = '本地 LLM 推理';
      // 修前这里写的是 `llama-cpp-python`,而真实后端 id 是 `python-server` / `ollama`
      // (localLLMService 的 _backend 取值)—— 文案与实现不一致,且无人能检。现由
      // LOCAL_LLM_BACKENDS 现取,顺序即 ensureLoaded 的实际尝试顺序。
      entry.description = facts.localBackends.length
        ? `${facts.localBackends.length} 级 fallback：${facts.localBackends.map((b) => b.id).join(' → ')}`
        : '本地推理后端链本上下文不可解析（未回填猜测）';
      if (facts.localBackends.length > 0) {
        entry.backends = facts.localBackends.map((b) => ({
          id: b.id,
          label: b.label,
          requires: b.requires,
        }));
      }
      break;
    }
    case 'tools': {
      entry.summary = facts.tools.count > 0 ? `${facts.tools.count} 工具` : '工具集';
      const keys = Array.isArray(facts.toolCategoryKeys) ? facts.toolCategoryKeys : [];
      entry.description = keys.length
        ? `${facts.tools.count} 工具，按 ${keys.length} 个类别组织（类别真源：tools/_toolCategories）`
        : d.claim || '';
      const cats = {};
      for (const k of keys) {
        const names = (facts.tools.categories && facts.tools.categories[k]) || [];
        cats[k] = names.length
          ? `${names.length} tools (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''})`
          : '0 tools';
      }
      if (Object.keys(cats).length > 0) {
        entry.categories = cats;
      }
      if (facts.tools.count === 0) {
        entry.note =
          '工具注册表未加载（本上下文）——计数为 0 不等于「没有该类别」，不要据此宣称某类别不存在';
      }
      break;
    }
    case 'skills': {
      entry.summary = '可扩展技能系统';
      entry.description = facts.skillCount > 0
        ? `${d.claim}（当前 ${facts.skillCount} 个可用）`
        : `${d.claim}（技能清单本上下文不可解析）`;
      break;
    }
    case 'commands': {
      entry.summary = 'CLI 命令体系';
      entry.description = `${facts.routerCount} 路由命令 + ${facts.slashCount} 斜杠命令，涵盖网关/技能/系统/应用管理`;
      break;
    }
    case 'wasm_runtime': {
      const { SUPPORTED_ABIS } = getWasmDefaults();
      entry.summary = 'WASM 应用沙箱';
      entry.description = `${d.claim}，支持 ${SUPPORTED_ABIS.join('/')} ABI`;
      entry.abis = [...SUPPORTED_ABIS];
      break;
    }
    case 'app_runtime': {
      entry.summary = '应用运行时';
      entry.description = `${partsDesc}。默认内置应用：khyquant（量化交易）`;
      break;
    }
    case 'learning': {
      entry.summary = '学习引导系统';
      entry.description = d.claim;
      break;
    }
    case 'multi_agent': {
      entry.summary = '多智能体协作';
      // 修前 modes 只列 3 种,实际实现 ≥6 种。现为「存活部件」清单,不可能比实现多。
      entry.modes = ap.alive.slice();
      break;
    }
    case 'os_operations': {
      entry.summary = '系统操作';
      break;
    }
    case 'security': {
      entry.summary = '安全体系';
      break;
    }
    case 'memory': {
      entry.summary = '记忆与日志';
      break;
    }
    case 'messaging': {
      entry.summary = '消息与通道';
      break;
    }
    default: {
      // claim-only 域:描述即断言。
      entry.description = d.claim || partsDesc;
      break;
    }
  }

  if (parts.length > 0) {
    entry.features = ap.alive.slice();
    if (!ap.filtered) {
      entry.note =
        '部件存在性未核验（selfEvidenceVerifier 不可解析）——features 为声明值，不是核验结果';
    }
  }
  return entry;
}

/**
 * 由声明叶子 + 现场事实构建 capabilityDomains。叶子不可解析 → null(调用方回退)。
 *
 * **刻意没有 env 门控**。早期版本在这里放了「门控关 → 回退旧的静态散文清单」,删掉是因为两点
 * 实测问题:① buildStaticProfile() 是记忆化的,门控实际只在进程内首次调用时解析一次 —— 首次
 * 调用之后的「关」永远走不到,那是个假开关;② 被回退的那些字节里有两处假话(Alpine 构建、
 * 发明的分类标签),保留它等于留一个说假话的后门。声明与 L 态派生属于**正确性本身**,正确性
 * 不设开关;可开关的只有证据核验(A 态),由 selfCapabilityVerifier 的门控管。
 * @returns {object|null}
 */
function _buildCapabilityDomains() {
  const scr = getSelfCapabilityRegistry();
  if (!scr || typeof scr.getCapabilityDomains !== 'function') {
    return null;
  }
  let declared;
  try {
    declared = scr.getCapabilityDomains();
  } catch {
    return null;
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    return null;
  }
  const facts = _deriveDomainFacts();
  const out = {};
  for (const d of declared) {
    if (!d || typeof d.key !== 'string') {
      continue;
    }
    out[d.key] = _materializeDomain(d, facts, scr);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function buildStaticProfile() {
  if (_staticCache) {
    return _staticCache;
  }

  // 能力域取数分工:声明在 selfCapabilityRegistry(纯数据),L 态派生在 _deriveDomainFacts,
  // 物化在 _materializeDomain。此处不再有第二份手写的能力清单(见上方 §7 说明)。
  const facts = _deriveDomainFacts();

  _staticCache = {
    identity: {
      name: 'khy OS',
      version: getPackageVersion(),
      positioning: 'AI platform operating system with extensible default app runtime',
      personality: '务实、主动、像朋友一样的同事',
    },

    // ====== OS 平台能力（与上层应用严格解耦） ======
    // 声明 + L 态派生(部件按模块存在性过滤);叶子不可解析 → 空对象(不编造能力清单)。
    // 见 [DESIGN-ARCH-153] §7。A 态(证据核验)在 selfCapabilityVerifier,门控只管它。
    capabilityDomains: _buildCapabilityDomains() || {},

    // ====== OS 层的能力边界（不包含应用层边界） ======
    // 刻意**不加**证据锚点(与 capabilityDomains 的处理不同,不是遗漏):边界断言说的是
    // 「做不到什么」,而「缺席」没有模块可指向 —— 给边界硬挂一个「模块存在」的锚点只能
    // 证明该模块存在,证明不了该限制成立,那是装饰性锚点、是假的可核验性。故边界保持
    // A 态散文,并由 selfCapabilityRegistry 的说明如实标注它不在锚点契约内。
    boundaries: [
      { short: '工具受权限约束', detail: '执行范围由用户权限模式决定，危险操作需确认' },
      { short: '本地推理受硬件限制', detail: '模型精度和速度取决于本机 GPU/CPU 和模型大小' },
      { short: '上下文有限', detail: '超长对话会自动压缩历史，早期信息可能被裁剪' },
      { short: '不伪装确定性', detail: '信息不足时标注「已知/假设/未知」，不编造事实' },
      {
        short: '平台不等于应用',
        detail: 'khy OS 提供基础设施，具体业务能力由上层应用 (如 khyquant) 提供',
      },
    ],
  };

  return _staticCache;
}

// ─── Runtime detection (session-specific, call per request) ──────────────────

function detectRuntimeCapabilities(opts = {}) {
  const runtime = {
    platform: `${os.platform()} ${os.arch()}`,
    nodeVersion: process.version,
    pythonVersion: _detectPython(),
    cwd: opts.cwd || process.cwd(),
    permissionMode: opts.permissionMode || 'normal',
    studyMode: opts.studyMode || false,
  };

  // Gateway state
  const gatewayState = { adapters: [], currentAdapter: null, currentModel: null };
  const gw = getGateway();
  if (gw) {
    try {
      const status = typeof gw.getStatus === 'function' ? gw.getStatus() : {};
      gatewayState.currentAdapter = status.adapter || null;
      gatewayState.currentModel = status.model || opts.model || null;
      if (typeof gw.listAdapters === 'function') {
        gatewayState.adapters = gw
          .listAdapters()
          .filter((a) => a.available)
          .map((a) => a.name || a.key);
      }
    } catch {
      /* gateway not initialized */
    }
  }
  if (!gatewayState.currentModel && opts.model) {
    gatewayState.currentModel = opts.model;
  }

  // Local LLM state
  const llmState = { status: 'unknown', backend: null, backends: [] };
  const llm = getLocalLLM();
  if (llm) {
    try {
      const st = typeof llm.getStatus === 'function' ? llm.getStatus() : {};
      llmState.backend = st.backend || null;
      llmState.status = st.loaded ? 'loaded' : st.available ? 'available' : 'unavailable';
      if (st.backend) {
        llmState.backends.push(st.backend);
      }
      // Carry the REAL cause out of getStatus so the human surface can state
      // 动作+目标+原因+修复 (RUNTIME-002 §2.2) instead of a hardcoded "install
      // Ollama" — which is only one of several reasons local inference can be
      // unavailable (no model, incompatible GGUF, loopback blocked, lastError…).
      llmState.discoveryReason = st.modelDiscoveryReason || null;
      llmState.importHint = st.modelImportHint || null;
      llmState.incompatible = !!st.modelIncompatible;
      llmState.loadDiagnosis = st.modelLoadDiagnosis || null;
      llmState.lastError = st.lastError || null;
    } catch {
      /* not loaded */
    }
  }

  // Tools. `enabledTools` = the CURRENT session's assembled pool, which only a caller inside
  // the session can supply. When it is absent (e.g. `khy self` from a cold CLI process) the
  // old code reported `enabled: 0`, and the human output printed "工具 (0 已启用)" — a
  // fabricated zero that reads as "khy has no tools". Report null (unknown) instead, plus the
  // registry count, which is a real checkable number.
  const _suppliedTools = Array.isArray(opts.enabledTools);
  const toolState = {
    enabled: _suppliedTools ? opts.enabledTools.length : null,
    list: _suppliedTools
      ? opts.enabledTools.map((t) => (typeof t === 'string' ? t : t.name || t.tool || ''))
      : [],
    registered: _deriveToolInfo().count,
    note: _suppliedTools
      ? null
      : '未传入本次会话已启用的工具清单：enabled 为 null（未知），registered 为注册表实际数量——不要把 enabled 的 null/0 说成「没有工具」',
  };

  // Skills
  const skillState = { count: 0, loaded: [] };
  try {
    const sm = getSkillsModule();
    const cmds = typeof sm.getSkillCommands === 'function' ? sm.getSkillCommands() : [];
    skillState.count = cmds.length;
    skillState.loaded = cmds.map((s) => s.name);
  } catch {
    /* skills not available */
  }

  // Commands
  const cmdState = { routerCount: 0, slashCount: 0 };
  try {
    const cs = getCommandSchema();
    if (typeof cs.getRouterCommandNames === 'function') {
      cmdState.routerCount = cs.getRouterCommandNames().length;
    }
    if (typeof cs.getBuiltinSlashCommands === 'function') {
      cmdState.slashCount = cs.getBuiltinSlashCommands().length;
    }
  } catch {
    /* schema not available */
  }

  // Self-location: where khy itself is installed + its own source dir. Derived from
  // the real dataHome resolvers so the agent knows the ABSOLUTE path to grep its own
  // code (GrepTool honors absolute paths outside cwd). selfSrcDir = services/backend/src.
  const install = _resolveInstall();

  // Installed apps (detected at runtime). BUG FIX: previously probed opts.cwd (the
  // USER's working dir) for backend/src/services/comprehensiveDataService.js — the
  // root was wrong so it almost never found khy's own files. Probe khy's OWN source
  // dir (install.selfSrcDir === services/backend/src) instead.
  const appsState = { installed: [] };
  try {
    const svcDir = install && install.selfSrcDir ? path.join(install.selfSrcDir, 'services') : null;
    if (svcDir && fs.existsSync(path.join(svcDir, 'comprehensiveDataService.js'))) {
      appsState.installed.push('khyquant');
    }
  } catch {
    /* detection failure is fine */
  }

  // Learning system (OS-level capability, knowledge content provided by apps)
  const learningState = {
    level: 'unknown',
    xp: 0,
    builtinCount: 0,
    learnedCount: 0,
    completionRate: 0,
  };
  const ks = getKnowledgeService();
  if (ks) {
    try {
      if (typeof ks.getLevelProgress === 'function') {
        const lp = ks.getLevelProgress();
        learningState.level = lp.levelName || lp.level || 'unknown';
        learningState.xp = lp.xp || 0;
        const total = Math.max(lp.totalTopics || 0, 1);
        learningState.completionRate = Math.round(((lp.completedTopics || 0) / total) * 100);
      }
      if (typeof ks.getKnowledgeStats === 'function') {
        const stats = ks.getKnowledgeStats();
        learningState.builtinCount = stats.builtinCount || 0;
        learningState.learnedCount = stats.learnedCount || 0;
      }
    } catch {
      /* knowledge service not ready */
    }
  }

  return {
    runtime,
    gateway: gatewayState,
    localLLM: llmState,
    tools: toolState,
    skills: skillState,
    commands: cmdState,
    apps: appsState,
    learning: learningState,
    install,
  };
}

/**
 * Resolve khy's own install location by feeding the real dataHome resolvers into the
 * selfLocation leaf. selfSrcDir is derived from this module's own __dirname
 * (services/backend/src). Fail-soft: returns a best-effort object even if resolvers throw.
 */
function _resolveInstall() {
  const sl = getSelfLocation();
  // services/backend/src — this file lives at services/backend/src/services/selfProfile.js
  const selfSrcDir = path.resolve(__dirname, '..');
  let appRoot = '';
  let dataHome = '';
  let projectDataHome = '';
  let baseHome = '';
  const dh = getDataHome();
  if (dh) {
    try {
      if (typeof dh.getAppRoot === 'function') {
        appRoot = dh.getAppRoot();
      }
    } catch {
      /* ignore */
    }
    try {
      if (typeof dh.getStorageReport === 'function') {
        const sr = dh.getStorageReport();
        const homes = (sr && sr.homes) || {};
        dataHome = homes.dataHome || '';
        projectDataHome = homes.projectDataHome || '';
        baseHome = homes.baseHome || '';
      }
    } catch {
      /* ignore */
    }
  }
  if (sl && typeof sl.resolveSelfLocation === 'function') {
    try {
      return sl.resolveSelfLocation({ appRoot, selfSrcDir, dataHome, projectDataHome, baseHome });
    } catch {
      /* fall through */
    }
  }
  return {
    appRoot,
    selfSrcDir,
    dataHome,
    projectDataHome,
    baseHome,
    installKind: 'dev',
    enabled: true,
  };
}

// Python version probe result cache. detectRuntimeCapabilities() runs per
// request, and each cold call pays a synchronous `python --version` subprocess
// (~100-300ms on Windows); the interpreter version cannot change mid-session.
let _pythonCache = { value: null, at: 0 };
const _PYTHON_TTL_MS = 300000;

function _detectPython() {
  const now = Date.now();
  if (_pythonCache.value !== null && now - _pythonCache.at < _PYTHON_TTL_MS) {
    return _pythonCache.value;
  }
  const value = _detectPythonUncached();
  _pythonCache = { value, at: Date.now() };
  return value;
}

function _detectPythonUncached() {
  try {
    const { execFileSync } = require('child_process');
    const { isWin, searchExecutable } = require('../tools/platformUtils');
    const candidates = isWin ? ['python', 'python3'] : ['python3', 'python'];
    for (const cmd of candidates) {
      if (!searchExecutable(cmd)) {
        continue;
      }
      try {
        const ver = execFileSync(cmd, ['--version'], {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
        return ver.replace(/^Python\s*/i, '');
      } catch {
        /* try next */
      }
    }
    return 'not found';
  } catch {
    return 'not found';
  }
}

// ─── Full profile (static + runtime merged) ──────────────────────────────────

function getFullProfile(opts = {}) {
  const staticProfile = buildStaticProfile();
  const runtimeCaps = detectRuntimeCapabilities(opts);
  return { ...staticProfile, runtime: runtimeCaps };
}

// ─── Output: System Prompt (token-efficient, 仅注入行为相关信息) ────────────────────

function formatForSystemPrompt(profile) {
  if (!profile) {
    profile = getFullProfile();
  }
  const rt = profile.runtime || {};
  const gw = rt.gateway || {};
  const llm = rt.localLLM || {};
  const id = profile.identity || {};

  // Minimal injection — only adapter/model info not already in getEnvironmentSection().
  // CC doesn't inject self-descriptions ("I am", "I cannot") — the model knows its
  // capabilities from tool definitions and system prompt sections.
  const lines = [
    `# Runtime (${id.name || 'khy OS'} v${id.version || '?'})`,
    `Adapter: ${gw.currentAdapter || 'auto'}, Model: ${gw.currentModel || 'auto'}`,
  ];

  // 模型身份不可伪装(A 层, goal 2026-07-04):在 Adapter/Model 行后注入反伪装指令,命令模型
  // 被问身份时如实报「真实供应渠道 + 真实模型」、绝不冒充其他 AI。真值取当前网关状态(装配时
  // 可能仍为 auto,指令仍成立——它命模型以运行时真实后端为准)。门控 KHY_MODEL_IDENTITY_TRUTH
  // 关 → formatIdentityDirective 返 '',不注入(字节回退)。fail-soft:绝不因此打断系统提示。
  try {
    const mit = require('./modelIdentityTruth');
    const directive =
      typeof mit.formatIdentityDirective === 'function'
        ? mit.formatIdentityDirective(
            { channel: gw.currentAdapter, model: gw.currentModel },
            { env: process.env }
          )
        : '';
    if (directive) {
      lines.push('');
      lines.push(directive);
    }
  } catch {
    /* identity directive is best-effort; never break the system prompt */
  }

  // 缓存命中率如实上报(A 层, goal 2026-07-04, 截图):模型常谎称「没有访问实时监控数据的工具」,
  // 但 khy 网关确有缓存遥测。注入指令告诉模型缓存命中率可观测、被问须据实答或指向缓存透明报告。
  // 门控 KHY_CACHE_METRICS_TRUTH 关 → formatMetricsDirective 返 '',不注入(字节回退)。fail-soft。
  try {
    const cmt = require('./cacheMetricsTruth');
    const mdir =
      typeof cmt.formatMetricsDirective === 'function'
        ? cmt.formatMetricsDirective({ env: process.env })
        : '';
    if (mdir) {
      lines.push('');
      lines.push(mdir);
    }
  } catch {
    /* cache-metrics directive is best-effort; never break the system prompt */
  }

  // 视觉能力路由透明(A 层, 自审 #6):主模型可能纯文本、视觉靠网关改选视觉模型或本地 OCR 兜底。
  // 注入指令告知模型「视觉是路由而非原生」、被问须据实答并回显实际模型。门控 KHY_VISION_ROUTING_TRUTH
  // 关 → formatVisionDirective 返 '',不注入(字节回退)。fail-soft:绝不因此打断系统提示。
  try {
    const vrt = require('./visionRoutingTruth');
    const vdir =
      typeof vrt.formatVisionDirective === 'function'
        ? vrt.formatVisionDirective({ env: process.env })
        : '';
    if (vdir) {
      lines.push('');
      lines.push(vdir);
    }
  } catch {
    /* vision directive is best-effort; never break the system prompt */
  }

  // 自我认知/自审知识(A 层, goal 2026-07-04「khy 对自己的情况做到自知」):把 khyos 自审报告
  // (#1..#7,此前只散落在代码注释里,模型读不到)变成机器可读 SSOT 并推入系统提示,让模型被问
  // 「khyos 最大的问题有哪些 / 你的局限」时据实快答、不凭空猜、不夸大。门控 KHY_SELF_AUDIT_AWARENESS
  // 关 → formatForSystemPrompt 返 '',不注入(字节回退)。fail-soft:绝不因此打断系统提示。
  // 另接 selfAuditVerifier 动态核验(门控 KHY_AUDIT_DYNAMIC_VERIFY):把证据锚点核验结果注入
  // 徽标(·已核验/·核验失败)——verifier 不可用或返 null 时行为与无核验时完全一致。
  try {
    const sar = require('./selfAuditRegistry');
    // Dynamic evidence verification is best-effort: null/unavailable → legacy output.
    let verification;
    try {
      const verifier = require('./selfAuditVerifier');
      const vres = typeof verifier.verifyAll === 'function' ? verifier.verifyAll() : null;
      if (vres && vres.results) {
        verification = vres.results;
      }
    } catch {
      /* verifier is best-effort; fall back to the static audit block */
    }
    const adir =
      typeof sar.formatForSystemPrompt === 'function'
        ? sar.formatForSystemPrompt({ env: process.env, verification })
        : '';
    if (adir) {
      lines.push('');
      lines.push(adir);
    }
  } catch {
    /* self-audit awareness is best-effort; never break the system prompt */
  }

  // 20 倍模式(twentyXMode, goal 2026-07-04「cc 有 20 倍模式,khy 没有需要补充」):开启时在系统
  // 提示注入当前满负荷状态,让模型被问「是否在 20x 模式」时如实回答。opt-in 默认关 → describe
  // 返 enabled:false,不注入(字节回退)。fail-soft:绝不因此打断系统提示。
  try {
    const { describeTwentyXState } = require('./twentyXMode');
    const tx = describeTwentyXState(process.env);
    if (tx && tx.enabled) {
      lines.push('');
      lines.push(`## 20 倍模式（当前：开）`);
      lines.push(
        `当前运行在满负荷档：effort=${tx.effort}（含扩展思考）· 工具循环迭代上限 ${tx.maxIterations} · 并行子代理扇出 ${tx.maxChildren}/${tx.maxTotalAgents}。被问到「是否开启 20x / 满负荷模式」时如实确认已开启；用 \`/20x off\` 可关闭回到常规档。`
      );
    }
  } catch {
    /* 20x directive is best-effort; never break the system prompt */
  }

  // Capability boundaries — single source of truth (profile.boundaries). Injected
  // so the agent has REAL self-knowledge of its limits and does not overclaim.
  // Token-efficient: one line per boundary, short label + detail.
  const boundaries = Array.isArray(profile.boundaries) ? profile.boundaries : [];
  if (boundaries.length > 0) {
    lines.push('');
    lines.push('## Capability boundaries (know these about yourself)');
    for (const b of boundaries) {
      if (!b || !b.short) {
        continue;
      }
      lines.push(`- ${b.short}${b.detail ? ` — ${b.detail}` : ''}`);
    }
    // Runtime honesty signals: surface CURRENT availability so the agent does not
    // claim it can do something the environment cannot do right now.
    const signals = [];
    if (llm.status === 'unavailable' || llm.status === 'degraded') {
      const why = llm.discoveryReason ? `（原因: ${llm.discoveryReason}）` : '';
      signals.push(`本地推理当前不可用${why}，无法保证离线模型可用`);
    }
    if (!gw.currentModel || gw.currentModel === 'auto') {
      signals.push('当前模型/通道为自动解析，具体后端以实际网关状态为准');
    }
    if (signals.length > 0) {
      lines.push(`- 实时可用性：${signals.join('；')}`);
    }
  }

  // Self-location + own-command overview — so the agent KNOWS where its own source
  // lives (can Grep/Read it by absolute path) and WHAT commands it can invoke (no
  // guessing). Gated by KHY_SELF_LOCATION (default on); off → both blocks empty
  // (byte-identical fallback to prior behavior). Fail-soft: never throws.
  try {
    const sl = getSelfLocation();
    if (sl) {
      const locBlock =
        typeof sl.formatLocationForSystemPrompt === 'function'
          ? sl.formatLocationForSystemPrompt((profile.runtime || {}).install)
          : '';
      if (locBlock) {
        lines.push('');
        lines.push(locBlock);
      }

      const cc = getCommandCatalog();
      if (
        cc &&
        typeof cc.buildCommandCatalog === 'function' &&
        typeof sl.formatCommandOverviewForSystemPrompt === 'function'
      ) {
        let catalog = null;
        try {
          catalog = cc.buildCommandCatalog();
        } catch {
          catalog = null;
        }
        const cmdBlock = catalog ? sl.formatCommandOverviewForSystemPrompt(catalog) : '';
        if (cmdBlock) {
          lines.push('');
          lines.push(cmdBlock);
        }
      }
    }
  } catch {
    /* self-location is best-effort; never break the system prompt */
  }

  // Skill protocol self-knowledge (goal 2026-07-11「工具使用和 skill 格式对 khy
  // 自身还需现场调查是不对的…自己的协议格式都是清楚的，直接使用」). khy's OWN
  // skill format is fixed and authoritative — the agent must USE it directly, not
  // field-investigate (现场调查) it at runtime. Without this the agent guessed
  // non-existent shapes (`*.skill.json`), got 0 hits, and fell back to text
  // parsing. Authoritative format single-sourced from skills/skillLoader.js (the
  // sole loader). Gated by KHY_SKILL_FORMAT_AWARENESS (default on); off → block
  // omitted (byte-identical fallback). Token-cheap: three short lines.
  const _skillAwareRaw = String(process.env.KHY_SKILL_FORMAT_AWARENESS || 'true')
    .trim()
    .toLowerCase();
  if (!['0', 'false', 'off', 'no'].includes(_skillAwareRaw)) {
    lines.push('');
    lines.push('## Skill format (khy-native — use directly, do not field-investigate)');
    lines.push(
      'A khy skill is a directory containing `SKILL.md` (fixed filename) with YAML frontmatter (`name`/`version`/`description`/`layer`/`lifecycle`/`tags`/`platforms`/`dependencies`) followed by a Markdown body (instructions for the AI). There is NO `*.skill.json` / `manifest.json` shape — to author a skill, write `SKILL.md` directly; do not search for or reverse-engineer the format.'
    );
    lines.push(
      'Discovery (nearest wins): project `./.khy/skills/` → user `~/.khy/skills/` → built-in `backend/src/skills/`. Placing `<name>/SKILL.md` under `~/.khy/skills/` loads it natively. Manage: `khy skill list`.'
    );
  }

  return lines.join('\n');
}

// ─── Capability grounding helpers (见 [DESIGN-ARCH-153] §7) ────────────────────

/**
 * 取能力域的证据锚点核验结果。verifier 不可解析 / 门控关 → null(调用方不显示徽标,
 * 而不是显示「全部通过」)。绝不抛。
 * @param {object} [env]
 * @returns {{checkedAt:string, results:object}|null}
 */
function _capabilityGrounding(env) {
  try {
    const v = getSelfCapabilityVerifier();
    if (!v || typeof v.verifyAll !== 'function') {
      return null;
    }
    const r = v.verifyAll({ env: env || process.env });
    return r && r.results ? r : null;
  } catch {
    return null;
  }
}

/**
 * 单个域的核验徽标。**没有核验结果时不显示任何徽标**(未知 ≠ 通过)。
 * @param {object|null} grounding
 * @param {string} key
 * @returns {string}
 */
function _anchorBadge(grounding, key) {
  if (!grounding || !grounding.results) {
    return '';
  }
  const r = grounding.results[key];
  if (!r || typeof r !== 'object') {
    return '';
  }
  return r.verified ? ' ·已核验' : ' ·核验失败';
}

/**
 * 核验总览行。核验不可用 → ''(不冒充「全部通过」)。
 * @param {object|null} grounding
 * @returns {string}
 */
function _groundingSummary(grounding) {
  if (!grounding || !grounding.results) {
    return '';
  }
  const entries = Object.entries(grounding.results);
  if (entries.length === 0) {
    return '';
  }
  const failed = entries.filter(([, r]) => !(r && r.verified)).map(([k]) => k);
  if (failed.length === 0) {
    return `> 证据核验：${entries.length}/${entries.length} 通过（模块文件存在 + 门控状态，核验于 ${grounding.checkedAt}）`;
  }
  return `> 证据核验：仅 ${entries.length - failed.length}/${entries.length} 通过；未通过：${failed.join('、')} —— 这些域的描述可能已过期，以现场代码为准`;
}

// ─── Output: Human-readable (khy self, 中文 Markdown) ────────────────────────

function formatForHuman(profile) {
  if (!profile) {
    profile = getFullProfile();
  }
  const rt = profile.runtime || {};
  const gw = rt.gateway || {};
  const llm = rt.localLLM || {};
  const tools = rt.tools || {};
  const skills = rt.skills || {};
  const apps = rt.apps || {};
  const env = rt.runtime || {};
  const id = profile.identity || {};
  const domains = profile.capabilityDomains || {};

  const statusIcon = (status) => {
    if (status === 'loaded' || status === 'available') {
      return '\u2713';
    }
    if (status === 'degraded') {
      return '~';
    }
    return '\u2717';
  };

  const sections = [];

  // Header
  sections.push(`# ${id.name} 自我画像 (v${id.version})`);
  sections.push('');
  sections.push(`我是 ${id.name}，${id.positioning}。`);
  sections.push(`上层应用 (如 khyquant) 运行在此平台之上 — 我是操作系统，不是应用。`);
  sections.push(`性格: ${id.personality}`);
  sections.push('');

  // Capabilities — iterate the domain SSOT generically. This block used to be a hardcoded
  // per-domain section list, which is exactly how the wasm/app/security prose drifted out of
  // sync with the declaration: adding or renaming a domain meant remembering to edit here too.
  // Only genuinely per-run state (current channel, loaded skills, learning progress) stays
  // keyed by domain; everything else is rendered from the domain object itself.
  const grounding = _capabilityGrounding(process.env);
  sections.push('## 我能做什么');
  sections.push('');

  const learning = rt.learning || {};
  const runtimeExtras = {
    ai_gateway: () => {
      const out = [];
      if (gw.currentAdapter) {
        out.push(`当前通道: ${gw.currentAdapter} / ${gw.currentModel || 'auto'}`);
      }
      if (gw.adapters && gw.adapters.length > 0) {
        out.push(`可用适配器: ${gw.adapters.join(', ')}`);
      }
      out.push('切换: `khy gateway config`');
      return out;
    },
    local_inference: () => {
      const out = [
        `${statusIcon(llm.status)} 状态: ${llm.status}${llm.backend ? ` (${llm.backend})` : ''}`,
      ];
      // When usable, the status line is enough. When not, state the REAL cause +
      // a concrete fix instead of a fixed "install Ollama" that may not apply.
      if (llm.status !== 'loaded' && llm.status !== 'available') {
        if (llm.incompatible && llm.loadDiagnosis) {
          out.push(`原因: 模型格式与内置引擎不兼容 — ${llm.loadDiagnosis}`);
        } else if (llm.lastError) {
          out.push(`原因: ${llm.lastError}`);
        } else if (llm.discoveryReason === 'not_found' || !llm.discoveryReason) {
          out.push('原因: 未发现可运行的本地模型');
        } else {
          out.push(`原因: 模型不可用 (${llm.discoveryReason})`);
        }
        out.push(llm.importHint || '安装 Ollama: https://ollama.com/download');
      }
      return out;
    },
    tools: () => [
      tools.enabled != null
        ? `本次会话已启用: ${tools.enabled}`
        : '本次未传入会话已启用清单：已启用数为未知（不等于 0）',
    ],
    skills: () => {
      const out = [];
      if (skills.loaded && skills.loaded.length > 0) {
        out.push(`已加载: ${skills.loaded.join(', ')}`);
      }
      out.push('管理: `khy skill list`');
      return out;
    },
    commands: () => ['查看: `khy --help` 或 `/help`'],
    learning: () => [
      `知识库: ${learning.builtinCount} 内置 + ${learning.learnedCount} 学习`,
      `等级: ${learning.level} (${learning.xp} XP, 完成率 ${learning.completionRate}%)`,
      '进入学习模式: `khy ai --study`',
    ],
    app_runtime: () => ['查看已安装应用: `khy app list`'],
  };

  for (const [key, d] of Object.entries(domains)) {
    if (!d || typeof d !== 'object') {
      continue;
    }
    const badge = _anchorBadge(grounding, key);
    sections.push(`### ${d.summary || d.label || key}${badge}`);
    if (d.description) {
      sections.push(`${d.description}`);
    }
    if (Array.isArray(d.providers) && d.providers.length > 0) {
      sections.push(`可用供应商: ${d.providers.join(', ')}`);
    }
    if (Array.isArray(d.backends) && d.backends.length > 0) {
      sections.push(`后端链: ${d.backends.map((b) => b.id).join(' → ')}`);
    }
    if (d.categories && typeof d.categories === 'object') {
      for (const [catKey, desc] of Object.entries(d.categories)) {
        sections.push(`- ${catKey}: ${desc}`);
      }
    }
    if (Array.isArray(d.modes) && d.modes.length > 0 && d.modes.join('、') !== d.description) {
      sections.push(`模式: ${d.modes.join(', ')}`);
    }
    if (Array.isArray(d.abis) && d.abis.length > 0) {
      sections.push(`ABI: ${d.abis.join(', ')}`);
    }
    // A parts-domain's `features` IS its description (both are the alive-parts list), so only
    // print it when it actually adds something the line above did not say.
    if (
      Array.isArray(d.features) &&
      d.features.length > 0 &&
      d.features.join('、') !== d.description
    ) {
      sections.push(`功能: ${d.features.join(', ')}`);
    }
    const extras = runtimeExtras[key];
    if (typeof extras === 'function') {
      for (const line of extras() || []) {
        sections.push(line);
      }
    }
    if (d.note) {
      sections.push(`注: ${d.note}`);
    }
    sections.push('');
  }

  const groundingLine = _groundingSummary(grounding);
  if (groundingLine) {
    sections.push(groundingLine);
    sections.push('');
  }

  // Boundaries
  sections.push('## 我的局限');
  sections.push('');
  (profile.boundaries || []).forEach((b, i) => {
    sections.push(`${i + 1}. **${b.short}** — ${b.detail}`);
  });
  sections.push('');

  // Runtime
  sections.push('## 当前状态');
  sections.push('');
  sections.push(`- 平台: ${env.platform}`);
  sections.push(`- Node: ${env.nodeVersion}`);
  sections.push(`- Python: ${env.pythonVersion}`);
  sections.push(`- 工作目录: ${env.cwd}`);
  sections.push(`- 权限模式: ${env.permissionMode}`);
  // 20 倍模式(twentyXMode):开启时如实告知模型当前处于满负荷档,让它据实回答「是否 20x」。
  // 关 → 不追加本行(系统提示逐字节回退)。绝不抛。
  try {
    const { describeTwentyXState } = require('./twentyXMode');
    const tx = describeTwentyXState(process.env);
    if (tx && tx.enabled) {
      sections.push(
        `- 20 倍模式: 开（满负荷）— effort=${tx.effort} · 工具迭代上限 ${tx.maxIterations} · 并行子代理 ${tx.maxChildren}/${tx.maxTotalAgents}；被问到时如实说明已开启`
      );
    }
  } catch {
    /* twentyXMode 不可用 → 不追加 */
  }
  const inst = rt.install || {};
  if (inst.selfSrcDir || inst.appRoot) {
    sections.push(`- 自身源码: ${inst.selfSrcDir || '?'}（可用 Grep/Read 直接搜索此绝对路径）`);
    sections.push(
      `- 安装根: ${inst.appRoot || '?'}${inst.installKind ? ` (${inst.installKind})` : ''}`
    );
    if (inst.dataHome) {
      sections.push(`- 数据主目录: ${inst.dataHome}`);
    }
  }
  sections.push(`- 已安装应用: ${(apps.installed || []).join(', ') || '无'}`);

  return sections.join('\n');
}

// ─── Output: API JSON ────────────────────────────────────────────────────────

function formatForAPI(profile) {
  if (!profile) {
    profile = getFullProfile();
  }
  return JSON.parse(JSON.stringify(profile));
}

// ─── Brief one-liner ─────────────────────────────────────────────────────────

function formatBrief(profile) {
  if (!profile) {
    profile = getFullProfile();
  }
  const id = profile.identity || {};
  const rt = profile.runtime || {};
  const gw = rt.gateway || {};
  const tools = rt.tools || {};
  const skills = rt.skills || {};
  const llm = rt.localLLM || {};
  const apps = rt.apps || {};

  // `enabled` is null when the caller could not supply the session's pool — print the
  // registry count instead of a zero that would read as "khy has no tools".
  const toolsLabel =
    tools.enabled != null
      ? String(tools.enabled)
      : `${tools.registered != null ? tools.registered : '?'} 注册`;

  return (
    `${id.name} v${id.version} | ` +
    `Gateway: ${gw.currentAdapter || 'auto'}/${gw.currentModel || 'auto'} | ` +
    `Tools: ${toolsLabel} | Skills: ${skills.count} | ` +
    `LLM: ${llm.status} | Apps: ${(apps.installed || []).join(', ') || 'none'}`
  );
}

// ─── Cache invalidation ──────────────────────────────────────────────────────

function invalidateStaticCache() {
  _staticCache = null;
}

/**
 * Lightweight install-location accessor: resolves ONLY khy's own paths (install
 * root / self source dir / data homes / installKind) WITHOUT the expensive runtime
 * detection (no python probe, no gateway/LLM status). Safe to call from a tool on
 * every invocation. Returns the same shape as runtime.install.
 */
function getInstallLocation() {
  return _resolveInstall();
}

// ─── Self-knowledge facets (自知分面 SSOT) ───────────────────────────────────
//
// 「khyself 工具过时了」的根因不是工具写错，而是自知有**两个互不覆盖的面**：
// `/self`（人类面，routerDispatchTail case 'self'）只给 capabilities/boundaries/runtime，
// KhySelf（agent 面）只给 commands/location/self_audit/self_audit_verify —— 并集 8 个分面、
// 交集只有 location。两个 action 枚举各自手维护，没有任何东西阻止它们继续分叉。
//
// 本表是分面的**单一真源**：两个面都从它派生（KhySelf 的 action enum、/self 的子命令表），
// parity 由 tests/tools/khySelfAlignment.test.js 锁死。见 [DESIGN-ARCH-153]。
//
// 契约：只读（全冻结）、绝不抛、fail-closed（未知分面 → null，不落到默认值）、
// 门控跟随被消费的 SSOT（commands 随 KHY_COMMAND_CATALOG、self_audit 随
// KHY_SELF_AUDIT_AWARENESS、self_audit_verify 随 KHY_AUDIT_DYNAMIC_VERIFY）。

const SELF_FACETS = Object.freeze([
  Object.freeze({
    key: 'identity',
    aliases: Object.freeze(['whoami', 'id']),
    summary: '名称/版本/定位/性格',
  }),
  Object.freeze({
    key: 'capabilities',
    aliases: Object.freeze(['capability', 'cap', 'features']),
    summary: '能力域（网关/推理/工具/技能/命令/多智能体/WASM/应用/学习/安全）',
  }),
  Object.freeze({
    key: 'boundaries',
    aliases: Object.freeze(['boundary', 'limits', 'limitations']),
    summary: '能力边界（含不支持的清单）',
  }),
  Object.freeze({
    key: 'runtime',
    aliases: Object.freeze(['env', 'environment', 'status']),
    summary: '平台/Node/Python/cwd/网关通道/本地推理/学习模式',
  }),
  Object.freeze({
    key: 'location',
    aliases: Object.freeze(['where', 'install', 'install_root', 'khy_where']),
    summary: '安装根/自身源码绝对目录/数据主目录/安装类型',
  }),
  Object.freeze({
    key: 'commands',
    aliases: Object.freeze(['command', 'cmd', 'catalog']),
    summary: '命令目录（可用 query 关键词过滤）',
  }),
  Object.freeze({
    key: 'self_audit',
    aliases: Object.freeze(['audit', 'audit_report', 'issues']),
    summary: '自审报告（已知问题 + 严重度 + 现状 + 缓解模块）',
  }),
  Object.freeze({
    key: 'self_audit_verify',
    aliases: Object.freeze(['audit_verify', 'verify', 'evidence']),
    summary: '自审证据逐项运行时核验',
  }),
]);

/**
 * 把任意输入解析为 canonical 分面 key。大小写 / 两端空白 / 连字符容忍，别名可解析。
 * **fail-closed**：未知输入 → null（绝不落到某个默认分面）。
 * @param {*} input
 * @returns {string|null}
 */
function resolveFacetKey(input) {
  if (typeof input !== 'string') {
    return null;
  }
  const norm = input.trim().toLowerCase().replace(/-/g, '_');
  if (!norm) {
    return null;
  }
  for (const f of SELF_FACETS) {
    if (f.key === norm) {
      return f.key;
    }
    if (f.aliases.includes(norm)) {
      return f.key;
    }
  }
  return null;
}

/** 命令目录按 query 过滤（大小写不敏感,跨 cmd/label/name/desc）。纯函数,绝不抛。 */
function _filterCommandCatalog(catalog, query) {
  const q = String(query == null ? '' : query)
    .trim()
    .toLowerCase();
  const cats = Array.isArray(catalog && catalog.categories) ? catalog.categories : [];
  const out = [];
  let matched = 0;
  for (const cat of cats) {
    if (!cat || typeof cat !== 'object') {
      continue;
    }
    const cmds = Array.isArray(cat.commands) ? cat.commands : [];
    const kept = q
      ? cmds.filter((c) => {
          const hay = `${c.cmd || ''} ${c.label || ''} ${c.name || ''} ${c.desc || ''}`.toLowerCase();
          return hay.includes(q);
        })
      : cmds;
    if (kept.length === 0) {
      continue;
    }
    matched += kept.length;
    out.push({
      key: cat.key,
      label: cat.label,
      commands: kept.map((c) => ({
        cmd: c.cmd,
        label: c.label || '',
        desc: c.desc || '',
        route: c.route || '',
      })),
    });
  }
  return { categories: out, matched };
}

/**
 * 取一个自知分面的**结构化数据**（两个自知面的共同后端）。
 *
 * 每个分面的数据都来自其既有 SSOT，本函数只做取用与整形，不发明事实：
 *   identity/capabilities/boundaries → buildStaticProfile()
 *   runtime                          → detectRuntimeCapabilities(opts)
 *   location                         → getInstallLocation()（= selfLocation 叶子）
 *   commands                         → commandCatalog 叶子（尊重 KHY_COMMAND_CATALOG）
 *   self_audit                       → selfAuditRegistry.summarize()
 *   self_audit_verify                → selfAuditVerifier.verifyAll()
 *
 * 绝不抛：SSOT 不可解析 / 门控关 → `{ok:false, facet, reason}`，**绝不伪造数据、绝不静默空白**
 * （对齐 RUNTIME-002 与仓内既有「诚实空信号」模式）。
 *
 * @param {string} key  分面 key 或别名
 * @param {object} [opts] {env, query, cwd, model, permissionMode, studyMode}
 * @returns {{ok:boolean, facet:string|null, data?:*, reason?:string}}
 */
function getSelfFacet(key, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const env = o.env || process.env;
  const facet = resolveFacetKey(key);
  if (!facet) {
    return {
      ok: false,
      facet: null,
      reason: `unknown facet: ${String(key)} (known: ${SELF_FACETS.map((f) => f.key).join(', ')})`,
    };
  }

  try {
    switch (facet) {
      case 'identity': {
        const id = buildStaticProfile().identity || {};
        return { ok: true, facet, data: JSON.parse(JSON.stringify(id)) };
      }
      case 'capabilities': {
        const doms = buildStaticProfile().capabilityDomains || {};
        const data = JSON.parse(JSON.stringify(doms));
        // 每个域挂上运行时核验徽标(§7.2 A 态)。核验不可用 → 不挂任何 anchorStatus,
        // 绝不把「没核验」渲染成「核验通过」。
        const grounding = _capabilityGrounding(env);
        const failed = [];
        let verified = 0;
        for (const [key, r] of Object.entries((grounding && grounding.results) || {})) {
          const ok = !!(r && r.verified);
          if (data[key] && typeof data[key] === 'object') {
            data[key].anchorStatus = ok ? 'verified' : 'failed';
            if (!ok) {
              data[key].anchorReason = (r && r.reason) || '';
            }
          }
          if (ok) {
            verified += 1;
          } else {
            failed.push(key);
          }
        }
        return {
          ok: true,
          facet,
          data,
          grounding: grounding
            ? {
                checkedAt: grounding.checkedAt,
                total: Object.keys(grounding.results).length,
                verified,
                failed,
                note: '证据锚点运行时核验（模块文件存在性 + 门控开关状态）。anchorStatus 缺席即「本次未核验」,不等于通过。',
              }
            : {
                available: false,
                reason:
                  '能力域核验不可用（KHY_SELF_CAPABILITY_EVIDENCE 门控关或 verifier 不可解析）——各域描述仍为声明 + 现场派生值',
              },
        };
      }
      case 'boundaries': {
        const b = buildStaticProfile().boundaries || [];
        return { ok: true, facet, data: JSON.parse(JSON.stringify(b)) };
      }
      case 'runtime': {
        return { ok: true, facet, data: detectRuntimeCapabilities(o) };
      }
      case 'location': {
        const loc = getInstallLocation() || {};
        // Canonical keys come from the selfLocation leaf (appRoot / selfSrcDir).
        // `installRoot` / `selfSourceDir` are the field names KhySelf has published
        // since it shipped, so they are carried as **aliases on the same object**
        // (same values, not a second source of truth) to keep that contract intact
        // while both faces read one shape.
        return {
          ok: true,
          facet,
          data: {
            ...loc,
            installRoot: loc.appRoot || '',
            selfSourceDir: loc.selfSrcDir || '',
          },
        };
      }
      case 'commands': {
        const cc = getCommandCatalog();
        if (!cc || typeof cc.buildCommandCatalog !== 'function') {
          return { ok: false, facet, reason: 'commandCatalog 不可解析（本上下文）' };
        }
        const catalog = cc.buildCommandCatalog({}, env);
        const { categories, matched } = _filterCommandCatalog(catalog, o.query);
        return {
          ok: true,
          facet,
          data: {
            total: catalog.total || 0,
            matched,
            query: o.query ? String(o.query) : null,
            categories,
            enabled: typeof cc.commandCatalogEnabled === 'function' ? cc.commandCatalogEnabled(env) : true,
            note: "khy 自身的斜杠/路由命令目录。完整可浏览索引:/features(TUI)或 GET /api/commands。",
          },
        };
      }
      case 'self_audit': {
        const sar = getSelfAuditRegistry();
        if (!sar || typeof sar.summarize !== 'function') {
          return { ok: false, facet, reason: 'selfAuditRegistry 不可解析（本上下文）' };
        }
        const audit = sar.summarize({ env });
        if (!audit || !audit.enabled) {
          return { ok: false, facet, reason: 'self-audit 门控关闭（KHY_SELF_AUDIT_AWARENESS=0）' };
        }
        const meta = audit.meta || {};
        return {
          ok: true,
          facet,
          data: {
            reportedTotal: meta.reportedTotal,
            trackedInCode: meta.trackedInCode,
            untracked: meta.untracked || [],
            note: meta.note,
            issues: audit.items || [],
          },
        };
      }
      case 'self_audit_verify': {
        const verifier = getSelfAuditVerifier();
        if (!verifier || typeof verifier.verifyAll !== 'function') {
          return { ok: false, facet, reason: 'selfAuditVerifier 不可解析（本上下文）' };
        }
        const verification = verifier.verifyAll({ env });
        if (!verification || !verification.results) {
          return {
            ok: false,
            facet,
            reason:
              'khy self-audit 核验不可用（KHY_AUDIT_DYNAMIC_VERIFY 门控关闭或 verifier 不可解析）',
          };
        }
        const loc = getInstallLocation();
        const selfSourceDir = (loc && loc.selfSrcDir) || '';
        return {
          ok: true,
          facet,
          data: {
            checkedAt: verification.checkedAt,
            items: Object.entries(verification.results).map(([id, r]) => ({
              id,
              verified: !!(r && r.verified),
              checks: (r && r.checks) || [],
              reason: (r && r.reason) || '',
            })),
            selfSourceDir,
            hint: selfSourceDir
              ? `Evidence above was checked live (module file existence + gate state). To inspect deeper yourself, pass this ABSOLUTE path to Read/Grep: ${selfSourceDir}`
              : 'Self source dir unresolved; evidence above was still checked live.',
          },
        };
      }
      default:
        return { ok: false, facet, reason: `facet '${facet}' 无取值实现` };
    }
  } catch (err) {
    // Fail-soft: 任一 SSOT 异常 → 诚实 ok:false,绝不抛、绝不伪造。
    return {
      ok: false,
      facet,
      reason: `取分面 '${facet}' 失败:${(err && err.message) || String(err)}`,
    };
  }
}

module.exports = {
  getFullProfile,
  getInstallLocation,
  formatForSystemPrompt,
  formatForHuman,
  formatForAPI,
  formatBrief,
  invalidateStaticCache,
  // 自知分面 SSOT（两个自知面的共同真源，见 [DESIGN-ARCH-153]）
  SELF_FACETS,
  resolveFacetKey,
  getSelfFacet,
};
