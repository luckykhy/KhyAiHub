/**
 * Prefetch Orchestration — parallel startup tasks and deferred background work.
 *
 * parallelPrefetch()  — runs during init/setup phase (before REPL prompt).
 * deferredPrefetch()  — runs after REPL prompt is displayed (user can type).
 *
 * Consolidates the scattered setTimeout chains from repl.js into a single
 * managed module.  Returns timer IDs so they can be cancelled on shutdown.
 *
 * Usage:
 *   const { parallelPrefetch, deferredPrefetch } = require('./prefetch');
 *   await parallelPrefetch({ mode: 'khyquant' });
 *   const timers = deferredPrefetch({ mode: 'khyquant', onOutput, isBusy });
 */

const { checkpoint } = require('./startupProfiler');

/**
 * Run critical prefetch tasks in parallel during startup.
 * Each task is individually error-isolated.
 *
 * @param {{ mode?: string }} options
 */
async function parallelPrefetch(options = {}) {
  const { mode = 'khyquant' } = options;
  checkpoint('prefetch:parallel:start');

  const tasks = [];

  // Hardware profile detection (both modes)
  tasks.push(
    (async () => {
      try {
        const hw = require('../services/hardwareProfileService');
        hw.detectProfile();
      } catch {
        /* non-critical */
      }
    })()
  );

  if (mode === 'khyquant') {
    // Network detector (full mode only)
    tasks.push(
      (async () => {
        try {
          const networkDetector = require('../services/networkDetector');
          await networkDetector.init();
        } catch {
          /* non-critical */
        }
      })()
    );

    // Cache service warmup (full mode only)
    tasks.push(
      (async () => {
        try {
          const cache = require('../services/cacheService');
          await cache.getStats();
        } catch {
          /* non-critical */
        }
      })()
    );
  }

  await Promise.allSettled(tasks);
  checkpoint('prefetch:parallel:done');

  // 会话临时目录：创建 + 注册退出清理
  try {
    const { ensureSessionTmpDir, cleanupSessionTmpDir } = require('../tools/platformUtils');
    ensureSessionTmpDir();
    const { addShutdownHook } = require('./shutdown');
    addShutdownHook('session-tmpdir', cleanupSessionTmpDir);
  } catch {
    /* non-critical */
  }
}

/**
 * 3s 档的启动清理：跑清理 → （低余量时不起周期 timer）→ 体积自检 → 实际动作播报。
 *
 * 抽成模块级函数只为压平 RUNNERS 闭包里的缩进（COMP-001 嵌套棘轮），执行顺序与
 * fail-soft 语义和原内联实现逐行一致。`emit` / `emitFootprintNotice` 由调用方注入
 * —— 它们捕获了 deferredPrefetch 内部的输出通道。
 */
function _runStartupCleanup(lowHeadroom, emit, emitFootprintNotice) {
  try {
    const cleanup = require('../services/cleanupService');
    const result = cleanup.runCleanup({ trigger: 'startup' });
    // 低余量时只保留启动清理，不起周期 timer——与 cleanupService 自身
    // KHY_ENABLE_PERIODIC_SCAN=false 的约束硬件处理同义，但改由实测余量触发。
    if (!lowHeadroom) cleanup.startPeriodicCleanup({ skipInitial: true });
    // 体积自检:只报不删。清理跑完之后才测,报的才是清理之后的真实占用。
    emitFootprintNotice(cleanup);
    if (result.summary && result.summary.actions && result.summary.actions.length > 0) {
      try {
        const chalk = require('chalk').default || require('chalk');
        emit(
          chalk.dim(
            `  清理  ${result.summary.actions.join(', ')} (释放 ${result.summary.freedHuman})`
          )
        );
      } catch {
        /* chalk not available */
      }
    }
  } catch {
    /* non-critical */
  }
}

/** 安全监视（10 分钟一扫）。低余量时调用方直接跳过；本函数只负责 fail-soft。 */
function _startSecurityMonitor() {
  try {
    const { startSecurityMonitor } = require('../services/securityGuardService');
    startSecurityMonitor();
  } catch {
    /* non-critical */
  }
}

/**
 * Schedule deferred background tasks after REPL is ready.
 *
 * Returns an array of timer IDs that can be cleared on shutdown:
 *   const timers = deferredPrefetch({ ... });
 *   // on exit: timers.forEach(clearTimeout);
 *
 * @param {{ mode?: string, onOutput?: (msg: string|object) => void, isBusy?: () => boolean }} options
 * @returns {Array<NodeJS.Timeout>}
 */
function deferredPrefetch(options = {}) {
  const { mode = 'khyquant', onOutput, isBusy } = options;
  const timers = [];
  const busy = () => (typeof isBusy === 'function' ? isBusy() : false);
  const pendingOutput = [];
  let flushTimer = null;
  const deliver = (value) => {
    if (typeof onOutput !== 'function') return;
    try {
      const handled = onOutput(value);
      if (handled && typeof handled.catch === 'function') handled.catch(() => {});
    } catch {
      /* non-critical output consumer */
    }
  };
  const flush = () => {
    flushTimer = null;
    if (busy() || pendingOutput.length === 0) {
      if (pendingOutput.length > 0) {
        flushTimer = setTimeout(flush, 500);
        timers.push(flushTimer);
      }
      return;
    }
    while (!busy() && pendingOutput.length > 0) deliver(pendingOutput.shift());
    if (pendingOutput.length > 0) {
      flushTimer = setTimeout(flush, 500);
      timers.push(flushTimer);
    }
  };
  const emit = (value) => {
    if (typeof onOutput !== 'function') return;
    if (busy()) {
      pendingOutput.push(value);
      if (!flushTimer) {
        flushTimer = setTimeout(flush, 500);
        timers.push(flushTimer);
      }
      return;
    }
    deliver(value);
  };

  // Apply hardware-derived runtime limits SYNCHRONOUSLY up front (idempotent;
  // honors user/env overrides). This must precede the deferred cleanup/agent
  // timers and the first request so concurrency, timeout and background-cadence
  // consumers read already-adapted env. detectProfile() is cached, so the later
  // deferred call that emits the lightweight notice is effectively free.
  try {
    require('../services/hardwareProfileService').applyLimits();
  } catch {
    /* non-critical — falls back to fixed defaults */
  }

  // 生命周期策略驱动(操作化):策略决定「跑什么 / 何时 / 是否启用」,本模块只持有「怎么跑」。
  // RUNNERS 每个 body 与改造前的 setTimeout/setImmediate 回调逐字节一致;id 必须与
  // serviceLifecyclePolicy 的 cli-startup 条目一一对应,scripts/check-lifecycle-policy.js 守卫防漂移。
  const policy = require('../services/serviceLifecyclePolicy');

  // 机器余量探测（P2，零 spawn：只读 os.*）。低余量时不给本会话再添常驻开销，
  // 与 runtimeResourceProbe 的 floorFreePct 同一把尺——否则会出现「环境告警说内存
  // 不够」与「我们照旧起满常驻」同时发生的自相矛盾。读不到就退回原行为（fail-soft）。
  let lowHeadroom = false;
  try {
    const probe = require('../services/runtimeResourceProbe');
    const machine = probe.collectMachine();
    lowHeadroom = machine.freePct < machine.floorFreePct;
  } catch {
    lowHeadroom = false;
  }

  // 体积自检:完整模式与轻量模式共用一份,免得两处文案漂移。
  // 只报不删 —— .khy 下躺着会话存档与工作区快照,自动清理判错是不可逆的。
  // 结果**缓存不直接发射**(B5):自检跑在 +3s/+3.5s,驻留采样在 settleTimer(调度表
  // 最大 delayMs+1s)——两条行各自打 transcript 会随 nowTick 心跳重绘常驻(实测被
  // 探针读成「从 0% 爬到 15%」的伪进度),故缓存到这里,由 emitResidencyNotice
  // 合并成一条一次性「资源」通知。
  let _pendingFootprintNotice = null;
  const cacheFootprintStorageNotice = (cleanup) => {
    try {
      const footprint = cleanup.assessRuntimeFootprint();
      _pendingFootprintNotice = footprint.notice || null;
    } catch {
      /* 自检失败不该拦住启动 */
    }
  };

  // 稳态资源读数（与 khy doctor「驻留资源」同一把尺，见 runtimeResourceProbe）。
  // 只在超出判据时出一行——每帧都响的仪表会让人学会忽略它。
  // 刻意零 spawn：本机一次派生被 Defender 税到 3.8–7.8s（DESIGN-PERF-005 实测），
  // 一个要派生进程的仪表不如没有。
  //
  // 采样点被刻意移到所有一次性启动 timer firing 之后（见下方结算 timer）：
  // 在启动窗口内采样时，尚未 firing 的 deferred setTimeout 仍是 active Timeout，
  // 会把「本会话刚启动」误报成「定时器超预算」（2026-10-04 实测 26/20 即此）。
  const emitResidencyNotice = () => {
    try {
      const probe = require('../services/runtimeResourceProbe');
      const residency = probe.buildResidencyNotice(probe.collectRuntimeCensus({ phase: 'tui' }));
      // B5:与缓存的体积自检行合并为**一条**一次性通知 —— settleTimer 是调度表唯一
      // 的最晚时点,两条行在这里汇合;皆空则静默(silence is the normal state)。
      const footprint = _pendingFootprintNotice;
      _pendingFootprintNotice = null;
      if (!residency && !footprint) {
        return;
      }
      const merged = [residency, footprint].filter(Boolean).join(' · ');
      // TUI 会话走通知端口(真实 seam):notificationPort 按 type 相邻去重、侧栏槽
      // 渲染时过期过滤 —— 不进 transcript、不随心跳重发。低档机的页脚单槽瞬显降级
      // 在 App 通知接线区做(cli 层才读得动 ~/.khyquant/tui.json,本层不反向依赖)。
      // 经典 REPL 无端口渲染器,保留原单行 emit;KHY_INK_TUI_ACTIVE 在 startInkApp
      // 同步段置位(app.js:130),早于本模块被 App mount effect 调度。
      if (process.env.KHY_INK_TUI_ACTIVE) {
        try {
          require('../services/notificationPort').emitNotification({
            type: 'residency',
            level: 'info',
            title: '资源',
            detail: merged,
          });
          return;
        } catch {
          /* 端口不可用 → 回退单行 emit */
        }
      }
      const chalk = require('chalk').default || require('chalk');
      emit(chalk.dim(`  资源  ${merged}`));
    } catch {
      /* 普查失败不该拦住启动 */
    }
  };

  const RUNNERS = {
    // ── Lightweight mode (khy):+300ms 预热 gateway(门判定保留在 body 内)──────
    gatewayWarmup: () => {
      try {
        const shouldWarmGateway =
          String(process.env.KHY_GATEWAY_WARMUP_ON_BOOT || 'true').toLowerCase() !== 'false';
        if (!shouldWarmGateway) {
          return;
        }
        const gw = require('../services/gateway/aiGateway');
        gw.init().catch(() => {});
      } catch {
        /* non-critical */
      }
    },

    // 轻量模式 +3.5s:滚动 + 体积自检。
    //
    // 为什么轻量模式要单独有这一条:cleanupService 那条策略条目是 mode 'khyquant',
    // 而 bin/khy.js 以 `khy` 名调用时把 KHY_RUNTIME_MODE 设成 'khy',走的是本段。
    // 于是日志/审计的滚动在最主要的分发入口上从来没跑过,.khy 只增不减。这里补的是
    // 那条缺口,但刻意只做两件有界的事(滚动 logs 与 audit、报一次体积),不起周期
    // timer、不做完整 runCleanup,轻量模式该轻的地方仍然轻。
    runtimeFootprintNotice: () => {
      // 分片执行(B5):四个清理动作各自有界,片间 setImmediate 让出事件循环 ——
      // +3.5s 恰是用户开始打字的窗口,连片同步跑(trimTrainingData 单片实测可达
      // 数秒)会把输入调度冻住。只改「何时让出」,动作本体与先后顺序逐条不变;
      // 体积自检挪到尾片,结果缓存(见 cacheFootprintStorageNotice),不直接 emit。
      let cleanup = null;
      try {
        cleanup = require('../services/cleanupService');
      } catch {
        /* non-critical */
        return;
      }
      const steps = [
        () => {
          try {
            cleanup.cleanRuntimeLogs();
          } catch {
            /* 滚动失败不影响自检 */
          }
        },
        () => {
          try {
            cleanup.cleanTraceAudit();
          } catch {
            /* 同上 */
          }
        },
        // training 与训练隔离区同样只在完整模式的 runCleanup 里被裁,轻量入口从不碰它们。
        // 实测 .khy/training 550 MB,其中 interaction_quarantine.jsonl 547.8 MB(超自身上限
        // 20 MB 的 27 倍),占 .khy 总体积 56%。这是同一条缺口的第二批(2026-09-29)。
        () => {
          try {
            cleanup.trimTrainingData();
          } catch {
            /* 裁剪失败不影响自检 */
          }
        },
        () => {
          try {
            cleanup.trimQuarantine();
          } catch {
            /* 同上 */
          }
        },
        () => cacheFootprintStorageNotice(cleanup),
      ];
      const runStep = (i) => {
        if (i >= steps.length) {
          return;
        }
        try {
          steps[i]();
        } catch {
          /* non-critical */
        }
        setImmediate(() => runStep(i + 1));
      };
      runStep(0);
    },

    // ── Full mode (khyquant): all deferred tasks ────────────────────────────
    // 2s: Surface the detected profile (limits already applied synchronously above)
    hardwareProfileNotice: () => {
      try {
        const hw = require('../services/hardwareProfileService');
        const profile = hw.detectProfile();
        if (profile.isLightweight) {
          try {
            const chalk = require('chalk').default || require('chalk');
            emit(
              chalk.dim(
                `  模式  轻量 ${profile.profile} (${profile.memory.totalGB}GB RAM, ${profile.cpu.cores} cores)`
              )
            );
          } catch {
            /* chalk not available */
          }
        }
      } catch {
        /* non-critical */
      }
    },

    // 3s: Data cleanup + periodic cleanup（实现在模块级 _runStartupCleanup）。
    // 第三参传的是**缓存版**体积自检（B5）——结果由驻留结算一并合并发射。
    cleanupService: () => _runStartupCleanup(lowHeadroom, emit, cacheFootprintStorageNotice),

    // 4s: Resource guard memory monitor
    resourceGuard: () => {
      try {
        const { startMemoryMonitor } = require('../services/resourceGuard');
        startMemoryMonitor();
      } catch {
        /* non-critical */
      }
    },

    // 4s: Project memory prune
    projectMemoryPrune: () => {
      try {
        const { pruneProjects } = require('../services/projectMemoryService');
        pruneProjects();
      } catch {
        /* non-critical */
      }
    },

    // 5s: File integrity check
    fileIntegrity: () => {
      try {
        const integrity = require('../services/fileIntegrityService');
        const ok = integrity.verifyOnStartup();
        if (!ok) {
          try {
            const chalk = require('chalk').default || require('chalk');
            emit(chalk.red('  校验  文件完整性异常：部分核心文件已被修改'));
            emit(chalk.dim('  操作  运行 security 命令查看详情'));
          } catch {
            /* chalk not available */
          }
        }
      } catch {
        /* non-critical */
      }
    },

    // 5s: Unified background update detection. Detection may fetch and stage a
    // verified artifact, but installation remains behind an explicit choice.
    versionUpdateNotice: async () => {
      try {
        const coordinator = require('../services/updateCoordinator');
        const state = await coordinator.checkUpdate({
          mode,
          cwd: process.cwd(),
          channel: process.env.KHY_UPDATE_CHANNEL,
        });
        if (state && state.state === 'available') {
          const staged = await coordinator.stageUpdate({ state });
          emit({ type: 'update-available', state: staged });
        } else if (state && state.state === 'blocked') {
          emit({ type: 'update-blocked', state });
        }
      } catch {
        /* non-critical */
      }
    },

    // 6s: IDE adapter recovery
    ideAdapterRecovery: async () => {
      try {
        const { recoverIdeAdapters, formatRecoveryMessage } = require('../services/versionService');
        const result = await recoverIdeAdapters();
        const msg = formatRecoveryMessage(result);
        if (msg && !busy()) {
          try {
            const chalk = require('chalk').default || require('chalk');
            emit(chalk.dim(`  适配  ${msg}`));
          } catch {
            /* chalk not available */
          }
        }
      } catch {
        /* non-critical */
      }
    },

    // 8s: Skill learning suggestions
    skillLearning: () => {
      try {
        const { getSuggestedLearning } = require('../services/skillLearningService');
        const suggestions = getSuggestedLearning();
        if (suggestions.length > 0 && !busy()) {
          const s = suggestions[0];
          try {
            const chalk = require('chalk').default || require('chalk');
            emit('');
            emit(chalk.yellow('  建议  ') + chalk.white(s.name));
            emit(chalk.dim(`  原因  ${s.reason}`));
            emit(chalk.dim(`  操作  ${s.action}`));
            emit('');
          } catch {
            /* chalk not available */
          }
        }
      } catch {
        /* non-critical */
      }
    },

    // Immediate: cloud sync + admin telemetry + security monitor
    immediateServices: () => {
      try {
        const cloudSync = require('../services/cloudSync');
        if (cloudSync.isEnabled()) {
          cloudSync.fetchRemoteConfig().catch(() => {});
          cloudSync.flushTelemetry().catch(() => {});
        }
      } catch {
        /* non-critical */
      }

      try {
        const adminSvc = require('../services/adminService');
        adminSvc.syncTelemetry().catch(() => {});
      } catch {
        /* non-critical */
      }

      // 低余量时跳过安全监视（10 分钟一扫，非关键）；低内存机器上它只会加剧换页。
      if (!lowHeadroom) _startSecurityMonitor();
    },
  };

  // 由策略调度:immediate 条目走 setImmediate(不进 timers,与原语义一致);其余 setTimeout。
  let maxDelayMs = 0;
  for (const entry of policy.listStartupSchedule(process.env, mode)) {
    const run = RUNNERS[entry.id];
    if (typeof run !== 'function') {
      continue;
    }
    if (entry.immediate) {
      setImmediate(run);
    } else {
      timers.push(setTimeout(run, entry.delayMs));
      if (Number(entry.delayMs) > maxDelayMs) {
        maxDelayMs = Number(entry.delayMs);
      }
    }
  }

  // 结算 timer:等所有一次性启动 timer firing 之后再采样驻留资源。delay 取调度表最大
  // delayMs + 1s 缓冲——事件循环若被长同步任务阻塞,到期的 setTimeout 会按注册顺序集中
  // firing,本 timer 注册在最后且 delay 最大,故必然最后跑;届时其余一次性启动 timer 均已
  // 销毁,不再被 getActiveResourcesInfo 计入 Timeout(消除启动窗口误报,见 emitResidencyNotice)。
  const settleTimer = setTimeout(emitResidencyNotice, maxDelayMs + 1000);
  settleTimer.unref?.();
  timers.push(settleTimer);

  // 轻量模式历史上在发出 deferred:scheduled checkpoint 之前就 return;逐字节保留(仅完整模式标记)。
  if (mode !== 'khy') {
    checkpoint('prefetch:deferred:scheduled');
  }
  return timers;
}

module.exports = { parallelPrefetch, deferredPrefetch };
