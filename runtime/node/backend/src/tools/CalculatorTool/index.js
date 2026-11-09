'use strict';

/**
 * CalculatorTool — 循环内数值计算叶子。
 *
 * 由来：[RESEARCH-028] §4.1 P1-4（llm-math 缺口）：输出侧有 answerVerifier 做算式
 * 真值复核，输入侧却没有计算叶子，任务中途要算（定价链、汇总、单位换算）时模型只能
 * 口算或绕 shellCommand——更容易错、更废 token。本叶子补上「循环内能算」，与既有
 * 的「收尾能验」闭环；不碰主循环。
 *
 * 安全是结构性的，不是过滤出来的：tokenizer + 递归下降解析器只认一张固定文法
 * （数字、+ - * / % ^、括号、白名单函数/常量），整条路径没有 eval / Function /
 * vm / 动态 require，所以「执行任意代码」在这里不是可能触发的 bug，而是不可能
 * 出现的形态。这也是它敢直接交给模型用的前提。
 *
 * 阈值走 env 覆盖 + KHY_* 命名（RUNTIME-001），沿用 tools/fileReadLimit.js 的
 * 叶子惯例：本地默认常量 + env 覆盖，无新依赖（PROCESS-013——package.json 里没有
 * 现成表达式求值依赖，故白名单自实现）。
 */

const { BaseTool } = require('../_baseTool');

const DEFAULT_MAX_EXPR_CHARS = 500;
const DEFAULT_MAX_NODES = 200;

// 模型会打全角/排版体运算符与 ** 乘方；先归一化，tokenizer 的字符白名单才能保持严格。
const OPERATOR_ALIASES = {
  '×': '*',
  '÷': '/',
  '−': '-',
  '，': ',',
  '（': '(',
  '）': ')',
};

const NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const SINGLE_CHAR_TOKENS = new Set(['+', '-', '*', '/', '%', '^', '(', ')', ',']);

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

function applyDiv(a, b) {
  if (b === 0) {
    throw new Error('除数不能为 0：请检查表达式中的 / 或 %');
  }
  return a / b;
}

function applyPow(base, exponent) {
  const value = Math.pow(base, exponent);
  if (Number.isNaN(value)) {
    throw new Error(`幂运算未定义：${base} 的 ${exponent} 次方不在实数范围内`);
  }
  return value;
}

function roundTo(x, digits) {
  const d = digits === undefined ? 0 : digits;
  if (!Number.isInteger(d) || d < 0 || d > 15) {
    throw new Error(`round 的位数须为 0-15 的整数，收到了 ${digits}`);
  }
  const factor = 10 ** d;
  return Math.round(x * factor) / factor;
}

function average(...xs) {
  return xs.reduce((acc, x) => acc + x, 0) / xs.length;
}

const FUNCTIONS = {
  abs: { min: 1, max: 1, fn: Math.abs },
  sqrt: { min: 1, max: 1, fn: Math.sqrt },
  cbrt: { min: 1, max: 1, fn: Math.cbrt },
  exp: { min: 1, max: 1, fn: Math.exp },
  ln: { min: 1, max: 1, fn: Math.log },
  log: {
    min: 1,
    max: 2,
    fn: (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)),
  },
  log2: { min: 1, max: 1, fn: Math.log2 },
  log10: { min: 1, max: 1, fn: Math.log10 },
  logb: { min: 2, max: 2, fn: (x, base) => Math.log(x) / Math.log(base) },
  pow: { min: 2, max: 2, fn: applyPow },
  round: { min: 1, max: 2, fn: roundTo },
  floor: { min: 1, max: 1, fn: Math.floor },
  ceil: { min: 1, max: 1, fn: Math.ceil },
  trunc: { min: 1, max: 1, fn: Math.trunc },
  sign: { min: 1, max: 1, fn: Math.sign },
  sin: { min: 1, max: 1, fn: Math.sin },
  cos: { min: 1, max: 1, fn: Math.cos },
  tan: { min: 1, max: 1, fn: Math.tan },
  asin: { min: 1, max: 1, fn: Math.asin },
  acos: { min: 1, max: 1, fn: Math.acos },
  atan: { min: 1, max: 1, fn: Math.atan },
  atan2: { min: 2, max: 2, fn: Math.atan2 },
  sinh: { min: 1, max: 1, fn: Math.sinh },
  cosh: { min: 1, max: 1, fn: Math.cosh },
  tanh: { min: 1, max: 1, fn: Math.tanh },
  hypot: { min: 1, max: 8, fn: Math.hypot },
  radians: { min: 1, max: 1, fn: (deg) => (deg * Math.PI) / 180 },
  degrees: { min: 1, max: 1, fn: (rad) => (rad * 180) / Math.PI },
  min: { min: 1, max: 32, fn: Math.min },
  max: { min: 1, max: 32, fn: Math.max },
  sum: { min: 1, max: 64, fn: (...xs) => xs.reduce((acc, x) => acc + x, 0) },
  mean: { min: 1, max: 64, fn: average },
  avg: { min: 1, max: 64, fn: average },
  average: { min: 1, max: 64, fn: average },
};

// 0.1+0.2 在 IEEE-754 里是 0.30000000000000004；计算器把它原样打出来只会训练模型
// 不信任这个工具。12 位有效数字远低于任何真实定价链的精度需求，远高于浮点噪声。
function tidy(value) {
  const rounded = Number(value.toPrecision(12));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeExpression(src) {
  let out = src;
  for (const [from, to] of Object.entries(OPERATOR_ALIASES)) {
    out = out.split(from).join(to);
  }
  return out.replace(/\*\*/g, '^');
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    const rest = src.slice(i);
    const numMatch = rest.match(NUMBER_RE);
    if (numMatch) {
      tokens.push({ type: 'num', value: Number(numMatch[0]) });
      i += numMatch[0].length;
      continue;
    }
    const identMatch = rest.match(IDENT_RE);
    if (identMatch) {
      tokens.push({ type: 'ident', value: identMatch[0] });
      i += identMatch[0].length;
      continue;
    }
    if (SINGLE_CHAR_TOKENS.has(ch)) {
      const type = ch === '(' ? 'lparen' : ch === ')' ? 'rparen' : ch === ',' ? 'comma' : 'op';
      tokens.push({ type, value: ch });
      i += 1;
      continue;
    }
    throw new Error(
      `表达式含不支持的字符「${ch}」（第 ${i + 1} 个字符）：仅支持数字、+ - * / % ^ ( ) ,、标识符与空格`
    );
  }
  return tokens;
}

function evaluateExpression(src, maxNodes) {
  const tokens = tokenize(src);
  let pos = 0;
  let nodes = 0;
  let pendingOp = null;

  const peek = () => tokens[pos];
  const advance = () => tokens[pos++];

  function budget() {
    nodes += 1;
    if (nodes > maxNodes) {
      throw new Error(`表达式结构超过节点上限 ${maxNodes}：请拆成多步计算`);
    }
  }

  function incompleteError() {
    if (pendingOp === '%') {
      // 后缀百分号是最常见的模型误用；直接给改写形式，别让它去猜。
      return new Error(
        '表达式以「%」结尾：本工具把 % 当作取余运算符，不支持后缀百分号，请改用小数（如 15% → 0.15）'
      );
    }
    if (pendingOp) {
      return new Error(`表达式以运算符「${pendingOp}」结尾：此处缺少数字或表达式`);
    }
    return new Error('表达式不完整：结尾处缺少数字或表达式');
  }

  function arityText(spec) {
    return spec.min === spec.max ? String(spec.min) : `${spec.min}-${spec.max}`;
  }

  function parseCall(name) {
    const spec = FUNCTIONS[name.toLowerCase()];
    if (!spec) {
      throw new Error(
        `未知函数「${name}」：可用函数见工具说明（abs/sqrt/log/round/min/max/sum/mean 等）`
      );
    }
    advance();
    const args = [];
    if (peek() && peek().type !== 'rparen') {
      args.push(parseExpr());
      while (peek() && peek().type === 'comma') {
        advance();
        args.push(parseExpr());
      }
    }
    const closing = peek();
    if (!closing || closing.type !== 'rparen') {
      throw new Error(`函数 ${name}( 的参数列表缺少对应的 ")"`);
    }
    advance();
    if (args.length < spec.min || args.length > spec.max) {
      throw new Error(`函数 ${name} 需要 ${arityText(spec)} 个参数，收到了 ${args.length} 个`);
    }
    pendingOp = null;
    return spec.fn(...args);
  }

  function parseAtom() {
    budget();
    const t = peek();
    if (!t) {
      throw incompleteError();
    }
    if (t.type === 'num') {
      advance();
      pendingOp = null;
      return t.value;
    }
    if (t.type === 'ident') {
      advance();
      const name = t.value;
      if (peek() && peek().type === 'lparen') {
        return parseCall(name);
      }
      const constant = CONSTANTS[name.toLowerCase()];
      if (constant !== undefined) {
        pendingOp = null;
        return constant;
      }
      throw new Error(
        `未识别的名称「${name}」：仅支持常量 ${Object.keys(CONSTANTS).join('/')} 与白名单函数（见工具说明）`
      );
    }
    if (t.type === 'lparen') {
      advance();
      const value = parseExpr();
      const closing = peek();
      if (!closing || closing.type !== 'rparen') {
        throw new Error('括号不匹配：表达式缺少对应的 ")"');
      }
      advance();
      pendingOp = null;
      return value;
    }
    throw new Error(`表达式在「${t.value}」处不完整：此处应为数字、函数或括号`);
  }

  function parsePower() {
    budget();
    const base = parseAtom();
    const t = peek();
    if (t && t.type === 'op' && t.value === '^') {
      pendingOp = '^';
      advance();
      return applyPow(base, parseUnary());
    }
    return base;
  }

  function parseUnary() {
    budget();
    const t = peek();
    if (t && t.type === 'op' && (t.value === '-' || t.value === '+')) {
      pendingOp = t.value;
      advance();
      const value = parseUnary();
      return t.value === '-' ? -value : value;
    }
    return parsePower();
  }

  function parseTerm() {
    budget();
    let value = parseUnary();
    for (;;) {
      const t = peek();
      if (t && t.type === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        pendingOp = t.value;
        advance();
        const rhs = parseUnary();
        if (t.value === '*') {
          value *= rhs;
        } else if (t.value === '/') {
          value = applyDiv(value, rhs);
        } else {
          value %= rhs;
        }
        continue;
      }
      return value;
    }
  }

  function parseExpr() {
    budget();
    let value = parseTerm();
    for (;;) {
      const t = peek();
      if (t && t.type === 'op' && (t.value === '+' || t.value === '-')) {
        pendingOp = t.value;
        advance();
        const rhs = parseTerm();
        value = t.value === '+' ? value + rhs : value - rhs;
        continue;
      }
      return value;
    }
  }

  const value = tidy(parseExpr());

  const leftover = peek();
  if (leftover) {
    throw new Error(`表达式末尾有多余内容「${leftover.value}」：请检查是否漏了运算符或括号`);
  }
  if (!Number.isFinite(value)) {
    throw new Error('计算结果未定义或溢出（如负数开平方、0÷0、超出双精度范围）：请检查表达式');
  }
  return value;
}

function _posInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function resolveMaxExprChars(env = process.env) {
  return _posInt(env && env.KHY_CALCULATOR_MAX_EXPR_CHARS) || DEFAULT_MAX_EXPR_CHARS;
}

function resolveMaxNodes(env = process.env) {
  return _posInt(env && env.KHY_CALCULATOR_MAX_NODES) || DEFAULT_MAX_NODES;
}

class CalculatorTool extends BaseTool {
  static toolName = 'Calculator';
  static category = 'analysis';
  static risk = 'low';
  static aliases = ['calculator', 'calc', 'math', 'arithmetic', 'compute'];
  static searchHint = 'calculator arithmetic math numeric evaluate expression 计算 算术 求值';
  static shouldDefer = false;

  isReadOnly() {
    return true;
  }

  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `数值计算用我，不要口算：任务中途需要算（定价链、汇总、单位换算、百分比、利息）时调用本工具——不要用心算，也不要用 Bash/CodeInterpreter 绕。

运算符：+ - * / %（取余） ^（乘方，右结合）、括号、小数与科学计数法（1.2e3）；常量 pi/e/tau。
函数：abs sqrt cbrt exp ln log（以 10 为底） log2 log10 logb(x,b) pow round(x,位数) floor ceil trunc sign
sin cos tan asin acos atan atan2 sinh cosh tanh hypot radians degrees min max sum mean。
也接受 × ÷ − 、全角括号与 **（乘方）。

约束：严格白名单求值，绝不执行任意代码；不支持变量、字符串、成员访问与比较运算。
示例："sqrt(2)*100" → 141.421356237；"(1200+800)*0.13" → 260；"200*0.15" → 30。`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            '要求值的算术表达式字符串，如 "(1200+800)*0.13" 或 "sqrt(2)*100"。支持 + - * / % ^、括号、常量 pi/e/tau 与白名单数学函数（完整清单见工具说明）。',
        },
      },
      required: ['expression'],
    };
  }

  async execute(params) {
    const raw = params && params.expression;
    if (typeof raw !== 'string' || raw.trim() === '') {
      return {
        success: false,
        error: 'expression 必须是非空字符串：请提供算式，例如 "(1200+800)*0.13" 或 "sqrt(2)*100"',
      };
    }

    const expression = normalizeExpression(raw);
    const maxChars = resolveMaxExprChars(process.env);
    if (expression.length > maxChars) {
      return {
        success: false,
        error: `表达式过长（${expression.length} 字符 > 上限 ${maxChars}）：请拆成多步计算，或用 KHY_CALCULATOR_MAX_EXPR_CHARS 调整上限`,
      };
    }

    try {
      const result = evaluateExpression(expression, resolveMaxNodes(process.env));
      return { success: true, expression, result, formatted: String(result) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  getActivityDescription(input) {
    return `计算表达式：${String((input && input.expression) || '').slice(0, 40)}`;
  }
}

module.exports = CalculatorTool;
