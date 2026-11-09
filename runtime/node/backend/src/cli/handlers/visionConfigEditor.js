'use strict';

/**
 * visionConfigEditor.js — `khy vision config` 交互向导（识图端点，只当眼睛）。
 *
 * 用户语义(2026-10-27 裁决)：视觉模型**只当眼睛**。带图请求遇到不支持视觉的推理
 * 模型时，视觉模型描述图片、描述注入 prompt、由用户选定的推理模型作答。组合逻辑
 * 早已存在且默认开启（KHY_VISION_DESCRIBE_RETURN），所以本向导不新增任何组合
 * 行为，只负责把「端点三件套」收上来。
 *
 * 写入只经管理资源漏斗（managementRegistry.invoke('vision-config', …），**绝不经
 * _writeEnvPatch**：真源是 <dataHome>/vision_endpoint.json + api_keys.json 的
 * khy-vision 池，不是 .env。.env 一写，另一个 CLI 进程或常驻网关就看不到这次改动。
 *
 * 复用 customProviderVerify.verifyCustomProviderDraft 做连通性自检——与
 * `khy manage custom-providers add` 同一道闸，所以「探测不过就不写任何配置」这条
 * 纪律在两个入口上是一致的，不会出现「这边能写那边不能写」。
 */

const { printSuccess, printError, printInfo, printWarn } = require('../formatters');

// ── 交互提示（自带 TUI 守卫，避免 require 进 gateway.js 那个上帝文件）─────────
//
// 与 handlers/gateway.js 的 promptWithReplGuard 同形：Ink TUI 占用终端时原生
// inquirer 会掀掉托管 UI（stdin 仍是 TTY，所以非 TTY 守卫发现不了），必须走
// uiPrompt 桥。抄这 12 行比依赖 gateway.js 便宜——后者 2000+ 行且是基线钉死的
// 上帝文件。
let _prompt = null;
async function prompt(questions = []) {
  if (!_prompt) {
    const { isTuiActive, promptCompat } = require('../uiPrompt');
    if (isTuiActive()) {
      _prompt = promptCompat;
    } else {
      const inquirer = require('inquirer');
      _prompt = (qs) => inquirer.prompt(qs);
    }
  }
  return await _prompt(questions);
}

/** 示例地址必须是假公网域名：写 127.0.0.1 会让人以为识图也要在本机跑个服务。 */
const EXAMPLE_BASE_URL = 'https://your-vision-api.example.com/v1';
const EXAMPLE_MODEL = 'qwen-vl-max';

function _mgmt() {
  return require('../../services/management');
}

function _currentVisionConfig() {
  try {
    return _mgmt().invoke('vision-config', 'get', {}, { source: 'cli' });
  } catch {
    return null; // fail-soft：读不出来就当没配，向导照常能填
  }
}

function _isInteractive(options = {}) {
  // --json 一律非交互：机器消费者不该被提示卡住（与 gatewayConfigEditor 的
  // `if (asJson || !isInteractive)` 同一口径）。--yes 是显式要求无人值守。
  if (options.json || options.yes === true || options.yes === 'true') {
    return false;
  }
  return !!process.stdout.isTTY;
}

/** 归一化 CLI flag 与 JSON 两种来源的 clearApiKey。 */
function _flag(v) {
  return v === true || v === 'true';
}

/**
 * 取第一个非空 flag。CLI 解析器对 `--base-url` 的归一化写法在不同入口不一致
 * （camelCase / snake_case / 原样三种都见过），三种都认，免得用户照帮助敲下去
 * 拿到一句「Base URL 不能为空」。
 */
function _pick(options, ...names) {
  for (const n of names) {
    const v = options[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return v;
    }
  }
  return undefined;
}

/**
 * 校验 + 落库。返回 { ok, error?, config? }。
 *
 * `current` 用于补缺：`khy vision config --model <id>` 不该要求重打 Base URL。
 * 补缺发生在**校验之前**——漏斗里的 store 也会合并，但它合并的是盘上的半配置，
 * 而这里要先能通过校验才走得到那一步。
 *
 * 顺序刻意是「先探测再落库」：探测不过就一个字节都不写，避免留下一个连不通的
 * 端点——那种配置比没有配置更糟，因为它会让带图请求安静地走一条死路。
 */
async function _writeVisionConfig(input = {}, { verify = true, current = null } = {}) {
  const mgmt = _mgmt();

  const clearApiKey = _flag(input.clearApiKey);
  if (clearApiKey) {
    await mgmt.invoke('vision-config', 'clear', {}, { source: 'cli' });
    return { ok: true, config: null };
  }

  const pick = (key, field) => {
    const v = input[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return v;
    }
    return current ? current[field] : undefined;
  };

  const endpoint = String(pick('baseUrl', 'baseUrl') || '')
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(endpoint)) {
    return { ok: false, error: 'Base URL 必须以 http:// 或 https:// 开头' };
  }
  const modelId = String(pick('model', 'model') || '').trim();
  if (!modelId) {
    return { ok: false, error: 'Model ID 不能为空' };
  }
  if (/\s/.test(modelId)) {
    return { ok: false, error: 'Model ID 不能含空格（会被按逗号/空格切分）' };
  }

  const args = { baseUrl: endpoint, model: modelId };
  const key = String(input.apiKey == null ? '' : input.apiKey).trim();
  if (key) {
    args.apiKey = key;
  }

  if (verify && key) {
    printInfo('正在测试连接…');
    let verification;
    try {
      const { verifyCustomProviderDraft } = require('../../services/gateway/customProviderVerify');
      verification = await verifyCustomProviderDraft(
        { endpoint, keyInput: key, defaultModel: modelId },
        { apiFormat: 'openai' }
      );
    } catch (e) {
      // 探测本身出错不当成配置失败：上游没实现 /models 的老中转也会走到这里。
      printWarn(`连接自检未能完成（${e && e.message ? e.message : String(e)}），仍按你填写的内容保存。`);
      verification = { ok: true, reason: '', summary: { attempted: true, success: null } };
    }
    if (!verification.ok) {
      return { ok: false, error: verification.reason || '连接自检未通过', verification };
    }
    if (verification.summary && verification.summary.success === true) {
      printSuccess('连接成功');
    }
  }

  const config = await mgmt.invoke('vision-config', 'set', args, { source: 'cli' });
  return { ok: true, config };
}

function _printState(config) {
  if (!config) {
    printInfo('当前未配置识图端点（带图请求会走 OCR 兜底或推理模型原生视觉）。');
    return;
  }
  printInfo(`当前识图端点：${config.baseUrl}`);
  printInfo(`当前识图模型：${config.model}`);
  printInfo(
    config.hasApiKey
      ? `密钥：已配置（${config.apiKeyMasked || '已隐藏'}，共 ${config.keyCount} 把）`
      : '密钥：未配置（若上游需要鉴权，带图请求会 401）'
  );
}

/**
 * `khy vision config`
 *
 * @param {string[]} args   位置参数（忽略；本命令只认 flag）
 * @param {object}   options CLI options
 */
async function handleVisionConfig(args = [], options = {}) {
  const asJson = !!options.json;

  if (options.clear === true || options.clear === 'true') {
    try {
      await _mgmt().invoke('vision-config', 'clear', {}, { source: 'cli' });
    } catch (e) {
      if (asJson) {
        console.log(JSON.stringify({ ok: false, action: 'clear', error: String((e && e.message) || e) }));
      } else {
        printError(`清除失败：${(e && e.message) || e}`);
      }
      return false;
    }
    if (asJson) {
      console.log(JSON.stringify({ ok: true, action: 'clear' }));
    } else {
      printSuccess('已清除识图端点配置（密钥同时收回）');
    }
    return true;
  }

  const current = await _currentVisionConfig();

  // 非交互 / --json：只报状态，或按 flag 一次写完。
  if (!_isInteractive(options)) {
    const baseUrl = _pick(options, 'baseUrl', 'base_url', 'base-url');
    const model = _pick(options, 'model', 'modelId', 'model-id');
    if (!baseUrl && !model) {
      if (asJson) {
        console.log(JSON.stringify({ ok: true, action: 'status', config: current || null }));
      } else {
        _printState(current);
        printInfo('填写用：khy vision config --base-url <url> --model <模型id> --api-key <密钥>');
      }
      return true;
    }
    const result = await _writeVisionConfig(
      {
        baseUrl,
        model,
        apiKey: _pick(options, 'apiKey', 'api_key', 'api-key', 'key'),
      },
      {
        verify: !_flag(_pick(options, 'noVerify', 'no_verify', 'no-verify')),
        current,
      }
    );
    if (!result.ok) {
      if (asJson) {
        console.log(JSON.stringify({ ok: false, action: 'set', error: result.error }));
      } else {
        printError(result.error);
        printInfo('未写入任何配置。');
      }
      return false;
    }
    if (asJson) {
      console.log(JSON.stringify({ ok: true, action: 'set', config: result.config || null }));
    } else {
      printSuccess('识图端点已配置');
      _printState(result.config);
    }
    return true;
  }

  // ── 交互式三步 ──────────────────────────────────────────────────────────
  printInfo('');
  printInfo('识图端点：给「看图片」单独配一个模型。它只负责描述图片，回答仍由你选定的推理模型给出。');
  printInfo('（不想配就直接 Ctrl+C 退出，带图请求会按既有规则走 OCR 兜底或推理模型原生视觉。）');
  printInfo('');

  const { baseUrl } = await prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: `Base URL（示例: ${EXAMPLE_BASE_URL}）:`,
      default: (current && current.baseUrl) || undefined,
      validate: (v) => {
        if (!v || !v.trim()) {
          return '请输入视觉模型的 API 地址';
        }
        if (!/^https?:\/\//i.test(v.trim())) {
          return '请输入完整 URL (https://...)';
        }
        return true;
      },
    },
  ]);

  const { model } = await prompt([
    {
      type: 'input',
      name: 'model',
      message: `Model ID（识图专用，示例: ${EXAMPLE_MODEL}）:`,
      default: (current && current.model) || undefined,
      validate: (v) => {
        if (!v || !v.trim()) {
          return '请输入识图模型的 ID';
        }
        if (/\s/.test(v.trim())) {
          return 'Model ID 不能含空格';
        }
        return true;
      },
    },
  ]);

  const { apiKey } = await prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: current && current.hasApiKey ? 'API Key（留空则沿用已保存的那把）:' : 'API Key（留空表示上游无需鉴权）:',
      mask: '*',
    },
  ]);

  const keyInput = String(apiKey == null ? '' : apiKey).trim();
  if (!keyInput && !(current && current.hasApiKey)) {
    printWarn('没有填密钥。若上游需要鉴权，带图请求会 401；确认无需鉴权可继续。');
  }

  const result = await _writeVisionConfig(
    { baseUrl, model, apiKey: keyInput },
    {
      verify: !_flag(_pick(options, 'noVerify', 'no_verify', 'no-verify')),
      current,
    }
  );
  if (!result.ok) {
    printError(result.error);
    printInfo('未写入任何配置。');
    return false;
  }

  printSuccess(`识图端点已配置：${String(baseUrl).trim().replace(/\/+$/, '')}`);
  printInfo(`识图模型：${String(model).trim()}（只当眼睛，回答仍由推理模型给出）`);
  printInfo('已保存到数据目录的 vision_endpoint.json / api_keys.json（未改动 .env）');
  printInfo('清除用：khy vision config --clear');

  // 已知不对称：用户显式把 KHY_VISION_FALLBACK_MODEL 设成非 auto 的值时，我们的
  // 钉选让位给那个显式 env——这是「显式配置优先」的既定语义，但用户可能不知道
  // 自己设过。这里如实告知，不要让人以为配了却没生效是 bug。
  const explicit = String(process.env.KHY_VISION_FALLBACK_MODEL || '').trim();
  if (explicit && explicit.toLowerCase() !== 'auto') {
    printWarn(
      `检测到环境变量 KHY_VISION_FALLBACK_MODEL=${explicit}，它会盖掉刚配的识图端点。` +
        '需要改用本端点请把它设成 auto 或清掉。'
    );
  }
  return true;
}

module.exports = {
  handleVisionConfig,
  EXAMPLE_BASE_URL,
  EXAMPLE_MODEL,
};
