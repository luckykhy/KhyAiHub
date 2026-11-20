'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const name = z.string().trim().min(1);
const names = z.array(name).refine((items) => new Set(items).size === items.length, '条目不能重复');
const absolutePath = z.string().min(1).refine((value) => path.isAbsolute(value), '数据范围必须是绝对路径');
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const capability = z.object({
  status: z.enum(['available', 'missing']),
  evidence: name,
}).strict();
const terminal = z.object({
  terminal_id: name,
  role: z.enum(['developer', 'container', 'client']),
  state: z.enum(['active', 'frozen', 'unregistered']),
  tools: names,
  denied_tools: names,
  data_scope: z.array(absolutePath),
  allowed_commands: names,
  max_tokens_per_task: tokens.positive(),
  daily_budget: tokens.positive(),
  app_capabilities: z.record(name, capability),
}).strict().refine((row) => row.daily_budget >= row.max_tokens_per_task, '日预算不能小于单任务预算');
const matrixSchema = z.object({
  version: z.literal('v1.3-khyos'),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  shared_scope: z.array(absolutePath),
  high_risk_actions: names,
  budget_policy: z.object({ unit: z.literal('input_output_tokens'), reset: z.literal('UTC') }).strict(),
  app_sources: z.array(z.object({ path: absolutePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  terminals: z.array(terminal).min(1),
}).strict().refine((value) => new Set(value.terminals.map((row) => row.terminal_id)).size === value.terminals.length,
  '终端标识不能重复');

const HIGH_RISK = new Set([
  'git.push', 'payment', 'external_post', 'db.write', 'db.delete', 'email.send',
  'app.install', 'app.uninstall', 'app.permission.grant',
  'file.delete.bulk', 'disk.format', 'system.service.start', 'system.service.stop',
  'process.kill.external', 'system.permission.change', 'system.security.change',
]);
const APP_ACTIONS = new Set([
  'app.install', 'app.uninstall', 'app.list', 'app.info', 'app.permission.grant',
  'app.permission.revoke', 'app.launch', 'app.freeze', 'app.unfreeze',
]);

function highRiskCommand(command) {
  const executable = path.basename(command.executable).toLowerCase().replace(/\.exe$/, '');
  if (executable === 'git') {
    return !/^(status|log|show|diff|rev-parse|ls-files|ls-tree|cat-file)$/.test(command.argv[0])
      || command.argv.some((arg) => /^(push|config|reset|clean|checkout|restore)$|^-c|^--config-env(?:=|$)/i.test(arg));
  }
  return /^(node|python\d*(\.\d+)?|ruby|perl|bash|sh|zsh|cmd|powershell|pwsh|rm|rmdir|del|format|diskpart|mkfs|dd|kill|taskkill|systemctl|service|sc|net|chmod|chown|icacls|cacls|schtasks|reg|sudo|su)$/.test(executable);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function canonicalPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new TypeError('路径无效');
  if (value.split(path.sep === '\\' ? /[\\/]/ : /\//).includes('..')) {
    throw new TypeError('执行路径不能含父目录跳转，请由宿主提供最终绝对路径');
  }
  const target = path.resolve(value);
  const suffix = [];
  let cursor = target;
  for (;;) {
    try {
      fs.lstatSync(cursor);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
      continue;
    }
    return path.join(fs.realpathSync.native(cursor), ...suffix);
  }
}

function inside(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function parseMatrix(value) {
  const matrix = matrixSchema.parse(value);
  const shared = matrix.shared_scope.map(canonicalPath);
  const scopes = matrix.terminals.map((row) => row.data_scope.map(canonicalPath));
  for (const roots of scopes) for (const root of roots) {
    if (shared.some((item) => root !== item && (inside(root, item) || inside(item, root)))) {
      throw new TypeError('共享范围与私有范围不能相互包含');
    }
  }
  for (let i = 0; i < scopes.length; i++) {
    for (let j = i + 1; j < scopes.length; j++) {
      for (const left of scopes[i]) for (const right of scopes[j]) {
        if ((inside(left, right) || inside(right, left))
          && !shared.some((root) => inside(left, root) && inside(right, root))) {
          throw new TypeError('终端私有数据范围重叠：请分离目录，公共范围只能放入 shared_scope');
        }
      }
    }
  }
  return freeze(matrix);
}

const denied = (reason, status = 'denied') => Object.freeze({ allowed: false, status, reason });
const factsSchema = z.object({
  scope_enforced: z.literal(true),
  targets: z.array(absolutePath),
  risk: z.enum(['normal', 'high']),
  usage: z.object({
    task_tokens: tokens,
    day_tokens: tokens,
    reserved_task_tokens: tokens,
    reserved_day_tokens: tokens,
    input_tokens: tokens,
    max_output_tokens: tokens,
  }).strict(),
  command: z.object({ executable: name, argv: z.array(z.string()), shell: z.literal(false) }).strict().optional(),
  app_source: z.object({ path: absolutePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();

// Facts are produced by the host's final executor, never copied from terminal payloads.
function createMatrixPolicy(value, { protectedPaths = [] } = {}) {
  const protectedRoots = protectedPaths.map(canonicalPath);
  const matrix = value === null ? null : parseMatrix(value);
  const rootBindings = new Map(matrix
    ? [...matrix.shared_scope, ...matrix.terminals.flatMap((row) => row.data_scope)].map((root) => [root, canonicalPath(root)])
    : []);
  function check(context, executionFacts) {
    if (!matrix) return denied('权限矩阵尚未激活：请完成勘察并由管理员确认', 'need_human');
    const row = matrix.terminals.find((item) => item.terminal_id === context?.terminal_id);
    if (!row || row.state !== 'active') return denied('终端未注册、未激活或已停用');
    if (!row.tools.includes(context.action)) return denied('动作不在终端白名单中');
    if (row.denied_tools.includes(context.action)) return denied('动作被终端拒绝清单禁止');
    if (context.action.startsWith('app.')
      && (!APP_ACTIONS.has(context.action) || row.role !== 'container' || row.app_capabilities[context.action]?.status !== 'available')) {
      return denied('该应用能力当前缺失：需要实现并勘察确认对应容器工具', 'failed');
    }
    const parsed = factsSchema.safeParse(executionFacts);
    if (!parsed.success) return denied('执行范围、风险分类或令牌计量缺失：请接通宿主执行边界');
    const facts = parsed.data;
    let scope;
    try {
      if (!Array.isArray(context.scope) || context.scope.length === 0) return denied('动作数据范围不能为空');
      scope = context.scope.map(canonicalPath);
      const roots = [...row.data_scope, ...matrix.shared_scope].map((root) => {
        const current = canonicalPath(root);
        if (current !== rootBindings.get(root)) throw new TypeError('数据根目录已被重定向');
        return current;
      });
      if (!scope.every((target) => roots.some((root) => inside(target, root)))) return denied('票据范围超出终端数据范围');
      for (const target of facts.targets) {
        const resolved = canonicalPath(target);
        const entry = path.join(canonicalPath(path.dirname(target)), path.basename(target));
        if ([resolved, entry].some((item) => protectedRoots.some((root) => inside(item, root) || inside(root, item)))) {
          return denied('执行目标涉及内核保留文件：配置与审计只能经管理员通道访问');
        }
        if (![resolved, entry].every((item) => scope.some((root) => inside(item, root)))) {
          return denied('执行目标或目录项超出票据范围：禁止跨端操作');
        }
      }
    } catch {
      return denied('执行路径无法规范化：请检查路径、符号链接和访问权限');
    }
    if (context.action === 'shell.exec') {
      const command = facts.command;
      if (!command || !row.allowed_commands.includes(command.executable)) return denied('命令未被明确允许或仍通过 shell 解释');
    }
    if (context.action === 'app.install') {
      const source = facts.app_source;
      if (!source || !matrix.app_sources.some((item) => item.sha256 === source.sha256 && item.path === source.path)) {
        return denied('应用来源白名单未匹配：仅接受管理员逐个批准且摘要一致的本地包');
      }
    }
    const usage = facts.usage;
    const next = BigInt(usage.input_tokens) + BigInt(usage.max_output_tokens);
    if (BigInt(usage.task_tokens) + BigInt(usage.reserved_task_tokens) + next > BigInt(row.max_tokens_per_task)) {
      return denied('单任务令牌预算不足：请由核心拆分任务', 'need_split');
    }
    if (BigInt(usage.day_tokens) + BigInt(usage.reserved_day_tokens) + next > BigInt(row.daily_budget)) {
      return denied('当日令牌预算不足：拆分不能绕过日预算，请等待 UTC 次日或由管理员调整');
    }
    if (facts.risk === 'high' || HIGH_RISK.has(context.action) || matrix.high_risk_actions.includes(context.action)
      || (context.action === 'shell.exec' && highRiskCommand(facts.command))) {
      return denied('高危动作需要绑定本次最终参数的管理员确认', 'need_human');
    }
    return Object.freeze({ allowed: true, status: 'ok', reason: '矩阵权限、执行范围与预算检查通过' });
  }
  return Object.freeze({ matrix, check });
}

module.exports = { createMatrixPolicy, canonicalPath };
