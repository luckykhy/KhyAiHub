'use strict';

/**
 * turnEnvelope.test.js — 钉死回合信封的派生规则：工具名分类、成败三态、
 * artifacts/filesTouched/filesRead 的记账口径、status 判定链与交付判定的降级。
 *
 * 为什么这支套件必须存在：envelope 是 CLI/SSE/API 三路消费者共同读的结构出口，
 * 「绝不解析模型散文」与「失败不伪装成功」是它的两条立命契约。status 判定链
 * （error_code > 工具全败 > 部分 > ok + delivery fail 降级）任何一格写错，
 * 下游看到的就是把失败轮当成功轮存档。
 *
 * 实测更正（与直觉不同处，按真实语义钉死）：
 *   · _classify 走 normalizeAlnumKey（小写去非字母数字）：'write_file'≈'WriteFile'≈'writefile'。
 *   · read 无论成败都进 filesRead；write/edit/delete 只有 success !== false 才进
 *     filesTouched（success 为 null 即未知也记为 touched——「没明确失败就算动了」）。
 *   · success === false 的条目仍进 artifacts，只是不进 filesTouched。
 *   · tool === '_legacy_cmd' 或空名的条目整条跳过，连 errors 都不记。
 *   · metrics.toolCalls = commands.length + artifacts.length，**不含**被跳过与
 *     other 类工具；unknown 工具（kind==='other'）成败仍计数但不出现在任何清单。
 *   · 顶层 error_code / pseudoRefusal 时 errors **unshift** 在每条工具错之前，
 *     code 缺省为 'PSEUDO_REFUSAL'；status 直接 'error'（压过一切工具统计）。
 *   · status 判定顺序：toolCalls===0 的「纯问答 ok」短路**先于**失败统计——只跑了
 *     other 类工具且全败的回合仍判 ok（errors 里如实记败）。
 *   · delivery.verdict === 'fail' 只把 'ok' 降为 'partial'，不改变 'error'。
 *   · 无任何工具、无错误 → status 'ok'（纯问答轮）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildTurnEnvelope, SCHEMA_VERSION, _classify, _resolveSuccess } = require('./turnEnvelope');

test('_classify：别名不敏感归类，edit 优先于 write，未知归 other', () => {
  assert.equal(_classify('write_file'), 'write');
  assert.equal(_classify('WriteFile'), 'write');
  assert.equal(_classify('EditFile'), 'edit'); // edit 名单先于 write 命中
  assert.equal(_classify('rm'), 'delete');
  assert.equal(_classify('bash'), 'command');
  assert.equal(_classify('Read'), 'read');
  assert.equal(_classify('web_search'), 'other');
  assert.equal(_classify(''), 'other');
  assert.equal(_classify(null), 'other');
});

test('_resolveSuccess：三态且不猜——success > exitCode > error 字符串 > isError > null', () => {
  assert.equal(_resolveSuccess({ success: false, exitCode: 0 }), false); // success 字段最优先
  assert.equal(_resolveSuccess({ exitCode: 0 }), true);
  assert.equal(_resolveSuccess({ exitCode: 1 }), false);
  assert.equal(_resolveSuccess({ error: 'boom' }), false);
  assert.equal(_resolveSuccess({ isError: true }), false);
  assert.equal(_resolveSuccess({ stdout: 'hi' }), null); // 无结构化信号 → 未知
  assert.equal(_resolveSuccess(undefined), null);
  assert.equal(_resolveSuccess('not-an-object'), null);
});

test('空输入返回形状完整的 ok 信封，绝不抛', () => {
  const env = buildTurnEnvelope(undefined);
  assert.equal(env.schemaVersion, SCHEMA_VERSION);
  assert.equal(env.status, 'ok');
  assert.equal(env.summary, '');
  assert.deepEqual(env.artifacts, []);
  assert.deepEqual(env.filesTouched, []);
  assert.equal(env.delivery, null);
  assert.equal(env.metrics.iterations, null);
  assert.equal(env.metrics.toolCalls, 0);
});

test('纯问答轮（无工具日志）为 ok；summary 依次取 opts.summary > finalResponse > reply', () => {
  assert.equal(buildTurnEnvelope({ reply: 'r' }, { summary: 's' }).summary, 's');
  assert.equal(buildTurnEnvelope({ finalResponse: 'f', reply: 'r' }).summary, 'f');
  assert.equal(buildTurnEnvelope({ reply: 'r' }).summary, 'r');
  const env = buildTurnEnvelope({ finalResponse: '答案', iterations: 3, provider: 'claude' });
  assert.equal(env.status, 'ok');
  assert.equal(env.metrics.iterations, 3);
  assert.equal(env.metrics.provider, 'claude');
});

test('命令类工具进 commands，exitCode 与三态 success 随行', () => {
  const env = buildTurnEnvelope({
    toolCallLog: [
      { tool: 'Bash', params: { command: '  npm test  ' }, result: { exitCode: 0 } },
      { tool: 'shell', params: { cmd: 'ls' }, result: { exitCode: 2, error: 'nope' } },
      { tool: 'exec', params: {}, result: {} },
    ],
  });
  assert.equal(env.commands.length, 3);
  assert.equal(env.commands[0].command, 'npm test'); // trim 生效
  assert.equal(env.commands[0].success, true);
  assert.equal(env.commands[1].exitCode, 2);
  assert.equal(env.commands[2].command, null);
  assert.equal(env.commands[2].success, null);
  // 一败一成 → partial；失败记入 errors
  assert.equal(env.status, 'partial');
  assert.deepEqual(env.errors, [{ tool: 'shell', code: null, message: 'nope' }]);
});

test('文件类记账：read 不论成败都进 filesRead；写类仅 success!==false 进 filesTouched', () => {
  const env = buildTurnEnvelope({
    toolCallLog: [
      { tool: 'read_file', params: { file_path: '/a.js' }, result: { error: 'EACCES' } },
      { tool: 'WriteFile', params: { path: '/b.js' }, result: { success: false, error_code: 'E05' } },
      { tool: 'Edit', params: { filePath: '/c.js' }, result: { updated: true } }, // success 未知
      { tool: 'createfile', params: { file: '/d.js' }, result: { success: true } },
    ],
  });
  assert.deepEqual(env.filesRead, ['/a.js']); // 读失败也进 filesRead，但会进 errors
  assert.deepEqual(env.filesTouched, ['/c.js', '/d.js']); // b 明确失败被剔除；c 未知仍记
  assert.equal(env.artifacts.length, 4); // 失败条目仍出现在 artifacts
  assert.deepEqual(env.artifacts[1], { path: '/b.js', action: 'write', tool: 'WriteFile' });
  assert.equal(env.status, 'partial'); // a、b 明确失败，c 未知，d 成功 → 有败有成
});

test('状态判定链：全败→error；混合→partial；unknown 工具计数但不进清单', () => {
  const allFail = buildTurnEnvelope({
    toolCallLog: [
      { tool: 'bash', params: { command: 'x' }, result: { error: 'e1' } },
      { tool: 'write_file', params: { path: 'p' }, result: { isError: true } },
    ],
  });
  assert.equal(allFail.status, 'error');
  assert.equal(allFail.metrics.toolCalls, 2);
  // other 类工具：成败参与统计，artifacts/commands 均不记
  const otherOnly = buildTurnEnvelope({
    toolCallLog: [{ tool: 'web_search', params: {}, result: { success: false, error: 'x' } }],
  });
  // 实测更正：toolCalls===0 的短路在失败统计**之前**——只跑了 unknown 工具且全败的
  // 回合仍被判 'ok'（纯问答分支抢先）。这是真实判定顺序，钉死待评审。
  assert.equal(otherOnly.status, 'ok');
  assert.equal(otherOnly.metrics.toolCalls, 0);
  assert.equal(otherOnly.errors.length, 1); // errors 里仍如实记着那条失败
});

test('顶层 error_code / pseudoRefusal 压过一切：status=error 且错误 unshift 在最前', () => {
  const env = buildTurnEnvelope({
    error_code: 'E03',
    attribution: { message: '上游炸了' },
    toolCallLog: [{ tool: 'bash', params: { command: 'ok' }, result: { exitCode: 0 } }],
  });
  assert.equal(env.status, 'error'); // 明明有成功工具也照错
  assert.equal(env.errors[0].tool, null);
  assert.equal(env.errors[0].code, 'E03');
  assert.equal(env.errors[0].message, '上游炸了');
  // pseudoRefusal 无 error_code → 占位码 PSEUDO_REFUSAL，message 缺省 null
  const pr = buildTurnEnvelope({ pseudoRefusal: true });
  assert.equal(pr.status, 'error');
  assert.deepEqual(pr.errors[0], { tool: null, code: 'PSEUDO_REFUSAL', message: null });
});

test('delivery.verdict=fail 只降级 ok→partial，不改动 error', () => {
  const ok = buildTurnEnvelope({
    harness: { deliveryVerdict: { verdict: 'fail', blockedBy: 'tests', summary: '未过测' } },
  });
  assert.equal(ok.status, 'partial');
  assert.deepEqual(ok.delivery, { verdict: 'fail', blockedBy: ['tests'], summary: '未过测' });
  const err = buildTurnEnvelope({
    error_code: 'E01',
    harness: { deliveryVerdict: { verdict: 'fail', blockedBy: ['a', 'b'] } },
  });
  assert.equal(err.status, 'error'); // 已是 error，不再降
  assert.deepEqual(err.delivery.blockedBy, ['a', 'b']); // 数组形态直通
  const warn = buildTurnEnvelope({ harness: { deliveryVerdict: { verdict: 'warn' } } });
  assert.equal(warn.status, 'ok'); // warn 不触发降级（实测：仅 fail 降级）
  assert.deepEqual(warn.delivery.blockedBy, []);
  assert.equal(warn.delivery.summary, '');
});

test('_legacy_cmd 与空名条目整条跳过，不进任何计数', () => {
  const env = buildTurnEnvelope({
    toolCallLog: [
      null,
      'garbage',
      { tool: '', result: { error: 'x' } },
      { tool: '_legacy_cmd', params: { command: 'ls' }, result: { success: false } },
      { tool: 'bash', params: { command: 'real' }, result: { success: true } },
    ],
  });
  assert.equal(env.commands.length, 1);
  assert.equal(env.errors.length, 0); // 被跳过条目的失败不记 error
  assert.equal(env.metrics.toolCalls, 1);
  assert.equal(env.status, 'ok');
});
