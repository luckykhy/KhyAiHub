'use strict';

/**
 * khyosAgentChannel — 网页内核终端的 agent 通道(内核 COM2 ⇄ 宿主 KhyBridge)。
 *
 * 内核侧:agentbus_task() 在 COM2 上服务三个面(控制面 agentctl / 决策面 agentask /
 * 事件面 agentevent)。shell 的 `ai <自然语言>` 与 `agentask <问题>` 走**决策面**:
 * 内核把问题编成 DECISION_REQ 发出并阻塞调用者,宿主必须在期限内回 DECISION_RESP,
 * 否则内核按超时**诚实上报**(kernel/src/agentask.h,默认 AGENTASK_DEFAULT_TIMEOUT_MS=3s),
 * 绝不挂死。
 *
 * 宿主侧:本模块把 KhyOsRunner 暴露的 COM2 环回口接上 `kernel/bridge` 的 KhyBridge,
 * 并挂一个 brain(大脑):
 *   - 项目网关在监听 → makeGatewayBrain() 走它自己的 OpenAI 兼容端点,真模型决策;
 *   - 网关没起/超时   → 桥自带的规则脑兜底(SET/GET/SAY + ALLOW/DENY 仍成立),
 *     内核永远拿得到答复,这是 [DESIGN] 的「松耦合」硬保证,不是降级缺陷。
 *
 * 零硬编码:网关 URL 与 token 全部取自后端自有真源 —— utils/proxyBaseUrl 的运行时发现
 * (proxy_server_runtime.json → env)与 gateway/proxyServer 的凭据解析,本模块不写
 * host/port/token 字面量。模型选择取自内核自己的配置(/disk/etc/agent.conf,由
 * `ai use model X` 落盘),即「在系统里配置模型」这条链路对本通同样成立。
 *
 * 门控 KHY_KHYOS_AGENT_CHANNEL(flagRegistry 优先,本地回退,默认开)。全程 fail-soft:
 * 桥模块缺失 / COM2 未开 / 网关不可达都只记一条日志,绝不抛 —— 没有 agent 的表现是
 * 内核侧诚实的超时提示,而不是网页上多一个报错。
 */

const path = require('path');

const CONNECT_RETRY_DELAY_MS = 50;
// 内核决策面的截止时间是 3s,所以**任何**控制面读取都不能挡在决策路径上:配置读取
// 在后台进行,决策只用已缓存的值(见 _refreshConfig)。
const CONFIG_TTL_MS = 15000;

const _AGENT_CHANNEL_FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:flagRegistry 优先,本地 CANON 回退(与 _khyosDesktopCaptureEnabled 同款,注册表
 *  抖动不至于静默关掉本通道)。默认开。 */
function _khyosAgentChannelEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_KHYOS_AGENT_CHANNEL', e);
    }
  } catch {
    /* registry unavailable → local fallback */
  }
  const v = e.KHY_KHYOS_AGENT_CHANNEL;
  return !(v !== undefined && _AGENT_CHANNEL_FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 定位内核树里的宿主桥(kernel/bridge)。候选顺序与 `khy os build` / isoProvisioner
 * 同一套覆盖:KHY_KERNEL_SRC_DIR → 仓库根 kernel/ → pip wheel 的 bundled 布局。
 * 找不到返回 null(调用方 fail-soft),绝不抛。
 */
function resolveKernelBridge() {
  const candidates = [];
  const srcOverride = process.env.KHY_KERNEL_SRC_DIR;
  if (srcOverride) {
    candidates.push(path.join(srcOverride, 'bridge'));
  }
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  candidates.push(path.join(repoRoot, 'kernel', 'bridge'));
  candidates.push(path.join(repoRoot, 'khy_os', 'bundled', 'kernel', 'bridge'));
  for (const dir of candidates) {
    try {
      const mod = require(path.join(dir, 'index.js'));
      if (mod && typeof mod.KhyBridge === 'function') {
        return mod;
      }
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/**
 * 解析项目自有网关的 OpenAI 兼容端点与令牌。**只在网关确实在监听时解析**:
 * getAuthStatus() 在无令牌时会现场生成并落盘一个,不该为一个连不上的网关产生副作用。
 * 返回 { running, url?, token? };任何异常都收敛为 running:false。
 */
function resolveGateway() {
  try {
    const proxy = require('./gateway/proxyServer');
    if (!proxy || typeof proxy.isRunning !== 'function' || !proxy.isRunning()) {
      return { running: false };
    }
    const base = require('../utils/proxyBaseUrl').resolveLocalProxyOpenAiBaseUrl();
    const trimmed = String(base || '').replace(/\/+$/, '');
    if (!trimmed) {
      return { running: false };
    }
    const auth = typeof proxy.getAuthStatus === 'function' ? proxy.getAuthStatus() : null;
    return {
      running: true,
      url: `${trimmed}/chat/completions`,
      token: auth && auth.authToken ? String(auth.authToken) : '',
    };
  } catch (err) {
    return { running: false, error: err };
  }
}

/**
 * 建一条内核 agent 通道。
 *
 * @param {object} args
 * @param {object} args.runner 已 start() 的 KhyOsRunner(需带 agentChannel)
 * @param {Function} [args.log] 诊断日志收口((msg) => void),默认静默
 * @returns {{ start: Function, stop: Function, attached: boolean, describe: Function }}
 */
function createKhyosAgentChannel({ runner, log } = {}) {
  const note = typeof log === 'function' ? log : () => {};
  let bridge = null;
  let started = false;
  let brainKind = 'none';
  let config = {};
  let configAt = 0;
  let configInFlight = null;

  /* 后台刷新内核配置(/disk/etc/agent.conf):决策路径只读缓存值,不阻塞 ——
   * 控制面读取哪怕几百毫秒,也会直接吃掉内核 3s 决策预算。并发的重复读取合并成一次。 */
  function refreshConfig() {
    if (!bridge || configInFlight) {
      return configInFlight;
    }
    configInFlight = bridge
      .readConfig()
      .then((value) => {
        config = value && typeof value === 'object' ? value : {};
        configAt = Date.now();
        return config;
      })
      .catch(() => config)
      .finally(() => {
        configInFlight = null;
      });
    return configInFlight;
  }

  function currentConfig() {
    // 过期就顺手触发一次后台刷新,本次决策仍用已有的值(下一次生效)。
    if (Date.now() - configAt >= CONFIG_TTL_MS) {
      void refreshConfig();
    }
    return config;
  }

  return {
    get attached() {
      return !!bridge;
    },

    describe() {
      return { attached: !!bridge, brain: brainKind, model: config.model || '' };
    },

    /**
     * 连上 COM2 并挂 brain。返回是否挂上;任何失败都只记日志(
     * 内核侧会以诚实的超时提示呈现,而不是网页报错)。
     */
    async start() {
      if (started) {
        return !!bridge;
      }
      started = true;
      if (!_khyosAgentChannelEnabled()) {
        note('内核 agent 通道已关闭(KHY_KHYOS_AGENT_CHANNEL)');
        return false;
      }
      if (!runner || !runner.agentChannel || !runner.agentPort) {
        note('内核 agent 通道:runner 未开启 COM2(agentChannel),跳过挂载');
        return false;
      }
      const mod = resolveKernelBridge();
      if (!mod) {
        note('内核 agent 通道:未找到 kernel/bridge(KHY_KERNEL_SRC_DIR 可覆盖),跳过挂载');
        return false;
      }

      let stream;
      try {
        stream = await runner.connectAgentChannel();
      } catch (err) {
        note(`内核 agent 通道连接失败: ${(err && err.message) || String(err)}`);
        return false;
      }

      bridge = new mod.KhyBridge({ stream, requestTimeoutMs: 6000 });
      await bridge.connect(); // stream 已给,attach 立即完成

      // brain:网关在跑用真模型,否则规则脑兜底 —— makeGatewayBrain() 自己保证
      // 「网关挂了/超时/无 token 一律回落规则脑」,这里只补齐 URL/token/model。
      const gw = resolveGateway();
      const brainOpts = {};
      if (gw.running) {
        brainOpts.url = gw.url;
        if (gw.token) {
          brainOpts.token = gw.token;
        }
        brainKind = 'gateway';
      } else {
        brainKind = 'rule';
        note('内核 agent 通道:项目网关未监听,先用规则脑(启动网关后重开会话即用真模型)');
      }
      const brain = typeof mod.makeGatewayBrain === 'function'
        ? mod.makeGatewayBrain({
            ...brainOpts,
            onError: (err) => note(`内核 agent 通道:网关调用失败,回落规则脑(${(err && err.message) || String(err)})`),
          })
        : mod.defaultBrain;

      // 模型选择:内核配置里的 model 优先级最高(在系统里 `ai use model X` 配的),
      // 由 brain 读 config.model 决定路由 —— 与内核 docs 的「bridge 读它决定模型」一致。
      bridge.onDecision((question, code) => brain(question, code, currentConfig()));

      // 首个决策之前先把配置读回来(后台,不挡决策路径)。
      void refreshConfig();
      note(`内核 agent 通道已挂载(brain=${brainKind})`);
      return true;
    },

    /** 断开并释放 COM2。可重复调用。 */
    stop() {
      started = false;
      configInFlight = null;
      if (bridge) {
        try {
          bridge.close();
        } catch {
          /* ignore */
        }
        bridge = null;
      }
    },
  };
}

module.exports = {
  createKhyosAgentChannel,
  resolveGateway,
  resolveKernelBridge,
  _khyosAgentChannelEnabled,
};