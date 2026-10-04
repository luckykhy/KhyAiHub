'use strict';

// Co-located contract tests for safeResponse.js (C-4, [RESEARCH-018] §2.3).
// SafeResponseWrapper is the "零静默失败" base: whatever an LLM / tool / external call
// returns must be turned into either the original value or a structured E0x failure —
// never an empty return. The cases below therefore concentrate on (a) guard() never
// resolving to nothing, (b) the empty-value detectors for each kind, and (c) the one
// place the redaction guarantee can still be bypassed.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const safeResponse = require('./safeResponse');
const { SafeResponseWrapper } = safeResponse;
const { isKnownCode, FALLBACK_CODE } = require('./errorCodes');

describe('模块面与构造', () => {
  test('对外面只暴露 SafeResponseWrapper 一个符号', () => {
    assert.deepEqual(Object.keys(safeResponse), ['SafeResponseWrapper']);
  });

  test('构造器把 null/undefined 上下文收敛为空对象，字符串键照样保留', () => {
    assert.deepEqual(new SafeResponseWrapper(null).context, {});
    assert.deepEqual(new SafeResponseWrapper(undefined).context, {});
    assert.deepEqual(new SafeResponseWrapper({ model: 'm' }).context, { model: 'm' });
  });

  test('校验器不写回 this.context：一次调用的局部上下文不外溢', () => {
    const shared = { model: 'm' };
    const w = new SafeResponseWrapper(shared);
    w.validateLLM('');
    w.validateTool(null);
    assert.deepEqual(shared, { model: 'm' }, 'context 被就地加了 kind 字段');
  });

  test('子类继承后 _safeCall 可用（继承用法是头注释承诺的第二种）', async () => {
    class FakeAdapter extends SafeResponseWrapper {
      constructor() {
        super({ kind: 'llm', model: 'fake' });
      }
      async ask() {
        return this._safeCall(async () => 'answer text');
      }
    }
    assert.equal(await new FakeAdapter().ask(), 'answer text');
  });
});

describe('guard：永不返回空', () => {
  test('成功路径 ok=true，value 与 raw 都是原始结果，failure 为 null', async () => {
    const w = new SafeResponseWrapper({ kind: 'llm', model: 'm' });
    const r = await w.guard(async () => 'hello');
    assert.deepEqual(r, { ok: true, value: 'hello', failure: null, raw: 'hello' });
  });

  test('生产者抛异常时 ok=false 且 failure 是完整 E0x 结构（catch 不空返回）', async () => {
    const w = new SafeResponseWrapper({ kind: 'tool', toolName: 'grep' });
    const r = await w.guard(() => {
      throw new Error('spawn ENOENT');
    });
    assert.equal(r.ok, false);
    assert.equal(isKnownCode(r.failure.error_code), true);
    assert.equal(r.failure.status, 'failed');
    assert.equal(r.value, r.failure, 'ok=false 时 value 必须同 failure，杜绝空透传');
    assert.equal(r.raw.message, 'spawn ENOENT');
    assert.match(r.failure.detail, /spawn ENOENT/);
  });

  test('producer 不是函数也不抛：归因成结构化失败而不是让 TypeError 逃逸', async () => {
    for (const bad of ['nope', null, undefined, 0, {}, []]) {
      const r = await new SafeResponseWrapper().guard(bad);
      assert.equal(r.ok, false, `${String(bad)} 作为 producer 必须被判失败`);
      assert.equal(r.failure.error_code, FALLBACK_CODE);
    }
  });

  test('局部上下文覆盖实例上下文，kind 决定校验器分派', async () => {
    const w = new SafeResponseWrapper({ kind: 'value' });
    assert.equal((await w.guard(async () => '')).ok, false, 'value 下空串是失败');
    const asTool = await w.guard(async () => '', { kind: 'tool' });
    assert.equal(asTool.ok, true, 'tool 校验器不看空串（见下方 KNOWN-DEFECT）');
    const asLlm = await w.guard(async () => ({ content: '' }), { kind: 'llm' });
    assert.equal(asLlm.ok, false);
    assert.equal(asLlm.failure.error_code, 'E01');
  });

  test('_safeCall 失败时抛出携带 failure/error_code 的 Error，成功时返回原值', async () => {
    const w = new SafeResponseWrapper({ kind: 'llm', model: 'm' });
    await assert.rejects(
      () => w._safeCall(async () => ''),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.error_code, 'E01');
        assert.equal(err.failure.error_code, 'E01');
        assert.equal(err.message, err.failure.reason);
        return true;
      }
    );
    assert.equal(await w._safeCall(async () => 'fine'), 'fine');
  });
});

describe('validateLLM：空内容与安全停止', () => {
  test('null/undefined/空串/纯空白对象内容都归 E01，且带 model 与 prompt_tokens', () => {
    const w = new SafeResponseWrapper({ kind: 'llm', model: 'deepseek' });
    for (const empty of [null, undefined, '', '   \n\t ', {}, { content: '' }, { text: '  ' }, { message: '' }, { finalResponse: '' }]) {
      const out = w.validateLLM(empty);
      assert.ok(out, `${JSON.stringify(empty)} 应被判空`);
      assert.equal(out.error_code, 'E01');
      assert.equal(out.fields.model, 'deepseek');
    }
  });

  test('有工具调用就不算空响应（tool_calls/toolCalls/tool_use 三种载体）', () => {
    const w = new SafeResponseWrapper({ kind: 'llm' });
    for (const key of ['tool_calls', 'toolCalls', 'tool_use', 'toolCallLog']) {
      assert.equal(w.validateLLM({ [key]: [{ id: '1' }] }), null, `${key} 有内容应放行`);
    }
    assert.equal(w.validateLLM({ tool_calls: [] }).error_code, 'E01', '空数组仍是空响应');
  });

  test('finish_reason 安全停止优先于内容存在，归 E02 且脱敏', () => {
    const w = new SafeResponseWrapper({ kind: 'llm', model: 'm' });
    const out = w.validateLLM({ content: '部分内容', finish_reason: 'refusal' });
    assert.equal(out.error_code, 'E02');
    assert.equal(out.sensitive, true);
    assert.ok(!out.detail.includes('部分内容'), `E02 detail 泄露了原始内容: ${out.detail}`);
  });

  test('结构化失败交回 classify 精确归类（success:false / error.code / 裁决对象）', () => {
    const w = new SafeResponseWrapper({ kind: 'llm' });
    assert.equal(w.validateLLM({ success: false, error: { code: 'TIMEOUT' } }).error_code, 'E06');
    assert.equal(w.validateLLM({ error_code: 'E08' }).error_code, 'E08');
    assert.equal(w.validateLLM({ allow: false, decision: 'deny', level: 2 }).error_code, 'E07');
  });

  test('prompt_tokens 走三处取源，0 也算在场不填 unknown', () => {
    const w = new SafeResponseWrapper({ kind: 'llm', model: 'm' });
    assert.equal(w.validateLLM({ content: '', prompt_tokens: 0 }).fields.prompt_tokens, 0);
    assert.equal(w.validateLLM({ content: '', tokenUsage: { prompt_tokens: 11 } }).fields.prompt_tokens, 11);
    assert.equal(w.validateLLM({ content: '', usage: { prompt_tokens: 22 } }).fields.prompt_tokens, 22);
    assert.equal(w.validateLLM({ content: '' }, { promptTokens: 33 }).fields.prompt_tokens, 33);
    assert.equal(w.validateLLM({ content: '' }).attribution_complete, false);
  });

  test('合格响应返回 null 而不是假失败（文本/0 长度以上）', () => {
    const w = new SafeResponseWrapper({ kind: 'llm' });
    assert.equal(w.validateLLM('有内容'), null);
    assert.equal(w.validateLLM({ content: '0' }), null);
    assert.equal(w.validateLLM({ content: 'ok', finish_reason: 'stop' }), null);
  });

  test('KNOWN-DEFECT: 数字 0 作为响应正文被当成空响应，而裸 0 却放行', () => {
    // safeResponse.js:178-179 `_isEmptyLLM` takes `v.content` and decides emptiness with
    // `!!text` for non-strings. A gateway that returns the number 0 (or false) as content
    // therefore produces a user-visible E01 "模型返回空内容" although the model did answer,
    // while the same value at the top level (typeof number → not object) passes as valid.
    const w = new SafeResponseWrapper({ kind: 'llm', model: 'm' });
    assert.equal(w.validateLLM({ content: 0 }).error_code, 'E01');
    assert.equal(w.validateLLM({ content: false }).error_code, 'E01');
    assert.equal(w.validateLLM(0), null, '裸 0 反而通过校验');
    assert.equal(w.validateLLM({ content: 12 }), null, '非零数字却通过：判定只看真假不看类型');
  });
});

describe('validateTool / _validate 默认分派', () => {
  test('工具返回 null/undefined 视为崩溃 E04，不当作成功的空结果放行', () => {
    const w = new SafeResponseWrapper({ kind: 'tool', toolName: 'calc' });
    for (const empty of [null, undefined]) {
      const out = w.validateTool(empty);
      assert.equal(out.error_code, 'E04');
      assert.equal(out.fields.tool_name, 'calc');
      assert.match(out.detail, /未捕获异常/);
    }
  });

  test('工具软失败（success:false / allow:false）交回 classify', () => {
    const w = new SafeResponseWrapper({ kind: 'tool' });
    assert.equal(w.validateTool({ success: false, error: { code: 'PERMISSION_DENIED' } }).error_code, 'E07');
    assert.equal(w.validateTool({ allow: false, tripped: true }).error_code, 'E07');
    assert.equal(w.validateTool({ result: 'ok' }), null);
  });

  test('默认 kind（value）时空串与空数组判失败，对象/数字放行', async () => {
    const w = new SafeResponseWrapper();
    assert.equal((await w.guard(async () => '')).failure.error_code, FALLBACK_CODE);
    assert.equal((await w.guard(async () => [])).ok, false);
    assert.equal((await w.guard(async () => 0)).ok, true, '数字 0 不算空值');
    assert.equal((await w.guard(async () => false)).ok, true);
    assert.equal((await w.guard(async () => ({}))).ok, true);
  });

  test('KNOWN-DEFECT: validateTool 不检查空串/空数组，工具静默空输出被当成功放行', async () => {
    // safeResponse.js:142-154 `_validateTool` only rejects null/undefined and structured
    // failures, while `_validateValue` (line 156) does call _isEmptyValue. A tool that
    // returns '' or [] — the exact "console.error then empty return" pattern the header
    // forbids — passes as ok:true, so the zero-silent-failure rule has a hole on the
    // tool path.
    const w = new SafeResponseWrapper({ kind: 'tool', toolName: 'search' });
    assert.equal(w.validateTool(''), null, '空串工具结果被判合格');
    assert.equal(w.validateTool([]), null);
    assert.equal(w.validateTool('   '), null);
    assert.equal((await w.guard(async () => '', { kind: 'tool' })).ok, true);
    // Same wrapper under the default value kind does catch it.
    assert.equal((await new SafeResponseWrapper().guard(async () => '')).ok, false);
  });

  test('KNOWN-DEFECT: guard 把未脱敏的原始对象放在同级 raw 字段上返回', async () => {
    // safeResponse.js:51 returns `{ ok:false, value:failure, failure, raw: err }`. The E07
    // / E02 redaction happens only inside classify's output object; the raw sibling keeps
    // the original approval verdict with its internal reasons, enumerable and one spread
    // or JSON.stringify away from a log line or a client.
    const secret = 'INTERNAL_APPROVAL_RULE: deny_all_writes_hash=9f2c';
    const verdict = { allow: false, decision: 'deny', level: 5, reasons: [secret] };
    const r = await new SafeResponseWrapper({ kind: 'tool' }).guard(async () => verdict);
    assert.equal(r.failure.error_code, 'E07');
    assert.equal(r.failure.sensitive, true);
    assert.ok(!JSON.stringify(r.failure).includes(secret), 'failure 自身脱敏是到位的');
    assert.deepEqual(Object.keys(r), ['ok', 'value', 'failure', 'raw']);
    assert.equal(r.raw.reasons[0], secret, 'raw 仍是原始未脱敏对象');
    assert.ok(JSON.stringify(r).includes(secret), '整个 guard 结果序列化即泄露');
  });
});

describe('边界与垃圾输入', () => {
  test('KNOWN-DEFECT: 原型链上的 success:false / allow:false 被当成真实结构化失败', () => {
    // safeResponse.js:207-217 `_isStructuredFailure` reads `v.success`, `v.error_code` and
    // `v.allow` through the prototype chain (only `'decision' in v` is written as an
    // explicit `in`, which is also chain-wide). An object built from a polluted prototype —
    // e.g. JSON.parse of a `{"__proto__": {...}}` payload upstream — therefore makes a
    // perfectly good answer get attributed as a tool crash, or fabricates an approval denial.
    const w = new SafeResponseWrapper({ kind: 'llm' });
    const good = { __proto__: { success: false }, content: '正确答案' };
    assert.equal(Object.prototype.hasOwnProperty.call(good, 'success'), false);
    assert.equal(w.validateLLM(good).error_code, 'E04', '继承来的 success:false 触发了归因');
    const fakeVerdict = { __proto__: { allow: false, decision: 'deny' } };
    assert.equal(w.validateTool(fakeVerdict).error_code, 'E07', '继承来的裁决触发了 E07 拦截文案');
    // Own keys named after prototype members are inert by comparison.
    assert.equal(w.validateLLM({ constructor: 'E02' }).error_code, 'E01');
    assert.equal(w.validateLLM({ content: 'ok', __proto__: null }), null);
  });

  test('巨大数字与负数上下文照样归因，不进死循环', () => {
    const w = new SafeResponseWrapper({ kind: 'llm', model: 'm' });
    const out = w.validateLLM({ content: '', prompt_tokens: 1e308 });
    assert.equal(out.error_code, 'E01');
    assert.equal(out.fields.prompt_tokens, 1e308);
    assert.equal(w.validateLLM({ content: '', prompt_tokens: -1 }).fields.prompt_tokens, -1, '负数也是"在场"');
    assert.equal(w.validateLLM({ content: '', prompt_tokens: NaN }).attribution_complete, true, 'NaN 不是 null/undefined/空串，被当有效值');
  });

  test('超长正文不炸，脱敏裁剪在下游生效', () => {
    const w = new SafeResponseWrapper({ kind: 'tool' });
    const out = w.validateTool({ success: false, error: { message: 'e'.repeat(100000) } });
    assert.equal(isKnownCode(out.error_code), true);
    assert.ok(out.detail.length < 1000, `detail 未被裁剪: ${out.detail.length}`);
  });
});
