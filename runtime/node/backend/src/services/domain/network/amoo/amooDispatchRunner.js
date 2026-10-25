'use strict';

/**
 * amooDispatchRunner.js — thin IO shell that runs one "task in, answer out"
 * round trip with Amoo on the phone.
 *
 * WHY this shape: the pure leaves decide WHAT happens (config, policy, plan,
 * snapshot); this file only performs it and records what actually happened. An
 * actuation on the user's own phone therefore never runs without an explicit
 * `confirm: true`, and a run that fails halfway still returns the step log so
 * the caller can see exactly where it stopped.
 *
 * Screen reads and taps go through PC-side adb (`uiautomator dump`, `input tap`,
 * `input keyevent`) because the installed StepBridge lite build exposes no UI
 * tools at all. The bridge is used for exactly two things: liveness and the
 * clipboard (the only verified CJK text route on this device).
 *
 * Waiting strategy (all from the plan leaf, nothing invented here):
 *   capped poll interval, round cap, wall-clock deadline, and a stability rule
 *   of "chat text byte-identical N rounds in a row". The stop reason is always
 *   reported, so a timeout is never mistaken for an answer.
 *
 * Contract: no method throws; a failed step becomes a step-log entry plus a
 * Chinese `message`.
 *
 * @module services/domain/network/amoo/amooDispatchRunner
 */

const fs = require('fs');
const nodePath = require('path');

const {
  buildLaunchAmooArgv,
  buildTapArgv,
  buildKeyEventArgv,
  buildUiDumpArgv,
  buildPullArgv,
  buildRemoveArgv,
  buildShellArgv,
  evaluateBridgeCall,
  escapeForDeviceShell,
  KEY_EVENT_PASTE,
  KEY_EVENT_DEL,
} = require('./amooBridgePolicy');
const {
  parseUiDump,
  findByResourceId,
  centerOf,
  extractChatListText,
  judgeReplyStability,
  sliceReply,
  inputHasPayload,
  payloadPrefix,
  isInputEmpty,
  describeScreen,
} = require('./amooUiSnapshot');
const {
  buildDispatchPlan,
  renderDispatchPlan,
  shouldStopPolling,
  nextPollDelay,
  truncateForResult,
  describeStopReason,
} = require('./amooDispatchPlan');

const UI_DUMP_TIMEOUT_MS = 25000;

// Poll-loop screen-read policy. Measured live: during Amoo's streaming
// generation `uiautomator dump` fails with "could not get idle state" for as
// long as the stream runs and recovers on its own the moment it ends — three
// quick retries bridged that gap, while twenty rounds of silently treating a
// failed dump as "nothing changed" read as a stable empty screen and burned
// the whole round cap.
const SCREEN_READ_RETRIES = 3;
const SCREEN_RETRY_DELAY_MS = 1500;
const SCREEN_UNREADABLE_ROUNDS = 3;

// Progress-report throttle for the optional onPoll hook. The poll loop can run
// 40 rounds inside a few seconds against a fast device; reporting every round
// would make a listener's setState the bottleneck, so one per second is enough
// for a progress line.
const POLL_PROGRESS_INTERVAL_MS = 1000;

/**
 * Fire a progress hook without ever letting it break the dispatch. A listener
 * may only enqueue (push to a ref / setState) — it must not do IO or block,
 * because this runs inline in the async dispatch path next to real adb timing.
 * @param {Function|null} hook
 * @param {object} event
 */
function emitProgress(hook, event) {
  if (typeof hook !== 'function') {
    return;
  }
  try {
    hook(event);
  } catch {
    /* a broken observer must not abort a dispatch that is otherwise fine */
  }
}

class AmooDispatchRunner {
  /**
   * @param {object} [opts]
   * @param {object} [opts.config] output of resolveAmooConfig
   * @param {object} [opts.client] AmooBridgeClient
   * @param {object} [opts.mailbox] AmooBridgeMailbox
   * @param {Function} [opts.getAppDataDir] utils/dataHome.getAppDataDir
   * @param {Function} [opts.sleep]
   * @param {Function} [opts.now]
   */
  constructor(opts = {}) {
    this.config = opts.config;
    this.client = opts.client;
    this.mailbox = opts.mailbox;
    this._getAppDataDir = typeof opts.getAppDataDir === 'function' ? opts.getAppDataDir : null;
    this._sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  }

  // ── screen primitives ────────────────────────────────────────────────────

  /**
   * Chat-list text with the input box and the send button excluded.
   *
   * The exclusion is load-bearing, not tidiness: on an EMPTY conversation the
   * chat list spans the whole content area (measured `[0,196][1200,2660]`), so
   * the input box is geometrically inside it and its HINT would otherwise be
   * read as a chat bubble — corrupting both the reply and the stability rule.
   * @param {object[]} nodes
   * @returns {string}
   */
  _chatText(nodes) {
    return extractChatListText(nodes, this.config.amoo.chatListId, [
      this.config.amoo.inputId,
      this.config.amoo.sendId,
    ]);
  }

  /**
   * Pull and parse one screen snapshot.
   * @returns {Promise<{ok:boolean, nodes:object[], error:string|null,
   *                    remotePath:string, localPath:string|null}>}
   */
  async dumpScreen() {
    const { serial } = this.config.adb;
    const remotePath = this.config.dispatch.uiDumpRemotePath;
    const localPath = this._scratchFile(`ui_${this._now().toString(36)}.xml`);
    const dumped = await this.client.runAdb(buildUiDumpArgv(serial, remotePath), {
      timeoutMs: UI_DUMP_TIMEOUT_MS,
    });
    if (!dumped.ok) {
      return {
        ok: false,
        nodes: [],
        error: (dumped.stderr || dumped.error || '').trim() || '界面 dump 失败',
        remotePath,
        localPath: null,
      };
    }
    const pulled = await this.client.runAdb(buildPullArgv(serial, remotePath, localPath));
    if (!pulled.ok) {
      return {
        ok: false,
        nodes: [],
        error: (pulled.stderr || pulled.error || '').trim() || '界面文件拉取失败',
        remotePath,
        localPath: null,
      };
    }
    let raw = '';
    try {
      raw = fs.readFileSync(localPath, 'utf8');
    } catch (error) {
      return {
        ok: false,
        nodes: [],
        error: `界面文件读取失败：${(error && error.message) || '未知原因'}`,
        remotePath,
        localPath,
      };
    }
    await this.client.runAdb(buildRemoveArgv(serial, remotePath));
    try {
      fs.rmSync(localPath, { force: true });
    } catch {
      /* scratch file, best effort */
    }
    return { ok: true, nodes: parseUiDump(raw), error: null, remotePath, localPath };
  }

  /**
   * dumpScreen with in-round retries. A single failed dump is NOT evidence
   * that the screen is unreadable — see SCREEN_READ_RETRIES. Retry sleeps are
   * reported back so the poll deadline stays honest.
   * @param {number} retries
   * @returns {Promise<{screen:object, waitedMs:number}>}
   */
  async _dumpScreenWithRetry(retries) {
    let waitedMs = 0;
    for (let attempt = 1; ; attempt += 1) {
      const screen = await this.dumpScreen();
      if (screen.ok || attempt > retries) {
        return { screen, waitedMs };
      }
      await this._sleep(SCREEN_RETRY_DELAY_MS);
      waitedMs += SCREEN_RETRY_DELAY_MS;
    }
  }

  _scratchFile(name) {
    let dir;
    if (this._getAppDataDir) {
      dir = this._getAppDataDir(this.config.local.scratchSubdir, 'dispatch');
    } else {
      dir = nodePath.join(require('os').tmpdir(), 'khy-amoo-dispatch');
    }
    // The pull target's parent must exist before adb writes into it: a missing
    // directory surfaces as ENOENT on READ, which reads like an unreadable
    // screen rather than a missing scratch dir.
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* a read-only data home is a real failure and will surface on read */
    }
    return nodePath.join(dir, name);
  }

  /**
   * Tap the centre of a node, resolving coordinates from the LIVE snapshot.
   * @param {object|null} node
   * @returns {Promise<{ok:boolean, x:number|null, y:number|null, detail:string}>}
   */
  async tapNode(node) {
    if (!node) {
      return { ok: false, x: null, y: null, detail: '目标控件未出现在界面上' };
    }
    const centre = centerOf(node.bounds);
    if (!centre) {
      return { ok: false, x: null, y: null, detail: `控件坐标无法解析：${node.bounds || '(空)'}` };
    }
    const tapped = await this.client.runAdb(buildTapArgv(this.config.adb.serial, centre.x, centre.y));
    return {
      ok: tapped.ok,
      x: centre.x,
      y: centre.y,
      detail: tapped.ok
        ? `已点击 (${centre.x}, ${centre.y})`
        : (tapped.stderr || tapped.error || '').trim() || '点击失败',
    };
  }

  // ── status ───────────────────────────────────────────────────────────────

  /**
   * Read-only status snapshot. Honest about the lite build's missing UI tools.
   * @returns {Promise<object>}
   */
  async collectStatus() {
    const adb = this.client.resolveAdbPath();
    const device = adb.ok ? await this.client.ensureDevice() : { ok: false, connected: false, reason: 'adb_unresolved', detail: adb.message };
    const forwards = device.ok && device.connected ? await this.client.ensureForward() : { ok: false, forwards: [], detail: '设备未连接，未建立 forward' };
    const bridge = forwards.ok ? await this.client.ping() : { ok: false, latencyMs: 0, detail: 'forward 未就绪，未探活' };
    const status = bridge.ok ? await this.client.status() : { ok: false, status: null, detail: bridge.detail };
    const token = await this.client.readToken();
    const screen = device.ok && device.connected ? await this.dumpScreen() : { ok: false, nodes: [], error: '设备未连接' };
    const screenInfo = screen.ok
      ? describeScreen(screen.nodes, {
          chatListId: this.config.amoo.chatListId,
          inputId: this.config.amoo.inputId,
          sendId: this.config.amoo.sendId,
        })
      : null;

    return {
      ok: Boolean(adb.ok && device.ok && forwards.ok && bridge.ok),
      adb: { resolved: adb.ok, source: adb.source, path: adb.ok ? adb.path : null, message: adb.message },
      device: { connected: Boolean(device.connected), serial: this.config.adb.serial, detail: device.detail, reason: device.reason },
      forwards: { ok: forwards.ok, ports: forwards.forwards, detail: forwards.detail },
      bridge: {
        online: bridge.ok,
        latencyMs: bridge.latencyMs,
        detail: bridge.detail,
        port: this.config.bridge.port,
        transport: this.config.bridge.transport,
        baseUrl: this.config.bridge.baseUrl,
        token: token.ok ? this.client.tokenMask() : null,
        tokenDetail: token.ok ? '已从设备读取' : `不可用：${token.reason}`,
        tools: status.status && Number.isFinite(Number(status.status.tools)) ? Number(status.status.tools) : null,
        mode: status.status && status.status.mode ? status.status.mode : null,
      },
      screen: screenInfo,
      uiAutomation: {
        // Honest boundary: the installed bridge has no accessibility service and
        // no UI tools, so nothing here can drive another app's UI through it.
        bridgeUiTools: false,
        screenReadPath: 'PC 侧 adb shell uiautomator dump',
        note: 'StepBridge lite 版不含无障碍与任何 UI 工具；读屏与点击全部走 PC 侧 adb。',
      },
      summary: this._renderStatusSummary({ adb, device, forwards, bridge, token, screenInfo }),
    };
  }

  _renderStatusSummary({ adb, device, forwards, bridge, token, screenInfo }) {
    const lines = [];
    lines.push(`adb：${adb.ok ? `已解析（${adb.source}）` : `未解析 —— ${adb.message}`}`);
    lines.push(`设备：${device.connected ? `已连接 ${this.config.adb.serial}` : `未连接（${device.reason || 'unknown'}）`}`);
    lines.push(`forward：${forwards.ok ? `已建立 ${forwards.forwards.join(' + ')}` : forwards.detail}`);
    lines.push(
      `桥服务：${bridge.ok ? `在线，端口 ${this.config.bridge.port}，本次探活 ${bridge.latencyMs}ms` : bridge.detail}`
    );
    lines.push(`令牌：${token.ok ? `已读取 ${this.client.tokenMask()}` : `不可用（${token.reason}）`}`);
    if (screenInfo) {
      lines.push(`当前界面：${screenInfo.summary}`);
    }
    return lines.join('\n');
  }

  // ── dispatch ─────────────────────────────────────────────────────────────

  /**
   * Send a task to Amoo and read the answer back.
   *
   * Optional progress hooks (both no-ops when not supplied — old callers see
   * byte-identical behaviour):
   *   onStep({id, ok, detail})  after every recorded step, in order;
   *   onPoll({round, maxRounds, waitedMs, chatChars})  at most once per second
   *     inside the reply poll, which otherwise gives the caller zero feedback
   *     for up to four minutes.
   * A hook may only enqueue state; it must not do IO or block, because it runs
   * inline next to real adb timing.
   * @param {{taskText:string, confirm?:boolean, channel?:'http'|'mailbox',
   *          onStep?:Function, onPoll?:Function}} input
   * @returns {Promise<object>}
   */
  async dispatchTask(input = {}) {
    const taskText = typeof input.taskText === 'string' ? input.taskText : '';
    const channel = input.channel === 'mailbox' ? 'mailbox' : 'http';
    const plan = buildDispatchPlan({ taskText, config: this.config, channel });

    if (!this.config.gates.enabled) {
      return {
        ok: false,
        code: 'layer_disabled',
        message: 'Amoo 协作层已被 KHY_AMOO_BRIDGE_ENABLED 关闭。',
        plan,
        planText: renderDispatchPlan(plan),
        steps: [],
      };
    }
    if (!taskText.trim()) {
      return {
        ok: false,
        code: 'task_empty',
        message: '任务文本为空，没有可下发的内容。',
        plan,
        planText: renderDispatchPlan(plan),
        steps: [],
      };
    }
    if (input.confirm !== true) {
      // Actuation gate: show the plan, execute nothing.
      return {
        ok: false,
        code: 'confirm_required',
        message: '这一步会在你的手机上操作 Amoo 界面并发送消息。确认后加 --confirm 再执行。',
        plan,
        planText: renderDispatchPlan(plan),
        steps: [],
      };
    }

    const steps = [];
    const onStep = typeof input.onStep === 'function' ? input.onStep : null;
    const onPoll = typeof input.onPoll === 'function' ? input.onPoll : null;
    const record = (id, ok, detail) => {
      const entry = { id, ok, detail };
      steps.push(entry);
      emitProgress(onStep, entry);
      return ok;
    };

    const device = await this.client.ensureDevice();
    if (!record('ensure-device', device.ok, device.detail)) {
      return this._fail('device_unreachable', `设备不可用：${device.detail}`, plan, steps);
    }

    let bridgeState = { ok: true, revived: false, detail: '使用文件信箱，跳过 HTTP 探活' };
    if (channel === 'http') {
      const forwards = await this.client.ensureForward();
      if (!record('ensure-forward', forwards.ok, forwards.detail)) {
        return this._fail('forward_failed', `forward 建立失败：${forwards.detail}`, plan, steps);
      }
      bridgeState = await this.client.ensureBridge();
      if (!record('bridge-ping', bridgeState.ok, bridgeState.detail)) {
        return this._fail('bridge_offline', bridgeState.detail, plan, steps);
      }
    } else if (!record('bridge-ping', this.config.gates.mailboxEnabled, '文件信箱通道已启用')) {
      return this._fail('mailbox_disabled', '文件信箱通道已被 KHY_AMOO_MAILBOX_ENABLED 关闭。', plan, steps);
    }

    const launched = await this.client.runAdb(
      buildLaunchAmooArgv(this.config.adb.serial, this.config.amoo.component, this.config.amoo.launchAction)
    );
    if (!record('launch-amoo', launched.ok, launched.ok ? launched.stdout.trim() : (launched.stderr || launched.error || '').trim())) {
      return this._fail('amoo_launch_failed', '无法打开 Amoo 聊天界面。', plan, steps);
    }
    await this._sleep(this.config.dispatch.launchWaitMs);

    const firstScreen = await this.dumpScreen();
    if (!record('focus-input', firstScreen.ok, firstScreen.ok ? describeScreen(firstScreen.nodes, this.config.amoo).summary : firstScreen.error)) {
      return this._fail('screen_unreadable', `读不到 Amoo 界面：${firstScreen.error}`, plan, steps);
    }
    const baselineChat = this._chatText(firstScreen.nodes);
    const inputNode = findByResourceId(firstScreen.nodes, this.config.amoo.inputId);
    const focus = await this.tapNode(inputNode);
    if (!record('focus-input-tap', focus.ok, focus.detail)) {
      return this._fail('input_not_found', `找不到 Amoo 输入框（${this.config.amoo.inputId}）：${focus.detail}`, plan, steps);
    }
    await this._sleep(this.config.dispatch.inputWaitMs);

    const filled = await this._fillInput(taskText, plan.inputRoute, channel);
    if (!record('fill-text', filled.ok, filled.detail)) {
      return this._fail('text_not_injected', filled.detail, plan, steps);
    }

    const verifyScreen = await this.dumpScreen();
    const verifyNode = verifyScreen.ok ? findByResourceId(verifyScreen.nodes, this.config.amoo.inputId) : null;
    const verifyText = verifyNode ? verifyNode.text : '';
    // An empty box still reports its HINT as text, so the only sound check is
    // "does the box contain the payload we tried to put there".
    const verified = verifyScreen.ok && inputHasPayload(verifyText, taskText);
    if (!record('verify-input', verified, verified ? `输入框已含任务文本前缀「${payloadPrefix(taskText)}」` : `输入框里看不到任务文本（${verifyScreen.ok ? `当前 ${verifyText.trim().length || 0} 字` : verifyScreen.error}）`)) {
      return this._fail('input_empty_after_fill', '文本没有进入输入框，已停止，不会发送空消息。', plan, steps);
    }

    const sendScreen = await this.dumpScreen();
    const sendNode = sendScreen.ok ? findByResourceId(sendScreen.nodes, this.config.amoo.sendId) : null;
    const sendTap = await this.tapNode(sendNode);
    if (!record('tap-send', sendTap.ok, sendTap.detail)) {
      return this._fail(
        'send_button_missing',
        `找不到发送按钮（${this.config.amoo.sendId}）：${sendTap.detail}`,
        plan,
        steps
      );
    }
    await this._sleep(this.config.dispatch.sendWaitMs);

    const poll = await this._pollReply(baselineChat, taskText, onPoll);
    record('poll-reply', poll.ok, `轮次 ${poll.rounds}，停止原因 ${poll.stopReason}`);

    const truncated = truncateForResult(poll.reply, this.config.dispatch.maxResultChars);
    const ok = poll.stopReason === 'reply_stable_text_stable' && truncated.text.trim().length > 0;
    return {
      ok,
      code: ok ? 'ok' : 'reply_incomplete',
      message: ok
        ? `已收到 Amoo 答复（${truncated.text.length} 字，${poll.rounds} 轮轮询后判定稳定）。`
        : `未拿到完整答复：${describeStopReason(poll.stopReason)}。已收到的内容 ${truncated.text.length} 字，见 reply.text。`,
      channel,
      inputRoute: plan.inputRoute,
      taskChars: taskText.length,
      baselineChars: baselineChat.length,
      reply: {
        text: truncated.text,
        full: poll.reply,
        truncated: truncated.truncated,
        originalChars: truncated.originalChars,
        echoStripped: poll.echoStripped,
      },
      poll: {
        rounds: poll.rounds,
        waitedMs: poll.waitedMs,
        deadlineMs: plan.poll.deadlineMs,
        stopReason: poll.stopReason,
        screenError: poll.screenError,
        stableRounds: plan.poll.stableRounds,
      },
      bridge: { online: bridgeState.ok, revived: bridgeState.revived, detail: bridgeState.detail },
      plan,
      planText: renderDispatchPlan(plan),
      steps,
    };
  }

  /**
   * Put the task text into Amoo's input box.
   * @param {string} text
   * @param {'clipboard'|'adb-input-text'} route
   * @param {'http'|'mailbox'} channel
   * @returns {Promise<{ok:boolean, detail:string}>}
   */
  async _fillInput(text, route, channel) {
    if (route === 'clipboard') {
      const decision = evaluateBridgeCall({ tool: 'clipboard', args: { op: 'set', text } });
      if (!decision.ok) {
        return { ok: false, detail: `剪贴板参数被策略拒绝：${decision.message}` };
      }
      let res;
      if (channel === 'mailbox') {
        res = await this.mailbox.call('clipboard', { op: 'set', text });
      } else {
        res = await this.client.bridgeRequest('/call', { tool: 'clipboard', args: { op: 'set', text } });
      }
      const bodyOk = res.ok && res.body && res.body.ok === true;
      if (!bodyOk) {
        this.client.invalidateToken();
        return {
          ok: false,
          detail:
            `剪贴板写入失败：${(res.body && res.body.error) || res.error || '未知原因'}。` +
            '中文文本只能走这条路（input text 不支持 CJK）；可改用反向 CLI 通道，让 Amoo 主动来调 khy-os。',
        };
      }
      const pasted = await this.client.runAdb(buildKeyEventArgv(this.config.adb.serial, KEY_EVENT_PASTE));
      if (!pasted.ok) {
        return { ok: false, detail: `粘贴键发送失败：${(pasted.stderr || pasted.error || '').trim() || '未知原因'}` };
      }
      let detail = '已写入剪贴板并按下粘贴键';
      if (channel === 'http') {
        // `clipboard` is the one bridge tool observed to wedge the whole
        // process (live: heartbeat went stale 132s after a call and only a
        // monkey restart recovered it). A cheap /ping right after it turns a
        // silent future hang into a flag the next ensureBridge() acts on. It is
        // deliberately NOT fatal: paste, verify, send and poll all run over
        // adb, so the dispatch can finish without the bridge.
        const probe = await this.client.probeAfterClipboard();
        if (!probe.ok) {
          detail += `；桥自检无响应（${probe.detail}），已标记，下次调用前会自动重启`;
        }
      }
      return { ok: true, detail };
    }

    const typed = await this.client.runAdb(
      buildShellArgv(this.config.adb.serial, `input text ${escapeForDeviceShell(text)}`)
    );
    if (!typed.ok) {
      return { ok: false, detail: `input text 失败：${(typed.stderr || typed.error || '').trim() || '未知原因'}` };
    }
    return { ok: true, detail: '已用 input text 写入（纯 ASCII）' };
  }

  /**
   * Poll the screen until the reply is stable, the round cap is hit, or the
   * deadline expires. The stop reason is always part of the result.
   * @param {string} baselineChat
   * @param {string} taskText
   * @param {Function} [onPoll] optional progress hook, throttled to one per second
   * @returns {Promise<{ok:boolean, reply:string, rounds:number, waitedMs:number,
   *                    stopReason:string, echoStripped:boolean}>}
   */
  async _pollReply(baselineChat, taskText, onPoll = null) {
    const plan = buildDispatchPlan({ taskText, config: this.config });
    const { intervalMs, maxIntervalMs, maxRounds, stableRounds, deadlineMs } = plan.poll;
    const samples = [];
    const startedAt = this._now();
    let waitedMs = 0;
    let round = 0;
    let stopReason = 'not_started';
    let reply = '';
    let unreadableStreak = 0;
    let lastScreenError = '';
    let lastPollReportAt = 0;

    for (round = 1; round <= maxRounds; round += 1) {
      const { screen, waitedMs: retryMs } = await this._dumpScreenWithRetry(SCREEN_READ_RETRIES);
      waitedMs += retryMs;
      if (screen.ok) {
        unreadableStreak = 0;
        const chatText = this._chatText(screen.nodes);
        samples.push({ chatText });
        // Progress first, stop check second: the round that ends the wait is
        // exactly the one a waiting panel most wants to have seen.
        const nowMs = this._now();
        if (nowMs - lastPollReportAt >= POLL_PROGRESS_INTERVAL_MS) {
          lastPollReportAt = nowMs;
          emitProgress(onPoll, { round, maxRounds, waitedMs, chatChars: chatText.length });
        }
        const stability = judgeReplyStability(samples, stableRounds);
        const sliced = sliceReply(chatText, baselineChat, taskText);
        reply = sliced.reply;
        const stop = shouldStopPolling({
          round,
          maxRounds,
          elapsedMs: waitedMs,
          deadlineMs,
          stability,
        });
        if (stop.stop) {
          stopReason = stop.reason;
          break;
        }
      } else {
        // "Screen unreadable" and "no new reply" are different facts. Faking a
        // stability sample from the previous round here is what once turned 20
        // rounds of dead dumps into a confident empty answer, so the failure is
        // counted on its own and gets its own stop reason.
        unreadableStreak += 1;
        lastScreenError = screen.error;
        if (unreadableStreak >= SCREEN_UNREADABLE_ROUNDS) {
          stopReason = 'screen_unreadable';
          break;
        }
      }
      const delay = nextPollDelay(round, intervalMs, maxIntervalMs);
      const projected = waitedMs + delay;
      if (projected >= deadlineMs) {
        stopReason = 'deadline_reached';
        waitedMs = deadlineMs;
        break;
      }
      await this._sleep(delay);
      waitedMs += delay;
    }

    if (stopReason === 'not_started') {
      stopReason = 'round_cap_reached';
    }
    const sliced = sliceReply(
      samples.length > 0 ? samples[samples.length - 1].chatText : '',
      baselineChat,
      taskText
    );
    return {
      ok: stopReason === 'reply_stable_text_stable',
      reply: sliced.reply || reply,
      rounds: round,
      waitedMs: Math.max(0, this._now() - startedAt),
      stopReason,
      screenError: lastScreenError || null,
      echoStripped: sliced.echoStripped,
    };
  }

  _fail(code, message, plan, steps) {
    return {
      ok: false,
      code,
      message,
      plan,
      planText: renderDispatchPlan(plan),
      steps,
    };
  }

  /**
   * Clear whatever is left in Amoo's input box without sending it.
   * Used by callers that aborted a dispatch and want the phone left clean.
   * @returns {Promise<{ok:boolean, detail:string}>}
   */
  async clearInput() {
    const screen = await this.dumpScreen();
    if (!screen.ok) {
      return { ok: false, detail: screen.error };
    }
    const inputNode = findByResourceId(screen.nodes, this.config.amoo.inputId);
    if (!inputNode) {
      return { ok: true, detail: '输入框不在界面上，无需清理' };
    }
    const beforeText = inputNode.text;
    // A hint is not content: only clear when something real was typed.
    if (isInputEmpty(beforeText, this.config.amoo.inputHints)) {
      return { ok: true, detail: '输入框本来就是空的（或只剩提示语）' };
    }
    const focus = await this.tapNode(inputNode);
    if (!focus.ok) {
      return { ok: false, detail: focus.detail };
    }
    const presses = Math.min(200, beforeText.trim().length + 8);
    const cleared = await this.client.runAdb(
      buildShellArgv(
        this.config.adb.serial,
        `i=0; while [ $i -lt ${presses} ]; do input keyevent ${KEY_EVENT_DEL}; i=$((i+1)); done`
      )
    );
    if (!cleared.ok) {
      return { ok: false, detail: (cleared.stderr || cleared.error || '').trim() || '清理输入框失败' };
    }
    const after = await this.dumpScreen();
    const afterNode = after.ok ? findByResourceId(after.nodes, this.config.amoo.inputId) : null;
    const afterText = afterNode ? afterNode.text : '';
    const stillThere = after.ok && inputHasPayload(afterText, beforeText);
    return {
      ok: !stillThere,
      detail: stillThere
        ? `输入框仍残留任务文本（原 ${beforeText.trim().length} 字）`
        : `输入框已清空（原 ${beforeText.trim().length} 字）`,
    };
  }
}

module.exports = { AmooDispatchRunner, UI_DUMP_TIMEOUT_MS, describeStopReason };
