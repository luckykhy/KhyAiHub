'use strict';

/**
 * CalculatorTool/index.test.js — unit suite for the loop's numeric leaf.
 *
 * The security contract is the point of this tool: a calculator handed to a
 * model must evaluate arithmetic and nothing else. So the suite is split in
 * two halves — the math (does it compute the right number) and the walls (does
 * everything that is not arithmetic get refused). The wall cases go through
 * execute() exactly the way the loop calls it, because a parser that is safe
 * in isolation can still be reachable through a schema hole.
 *
 * No repo-wide tool-count assertion lives here on purpose: the registry count
 * moves with every new tool, and a pinned number turns a neighbour's addition
 * into this file's failure. Wiring is proven by presence, not by arithmetic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const TOOL_PATH = path.join(__dirname, 'index.js');
const Tool = require(TOOL_PATH);

/** Run the tool the way the loop does. */
async function calc(expression) {
  const tool = new Tool();
  return tool.execute({ expression }, {});
}

/** Run the tool in a fresh process with a given env (for the limit overrides). */
function calcWithEnv(env, expression) {
  const script = [
    'const tool = new (require(process.argv[1]))();',
    'tool.execute({ expression: process.argv[2] }, {}).then((r) => {',
    '  console.log(JSON.stringify({ success: r.success, error: r.error || null, result: r.result }));',
    '});',
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script, TOOL_PATH, expression], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

/**
 * Source with comments and string literals stripped — assertions like "the
 * evaluator never calls eval" are about CODE. Matching the raw file also
 * matches the header comment and the prompt text, both of which legitimately
 * name eval/Function because that is the contract being described.
 */
function codeOnly(filePath) {
  const src = require('node:fs').readFileSync(filePath, 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\\n]|\\.)*`/g, '``');
}

// ── the math ─────────────────────────────────────────────────────────────────

test('arithmetic precedence, associativity and unary signs', async () => {
  assert.equal((await calc('1+2*3')).result, 7);
  assert.equal((await calc('(1+2)*3')).result, 9);
  assert.equal((await calc('2^3^2')).result, 512, '^ 右结合');
  assert.equal((await calc('-2^2')).result, -4, '一元负号优先于乘方');
  assert.equal((await calc('10/4')).result, 2.5);
  assert.equal((await calc('10%3')).result, 1);
  assert.equal((await calc('--5')).result, 5);
  assert.equal((await calc('2^-1')).result, 0.5);
});

test('float noise is tidied to 12 significant digits', async () => {
  // 0.1+0.2 is 0.30000000000000004 in IEEE-754; printing that verbatim would
  // train the model to distrust the tool.
  assert.equal((await calc('0.1+0.2')).result, 0.3);
  assert.equal((await calc('1/3')).result, 0.333333333333);
});

test('whitelisted functions and constants evaluate', async () => {
  assert.equal((await calc('sqrt(2)*100')).result, 141.421356237);
  assert.equal((await calc('round(3.14159, 2)')).result, 3.14);
  assert.equal((await calc('log(1000)')).result, 3);
  assert.equal((await calc('logb(8, 2)')).result, 3);
  assert.equal((await calc('pow(2, 10)')).result, 1024);
  assert.equal((await calc('hypot(3, 4)')).result, 5);
  assert.equal((await calc('degrees(pi)')).result, 180);
  assert.equal((await calc('min(3, 1, 2)')).result, 1);
  assert.equal((await calc('sum(1, 2, 3.5)')).result, 6.5);
  assert.equal((await calc('mean(2, 4)')).result, 3);
  assert.equal((await calc('pi')).result, 3.14159265359);
  assert.equal((await calc('e')).result, 2.71828182846);
});

test('typographic operators models emit are normalized', async () => {
  assert.equal((await calc('6 × 7')).result, 42);
  assert.equal((await calc('8 ÷ 2')).result, 4);
  assert.equal((await calc('5 − 3')).result, 2);
  assert.equal((await calc('max(1，2)')).result, 2);
  assert.equal((await calc('2**10')).result, 1024);
  assert.equal((await calc('（1+2）*3')).result, 9);
});

test('scientific notation and leading-dot decimals parse', async () => {
  assert.equal((await calc('1.2e3 + 1')).result, 1201);
  assert.equal((await calc('.5*4')).result, 2);
});

// ── the walls: everything that is not arithmetic is refused ──────────────────

test('unknown names, functions and characters are refused with position', async () => {
  const unknownFn = await calc('foo(1)');
  assert.equal(unknownFn.success, false);
  assert.match(unknownFn.error, /未知函数「foo」/);

  const unknownName = await calc('x + 1');
  assert.equal(unknownName.success, false);
  assert.match(unknownName.error, /未识别的名称「x」/);

  const badChar = await calc('1 @ 2');
  assert.equal(badChar.success, false);
  assert.match(badChar.error, /不支持的字符「@」（第 3 个字符）/);

  // Member access is the classic escape hatch — the dot never reaches the
  // parser because the tokenizer rejects it.
  for (const escape of ['Math.max(1,2)', 'process.exit(1)', 'a[0]', '1;2', 'require("fs")']) {
    const res = await calc(escape);
    assert.equal(res.success, false, `${escape} 必须被拒`);
    assert.match(res.error, /不支持的字符/);
  }
});

test('syntax errors name the problem, not a stack trace', async () => {
  const unbalanced = await calc('(1+2');
  assert.equal(unbalanced.success, false);
  assert.match(unbalanced.error, /括号不匹配/);

  const danglingOp = await calc('1+');
  assert.equal(danglingOp.success, false);
  assert.match(danglingOp.error, /以运算符「\+」结尾/);

  const trailingPercent = await calc('200*15%');
  assert.equal(trailingPercent.success, false);
  assert.match(trailingPercent.error, /不支持后缀百分号.*0\.15/);

  const emptyArgs = await calc('sum()');
  assert.equal(emptyArgs.success, false);
  assert.match(emptyArgs.error, /函数 sum 需要 1-64 个参数，收到了 0 个/);

  const emptyExpr = await calc('   ');
  assert.equal(emptyExpr.success, false);
  assert.match(emptyExpr.error, /expression 必须是非空字符串/);
});

test('arithmetic domain errors are honest, not Infinity or NaN', async () => {
  const divZero = await calc('1/0');
  assert.equal(divZero.success, false);
  assert.match(divZero.error, /除数不能为 0/);

  const negSqrt = await calc('sqrt(-1)');
  assert.equal(negSqrt.success, false);
  assert.match(negSqrt.error, /未定义或溢出/);

  const negPow = await calc('pow(-1, 0.5)');
  assert.equal(negPow.success, false);
  assert.match(negPow.error, /幂运算未定义/);
});

test('expression length and node budget are enforced', async () => {
  const tooLong = await calc(`${'1+'.repeat(250)}1`);
  assert.equal(tooLong.success, false);
  assert.match(tooLong.error, /表达式过长（501 字符 > 上限 500）/);

  const tooDeep = await calc(`${'1+'.repeat(150)}1`);
  assert.equal(tooDeep.success, false);
  assert.match(tooDeep.error, /超过节点上限 200/);
});

test('the caps are env-overridable and nothing else changes', async () => {
  // Child process because the limits are read from process.env at call time.
  const capped = calcWithEnv({ KHY_CALCULATOR_MAX_EXPR_CHARS: '50' }, `${'1+'.repeat(30)}1`);
  assert.equal(capped.success, false);
  assert.match(capped.error, /上限 50/);

  const stillWorks = calcWithEnv({ KHY_CALCULATOR_MAX_EXPR_CHARS: '50' }, '1+1');
  assert.equal(stillWorks.success, true);
  assert.equal(stillWorks.result, 2);
});

test('a non-string expression is refused at the boundary', async () => {
  const tool = new Tool();
  const res = await tool.execute({ expression: 123 }, {});
  assert.equal(res.success, false);
  assert.match(res.error, /expression 必须是非空字符串/);

  const missing = await tool.execute({}, {});
  assert.equal(missing.success, false);
});

// ── the walls, proven on the source ──────────────────────────────────────────

test('the evaluator has no code-execution path at all', () => {
  // Not a filter that could be bypassed — the absence of the primitives.
  const code = codeOnly(TOOL_PATH);
  const src = require('node:fs').readFileSync(TOOL_PATH, 'utf8');
  assert.doesNotMatch(code, /\beval\s*\(/);
  assert.doesNotMatch(code, /new\s+Function/);
  assert.doesNotMatch(code, /child_process|setTimeout|setInterval/);
  // Exactly one require in the whole file: the BaseTool base class. No dynamic
  // module loading anywhere in the evaluation path. (Counted on raw source —
  // codeOnly blanks string literals, which is the point of that helper.)
  assert.equal((src.match(/require\(/g) || []).length, 1);
  assert.match(src, /require\('\.\.\/_baseTool'\)/);
});

// ── tool shape and registry wiring ───────────────────────────────────────────

test('tool shape matches the read-only analysis leaf contract', () => {
  const tool = new Tool();
  assert.equal(tool.constructor.toolName, 'Calculator');
  assert.equal(tool.constructor.category, 'analysis');
  assert.equal(tool.constructor.risk, 'low');
  assert.equal(tool.isReadOnly(), true);
  assert.equal(tool.isConcurrencySafe(), true);
  assert.deepEqual(tool.inputSchema.required, ['expression']);
  assert.equal(tool.inputSchema.properties.expression.type, 'string');
  // The brief's mandate: the model must be told to compute, not to guess.
  assert.match(tool.prompt(), /数值计算用我，不要口算/);
  assert.match(tool.getActivityDescription({ expression: '1+1' }), /计算表达式：1\+1/);
});

test('the registry picks the tool up through the directory scan', () => {
  const registry = require('../index');
  const tool = registry.get('Calculator');
  assert.ok(tool, 'Calculator 必须经目录扫描自动注册');
  assert.equal(tool.risk, 'low');
  assert.equal(tool.isReadOnly(), true);
  assert.ok(tool.aliases.includes('calc'));
});
