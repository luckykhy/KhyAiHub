'use strict';

/**
 * index.js — star-assembly facade for the stepneoCloud unit.
 *
 * Single import point for consumers. Siblings do not require each other except
 * through here, so a consumer never reaches into signing.js or upstream.js
 * directly and the shape of this unit can change underneath it.
 *
 * No module-load side effects: no env is read, no adb is spawned, no token is
 * fetched until a caller asks. That matters because the tool module requires
 * this at discovery time, and discovery happens on every startup.
 */

const signing = require('./signing');
const accountToken = require('./accountToken');
const toolSchemas = require('./toolSchemas');
const upstream = require('./upstream');
const { runAgentTurn, DEFAULT_MAX_ROUNDS } = require('./agentLoop');
const config = require('./config');

/**
 * Build the pieces needed for one agent turn.
 *
 * `createStepneoSession` is deliberately not a singleton-builder: the token
 * changes on every renewal and the bridge client owns device connection state,
 * so both are passed in. What is assembled here is only the wiring.
 *
 * @param {object} opts
 * @param {string} opts.token account token — memory only, never persisted
 * @param {string} opts.deviceId from the token's `a` field
 * @param {string} opts.appSecret signing key, from env only
 * @param {object} opts.bridge the phone bridge client (call(tool,args,opts))
 * @param {object} [opts.env] for the default max-rounds override
 */
function createStepneoSession({
  token,
  deviceId,
  appSecret,
  bridge,
  env = process.env,
  fetchImpl,
  baseUrl,
  maxRounds,
}) {
  if (!token) throw new Error('createStepneoSession: token 必填（账号 token，仅存内存）');
  if (!deviceId) throw new Error('createStepneoSession: deviceId 必填（取自 token 的 a 字段）');
  if (!appSecret) throw new Error('createStepneoSession: appSecret 必填（只从环境变量读，不落盘）');
  if (!bridge) throw new Error('createStepneoSession: bridge 必填（手机桥客户端）');

  const resolvedMaxRounds = maxRounds
    || Number(env.STEPNEO_MAX_ROUNDS)
    || DEFAULT_MAX_ROUNDS;

  const upstreamFn = (args) => upstream.chatCompletion({
    token,
    deviceId,
    appSecret,
    messages: args.messages,
    tools: args.tools,
    fetchImpl,
    baseUrl,
  });

  return {
    maxRounds: resolvedMaxRounds,
    tools: toolSchemas.buildToolSchemas(),
    upstream: { chatCompletion: upstreamFn },
    /** Run one turn. `messages` is appended to in place. */
    run: (messages, opts = {}) => runAgentTurn({
      upstream: { chatCompletion: upstreamFn },
      bridge,
      messages,
      maxRounds: resolvedMaxRounds,
      onProgress: opts.onProgress,
      includeUi: opts.includeUi,
      includeAssistantRelay: opts.includeAssistantRelay,
    }),
  };
}

module.exports = {
  ...signing,
  ...accountToken,
  ...toolSchemas,
  ...upstream,
  ...config,
  runAgentTurn,
  DEFAULT_MAX_ROUNDS,
  createStepneoSession,
};
