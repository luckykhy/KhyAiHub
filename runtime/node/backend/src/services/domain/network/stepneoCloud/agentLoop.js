'use strict';

/**
 * stepneoCloud/agentLoop.js — drive the cloud model against the phone's device
 * tools (the tool-calling loop).
 *
 * WHAT THIS REPLACES. The Android bridge's AmooLoop drives Amoo by scraping its
 * chat bubbles through the accessibility service: one turn costs minutes, needs
 * the app foregrounded, and StepOS freezes the process the moment it is not.
 * This loop keeps the same device tools but moves the reasoning to the cloud
 * gateway, where a tool call is a tool call — no screen scraping, no foreground
 * requirement, no per-turn minute-scale latency.
 *
 * WHAT IT MUST NOT BECOME. The tools it can reach include exec, write and rm.
 * The safety contract therefore lives in the bridge, not here:
 *
 *   · every call goes through phoneBridgeClient.call(), which runs
 *     classifyBridgeCall() and planBridgeCall() first — an actuating tool
 *     without confirm:true is REFUSED, not executed;
 *   · the bridge's session budget (bytes / entries / copies) accumulates across
 *     every call in this loop and is never reset per round, so a model cannot
 *     defeat it by asking for the same file 200 times;
 *   · the loop caps its own rounds so a model that keeps calling tools cannot
 *     run forever.
 *
 * This module adds no policy of its own on purpose. A second policy layer here
 * would drift from the bridge's, and the bridge is the one that actually holds
 * the device.
 */

const { createToolNameResolver } = require('./toolSchemas');

/** Hard cap on tool-calling rounds in one turn. */
const DEFAULT_MAX_ROUNDS = 24;

/**
 * The system prompt for one turn.
 *
 * WHY THERE IS ONE. Without it the model answers from its reply text. Measured
 * on device: asked to write a game, it began emitting the entire HTML file as
 * its reply, exhausted the token budget, and returned HTTP 200 with an empty
 * body — because nothing had told it that writing a file is a TOOL CALL, not a
 * thing you say.
 *
 * It is a parameter, not a constant, so a caller can replace it. It is prepended
 * only when the conversation has no system message already.
 */
const DEFAULT_SYSTEM_PROMPT = [
  '你是一个能在用户手机上执行操作的智能体。',
  '',
  '你能通过工具直接在手机上做事：读写文件、执行 shell 命令、启动应用、操作界面。',
  '要做一件事就用对应的工具去做，不要把文件内容、命令输出或代码写在回复里——',
  '回复是给人看的结论，工具才是真正落地动作的地方。',
  '',
  '会改变手机状态的工具（write/exec/rm/mv/cp/mkdir/启动应用/界面点击等）需要显式传',
  ' confirm:true 才会真正执行；不传只会返回将要执行的内容。用户已经授权本次任务范围，',
  '在范围内该确认就确认，不要因为反复试探同一个工具而浪费轮次。',
  '',
  '默认用中文回复。',
].join('\n');

/**
 * Run one agent turn to completion.
 *
 * @param {object} deps
 * @param {object} deps.upstream must expose chatCompletion({messages, tools}) and
 *   return {ok:true, message} or {ok:false, error}
 * @param {object} deps.bridge the phone bridge client (call(tool,args,opts))
 * @param {string[]} deps.messages the conversation so far (mutated: appended to)
 * @param {boolean} [deps.includeUi] whether to advertise UI tools
 * @param {number} [deps.maxRounds]
 * @param {(line: string) => void} [deps.onProgress]
 * @returns {Promise<{ok: boolean, message?: object, error?: string, rounds: number,
 *   toolCalls: Array<{name: string, ok: boolean}>, stopped?: string}>}
 */
async function runAgentTurn({
  upstream,
  bridge,
  messages,
  includeUi = true,
  maxRounds = DEFAULT_MAX_ROUNDS,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  onProgress = () => {},
  resolveToolName = createToolNameResolver(),
}) {
  if (!upstream || typeof upstream.chatCompletion !== 'function') {
    return { ok: false, error: 'agentLoop: upstream.chatCompletion 未提供', rounds: 0, toolCalls: [] };
  }
  if (!bridge || typeof bridge.call !== 'function') {
    return { ok: false, error: 'agentLoop: bridge.call 未提供', rounds: 0, toolCalls: [] };
  }

  const { buildToolSchemas } = require('./toolSchemas');
  const tools = buildToolSchemas({ includeUi });

  // The system prompt goes in only when the caller has not supplied one, so a
  // conversation that already carries its own instructions is not overridden.
  if (systemPrompt && !messages.some((m) => m && m.role === 'system')) {
    messages.unshift({ role: 'system', content: systemPrompt });
  }

  const toolCalls = [];
  let rounds = 0;

  for (;;) {
    if (rounds >= maxRounds) {
      // Reported as a distinct outcome, not as an error: the work done so far is
      // real and the caller should be able to see it. A model that keeps calling
      // tools is a model that has not finished, not a crashed turn.
      return {
        ok: false,
        stopped: 'max_rounds',
        error: `已达本轮工具调用上限（${maxRounds} 轮）。已完成的部分有效，但模型没有收尾。`,
        rounds,
        toolCalls,
      };
    }
    rounds += 1;

    const res = await upstream.chatCompletion({ messages, tools });
    if (!res || res.ok !== true) {
      return {
        ok: false,
        error: (res && res.error) || '上游未返回可用响应',
        rounds,
        toolCalls,
      };
    }

    const message = res.message || {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (calls.length === 0) {
      // A final answer. Recorded in the transcript so the caller can persist it.
      messages.push({ role: 'assistant', content: message.content || '' });
      return { ok: true, message, rounds, toolCalls };
    }

    // The assistant turn that asked for the tools must be in the transcript
    // BEFORE the tool results, or the upstream rejects the sequence.
    messages.push({
      role: 'assistant',
      content: message.content || '',
      tool_calls: calls,
    });

    for (const call of calls) {
      const fn = (call && call.function) || {};
      const schemaName = fn.name || '';
      const bridgeName = resolveToolName.resolve(schemaName);
      const callId = call.id || '';

      if (!bridgeName) {
        // Name the real tools instead of a bare "unknown tool". This is the same
        // failure shape as the Dart tool engine's, and the same fix: a model that
        // invented a name cannot correct itself from "not found" alone.
        const known = tools.map((t) => t.function.name);
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          content: `工具 "${schemaName}" 不存在。已注册 ${known.length} 个：${known.join('、')}。`
            + '请从这些名字里选一个，不要改用别的叫法。',
        });
        toolCalls.push({ name: schemaName, ok: false, why: '工具名不存在', code: 'unknown_tool', requiresConfirm: false });
        continue;
      }

      let args = {};
      try {
        args = fn.arguments ? JSON.parse(fn.arguments) : {};
      } catch (e) {
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          content: `工具参数不是合法 JSON：${e.message}。原样重发，参数必须是 JSON 对象。`,
        });
        toolCalls.push({ name: bridgeName, ok: false, why: '工具参数不是合法 JSON', code: 'bad_args', requiresConfirm: false });
        continue;
      }

      onProgress(`执行 ${bridgeName}`);

      // THE TRANSLATION. `confirm` is a CALL OPTION on the bridge
      // (client.call(tool, args, {confirm})), but the model's only channel is
      // the arguments object — so it necessarily puts confirm in there. The
      // schema advertises it as a property precisely so it can.
      //
      // Measured on device before this existed: the model tried to pass
      // confirm:true and got back "工具 write 不接受参数 confirm", because
      // validateBridgeArgs rejects unknown args in `args` (deliberately —
      // silently dropping an arg is how "I asked for recursive" becomes a
      // no-op). It then retried without confirm, hit the confirm gate, and
      // oscillated between the two errors until it ran out of rounds.
      //
      // So: strip confirm out of args, and hand it over as the call option the
      // bridge actually reads.
      const { confirm, ...toolArgs } = args && typeof args === 'object' ? args : {};

      // No confirm is injected here. If the model wants to actuate the phone it
      // has to ask for it explicitly, and the bridge is what decides
      // whether that request is honoured — see the header.
      const result = await bridge.call(bridgeName, toolArgs, { confirm: confirm === true });

      const ok = !!(result && result.success);
      // The refusal text, in the field the bridge actually uses.
      //
      // THE BUG THIS FIXES: the confirm gate answers with `message`, not
      // `error` — see phoneBridgeClient._confirmGate(). Reading only `error`
      // produced `"error":"桥未返回结果"` for every refusal, so the model was
      // told the bridge returned nothing when in fact it had returned a precise
      // instruction to retry with confirm:true. Measured on device: three write
      // attempts, all refused, all reported to the model as "no result" — so it
      // could not possibly have learned to pass confirm.
      //
      // `message` first, `error` second, and a generic fallback only when both
      // are genuinely absent.
      const refusalText = (result && (result.message || result.error)) || '桥未返回结果';
      // `why` is recorded, not just the boolean. A turn that reports
      // "6 tool calls, 0 succeeded" tells the caller nothing about whether the
      // bridge was unreachable, the args were rejected, or the confirm gate
      // refused — and those need three different responses. Measured on device:
      // three write attempts were refused by the confirm gate and the only
      // visible symptom was a silent non-zero success count.
      toolCalls.push({
        name: bridgeName,
        ok,
        why: ok ? null : refusalText,
        code: ok ? null : (result && result.code) || null,
        requiresConfirm: !!(result && result.requiresConfirm),
      });

      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: JSON.stringify(ok ? (result.result ?? result) : {
          ok: false,
          error: refusalText,
          code: result && result.code,
          requiresConfirm: result && result.requiresConfirm === true,
          plan: result && result.plan,
        }),
      });
    }
  }
}

module.exports = {
  DEFAULT_MAX_ROUNDS,
  runAgentTurn,
};
