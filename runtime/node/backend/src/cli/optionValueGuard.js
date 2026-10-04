'use strict';

/**
 * optionValueGuard.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 修「未知长选项静默吞掉后一个位置参数」。router.js 的选项解析对任何 `--flag`
 * 都贪心消费下一个 token 作为值:`msg --zqxflag platforms` 里陌生的 `--zqxflag`
 * 把子命令 `platforms` 吃成 `options.zqxflag='platforms'`,命令含义从「平台表」
 * 变成「裸 msg」——用户看到的是语义被偷换,且无任何提示。
 *
 * parseInput 没有逐命令的选项声明表,判不了「未知」;可判的下界是:
 * **值位上的 token 若是该命令的已声明子命令,它首先是位置参数**,不该被选项吃掉。
 * 于是 `--flag <子命令词>` → 选项记为 true,子命令词照常落 args。
 * 非子命令词(`--type relay` 之类真值)与开门前逐字节一致。
 *
 * 门控 KHY_OPTION_VALUE_SUBCMD_GUARD 默认开;关(0/false/off/no)→ 恒 true,
 * call-site 逐字节回退历史贪心逻辑。绝不抛:异常回退 true(=历史行为)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_OPTION_VALUE_SUBCMD_GUARD;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * @param {object} p
 * @param {string} [p.nextVal]      `--flag` 后面那个 token
 * @param {string[]} [p.subCommands] 该命令(规范化后)的已声明子命令表,可为 undefined
 * @param {Record<string,string>} [p.env]
 * @returns {boolean} true = 允许选项消费该 token(历史行为);false = 保留为位置参数
 */
function shouldConsumeNextValue({ nextVal, subCommands, env = process.env } = {}) {
  try {
    if (!isEnabled(env)) return true;
    if (!Array.isArray(subCommands)) return true;
    if (typeof nextVal !== 'string' || nextVal === '') return true;
    if (subCommands.includes(nextVal)) return false;
    return true;
  } catch {
    return true;
  }
}

module.exports = { isEnabled, shouldConsumeNextValue };
