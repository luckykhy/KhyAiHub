'use strict';

/**
 * 微信「出站草稿确认」离线单测(node:test 运行器,与既有 ilink 套件一致)。
 *
 * 覆盖的坑,按重要性排:
 *   1. 草稿**不外发**(正文与文件一个都不发),out 里只有预览;
 *   2. **作者绑定**:peer B 的「发」既不能放行 A 的草稿,也不能被吞掉(B 那条必须进 agent);
 *   3. 不阻塞:待批期间下一条照常跑完;typing 不悬挂;
 *   4. 投递顺序:文件在正文之前;
 *   5. 过期绝不自动发;迟到的「发」不进 agent;**草稿过期不得踩掉权限的宽限窗口**;
 *   6. 诊断面(/queue、/wx、toJSON)看得见待批草稿,0 条时不制造噪音;
 *   7. 草稿词表与权限词表零交集;
 *   8. KHY_ILINK_DRAFT_CONFIRM=0 逐字节回到「正文直接外发」;
 *   9. **slash-clear 只清发起者自己的桶** —— 复核员实测 uA 的 /clear 把 uB 的待批草稿清空,
 *      uB 既没收到提示、内容也永久没了。
 *  10. **诊断面按提问者隔离** —— 复核员实测 uA 从 /wx 看到「2 条草稿待你批准(发送者:uB/uC)」,
 *      草稿正文没泄露,但别人的标识符也不该报给当前这个发送者。
 *
 * 全部离线:注入假 chat / 假通道,关掉结构化工具循环,不触模型、不触网络、不落真实配置。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilinkdraft-'));
process.env.KHY_ILINK_DISABLE_TOOL_LOOP = '1';
// 显式允许名单(见 ilinkAllowlist.test.js):本文件用 uA/uB 两个 peer,不做账号注入。
process.env.KHY_ILINK_ALLOWED_PEERS = 'uA,uB';
process.env.KHY_ILINK_TYPING_KEEPALIVE_MS = '5';
process.env.KHY_ILINK_QUERY_TIMEOUT_MS = '5000';
// 草稿活 5s —— 本文件只有「过期」那几条用例需要短 TTL,由 mkExpiringDispatcher
// 单独临时压到 150ms。早先在这里把整份文件压到 150ms,结果跟过期毫无关系的用例
// 在整套并行跑、机器慢的时候集体翻车:草稿在断言落地前就被清扫掉,断言对着
// 一个已经变了的世界。TTL 的余量得留给调度抖动,不能贴着脸设。
process.env.KHY_ILINK_DRAFT_TTL_MS = '5000';
process.env.KHY_ILINK_DRAFT_GRACE_MS = '200';
// 权限超时压到 60ms,宽限仍走默认 15s(要验证的就是它**没有被草稿清零**)。
process.env.KHY_ILINK_PERMISSION_TIMEOUT_MS = '60';

const defaults = require('../../../src/constants/serviceDefaults');
const core = require('../../../src/services/domain/messaging/messaging/ilinkCore.js');
const log = require('../../../src/utils/logger');
const { IlinkDispatcher } =
  require('../../../src/services/domain/messaging/channels/ilinkDispatcher.js');
const { ReplyDraftQueue } =
  require('../../../src/services/domain/messaging/channels/ilinkReplyDraft.js');
const parseBoolean = require('../../../src/utils/parseBoolean');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 夹具 ────────────────────────────────────────────────────────────────────

/**
 * 假通道。出站按顺序记进 calls,这样「文件必须排在正文之前」是能被断言的事实,
 * 而不是靠读代码推出来的。typing 单独记 flagCalls。
 */
function fakeChannel() {
  const calls = [];
  const typing = [];
  return {
    calls,
    typing,
    async sendReply(_c, _t, x) { calls.push(`text:${x}`); return { ok: true, sent: 1 }; },
    async sendFile(_c, buf, meta) { calls.push(`file:${meta.fileName}`); return { ok: true }; },
    async sendImage(_c, buf, meta) { calls.push(`image:${meta.fileName}`); return { ok: true }; },
    async setTyping(_u, on) { typing.push(on); return true; },
    toJSON() { return { connected: true, accountId: 'botA', failures: 0 }; },
  };
}

/**
 * 构造一个 dispatcher。chatStub 可换;每轮返回 { finalResponse, toolCallLog }。
 * @param {Function} [respond] (prompt, chatOpts, callIndex) => object|string
 */
function mkDispatcher(respond, opts = {}) {
  const channel = opts.channel || fakeChannel();
  const prompts = [];
  let calls = 0;
  const chat = async (prompt, chatOpts) => {
    prompts.push(prompt);
    calls += 1;
    return respond ? respond(prompt, chatOpts, calls) : 'ok';
  };
  const d = new IlinkDispatcher({ channel, accountId: 'botA', getChat: () => chat });
  return { d, channel, prompts, chatCalls: () => calls };
}

/**
 * 草稿只活 150ms 的 dispatcher —— 只供 (h) 那几条「过期」用例用。
 *
 * TTL 在队列构造那一刻被读进 _ttlMs(ilinkDispatcher.js:577),所以临时改写
 * defaults、造完 dispatcher 就还原,别的用例完全不受影响。这比给整份文件压
 * 短 TTL 稳:整套并行跑时机器更慢,跟过期无关的用例不该跟着一起翻车。
 */
function mkExpiringDispatcher(respond, opts = {}) {
  const prev = defaults.ILINK_DRAFT_TTL_MS;
  defaults.ILINK_DRAFT_TTL_MS = 150;
  try {
    return mkDispatcher(respond, opts);
  } finally {
    defaults.ILINK_DRAFT_TTL_MS = prev;
  }
}

/** 一条 SendUserFile 成功的 toolCallLog 条目(真实形状见 ilinkFileSend.test.js)。 */
function fileLog(filePath) {
  return [{ iteration: 1, tool: 'SendUserFile', params: {}, result: { success: true, file: filePath }, elapsed: 1 }];
}

/**
 * 一个真实存在的小文件,供 stat / 投递用。
 *
 * 落在 os.tmpdir 而不是 KHYOS_HOME:KHYOS_HOME 就是 getBaseHome(),而那是
 * ilinkDeliveryGuard 的禁发目录(凭据/数据家)。把夹具写进去等于让本套件在测
 * 「投递被守卫拒绝」,而它要测的是草稿批准语义。
 */
function tmpFile(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilinkdraft-file-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

const msg = (userId, text) => ({ userId, channelId: userId, threadId: '', text });

// ── (a) 默认态:正文与文件一个都不外发,out 里只有预览 ────────────────────────

test('草稿态:一轮跑完只发预览,正文与文件都不外发', async () => {
  const file = tmpFile('notes.txt', 'hello');
  const { d, channel } = mkDispatcher(() => ({ finalResponse: '私密正文A', toolCallLog: fileLog(file) }));
  await d.handle(msg('uA', '帮我总结'));

  const texts = channel.calls.filter((c) => c.startsWith('text:'));
  assert.ok(
    !texts.some((c) => c === 'text:私密正文A'),
    `草稿未批准前正文不得外发,实际 out:${JSON.stringify(channel.calls)}`,
  );
  assert.ok(
    !channel.calls.some((c) => c.startsWith('file:')),
    `草稿未批准前文件不得外发,实际 out:${JSON.stringify(channel.calls)}`,
  );
  const preview = texts.join('\n');
  assert.match(preview, /【草稿】/, 'out 里应当只有草稿预览');
  assert.match(preview, /私密正文A/, '预览必须让人看得懂内容才能批准');
  assert.match(preview, /notes\.txt/, '预览必须列出待发文件名');
  assert.ok(
    !preview.includes(path.dirname(file)),
    `预览不得回显本地绝对路径(多 peer 场景下路径本身就是信息):${preview}`,
  );
});

test('草稿态:长正文按上限截断并标注全文字数', async () => {
  const body = 'x'.repeat(1200);
  const { d, channel } = mkDispatcher(() => ({ finalResponse: body, toolCallLog: [] }));
  await d.handle(msg('uA', '长文'));
  const preview = channel.calls.join('\n');
  assert.match(preview, /…\(全文 1200 字\)/);
});

// ── (b)(c) 不阻塞 + typing 不悬挂 ───────────────────────────────────────────

test('草稿不阻塞:待批期间再投一条普通消息,第二轮照常跑完', async () => {
  const { d, prompts } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', '第一问'));
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 1, '第一轮应留下一条待批草稿');
  await d.handle(msg('uA', '第二问'));
  assert.deepStrictEqual(prompts, ['第一问', '第二问'], '待批不得挡住下一轮');
  assert.strictEqual(d.toJSON().running, false, '_running 必须已释放');
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 2, '两条都压在待批里');
});

test('草稿不阻塞:typing 不会因为等批准而一直挂着', async () => {
  const { d, channel } = mkDispatcher(() => '答');
  await d.handle(msg('uA', '问题'));
  assert.strictEqual(channel.typing[channel.typing.length - 1], false, 'turn 结束即停 typing');
});

// ── (d)(g) 批准/丢弃/改稿的投递语义 ─────────────────────────────────────────

test('回「发」:正文外发且文件排在正文之前', async () => {
  const file = tmpFile('report.md', 'r');
  const { d, channel } = mkDispatcher(() => ({ finalResponse: '私密正文A', toolCallLog: fileLog(file) }));
  await d.handle(msg('uA', '出报告'));
  await d.handle(msg('uA', '发'));

  const iFile = channel.calls.findIndex((c) => c.startsWith('file:'));
  // 找**投递**那一条:预览里也含正文,不能拿它当投递。
  const iText = channel.calls.findIndex((c) => c.startsWith('text:私密正文A'));
  assert.ok(iFile !== -1, `文件必须跟着批准一起走:${JSON.stringify(channel.calls)}`);
  assert.ok(iText !== -1, '正文必须发出去');
  assert.ok(iFile < iText, '文件必须排在正文之前(否则等于先发了最敏感的部分)');
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 0, '草稿被消费');
});

test('回「撤」:正文与文件都不外发,只回执', async () => {
  const file = tmpFile('secret.txt', 's');
  const { d, channel } = mkDispatcher(() => ({ finalResponse: '私密正文A', toolCallLog: fileLog(file) }));
  await d.handle(msg('uA', '出报告'));
  await d.handle(msg('uA', '撤'));
  // 预览里本来就有正文,所以只认「投递形态」(没有草稿抬头的那一条)。
  assert.ok(!channel.calls.some((c) => c.startsWith('text:私密正文A')), '撤稿后正文不得外发');
  assert.ok(!channel.calls.some((c) => c.startsWith('file:')), '撤稿后文件不得外发');
  assert.match(channel.calls.join('\n'), /已丢弃/);
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 0);
});

test('回「改 X」:旧稿不外发,新稿重新进预览', async () => {
  const { d, channel, prompts } = mkDispatcher(() => '旧正文');
  await d.handle(msg('uA', '起草'));
  await d.handle(msg('uA', '改 新正文'));
  assert.ok(!channel.calls.some((c) => c.includes('旧正文') && !c.includes('【草稿】')),
    '旧稿绝不外发');
  assert.match(channel.calls.join('\n'), /新正文/, '新正文应出现在新预览里');
  assert.strictEqual(prompts.length, 1, '「改」是审批,不得进 agent');
  assert.strictEqual(d._draftQueue.pending('uA').text, '新正文', '新稿必须是队首,否则批的还是旧的');
});

// ── (e) 作者绑定(本轮最关键的洞)────────────────────────────────────────────

test('作者绑定:B 的「发」既不消费 A 的草稿,也不被吞掉', async () => {
  const fileA = tmpFile('a-private.txt', 'A');
  const { d, channel, prompts } = mkDispatcher((p) => ({
    finalResponse: p === 'A 的问题' ? 'A的私密正文' : `答:${p}`,
    toolCallLog: p === 'A 的问题' ? fileLog(fileA) : [],
  }));
  await d.handle(msg('uA', 'A 的问题'));
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 1);

  await d.handle(msg('uB', '发'));

  // (i) A 的草稿纹丝不动
  assert.strictEqual(d._draftQueue.pending('uA').text, 'A的私密正文', 'B 无权消费 A 的草稿');
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 1);
  // B 自己那条进了 agent → 于是 B 名下多出来的是**B 自己的**新草稿,不是 A 的内容
  assert.strictEqual(d._draftQueue.pending('uB').text, '答:发');
  // (iii) A 的内容一个字节都没外发(预览里本来就含正文,只看投递形态)
  assert.ok(!channel.calls.some((c) => c === 'text:A的私密正文'), 'A 的正文不得外发');
  assert.ok(!channel.calls.some((c) => c.startsWith('file:')), 'A 的文件不得外发');
  // (ii) B 的「发」必须进 agent —— 否则就是凭空制造一个「消息消失」的洞
  assert.deepStrictEqual(prompts, ['A 的问题', '发'], 'B 的「发」要当普通 prompt 交给 agent');
});

test('作者绑定:B 的「撤」「改 …」同样不吃 A 的草稿,自己那条照常进 agent', async () => {
  for (const word of ['撤', '改 借你一用']) {
    const { d, prompts } = mkDispatcher(() => 'A的私密正文');
    await d.handle(msg('uA', 'A 的问题'));
    await d.handle(msg('uB', word));
    assert.strictEqual(d._draftQueue.pendingCount('uA'), 1, `${word} 不得消费 A 的草稿`);
    assert.deepStrictEqual(prompts, ['A 的问题', word], `${word} 必须 fall through 给 agent`);
  }
});

test('作者绑定:A 自己回「发」只投递 A 的草稿,B 的队列不受影响', async () => {
  const { d, channel } = mkDispatcher((p) => (p === 'B 的问题' ? 'B的正文' : 'A的正文'));
  await d.handle(msg('uA', 'A 的问题'));
  await d.handle(msg('uB', 'B 的问题'));
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 1);
  assert.strictEqual(d._draftQueue.pendingCount('uB'), 1);

  await d.handle(msg('uA', '发'));
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 0, 'A 的草稿被消费');
  assert.strictEqual(d._draftQueue.pending('uB').text, 'B的正文', 'B 的草稿不受影响');
  const texts = channel.calls.filter((c) => c.startsWith('text:'));
  assert.ok(texts.some((c) => c.includes('A的正文')), 'A 的正文投递');
  assert.ok(!texts.some((c) => c.includes('B的正文') && !c.includes('【草稿】')), 'B 的正文仍不得外发');
});

test('作者绑定:FIFO 只在同发送者内部排', async () => {
  const { d } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', '一'));
  await d.handle(msg('uA', '二'));
  assert.strictEqual(d._draftQueue.pending('uA').text, '答:一', '同发送者内部仍是 FIFO');
});

// ── (h) 超时不自动发 + 迟到答复不进 agent + 不踩权限的宽限窗口 ───────────────

test('草稿过期:不自动发送,并回执「未发送」', async () => {
  const { d, channel, prompts } = mkExpiringDispatcher(() => '私密正文');
  await d.handle(msg('uA', '问题'));
  await sleep(220);
  // 任意一条入站都会触发清扫(不发指令只是懒得选)
  await d.handle(msg('uA', '在吗'));
  assert.ok(!channel.calls.some((c) => c.includes('私密正文') && !c.includes('【草稿】')), '过期绝不自动发');
  assert.match(channel.calls.join('\n'), /已过期\(未发送\)/, '必须明确回执过期且未发送');
  assert.ok(prompts.includes('在吗'), '过期的只是草稿,agent 仍要能继续干活');
});

test('迟到的「发」:不进 agent,回执已过期', async () => {
  const { d, channel, prompts } = mkExpiringDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', '问题'));
  await sleep(220);
  // 用 /ping 触发清扫:它是即时命令,不跑 agent,所以不会顺手压出一条新草稿
  // —— 此时 A 名下确实「一条待批都没有」,迟到的「发」才是迟到。
  await d.handle(msg('uA', '/ping'));
  const before = prompts.length;
  await d.handle(msg('uA', '发'));
  assert.strictEqual(prompts.length, before, '迟到的「发」不得被当成新 prompt 丢给模型');
  assert.ok(!channel.calls.some((c) => c.includes('已发出')), '过期草稿不得被补发');
});

test('迟到宽限也带作者判定:别人的「发」照常进 agent', async () => {
  const { d, prompts } = mkExpiringDispatcher(() => '私密正文');
  await d.handle(msg('uA', 'A 的问题'));
  await sleep(220);
  await d.handle(msg('uA', '在吗'));
  const before = prompts.length;
  await d.handle(msg('uB', '发'));
  assert.strictEqual(prompts.length, before + 1, 'B 的「发」不能被 A 的宽限窗口吞掉');
});

test('迟到宽限不得吞掉**新**草稿的批准(有活草稿时不进过期分支)', async () => {
  const { d, prompts } = mkExpiringDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', 'A 的问题'));
  await sleep(220);
  await d.handle(msg('uA', '再问一个')); // 触发清扫:旧草稿过期 → 开宽限窗口;这一轮又压了新草稿
  assert.ok(d._draftGraceUntil > 0, '旧草稿过期开了宽限窗口');
  const before = prompts.length;
  await d.handle(msg('uA', '发'));
  assert.strictEqual(prompts.length, before, '活草稿的批准必须走投递分支,不能被旧窗口当成迟到');
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 0, '新草稿被消费');
});

test('草稿过期不得踩掉权限的宽限窗口(迟到的 y 仍被吞)', async () => {
  const { d, prompts } = mkExpiringDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', 'A 的问题'));
  // 走一次真实的权限超时:60ms 后自动拒绝,并进入 _graceUntil 宽限期
  d._askPermission(msg('uA', 'A 的问题'), { toolName: 'Bash', params: { command: 'rm x' } });
  await sleep(120);
  assert.ok(d._graceUntil > 0, '权限超时后应有宽限窗口');
  await sleep(200);
  await d.handle(msg('uA', '在吗')); // 触发草稿清扫(草稿 TTL 150ms,此时已过期)
  assert.strictEqual(d._draftQueue.pending('uA').text, '答:在吗', '旧草稿已被清掉,只剩这一轮的新稿');
  assert.ok(d._draftGraceUntil > 0, '草稿过期开的是**草稿自己的**宽限窗口');

  const before = prompts.length;
  await d.handle(msg('uA', 'y'));
  assert.strictEqual(prompts.length, before, '权限的迟到 y 必须仍被吞掉(证明 _graceUntil 没被草稿清零)');
  assert.strictEqual(d._graceUntil, 0, '权限宽限窗口被消费');
});

// ── (i) 诊断面 ─────────────────────────────────────────────────────────────

test('诊断面:草稿待批时 toJSON 与 /queue 都看得见', async () => {
  const { d, channel } = mkDispatcher(() => '私密正文');
  await d.handle(msg('uA', '问题'));
  const j = d.toJSON();
  assert.strictEqual(j.pendingDrafts, 1);
  assert.deepStrictEqual(j.draftOwners, ['uA']);

  await d.handle(msg('uA', '/queue'));
  const q = channel.calls.join('\n');
  assert.match(q, /草稿/, '/queue 必须报待批草稿');
  assert.match(q, /uA/, '/queue 必须报发送者');
});

test('诊断面:0 条草稿时 /queue 不提「草稿」(不制造噪音)', async () => {
  const { d, channel } = mkDispatcher(() => '私密正文');
  await d.handle(msg('uA', '/queue'));
  assert.ok(!/草稿/.test(channel.calls.join('\n')), '没有草稿时不该报草稿位');
});

test('诊断面:/wx 含草稿数与准入档位', async () => {
  const { d, channel } = mkDispatcher(() => '私密正文');
  await d.handle(msg('uA', '问题'));
  const before = channel.calls.length; // 只看 /wx 自己的那条,别把先前的预览算进来
  await d.handle(msg('uA', '/wx'));
  const out = channel.calls.slice(before).join('\n');
  assert.match(out, /草稿:1 条待批/, '/wx 必须报待批条数');
  assert.match(out, /待批发送者:uA/);
  assert.match(out, /发送者准入:/, '/wx 必须带准入档位');
  assert.ok(!out.includes('私密正文'), '/wx 不得回显草稿正文');
});

test('诊断面:/draft 报当前档位,并能按发送者切直发', async () => {
  const { d, channel } = mkDispatcher(() => '私密正文');
  await d.handle(msg('uA', '/draft'));
  assert.match(channel.calls.join('\n'), /草稿档位:逐条批准\(草稿态\)/);

  await d.handle(msg('uB', '/draft off'));
  assert.ok(d._draftDirectUsers.has('uB'), '/draft off 只作用于发命令的那个人');
  assert.ok(!d._draftDirectUsers.has('uA'), 'A 不受影响');

  await d.handle(msg('uB', '直接问'));
  assert.ok(channel.calls.some((c) => c.includes('私密正文')), '直发档下回复直接外发');
});

test('诊断面:/clear 顺带清掉待批草稿', async () => {
  const { d } = mkDispatcher(() => '私密正文');
  await d.handle(msg('uA', '问题'));
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 1);
  await d.handle(msg('uA', '/clear'));
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 0, '/clear 后不得还有草稿能发出去');
});

// ── (i½) /clear 的作用域:只清发起者自己的桶 ─────────────────────────────────

test('/clear 只清发起者自己的桶:uB 的待批草稿原样留着', async () => {
  const { d } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', 'A 的问题'));
  await d.handle(msg('uB', 'B 的问题'));
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 1);
  assert.strictEqual(d._draftQueue.pendingCount('uB'), 1);

  await d.handle(msg('uA', '/clear'));

  assert.strictEqual(d._draftQueue.pendingCount('uA'), 0, '发起者自己的草稿必须清掉');
  assert.strictEqual(d._draftQueue.pendingCount('uB'), 1, '别人的草稿不得被 /clear 带走');
  assert.strictEqual(
    d._draftQueue.pending('uB').text,
    '答:B 的问题',
    'B 的草稿内容必须逐字不动 —— 静默清空等于既没提示又永久丢失',
  );
});

test('/clear 回执按实际条数说话,且不带别人的标识符', async () => {
  const { d, channel } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', 'A 一'));
  await d.handle(msg('uA', 'A 二'));
  await d.handle(msg('uB', 'B 的问题'));
  // 本文件顶部把 TTL 压到 150ms(过期用例要用)。整套并行跑时机器更慢,这几条
  // 草稿可能在断言落地前就被清扫掉 —— 那时"清了 2 条"照样是对着空气的断言。
  // 所以先读此刻 uA 名下的实际条数,再让回执对上它:这条用例要验的是
  // 「回执按实际条数说话」,不是「此刻恰好有两条」。
  const mine = d._draftQueue.pendingCount('uA');
  assert.ok(mine >= 1, `uA 名下至少要留下一条草稿,实际 ${mine}`);
  const before = channel.calls.length;
  await d.handle(msg('uA', '/clear'));
  const receipt = channel.calls.slice(before).join('\n');
  assert.match(
    receipt,
    new RegExp(`你的待批草稿清了 ${mine} 条\\(未发送\\)`),
    `回执必须报实际清掉的条数,实际 ${receipt}`,
  );
  assert.ok(!receipt.includes('uB'), `回执不得泄露他人标识符:${receipt}`);
});

test('/clear 在发起者名下没有草稿时不得声称清掉了草稿', async () => {
  const { d, channel } = mkDispatcher(() => '私密正文');
  const before = channel.calls.length;
  await d.handle(msg('uA', '/clear'));
  const receipt = channel.calls.slice(before).join('\n');
  assert.ok(!/清了\s*\d+\s*条/.test(receipt), `没草稿就不该声称清掉了:${receipt}`);
  assert.match(receipt, /你名下没有待批草稿/, '要如实说「本来就没有」');
});

test('/clear 清的是全账号共享的排队队列:回执说清影响面,并留结构化 warn', async () => {
  const { d, channel } = mkDispatcher(() => '私密正文');
  // 白盒塞一条排队的入站:串行队列只在「上一条还在跑」时才会自然堆积,离线夹具里
  // 复现那个时序不稳,而被丢的是谁、有没有被丢,正是这条要钉的事实。
  d._queue.push(msg('uB', 'B 排队的私密提问'));

  const warns = [];
  const prevWarn = log.warn;
  log.warn = (m, meta) => { warns.push({ m, meta }); };
  const before = channel.calls.length;
  try {
    await d.handle(msg('uA', '/clear'));
  } finally {
    log.warn = prevWarn;
  }

  const receipt = channel.calls.slice(before).join('\n');
  assert.match(receipt, /排队队列是全账号共享的/, '回执必须说清排队队列对谁生效(规则 2.2 不泛指)');
  assert.match(receipt, /含他人排队的消息/);
  assert.strictEqual(warns.length, 1, '被丢的消息必须留痕,否则事后查不出谁被吞');
  assert.deepStrictEqual(warns[0].meta.senders, ['uB'], 'warn 带上受影响者的 id');
  assert.strictEqual(warns[0].meta.clearedBy, 'uA');
  assert.ok(
    !JSON.stringify(warns[0].meta).includes('私密提问'),
    'warn 只带标识符,不带消息正文',
  );
  assert.strictEqual(d._queue.length, 0);
});

test('/clear 不开迟到宽限窗口:迟到的「发」照常进 agent', async () => {
  const { d, prompts } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', '问题'));
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 1, '前提:草稿还活着,没被过期清扫带走');
  await d.handle(msg('uA', '/clear'));
  assert.strictEqual(
    d._draftGraceUntil,
    0,
    '显式 /clear 不开宽限窗口(只有 expire 路径开)—— 用户已拿到回执,不必再吞他一次',
  );
  const before = prompts.length;
  await d.handle(msg('uA', '发'));
  assert.strictEqual(prompts.length, before + 1, '迟到的「发」按普通提问走,不被静默吞掉');
});

// ── (i¾) 诊断面的隔离:/queue 与 /wx 只报提问者自己的草稿 ────────────────────
//
// 复核员实测:uA 发 /wx,收到「2 条草稿待你批准(发送者:uB/uC)」—— 把同 bot 其他人的
// 标识符报给了当前这个发送者。草稿正文从没泄露过,但「谁还在用这个 bot」本身也是信息。

test('诊断面隔离:uA 的 /queue 不含 uB 的标识符', async () => {
  const { d, channel } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', 'A 的问题'));
  await d.handle(msg('uB', 'B 的问题'));
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 1, '前提:两人各有一条待批草稿');
  assert.strictEqual(d._draftQueue.pendingCount('uB'), 1);

  const before = channel.calls.length;
  await d.handle(msg('uA', '/queue'));
  const out = channel.calls.slice(before).join('\n');

  assert.match(out, /1 条草稿待你批准/, 'A 必须仍看得见自己的草稿(别把功能改没了)');
  assert.ok(!out.includes('uB'), `/queue 不得泄露他人标识符:${out}`);
  assert.ok(!out.includes('答:B 的问题'), '/queue 不得泄露他人草稿正文');
});

test('诊断面隔离:uA 的 /wx 不含 uB 的标识符', async () => {
  const { d, channel } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', 'A 的问题'));
  await d.handle(msg('uB', 'B 的问题'));

  const before = channel.calls.length;
  await d.handle(msg('uA', '/wx'));
  const out = channel.calls.slice(before).join('\n');

  assert.match(out, /草稿:1 条待批/, 'A 的 /wx 必须仍报自己那一条');
  assert.match(out, /待批发送者:uA/, '作者视角下这一行恒等于「你自己」,保留是为了确认在等自己批');
  assert.ok(!out.includes('uB'), `/wx 不得泄露他人标识符:${out}`);
});

test('诊断面隔离:B 自己查时仍报自己那一条(功能没被改没)', async () => {
  const { d, channel } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', 'A 的问题'));
  await d.handle(msg('uB', 'B 的问题'));

  const before = channel.calls.length;
  await d.handle(msg('uB', '/queue'));
  const out = channel.calls.slice(before).join('\n');

  assert.match(out, /1 条草稿待你批准/, 'B 必须看得见自己的草稿');
  assert.match(out, /发送者:uB/, 'B 的那一行报的是 B');
  assert.ok(!out.includes('uA'), `B 同样看不到 A:${out}`);
});

test('诊断面隔离:名下无草稿的人提问,连草稿位都不提', async () => {
  const { d, channel } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', 'A 的问题'));
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 1, '前提:A 名下有一条待批草稿');
  // uB 从没发过问题,名下必然 0 条:这一条钉的是「别人的草稿存在也不该在他面前露头」。
  assert.strictEqual(d._draftQueue.pendingCount('uB'), 0);

  const before = channel.calls.length;
  await d.handle(msg('uB', '/queue'));
  const out = channel.calls.slice(before).join('\n');
  assert.ok(!/草稿/.test(out), `0 条时不提草稿位(不制造噪音):${out}`);
  assert.ok(!out.includes('uA'), `不得顺带泄露别人:${out}`);
});

test('诊断面隔离:漏传 userId 是 fail-closed(报 0 条,不是报全量)', async () => {
  const { d } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', 'A 的问题'));
  assert.strictEqual(d._draftQueue.pendingCount('uA'), 1);

  // 漏改的调用点会以 undefined 进 _draftStatsFor。今天无害(读到 0),
  // 但方向必须是「少报」:若哪天 _draftStatsFor 改成缺省全量,这条立刻翻红。
  const s = d._diagState(undefined);
  assert.strictEqual(s.pendingDrafts, 0, '缺省 userId 必须读成 0 条');
  assert.deepStrictEqual(s.draftOwners, [], '缺省 userId 不得列出任何发送者');
  assert.ok(!/草稿/.test(d._describeQueue()), '缺省 userId 的 /queue 不得报草稿位');
  assert.deepStrictEqual(d._draftStatsFor(undefined), { total: 0, owners: [] });
});

test('诊断面隔离:_draftStatsFor 与 stats() 同形状,且 owners 至多 1 个元素', async () => {
  const { d } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', 'A 的问题'));
  await d.handle(msg('uB', 'B 的问题'));

  const forA = d._draftStatsFor('uA');
  assert.deepStrictEqual(Object.keys(forA).sort(), ['owners', 'total'], '形状必须与 stats() 一致,诊断模块才不用改');
  assert.strictEqual(forA.total, 1, 'A 只数自己那一条(全量是 2)');
  assert.deepStrictEqual(forA.owners, ['uA']);
  assert.deepStrictEqual(d._draftStatsFor('nobody'), { total: 0, owners: [] }, '无此人的桶恒为空');
});

test('诊断面隔离:toJSON 保持全量(进程内形状,刻意不改)', async () => {
  const { d } = mkDispatcher((p) => `答:${p}`);
  await d.handle(msg('uA', 'A 的问题'));
  await d.handle(msg('uB', 'B 的问题'));

  const j = d.toJSON();
  assert.strictEqual(j.pendingDrafts, 2, 'toJSON 是进程内全量读数,不按提问者收窄');
  assert.deepStrictEqual(j.draftOwners, ['uA', 'uB'], '全量 owners 只给日志/status 条,任何用户可见文本都不许走它');
});

// ── (j) 词表零交集 ──────────────────────────────────────────────────────────

test('词表零交集:权限词表里的每个词都不是草稿答复', () => {
  for (const w of ['y', 'yes', '是', '好', '允许', '同意', 'n', 'no', '否', '不', '拒绝', '不允许']) {
    assert.strictEqual(core.parseDraftReply(w), null, `${w} 不该被当成草稿答复`);
  }
});

test('词表零交集:草稿词表里的每个词都不是权限答复', () => {
  for (const w of ['发', 'send', '发送', '确认', '撤', '取消', 'cancel', '丢弃', '放弃', '改 新内容']) {
    assert.strictEqual(core.parsePermissionReply(w), null, `${w} 不该被当成权限答复`);
  }
});

test('「改」不带新内容 → null(不得把用户的四个字节当审批吞掉)', () => {
  for (const w of ['改', '改 ', '改。']) {
    assert.strictEqual(core.parseDraftReply(w), null);
  }
});

test('「改」保留新内容的大小写(不得替他改要发的话)', () => {
  assert.deepStrictEqual(core.parseDraftReply('改 Deploy to Prod'), { edit: 'Deploy to Prod' });
  assert.deepStrictEqual(core.parseDraftReply('改：确认已上线 OK'), { edit: '确认已上线 OK' });
});

// ── (k)(l) 逃生阀 ──────────────────────────────────────────────────────────

test('image_generate 的占位语随档位变:草稿态不得说「已发送」', async () => {
  const img = '/tmp/khyimg_generated.png';
  const logArr = [{ tool: 'image_generate', result: { success: true, meta: { paths: [img] } } }];
  const mk = () => mkDispatcher(() => ({ finalResponse: `图片在 ${img}`, toolCallLog: logArr }));
  const a = mk();
  await a.d.handle(msg('uA', '画个图'));
  assert.match(a.channel.calls.join('\n'), /图片待你批准后发送/, '草稿态图还没发,不得说已发送');

  const prev = defaults.ILINK_DRAFT_CONFIRM;
  defaults.ILINK_DRAFT_CONFIRM = false;
  try {
    const b = mk();
    await b.d.handle(msg('uA', '画个图'));
    assert.match(b.channel.calls.join('\n'), /（图片已发送）/, '直发档沿用原措辞');
  } finally {
    defaults.ILINK_DRAFT_CONFIRM = prev;
  }
});

test('KHY_ILINK_DRAFT_CONFIRM=0 → 逐字节回到「正文直接外发」', () => {
  const prev = defaults.ILINK_DRAFT_CONFIRM;
  defaults.ILINK_DRAFT_CONFIRM = false;
  try {
    const { d } = mkDispatcher(() => 'ok');
    assert.strictEqual(d._draftQueue, null, '关掉时不得留一个空队列假装还在拦');
    assert.strictEqual(d._draftActiveFor('uA'), false);
  } finally {
    defaults.ILINK_DRAFT_CONFIRM = prev;
  }
  const { d: d2 } = mkDispatcher(() => 'ok');
  assert.ok(d2._draftQueue, '默认档必须有队列');
  assert.strictEqual(d2._draftActiveFor('uA'), true);
});

test('KHY_ILINK_DRAFT_CONFIRM=0 直发路径:正文与文件都直接外发', async () => {
  const prev = defaults.ILINK_DRAFT_CONFIRM;
  defaults.ILINK_DRAFT_CONFIRM = false;
  try {
    const file = tmpFile('direct.txt', 'd');
    const { d, channel } = mkDispatcher(() => ({ finalResponse: '直发正文', toolCallLog: fileLog(file) }));
    await d.handle(msg('uA', '问题'));
    assert.ok(channel.calls.some((c) => c.includes('直发正文')), '直发档必须把正文发出去');
    assert.ok(channel.calls.some((c) => c.startsWith('file:')), '直发档必须把文件发出去');
    assert.ok(!channel.calls.some((c) => c.includes('【草稿】')));
  } finally {
    defaults.ILINK_DRAFT_CONFIRM = prev;
  }
});

test('parseBoolean 的打错值走 fallback(不开草稿才是危险档)', () => {
  assert.strictEqual(parseBoolean('maybe', true, { extended: false }), true);
  assert.strictEqual(parseBoolean('y', true, { extended: false }), true, '单字母不翻转闸门');
  assert.strictEqual(parseBoolean('0', true, { extended: false }), false, '逃生阀必须能开');
});

// ── 队列本身:分桶与上限 ────────────────────────────────────────────────────

test('ReplyDraftQueue:分桶隔离 + 上限丢最旧', () => {
  const q = new ReplyDraftQueue({ ttlMs: 1000, max: 3 });
  for (const t of ['a1', 'a2', 'a3', 'a4']) {
    q.push('uA', { msg: { userId: 'uA' }, text: t, preview: t });
  }
  assert.strictEqual(q.pendingCount('uA'), 3);
  assert.strictEqual(q.pending('uA').text, 'a2', '超上限丢最旧');
  assert.strictEqual(q.pending('uB'), null, '别的发送者一条都没有');
  assert.deepStrictEqual(q.stats(), { total: 3, owners: ['uA'] });
  assert.strictEqual(JSON.stringify(q.stats()).includes('a2'), false, '诊断读数不含草稿正文');
});

test('ReplyDraftQueue:超上限时把被丢的那条交回给调用方告知', () => {
  const q = new ReplyDraftQueue({ ttlMs: 1000, max: 1 });
  q.push('uA', { msg: { userId: 'uA' }, text: 'old', preview: 'old' });
  const r = q.push('uA', { msg: { userId: 'uA' }, text: 'new', preview: 'new' });
  assert.strictEqual(r.dropped.text, 'old', '被丢的必须是旧稿,且要能告知用户');
});

test('ReplyDraftQueue:expire 只清不送', () => {
  const q = new ReplyDraftQueue({ ttlMs: 10, max: 3 });
  q.push('uA', { msg: { userId: 'uA' }, text: 'x', preview: 'x' });
  const expired = q.expire(Date.now() + 20);
  assert.strictEqual(expired.length, 1);
  assert.strictEqual(q.pending('uA'), null);
});

test('ReplyDraftQueue:clear 只清该发送者的桶,别人的草稿与总计数不受牵连', () => {
  const q = new ReplyDraftQueue({ ttlMs: 1000, max: 3 });
  q.push('uA', { msg: { userId: 'uA' }, text: 'a1', preview: 'a1' });
  q.push('uA', { msg: { userId: 'uA' }, text: 'a2', preview: 'a2' });
  q.push('uB', { msg: { userId: 'uB' }, text: 'b1', preview: 'b1' });
  assert.deepStrictEqual(q.stats(), { total: 3, owners: ['uA', 'uB'] });

  assert.strictEqual(q.clear('uA'), 2, '返回实际清掉的条数,好让回执说真话');
  assert.strictEqual(q.pending('uA'), null);
  assert.strictEqual(q.pending('uB').text, 'b1', 'B 的草稿必须原样留着');
  assert.deepStrictEqual(q.stats(), { total: 1, owners: ['uB'] }, '总计数只减发起者的量');
  assert.strictEqual(q.clear('uA'), 0, '没有草稿就返回 0,不得编造条数');
  assert.strictEqual(q.pending('uB').text, 'b1');
});
