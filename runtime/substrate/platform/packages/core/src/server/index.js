'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { z } = require('zod');

const { CoreError } = require('../contracts/errors');
const {
  CORE_PROTOCOL_VERSION,
  CoreHealthResponseSchema,
} = require('../contracts/health');
const {
  CoreLockRecordSchema,
  HelloRequestSchema,
  HelloResponseSchema,
} = require('../contracts/schemas/core-handle.schema');
const { DEFAULT_BIND_HOST } = require('../contracts/core-env');
const { createSecurityKernel } = require('./securityKernel');

// S4-minimal（[DESIGN-ARCH-220] §12 S4 / §4.3 / §4.5）：core server 真起 HTTP，
// /core/hello 与 /core/health 两个帧用契约 schema 校验；六成员由宿主注入——
// core 永不 import backend，网关实现经 B1 的 createGateway() 由宿主传进来。
const MEMBER_KEYS = ['gateway', 'events', 'storage', 'session', 'capabilities', 'plugins'];
const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const CreateCoreServerOptionsSchema = z.object({
  dataHome: z.string().min(1).nullable(),
  bindHost: z.string().min(1).optional(),
  lock: CoreLockRecordSchema.optional(),
  // 宿主注入的成员实现。缺谁的键，谁的调用就如实报 member-pending，不假装可用。
  members: z.record(z.unknown()).optional(),
  coreVersion: z.string().min(1).optional(),
  enginesKhy: z.string().min(1).optional(),
  security: z.custom((value) => value !== null && typeof value === 'object').optional(),
});

function pendingMember(label) {
  const notYet = async () => {
    throw new CoreError(
      'CORE_UNAVAILABLE',
      `${label} 成员通道未接线：该成员随 S5 逐块迁移，当前仅完成发现、握手与已注入成员`,
      { retryable: false, details: { reason: 'member-pending', member: label } },
    );
  };
  return new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? notYet : undefined) });
}

// 六成员状态：注入了 = available，没注入 = missing（required 缺失在装配期报缺谁）。
// 注入与否用独立映射记，不往 Proxy 上挂标志——Proxy 的 get 陷阱会把它吞掉。
async function memberStates(members, injected) {
  const states = [];
  for (const key of MEMBER_KEYS) {
    states.push({ id: key, state: injected[key] ? 'available' : 'missing', version: '1' });
  }
  let extra = [];
  try {
    const listed = await members.capabilities.list();
    if (Array.isArray(listed)) extra = listed;
  } catch (_) {
    // capabilities 成员未注入时六成员状态已足够表达，不额外报错。
  }
  return states.concat(extra);
}

function createCoreServer(options) {
  let opts;
  try {
    opts = CreateCoreServerOptionsSchema.parse(options);
  } catch (err) {
    const issues = err.issues ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : [String(err)];
    throw new CoreError('CORE_INVALID_ARGUMENT', `createCoreServer 参数不合法：${issues.join('；')}，按 CreateCoreServerOptionsSchema 修正`, {
      retryable: false,
      details: { issues },
    });
  }

  const members = {};
  const injected = {};
  for (const key of MEMBER_KEYS) {
    const impl = opts.members && opts.members[key];
    injected[key] = !!impl;
    members[key] = impl || pendingMember(key);
  }

  const coreId = opts.lock ? opts.lock.coreId : `core-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const epoch = opts.lock ? opts.lock.epoch : 0;
  const coreVersion = opts.coreVersion || '0.1.0';
  const enginesKhy = opts.enginesKhy || '>=1.0.0 <2.0.0';
  const startedAt = Date.now();
  const bindHost = opts.bindHost || DEFAULT_BIND_HOST;

  let httpServer = null;
  let security = null;
  let started = false;
  let closing;
  let port = 0;

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  }

  function sendCoreError(res, status, code, message, details) {
    sendJson(res, status, { code, message, retryable: false, details: details || undefined });
  }

  async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function handleHello(req, res) {
    let request;
    try {
      request = HelloRequestSchema.parse(await readJsonBody(req));
    } catch (err) {
      const issues = err.issues ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : [String(err)];
      sendCoreError(res, 400, 'CORE_INVALID_ARGUMENT', `hello 帧不合法：${issues.join('；')}`, { issues });
      return;
    }
    if (request.protocolVersion !== CORE_PROTOCOL_VERSION) {
      sendCoreError(
        res,
        400,
        'CORE_PROTOCOL_MISMATCH',
        `客户端 protocolVersion=${request.protocolVersion}，核心要求 ${CORE_PROTOCOL_VERSION}：协议版本必须相等才可连接`,
        { coreProtocol: CORE_PROTOCOL_VERSION },
      );
      return;
    }
    const response = HelloResponseSchema.parse({
      coreId,
      coreVersion,
      protocolVersion: CORE_PROTOCOL_VERSION,
      enginesKhy,
      epoch,
      capabilities: await memberStates(members, injected),
      paths: opts.dataHome ? { dataHome: opts.dataHome } : {},
      sessionToken: crypto.randomBytes(24).toString('hex'),
      expiresAt: Date.now() + SESSION_TOKEN_TTL_MS,
    });
    sendJson(res, 200, response);
  }

  async function handleHealth(_req, res) {
    const health = CoreHealthResponseSchema.parse({
      status: 'ok',
      coreId,
      protocolVersion: CORE_PROTOCOL_VERSION,
      pid: process.pid,
      port,
      epoch,
      coreVersion,
      uptimeMs: Date.now() - startedAt,
      capabilities: await memberStates(members, injected),
    });
    sendJson(res, 200, health);
  }

  const server = {
    coreId,
    protocolVersion: CORE_PROTOCOL_VERSION,
    members,
    get security() { return security; },
    getPort: () => port,
    async start() {
      if (started || closing) throw new CoreError('CORE_INVALID_ARGUMENT', '核心服务不能重复启动：请新建服务实例');
      started = true;
      try {
        if (opts.security) security = createSecurityKernel(opts.security);
      httpServer = http.createServer((req, res) => {
        const url = String(req.url || '').split('?')[0];
        if (req.method === 'POST' && url === '/core/hello') {
          handleHello(req, res).catch((err) =>
            sendCoreError(res, 500, 'CORE_INTERNAL', `hello 处理失败：${err && err.message}`, { reason: String(err && err.code) }),
          );
          return;
        }
        if (req.method === 'GET' && url === '/core/health') {
          handleHealth(req, res).catch((err) =>
            sendCoreError(res, 500, 'CORE_INTERNAL', `health 处理失败：${err && err.message}`, { reason: String(err && err.code) }),
          );
          return;
        }
        sendCoreError(res, 404, 'CORE_INVALID_ARGUMENT', `未知端点 ${req.method} ${url}：当前只暴露 /core/hello 与 /core/health`);
      });
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        // 仅绑 loopback：远程接入的鉴权与 LAN 发现随 attached 模式落地（[DESIGN-ARCH-220] §4.3）。
        httpServer.listen(0, bindHost, () => resolve());
      });
      port = httpServer.address().port;
      } catch (error) {
        try { await server.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], '核心启动失败且清理未完成'); }
        throw error;
      }
    },
    close() {
      if (closing) return closing;
      const stopSecurity = security ? security.close() : Promise.resolve();
      const stopHttp = httpServer ? new Promise((resolve) => httpServer.close(() => resolve())) : Promise.resolve();
      closing = Promise.allSettled([stopSecurity, stopHttp]).then((results) => {
        httpServer = null;
        port = 0;
        const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, '核心关闭未完成：请核查安全存储');
      });
      return closing;
    },
  };
  return server;
}

module.exports = {
  createCoreServer, CORE_PROTOCOL_VERSION, MEMBER_KEYS,
  createActionAuthority: require('./actionAuthority').createActionAuthority,
  createMatrixPolicy: require('./matrixPolicy').createMatrixPolicy,
  createMatrixStore: require('./matrixStore').createMatrixStore,
  createSecurityAudit: require('./securityAudit').createSecurityAudit,
};
