'use strict';

/**
 * clientApps/scan.js — 「应用中心」本机只读探测（DESIGN-ARCH-189 §7.2；S1）。
 *
 * 回答每张卡三个问题：装了没 / 配了没 / 指向本网关没。
 *
 * 纪律：
 * - **绝不写盘**（S1 无写通道，RUNTIME-010：只读由「不接写路径」保证，不靠调用方自觉）。
 * - **绝不抛**（fail-soft）：单个 app 探测失败收敛为该卡 badge='探测失败' + detail，
 *   绝不拖垮整次扫描（状态透明，规则 2.2）。
 * - **零硬编码**：客户端配置路径来自 adapter.configPath() 或登记表 probe 段拼接；
 *   网关端点复用 ccSwitch/proxyAccess.resolveProxyAccess()（它自己从 dataHome 运行时
 *   文件 / KHY_PROXY_ENDPOINT 解析），本模块不含任何端口字面量。
 * - **不泄密钥**：网关令牌只用于「能不能校验」的布尔判断，绝不进返回值。
 *
 * 信号语义（字段定义以本文件为准；与参考对象 RouterCode 的三信号对齐关系见 README）：
 * - installed           探测落点文件存在（CLI 用 adapter.configPath，桌面端用登记表 probe）
 * - configured          反向读配置（ccSwitch/appWriters.detectCardInApp）检测到至少一个 provider
 * - configuredVerified  存在 provider 的 endpoint 与当前网关端点同源（网关不可解析时恒 false）
 * - manualConfig        configured && !configuredVerified —— 配了，但没指向本网关
 *                       （S1 没有 intent 存储，这是 S1 能给出的最诚实近似；见 README 边界）
 * - badge               未安装 / 未接入 / 未配置 / 配置未完成 / 已配置 / 探测失败
 *
 * @module services/domain/config/clientApps/scan
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { APPS } = require('../ccSwitch/constants');
const appWriters = require('../ccSwitch/appWriters');
const { userAppConfigDir } = require('../../messaging/mcp/mcpEcosystemRegistry');

/**
 * adapter 模块装载表 —— 静态 allowlist（**禁止**按登记表字符串动态 require，防路径注入）。
 * 每个 value 是 () => module；模块须导出 configPath(env)。与 ccSwitch/appWriters.js 的
 * require 列表保持一一对应；漂移由 catalog.test.js 钉住（登记表每个 adapter 名必须在本表）。
 * codex 刻意缺席：其写配置器在 gateway/adapters（D1），D2 不可反向依赖，探测走登记表 probe。
 */
const ADAPTER_LOADERS = Object.freeze({
  claudeCodeAdapter: () => require('../../network/externalApps/claudeCodeAdapter'),
  opencodeAdapter: () => require('../../network/externalApps/opencodeAdapter'),
  geminiCliAdapter: () => require('../../network/externalApps/geminiCliAdapter'),
  commandCodeAdapter: () => require('../../network/externalApps/commandCodeAdapter'),
  ycodeAdapter: () => require('../../network/externalApps/ycodeAdapter'),
  zcodeAdapter: () => require('../../network/externalApps/zcodeAdapter'),
  deepseekTuiAdapter: () => require('../../network/externalApps/deepseekTuiAdapter'),
  reasonixAdapter: () => require('../../network/externalApps/reasonixAdapter'),
  openclawAdapter: () => require('../../network/externalApps/openclawAdapter'),
  cozeAdapter: () => require('../../network/externalApps/cozeAdapter'),
  traeAppAdapter: () => require('../../network/externalApps/traeAppAdapter'),
});

/**
 * 两个 endpoint 是否指向同一网关源（protocol + host + port 全等）。
 * 纯函数：任一参数缺失/非法 → false，绝不抛。
 */
function sameGatewayOrigin(endpoint, gatewayEndpoint) {
  try {
    const a = new URL(String(endpoint || '').trim());
    const b = new URL(String(gatewayEndpoint || '').trim());
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

/**
 * 徽章裁决。纯函数，输入全部显式，便于单测钉死边界。
 *
 * @param {{ installed: boolean, hasDetector: boolean, configured: boolean,
 *           configuredVerified: boolean, gatewayAvailable: boolean }} s
 * @returns {'未安装'|'未接入'|'未配置'|'配置未完成'|'已配置'}
 */
function badgeFor(s) {
  if (!s.installed) return '未安装';
  if (!s.hasDetector) return '未接入';
  if (!s.configured) return '未配置';
  if (s.configuredVerified) return '已配置';
  return '配置未完成';
}

function _defaultContext() {
  return {
    env: process.env,
    homedir: os.homedir(),
    platform: process.platform,
    existsSync: fs.existsSync,
    detectFn: (appId) => appWriters.detectCardInApp(appId),
    gatewayAccessFn: () => appWriters.resolveProxyAccess(),
    adapterLoaders: ADAPTER_LOADERS,
  };
}

/**
 * 解析一个条目的探测落点路径。
 * @returns {{ path: string|null, reason?: string }}
 */
function resolveProbeTarget(entry, ctx) {
  if (entry.adapter) {
    const loader = ctx.adapterLoaders[entry.adapter];
    if (!loader) {
      return { path: null, reason: `adapter "${entry.adapter}" 未在 ADAPTER_LOADERS 登记` };
    }
    const mod = loader();
    if (typeof mod.configPath !== 'function') {
      return { path: null, reason: `adapter "${entry.adapter}" 未导出 configPath()` };
    }
    return { path: mod.configPath(ctx.env) };
  }
  const probe = entry.probe;
  if (probe.kind === 'home') {
    return { path: path.join(ctx.homedir, ...probe.segs) };
  }
  if (probe.kind === 'userAppConfig') {
    const base = userAppConfigDir({ homedir: ctx.homedir, platform: ctx.platform, env: ctx.env });
    if (!base) {
      return { path: null, reason: `userAppConfigDir 无法解析（platform=${ctx.platform}）` };
    }
    return { path: path.join(base, ...probe.segs) };
  }
  return { path: null, reason: `未知 probe.kind "${probe.kind}"` };
}

/**
 * 探测一个客户端应用。绝不抛：一切异常收敛为 badge='探测失败'。
 * @returns {object} 探测结果（形状见模块头注释）
 */
function scanApp(entry, ctx = _defaultContext()) {
  const base = { appId: entry.appId, category: entry.category, name: entry.name };
  try {
    const target = resolveProbeTarget(entry, ctx);
    const installed = Boolean(target.path && ctx.existsSync(target.path));
    const hasDetector = Object.values(APPS).includes(entry.appId);

    let configured = false;
    let configuredVerified = false;
    let detectNote = '';
    if (installed && hasDetector) {
      const detect = ctx.detectFn(entry.appId);
      if (!detect || detect.success !== true || !Array.isArray(detect.providers)) {
        detectNote = `反向读配置失败：${(detect && detect.reason) || '未知原因'}`;
      } else {
        configured = detect.providers.length > 0;
        const gw = ctx._gateway || { available: false, endpoint: '' };
        if (gw.available && gw.endpoint && configured) {
          configuredVerified = detect.providers.some((p) => p && sameGatewayOrigin(p.endpoint, gw.endpoint));
        }
      }
    }

    const gatewayAvailable = Boolean(ctx._gateway && ctx._gateway.available);
    const manualConfig = configured && !configuredVerified;
    const badge = badgeFor({ installed, hasDetector, configured, configuredVerified, gatewayAvailable });
    const detail = { configPath: target.path || null };
    if (target.reason) detail.probeReason = target.reason;
    if (detectNote) detail.detectReason = detectNote;
    if (!hasDetector) detail.note = '本卡暂无反向读配置器，只能探测安装状态';
    if (manualConfig) detail.note = '已配置但未指向本网关（手动配置或指向其他上游）';
    return { ...base, installed, configured, configuredVerified, manualConfig, badge, detail };
  } catch (e) {
    return {
      ...base,
      installed: false,
      configured: false,
      configuredVerified: false,
      manualConfig: false,
      badge: '探测失败',
      detail: { configPath: null, error: String((e && e.message) || e) },
    };
  }
}

/**
 * 扫描整张登记表。
 *
 * @param {object[]} apps 登记表条目（catalog.loadCatalog().apps）
 * @param {object} [ctx] 测试可注入替身（见 _defaultContext 形状）
 * @returns {{ gateway: { available: boolean, endpoint: string, source: object },
 *             apps: object[], count: number }}
 */
function scanAll(apps, ctx = _defaultContext()) {
  const gw = ctx.gatewayAccessFn();
  const gateway = {
    available: Boolean(gw && gw.ok === true),
    // 令牌绝不进返回值；endpoint 不是密钥（形如 http://127.0.0.1:9100），可回显。
    endpoint: gw && gw.ok === true ? String(gw.proxyEndpoint || '') : '',
    source: gw && gw.source ? gw.source : { endpoint: 'absent', token: 'absent' },
    reason: gw && gw.ok === true ? null : String((gw && gw.error) || '网关不可解析'),
  };
  const scoped = { ...ctx, _gateway: { available: gateway.available, endpoint: gateway.endpoint } };
  const results = (apps || []).map((entry) => scanApp(entry, scoped));
  return { gateway, apps: results, count: results.length };
}

module.exports = { scanAll, scanApp, badgeFor, sameGatewayOrigin, resolveProbeTarget, ADAPTER_LOADERS };
