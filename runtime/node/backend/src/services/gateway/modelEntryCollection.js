'use strict';

/**
 * 模型列表**采集**的单一真源。
 *
 * 桌面端（Electron host）与终端（CLI / Ink TUI）此前各写一套采集：终端在
 * cli/handlers/gatewayModelChoices.js 的 buildGatewayModelChoices 里探全部启用
 * 通道、判可用性、跑可靠性裁剪；桌面端 apps/khyos-desktop/src/host/index.ts 的
 * listModelOptions 只把静态预置表投影出来、不探活。于是同一个模型在两边
 * 「可不可选、归哪组、叫什么」全不一致。
 *
 * 本叶做「决策 + 原始数据采集」，**不出任何呈现**：返回的 entry 只有原始字段与
 * 纯文本 display（composeModelDisplay 产出），没有 chalk、没有 name/primary/
 * secondary 的彩色串。呈现由各表面自理——终端用 cli/handlers/gateway.js 的四个
 * chalk 格式化器组装（画面字节不变），桌面映射成 ModelOption。
 *
 * 无 cli 层依赖：不 require chalk / inquirer / readline / ./proxy。终端专属的
 * switch-center 同步经 `beforeCollect` 钩子由调用方注入，桌面端可注入同一个
 * 函数以保持初始化序列一致（cli/handlers/proxy.js 的 require 图只有
 * chalk/formatters/http，可安全进 Electron 主进程）。
 */

const {
  STRICT_OPERATIONAL_ADAPTERS,
  isAdapterOperational,
  _filterModelsByReliability,
  shouldTreatGenerationFailureAsWarning,
  _classifyHiddenReason,
  _shouldRetryProbeByDebounce,
  _isTransientProbeLikeReason,
  _isTimeoutLikeReason,
  _compactReasonText,
  composeModelDisplay,
  FILTER_REASON_LABELS,
} = require('./modelOperationality');

// ── 探测时限常量（只在此声明一次；gateway.js 的其它路径 re-import）───────────
const MODEL_DEEP_PROBE_CACHE_MS = Math.max(
  10000,
  parseInt(process.env.KHY_MODEL_DEEP_PROBE_CACHE_MS || '300000', 10) || 300000
);
const KIRO_PROBE_TIMEOUT_MS = Math.max(
  8000,
  parseInt(process.env.KHY_MODEL_KIRO_PROBE_TIMEOUT_MS || '20000', 10) || 20000
);
const KIRO_MODEL_LIST_TIMEOUT_MS = Math.max(
  KIRO_PROBE_TIMEOUT_MS,
  parseInt(process.env.KHY_MODEL_KIRO_LIST_TIMEOUT_MS || '25000', 10) || 25000
);

function getAdapterProbeTimeoutMs(adapterType, fallbackMs) {
  const type = String(adapterType || '').toLowerCase();
  if (type === 'kiro') {
    return Math.max(fallbackMs, KIRO_PROBE_TIMEOUT_MS);
  }
  return fallbackMs;
}

function getAdapterModelListTimeoutMs(adapterType, fallbackMs) {
  const type = String(adapterType || '').toLowerCase();
  if (type === 'kiro') {
    return Math.max(fallbackMs, KIRO_MODEL_LIST_TIMEOUT_MS);
  }
  return fallbackMs;
}

// 深测缓存 + in-flight 表：终端与桌面共用同一份，避免两边对同一通道各测一遍。
const _modelDeepProbeCache = new Map(); // key: adapter type -> { at, test }
const _modelDeepProbeInFlight = new Map();

function _getDeepProbeCache(adapterType) {
  const key = String(adapterType || '').toLowerCase();
  if (!key) {
    return null;
  }
  const entry = _modelDeepProbeCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.at > MODEL_DEEP_PROBE_CACHE_MS) {
    _modelDeepProbeCache.delete(key);
    return null;
  }
  return entry;
}

function _setDeepProbeCache(adapterType, test) {
  const key = String(adapterType || '').toLowerCase();
  if (!key) {
    return;
  }
  _modelDeepProbeCache.set(key, { at: Date.now(), test });
}

// 与 utils/withTimeout 的「只 resolve 不 reject」契约不同：探测要的是「到点即失败」，
// 才能让 Promise.race 在整体超时后继续用已到手的结果，故此处保留 reject 语义。
async function withTimeout(promise, ms, label = 'operation') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const EMPTY_RESULT = {
  entries: [],
  diagnostics: {
    hiddenAdapters: [],
    skippedUnavailableAdapters: 0,
    generationWarnCount: 0,
    filteredModelCount: 0,
    filteredModelReasonCount: {},
    debounceRetried: 0,
    debounceRecovered: 0,
    backgroundDeepProbeStarted: 0,
  },
  auto: null,
  preferredIssueAfterProbe: null,
  empty: true,
};

/**
 * 采集可执行的模型条目。
 *
 * @param {object} opts
 * @param {object} opts.gateway aiGateway 实例（必须已可调 getStatus/testAdapter/listModels）
 * @param {(msg:string)=>void} [opts.onNotice] 诊断/进度旁白（原样转发，终端据此打印）
 * @param {(msg:string)=>void} [opts.onError]
 * @param {(p:object)=>void} [opts.onProgress] {kind:'stage'|'count', current, total, label}
 * @param {()=>Promise<object|null>} [opts.beforeCollect] 探测前的初始化钩子（终端传 switch-center 同步）
 * @param {boolean} [opts.quickFailMode]
 * @returns {Promise<{entries:Array, diagnostics:object, auto:object|null, preferredIssueAfterProbe:object|null, empty:boolean}>}
 */
async function collectModelEntries({
  gateway,
  onNotice = () => {},
  onError = () => {},
  onProgress = () => {},
  beforeCollect = null,
  quickFailMode = String(process.env.KHY_MODEL_QUICK_FAIL || 'false').toLowerCase() === 'true',
} = {}) {
  const diagnostics = {
    hiddenAdapters: [],
    skippedUnavailableAdapters: 0,
    generationWarnCount: 0,
    filteredModelCount: 0,
    filteredModelReasonCount: {},
    debounceRetried: 0,
    debounceRecovered: 0,
    backgroundDeepProbeStarted: 0,
  };
  if (!gateway || typeof gateway.getStatus !== 'function') {
    onError('无已启用 AI 通道');
    return { ...EMPTY_RESULT, diagnostics };
  }

  try {
    // Phase-start markers: use 'stage' kind for multi-phase init sequence.
    // These show as ●●●○○ Step N/5 — honest about which phase we're in.
    onProgress({ kind: 'stage', current: 1, total: 5, label: '初始化网关' });
    onNotice('正在初始化网关...');

    if (!quickFailMode) {
      if (beforeCollect) {
        onProgress({ kind: 'stage', current: 2, total: 5, label: '同步 switch-center' });
        onNotice('正在同步 switch-center...');
      }
      const autoSync = beforeCollect
        ? await withTimeout(
            Promise.resolve().then(() => beforeCollect('gateway-model')),
            10000,
            'switch-center-sync'
          ).catch(() => null)
        : null;

      if (!gateway.isInitialized()) {
        onProgress({ kind: 'stage', current: 3, total: 5, label: '初始化网关适配器' });
        onNotice('正在初始化网关适配器...');
        await withTimeout(gateway.init(), 15000, 'gateway-init').catch((err) => {
          onNotice(`网关初始化失败: ${err?.message || 'unknown'}`);
        });
      }

      if (autoSync && autoSync.synced && (autoSync.changed || autoSync.activeChanged)) {
        try {
          onProgress({ kind: 'stage', current: 4, total: 5, label: '刷新适配器' });
          onNotice('正在刷新适配器...');
          await withTimeout(gateway.refreshAdapters(), 15000, 'refresh-adapters');
        } catch {
          /* best effort */
        }
        onNotice(
          `已自动同步 switch-center: ${autoSync.profileName || autoSync.profileId || 'trae-auto'} (${autoSync.modelsCount || 0} models)`
        );
      }
    } else {
      onProgress({ kind: 'stage', current: 3, total: 5, label: '快速初始化' });
      onNotice('快速失败模式：跳过耗时初始化');
      // Ensure gateway is at least minimally initialized
      if (!gateway.isInitialized()) {
        try {
          await Promise.race([
            gateway.init(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('init timeout')), 3000))
          ]);
        } catch {
          onNotice('快速初始化失败，使用当前状态');
        }
      }
    }

    onProgress({ kind: 'stage', current: 5, total: 5, label: '获取适配器状态' });
    onNotice('正在获取适配器状态...');
    const statuses = gateway.getStatus();
    const enabledAdapters = statuses.filter((s) => s.enabled);
    const verboseAdapterDetails =
      String(process.env.KHY_MODEL_VERBOSE_ADAPTER_DETAILS || 'false').toLowerCase() === 'true';

    if (enabledAdapters.length === 0) {
      onError('无已启用 AI 通道');
      return { ...EMPTY_RESULT, diagnostics };
    }

    if (verboseAdapterDetails) {
      const traeStatus = statuses.find((s) => String(s.type || '').toLowerCase() === 'trae');
      if (traeStatus && traeStatus.tokenPath) {
        onNotice(`Trae token 位置: ${traeStatus.tokenPath}`);
        const official = traeStatus.officialModels || null;
        if (official) {
          if (official.hit) {
            const endpointLabel = official.endpoint ? ` (${official.endpoint})` : '';
            onNotice(
              `Trae 官方模型列表: 已命中${endpointLabel} · 官方 ${official.officialCount} / 本地 ${official.localCount} / 合并 ${official.mergedCount}`
            );
          } else {
            const reason = String(official.error || '').trim();
            onNotice(
              `Trae 官方模型列表: 未命中${reason ? ` (${reason})` : '（已回退本地发现）'}`
            );
          }
        }
      }
    }

    const preferredIssueBeforeProbe = resolvePreferredAdapterIssue(statuses, {});
    if (preferredIssueBeforeProbe && preferredIssueBeforeProbe.type === 'invalid') {
      onError(preferredIssueBeforeProbe.message);
      onNotice('当前将忽略该无效配置，并仅展示可执行通道');
    }

    // Fast probe for model-selection UX.
    // For unstable-prone adapters, include a lightweight generation probe
    // to avoid "detected but unusable" false positives in /model.
    // Reduced default timeouts to prevent hanging on unreachable adapters
    const probeTimeoutMs = Math.max(
      2000,
      parseInt(process.env.KHY_MODEL_PROBE_TIMEOUT_MS || '4000', 10) || 4000
    );
    const generationProbeTimeoutMs = Math.max(
      probeTimeoutMs,
      parseInt(process.env.KHY_MODEL_PROBE_GENERATION_TIMEOUT_MS || '8000', 10) || 8000
    );
    const strictOperationalAdapters = STRICT_OPERATIONAL_ADAPTERS;
    const twoPhaseProbeEnabled =
      String(process.env.KHY_MODEL_TWO_PHASE_PROBE || 'true').toLowerCase() !== 'false';

    // Overall timeout protection: prevent hanging when multiple adapters are slow/unreachable
    const overallTimeoutMs = Math.max(
      15000,
      parseInt(process.env.KHY_MODEL_OVERALL_TIMEOUT_MS || '30000', 10) || 30000
    );

    // UX2: 通道探测百分比进度 — 每完成一个通道就更新进度
    const totalAdapters = enabledAdapters.length;
    let probedCount = 0;
    onNotice(`检测各通道连通性（${totalAdapters} 通道，总超时 ${Math.round(overallTimeoutMs / 1000)}s）...`);
    const testResults = {};
    const strictCandidates = [];
    const testPromises = enabledAdapters.map(async (s) => {
      const adapterType = String(s.type || '').toLowerCase();
      const requireGenerationProbe = strictOperationalAdapters.has(adapterType);
      const adapterProbeTimeoutMs = getAdapterProbeTimeoutMs(adapterType, probeTimeoutMs);
      const adapterGenerationProbeTimeoutMs = Math.max(
        adapterProbeTimeoutMs,
        generationProbeTimeoutMs
      );
      if (requireGenerationProbe) {
        strictCandidates.push(s);
      }
      try {
        testResults[s.type] = await withTimeout(
          gateway.testAdapter(s.type, {
            quick: !requireGenerationProbe,
            timeoutMs: adapterProbeTimeoutMs,
            probeGenerationTimeoutMs: adapterGenerationProbeTimeoutMs,
          }),
          Math.max(adapterProbeTimeoutMs + 1000, adapterGenerationProbeTimeoutMs + 1000),
          `${s.type} probe`
        );
      } catch (err) {
        testResults[s.type] = {
          connectivity: {
            success: false,
            latencyMs: adapterProbeTimeoutMs,
            error: err && err.message ? err.message : 'probe failed',
          },
        };
      } finally {
        probedCount++;
        const pct = totalAdapters > 0 ? (probedCount / totalAdapters) * 100 : 100;
        const latency = testResults[s.type]?.connectivity?.latencyMs;
        const ok = testResults[s.type]?.connectivity?.success;
        const statusIcon = ok ? '✓' : '✗';
        onNotice(`  [${probedCount}/${totalAdapters} ${pct.toFixed(1).padStart(5)}%] ${statusIcon} ${s.type}${latency ? ` (${latency}ms)` : ''}`);
        // Real count: probedCount / totalAdapters
        onProgress({ kind: 'count', current: probedCount, total: totalAdapters, label: `探测 ${s.type}` });
      }
    });

    // Race all probes against overall timeout
    try {
      await Promise.race([
        Promise.all(testPromises),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('overall timeout')), overallTimeoutMs)
        )
      ]);
    } catch (err) {
      if (err && err.message === 'overall timeout') {
        onNotice('部分通道探测超时，显示当前可用结果');
        // Continue with whatever results we have so far
      } else {
        throw err;
      }
    }
    const preferredIssueAfterProbe = resolvePreferredAdapterIssue(enabledAdapters, testResults);

    let debounceRetried = 0;
    let debounceRecovered = 0;
    if (MODEL_PROBE_DEBOUNCE_ENABLED) {
      const retryCandidates = enabledAdapters.filter((s) => {
        const firstTest = testResults[s.type];
        if (isAdapterOperational(s, firstTest, strictOperationalAdapters)) {
          return false;
        }
        return _shouldRetryProbeByDebounce(s, firstTest);
      });
      if (retryCandidates.length > 0) {
        debounceRetried = retryCandidates.length;
        diagnostics.debounceRetried = debounceRetried;
        await Promise.all(
          retryCandidates.map(async (s) => {
            const adapterType = String(s.type || '').toLowerCase();
            const requireGenerationProbe = strictOperationalAdapters.has(adapterType);
            const adapterProbeTimeoutMs = getAdapterProbeTimeoutMs(adapterType, probeTimeoutMs);
            const adapterGenerationProbeTimeoutMs = Math.max(
              adapterProbeTimeoutMs,
              generationProbeTimeoutMs
            );
            for (let attempt = 1; attempt <= MODEL_PROBE_DEBOUNCE_MAX_RETRIES; attempt++) {
              if (MODEL_PROBE_DEBOUNCE_DELAY_MS > 0) {
                const waitMs = MODEL_PROBE_DEBOUNCE_DELAY_MS * attempt;
                await new Promise((resolve) => setTimeout(resolve, waitMs));
              }
              try {
                const retried = await withTimeout(
                  gateway.testAdapter(s.type, {
                    quick: !requireGenerationProbe,
                    timeoutMs: adapterProbeTimeoutMs,
                    probeGenerationTimeoutMs: adapterGenerationProbeTimeoutMs,
                  }),
                  Math.max(adapterProbeTimeoutMs + 1000, adapterGenerationProbeTimeoutMs + 1000),
                  `${s.type} debounce-probe`
                );
                testResults[s.type] = retried;
                if (isAdapterOperational(s, retried, strictOperationalAdapters)) {
                  debounceRecovered += 1;
                  break;
                }
                if (!_shouldRetryProbeByDebounce(s, retried)) {
                  break;
                }
              } catch (err) {
                testResults[s.type] = {
                  connectivity: {
                    success: false,
                    latencyMs: adapterProbeTimeoutMs,
                    error: err && err.message ? err.message : 'debounce probe failed',
                  },
                };
              }
            }
          })
        );
        diagnostics.debounceRecovered = debounceRecovered;
      }
    }

    let backgroundDeepProbeStarted = 0;
    if (twoPhaseProbeEnabled && strictCandidates.length > 0) {
      for (const s of strictCandidates) {
        const adapterType = String(s.type || '').toLowerCase();
        const currentGeneration = testResults[s.type]?.generation || null;
        if (currentGeneration?.success) {
          continue;
        }
        if (
          currentGeneration &&
          !_isTransientProbeLikeReason(String(currentGeneration.error || ''))
        ) {
          continue;
        }
        const cached = _getDeepProbeCache(adapterType);
        if (cached && cached.test && cached.test.generation) {
          const cachedGeneration = cached.test.generation;
          // Prefer fresh live probe result; only use cache when it can improve confidence.
          if (!currentGeneration || (cachedGeneration?.success && !currentGeneration.success)) {
            testResults[s.type] = {
              ...(testResults[s.type] || {}),
              generation: cachedGeneration,
            };
          }
          continue;
        }
        if (_modelDeepProbeInFlight.has(adapterType)) {
          continue;
        }
        backgroundDeepProbeStarted += 1;
        diagnostics.backgroundDeepProbeStarted = backgroundDeepProbeStarted;
        const deepTask = (async () => {
          try {
            const adapterProbeTimeoutMs = getAdapterProbeTimeoutMs(s.type, probeTimeoutMs);
            const adapterGenerationProbeTimeoutMs = Math.max(
              adapterProbeTimeoutMs,
              generationProbeTimeoutMs
            );
            const deep = await withTimeout(
              gateway.testAdapter(s.type, {
                quick: false,
                timeoutMs: adapterProbeTimeoutMs,
                probeGenerationTimeoutMs: adapterGenerationProbeTimeoutMs,
              }),
              Math.max(adapterProbeTimeoutMs + 3000, adapterGenerationProbeTimeoutMs + 3000),
              `${s.type} deep-probe`
            );
            _setDeepProbeCache(adapterType, deep);
          } catch (err) {
            _setDeepProbeCache(adapterType, {
              connectivity: {
                success: false,
                error: err && err.message ? err.message : 'deep probe failed',
              },
              generation: {
                success: false,
                error: err && err.message ? err.message : 'deep probe failed',
              },
            });
          } finally {
            _modelDeepProbeInFlight.delete(adapterType);
          }
        })();
        _modelDeepProbeInFlight.set(adapterType, deepTask);
        deepTask.catch(() => {});
      }
    }

    // Collect models from all available adapters with indicators
    onProgress({ kind: 'count', current: 0, total: enabledAdapters.length, label: '获取模型列表' });
    const entries = [];
    let listedCount = 0;
    for (const s of enabledAdapters) {
      const test = testResults[s.type];
      const adapterOk = isAdapterOperational(s, test);
      if (!adapterOk) {
        diagnostics.skippedUnavailableAdapters += 1;
        diagnostics.hiddenAdapters.push({
          name: s.name || s.type,
          type: s.type,
          reason: _classifyHiddenReason(s, test),
        });
        continue;
      }
      const generationWarn = !!(
        test?.generation &&
        !test.generation.success &&
        shouldTreatGenerationFailureAsWarning(s.type)
      );
      if (generationWarn) {
        diagnostics.generationWarnCount += 1;
      }
      const base = {
        adapter: { type: s.type, name: s.name || s.type },
        generationWarn,
        generationError: generationWarn ? String(test.generation.error || '实测告警') : '',
        latencyMs: Number(test?.connectivity?.latencyMs) || 0,
        disabled: false,
      };

      let listModelsErr;
      try {
        const modelListTimeoutMs = getAdapterModelListTimeoutMs(
          s.type,
          Math.max(3000, probeTimeoutMs)
        );
        const models = await withTimeout(
          gateway.listModels(s.type),
          modelListTimeoutMs,
          `${s.type} listModels`
        );
        if (models && models.length > 0) {
          const reliabilityFiltered = _filterModelsByReliability(s, test, models);
          if (reliabilityFiltered.filtered > 0) {
            diagnostics.filteredModelCount += reliabilityFiltered.filtered;
            for (const reason of reliabilityFiltered.reasons) {
              diagnostics.filteredModelReasonCount[reason] =
                (diagnostics.filteredModelReasonCount[reason] || 0) + 1;
            }
          }
          for (const m of reliabilityFiltered.models) {
            entries.push({
              ...base,
              kind: 'model',
              model: m,
              group: composeModelDisplay({
                model: m,
                adapterName: s.name,
                adapterType: s.type,
              }).group,
              display: composeModelDisplay({ model: m, adapterName: s.name, adapterType: s.type }),
              value: { adapter: s.type, model: m.id },
            });
          }
        } else {
          // Adapter available but no model list (e.g. relay)
          entries.push({
            ...base,
            kind: 'default-model',
            note: 'no-models',
            model: null,
            group: s.name || s.type,
            display: {
              primary: s.name || s.type,
              secondary: '(默认模型)',
              group: s.name || s.type,
            },
            value: { adapter: s.type, model: null },
          });
        }
        listedCount++;
      } catch (err) {
        listedCount++;
        listModelsErr = err;
      } finally {
        onProgress({ kind: 'count', current: listedCount, total: enabledAdapters.length, label: '获取模型列表' });
        const reasonText = listModelsErr && listModelsErr.message ? listModelsErr.message : 'listModels failed';
        if (String(s.type || '').toLowerCase() === 'kiro' && _isTimeoutLikeReason(reasonText)) {
          // Keep Kiro selectable when model listing is slow; selection still works
          // and runtime can refresh models in background.
          entries.push({
            ...base,
            kind: 'default-model',
            note: 'list-timeout',
            model: null,
            group: s.name || s.type,
            display: {
              primary: s.name || s.type,
              secondary: '(模型列表超时，使用默认模型)',
              group: s.name || s.type,
            },
            value: { adapter: s.type, model: null },
          });
          diagnostics.hiddenAdapters.push({
            name: s.name || s.type,
            type: s.type,
            reason: `模型列表超时，已保留默认模型入口: ${_compactReasonText(reasonText)}`,
          });
          continue;
        }
        if (listModelsErr) {
          diagnostics.skippedUnavailableAdapters += 1;
          diagnostics.hiddenAdapters.push({
            name: s.name || s.type,
            type: s.type,
            reason: _classifyHiddenReason(s, test, reasonText),
          });
        }
      }
    }

    // ── 外部智能体模型投影(自动发现 opencode / claude-code 已配置的模型,复用其配置)──
    // 投影为 `<模型>(opencode)` / `<模型>(claudecode)`,选中后路由到对应 gateway 适配器:
    //   · opencode    → opencodeAdapter(指挥 `opencode run`,读它自己的 opencode.json)
    //   · claude-code → claudeAdapter(会话内先采纳其 env,复用同款 endpoint/token/model)
    // khy 不需要替用户重复配置 endpoint/key——各自 agent 的配置文件就是真源。
    try {
      const projection = require('./agentModelProjection');
      // 采纳 claude-code env + opencode 便携配置定位,让对应适配器在本会话即可调出配置同款模型。
      try {
        projection.ensureClaudeCodeEnv(process.env);
      } catch {
        /* fail-soft */
      }
      try {
        projection.ensureOpenCodeEnv(process.env);
      } catch {
        /* fail-soft */
      }
      const proj = projection.discover(process.env);
      if (proj.ok && Array.isArray(proj.models) && proj.models.length) {
        // 只投影其 gateway 适配器通道**已启用**的智能体模型,避免展示「选中但不可调用」的入口。
        const enabledTypes = new Set(
          enabledAdapters.map((s) => String(s.type || '').trim().toLowerCase())
        );
        const projectedShown = proj.models.filter(
          (pm) => enabledTypes.has(String(pm.adapter || '').trim().toLowerCase())
        );
        for (const pm of projectedShown) {
          const connPlain = pm.protocol === 'anthropic' ? '中继' : '直连';
          const keyPlain = pm.hasKey ? '● ready' : '● 未含 key';
          entries.push({
            kind: 'external-agent',
            adapter: { type: pm.adapter, name: pm.adapter },
            model: pm.model,
            generationWarn: false,
            generationError: '',
            latencyMs: 0,
            group: pm.adapter,
            display: {
              primary: pm.name || pm.model,
              secondary: `${connPlain} ${keyPlain}`.trim(),
              group: pm.adapter,
            },
            // 投影行没有 per-adapter 探测状态，组级三件套里只有 key 就绪度可挂。
            connPlain,
            keyPlain,
            value: { adapter: pm.adapter, model: pm.model },
            disabled: false,
            externalAgent: true,
          });
        }
      }
    } catch {
      /* fail-soft: 投影失败绝不影响主线模型列表 */
    }

    if (entries.length === 0) {
      onNotice('当前无可执行模型可选（已过滤未通过实测的通道）');
      if (preferredIssueAfterProbe && preferredIssueAfterProbe.type === 'unavailable') {
        onNotice(preferredIssueAfterProbe.message);
        onNotice('可先运行 khy gateway status 查看失败细节，再切换到可执行通道');
      }
      return { entries: [], diagnostics, auto: null, preferredIssueAfterProbe, empty: true };
    }

    // 诊断脚注：终端打印、桌面展示，两边同一批文案（不再只有终端说实话）。
    emitDiagnostics(diagnostics, {
      enabledAdapters,
      twoPhaseProbeEnabled,
      preferredIssueAfterProbe,
      onNotice,
    });

    // 模型列表顶部增设可选「Auto」入口(/goal「khy 在模型列表下设置一个 auto 模型」)。
    // 门控 KHY_AUTO_MODEL_SELECT 默认开。这里只产出**决策数据**（预览模型、四档规格），
    // 具体画几行、怎么上色由各表面自理——终端仍调 autoModelSelect.buildAutoChoice /
    // buildModeChoices，桌面渲染自己的 Auto 行。
    const auto = collectAutoSpec(entries);

    onProgress({ kind: 'count', current: 100, total: 100, label: '完成' });

    return { entries, diagnostics, auto, preferredIssueAfterProbe, empty: false };
  } catch (err) {
    onError(`构建模型列表失败: ${(err && err.message) || 'unknown'}`);
    return { ...EMPTY_RESULT, diagnostics };
  }
}

/**
 * 诊断脚注：隐藏了几个通道、过滤了几个模型及原因。终端打印、桌面展示，
 * 两边同一批文案——此前只有终端说实话，桌面把「为什么某些模型不见了」整个吞掉。
 */
function emitDiagnostics(diagnostics, ctx) {
  const { enabledAdapters, twoPhaseProbeEnabled, preferredIssueAfterProbe, onNotice } = ctx;
  if (diagnostics.skippedUnavailableAdapters > 0) {
    onNotice(
      `已隐藏 ${diagnostics.skippedUnavailableAdapters} 个未通过实测的通道（可用 khy gateway status 查看详情）`
    );
    const shown = [];
    const seen = new Set();
    for (const item of diagnostics.hiddenAdapters) {
      const key = `${String(item.type || '').toLowerCase()}|${String(item.reason || '').toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      shown.push(item);
      if (shown.length >= 3) {
        break;
      }
    }
    for (const item of shown) {
      onNotice(`  - ${item.name} (${item.type}): ${item.reason}`);
    }
    if (diagnostics.hiddenAdapters.length > shown.length) {
      onNotice(
        `  - 其余 ${diagnostics.hiddenAdapters.length - shown.length} 个通道请用 khy gateway status 查看完整原因`
      );
    }
  }
  if (preferredIssueAfterProbe && preferredIssueAfterProbe.type === 'unavailable') {
    onNotice(preferredIssueAfterProbe.message);
  }
  if (diagnostics.generationWarnCount > 0) {
    onNotice(`探测告警 ${diagnostics.generationWarnCount} 项：为快速健康探测结果，不等同于运行时必然失败`);
  }
  if (diagnostics.filteredModelCount > 0) {
    const reasonSummary = Object.keys(diagnostics.filteredModelReasonCount)
      .map(
        (key) =>
          `${FILTER_REASON_LABELS[key] || key}×${diagnostics.filteredModelReasonCount[key]}`
      )
      .join('，');
    onNotice(`已过滤 ${diagnostics.filteredModelCount} 个低置信模型（${reasonSummary || '默认可靠性策略'}）`);

    // Smart adapter suggestion: if Claude models were filtered due to cross-provider,
    // suggest switching to claude adapter
    if (diagnostics.filteredModelReasonCount['cross-provider-claude'] > 0) {
      const claudeAdapterAvailable = enabledAdapters.find(
        (s) => String(s.type || '').toLowerCase() === 'claude' && s.available
      );
      if (claudeAdapterAvailable) {
        onNotice(`提示: 若需使用 Claude Opus 4.8/4.7 等模型，可切换到 Claude 适配器`);
        onNotice(`   快速切换: export GATEWAY_PREFERRED_ADAPTER=claude && khy`);
      }
    }
  }
  if (diagnostics.debounceRetried > 0) {
    onNotice(`防抖复检: 已复检 ${diagnostics.debounceRetried} 个抖动通道，恢复 ${diagnostics.debounceRecovered} 个`);
  }
  if (twoPhaseProbeEnabled && diagnostics.backgroundDeepProbeStarted > 0) {
    onNotice(
      `已启动 ${diagnostics.backgroundDeepProbeStarted} 个后台深测任务（strict 通道），下次 /model 会显示更准确告警`
    );
  }
}

/**
 * Auto / 模式轴的决策数据。[DESIGN-ARCH-185] §4.4：模式轴开启时产出四行规格
 * (Auto/极致/性能/经济)，关 → 单行 Auto。档名不在此硬编码，一律取 routingMode 的档位卡。
 */
function collectAutoSpec(entries) {
  try {
    const autoSelect = require('./autoModelSelect');
    if (!autoSelect.isEnabled()) {
      return null;
    }
    const selectable = entries.filter((e) => e && e.value && !e.disabled && e.value.model);
    if (selectable.length === 0) {
      return null;
    }
    const modelTier = require('../modelTier');
    const candidates = selectable.map((e) => ({
      model: e.value.model,
      adapter: e.value.adapter,
      tier: modelTier.resolveTier(e.value.model),
    }));

    let routingMode = null;
    try {
      const rm = require('./routingMode');
      if (rm.isEnabled()) routingMode = rm;
    } catch {
      /* 模式轴不可用 → 退回单行 Auto */
    }

    if (routingMode) {
      const card = routingMode._loadCard();
      const currentName = routingMode.currentModeName();
      // §14-D11：钉选时模式轴整体旁路，四行档画出来可选却不生效 ⇒ 置灰并说明原因。
      // 顺带**不**再给「当前最优」预览：那一行会声称某模型将被选中，而档根本不会生效。
      const inert = routingMode.pinnedBypass();
      const inertNote = inert
        ? `已钉选${
            String(process.env.GATEWAY_PREFERRED_MODEL || '').trim() &&
            String(process.env.GATEWAY_PREFERRED_MODEL).trim().toLowerCase() !== 'auto'
              ? '模型'
              : '渠道'
          } · 档位不生效`
        : '';
      // 档名列表**不在这儿硬编码**：§7-① 说档位卡是档名/floor/ceiling 的唯一真源，
      // 而 `if (!mode) continue` 会让「卡里改了名」的这一档在选择器里静默消失——
      // 硬编码 ORDER 就是一条第二条真源，卡与画面会分叉且没有测试会红。
      const ORDER = routingMode.listModes({ card });
      const specs = [];
      for (const entry of ORDER) {
        const mode = routingMode.resolveMode(entry.key, { card });
        if (!mode) continue;
        const hint = routingMode.costHintOf(mode, candidates);
        let preview = '';
        if (!inert) {
          try {
            const picked = autoSelect.rankAutoModels('conversation', candidates, {
              band: { floorIdx: mode.floorIdx, ceilingIdx: mode.ceilingIdx },
              max: 1,
            });
            preview = picked && picked[0] ? picked[0].model : '';
          } catch {
            /* 无预览不阻断 */
          }
        }
        specs.push({
          key: entry.key,
          label: mode.label,
          intent: mode.intent,
          costHint: hint.label,
          preview,
          current: entry.key === currentName,
        });
      }
      return {
        kind: 'mode-axis',
        inert,
        inertNote,
        modes: specs,
        previewModel: '',
      };
    }

    const preview = autoSelect.pickAutoModel('conversation', candidates);
    return {
      kind: 'single-auto',
      inert: false,
      inertNote: '',
      modes: [],
      previewModel: preview && preview.model ? preview.model : '',
    };
  } catch {
    /* fail-soft: no Auto entry, picker unchanged */
    return null;
  }
}

/**
 * 首选通道配置诊断（从 cli/handlers/gateway.js 随采集一并迁入，桌面与终端同一判据）。
 * STRICT 是**放大器**([DESIGN-ARCH-136] 第 3 期)：单通道不可用只损失一个通道，但 STRICT
 * 未显式关闭时会抑制回退，把「该通道不可用」升级成「每轮 AI 调用必然硬失败」。
 */
function resolvePreferredAdapterIssue(statuses = [], testResults = {}) {
  const configuredRaw = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim();
  const configured = configuredRaw.toLowerCase();
  if (!configured || configured === 'auto') {
    return null;
  }
  const strict =
    String(process.env.GATEWAY_PREFERRED_STRICT || '')
      .trim()
      .toLowerCase() !== 'false';
  const matched = Array.isArray(statuses)
    ? statuses.find(
        (s) =>
          String(s?.type || '')
            .trim()
            .toLowerCase() === configured
      )
    : null;
  if (!matched) {
    return {
      type: 'invalid',
      configured: configuredRaw,
      strict,
      message: `首选通道配置错误: "${configuredRaw}" 未注册`,
    };
  }

  const test = testResults && typeof testResults === 'object' ? testResults[matched.type] : null;
  const reason = _compactReasonText(
    test?.generation?.error ||
      test?.models?.error ||
      test?.connectivity?.error ||
      matched.detail ||
      ''
  );
  if (!matched.enabled || !matched.available) {
    return {
      type: 'unavailable',
      configured: configuredRaw,
      strict,
      adapterType: matched.type,
      reason,
      message: reason
        ? `首选通道当前不可用: ${matched.type}（${reason}）`
        : `首选通道当前不可用: ${matched.type}`,
    };
  }
  return null;
}

const MODEL_PROBE_DEBOUNCE_ENABLED =
  String(process.env.KHY_MODEL_PROBE_DEBOUNCE || 'true').toLowerCase() !== 'false';
const MODEL_PROBE_DEBOUNCE_MAX_RETRIES = Math.max(
  1,
  parseInt(process.env.KHY_MODEL_PROBE_DEBOUNCE_RETRIES || '2', 10) || 2
);
const MODEL_PROBE_DEBOUNCE_DELAY_MS = Math.max(
  0,
  parseInt(process.env.KHY_MODEL_PROBE_DEBOUNCE_DELAY_MS || '600', 10) || 600
);

module.exports = {
  collectModelEntries,
  collectAutoSpec,
  resolvePreferredAdapterIssue,
  getAdapterProbeTimeoutMs,
  getAdapterModelListTimeoutMs,
  _getDeepProbeCache,
  _setDeepProbeCache,
  withTimeout,
  FILTER_REASON_LABELS,
};
