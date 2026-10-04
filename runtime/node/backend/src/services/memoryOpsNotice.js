'use strict';

/**
 * memoryOpsNotice —— 纯叶子 (pure leaf):把「写记忆 / 召回记忆」这两个动作渲染成
 *   一行**面向用户**的确定性告知语的单一真源。
 *
 * 契约 (CONTRACT):零 IO(不碰 fs / 时钟 / 子进程 / 网络;所有事实由调用方读入后作参数
 *   传进来)、确定性(同入参恒定同输出)、绝不抛(任何畸形入参一律吞成空串 '')、单一真源
 *   (写/召回告知语的措辞与门控只在这里派生)、env 门控默认开(`KHY_MEMORY_NOTICE`,仅
 *   {0,false,off,no} 关闭;关闭即两个 format 均返 ''、上层不 onStatus =「字节回退」到
 *   静默行为)。fail-soft:success 非真、无有效 name、空召回一律返 '' 不打扰用户。
 *
 * 背景(闭合的断桥):Khy 有两条**静默**的记忆动作,违反「写记忆和回忆时明确告知用户」:
 *   1) 确定性 NL 捕获 `_maybeAutoSaveMemory`(cli/ai.js)写入记忆后,返回值在
 *      aiChatCore.js 被直接丢弃,用户永远不知道刚被写了一条记忆(死字段)。
 *   2) 主动/预热/相关三段召回把记忆折进系统提示,`filenames` 只用于 dedup(_memSurfaced),
 *      从不面向用户播报「回忆了什么」。
 *   本叶子把这两个动作各渲成一行 onStatus 告知,消费上面两个被丢弃/半死的信号。
 *
 * 诚实边界:
 *   - 写告知区分落地位置——`ephemeral`(短期会话记忆,session 结束即忘)标「本会话」,
 *     否则标「已落盘」;`action==='skip'|'skip-duplicate'` 标「已存在(未重复写入)」,
 *     绝不谎报「新写入」。
 *   - 召回告知只播报**具名可核**的召回文件(_memSurfaced 里的),数量截断到前 N 个 + 「等 M 条」,
 *     绝不为未具名的相关块编造文件名(under-claim 是诚实的)。
 *   - 「用以完成什么」意图子句由 `deriveIntentClause(ctx)` 从 `frontmatter.type` **确定性派生**
 *     (取首个命中型),是**类型标签的派生陈述**,不是对模型真实动机的断言。缺省 / 未知一律
 *     省略子句,绝不编造。ctx 缺省时整行与旧版**逐字节相等**(`[DESIGN-MEM-008]` V4 回退)。
 *   - `formatRecallNoticePayload` 把 `kind` 与 `text` 在同处派生,消费点按字段分流,
 *     **不得**用 `includes('🧠')` 之类文案前缀做判据(文案一改即静默失效)。
 *   - 召回分**两态**:① **过程态**(`formatRecallProcessPayload`,进行时、不含具体内容
 *     ——此刻还不知道会召回什么)② **结果态**(`formatRecallNoticePayload`,播报具名文件)。
 *     两态文案都在本叶单一真源,REPL / TUI / aiChatCore 共用同一句话,避免三处硬编码漂移。
 *     过程态 `stage:'starting'` 与 `stage:'done'` **必须成对发出**,否则前端 spinner 文案
 *     会永久停在过程态(同族教训:aiChatCore 的 `compacting` 必须配 `compacted`)。
 *   - 只告知,不改变任何记忆的写入/召回决策(纯装饰层)。
 */

/** 门控 falsy 词集(与仓内 sibling 门约定一致:大小写 / 首尾空白归一后比较)。 */
const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 召回告知里最多逐一点名的文件数;超出的以「等 N 条」概述。 */
const _RECALL_NAME_CAP = 3;

/**
 * 召回**过程态**文案(单一真源)。
 *
 * 与结果态的分工:过程态是**进行时**且**不含具体内容**——发出时还不知道会召回什么,
 * 所以它只能陈述「正在做这件事」,绝不预告文件名/条数(under-claim 是诚实的)。
 * 真实内容一律由完成后的 `formatRecallNotice` 播报。
 */
const RECALL_PROCESS_TEXT = '正在回忆相关记忆…';

/** 记忆类型 → 面向用户的中文标签(单一真源;未知类型回退通用「记忆」)。 */
const _TYPE_LABEL = Object.freeze({
  user: '身份',
  feedback: '反馈',
  project: '项目',
  reference: '参考',
});

/**
 * 记忆类型 → 「用以完成什么」意图子句(单一真源)。
 *
 * 诚实边界([DESIGN-MEM-008] §3.2):这是**类型标签的派生陈述**,不是对模型真实
 * 动机的断言。措辞一律用「为了…」而非「因为你需要…」——**不替用户/模型宣称动机**。
 * 缺省/未知类型一律省略子句,绝不编造。
 */
const _INTENT_CLAUSE = Object.freeze({
  project: '为了对齐项目约定',
  reference: '为了查证外部资料',
  feedback: '为了遵守你此前给过的协作偏好',
  user: '为了沿用你的既有设定',
});

/**
 * 门控:默认开。仅 env ∈ {0,false,off,no}(归一后)关闭。
 * @returns {boolean}
 */
function isNoticeEnabled() {
  const raw = process.env.KHY_MEMORY_NOTICE;
  if (raw == null) {
    return true;
  }
  return !_OFF.has(String(raw).trim().toLowerCase());
}

/** 从 .md 文件名派生一个精简可读的记忆名(去扩展名;绝不抛)。 */
function _prettyName(filename) {
  const s = String(filename == null ? '' : filename).trim();
  if (!s) {
    return '';
  }
  return s.replace(/\.md$/i, '');
}

/**
 * 渲染「写记忆」告知语。
 * @param {object} result - `_maybeAutoSaveMemory` 的返回:期望 {kind:'memory', success,
 *   name, type, tier, action, ephemeral}。非 memory 种类 / 非成功 / 无 name → ''。
 * @returns {string} 告知语,或 ''(门关 / 畸形 / 不该告知)。
 */
function formatWriteNotice(result) {
  try {
    if (!isNoticeEnabled()) {
      return '';
    }
    if (!result || typeof result !== 'object') {
      return '';
    }
    if (result.kind !== 'memory') {
      return '';
    } // 指令提案走别的评审队列,不在此告知
    if (result.success !== true) {
      return '';
    }
    const name = String(result.name == null ? '' : result.name).trim();
    if (!name) {
      return '';
    }

    const typeLabel = _TYPE_LABEL[result.type] || '记忆';
    const action = String(result.action == null ? '' : result.action);
    // 已存在 / 去重命中:诚实标注未新写入。
    if (action === 'skip' || action === 'skip-duplicate') {
      return `记忆已存在（未重复写入）：${typeLabel}·${name}`;
    }
    // supersede([DESIGN-MEM-008] §4 第 7 项,承接 [DESIGN-MEM-007] MR-R4①):
    // 同名记忆被**原地替换** —— 必须说清是「更新既有」而非「又写了一条」,否则用户
    // 会以为记忆库在堆叠副本。
    // ⚠ 措辞纪律:决策是**原地替换**(memoryTier.decideUpdate 的 supersede 不改文件名、
    //   不归档旧记录),故写「已被替换」;写成「已归档」是**不诚实**的(归档只发生在
    //   forget 路径)。
    // ⚠ 前置:memoryEngine.addStructuredMemory 必须把 decideUpdate 的 action 透传出来,
    //   否则这里永远拿不到 'supersede'(该透传已于 2026-09-27 补齐)。
    if (action === 'supersede') {
      return `已更新既有${typeLabel}记忆（原记录已被替换）：${name}`;
    }
    // 落地位置:短期会话记忆(session 结束即忘) vs 落盘。
    const where = result.ephemeral === true ? '本会话' : '已落盘';
    return `已写入${typeLabel}记忆（${where}）：${name}`;
  } catch {
    return '';
  }
}

/**
 * 从召回上下文派生「用以完成什么」意图子句(确定性,绝不抛)。
 *
 * @param {object} [ctx] - 期望 {types: string[]}(按召回顺序;取 `frontmatter.type`,
 *   **绝不按文件所在目录推断**——存储是扁平的,按目录推断会得到 unknown 或错型)。
 *   缺省 / 非对象 / types 非数组 / 全部未知 → 返 ''(省略子句,**不编造**)。
 * @returns {string} 子句(如 '为了遵守你此前给过的协作偏好'),或 ''。
 */
function deriveIntentClause(ctx) {
  try {
    if (!ctx || typeof ctx !== 'object') {
      return '';
    }
    const types = Array.isArray(ctx.types) ? ctx.types : [];
    // 取**首个命中型**的标签(按调用方给的召回顺序,不重排)。
    for (const t of types) {
      const key = String(t == null ? '' : t)
        .trim()
        .toLowerCase();
      const clause = _INTENT_CLAUSE[key];
      if (clause) {
        return clause;
      }
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 渲染「召回记忆」告知语。
 * @param {Array<string>|Set<string>|string} filenames - 本轮**具名**召回并注入提示的
 *   记忆文件名集合(即 aiChatCore 的 _memSurfaced)。空 / 非可迭代 → ''。
 *   ⚠ 字符串入参按**单个文件名**处理(§3.2.2 加固:否则会被逐字符拆开)。
 * @param {object} [ctx] - 可选,`{types: string[]}`;缺省 ⇒ 输出与旧版**逐字节相等**。
 * @returns {string} 告知语,或 ''(门关 / 畸形 / 无召回)。
 */
function formatRecallNotice(filenames, ctx) {
  try {
    if (!isNoticeEnabled()) {
      return '';
    }
    let list = [];
    if (Array.isArray(filenames)) {
      list = filenames;
    } else if (filenames instanceof Set) {
      list = Array.from(filenames);
    } else if (typeof filenames === 'string') {
      // 加固:字符串本身是可迭代的,不特判会被 Array.from 逐字符拆开
      // (实测 'bad' → '召回 3 条:b、a、d')。按单个文件名处理。
      list = [filenames];
    } else if (filenames && typeof filenames[Symbol.iterator] === 'function') {
      list = Array.from(filenames);
    } else {
      return '';
    }

    const names = [];
    for (const fn of list) {
      const p = _prettyName(fn);
      if (p) {
        names.push(p);
      }
    }
    if (names.length === 0) {
      return '';
    }

    const shown = names.slice(0, _RECALL_NAME_CAP);
    const rest = names.length - shown.length;
    const tail = rest > 0 ? ` 等 ${names.length} 条` : '';
    // 意图子句**只插入、不改动任何既有字符**:ctx 缺省时 clause 为 '' ⇒
    // 整行与旧版逐字节相等(V4 回退)。
    const intent = deriveIntentClause(ctx);
    const clause = intent ? `（${intent}）` : '';
    return `召回 ${names.length} 条相关记忆${clause}：${shown.join('、')}${tail}`;
  } catch {
    return '';
  }
}

/**
 * 渲染「召回记忆」告知**载荷**(带判别符,供消费点分流用)。
 *
 * 为什么要判别符:消费点若用 `text.includes('🧠')` 之类文案前缀做判据,文案一改
 * 即**静默失效**。这里把 kind 与 text 在同一处派生(「一条规则只应有 1 处语义输入」),
 * 消费点按字段判,与措辞解耦。
 *
 * @param {Array<string>|Set<string>|string} filenames
 * @param {object} [ctx]
 * @returns {{kind: string, text: string}|null} 门关 / 无召回 → null(调用方不 push、不 onStatus)。
 */
function formatRecallNoticePayload(filenames, ctx) {
  try {
    const text = formatRecallNotice(filenames, ctx);
    return text ? { kind: 'memory-notice', text } : null;
  } catch {
    return null;
  }
}

/**
 * 渲染「召回**过程态**」载荷(带 `phase` / `stage`,供消费点按字段分流)。
 *
 * 消费契约:
 *   - `stage:'starting'` ⇒ 前端把 **spinner 文案**切成过程态并**继续转**(不停 spinner、
 *     不落持久行)⇒ 用户看到「正在回忆…」的进行时;
 *   - `stage:'done'` ⇒ **终止符**,前端把 spinner 文案切回常规(缺它 → 文案永久留屏)。
 *
 * @param {'starting'|'done'} stage - 非 'done' 一律归一成 'starting'。
 * @returns {{phase: string, stage: string, message: string}|null} 门关 → null(调用方不 onStatus)。
 */
function formatRecallProcessPayload(stage) {
  try {
    if (!isNoticeEnabled()) {
      return null;
    }
    return {
      phase: 'memory-recall',
      stage: stage === 'done' ? 'done' : 'starting',
      message: RECALL_PROCESS_TEXT,
    };
  } catch {
    return null;
  }
}

module.exports = {
  isNoticeEnabled,
  formatWriteNotice,
  formatRecallNotice,
  formatRecallNoticePayload,
  formatRecallProcessPayload,
  deriveIntentClause,
  RECALL_PROCESS_TEXT,
  _TYPE_LABEL,
  _INTENT_CLAUSE,
  _RECALL_NAME_CAP,
};
