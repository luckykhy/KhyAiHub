'use strict';

/**
 * Gateway model-choice / probe / vendor-switch subsystem (extracted from cli/handlers/gateway.js).
 *
 * Owns: buildGatewayModelChoices (probe all enabled adapters + reliability filtering, shared by the
 * classic CLI selector and the Ink TUI ModelPicker), applyGatewayModelSelection, handleGatewaySelectModel,
 * buildVendorModelChoices and handleModelSwitchByVendor. Extracted verbatim (byte-identical bodies) as a
 * same-directory sibling leaf so in-body relative require() paths resolve identically; the host re-imports
 * every public handler by the same name to keep the model-selection command contracts unchanged.
 *
 * This leaf performs IO (multi-second adapter probes, interactive prompts, .env persistence, terminal
 * output) so it does NOT self-declare as a pure zero-IO leaf. Its many host callbacks (probe cache/timeout
 * helpers, reason classifiers, model-tag formatters, reliability filter, readline/prompt utilities, prefer
 * persistence) plus the shared STRICT_OPERATIONAL_ADAPTERS set are injected via setGatewayModelChoicesDeps
 * to avoid a require cycle back into the host. The debounce config + in-flight deep-probe map are used only
 * by this subsystem and moved here wholesale.
 */

const chalkModule = require('chalk');

const chalk = chalkModule.default || chalkModule;
const { printSuccess, printError, printInfo } = require('../formatters');
// 分组语义 / 行内分层：与 TUI `ModelPicker` 共用的同一片枝叶（放 cli/ 下，
// 避免 handlers → tui 的反向依赖）。曾经路过这里只平铺 `c.name`，实现端 94% 的
// 行重复 `(执行:)`、宽度统一省 91 列、80 列终端下每行只显示 2 行（[DESIGN-ARCH-167] 搂11）。
const modelChoiceGrouping = require('../modelChoiceGrouping');

// 模型采集 + 可用性判定 + 展示文案已下沉到 services/gateway/ 两片叶子，桌面端
// Electron host 与终端共用同一份。本文件只做**呈现**：原始条目 → 终端选择项。
const { collectModelEntries } = require('../../services/gateway/modelEntryCollection');
const { stripProviderPrefix } = require('../../services/gateway/modelOperationality');

// ── Host callbacks + shared STRICT_OPERATIONAL_ADAPTERS injected via DI (avoid require cycle) ──
// 只保留本文件呈现层仍需要的；探测时限/深测缓存/可靠性过滤/可用性判定/原因分类已随
// 采集下沉，改由采集叶自持（桌面与终端同一份，不再经这里转发）。
let promptWithReplGuard = null;
let _formatModelSourceTag = null;
let _formatConnectionTag = null;
let _formatUpstreamTag = null;
let _formatVisionTag = null;
let maybeAutoSyncSwitchCenterForGateway = null;
let getTokenInfoForSelection = null;
let askLine = null;
let recoverGatewayPromptInput = null;
let withTimeout = null;
let persistGatewayPreference = null;

function setGatewayModelChoicesDeps(deps = {}) {
  if (typeof deps.promptWithReplGuard === 'function') {
    promptWithReplGuard = deps.promptWithReplGuard;
  }
  if (typeof deps._formatModelSourceTag === 'function') {
    _formatModelSourceTag = deps._formatModelSourceTag;
  }
  if (typeof deps._formatConnectionTag === 'function') {
    _formatConnectionTag = deps._formatConnectionTag;
  }
  if (typeof deps._formatUpstreamTag === 'function') {
    _formatUpstreamTag = deps._formatUpstreamTag;
  }
  if (typeof deps._formatVisionTag === 'function') {
    _formatVisionTag = deps._formatVisionTag;
  }
  if (typeof deps.maybeAutoSyncSwitchCenterForGateway === 'function') {
    maybeAutoSyncSwitchCenterForGateway = deps.maybeAutoSyncSwitchCenterForGateway;
  }
  if (typeof deps.getTokenInfoForSelection === 'function') {
    getTokenInfoForSelection = deps.getTokenInfoForSelection;
  }
  if (typeof deps.askLine === 'function') {
    askLine = deps.askLine;
  }
  if (typeof deps.recoverGatewayPromptInput === 'function') {
    recoverGatewayPromptInput = deps.recoverGatewayPromptInput;
  }
  if (typeof deps.withTimeout === 'function') {
    withTimeout = deps.withTimeout;
  }
  if (typeof deps.persistGatewayPreference === 'function') {
    persistGatewayPreference = deps.persistGatewayPreference;
  }
}

/**
 * 最近一次 buildGatewayModelChoices 产出的**可选项快照**(`adapter/model` 小写 key)。
 *
 * 为什么存在:模型列表(候选池 → 真值表的收敛)只在「构建」那一刻完成。任何**绕过选择器**的
 * 应用路径 —— F2「最近模型」轮换、启动默认值、自然语言直选 —— 都不经过构建,于是可以把一个
 * 早已不存在的 (adapter, model)(历史残留 / 静态目录猜测 / 本机扫描垃圾)直接写进偏好并应用,
 * 用户看到的就是「TUI 莫名跳到不存在的模型,下一次生成才报错」。快照让这些入口能与**当前真值**
 * 对账:不在快照里 → 拒绝并给出可执行提示,绝不落盘。
 */
let _lastSelectableKeys = null;

/** 读最近一次 catalog 的可选 key 集(未构建过 → null,表示「无快照,不阻断」)。 */
function getLastSelectableKeys() {
  return _lastSelectableKeys;
}

/**
 * 选择入口对账闸:该选择在**最近一次构建**里是否仍然可选。
 * 无快照(null)/ model 为空(adapter 级默认模型入口)/ adapter === 'auto' → 放行(不阻断)。
 * 有快照且快照里没有这条 → false(调用方应拒绝应用并提示重新选择)。
 * 绝不抛。
 * @param {{adapter?:string, model?:string|null}} selected
 * @returns {boolean}
 */
function isSelectableNow(selected) {
  try {
    const keys = _lastSelectableKeys;
    if (!keys || !selected) {
      return true;
    }
    const adapter = String(selected.adapter || '')
      .trim()
      .toLowerCase();
    const model = String(selected.model || '')
      .trim()
      .toLowerCase();
    if (!adapter || adapter === 'auto' || !model) {
      return true;
    }
    return keys.has(`${adapter}/${model}`);
  } catch {
    return true;
  }
}

/**
 * Select AI model from available adapters (with connectivity indicators).
 *
 * buildGatewayModelChoices — probe all enabled adapters and assemble the
 * selectable model list, WITHOUT any prompting. Shared by the classic CLI
 * handler (handleGatewaySelectModel) and the Ink TUI ModelPicker so both reuse
 * the exact same probing, reliability filtering and adapter-hiding logic.
 *
 * Side-effecting progress/diagnostic output is delegated to the caller via
 * `onNotice` / `onError` / `onProgress` callbacks (the classic CLI passes
 * printInfo/printError; the TUI pushes transcript messages and renders a
 * progress bar). `onProgress` receives `{ phase, current, total, label }`
 * where current/total are 0-100 percentages. This keeps the function
 * presentation-free while preserving streaming feedback during the probe.
 *
 * Returns { modelChoices, preferredIssueAfterProbe, empty }. `empty` is true
 * when there is nothing selectable (no enabled adapters, or all filtered out);
 * the relevant explanatory notices have already been emitted in that case.
 */
async function buildGatewayModelChoices({ onNotice = () => {}, onError = () => {}, onProgress = () => {} } = {}) {
  let preferredIssueAfterProbe = null;
  try {
    // 采集 + 决策已下沉到 services/gateway/modelEntryCollection.js——桌面端 Electron host
    // 与终端共用同一份，两边「哪些模型可选、归哪组、叫什么」从此同源。
    const collected = await collectModelEntries({
      gateway: require('../../services/gateway/aiGateway'),
      onNotice,
      onError,
      onProgress,
      // switch-center 同步留在 CLI 薄壳：它 require('./proxy') 会拖进 cli 层，而采集叶
      // 本身不依赖它。桌面端注入同一个函数即可保持初始化序列一致。
      beforeCollect: maybeAutoSyncSwitchCenterForGateway,
    });
    preferredIssueAfterProbe = collected.preferredIssueAfterProbe;
    if (collected.empty) {
      return { modelChoices: [], preferredIssueAfterProbe, empty: true };
    }

    // ── 呈现：采集叶的原始条目 → 终端选择项（chalk 上色仍在本文件）────────────
    const modelChoices = [];
    for (const entry of collected.entries) {
      if (entry.kind === 'external-agent') {
        const connTag = entry.connPlain === '中继' ? chalk.yellow('中继') : chalk.cyan('直连');
        const keyTag =
          entry.keyPlain === '● ready' ? chalk.green('● ready') : chalk.dim('● 未含 key');
        modelChoices.push({
          name: `${chalk.green('[可用]')} ${entry.display.primary}${connTag ? ` ${connTag}` : ''} ${keyTag}`,
          primary: entry.display.primary,
          // 投影行没有 per-adapter 探测状态，组级三件套里只有 key 就绪度可挂。
          secondary: `${connTag} ${keyTag}`.trim(),
          group: entry.group,
          groupMeta: `${chalk.green('[可用]')} ${keyTag}`,
          value: entry.value,
          disabled: false,
          externalAgent: true,
        });
        continue;
      }

      const s = { type: entry.adapter.type, name: entry.adapter.name };
      const m = entry.model;
      const generationWarn = entry.generationWarn;
      const indicator = generationWarn
        ? chalk.yellow(`● ${entry.generationError || '实测告警'}`)
        : chalk.green(`● ${entry.latencyMs}ms`);
      const statusTag = generationWarn ? chalk.yellow('[可用-告警]') : chalk.green('[可用]');
      // 组级三件套：同一 adapter 下每一行都相同，留在行内就是「每行重复」（截图病根）。
      // 升格到分组标题只写一次；段太短没画标题时由渲染侧回落到行内（ModelPicker 的 orphan）。
      const adapterTag = chalk.dim(`(执行:${s.name}/${s.type})`);
      const groupMeta = `${statusTag} ${indicator} ${adapterTag}`;

      if (entry.kind === 'default-model') {
        // Adapter available but no model list (e.g. relay)，或 Kiro 列表超时保留默认入口。
        const note =
          entry.note === 'list-timeout'
            ? chalk.dim('(模型列表超时，使用默认模型)')
            : chalk.dim('(默认模型)');
        modelChoices.push({
          name: `${statusTag} ${s.name} ${note} ${indicator}`,
          primary: entry.display.primary,
          secondary: note,
          group: entry.group,
          groupMeta,
          value: entry.value,
          disabled: false,
        });
        continue;
      }

      const sourceTag = _formatModelSourceTag(m);
      const connTag = _formatConnectionTag(m);
      const upstreamTag = _formatUpstreamTag(m);
      const visionTag = _formatVisionTag(m);
      const secondary = [
        visionTag,
        sourceTag,
        upstreamTag,
        connTag,
        m.isDefault ? chalk.green('✓ 当前') : '',
      ]
        .filter(Boolean)
        .join(' ');
      modelChoices.push({
        // `name` 只增不减：advisor.js 拿它当 label，拆了会静默丢标签。
        name: `${statusTag} ${m.name || m.id}${visionTag ? ` ${visionTag}` : ''}${sourceTag ? ` ${sourceTag}` : ''}${upstreamTag ? ` ${upstreamTag}` : ''}${connTag ? ` ${connTag}` : ''} ${adapterTag} ${indicator}${m.isDefault ? chalk.green(' ✓ 当前') : ''}`,
        primary: stripProviderPrefix(m.name || m.id, entry.group),
        secondary,
        group: entry.group,
        groupMeta,
        value: entry.value,
        disabled: false,
      });
    }

    // ── 模型列表顶部增设可选「Auto」入口(/goal「khy 在模型列表下设置一个 auto 模型」)。──
    // 门控 KHY_AUTO_MODEL_SELECT 默认开;关 → 不 unshift(字节回退旧行为)。Auto 标签用纯排序
    // 原语按「当前会话默认任务」预览一个「最适合且可用」的模型 id(候选=已枚举的可用模型)。
    //
    // [DESIGN-ARCH-185] §4.4：模式轴开启时这里产出**四行**(Auto/极致/性能/经济)，
    // 仍是同一个产出点，不是第 6 个。模式轴关 → 逐字节回到单行 Auto。
    // 决策数据（预览、四档规格）由采集叶算好，这里只负责上色与 unshift。
    const auto = collected.auto;
    if (auto && modelChoices.some((c) => c && c.value && !c.disabled && c.value.model)) {
      const autoSelect = require('../../services/gateway/autoModelSelect');
      let rows = [];
      if (auto.kind === 'mode-axis') {
        rows = autoSelect.buildModeChoices({
          modes: auto.modes,
          chalk,
          inert: auto.inert,
          inertNote: auto.inertNote,
        });
        // rows 为空时**不**抛：抛会被外层 catch 吞成「一行都没有」，比退回单行 Auto 更糟。
        // 这里让控制流自然落到下面的单行兜底。
      }
      if (rows.length === 0) {
        modelChoices.unshift(autoSelect.buildAutoChoice({ previewModel: auto.previewModel, chalk }));
      } else {
        modelChoices.unshift(...rows);
      }
    }

    // 记录本次构建的可选快照:选择/回跳入口(F2 最近模型、启动默认、自然语言直选)据此对账,
    // 防止把一个已不在列表里的模型写进偏好并应用(见 isSelectableNow 的注释)。
    try {
      _lastSelectableKeys = new Set(
        modelChoices
          .filter((c) => c && c.value && !c.disabled && c.value.adapter && c.value.model)
          .map(
            (c) =>
              `${String(c.value.adapter).trim().toLowerCase()}/${String(c.value.model)
                .trim()
                .toLowerCase()}`
          )
      );
    } catch {
      _lastSelectableKeys = null;
    }
    return { modelChoices, preferredIssueAfterProbe, empty: false };
  } catch (err) {
    onError(`构建模型列表失败: ${(err && err.message) || 'unknown'}`);
    return { modelChoices: [], preferredIssueAfterProbe: null, empty: true };
  }
}

/**
 * applyGatewayModelSelection — persist a chosen { adapter, model } as the
 * gateway preference, sync the live switch, and refresh adapters. Shared by the
 * classic CLI handler and the Ink TUI ModelPicker so selection has identical
 * side effects regardless of the front-end. Returns { tokenInfo } describing the
 * token source resolved for the selection.
 */
async function applyGatewayModelSelection(selected, options = {}) {
  const refreshTimeoutMs = Number.isFinite(options.refreshTimeoutMs)
    ? options.refreshTimeoutMs
    : 10000;
  const gateway = require('../../services/gateway/aiGateway');
  persistGatewayPreference(selected);
  // Mirror the user's explicit choice into lastVerifiedModelStore so that
  // getActiveAdapter() tier-2 resolver can restore it on the next startup,
  // even when GATEWAY_PREFERRED_ADAPTER env is set (tier 1 always wins over
  // tier 2, but the store is the authoritative "last used" record).
  try {
    const { recordLastVerifiedModel } = require('../../services/gateway/lastVerifiedModelStore');
    const adapterKey = String((selected && selected.adapter) || '').trim();
    if (adapterKey && adapterKey !== 'auto') {
      recordLastVerifiedModel({ adapter: adapterKey, model: (selected && selected.model) || null });
    }
  } catch {
    /* fail-soft: store write is best-effort */
  }
  try {
    gateway.syncModelSwitch(selected.model || null);
  } catch {
    /* best effort */
  }
  try {
    await withTimeout(gateway.refreshAdapters(), refreshTimeoutMs, 'post-select-refresh');
  } catch {
    /* best effort */
  }
  return { tokenInfo: getTokenInfoForSelection(selected) };
}

async function handleGatewaySelectModel(args = [], options = {}) {
  try {
    // Add overall timeout protection for the entire build process
    const buildTimeoutMs = Math.max(
      20000,
      parseInt(process.env.KHY_MODEL_BUILD_TIMEOUT_MS || '45000', 10) || 45000
    );

    let built;
    try {
      built = await Promise.race([
        buildGatewayModelChoices({ onNotice: printInfo, onError: printError }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('构建模型列表超时')), buildTimeoutMs)
        )
      ]);
    } catch (err) {
      if (err && err.message === '构建模型列表超时') {
        printError('模型列表构建超时，请检查网络连接和适配器配置');
        printInfo('提示: 可以尝试禁用不使用的适配器或使用 gateway status 命令');
        return;
      }
      throw err;
    }

    if (built.empty) {
      return;
    }
    const { modelChoices } = built;

    const isInteractive = !!(
      process.stdin &&
      process.stdin.isTTY &&
      process.stdout &&
      process.stdout.isTTY
    );
    const requestedAdapter = (args[0] || options.adapter || '').toLowerCase();
    const requestedModel = options.model || args[1] || '';

    // Non-interactive mode: auto-pick a model without prompting.
    if (!isInteractive) {
      let pick = null;
      if (requestedAdapter || requestedModel) {
        pick =
          modelChoices.find((c) => {
            if (!c || !c.value || c.disabled) {
              return false;
            }
            const adapterOk = !requestedAdapter || c.value.adapter === requestedAdapter;
            const modelOk = !requestedModel || c.value.model === requestedModel;
            return adapterOk && modelOk;
          }) || null;
      }
      if (!pick) {
        // Blind fallback must NOT pick the synthetic Auto sentinel entry (/goal「auto 模型」):
        // Auto is an explicit user choice, not a default. It is only selected above when
        // requestedAdapter/requestedModel === 'auto'. Gate-off → no Auto entry exists → no-op filter.
        let _isAutoValue;
        try {
          _isAutoValue = require('../../services/gateway/autoModelSelect').isAutoSelection;
        } catch {
          _isAutoValue = () => false;
        }
        pick =
          modelChoices.find((c) => c && c.value && !c.disabled && !_isAutoValue(c.value)) || null;
      }
      if (!pick) {
        printError('无可用模型可选择');
        return;
      }
      const selected = pick.value;
      const { tokenInfo } = await applyGatewayModelSelection(selected);
      printSuccess(`已选择: ${selected.model || '默认模型'} (${selected.adapter})`);
      printInfo(`可用性: ${pick.disabled ? '不可用' : '可用'}`);
      printInfo(`Token: ${tokenInfo.source} → ${tokenInfo.detail}`);
      return;
    }

    let selected = null;
    let picked = null;
    try {
      const inquirer = require('inquirer');
      const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '')
        .trim()
        .toLowerCase();
      const preferredModel = String(process.env.GATEWAY_PREFERRED_MODEL || '').trim();
      const defaultChoice = modelChoices.find((c) => {
        if (!c || !c.value || c.disabled) {
          return false;
        }
        if (!preferredAdapter) {
          return false;
        }
        if (c.value.adapter !== preferredAdapter) {
          return false;
        }
        return preferredModel ? String(c.value.model || '') === preferredModel : true;
      });

      const { selectedValue } = await promptWithReplGuard([
        {
          type: 'list',
          name: 'selectedValue',
          message: '选择模型（上下方向键选择，回车确认）:',
          choices: [
            // 组边界画 Separator（不可选中 ⇒ 不会打乱选择语义），模型行只放
            // primary + 次信息 —— 与 TUI 同一套分组/分层（共享叶子）。
            ...buildClassicInquirerChoices(modelChoices, inquirer, chalk),
            new inquirer.Separator(),
            { name: '返回', value: null },
          ],
          pageSize: Math.min(16, Math.max(8, modelChoices.length + 2)),
          default: defaultChoice ? defaultChoice.value : undefined,
          loop: false,
        },
      ]);
      if (!selectedValue) {
        printInfo('已取消模型选择');
        return;
      }
      selected = selectedValue;
      picked =
        modelChoices.find(
          (c) =>
            c &&
            c.value &&
            c.value.adapter === selected.adapter &&
            String(c.value.model || '') === String(selected.model || '')
        ) || null;
    } catch (err) {
      // User cancelled (Ctrl+C or Esc) or inquirer unavailable
      const isUserCancel =
        err &&
        (err.message === 'User force closed the prompt' ||
          err.name === 'ExitPromptError' ||
          String(err).includes('force closed'));
      if (isUserCancel) {
        console.log('');
        printInfo('已取消模型选择');
        return;
      }

      // Fallback: numeric selection for environments where inquirer is unavailable.
      // 与 inquirer 路径共用同一份显示条目 ⇒ 分组标题照画，**编号只给模型行**。
      const numeric = buildClassicNumericLines(modelChoices, chalk);
      console.log('');
      for (const line of numeric.lines) {
        console.log(line);
      }
      console.log(`  ${chalk.dim('0. 返回')}`);
      console.log('');

      const answer = await askLine(chalk.dim('  输入编号: '));
      // 编号 → choice 的映射由渲染侧给出（显示序），不再按原始下标取 ——
      // 否则归并（stableGroupOrder）后「输入 3」会落到另一个模型上。
      // 解析逻辑抽在纯函数 `resolveNumericPick` 里（可单测，见 gatewayModelChoicesLeaf.test.js）。
      const pick = resolveNumericPick(numeric, answer);
      if (!pick.ok) {
        if (pick.reason === 'cancel') {
          printInfo('已取消模型选择');
        } else if (pick.reason === 'out-of-range') {
          printError('编号超出范围');
        } else {
          printError('该模型当前不可选，请选择可用模型');
        }
        return;
      }
      picked = pick.choice;
      selected = picked.value;
    }

    // Save selection to .env and apply (sync + refresh) via the shared helper.
    const { tokenInfo } = await applyGatewayModelSelection(selected);

    printSuccess(`已选择: ${selected.model || '默认模型'} (${selected.adapter})`);
    const selectedChoice = modelChoices.find((c) => {
      if (!c || !c.value) {
        return false;
      }
      return (
        c.value.adapter === selected.adapter &&
        String(c.value.model || '') === String(selected.model || '')
      );
    });
    printInfo(`可用性: ${selectedChoice && selectedChoice.disabled ? '不可用' : '可用'}`);
    printInfo(`Token: ${tokenInfo.source} → ${tokenInfo.detail}`);
    console.log('');
  } finally {
    recoverGatewayPromptInput();
  }
}

/**
 * Build the model choices for a SINGLE vendor, reusing the exact same catalog
 * `/model` uses (buildGatewayModelChoices) and filtering it via the pure leaf
 * nlModelSwitchResolver. Powers the natural-language "切换模型到 <vendor>" flow
 * in both front-ends (TUI openModelPickerForVendor / classic handleModelSwitchByVendor).
 *
 * @param {object} opts
 * @param {string} opts.vendor       poolKey (e.g. 'deepseek')
 * @param {string} [opts.modelHint]  concrete model id if the user named one
 * @param {function} [opts.onNotice]
 * @param {function} [opts.onError]
 * @returns {Promise<{modelChoices:Array, directPick:(object|null), empty:boolean, vendor:string}>}
 */
async function buildVendorModelChoices({
  vendor,
  modelHint = '',
  onNotice = () => {},
  onError = () => {},
  onProgress = () => {},
} = {}) {
  const built = await buildGatewayModelChoices({ onNotice, onError, onProgress });
  if (!built || built.empty) {
    return { modelChoices: [], directPick: null, empty: true, vendor };
  }
  const leaf = require('../nlModelSwitchResolver');
  const filtered = leaf.filterModelChoices(built.modelChoices, vendor, modelHint);
  if (!filtered || filtered.length === 0) {
    onNotice(`未找到厂商 ${vendor} 的可用模型（可先运行 khy gateway status 查看通道状态）`);
    return { modelChoices: [], directPick: null, empty: true, vendor };
  }
  const directPick = leaf.resolveDirectPick(filtered, modelHint);
  return { modelChoices: filtered, directPick, empty: false, vendor };
}

/**
 * Classic-REPL entry for natural-language model switching: list a vendor's models
 * (via buildVendorModelChoices) and let the user pick, OR — when the user named a
 * concrete model that uniquely matches — apply it directly. Mirrors
 * handleGatewaySelectModel's inquirer + numeric-fallback + apply flow.
 *
 * @param {object} opts
 * @param {string} opts.vendor
 * @param {string} [opts.modelHint]
 */
async function handleModelSwitchByVendor({ vendor, modelHint = '' } = {}) {
  const hadGuard = global.__KHY_INQUIRER_ACTIVE__ === true;
  global.__KHY_INQUIRER_ACTIVE__ = true;
  try {
    const built = await buildVendorModelChoices({
      vendor,
      modelHint,
      onNotice: printInfo,
      onError: printError,
    });
    if (built.empty) {
      return;
    }
    const { modelChoices, directPick } = built;

    // Uniquely-named model → apply directly, no picker.
    if (directPick) {
      const { tokenInfo } = await applyGatewayModelSelection(directPick);
      printSuccess(`已切换: ${directPick.model || '默认模型'} (${directPick.adapter})`);
      printInfo(`Token: ${tokenInfo.source} → ${tokenInfo.detail}`);
      console.log('');
      return;
    }

    let selected = null;
    let picked = null;
    try {
      const inquirer = require('inquirer');
      const { selectedValue } = await promptWithReplGuard([
        {
          type: 'list',
          name: 'selectedValue',
          message: `选择 ${vendor} 模型（上下方向键选择，回车确认）:`,
          choices: [
            ...buildClassicInquirerChoices(modelChoices, inquirer, chalk),
            new inquirer.Separator(),
            { name: '返回', value: null },
          ],
          pageSize: Math.min(16, Math.max(8, modelChoices.length + 2)),
          loop: false,
        },
      ]);
      if (!selectedValue) {
        printInfo('已取消模型选择');
        return;
      }
      selected = selectedValue;
    } catch (err) {
      const isUserCancel =
        err &&
        (err.message === 'User force closed the prompt' ||
          err.name === 'ExitPromptError' ||
          String(err).includes('force closed'));
      if (isUserCancel) {
        console.log('');
        printInfo('已取消模型选择');
        return;
      }
      // Numeric fallback for environments where inquirer is unavailable.
      const numeric = buildClassicNumericLines(modelChoices, chalk);
      console.log('');
      for (const line of numeric.lines) {
        console.log(line);
      }
      console.log(`  ${chalk.dim('0. 返回')}`);
      console.log('');
      const answer = await askLine(chalk.dim('  输入编号: '));
      const pick = resolveNumericPick(numeric, answer);
      if (!pick.ok) {
        if (pick.reason === 'cancel') {
          printInfo('已取消模型选择');
        } else if (pick.reason === 'out-of-range') {
          printError('编号超出范围');
        } else {
          printError('该模型当前不可选，请选择可用模型');
        }
        return;
      }
      picked = pick.choice;
      selected = picked.value;
    }

    const { tokenInfo } = await applyGatewayModelSelection(selected);
    printSuccess(`已切换: ${selected.model || '默认模型'} (${selected.adapter})`);
    printInfo(`Token: ${tokenInfo.source} → ${tokenInfo.detail}`);
    console.log('');
  } finally {
    if (!hadGuard) {
      global.__KHY_INQUIRER_ACTIVE__ = false;
    }
    recoverGatewayPromptInput();
  }
}

/**
 * 经典 REPL `/model` 的**显示条目**：分组语义与行内分层都取自共享叶子
 * `cli/modelChoiceGrouping`（与 TUI `ModelPicker` 同一套 —— 同一份 modelChoices 的
 * 两个消费表面不得各写一份，否则就是第二真源）。
 *
 * 为什么这里没有 TUI 那套「模型下标 ↔ 条目下标」的桥：inquirer 的 `Separator`
 * **不可选中**（方向键会跳过它），所以「屏幕上第 n 行」与「按 n 命中」不会脱节 ——
 * 那是 ink 自己排版才有的风险（[DESIGN-ARCH-167] §2.3）。
 */
function classicDisplayEntries(modelChoices) {
  const list = Array.isArray(modelChoices) ? modelChoices : [];
  return modelChoiceGrouping.buildEntries(modelChoiceGrouping.stableGroupOrder(list), '');
}

/** 标题行的展示文本（两个经典渲染共用一处，避免 inquirer 与数字兜底各写一份）。 */
function classicSectionText(entry) {
  return `── ${entry.name} · ${entry.count} 个 ──${entry.meta ? ` ${entry.meta}` : ''}`;
}

/**
 * 经典 inquirer 列表的 choices（分组标题 → Separator；模型行 → primary + 次信息）。
 * `inquirer`/`chalk` 由调用方注入 ⇒ 本函数可单测（不必真起 inquirer）。
 */
function buildClassicInquirerChoices(modelChoices, inquirer, chalkRef) {
  const out = [];
  for (const e of classicDisplayEntries(modelChoices)) {
    if (e.kind === 'section') {
      out.push(new inquirer.Separator(chalkRef.dim(classicSectionText(e))));
      continue;
    }
    const { primary, secondary } = modelChoiceGrouping.layeredTextOf(e);
    out.push({
      name: secondary ? `${primary}  ${chalkRef.dim(secondary)}` : primary,
      value: e.choice.value,
      disabled: e.choice.disabled ? '不可选' : false,
    });
  }
  return out;
}

/**
 * 数字兜底渲染（inquirer 不可用时的环境）：标题行照画，**编号只给模型行**
 * （与 TUI「标题行不占号」同一约定），返回的 `models` 就是编号 → choice 的映射，
 * 调用方按 `models[idx-1]` 取，不再按原始下标取。
 */
function buildClassicNumericLines(modelChoices, chalkRef) {
  const lines = [];
  const models = [];
  for (const e of classicDisplayEntries(modelChoices)) {
    if (e.kind === 'section') {
      lines.push(chalkRef.dim(`  ${classicSectionText(e)}`));
      continue;
    }
    const { primary, secondary } = modelChoiceGrouping.layeredTextOf(e);
    models.push(e.choice);
    const tail = secondary ? `  ${chalkRef.dim(secondary)}` : '';
    const unavailable = e.choice.disabled ? chalkRef.dim(' (不可选)') : '';
    lines.push(`  ${chalkRef.white(`${models.length}.`)} ${primary}${tail}${unavailable}`);
  }
  return { lines, models };
}

/**
 * 把「用户在数字兜底里输入的编号」解析成一条 choice —— **纯函数**（不打印、不退出、不 IO）。
 *
 * 为什么单独抽出来：这是经典路径上**唯一**把「屏幕上的编号」接回「模型」的那一步，
 * 判据必须挂在它身上。原先它是两处内联的 3 行（`picked = numeric.models[idx - 1]`），
 * 没有任何测试覆盖 —— 改回 `modelChoices[idx - 1]` 不会让任何断言变红，而症状恰好是
 * 本方案的主题：「屏幕上写 3.」与「按 3 选中」脱节（[DESIGN-ARCH-167] §9-16）。
 *
 * 判据：编号活在**显示序**上 —— `models` 由 `buildClassicNumericLines` 给出（归并后的序），
 * **不是**原始 `modelChoices` 的下标。
 *
 * @param {{models:Array}} numeric `buildClassicNumericLines` 的返回值
 * @param {*} rawAnswer 用户输入（字符串/数字/null）
 * @returns {{ok:true, choice:object} | {ok:false, reason:'cancel'|'out-of-range'|'disabled'}}
 */
function resolveNumericPick(numeric, rawAnswer) {
  const models = numeric && Array.isArray(numeric.models) ? numeric.models : [];
  const idx = Number.parseInt(String(rawAnswer == null ? '' : rawAnswer).trim(), 10);
  if (!Number.isFinite(idx) || idx === 0) {
    return { ok: false, reason: 'cancel' };
  }
  if (idx < 1 || idx > models.length) {
    return { ok: false, reason: 'out-of-range' };
  }
  const choice = models[idx - 1];
  if (!choice || choice.disabled) {
    return { ok: false, reason: 'disabled' };
  }
  return { ok: true, choice };
}

module.exports = {
  buildGatewayModelChoices,
  applyGatewayModelSelection,
  handleGatewaySelectModel,
  buildVendorModelChoices,
  handleModelSwitchByVendor,
  getLastSelectableKeys,
  isSelectableNow,
  setGatewayModelChoicesDeps,
  // 纯函数，导出给单测（真起 inquirer 才能验的东西不该只能靠手测）
  buildClassicInquirerChoices,
  buildClassicNumericLines,
  resolveNumericPick,
};
