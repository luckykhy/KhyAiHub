'use strict';

// Co-located contract tests for classifier.js (C-4, [RESEARCH-018] §2.3).
// ErrorClassifier is the "精准归因" core: every raw failure signal must land on one of
// E01–E08 with that code's required fields, and E02/E07 must never echo back the policy
// text that triggered them. The two properties worth proving per source line are
// (a) total function — nothing in, nothing out is NOT an option — and (b) the redaction
// guarantee on the security-sensitive codes.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const classifier = require('./classifier');
const { isKnownCode, FALLBACK_CODE, getErrorCode } = require('./errorCodes');

const { classify, classifyCode } = classifier;

const OUT_KEYS = [
  'status',
  'error_code',
  'reason',
  'detail',
  'suggestion',
  'retryable',
  'resumable',
  'continueHint',
  'sensitive',
  'category',
  'fields',
  'attribution_complete',
];

// Garbage corpus reused by the totality cases: every one of these must still produce a
// full E0x structure, because the header promises "绝不返回空".
const JUNK = [
  null,
  undefined,
  '',
  '   ',
  0,
  -1,
  NaN,
  false,
  true,
  10n,
  {},
  [],
  [1, 2, 3],
  'constructor',
  '__proto__',
  'E99',
  { constructor: 'E02' },
  { __proto__: { error_code: 'E03' } },
  { toString: () => 'boom' },
  { valueOf: null },
  Symbol('raw signal'),
  () => {
    throw new Error('never called');
  },
];

describe('classify 输出结构契约', () => {
  test('对外面恰为 classify/classifyCode 与两个内部映射复用口', () => {
    assert.deepEqual(Object.keys(classifier).sort(), ['_mapKind', '_mapToolErrorCode', 'classify', 'classifyCode']);
  });

  test('返回值键集合固定为 12 项归因结构，不多不少', () => {
    assert.deepEqual(Object.keys(classify(new Error('boom'))).sort(), OUT_KEYS.slice().sort());
  });

  test('status 恒为 failed，error_code 恒为登记码，reason 恒取自单一真源', () => {
    for (const input of JUNK) {
      const out = classify(input);
      assert.equal(out.status, 'failed');
      assert.equal(isKnownCode(out.error_code), true, `${String(input)} 归因出了未登记码 ${out.error_code}`);
      assert.equal(out.reason, getErrorCode(out.error_code).reason, 'reason 必须是表内固定文案');
      assert.equal(typeof out.detail, 'string');
      assert.equal(out.sensitive, getErrorCode(out.error_code).sensitive === true);
      assert.equal(out.retryable, getErrorCode(out.error_code).retryable === true);
    }
  });

  test('必填字段缺失时填 unknown 并把 attribution_complete 打成 false', () => {
    const out = classify({ errorType: 'empty_reply' });
    assert.equal(out.error_code, 'E01');
    assert.deepEqual(out.fields, { model: 'unknown', prompt_tokens: 'unknown' });
    assert.equal(out.attribution_complete, false);
    const full = classify({ errorType: 'empty_reply' }, { model: 'claude', promptTokens: 1200 });
    assert.deepEqual(full.fields, { model: 'claude', prompt_tokens: 1200 });
    assert.equal(full.attribution_complete, true);
  });

  test('classifyCode 与 classify 对同一信号给出同一个码（轻量探针不改变语义）', () => {
    const signals = [
      new Error('fetch failed'),
      { allow: false, decision: 'deny', level: 3 },
      { errorType: 'schema' },
      { code: 'MISSING_DEPENDENCY' },
      { finish_reason: 'content_filter' },
      'total nonsense string',
      null,
      {},
    ];
    for (const s of signals) {
      assert.equal(classifyCode(s), classify(s).error_code, `探针与全量归因不一致: ${JSON.stringify(s)}`);
    }
  });

  test('classifyCode 也绝不返回空：垃圾输入落兜底码', () => {
    for (const input of JUNK) {
      assert.equal(isKnownCode(classifyCode(input)), true);
    }
    assert.equal(classifyCode({}, { error_code: 'E99' }), FALLBACK_CODE);
  });
});

describe('信号优先级：原始信号 → E0x', () => {
  test('已归因结构幂等沿用（顶层/嵌套/仅 context 三种载体）', () => {
    assert.equal(classifyCode({ error_code: 'E03' }), 'E03');
    assert.equal(classifyCode({ error: { errorCode: 'E06' } }), 'E06');
    assert.equal(classifyCode('some text', { error_code: 'E08' }), 'E08');
  });

  test('空响应三种拼法都归 E01，schema 归 E08，伪拒绝归 E02', () => {
    for (const t of ['empty_reply', 'empty_response', 'empty']) {
      assert.equal(classifyCode({ errorType: t }), 'E01', `${t} 应归模型静默空响应`);
    }
    assert.equal(classifyCode({}, { kind: 'empty_reply' }), 'E01', 'ctx.kind 也是合法载体');
    assert.equal(classifyCode({}, { kind: 'schema' }), 'E08');
    assert.equal(classifyCode({ errorType: 'schema_validation' }), 'E08');
    assert.equal(classifyCode({ errorType: 'pseudo_refusal' }), 'E02');
    assert.equal(classifyCode({ errorType: 'refusal' }), 'E02');
  });

  test('审批网关拒绝优先于通用归类 → E07', () => {
    const verdict = { allow: false, decision: 'deny', level: 4, reasons: ['rule-77'] };
    assert.equal(classifyCode(verdict), 'E07');
    assert.equal(classifyCode({ message: 'x' }, { syscallVerdict: verdict }), 'E07', '旁路 ctx 里的裁决同样有效');
    assert.equal(classify(verdict).retryable, false, '权限拦截不允许自动重试');
  });

  test('依赖缺失早于通用 ToolError 分流 → E05', () => {
    assert.equal(classifyCode({ name: 'MissingDependencyError', depId: 'ffmpeg' }), 'E05');
    const out = classify({ code: 'MISSING_DEPENDENCY', tool: 'ffmpeg', depId: 'libx264' });
    assert.equal(out.error_code, 'E05');
    assert.deepEqual(out.fields, { tool_name: 'ffmpeg', missing_dep: 'libx264' });
  });

  test('finish_reason 的内容安全停止 → E02，正常 stop 不放行', () => {
    assert.equal(classifyCode({ finish_reason: 'content_filter' }), 'E02');
    assert.equal(classifyCode({ finishReason: 'REFUSAL' }), 'E02', '大小写由分类器自己归一');
    assert.equal(classifyCode({ finish_reason: 'stop' }), FALLBACK_CODE);
    assert.equal(classifyCode({}, { finishReason: 'safety' }), 'E02');
  });

  test('工具错误码七种分流各自落位，未知码继续下探', () => {
    const pairs = [
      ['PERMISSION_DENIED', 'E07'],
      ['TIMEOUT', 'E06'],
      ['NETWORK_ERROR', 'E06'],
      ['EXECUTION_ERROR', 'E04'],
      ['TOOL_UNAVAILABLE', 'E04'],
      ['INVALID_ARGS', 'E04'],
      ['RESOURCE_NOT_FOUND', 'E04'],
    ];
    for (const [code, expected] of pairs) {
      assert.equal(classifyCode({ code }), expected, `${code} 归位错误`);
    }
    assert.equal(classifyCode({ code: 'SOMETHING_NEW', message: 'prompt is too long' }), 'E03', '弱码让位给强 kind 信号');
  });

  test('expectedSchema 在场且无更强信号时 → E08', () => {
    assert.equal(classifyCode({}, { expectedSchema: { type: 'object' } }), 'E08');
    assert.equal(classifyCode({ expected_schema: { type: 'array' }, raw_output: 'not json' }), 'E08');
  });

  test('legacy 深链 kind 分流：refusal/context_length/permission/timeout 各归其码', () => {
    assert.equal(classifyCode(new Error('the model returned a refusal')), 'E02');
    assert.equal(classifyCode(new Error('maximum context length exceeded')), 'E03');
    assert.equal(classifyCode({ code: 'EACCES', message: 'sandbox write blocked' }), 'E07');
    assert.equal(classifyCode(new Error('socket hang up')), 'E06');
    assert.equal(classifyCode({ message: 'no clue what happened' }), FALLBACK_CODE);
  });
});

describe('脱敏铁律：E02 / E07 不外泄策略与审批细节', () => {
  test('E07 detail 与 fields 只承载粗类别，原始 reasons 一条都不出现', () => {
    const secret = 'INTERNAL_RULE_77: deny writes to C:\\Windows\\System32 derived from system prompt';
    const out = classify(
      { allow: false, decision: 'deny', level: 5, reasons: [secret], tripped: true },
      { toolName: 'write_file', message: secret }
    );
    assert.equal(out.error_code, 'E07');
    assert.equal(out.sensitive, true);
    assert.equal(out.fields.deny_reason, '[已触发系统管控策略]');
    assert.equal(out.fields.approval_level, 5);
    const blob = JSON.stringify(out);
    assert.ok(!blob.includes('INTERNAL_RULE_77'), `归因结构泄露内部规则: ${blob}`);
    assert.ok(!blob.includes('system prompt'), '归因结构泄露系统 Prompt 字样');
    assert.ok(out.detail.includes('触发了系统管控策略'), out.detail);
  });

  test('E02 即使 ctx 里塞了命中策略原文，detail 仍是固定模板', () => {
    const policy = 'MATCHED_POLICY: minor_safety_block#3121';
    const out = classify({ finish_reason: 'content_filter', model: 'gpt-x' }, { message: policy, rawOutput: policy });
    assert.equal(out.error_code, 'E02');
    assert.ok(!JSON.stringify(out).includes('minor_safety_block'), JSON.stringify(out));
    assert.deepEqual(out.fields, { model: 'gpt-x', finish_reason: 'content_filter' });
    assert.equal(out.resumable, false, '安全中断不允许续接');
    assert.equal(out.continueHint, null);
  });

  test('脱敏码走白名单字段采集：raw_error_stack 之类的高危字段不会出现在 E02/E07', () => {
    for (const code of ['E02', 'E07']) {
      const out = classify({ error_code: code, stack: 'SECRET FRAME at internal/authz.js:1:1', message: 'SECRET' });
      assert.doesNotMatch(JSON.stringify(out), /SECRET FRAME/);
      assert.equal(Object.prototype.hasOwnProperty.call(out.fields, 'raw_error_stack'), false);
    }
  });

  test('非脱敏码才允许携带已裁剪的报错原文与栈', () => {
    const out = classify(new Error('plain tool blew up'), { toolName: 'grep' });
    assert.equal(out.error_code, 'E04');
    assert.ok(out.detail.includes('plain tool blew up'), out.detail);
    assert.ok(out.fields.raw_error_stack.includes('at '), 'E04 应保留栈供下钻');
  });
});

describe('兜底与故障放大防护', () => {
  test('分类器绝不抛：垃圾输入也产出完整归因结构（含 Symbol 与函数）', () => {
    for (const input of JUNK) {
      const out = classify(input);
      assert.equal(typeof out.detail, 'string');
      assert.equal(out.attribution_complete, false, '垃圾输入不可能归因完整');
      assert.equal(out.fields instanceof Object, true);
    }
  });

  test('未知码字符串不会伪装成已归因，落兜底 E04', () => {
    assert.equal(classifyCode({ error_code: 'E42' }), FALLBACK_CODE);
    assert.equal(classifyCode({ error_code: 404 }), FALLBACK_CODE);
    assert.equal(classify({ error_code: 'E42' }).category, getErrorCode(FALLBACK_CODE).category);
  });

  test('KNOWN-DEFECT: 再归因（幂等）只保住错误码，必填字段全部退化成 unknown', () => {
    // classifier.js:101 reads only `error_code` from an already-attributed structure and
    // classifier.js:208 `_collectFields` then looks for `input.model` / `input.tool_name`
    // at the TOP level — but the first pass wrote those into `input.fields.*`. So the
    // documented "原样规范化（幂等）" holds for the code only: re-classifying an E0x
    // structure silently drops its attribution and flips attribution_complete to false,
    // which is exactly what a retry chain / log re-parse does.
    const once = classify({ errorType: 'empty_reply' }, { model: 'claude', promptTokens: 1200 });
    assert.equal(once.attribution_complete, true);
    const twice = classify(once);
    assert.equal(twice.error_code, 'E01', '码本身确实幂等');
    assert.deepEqual(twice.fields, { model: 'unknown', prompt_tokens: 'unknown' });
    assert.equal(twice.attribution_complete, false, '幂等承诺未覆盖字段');
  });

  test('KNOWN-DEFECT: ctx 里过期的 error_code 压过 input 更强的显式信号', () => {
    // classifier.js:101 checks `_readExplicitCode(ctx)` in the same condition as the input
    // one, and returns whichever it finds first — a stale error_code left in a shared
    // context object outranks a fresh `empty_reply` signal produced by this very call.
    assert.equal(classifyCode({ errorType: 'empty_reply' }, { error_code: 'E06' }), 'E06');
    assert.equal(classifyCode({ errorType: 'empty_reply' }, {}), 'E01');
  });

  test('KNOWN-DEFECT: 只读(frozen)失败信号被降级成 E04，本应归 E06', () => {
    // classifierSignals.js:153 writes `probe.code = status` into the caller's object; on a
    // frozen verdict that throws, classifier.js:74 swallows it and returns FALLBACK_CODE.
    // The user is told "工具内部抛出未捕获异常" for what is actually an upstream 503.
    const frozen = Object.freeze({ message: 'gateway hiccup' });
    assert.equal(classifyCode(frozen, { httpStatus: 503 }), 'E04');
    assert.equal(classifyCode({ message: 'gateway hiccup' }, { httpStatus: 503 }), 'E06');
  });

  test('KNOWN-DEFECT: auth/billing/404 一类网关侧失败被归成「工具执行崩溃」', () => {
    // classifierSignals.js:158 `_mapKind` has no case for the auth / billing /
    // model_not_found / cancelled / process kinds that errorClassifier actually returns,
    // so a 401 credential failure ends on the fallback code whose category tells the user
    // a tool threw — misattribution of a gateway failure.
    const cases = [
      { status: 401, message: 'unauthorized' },
      { status: 402, message: 'payment required' },
      { statusCode: 404, message: 'model not found' },
    ];
    for (const input of cases) {
      const out = classify(input);
      assert.equal(out.error_code, 'E04');
      assert.equal(out.category, '工具执行崩溃');
      assert.match(out.detail, /工具 未知工具 执行时抛出未捕获异常/);
    }
  });

  test('KNOWN-DEFECT: detail 用真值判断渲染，值为 0 的数字字段被从文案里抹掉', () => {
    // classifier.js:293 renders `bag.retry_count ? ...` and classifier.js:292 `bag.endpoint ?`,
    // while _collectFields keeps 0 (its pick() only skips null/undefined/''). So the fields
    // bag says "0 retries" and the human-readable detail says nothing about retries — two
    // different truths about the same failure.
    const out = classify({ error_code: 'E06', endpoint: 'https://gw.local', retry_count: 0, timeout_ms: 0 });
    assert.equal(out.fields.retry_count, 0);
    assert.equal(out.fields.timeout_ms, 0);
    assert.equal(out.attribution_complete, true);
    assert.ok(!out.detail.includes('0 次'), `detail 反而丢掉了 0: ${out.detail}`);
    assert.doesNotMatch(out.detail, /超时 \(0ms\)/);
  });

  test('KNOWN-DEFECT: E07 的授权级别 0（L0）在 detail 里被当成缺失', () => {
    // classifier.js:314 renders `fields.approval_level && fields.approval_level !== 'unknown'`,
    // so a genuine level 0 loses its "（需 L0 授权）" suffix while fields still reports 0.
    const out = classify({ allow: false, decision: 'deny', level: 0 }, { toolName: 'read_file' });
    assert.equal(out.fields.approval_level, 0);
    assert.ok(!out.detail.includes('L0'), `L0 授权级别没进文案: ${out.detail}`);
    const higher = classify({ allow: false, decision: 'deny', level: 4 }, { toolName: 'read_file' });
    assert.ok(higher.detail.includes('L4'), higher.detail);
  });
});
