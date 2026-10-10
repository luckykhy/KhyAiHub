'use strict';

/**
 * permissionNotice — 授权请求「卡片里说什么 / 输出区说什么」的单一真源。
 *
 * 三块表面各司其职（用户 2026-09-23 的诉求：框太大、不美观；2026-09-24 复审：重排）：
 *
 *   · **权限框**（`cardRows` + PermissionsPrompt）—— 决定所需的最小充分集，且**列对齐**：
 *     标题（等级徽标 + 工具名右对齐）/ 动作·范围 / 资源 / 撤销 / 一句风险。行数只与字段
 *     个数有关，与资源长短无关 ⇒ 框高可记账（`PermissionsPrompt.frameRowCount`）。
 *   · **输出区**（`buildRecord`）—— 证据全文：资源不裁、为什么 / 后果 / 撤销 / 工作区照登。
 *     请求到达时一次成形，决定之后仍在，是「当时看到了什么、批了什么」的凭据。
 *   · **询问框**（QuestionPrompt）—— 不在这里；但两块卡片共用 `cardLayout` 的同一套
 *     排版语法（贴合内容宽 / 列对齐 / 一行一格），所以同屏出现时像一家人。
 *
 * 两处共用 `cardRows` ⇒ 框里显示的永远是记录里的**子集**，不会「框说 A、记录说 B」。
 *
 * 门控 `KHY_PERMISSION_NOTICE`（默认开）：关 → 调用方回到「证据全在框内 + 不推记录」的
 * 旧形态（可逆，与仓内其余门控同一约定）。
 *
 * 纯叶子：无 IO、确定性、不抛。
 */

const cardLayout = require('./cardLayout');
const { fieldRows } = require('./permissionFieldRows');

/** 与 cardLayout 同源（round 边框 2 + 左右 padding 2）。 */
const BOX_CHROME_COLS = cardLayout.BOX_CHROME_COLS;
/** cols 不可用时的排版兜底宽度（与 transcriptLines.DEFAULT_COLS 同值）。 */
const DEFAULT_COLS = 80;
/** 记录正文缩进；字段行的续行也落在这里。 */
const RECORD_INDENT = '    ';
/** 字段标签列：两个汉字 + 两空格 ⇒ `动作`/`资源`/`撤销`/`说明`/`命令` 的值都从同一列起。 */
const LABEL_PAD = '  ';

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控：默认开。仅 '0' / 'false' / 'off' / 'no' 关（空值 = 未设置 = 开）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function noticeEnabled(env) {
  const e = env || process.env || {};
  const v = String(e.KHY_PERMISSION_NOTICE == null ? '' : e.KHY_PERMISSION_NOTICE)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.has(v);
}

const PLACEHOLDER = new Set(['', '?', 'unknown', 'na', 'n/a', 'none', 'null', 'undefined', '-']);

/**
 * 上游未提供动作/范围时会送 'unknown'/'na' 之类的内部占位值，原样渲染等于把内部词
 * 暴露给用户（规则 2.2）。非空且非占位才算「说得出」。
 * @param {unknown} v
 * @returns {string}
 */
function meaningful(v) {
  const s = String(v == null ? '' : v).trim();
  return s && !PLACEHOLDER.has(s.toLowerCase()) ? s : '';
}

/** @returns {'L1'|'L2'|''} */
function levelOf(input) {
  const lvl = String((input && input.level) || '').toUpperCase();
  return lvl === 'L1' || lvl === 'L2' ? lvl : '';
}

/**
 * 等级**徽标**（短）—— 卡片标题用：`红灯 L2` / `黄灯 L1`。
 * 危险语义（毁灭性/系统级这类「为什么是红灯」）不进徽标：它属于证据，落在输出区记录里，
 * 卡片上用一句更具体的风险行（`⚠ 删除或覆盖数据 · 数据可能无法找回`）承载。
 */
function levelBadge(level) {
  const lvl = String(level || '').toUpperCase();
  if (lvl === 'L2') return '红灯 L2';
  if (lvl === 'L1') return '黄灯 L1';
  return '';
}

/**
 * 等级标签（**长**，含危险语义）—— 只给门控关的旧形态用，逐字节保持改前文案。
 * @returns {string} 非网关请求 → ''
 */
function riskTag(level) {
  const lvl = String(level || '').toUpperCase();
  if (lvl === 'L2') return '红灯 L2 · 毁灭性/系统级';
  if (lvl === 'L1') return '黄灯 L1 · 有限写入/网络';
  return '';
}

function explanationOf(input) {
  const ex = input && input.explanation;
  return ex && typeof ex === 'object' ? ex : null;
}

function commandOf(input) {
  const i = input || {};
  return String(i.command || i.cmd || i.script || '');
}

/**
 * 风险句 —— 从 explainer 的结构化字段里取，**不解析文本**：
 *   L2: `⚠ <whatHappens> · <risks[0]>`（有后果时带第一条）
 *   L1/其它: `⚠ <headline 去掉层级前缀>`
 * explainer 缺字段时返回 ''（卡片少一行，不编话）。
 */
function riskText(input) {
  const ex = explanationOf(input);
  if (!ex) return '';
  const risk = Array.isArray(ex.risks) && ex.risks.length ? String(ex.risks[0]).trim() : '';
  const happens =
    String(ex.whatHappens || '').trim() ||
    String(ex.headline || '')
      .replace(/^⚠\s*/, '')
      .replace(/^(高风险操作：|即将：)/, '')
      .trim();
  if (!happens) return '';
  return risk ? `⚠ ${happens} · ${risk}` : `⚠ ${happens}`;
}

/** 该请求是否有 diff 预览（框内保留，属「改了什么」）。 */
function hasRow(rows, key) {
  return rows.some((r) => r && r.key === key);
}

/**
 * 「记住范围」—— 这张卡最容易出「惊讶」的地方：用户点「总是允许」到底记住了什么。
 *
 * 结构取自两个上游的同一条设计（openCode 的 always 阶段单独列出将被记住的 patterns；
 * ZCode 在面板里逐行给 `Command prefix:` / `Exact command only:`）。本仓的真源是
 * `toolCallingPermissions.permissionKey = descriptor?.resolvedName || toolName` ——
 * 即**按工具名**记住，不区分本次参数。所以这里如实说明它，绝不含糊（规则 2.2）。
 *
 * ⚠ 只在**该选项真的会渲染**时才给这行：`KHY_L2_SESSION_ALLOW` 关掉时 L2 卡里没有
 * 「本会话内总是允许」这一项，说了就是描述一个不存在的按钮。
 *
 * 措辞刻意短（约 45 列）：这一行若长过页脚，就会把卡从 77 列撑到满宽 —— 结构价值换来
 * 「框又变宽」是亏的。
 *
 * @param {object} input
 * @param {string} [toolName]
 * @param {{sessionAllow?:boolean}} [opts]
 * @returns {string} 无可说内容 → ''
 */
function rememberText(input, toolName, opts) {
  const i = input || {};
  if (!levelOf(i)) return '';
  if (opts && opts.sessionAllow === false) return '';
  const tool = String(toolName == null ? '' : toolName).trim() || '该工具';
  return `只按工具名 ${tool}，不区分本次参数`;
}

/**
 * 写入前 diff 预览 → 记录用**纯文本**行（不裁）。
 *
 * 复用 `ToolLines.buildWriteDiffRows` 这唯一一份 diff 算法（不重写第二份），只把它的
 * 结构化行降成文本：卡内预览有红/绿，记录是日志、只要看得全。取不预览也算通过——
 * 用户批准的就是这一版改动。
 *
 * @param {object} dp `{beforeContent, afterContent, filePath}`
 * @returns {string[]}
 */
function diffRecordLines(dp) {
  if (!dp || typeof dp !== 'object') return [];
  try {
    const TL = require('./ink-components/ToolLines');
    const rows = TL.buildWriteDiffRows(dp, true);
    if (!rows || !rows.length) return [];
    const out = [`± ${dp.filePath ? String(dp.filePath) : '（文件改动）'}`];
    for (const r of rows) {
      const text = r && r.text != null ? String(r.text) : '';
      if (r && r.kind === 'add') out.push(`+ ${text}`);
      else if (r && r.kind === 'del') out.push(`- ${text}`);
      else if (r && r.kind === 'ctx') out.push(`  ${text}`);
      else if (text) out.push(`  ${text}`);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 框内信息行 —— 决定所需的最小充分集，**列对齐**（标签列定宽，值从同一列起）。
 *
 * 返回结构化 `{key,label,value,kind}` 而不是拼好的字符串：卡片要按尾注对齐裁成一行，
 * 记录要折行并悬挂缩进 —— 同一份数据两种排版（都由 cardLayout 收口）。
 *
 * @param {object} input 控制请求的 input（level/action/scope/resource/explanation）
 * @param {string} [toolName]
 * @param {{sessionAllow?:boolean}} [opts] 「总是允许」类选项是否会在卡里出现（决定要不要给「记住」行）
 * @returns {Array<{key:string,kind:string,label:string,value:string,pointer?:boolean}>}
 */
function cardRows(input, toolName, opts) {
  const i = input || {};
  const rows = [];
  const level = levelOf(i);

  if (level) {
    const actionText = meaningful(i.action);
    const scopeText = meaningful(i.scope);
    rows.push({
      key: 'as',
      kind: 'field',
      label: '动作',
      value:
        actionText || scopeText
          ? `${actionText || '未声明'} · ${scopeText ? `范围 ${scopeText}` : '范围 未声明'}`
          : '未声明（该工具未提供动作与范围说明）',
    });
    const resource = meaningful(i.resource) || String(i.resource == null ? '' : i.resource).trim();
    const cmd = commandOf(i);
    if (resource) {
      rows.push({ key: 'res', kind: 'field', label: '资源', value: resource, pointer: true });
    } else if (cmd) {
      rows.push({ key: 'res', kind: 'field', label: '命令', value: cmd, pointer: true });
    }
    const ex = explanationOf(i);
    const undo = ex && typeof ex.howToUndo === 'string' ? ex.howToUndo.trim() : '';
    // 撤销是 L2 决策的必答项（「我能不能撤」）——有就说，没有就不编。
    if (undo) {
      rows.push({ key: 'undo', kind: 'field', label: '撤销', value: undo, inDetail: undo });
    }
    const scopeLine = rememberText(i, toolName, opts);
    if (scopeLine) {
      rows.push({ key: 'remember', kind: 'scope', label: '记住', value: scopeLine });
    }
    const risk = riskText(i);
    if (risk) {
      // inDetail = 解释正文里承载同一件事的那句（`⚠ 高风险操作：删除或覆盖数据`）——
      // 记录靠它去重，不再写第二遍（比较值本身，不看键名，避免键名漂移漏判）。
      const happens =
        (ex && String(ex.whatHappens || '').trim()) ||
        (ex &&
          String(ex.headline || '')
            .replace(/^⚠\s*/, '')
            .replace(/^(高风险操作：|即将：)/, '')
            .trim()) ||
        '';
      rows.push({ key: 'risk', kind: 'risk', label: '', value: risk, inDetail: happens });
    }
    return rows;
  }

  // 非网关（classic）工具：没有分级/动作契约，能说的就是它自己的描述与命令。
  const desc = String(i.description || '').trim();
  if (desc) rows.push({ key: 'desc', kind: 'field', label: '说明', value: desc });
  const cmd = commandOf(i);
  if (cmd) rows.push({ key: 'cmd', kind: 'field', label: '命令', value: cmd, pointer: true });
  return rows;
}

/** 卡片标题（不含等级徽标；等级由 badgeOf 拼在标题后）。 */
function cardTitle(input) {
  return levelOf(input) === 'L2' ? '◉ 高危操作需要授权' : '⚠ 需要授权';
}

/** 标题尾注：等级徽标 + 工具名，两者都贴右（工具名一定是最后一段）。 */
function cardTitleTail(input, toolName) {
  const tool = String(toolName == null ? '' : toolName).trim();
  const badge = levelBadge(input && input.level);
  return [badge, tool].filter(Boolean).join(' · ');
}

/** 记录首行（与卡片标题同源，别在两处各写一套词）。 */
function recordHead(input, toolName) {
  const tool = String(toolName == null ? '' : toolName).trim() || '工具';
  const badge = levelBadge(input && input.level);
  return `${levelOf(input) === 'L2' ? '◉' : '⚠'} 需要授权 · ${tool}${badge ? ` · ${badge}` : ''}`;
}

/** 一行 `标签 + 值`（标签列定宽）。 */
function fieldLine(row) {
  return `${row.label}${LABEL_PAD}${row.value}`;
}

function contentColsOf(cols) {
  const n = Math.floor(Number(cols));
  const total = Number.isFinite(n) && n > 0 ? n : DEFAULT_COLS;
  return Math.max(0, total - BOX_CHROME_COLS);
}

/**
 * 输出区记录 —— 授权请求的证据全文，一次成形。
 *
 * 与卡片同一套标签列；**与解释正文重复的行不写两遍**（`撤销` 已被 `撤销方式：…` 覆盖、
 * 风险句与 `⚠ 高风险操作：…` 是同一句话）—— 记录不是把卡片再抄一遍，而是它的补集。
 * 解释正文里的空行也去掉：框内排版需要留白，日志里是噪音。
 *
 * @param {object} input
 * @param {string} [toolName]
 * @param {number} [cols]
 * @returns {string} 多行文本；至少含标题行
 */
function buildRecord(input, toolName, cols) {
  const width = Math.max(cardLayout.MIN_CONTENT_COLS, contentColsOf(cols));
  const out = [recordHead(input, toolName)];

  const ex = explanationOf(input);
  const detail = ex && typeof ex.text === 'string' ? ex.text.replace(/\s+$/, '') : '';

  const push = (label, value) => {
    const rows = fieldRows({ label, value, width });
    if (!rows) {
      for (const ln of String(value == null ? '' : value).split('\n')) out.push(label + ln);
      return;
    }
    for (const r of rows) out.push(r);
  };

  for (const row of cardRows(input, toolName)) {
    // 解释正文里已有同一句话 → 记录不写第二遍（比较值本身，不看键名，避免键名漂移漏判）。
    const key = row.inDetail ? row.inDetail : row.value;
    if (detail && key && detail.includes(key)) continue;
    push(RECORD_INDENT + row.label + (row.label ? LABEL_PAD : ''), row.value);
  }

  if (detail) {
    for (const ln of detail.split('\n')) {
      if (!ln.trim()) continue;
      push(RECORD_INDENT, ln);
    }
  }

  // 写入前 diff 预览的**全文**（卡内只放封顶预览）——批准的就是这一版改动，记录得留全。
  for (const ln of diffRecordLines(input ? input.diffPreview : null)) {
    push(RECORD_INDENT, ln);
  }
  return out.join('\n');
}

/**
 * 授权决定的判词 —— 与请求记录同属「授权的输出区足迹」。
 *
 * 输出区有两套渲染：committed 的 `Transcript.MessageBlock` 与应用内 Viewport 的
 * `transcriptLines`（改前它对 decision 记录什么都不画，与 buildDecisionRecord 自己
 * 「让决定在浮层消失后仍可见」的注释正好相反）。判词收在这里，两处共用。
 *
 * @param {string} decision 'allow' | 'deny' | 'always' | 'discuss'
 * @returns {{mark:string,label:string,color:string,denied:boolean,discuss:boolean}}
 */
function decisionVerdict(decision) {
  const d = String(decision == null ? '' : decision).toLowerCase();
  if (d === 'discuss') {
    return { mark: '✻ ', label: '先一起讨论', color: 'cyan', denied: false, discuss: true };
  }
  if (d === 'deny') {
    return { mark: '✗ ', label: '已拒绝', color: 'yellow', denied: true, discuss: false };
  }
  if (d === 'always') {
    return { mark: '✓ ', label: '已批准（始终允许）', color: 'green', denied: false, discuss: false };
  }
  if (d === 'allow') {
    return { mark: '✓ ', label: '已批准', color: 'green', denied: false, discuss: false };
  }
  // 未知值（正常路径不该出现）：如实回显，绝不假装「已批准」。
  return { mark: '• ', label: `决定 ${d || '未记录'}`, color: 'yellow', denied: false, discuss: false };
}

module.exports = {
  noticeEnabled,
  meaningful,
  levelOf,
  levelBadge,
  riskTag,
  riskText,
  rememberText,
  diffRecordLines,
  cardTitle,
  cardTitleTail,
  cardRows,
  fieldLine,
  buildRecord,
  recordHead,
  decisionVerdict,
  contentColsOf,
  hasRow,
  BOX_CHROME_COLS,
  DEFAULT_COLS,
  RECORD_INDENT,
  LABEL_PAD,
};
