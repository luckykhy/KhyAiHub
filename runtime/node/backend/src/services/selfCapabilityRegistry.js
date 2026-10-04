'use strict';

/**
 * selfCapabilityRegistry.js — khyos「能力自知」的确定性单一真源(纯叶子:零 IO、确定性、绝不抛、可单测)。
 *
 * 为什么存在(见 docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-153] khy 自知面对齐规范.md §7):
 * `selfProfile` 的 `capabilityDomains` 此前是**写死的散文**,有三类真实缺陷——
 *   D-A 事实错误:声称有「Alpine ISO build」,而真实构建器是自写 C 内核 + Limine/GRUB 引导;
 *   D-B 发明分类:回退用的 `file_ops/git/task/web/code_exec/media/agent/lsp` 八个标签与真实
 *       分类税表(tools/_toolCategories 的 15 类)无一相同;
 *   D-D 整片缺席:已实现的能力域(mcp/memory/training/backup_restore/messaging/observability/
 *       desktop_automation/scheduling/a2a)在清单里**一个字都没有**。
 * 共同点与 §6 的路径漂移同源:该叙述**没有任何机器可读的映射到实现**,所以既无人能检、也无人会
 * 察觉它在漂。区别只是漂移物从「路径」变成了「断言」——而断言的漂移更隐蔽,因为没有可比对的对象。
 *
 * 本叶子给出的治法:能力域必须**双重落地**才能进清单——
 *   L 态(deriveFrom):现场从活 SSOT 取数(工具分类、本地推理后端、命令计数…),不写散文;
 *   A 态(evidenceAnchors):无法派生的部分写成断言,但**必须**带可运行时核验的证据锚点;
 *   P 态(纯散文):**禁止进入** capabilityDomains —— 这是本设计的唯一红线。
 *
 * 「依据项目实际情况」的落点:域内可分解的部分(Parts)按**模块存在性过滤**——某能力部件被删,
 * 它在清单里就消失,而不是继续被声称。所谓「依据实际情况」不是换一份更准的文案,是把文案的
 * 每一句都接到一条**能被现场推翻**的来源上。
 *
 * 覆盖契约(不允许沉默遗漏):`src/` 顶层目录必须要么被某个域的锚点伸到、要么在 `excluded`
 * 里**显式列出并给出理由**。守卫见 tests/tools/khySelfCapabilityGrounding.test.js。
 *
 * 契约:零 IO、确定性、绝不抛。env 门控 KHY_SELF_CAPABILITY_EVIDENCE(默认开,仅显式
 * 0/false/off/no 关)只管**证据核验**(A 态):关 → 不核验、不显示徽标。**域的声明与 L 态派生
 * 不受门控**(那部分是正确性本身,不设「关闭正确」的开关)。父门控经 flagRegistry 集中判定
 * (CANON 词表),fail-soft 回退本地 CANON。
 *
 * @module services/selfCapabilityRegistry
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 证据核验门控判定。优先走 flagRegistry(集中优先级 + dogfood),不可用时回退本地 CANON 词表。
 * 默认开,仅显式 0/false/off/no 关。与 selfCapabilityVerifier.isEnabled 读同一门控
 * (测试锁死两者一致,避免又出现「同一概念两份定义」—— RUNTIME-010 A2-5)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_SELF_CAPABILITY_EVIDENCE', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_SELF_CAPABILITY_EVIDENCE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 能力域 SSOT。字段语义(§7.2):
 *   key            稳定标识(消费方按 key 索引;不得重命名,改名等于对外接口变更)
 *   label          人类可读中文标题
 *   deriveFrom     L 态取数标记(null = 完全依赖 A 态断言);取值:'aiGateway' | 'localLLM' |
 *                  'tools' | 'skills' | 'commands' | 'parts'
 *   claim          不可派生的散文断言(A 态)。`deriveFrom==='parts'` 时为 null —— 描述由
 *                  存活部件的 label 拼出,不再手写第二份
 *   parts          可分解的能力部件 [{label, module}]。**按 module 存在性过滤**:部件被删即消失
 *   evidenceAnchors 证据锚点 {modules, gates}。modules 相对 services/(省略 .js,允许 '../x');
 *                  gates 仅在「该域的可信度取决于某门控开启」时声明(与自审缓解项同语义),
 *                  能力域通常只用 modules。核验实现见 selfEvidenceVerifier
 *   unsupported    该域已知不做的清单(诚实边界;可选)
 *
 * 不变量(测试逐条锁死):① 锚点非空(无可核验来源的断言不得进入);② deriveFrom 与 claim 至少
 * 有一个;③ parts[].module ⊆ evidenceAnchors.modules(部件与锚点不可分叉);④ key 唯一非空。
 *
 * @type {ReadonlyArray<object>}
 */
const CAPABILITY_DOMAINS = Object.freeze([
  Object.freeze({
    key: 'ai_gateway',
    label: 'AI 网关',
    deriveFrom: 'aiGateway',
    claim: '统一的多供应商 AI 调用通道(单一适配器接口,含故障转移与通道切换),khy 的一切模型调用都经此',
    evidenceAnchors: Object.freeze({ modules: Object.freeze(['gateway/aiGateway']), gates: Object.freeze([]) }),
  }),
  Object.freeze({
    key: 'local_inference',
    label: '本地推理',
    deriveFrom: 'localLLM',
    claim: '在本机跑模型、不依赖云端通道的自有推理链(L 态给出当前后端与回退顺序)',
    evidenceAnchors: Object.freeze({ modules: Object.freeze(['localLLMService']), gates: Object.freeze([]) }),
  }),
  Object.freeze({
    key: 'tools',
    label: '工具系统',
    deriveFrom: 'tools',
    claim: '工具注册表与分类税表(类别是单一真源,工具按类别聚合;L 态给出各类别实际工具数)',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['../tools/index', '../tools/_toolCategories']),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'skills',
    label: '技能包',
    deriveFrom: 'skills',
    claim: '可安装技能包(按域分组的内置技能 + 加载器 + 外部技能桥接)',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['skills/index', '../skills/index']),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'commands',
    label: '命令与别名',
    deriveFrom: 'commands',
    claim: 'CLI/斜杠命令目录与声明式别名表(命令目录与别名由机器声明,不手维护第二份枚举)',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze([
        'domain/catalog/commandCatalog/commandCatalog',
        '../cli/router',
        '../cli/aliases',
        '../commands/ccCommandBridge',
        '../constants/commandSchema',
      ]),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'multi_agent',
    label: '多智能体',
    deriveFrom: 'parts',
    claim: null,
    // 此前清单只列 3 种模式,而实际实现 ≥6 种。改为「按模块存在性列出存活部件」——模式清单
    // 从此不可能比实现多,也不可能比实现少(少了就说明模块真被删了,那正是要看见的事实)。
    parts: Object.freeze([
      Object.freeze({ label: 'worker(进程内子代理)', module: '../coordinator/workerAgent' }),
      Object.freeze({ label: 'process(fork 隔离子代理)', module: '../coordinator/processAgent' }),
      Object.freeze({ label: 'taskBoard(文件式任务队列)', module: '../coordinator/taskBoard' }),
      Object.freeze({ label: 'coordinator(纯编排器)', module: '../coordinator/coordinatorMode' }),
      Object.freeze({ label: 'team/mesh(对等协作)', module: '../tools/TeamCreateTool/index' }),
      Object.freeze({ label: 'remote_agent(A2A 远端委托)', module: 'a2a/index' }),
      Object.freeze({ label: '大任务编排', module: '../tasks/index' }),
      Object.freeze({ label: '子代理定义注册表', module: '../agents/index' }),
    ]),
    evidenceAnchors: Object.freeze({
      modules: Object.freeze([
        '../coordinator/workerAgent',
        '../coordinator/processAgent',
        '../coordinator/taskBoard',
        '../coordinator/coordinatorMode',
        '../coordinator/ipcProtocol',
        '../tools/TeamCreateTool/index',
        '../tools/MeshPeer',
        'a2a/index',
        '../tasks/index',
        '../agents/index',
      ]),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'wasm_runtime',
    label: 'WASM 运行时',
    claim: '在沙箱内加载并执行 WASM 应用(khy app 的隔离执行路径)',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['wasmAppService', 'wasm-sandbox/index']),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'os_operations',
    label: '系统操作',
    deriveFrom: 'parts',
    claim: null,
    // D-A 的修复点。原清单写「Alpine ISO build」——与真实构建器无关的事实错误。真实构建器是
    // khyos 自写的 C 内核 + Limine/GRUB 引导 + xorriso 打包,故此处按真实部件与真实模块列。
    parts: Object.freeze([
      Object.freeze({ label: 'ISO 构建(自写 C 内核 + Limine/GRUB 引导)', module: '../cli/handlers/khyos' }),
      Object.freeze({ label: '服务管理', module: '../cli/handlers/service' }),
      Object.freeze({ label: '依赖/包管理', module: '../cli/handlers/deps' }),
      Object.freeze({ label: '环境诊断(khy doctor)', module: '../cli/handlers/doctorCmdc' }),
      Object.freeze({ label: '服务注册与发现', module: 'serviceRegistry' }),
    ]),
    evidenceAnchors: Object.freeze({
      modules: Object.freeze([
        '../cli/handlers/khyos',
        '../cli/handlers/service',
        '../cli/handlers/deps',
        '../cli/handlers/doctorCmdc',
        'serviceRegistry',
      ]),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'app_runtime',
    label: '应用运行时',
    deriveFrom: 'parts',
    claim: null,
    parts: Object.freeze([
      Object.freeze({ label: '应用托管(khy app)', module: '../cli/handlers/app' }),
      Object.freeze({ label: '扩展市场', module: 'extensionMarketplace' }),
      Object.freeze({ label: '插件工具桥接', module: 'domain/extensions/plugins/pluginToolBridge' }),
      Object.freeze({ label: '插件加载器(SDK 兼容层)', module: '../plugin-loader/index' }),
    ]),
    evidenceAnchors: Object.freeze({
      modules: Object.freeze([
        '../cli/handlers/app',
        'extensionMarketplace',
        'domain/extensions/plugins/pluginToolBridge',
        '../plugin-loader/index',
      ]),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'learning',
    label: '学习与教学',
    claim: '从资料学习并把知识教给模型(含来源威胁扫描与技能沉淀)',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['knowledgeTeachingService']),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'security',
    label: '安全防护',
    deriveFrom: 'parts',
    claim: null,
    parts: Object.freeze([
      Object.freeze({ label: '工具权限门控', module: '../permissions/index' }),
      Object.freeze({ label: 'Shell 命令安全校验', module: '../permissions/bashSecurity' }),
      Object.freeze({ label: 'SSRF 防护', module: 'ssrfGuard' }),
      Object.freeze({ label: '审计日志', module: 'auditLog' }),
      Object.freeze({ label: '工具沙箱', module: 'toolSandbox' }),
    ]),
    evidenceAnchors: Object.freeze({
      modules: Object.freeze([
        '../permissions/index',
        '../permissions/bashSecurity',
        'ssrfGuard',
        'auditLog',
        'toolSandbox',
      ]),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'mcp',
    label: 'MCP 协议',
    claim: 'MCP 服务器接入(作为客户端连接外部 MCP 服务)与 MCP 生态适配',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['domain/messaging/mcp/index', '../tools/MCPTool/index']),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'memory',
    label: '记忆与日志',
    deriveFrom: 'parts',
    claim: null,
    parts: Object.freeze([
      Object.freeze({ label: '长期记忆目录(memdir)', module: '../memdir/index' }),
      Object.freeze({ label: '记忆写入工具', module: '../tools/SaveMemory' }),
      Object.freeze({ label: '每日日志与自动固化/主动回顾', module: '../assistant/index' }),
    ]),
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['../memdir/index', '../tools/SaveMemory', '../assistant/index']),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'training',
    label: '模型训练',
    claim: '微调/蒸馏/导出(LoRA 等训练流水线)',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['modelTrainingService', '../tools/FineTuningTool/index']),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'backup_restore',
    label: '备份与恢复',
    claim: '数据备份与灾难恢复(含恢复代理)',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['domain/backup/backup/backupService', 'restoreAgentService']),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'messaging',
    label: '消息与通道',
    deriveFrom: 'parts',
    claim: null,
    parts: Object.freeze([
      Object.freeze({ label: '桥接服务器', module: '../bridge/bridgeServer' }),
      Object.freeze({ label: '消息路由/通道', module: 'domain/messaging/channels/messageRouter' }),
      Object.freeze({ label: 'IM 适配器框架', module: '../adapters/im/adapterRegistry' }),
    ]),
    evidenceAnchors: Object.freeze({
      modules: Object.freeze([
        '../bridge/bridgeServer',
        'domain/messaging/channels/messageRouter',
        '../adapters/im/adapterRegistry',
      ]),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'observability',
    label: '可观测性',
    claim: '遥测/指标与运行观测',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['../observability/index', 'telemetryService']),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'desktop_automation',
    label: '桌面自动化',
    claim: '看屏幕/操作桌面(视觉兜底通道,经总闸与安全审批,是最后手段而非首选)',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['../tools/ComputerUseTool/index', 'domain/desktop/desktopControl/index']),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'scheduling',
    label: '定时任务',
    claim: '定时/周期任务调度与任务持久化',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['cronScheduler', '../jobs/cronScheduler', '../jobs/jobStore']),
      gates: Object.freeze([]),
    }),
  }),
  Object.freeze({
    key: 'a2a',
    label: 'A2A 远端委托',
    claim: 'Agent-to-Agent 协议:把任务委托给远端智能体(跨机器协作的协议面)',
    evidenceAnchors: Object.freeze({
      modules: Object.freeze(['a2a/index']),
      gates: Object.freeze([]),
    }),
  }),
]);

/**
 * 覆盖契约的显式缺口清单。`src/` 顶层每个目录必须**要么**被某域锚点伸到、**要么**在此登记
 * 并给出理由 —— 不允许沉默遗漏(§7.4)。kind 取值见 EXCLUSION_KINDS。
 *
 * 「不是能力域」的判据(写下来是为了让例外可被复核,而不是让例外成为后门):
 *   能力域 = khy 能**替用户做**的一整片事(可被请求的操作面,或产出用户可见成果的子系统)。
 *   界面外观层(输入模式/装饰性陪伴/布局适配)与基础设施层(配置/常量/HTTP 管线/DB schema/
 *   迁移/数据资产/协议 schema)不是能力域 —— 它们在此显式列出,而不是从清单里悄悄消失。
 *
 * @type {ReadonlyArray<{name:string, kind:string, reason:string}>}
 */
const EXCLUDED_DIRS = Object.freeze([
  Object.freeze({ name: '.khy', kind: 'runtime_data', reason: 'src 内的运行时数据落点(本机态,非能力)' }),
  Object.freeze({ name: 'blueprints', kind: 'data', reason: '项目蓝图/概念目录(纯 JSON 资产,无代码能力)' }),
  Object.freeze({ name: 'bootstrap', kind: 'infrastructure', reason: '启动装配层:把各能力接线起来,本身不提供能力' }),
  Object.freeze({ name: 'buddy', kind: 'ui_affordance', reason: '桌面伙伴的渲染/精灵层(装饰性陪伴,不是可被请求的能力)' }),
  Object.freeze({ name: 'classic', kind: 'interface_adapter', reason: '经典(非对话)UI 适配层' }),
  Object.freeze({ name: 'config', kind: 'infrastructure', reason: '配置装载' }),
  Object.freeze({ name: 'constants', kind: 'infrastructure', reason: '常量与声明表(含命令 schema)' }),
  Object.freeze({
    name: 'contracts',
    kind: 'data',
    reason: '协议契约(A2A/ACP/mobile 的 JSON Schema);锚点只解析 .js 模块,故 schema 数据不进锚点',
  }),
  Object.freeze({ name: 'controllers', kind: 'interface_adapter', reason: 'Web API 控制器层' }),
  Object.freeze({ name: 'data', kind: 'data', reason: '静态数据资产' }),
  Object.freeze({ name: 'i18n', kind: 'infrastructure', reason: '多语言资源' }),
  Object.freeze({ name: 'middleware', kind: 'infrastructure', reason: 'HTTP 中间件管线' }),
  Object.freeze({ name: 'migrations', kind: 'infrastructure', reason: '数据库迁移脚本' }),
  Object.freeze({ name: 'models', kind: 'infrastructure', reason: 'ORM 数据模型/schema 层' }),
  Object.freeze({ name: 'routes', kind: 'interface_adapter', reason: 'HTTP 路由层' }),
  Object.freeze({ name: 'seeds', kind: 'data', reason: '数据库种子数据' }),
  Object.freeze({
    name: 'services',
    kind: 'container',
    reason: '能力实现的主容器:20 个能力域的锚点已伸入其内部,故顶层目录本身不再单列',
  }),
  Object.freeze({ name: 'templates', kind: 'data', reason: '模板资产' }),
  Object.freeze({ name: 'utils', kind: 'infrastructure', reason: '通用工具函数' }),
  Object.freeze({ name: 'vim', kind: 'ui_affordance', reason: 'REPL 的 vim 键位输入模式(交互外观,不是可被请求的能力)' }),
]);

/** 排除理由的封闭枚举(防止 `reason` 退化成自由文本后无法分类复核)。 */
const EXCLUSION_KINDS = Object.freeze([
  'infrastructure', // 配置/常量/管线/schema/迁移/工具函数
  'interface_adapter', // HTTP 路由/控制器/UI 适配
  'data', // 静态资产/模板/种子/协议 schema
  'runtime_data', // 运行时数据落点
  'ui_affordance', // 交互外观(输入模式/装饰)
  'container', // 能力实现的容器目录
]);

/** 元信息:覆盖契约的作用域与已知缺口(沉默遗漏的反面是把缺口也说出来)。 */
const CAPABILITY_META = Object.freeze({
  scope: 'src/ 顶层目录',
  domainCount: CAPABILITY_DOMAINS.length,
  excludedCount: EXCLUDED_DIRS.length,
  exclusionKinds: EXCLUSION_KINDS,
  // 作用域边界如实声明:本契约只守 src/ 顶层。services/ 下 150 个平铺目录与
  // services/domain/ 的 31 个子域**不在**当前契约内(那层粒度太细,逐个分类会退化成
  // 一份新的手维护清单)。这里的取舍是:守一个能守住的层,并说明没守到哪 —— 而不是
  // 假装覆盖了全部。
  scopeLimit:
    '只守 src/ 顶层目录(新增顶层子系统必须表态)。services/* 与 services/domain/* 的细分目录不在契约内。',
  note:
    'L 态(deriveFrom)现场取数、A 态(evidenceAnchors)运行时核验;两者都不成立的纯散文(P 态)禁止进入能力域清单。',
});

/** 返回能力域的浅拷贝数组(对外只读;元素本身已冻结)。 */
function getCapabilityDomains() {
  return CAPABILITY_DOMAINS.slice();
}

/** 返回元信息。 */
function getCapabilityMeta() {
  return CAPABILITY_META;
}

/** 返回被显式排除的目录清单(覆盖契约的另一半)。 */
function getExcludedDirs() {
  return EXCLUDED_DIRS.slice();
}

/** 能力域 key 有序清单(消费方索引/一致性校验用)。 */
function domainKeys() {
  return CAPABILITY_DOMAINS.map((d) => d.key);
}

/** 按 key 取单个域;未知 → null(fail-closed,不落默认值)。 */
function getCapabilityDomain(key) {
  if (typeof key !== 'string' || !key.trim()) {
    return null;
  }
  const k = key.trim();
  for (const d of CAPABILITY_DOMAINS) {
    if (d.key === k) {
      return d;
    }
  }
  return null;
}

/**
 * 取数分层标签(展示/审计用,不是真值来源):
 *   'live'         仅 L 态(现场取数,描述由部件标签拼出)
 *   'live+claim'   L 态 + 不可派生的散文断言
 *   'anchored'     仅 A 态(散文断言 + 可核验锚点)
 * @param {object} d
 * @returns {string}
 */
function deriveKind(d) {
  const hasL = !!(d && d.deriveFrom);
  const hasA = !!(d && d.claim);
  if (hasL && hasA) {
    return 'live+claim';
  }
  return hasL ? 'live' : 'anchored';
}

/**
 * 人读/工具用摘要(KhySelf 的 capabilities action 消费)。返回结构化对象,绝不抛。
 * @param {object} [opts] {env}
 * @returns {{enabled:boolean, meta:object, domains:Array}}
 */
function summarize(opts = {}) {
  const o = opts || {};
  return {
    enabled: isEnabled(o.env),
    meta: CAPABILITY_META,
    domains: getCapabilityDomains(),
  };
}

module.exports = {
  isEnabled,
  CAPABILITY_DOMAINS,
  CAPABILITY_META,
  EXCLUDED_DIRS,
  EXCLUSION_KINDS,
  getCapabilityDomains,
  getCapabilityMeta,
  getExcludedDirs,
  domainKeys,
  getCapabilityDomain,
  deriveKind,
  summarize,
};