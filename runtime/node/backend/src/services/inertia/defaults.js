'use strict';

/**
 * inertia/defaults.js — 惯性执行机制冻结常数（单一账本真源）。
 *
 * [DESIGN-ARCH-160] §3.2/§3.5：动量常数与预算默认值冻结在此一处
 * （先例：agenticHarnessService.js DEFAULTS）。惯性单只能把默认上界收紧、
 * 不能放宽（planSchema.validatePlan 强制校验方向）。
 *
 * 叶子纪律：零 IO、零 env 读取、绝不抛。被 planSchema / momentum /
 * inertialRunService 共享；所有开关走惯性单字段，不新增 env 门
 * （MAX_GATES 棘轮，方案 §4 S3）。
 */

const SCHEMA_VER = 1;

/** 动量起点（蹬一脚 = 满动量 1.0，§3.5）。 */
const MOMENTUM_START = 1.0;

const DEFAULTS = Object.freeze({
  // §3.2 预算默认上界（惯性单各字段只允许 ≤ 此值）
  budget: Object.freeze({
    maxTurns: 40, // 总迭代轮数（跨续推段累计，对齐 -p maxTurns ≤100 语义）
    maxCostCny: 5, // 人民币计（tokenUsageService 同币种）；cost 缺失时 turns 为主闸（§8.1）
    maxWallMs: 600000, // 10 分钟墙钟兜底（RUNTIME-003：非活动超时，idle 才是活动计时器）
    maxIdleMs: 90000, // 90s 无账本事件即停（活动计时器，任何账本事件重置）
    maxDenies: 3,
  }),
  // §3.5 动量常数
  decay: Object.freeze({
    noProgressPenalty: 0.15,
    repeatPenalty: 0.25,
    denyPenalty: 0.3,
    errorPenalty: 0.4,
    progressRestore: 0.2,
    stopBelow: 0.2,
  }),
  authorization: Object.freeze({
    // 无默认白名单：白名单必须由惯性单显式给出（fail-closed，未声明≠全权）
    tools: null,
    bashPolicy: Object.freeze({ allow: Object.freeze([]), deny: Object.freeze([]) }),
    paths: Object.freeze(['**']),
    onControlRequest: 'deny', // S1 仅支持 deny（不传应答器 = 内核 fail-closed deny）
  }),
  ambiguity: Object.freeze({ policy: 'stop' }),
  leaseMs: 900000, // 15 分钟租约（§3.8.5；HQ 租约同构，默认 120min 太长不适用单跑）
  consecutiveErrorsForStop: 3, // §3.4 error 停：窗口内连续错误 ≥3
});

/**
 * §3.8.2 不可逆硬拒清单（无论惯性单怎么写都 deny，常量化）。
 * 通配 `*` 匹配任意字符序列，大小写不敏感，整串锚定（planSchema.wildcardMatch）。
 *
 * S1 为命令模式级近似：「工作区外删除」的路径级判定、以及 bash 命令级
 * 执行边缘拦截（当前 onToolCall 只观测不可否决）留待 S2 独立提案——
 * S1 的硬拒语义 = 检测 + interruptSignal 刹车 + 立即停跑 + 诚实披露
 * （竞态：被匹配的那条命令可能已执行一次，见方案 §10）。
 */
const HARD_DENY_BASH = Object.freeze([
  // 强推 / 历史改写
  'git push*--force*',
  'git push* -f*',
  'git push*--delete*',
  'git push :*',
  'git reset*--hard*',
  'git filter-branch*',
  // 删除类（递归/强制形态；目录级普通删除不在此列）
  'rm -rf*',
  'rm -fr*',
  'rd /s*',
  'rmdir /s*',
  'Remove-Item* -Recurse*',
  'Remove-Item* -Force*',
  'del /s*',
  'del /q /s*',
  // 部署 / 发布 / registry publish
  'npm publish*',
  'yarn publish*',
  'pnpm publish*',
  'docker push*',
  'flyctl deploy*',
  'fly deploy*',
  'vercel*',
  'netlify deploy*',
  'wrangler*publish*',
  'gh release create*',
  'gh release upload*',
  // 凭据 / 密钥文件读取
  '*credentials*',
  '*credential*',
  '*.env',
  '*.pem',
  '*.p12',
  '*.pfx',
  '*.key',
]);

/** S1 支持的 completion 判据种类（其余具名拒绝，fail-closed）。 */
const SUPPORTED_COMPLETION_KINDS = Object.freeze(['command_green']);

/** S1 支持的 onControlRequest 策略。 */
const SUPPORTED_CONTROL_POLICIES = Object.freeze(['deny']);

/** S1 支持的歧义策略。 */
const SUPPORTED_AMBIGUITY_POLICIES = Object.freeze(['stop']);

/** 动量事件类型（§3.5；momentum.nextMomentum 消费）。 */
const MOMENTUM_EVENTS = Object.freeze(['progress', 'no_progress', 'repeat', 'deny', 'error']);

module.exports = {
  SCHEMA_VER,
  MOMENTUM_START,
  DEFAULTS,
  HARD_DENY_BASH,
  SUPPORTED_COMPLETION_KINDS,
  SUPPORTED_CONTROL_POLICIES,
  SUPPORTED_AMBIGUITY_POLICIES,
  MOMENTUM_EVENTS,
};
