/**
 * jsonExtract.js — 纯叶子：从一段文本里抽出**第一段平衡的 JSON 值**。
 * --------------------------------------------------------------------------
 * 真源：`[DESIGN-ARCH-141]` §5-D1「运行时自演化」—— `graphPatch.onVar`
 * 允许补丁来自运行期变量，而变量最常见的形态是**模型/工具产出的一段文本**。
 *
 * ## 为什么需要容错
 *
 * 现实里的模型回复不会恰好是裸 JSON：常见形态是
 *
 *   - 整段被 ```json 围栏包住：  ```json\n[{"op":"addNode",…}]\n```
 *   - JSON 前后带解释文字：      「好的，补丁如下：\n[{"op":"addNode",…}]\n以上。」
 *
 * 所以这里先剥围栏、再尝试整体解析、最后扫出第一段平衡的 JSON 值。
 *
 * ## 与 ai-backend 同名函数的孪生关系（**已登记的重复**）
 *
 * `services/ai-backend/src/services/workflowGenerateService.js` 里有一个同名
 * `extractFirstJson`（供 AI 生成工作流时解析模型回复）。两者是**有意的孪生件**：
 *
 *   - 本文件是它的**超集**：原版只把 `{` 当作起始定界符（`s.indexOf('{')`），
 *     因此 `'前文 [{"op":"x"}] 后文'` 会被它解析成**内层对象**而不是外层数组。
 *     `graphPatch.onVar` 的补丁本体是**数组**，故这里同时接受 `{` 与 `[`。
 *   - 之所以不共用一份：`@khy/shared` 在本仓有**两棵被 git 跟踪的副本**
 *     （`runtime/substrate/platform/packages/shared/` 与 `services/backend/vendor/shared/`，实测
 *     已存在漂移且**无同步守卫**），且 `services/backend/node_modules/@khy/shared`
 *     是指向 vendor 的软链 —— 往 shared 加子路径要同时改两棵树 + 两个 `exports`
 *     映射，风险与收益不成比例。
 *   - 两者都改过之后应**上提到 `@khy/shared`** 收敛为一份；届时删除本段说明。
 *
 * ## 契约
 *
 * 零 IO、确定性、**绝不抛**（解析不出来一律返回 `null`），可离线单测。
 *
 * @pattern Pure Function / Twin (see header)
 */
'use strict';

/**
 * 抽出文本里第一段平衡的 JSON 值。
 *
 * @param {*} text  任意输入；非字符串一律返回 `null`
 * @returns {*} 解析出的值（对象 / 数组 / 标量），或 `null`（解析不出来）
 */
function extractFirstJson(text) {
  if (typeof text !== 'string') {
    return null;
  }
  let s = text.trim();
  if (!s) {
    return null;
  }

  // 整段被 ```json / ``` 围栏包住时先剥掉。
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) {
    s = fence[1].trim();
  }

  // 快路径：整串就是 JSON。
  try {
    return JSON.parse(s);
  } catch {
    /* 继续扫平衡段 */
  }

  // 找第一个 `{` 或 `[`，再从它开始按**同种**定界符扫到平衡点。
  let start = -1;
  let open = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '{' || s[i] === '[') {
      start = i;
      open = s[i];
      break;
    }
  }
  if (start < 0) {
    return null;
  }
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

module.exports = {
  extractFirstJson,
};
