'use strict';

/**
 * modelChoiceGrouping — 「模型选择列表」的分组与信息分层**语义**（纯函数叶子，零 require、零 IO）。
 *
 * 为什么单独成一片叶子：同一个 `buildGatewayModelChoices()` 输出有**两个**消费表面 ——
 *   · TUI     `cli/tui/ink-components/ModelPicker.js`（ink，自己排版）
 *   · 经典REPL `cli/handlers/gatewayModelChoices.js`（inquirer 列表 / 数字兜底）
 * 两个表面必须共用**同一套**分组语义（组怎么算、什么时候不画标题、同名段怎么归并）与
 * **同一份**行内分层规则（哪段是主信息、哪段是次信息、孤儿段怎么回落）。
 * 各写一份就是第二真源（[MGMT-STD-008] §2.2），且两边会静默漂移。
 *
 * 放在 `cli/` 根下而不是 `cli/tui/` 下，是为了避免 `cli/handlers/**` 反向依赖 `cli/tui/**`
 * （分层倒置）。本叶子不 require 任何东西 ⇒ 谁都能引，也不会把 ink 拖进经典路径。
 *
 * 判据与实测见 `[DESIGN-ARCH-167]` §4.1 / §9 / §11。
 */

/**
 * 单模型组不画标题：行内标签已自证「它是谁家的」，标题是纯开销。
 * 这条同时给标题行数封顶——每个画标题的组至少 2 个模型 ⇒ 页内标题行 ≤ 页内模型行
 * （最坏 1:1）。没有这条，49 个单模型组能画出 49 行标题、0 个模型。
 */
const MIN_GROUP_FOR_SECTION = 2;
// 全表只有一组时不画标题：`── gateway · 12 个 ──` 这种标题不携带任何信息，
// 却吃掉一整行的条目额度（12 条模型被挤成 11 条、列表不再整页放下 ⇒ 滚动提示出现
// ⇒ 页脚在 60 列折成 2 行 ⇒ 帧高 +1）。实测见 [DESIGN-ARCH-167] §9-12。
const MIN_DISTINCT_GROUPS = 2;

/**
 * 分组键：**结构化字段优先，展示串永不参与**。
 *
 * P1 落地时 `choice.group` 由数据层给出（上游 provider 名）；P2 兜底回退
 * `value.adapter`（零改真源，但云端供应商会并成一组）。两条路共用这一处语义输入，
 * 不另立 `groupLabel` —— 否则就是第二份真源。
 * 禁止从 `name` 里解析 ` / ` 前缀当组名：展示文案一改就静默错组，且没有守卫会变红。
 */
function groupKeyOf(choice) {
  if (choice && choice.group) {
    return String(choice.group);
  }
  return choice && choice.value && choice.value.adapter ? String(choice.value.adapter) : '';
}

/**
 * 比较用的组键（大小写无关）。真数据实测到 `Anthropic` 与 `anthropic` 两家
 * 只差大小写却被当成两组，屏幕上出现两个近似名标题 —— 这本身就是「划分不清楚」
 * （[DESIGN-ARCH-167] §12-Q8，人裁决按 case-folded 合并）。
 * 显示仍用 `groupKeyOf` 的**首次出现原拼写**，不另立一份组名真源。
 */
function groupFoldOf(choice) {
  return groupKeyOf(choice).toLowerCase();
}

/**
 * 按组键做**稳定**归并：同组模型聚到一起，组间保持首次出现的相对顺序。
 *
 * 为什么不是按字母序排：字母序会把组本身重排，而模型列表的现有顺序可能是有意的
 * 优先级（免费档在前等）。首次出现序只做「聚拢」，不动任何既有先后
 * （[DESIGN-ARCH-167] §12-Q9）。组内按原顺序（sort 稳定 + 显式比 i）。
 *
 * 真数据场景：配置路（`opencode-zen:`）与密钥池路（`api:opencode-zen:`）产出同名
 * provider 却被别家隔开 ⇒ 不归并会画出两个「OpenCode Zen」标题。
 *
 * ⚠ 归并是**纯置换**（不丢、不重、组内保序）—— 消费方若拿它当「显示序」，
 * 必须把所有依赖模型下标的路径（光标/数字键/选中值）一起改绑到同一份数组。
 */
function stableGroupOrder(models) {
  const list = Array.isArray(models) ? models : [];
  const rank = new Map();
  const tagged = list.map((choice, i) => {
    const fold = groupFoldOf(choice);
    if (fold && !rank.has(fold)) {
      rank.set(fold, rank.size);
    }
    return { choice, i, r: fold ? rank.get(fold) : Number.MAX_SAFE_INTEGER };
  });
  return tagged
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((x) => x.choice);
}

/**
 * 模型条目 → 渲染条目（在组边界插入标题行）。
 *
 * 返回 `[{kind:'section', name, count, meta} | {kind:'model', mi, choice, orphan}, ...]`。
 * 段内不足 `MIN_GROUP_FOR_SECTION` 条时不画标题，该类模型条目带 `orphan: true`。
 * ⚠ 标题行**只进渲染维度**，绝不进显示序模型列表：光标、数字键、`choose`、
 * `initialCursor`、`（n/N）` 计数器全活在模型下标上（见 `ccMessageProjection.js:29`
 * 记着的 `row === index` 前提）。
 *
 * `count` 取**连续段长度**而非全局计数：标题写「N 个」，下面就必须真有 N 个。
 */
function buildEntries(models, query) {
  const list = Array.isArray(models) ? models : [];
  // 搜索态不画标题：分组是浏览辅助，不是搜索结果的性质，且搜索本身就把列表打散了。
  if (query) {
    return list.map((choice, mi) => ({ kind: 'model', mi, choice }));
  }
  const distinct = new Set();
  for (const c of list) {
    const k = groupFoldOf(c);
    if (k) {
      distinct.add(k);
    }
  }
  // 只有一组 ⇒ 无标题可画；组级信息（若有）全部回落到行内，保证它至少出现一次。
  if (distinct.size < MIN_DISTINCT_GROUPS) {
    return list.map((choice, mi) => ({ kind: 'model', mi, choice, orphan: true }));
  }
  const out = [];
  let i = 0;
  while (i < list.length) {
    // 段边界按**比较键**（fold）判、标题名取**首现原拼写**：真数据里
    // `Anthropic` / `anthropic` 只差大小写，按原串判会画出两个近似名标题
    // （[DESIGN-ARCH-167] §12-Q8）。组名仍然只有 `groupKeyOf` 一处语义输入。
    const fold = groupFoldOf(list[i]);
    const key = groupKeyOf(list[i]);
    let j = i + 1;
    while (j < list.length && groupFoldOf(list[j]) === fold) {
      j += 1;
    }
    const hasSection = !!fold && j - i >= MIN_GROUP_FOR_SECTION;
    if (hasSection) {
      const head = list[i];
      out.push({ kind: 'section', name: key, count: j - i, meta: (head && head.groupMeta) || '' });
    }
    // 没画标题的段（组内不足 MIN_GROUP_FOR_SECTION 条）没有标题行可挂组级信息，
    // 标记 `orphan` 让渲染侧把 groupMeta 回落到行内 —— 否则「某供应商只有 1 个模型」
    // 时状态/延迟/执行方三件套会整个消失，属静默丢失（[DESIGN-ARCH-167] R7）。
    for (; i < j; i += 1) {
      out.push({ kind: 'model', mi: i, choice: list[i], orphan: !hasSection });
    }
  }
  return out;
}

/**
 * 一个模型条目的**行内两段文本** —— 两个表面共用这一处定义，各表面只决定「怎么摆」：
 * TUI 左对齐 primary、右对齐 secondary（`padCell`）；经典 REPL 用两个空格拼成一行。
 *
 * `orphan` 段没有标题行可挂组级信息 ⇒ `groupMeta` 回落到次信息里，
 * 保证「段没画标题时组级信息至少出现一次」（不静默丢失）。
 *
 * 不在这里做任何宽度裁剪：裁剪是**各表面自己的账**（终端宽度不同、算法不同）。
 */
function layeredTextOf(entry) {
  const e = entry || {};
  const c = e.choice;
  if (!c) {
    return { primary: '', secondary: '' };
  }
  const primary = c.primary || c.name || (c.value && c.value.model) || `${(e.mi || 0) + 1}`;
  const orphanMeta = e.orphan && c.groupMeta ? c.groupMeta : '';
  const secondary = [c.secondary || '', orphanMeta].filter(Boolean).join(' ');
  return { primary, secondary };
}

module.exports = {
  MIN_GROUP_FOR_SECTION,
  MIN_DISTINCT_GROUPS,
  groupKeyOf,
  groupFoldOf,
  stableGroupOrder,
  buildEntries,
  layeredTextOf,
};
