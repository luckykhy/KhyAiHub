// khy-canary: Khy-20261101-109-637JY477
import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart';
import '../../core/config/app_config.dart';
import '../../core/config/permission_mode.dart';
import '../../core/drivers/app_driver_registry.dart';
import '../../core/drivers/driver.dart';
import '../../core/drivers/driver_event.dart';
import '../../core/drivers/driver_registry.dart';
import '../../core/toolhost/tool_host_client.dart';
import '../../core/gateway/khyos_api.dart';
import '../../core/gateway/zen_errors.dart';
import '../../core/gateway/zen_gate.dart';
import '../../core/gateway/zen_models.dart';
import '../../core/services/app_logger.dart';
import '../../core/services/amoo_service.dart';
import '../../core/services/chat_target.dart';
import '../../core/services/keep_awake.dart';
import '../widgets/khy_brand_mark.dart';
import '../../core/config/built_in_keys.dart';
import '../../data/models/models.dart' hide Conversation;
import '../../core/agent/tool_verdict.dart';
import '../../core/tools/tool_engine.dart';
import '../../core/tools/builtin_tools.dart';
import '../../core/authz/dialog_approval_channel.dart';
import '../../core/wechat/wechat_approval_bridge.dart' show ApprovalGatedToolEngine;
import '../../core/tools/write_diff.dart';
import '../../core/tools/tool_protocol.dart';
import '../../core/services/conversation_db.dart';
import '../../core/services/conversation_sync.dart';
import '../../core/config/project_profile.g.dart';
import '../../core/workspace/conversation_workspace.dart';
import '../../core/workspace/workspace_choices.dart';
import '../widgets/workspace_pickers.dart';
import '../../core/services/device_control.dart';
import '../../core/services/shell_command_guard.dart';
import '../../core/services/file_service.dart';
import '../../core/agent/execution_log.dart';
import '../../ui/theme/app_colors.dart';
import '../../ui/theme/design_tokens.dart';
import '../../ui/widgets/aurora.dart';
import '../../ui/widgets/tool_card.dart';
import '../../ui/widgets/chat_message_row.dart';
import '../../ui/widgets/thinking_block.dart';
import '../render/content_tier.dart';
import '../render/envelope_render.dart';
import '../render/envelope_reply_view.dart';
import '../../ui/widgets/amoo_task_card.dart';
import '../../ui/widgets/amoo_composer.dart';
import '../../ui/widgets/model_picker_sheet.dart';
import '../../core/config/model_registry.dart';
import 'settings_screen_new.dart';

/// App mode: standalone (direct API) or remote (via khy-os backend)
enum AppMode { remote, standalone }

/// 这一轮请求由谁执行。
///
/// 远程分支的模型由电脑挑（khyos_api 只发 question/history/sessionId），手机
/// 看不到电脑会用哪个模型，所以能承诺的只有一件事：**手机自己选中的 Zen 免费
/// 模型不发给电脑**。否则出口 IP 与设备身份都变成那台电脑的，手机上选的那个
/// 免费模型根本不会生效。
enum ZenSendMode { remote, standalone }

ZenSendMode resolveSendMode({required bool remote, required String? model}) {
  if (!remote) return ZenSendMode.standalone;
  // 配置还没读回来（_loadConfig 未完成）时无从判断，保持远程不动。
  if (model == null) return ZenSendMode.remote;
  return isZenFreeModelId(model) ? ZenSendMode.standalone : ZenSendMode.remote;
}

/// 把一段历史压成几行摘要（只取最后 4 条，不足 4 条就全取）。
///
/// 单独成函数是为了让「历史正好 9 条 → older 只有 3 条」这个病例有测试可钉：
/// 旧写法无条件 `sublist(msgs.length - 4)`，在 3 条时算出 -1 并抛
/// `RangeError (start): 0..3: -1`，用户看到的是一句莫名其妙的报错（2026-11-16 实机）。
String summarizeHistoryTail(List<Map<String, dynamic>> msgs) {
  final buf = StringBuffer();
  final tail = msgs.length <= 4 ? msgs : msgs.sublist(msgs.length - 4);
  for (final m in tail) {
    final role = m['role'] == 'user' ? '用户' : 'AI';
    final content = (m['content'] ?? '').toString();
    buf.writeln(
        '$role: ${content.length > 100 ? '${content.substring(0, 100)}...' : content}');
  }
  return buf.toString().trim();
}

/// Redesigned chat screen - clean top bar, tool cards, quick actions
class ChatScreenNew extends ConsumerStatefulWidget {
  final KhyOsApi? api;

  /// 宿主页签索引，本页「变成可见」的信号。
  ///
  /// IndexedStack 让五个页签同时活着，切页只换谁被画、不重建 State——
  /// 于是用户在设置里禁用 amoo driver 后回到 AI 页，那一页还活着、
  /// 还画着 amoo 入口（要等 App 重启才消失）。visibleTick 每次变都触发
  /// didUpdateWidget，在那里重探——与前后台切换的 resume 探测同源。
  final int visibleTick;
  const ChatScreenNew({super.key, this.api, this.visibleTick = 0});

  @override
  ConsumerState<ChatScreenNew> createState() => _ChatScreenNewState();
}

class _ChatScreenNewState extends ConsumerState<ChatScreenNew>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  final _input = TextEditingController();
  final _inputFocus = FocusNode();
  final _scroll = ScrollController();
  final List<ChatMessage> _msgs = [];
  bool _busy = false;
  String _currentAction = '';

  /// 消息行的局部重建通路。见 [ChatRowStore]：正文/思维链/工具卡的每一次改动都
  /// 只通知受影响的那一行（那一组），不走整屏 setState——流式期间每个 chunk 的
  /// 重建范围因此从「整个聊天屏」缩到「ListView 里那一行」。
  ///
  /// 在 initState 里建而不是字段初始化式：要把 [_msgs] 这个列表交给它托管，
  /// 而字段初始化式拿不到 this。
  late final ChatRowStore _rows;

  /// 服务端结构化回复的跨轮缓冲与「气泡 id → 渲染现场」映射。
  ///
  /// 去重键是信封 msg_id（同一 msg_id 只渲染一次，重放投递摘占位气泡）；
  /// 映射键是本地气泡 id（_rowFor 按它切到结构化视图）。会话切换时两者都要
  /// 清：turn 归属会话，残留的话新会话会撞上旧 id 的渲染现场。
  final EnvelopeReplyBuffer _envelopeBuffer = EnvelopeReplyBuffer();
  final Map<String, EnvelopeTurn> _structuredTurns = <String, EnvelopeTurn>{};

  AppConfigData? _cfg;

  /// 底部输入框发给谁。见 [ChatTargetNotifier]：为的是消掉"两个输入框"。
  final ChatTargetNotifier _chatTarget = ChatTargetNotifier();

  /// amoo driver 是否出场（未被设置禁用 **且** 本机装着 amoo）。
  ///
  /// 为什么需要一个字段而不是每次 build 去问：探测要走 MethodChannel
  /// （异步、且要碰原生壳），build 里不能做；而四个入口（消息列表头卡、
  /// 欢迎页卡、快捷栏 chip、目标切换）必须按**同一个**判据决定显不显——
  /// 各问各的必然漂移，漂移的形态是"输入框多一个永失败的目标"。
  ///
  /// 默认 false 而不是 true：没探测完之前不挂，比挂一张死卡再撤掉好。
  /// 旧原生壳上 amooStatus 会抛 MissingPluginException，[AmooService.status]
  /// 把它转成 unknown，这里同样按 false 处理——那种壳下卡片同样是死卡。
  ///
  /// 禁用时**零探测**（_probeAmooDriver 直接返回）：用户关掉 amoo driver
  /// 之后，启动路径上一次原生调用都不该发生——那是 T1「禁用后无降级提示
  /// 残留」的启动侧证据。
  bool _amooOn = false;

  /// 能力探测结果，整个 State 生命周期只各探测一次。见 _capabilityStrip。
  late final Future<bool> _a11yReady = DeviceControl.isAccessibilityReady();
  late final Future<bool> _screenReady = DeviceControl.isScreenCaptureReady();

  /// 反代卡的 State 句柄。主输入框对着 amoo 时，靠它把话递进去。
  final GlobalKey<AmooTaskCardState> _amooCardKey =
      GlobalKey<AmooTaskCardState>();
  KhyOsApi? _api;
  AppMode _mode = AppMode.standalone;
  String? _connStatus;
  // 规范 §6.1.3：_pulseAnim 常驻缩放循环删除，改 enter 一次性进场。
  late AnimationController _enterAnim;
  final _logger = AppLogger();
  late final ToolEngine _toolEngine;
  // driver 路径单独用带门引擎：手动工具循环已在 UI 层过 _needsApproval，
  // 若共用同一个带门引擎会被问两次。host client 包这个引擎，ask 工具与危险
  // 命令在 driver 路径也过同一道门（E-A03）。
  late final ToolEngine _driverToolEngine;

  // Session
  String _currentConvId = 'default';
  String _currentTitle = '新对话';

  /// 当前对话挑的工作空间根。null = 没挑 = 用 App 既有默认。
  ///
  /// 跟着会话走而不是全局：一个对话在写游戏、另一个在整理下载目录时，
  /// 共用一个根会让两者的成果和临时文件混在一起，于是谁都不敢删。
  String? _currentWorkspaceRoot;

  /// 当前对话的同步覆盖。null = 跟随设置页里的全局默认；true/false = 单独选过。
  ///
  /// 存在对话记录里而不是全局配置里：同一个用户完全可能"客户答疑同步到电脑、
  /// 私人备忘只留手机"，而全局开关只能表达一个意思。
  bool? _currentSyncOverride;

  /// 最近一轮同步的实际结果：'synced' / 'failed' / null。
  ///
  /// 只认后端 `sync` 事件回的结果，不在本机猜——请求发出去不等于写进去了。
  String? _currentSyncState;
  List<ConversationSummary> _conversations = [];
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  /// 工具许可模式。与桌面/终端同一套词汇，见 PermissionMode。
  ///
  /// 存在 AppConfig 里而不是本地字段：换对话、杀进程都不该把它重置——
  /// 用户选「一律不问」是一次决定，不是一次会话的心情。
  PermissionMode _permissionMode = PermissionMode.prompt;

  /// auto 档下，本次会话已经批准过的工具名。
  ///
  /// 故意不做成持久化的：auto 的语义是「这次别再问我」，不是「以后也别问」。
  /// 后者是 bypass，两件事必须能分开表达，混成一个就让「别再烦我」和
  /// 「永远别问」变成同一个开关。
  final Set<String> _approvedThisSession = <String>{};

  // Debounce: last connection test time
  DateTime _lastTestTime = DateTime.fromMillisecondsSinceEpoch(0);
  static const _testDebounce = Duration(seconds: 10);

  // 429 backoff: track failures for auto-failover
  int _consecutive429 = 0;
  // Auto-failover: track tried providers to avoid cycles
  final List<String> _triedProviders = [];

  @override
  void initState() {
    super.initState();
    // 欢迎页进场只播一次；系统减弱动效时直接落在终帧。取 platformDispatcher
    // 而非 MediaQuery，是因为 initState 里不允许依赖 inherited widget。
    _enterAnim = AnimationController(duration: AppDuration.enter, vsync: this);
    if (WidgetsBinding.instance.platformDispatcher.accessibilityFeatures.disableAnimations) {
      _enterAnim.value = 1;
    } else {
      _enterAnim.forward();
    }
    // _input / _inputFocus 不再整屏 setState。原来两个监听器都是
    // `() => setState(() {})`：每敲一个键就重建整个聊天屏（头部 slab、能力条、
    // 全部消息、输入坞），而那次重建里真正变的只有发送按钮的禁用态和输入框的
    // 聚焦描边。改成 _sendButton / 输入框容器里的局部订阅，见那两处。
    _api = widget.api;
    if (_api != null && _api!.isConnected) _mode = AppMode.remote;
    _rows = ChatRowStore(_msgs);
    _loadConfig();
    _toolEngine = ToolEngine();
    _toolEngine.registerAll(createBuiltinTools());
    _driverToolEngine = ApprovalGatedToolEngine(
      approval: DialogApprovalChannel(confirm: _confirmDriverTool),
    );
    _driverToolEngine.registerAll(createBuiltinTools());
    gateDangerousTools(_driverToolEngine);
    _loadConversations();
    // 系统分享／「选中文字后」送进来的文字。放在最后：它可能新建一个对话，
    // 而那不该抢在 _loadConversations 之前把列表状态搅乱。
    _drainSharedText();
    // onResume 也要排一次：用户从别的 App 分享完回到这里时，文字是那次
    // onNewIntent 送到的，而 initState 早跑完了。没有这一条，第二次起的分享
    // 会静默丢掉——症状是"我分享了但什么都没发生"。
    WidgetsBinding.instance.addObserver(this);
    _probeAmooDriver();
  }

  /// 探测 amoo 在不在，并据此决定反代那四个入口显不显。
  ///
  /// unknown 按 false：原生壳太旧时卡片同样是死卡（问不出去、也拿不到回复），
  /// 而 AI 页第一行就是它——用户第一眼看到的是一个永远停着的东西。
  ///
  /// 为什么把「切回助手」放在探测回调的 setState 里，而不是放在 build：
  /// build 内改 notifier 是 Flutter 反模式（每次构建都可能有副作用，且
  /// ListenableBuilder 会立刻再触发一次构建）。而"先切到 amoo、再复探失败"
  /// 是真实顺序——用户可能装过 amoo、用完卸载，或从别的页面回来时探测重跑。
  /// 不切回去的话，主输入框还对着一个此刻不存在的目标，_askAmooFromMainInput
  /// 会静默空转：卡不在，_amooCardKey.currentState 是 null，刚打的那句话
  /// 就这么消失了，连一句"没发出去"都没有。
  Future<void> _probeAmooDriver() async {
    // 禁用先行：用户在设置里关掉了 amoo driver 时，这里一次原生调用都不发。
    final cfg = _cfg ?? await AppConfig.load();
    if (cfg.isDriverDisabled('amoo')) {
      if (!mounted) return;
      setState(() {
        _amooOn = false;
        if (_chatTarget.isDriver('amoo')) {
          _chatTarget.select(ActiveDriverNotifier.kAssistantDriverId);
        }
      });
      return;
    }
    final st = await AmooService.status();
    if (!mounted) return;
    setState(() {
      _amooOn = st.installed;
      if (!_amooOn && _chatTarget.isDriver('amoo')) {
        _chatTarget.select(ActiveDriverNotifier.kAssistantDriverId);
      }
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _input.dispose();
    _inputFocus.dispose();
    _scroll.dispose();
    _enterAnim.dispose();
    _autoScrollTimer?.cancel();
    _rows.dispose();
    _envelopeBuffer.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _drainSharedText();
      // 复探一次：本页活着没重建（底部导航让四个页同时活着），而 amoo 的
      // 安装态是这期间少数真的会变的东西之一——用户可能刚在设置里装好，
      // 也可能刚卸掉。不复探的话，装好的人看不到入口，卸掉的人看到死卡。
      _probeAmooDriver();
    }
  }

  @override
  void didUpdateWidget(covariant ChatScreenNew oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 宿主页签变了 = 本页刚变成可见（或刚从可见切走）。此时重探 amoo：
    // 用户在设置里拨了禁用开关再回 AI 页，入口要当场消失，而不是等重启。
    if (widget.visibleTick != oldWidget.visibleTick) {
      _probeAmooDriver();
    }
  }

  /// 把系统分享进来的文字开成一个新对话。
  ///
  /// 为什么是"新对话"而不是塞进当前对话：分享是一个独立的意图，用户此刻在
  /// 看的话题跟它通常无关。塞进当前会话会让模型拿一段没头没尾的文字去接上文，
  /// 而那段上文它并没看到。
  ///
  /// 文字**只是放进输入框**，不自动发送。自动发送会在用户没打算问的时候
  /// 花掉一次模型调用，而且屏幕上刚出现一段他没打过的字就被发出去了——
  /// 那是把人从自己的设备上挤下去。
  Future<void> _drainSharedText() async {
    final text = await DeviceControl.consumeSharedText();
    if (text.trim().isEmpty) return;
    if (!mounted) return;
    setState(() {
      _rows.clear();
      _rows.clearToolCards();
      // turn 归属会话：换会话（新建/载入/分享开新）一并清渲染现场。
      _structuredTurns.clear();
      _envelopeBuffer.reset();
      _currentConvId = 'conv_${DateTime.now().millisecondsSinceEpoch}';
      _currentTitle = '分享的内容';
      _currentWorkspaceRoot = null;
      _currentSyncOverride = null;
      _currentSyncState = null;
      _input.text = text;
    });
  }

  Future<void> _loadConfig() async {
    final c = await AppConfig.loadEffective();
    if (mounted) {
      setState(() {
        _cfg = c;
        _permissionMode = PermissionMode.fromWire(c.permissionMode);
        // 模式跟着配置走。以前只活在内存，冷启动后用户选过的「独立」默默变回
        // 远程，「Zen 免费档由手机直连」也跟着失效（2026-11-16 实机）。
        _mode = c.remoteMode ? AppMode.remote : AppMode.standalone;
      });
    }
  }

  Future<void> _loadConversations() async {
    final list = await ConversationDB.listAll();
    if (mounted) setState(() => _conversations = list);
  }

  /// 全局默认。配置还没读回来时按"开"算——那是出厂值，也是用户选过的默认。
  bool get _globalSyncEnabled => _cfg?.sessionSyncEnabled ?? true;

  bool get _effectiveSyncEnabled => ConversationSync.effectiveEnabled(
        override: _currentSyncOverride,
        globalDefault: _globalSyncEnabled,
      );

  ConversationSyncStatus get _currentSyncStatus => _syncStatusOf(
        override: _currentSyncOverride,
        lastState: _currentSyncState,
      );

  /// 抽屉里每一条各自算：摘要带着自己的覆盖和上一次结果。
  ConversationSyncStatus _syncStatusOf({bool? override, String? lastState}) =>
      ConversationSync.status(
        override: override,
        globalDefault: _globalSyncEnabled,
        remoteMode: _mode == AppMode.remote,
        lastState: lastState,
      );

  IconData _syncIcon(ConversationSyncStatus status) => switch (status) {
        ConversationSyncStatus.off => Icons.cloud_off,
        ConversationSyncStatus.standalone => Icons.phone_android,
        ConversationSyncStatus.pending => Icons.cloud_upload_outlined,
        ConversationSyncStatus.synced => Icons.cloud_done,
        ConversationSyncStatus.failed => Icons.cloud_off,
      };

  Color _syncColor(ConversationSyncStatus status, AppPalette palette) =>
      switch (status) {
        ConversationSyncStatus.synced => palette.success,
        ConversationSyncStatus.failed => palette.error,
        ConversationSyncStatus.pending => palette.primary,
        ConversationSyncStatus.off ||
        ConversationSyncStatus.standalone =>
          palette.textSecondary,
      };

  // ==================== Send ====================

  void _sendMessage() {
    final text = _input.text.trim();
    if (text.isEmpty || _busy) return;

    final target = _chatTarget.value;
    // amoo 保留反代卡流程（轮询进度、停止按钮是那张卡的功能）；其余 driver
    // 走通用路径：registry.safeSend + 渲染层只消费 DriverEvent——不认识
    // 任何具体 driver（T2 机制面的最后一环）。
    if (target == 'amoo') {
      _askAmooFromMainInput();
      return;
    }
    if (target != ActiveDriverNotifier.kAssistantDriverId) {
      _sendViaDriver(target, text);
      return;
    }

    // 发送前重新读一次配置。
    //
    // 为什么必须有：底部导航把本页的 State 一直活着，而 _loadConfig() 原来只在
    // initState 里跑过一次。于是用户在设置页填好 key、显示"连接成功"、回到 AI 页
    // 发消息，这里的 _cfg 还是应用启动时那个 null——报一句"API 未配置"，
    // 而配置其实是好的。
    //
    // 放在这里而不是靠路由回调刷新：底部导航切换不产生路由事件，没有可靠的
    // "本页又可见了"信号；而每次发送前读一次是确定正确的，代价是一次
    // keystore 读取（毫秒级），且只发生在用户明确要发送的时刻。
    _reloadConfigThenSend(text);
  }

  Future<void> _reloadConfigThenSend(String text) async {
    await _loadConfig();
    if (!mounted) return;
    _dispatchSend(text);
  }

  /// 主输入框对着 amoo 时，把这句话交给反代卡去发。
  ///
  /// 清空输入框放在这里而不是卡片里：卡不知道主输入框的存在（它被列表头、
  /// 欢迎页两处复用，只有一处配了 GlobalKey）。各清各的，才不会有一头
  /// 清了另一头没清。
  ///
  /// **这一轮对话要进消息列表**，不能只活在反代卡里。原来 Amoo 的回复只显示在
  /// 卡片自带的回复框，于是：历史记录里看不到、滚动后看不全、也没法和模型回复
  /// 混在同一列里读。现在和 _dispatchSend 一样建「用户消息 + assistant 占位」，
  /// 卡的回复通过 [_onAmooReply] 流式写进那个占位。
  ///
  /// **先问卡肯不肯发，再建消息。** 反过来的话，单飞锁拒掉的那几轮也会留下
  /// 「用户气泡 + 空 assistant 气泡」——用户以为自己问过，其实提问根本没出手机，
  /// 而界面没有任何失败提示。那是比不显示更糟的一种假象。
  void _askAmooFromMainInput() {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    final card = _amooCardKey.currentState;
    if (card == null || !card.canSend) {
      _showError('amoo 正忙', '上一轮提问还在等回复，等它结束或先停止。');
      return;
    }
    _input.clear();
    if (_currentConvId == 'default') {
      _currentConvId = 'conv_${DateTime.now().millisecondsSinceEpoch}';
    }
    _updateTitleFromFirstMessage(text);
    final userMsg = ChatMessage(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      conversationId: _currentConvId,
      role: MessageRole.user,
      content: text,
      timestamp: DateTime.now(),
      source: 'amoo',
    );
    final aid = 'a_${DateTime.now().millisecondsSinceEpoch}';
    final placeholder = ChatMessage(
      id: aid,
      conversationId: _currentConvId,
      role: MessageRole.assistant,
      content: '',
      timestamp: DateTime.now(),
      source: 'amoo',
    );
    setState(() {
      _msgs.add(userMsg);
      _rows.clearToolCards();
      _currentAction = '';
      _busy = true;
      _msgs.add(placeholder);
    });
    _scrollToBottom();
    _amooReplyId = aid;
    _amooBestReply = '';
    card.sendWith(text);
  }

  /// 当前这一轮 amoo 回复对应的占位消息 id。null = 没有进行中的 amoo 提问。
  String? _amooReplyId;

  /// 反代卡每轮 poll 到新文本时调这里，流式写进上面那个占位。
  ///
  /// 取「见过最长的版本」而不是最后一次：Amoo 的回复是流式写进同一个气泡的，
  /// 而读的是可见区域——长回复滚动后前面会掉出视野，某一次 poll 可能比上一次
  /// 读到得更少。取最长的那次，才不会把已经拿到手的后半句又弄丢。
  String _amooBestReply = '';

  void _onAmooReply(String reply) {
    final id = _amooReplyId;
    if (id == null || reply.trim().isEmpty) return;
    if (reply.length <= _amooBestReply.length) return;
    _amooBestReply = reply;
    _rows.setContent(id, reply);
    _scrollToBottom();
  }

  /// amoo 这一轮结束（成功或失败）。占位消息留着——失败也要让用户看到自己
  /// 问过什么、卡在哪儿，而不是整轮消失。
  void _onAmooFinished() {
    _amooReplyId = null;
    _amooBestReply = '';
    if (!mounted) return;
    setState(() => _busy = false);
  }

  /// 经 registry 把一句话交给某个 driver，并把 DriverEvent 画进消息列表。
  ///
  /// 这是「Render 只消费 DriverEvent」的唯一落地处：content delta 写占位
  /// 气泡、DriverStatus 转等待文案（动作+目标+进度）、DriverFailed 把失败
  /// 写进气泡（不静默、不空气泡、不代答）。新 driver 接入时这里一行不改。
  void _sendViaDriver(String driverId, String text) {
    final cfg = _cfg;
    if (cfg == null) {
      // 配置还没读回来：先读一次再发。首启第一句话不该被「配置未就绪」
      // 挡掉——driver 路径本来就不需要 API key。
      AppConfig.loadEffective().then((c) {
        if (!mounted) return;
        setState(() => _cfg = c);
        _sendViaDriver(driverId, text);
      });
      return;
    }
    final reg = AppDriverRegistry.instance.registryFor(
      cfg,
      ToolEngineHostClient(_driverToolEngine),
    );
    if (!reg.enabledIds.contains(driverId)) {
      _showError('$driverId 未出场', '它可能被设置禁用，或本机不支持');
      return;
    }

    if (_currentConvId == 'default') {
      _currentConvId = 'conv_${DateTime.now().millisecondsSinceEpoch}';
    }
    _updateTitleFromFirstMessage(text);
    final userMsg = ChatMessage(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      conversationId: _currentConvId,
      role: MessageRole.user,
      content: text,
      timestamp: DateTime.now(),
      source: driverId,
    );
    final aid = 'a_${DateTime.now().millisecondsSinceEpoch}';
    final placeholder = ChatMessage(
      id: aid,
      conversationId: _currentConvId,
      role: MessageRole.assistant,
      content: '',
      timestamp: DateTime.now(),
      source: driverId,
    );
    setState(() {
      _msgs.add(userMsg);
      _rows.clearToolCards();
      _currentAction = '等待 $driverId 回复';
      _busy = true;
      _msgs.add(placeholder);
    });
    _input.clear();
    _scrollToBottom();

    final turn = UserTurn(sessionId: _currentConvId, turnId: aid, text: text);
    _consumeDriverEvents(reg, driverId, turn, aid);
  }

  Future<void> _consumeDriverEvents(
    DriverRegistry reg,
    String driverId,
    UserTurn turn,
    String placeholderId,
  ) async {
    final content = StringBuffer();
    try {
      await for (final ev in reg.safeSend(driverId, turn)) {
        if (!mounted) return;
        switch (ev) {
          case DriverDelta():
            if (ev.kind == 'content') {
              content.write(ev.text);
              _rows.setContent(placeholderId, content.toString());
            }
            // reasoning 不画进气泡正文（思维链有专属 widget 时再接）。
          case DriverStatus():
            // 状态行走渲染层映射器（T16）：屏幕不自己拼 driver 状态文案。
            // 自己拼一次的代价是 driver 带来的 detail 在这一跳被丢掉——
            // 而降级提示（route_degraded）与每个 driver 的状态目标本来就写在
            // detail 里。映射器认不出的 code 走 default 原样出 detail。
            setState(() => _currentAction = driverStatusLine(ev).text);
          case DriverFailed():
            final msg = ev.error.toString();
            _rows.setContent(placeholderId, '本轮失败${ev.retryable ? '（可重试）' : ''}：$msg');
          case DriverFinished():
            break;
          default:
            break;
        }
        _scrollToBottom();
      }
    } finally {
      if (mounted) setState(() => _busy = false);
      // driver 会话结束（无论成败）都落盘。不存的后果：切个对话再回来，
      // 这一轮问答连用户气泡一起消失——而用户记得自己问过。主对话路径
      // （_dispatchSend）一直在存，driver 路径不能是二等公民。
      await _saveConversation();
    }
  }

  void _dispatchSend(String text) {
    // 远程模式：检查后端连接
    if (_mode == AppMode.remote) {
      if (_api == null || !_api!.isConnected) {
        _showError('未连接到 khy-os 后端', '请先连接远程后端，或切换到独立模式');
        return;
      }
      if (resolveSendMode(remote: true, model: _cfg?.model) ==
          ZenSendMode.standalone) {
        _mode = AppMode.standalone;
        _connStatus = null;
        _addSystemMsg('已切到独立模式：Zen 免费档由手机直连（出口 IP = 本机）。');
      }
    }
    if (_mode == AppMode.standalone) {
      // 独立模式：检查 API 配置
      if (_cfg == null || !_cfg!.isConfigured) {
        _showError('API 未配置', '请先到设置页选择提供商和模型');
        return;
      }
    }
    
    // 第一次发送前定下会话 id：'default' 是所有新装 App 共用的占位值，拿它
    // 落盘会让两台设备的第一个对话挤进同一个共享会话。
    if (_currentConvId == 'default') {
      _currentConvId = 'conv_${DateTime.now().millisecondsSinceEpoch}';
    }
    _updateTitleFromFirstMessage(text);
    // 用户消息 + 空 assistant 占位合并成一次 setState。原来是两次（中间还夹着
    // 一次 _scrollToBottom），同帧两次全屏重建没有任何收益；而且旧写法里第二次
    // setState 之后没有再贴底，刚追加的占位符可能落在视口外。
    final userMsg = ChatMessage(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      conversationId: _currentConvId,
      role: MessageRole.user,
      content: text,
      timestamp: DateTime.now(),
    );
    final aid = 'a_${DateTime.now().millisecondsSinceEpoch}';
    final placeholder = ChatMessage(
      id: aid,
      conversationId: _currentConvId,
      role: MessageRole.assistant,
      content: '',
      timestamp: DateTime.now(),
    );
    setState(() {
      _msgs.add(userMsg);
      _rows.clearToolCards();
      _currentAction = '';
      _busy = true;
      _msgs.add(placeholder);
    });
    _input.clear();
    _scrollToBottom();

    if (_mode == AppMode.remote) {
      _sendRemote(text, aid);
    } else {
      _sendWithAgentLoop(aid);
    }
  }

  Future<void> _sendWithAgentLoop(String id) async {
    final execLog = ExecutionLog(
      conversationId: _currentConvId,
      userMessage: _msgs.isNotEmpty ? _msgs.last.content : '',
    );

    try {
      final h = _msgs
          .where((m) => m.content.isNotEmpty && m.id != id)
          .map((m) => {
                'role': m.role == MessageRole.user ? 'user' : 'assistant',
                'content': m.content,
              })
          .toList();
      // 系统提示分三段拼：身份 → 项目画像 → 技能与协议。
      //
      // 画像只在**用户没自己写系统提示**时才接。用户写了就整段照用，不把画像偷偷
      // 续在后面——那会让他写的"只准用中文"变成一句假话。PC 侧
      // stepneoCloud/agentLoop.js 是同一条规则，两边必须一致。
      //
      // 画像带上了这个对话绑定的工作目录：不带上，模型就只知道"能操作手机"，
      // 不知道自己在维护 khy-os、也不知道文件会落到哪——那种 agent 下次就可能
      // 自动 commit 或把密钥写进源码，不是它坏，是没人告诉它不许。
      final blocks = <String>[];
      if (_cfg!.systemPrompt.isNotEmpty) {
        blocks.add(_cfg!.systemPrompt);
      } else {
        blocks.add('你是 khy-os AI 助手，运行在用户的 Android 手机上。'
            '你可以帮用户打开应用、管理剪贴板、计算数学表达式、执行无障碍操作等。'
            '使用工具完成用户请求。');
        blocks.add(ProjectProfileText.section(
          workspaceRoot: _currentWorkspaceRoot,
        ));
      }
      blocks.add(_buildSkillsSummary());
      blocks.add(ToolProtocol.textProtocolInstructions);
      final sysPrompt =
          blocks.where((b) => b.trim().isNotEmpty).join('\n\n');
      final tools = _toolEngine.toFunctionSchemas();
      final dio = Dio(BaseOptions(
        connectTimeout: const Duration(seconds: 30),
        receiveTimeout: const Duration(minutes: 5),
      ));

      final messages = <Map<String, dynamic>>[
        {'role': 'system', 'content': sysPrompt},
        ..._compactHistory(h),
      ];

      // 免费档模型指到非官方根时直接说清，不发一条注定被拒的请求。
      final endpointProblem =
          freeModelEndpointProblem(_cfg!.baseUrl, _cfg!.model);
      if (endpointProblem != null) {
        _setError(id, endpointProblem);
        return;
      }

      for (var loop = 0; loop < 5; loop++) {
        _currentAction = loop == 0 ? '分析请求' : '继续执行 ($loop/4)';
        if (mounted) setState(() {});
        final requestData = {
          'model': _cfg!.model,
          'messages': messages,
          'temperature': 0.7,
          'max_tokens': 4096,
        };
        if (tools.isNotEmpty) requestData['tools'] = tools;

        final data = await ZenGate.postChatCompletion(
          dio: dio,
          baseUrl: _cfg!.baseUrl,
          apiKey: _cfg!.effectiveApiKey,
          body: requestData,
        );

        final choice = data['choices']?[0];
        final msg = choice?['message'];
        final content = msg?['content'] ?? '';
        final nativeToolCalls = msg?['tool_calls'] as List?;

        // 本地（非流式）分支的思维链来源：reasoning_content / reasoning。
        // 原来只读 content，这一段被静默丢弃——DeepSeek / GLM 这类模型默认就吐。
        // 走整段替换而不是累加：非流式一次拿完，没有增量可言。
        final reasoningRaw = msg?['reasoning_content'] ?? msg?['reasoning'];
        if (reasoningRaw != null) _rows.setReasoning(id, reasoningRaw.toString());

        // 检测是否需要文本协议（模型不支持原生 function calling）
        final useTextProtocol = ToolProtocol.needsTextProtocol(_cfg!.model);

        List<ParsedToolCall> toolCalls;
        if (nativeToolCalls != null && nativeToolCalls.isNotEmpty) {
          // 原生 function calling
          toolCalls = nativeToolCalls.map((tc) {
            final fn = tc['function'] ?? {};
            final argsStr = fn['arguments'] ?? '{}';
            Map<String, dynamic> args;
            try {
              args = jsonDecode(argsStr) as Map<String, dynamic>;
            } catch (_) {
              args = {};
            }
            return ParsedToolCall(name: fn['name'] ?? '', args: args);
          }).toList();

          messages.add({
            'role': 'assistant',
            'content': content,
            'tool_calls': nativeToolCalls,
          });
        } else if (useTextProtocol && ToolProtocol.hasToolCall(content)) {
          // 文本协议：解析 [TOOL_CALL:...] 标记
          toolCalls = ToolProtocol.parse(content);
          final cleanContent = ToolProtocol.stripToolCalls(content);
          messages.add({'role': 'assistant', 'content': cleanContent});
          _setContent(id, cleanContent);
        } else {
          // 无工具调用 → 结束
          if (content.isNotEmpty) {
            _setContent(id, ToolProtocol.stripToolCalls(content));
          }
          if (content.isEmpty) _setError(id, '无响应内容');
          execLog.finish(content);
          _logExecution(execLog);
          await _saveConversation();
          return;
        }

        if (content.isEmpty && toolCalls.isNotEmpty) {
          _setContent(id, '正在执行工具...');
        }

        for (final tc in toolCalls) {
          final toolName = tc.name;
          final args = tc.args;
          final label = _getToolLabel(toolName, args);

          // ── 记录执行步骤 ──
          final stepIdx = execLog.addStep(toolName, args);
          final step = execLog.steps[stepIdx];
          step.start();

          // ── 创建卡片（running 状态）──
          final cardData = ToolCardData.running(
            index: step.index,
            toolName: toolName,
            label: label,
            args: args,
          );
          _rows.toolCards.add(cardData);
          _setContent(id, '$content\n\n$label');
          _currentAction = label;
          // 卡数 0→1：itemCount 变了，ListView 必须整屏重建一次才多得出这一格。
          // 同一组内后续的更新走 notifier 局部重建（见下面 _notifyToolCards）。
          _rows.notifyToolCards();
          if (mounted) setState(() {});

          // 执行工具（危险命令需用户批准）
          ToolResult result;
          if (await _needsApproval(toolName, args)) {
            final approved = await _showApprovalDialog(toolName, args, label);
            if (!approved) {
              result = ToolResult.fail('用户拒绝了该操作');
              _rows.toolCards.last = ToolCardData.failed(
                index: step.index, toolName: toolName, label: label,
                args: args, error: '用户拒绝', durationMs: 0);
              _rows.notifyToolCards();
              _feedBack(messages, toolName, result, useTextProtocol);
              continue;
            }
            // auto 档的"记住"只在这里生效，而且只记**批准过**的。
            // 拒绝不记：用户这次不想让它跑，不等于下次也不想问。
            _approvedThisSession.add(toolName);
          }
          final startT = DateTime.now();
          result = await _toolEngine.execute(toolName, args);
          final elapsed = DateTime.now().difference(startT).inMilliseconds;

          // 记录结果
          if (result.success) {
            step.complete(result.output);
          } else {
            step.fail(result.output);
          }

          // ── 更新卡片（completed 状态）──
          final updatedCard = result.success
              ? ToolCardData.success(
                  index: step.index,
                  toolName: toolName,
                  label: label,
                  args: args,
                  output: result.output,
                  durationMs: elapsed,
                  diff: WriteDiffBuilder.fromMetadata(result.metadata),
                )
              : ToolCardData.failed(
                  index: step.index,
                  toolName: toolName,
                  label: label,
                  args: args,
                  error: result.output,
                  durationMs: elapsed,
                );
          _rows.toolCards.last = updatedCard;
          // 卡数没变（running → success/failed 是原地替换），只有工具卡那一组
          // 要重画：不再整屏 setState。这是每个工具步骤第二次全屏重建的收敛点。
          _rows.notifyToolCards();

          // 更新消息内容
          // 喂回 LLM。走 ToolVerdictFactory：核对结论追加在结果后面，
          // 模型没法把一次失败读成一次成功。五处回喂点都用它，理由见
          // tool_verdict.dart 的库注释。
          final verdict = ToolVerdictFactory.of(toolName, result);
          _setContent(id, '$content\n\n${verdict.userLabel}: $label');
          messages.add(ToolVerdictFactory.toolMessage(
            tool: toolName,
            result: result,
            useTextProtocol: useTextProtocol,
            callId: '${DateTime.now().millisecondsSinceEpoch}',
          ));
        }
      }

      execLog.finish('达到最大步骤数');
      _logExecution(execLog);
      await _saveConversation();
    } on DioException catch (e) {
      _handleDioErr(e, id);
      execLog.fail('网络错误: ${e.message}');
      _logExecution(execLog);
    } catch (e) {
      _logger.recordError(
        code: ErrorCode.unknown,
        message: '对话异常',
        category: LogCategory.api,
        context: {'mode': _mode.name, 'model': _cfg?.model ?? ''},
        exception: e,
      );
      execLog.fail('异常: $e');
      _logExecution(execLog);
      _setError(id, '发生错误：$e');
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _currentAction = '';
        });
      }
      // 远程模式：上报执行日志到 khy-os 后端
      if (_mode == AppMode.remote && _api != null) {
        _reportToBackend(execLog);
      }
    }
  }

  /// 记录执行日志
  void _logExecution(ExecutionLog log) {
    _logger.i(LogCategory.api, '执行完成',
        details: log.toJson());
    // 写入本地日志文件
    _logger.log(
      LogLevel.info,
      LogCategory.api,
      '工具执行日志',
      details: {
        'conversation': log.conversationId,
        'steps': log.steps.length,
        'success': log.successCount,
        'failed': log.failCount,
        'total_ms': log.totalDurationMs,
        'summary': log.toText(),
      },
    );
  }

  /// 上报到 khy-os 后端
  Future<void> _reportToBackend(ExecutionLog log) async {
    if (_api == null) return;
    try {
      await _api!.reportExecution(log.toJson());
      _logger.i(LogCategory.api, '执行日志已上报到 khy-os 后端');
    } catch (e) {
      _logger.w(LogCategory.api, '上报失败（不影响本地执行）', error: e);
    }
  }

  /// 远程模式：通过 khy-os 后端发送消息
  Future<void> _sendRemote(String text, String id) async {
    try {
      final h = _msgs
          .where((m) => m.content.isNotEmpty && m.id != id)
          .map((m) => {
                'role': m.role == MessageRole.user ? 'user' : 'assistant',
                'content': m.content,
              })
          .toList();
      // 最后一条就是刚发出去的这句。后端会自己把本轮问题追加给模型，
      // 再带一份过去等于让模型把同一个问题读两遍。
      if (h.isNotEmpty && h.last['role'] == 'user' && h.last['content'] == text) {
        h.removeLast();
      }

      final syncOn = _effectiveSyncEnabled;
      await for (final ev in _api!.streamChat(
        question: text,
        history: h,
        // 关掉同步就不报 sessionId。后端只对报了 id 的调用方写共享会话，
        // 不报即"只存本机"——这个开关只能由客户端表达，服务端没有对端开关。
        sessionId: syncOn ? _currentConvId : null,
      )) {
        final t = ev['type'];
        if (t == 'start' || t == 'done') {
          // 以后端回显为准：它才是真正落进共享会话的那个 id。
          final sid = ev['sessionId'];
          if (sid is String && sid.isNotEmpty) _currentConvId = sid;
        }
        if (t == 'chunk') {
          _appendContent(id, (ev['content'] ?? '').toString());
        } else if (t == 'thinking_content') {
          // 后端早就把网关的 thinking chunk 转成这个事件下发（routes/ai.js 的
          // thinking 分支），Dart 侧原来只认 chunk/done/error，它落在无形。
          _rows.appendReasoning(id, (ev['text'] ?? '').toString());
        } else if (t == 'blocks') {
          // 流式结构化块：done 信封定案前的已收块。msg_id 缺席的块事件无从
          // 归属，丢弃不猜。
          final mid = ev['msg_id'];
          final rawBlocks = ev['blocks'];
          if (mid is String && mid.isNotEmpty && rawBlocks is List) {
            final turn = _envelopeBuffer.absorbBlocks(
              msgId: mid,
              rawBlocks: List<Object?>.from(rawBlocks),
              localId: id,
            );
            if (turn != null) {
              if (!_structuredTurns.containsKey(id)) {
                setState(() => _structuredTurns[id] = turn);
              }
              _rows.setContent(id, turn.plainProjection());
              _scrollToBottom();
            }
          }
        } else if (t == 'done') {
          final c = ev['content'];
          if (c != null) {
            final text = c.toString();
            final reply = StructuredReply.tryParseText(text);
            if (reply == null) {
              // 流式块开过轮但 done 是纯文本：把正文按 L3 落进同一轮收场，
              // 不留悬挂转圈；没开过轮就是普通旧路径。
              final open = _structuredTurns[id];
              if (open != null && open.state == TurnState.receiving) {
                open.applyPlan(
                  RenderPlan(EnvelopeTier.l3Plain, structured: false, text: text),
                );
                _rows.setContent(id, open.plainProjection());
              } else {
                _setContent(id, text);
              }
            } else if (!_applyStructuredReply(id, reply)) {
              // 同一 msg_id 只渲染一次：重放投递不产生第二个气泡，本次的
              // 占位行摘掉，首次渲染的那个气泡保持原样。
              setState(() {
                _msgs.removeWhere((m) => m.id == id);
                _structuredTurns.remove(id);
              });
            }
          }
        } else if (t == 'sync') {
          // 落盘发生在 done 之后，所以结果单独回一条。`done` 里回显的
          // sessionId 只证明 id 合法，不证明写进去了——界面只认这一条。
          if (syncOn) {
            _currentSyncState = ev['persisted'] == true
                ? ConversationSync.stateSynced
                : ConversationSync.stateFailed;
          }
        } else if (t == 'error') {
          if (syncOn) _currentSyncState = ConversationSync.stateFailed;
          final msg = (ev['message'] ?? '远程请求失败').toString();
          // 结构化轮已开：保已收块 + failed 状态行（A 阶段 T5），失败行的
          // 措辞归 EnvelopeTurn，这里不代答。旧路径行为不变。
          if (!_envelopeBuffer.failByLocalId(id, msg)) {
            _setError(id, msg);
          }
          return;
        }
      }
      await _saveConversation();
    } catch (e) {
      _logger.e(LogCategory.api, '远程请求失败', error: e);
      // 这一轮根本没到电脑，别让上一轮的"已同步"继续挂着。
      if (_effectiveSyncEnabled) {
        _currentSyncState = ConversationSync.stateFailed;
      }
      if (!_envelopeBuffer.failByLocalId(id, '$e')) {
        _setError(id, 'khy-os 连接失败：$e');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 结构化回复落屏。返回 false = 重复 msg_id（本次投递不渲染）。
  bool _applyStructuredReply(String aid, StructuredReply reply) {
    final turn = _envelopeBuffer.finalize(localId: aid, reply: reply);
    if (turn == null) return false;
    setState(() => _structuredTurns[aid] = turn);
    // content 写纯文本投影：保存与上送历史有正文；行渲染走 [_structuredTurns]
    // 的结构化视图，投影不直接上屏。
    _rows.setContent(aid, turn.plainProjection());
    _scrollToBottom();
    return true;
  }

  // ==================== Session ====================

  void _updateTitleFromFirstMessage(String text) {
    if (_currentTitle == '新对话' && text.isNotEmpty) {
      setState(() => _currentTitle =
          text.length > 20 ? '${text.substring(0, 20)}...' : text);
    }
  }

  /// 把当前对话的工作空间根同步给原生侧。
  ///
  /// 为什么必须显式同步：原生侧持有"文件工具的根"这个设备级状态，而 Dart 侧
  /// 持有"这个对话挑了哪个根"。两边不一致时，症状是"我明明选了这个目录，
  /// 文件却不在这"——没有任何一方会报错。所以每次切换对话都推一次，
  /// 包括 null（没挑），那意味着恢复 App 私有目录。
  Future<void> _applyWorkspaceRoot(String? root) async {
    await FileService.setWorkRoot(
        ConversationWorkspace.effectiveRoot(root));
  }

  Future<void> _saveConversation() async {
    if (_msgs.isEmpty) return;
    final conv = Conversation(
      id: _currentConvId,
      title: _currentTitle,
      messages: _msgs.map((m) => ChatMsg(
        role: m.role == MessageRole.user ? 'user' : 'assistant',
        content: m.content,
        // 思维链必须跟着存，否则切会话再切回那段"先想"就没了。取消息自己的
        // 字段而不是行 store 的存档——前者是唯一真源（见 ChatRowStore）。
        reasoning: m.reasoning,
        timestamp: m.timestamp,
      )).toList(),
      // 少了这一行，用户挑的工作目录会在下一次保存时静默消失——而界面
      // 上什么都不会提示。
      workspaceRoot: _currentWorkspaceRoot,
      syncToDesktop: _currentSyncOverride,
      syncState: _currentSyncState,
    );
    await ConversationDB.save(conv);
    await _loadConversations();
  }

  void _newConversation() {
    setState(() {
      _rows.clear();
      _rows.clearToolCards();
      // turn 归属会话：换会话（新建/载入/分享开新）一并清渲染现场。
      _structuredTurns.clear();
      _envelopeBuffer.reset();
      _currentConvId = 'conv_${DateTime.now().millisecondsSinceEpoch}';
      _currentTitle = '新对话';
      _currentWorkspaceRoot = null;
      // 新对话没有单独表过态，回到全局默认；上一次的结果也不属于它。
      _currentSyncOverride = null;
      _currentSyncState = null;
    });
    if (mounted) Navigator.pop(context);
  }

  Future<void> _loadConversation(String id) async {
    final conv = await ConversationDB.load(id);
    if (conv == null) return;
    setState(() {
      _rows.clear();
      _rows.clearToolCards();
      // turn 归属会话：换会话（新建/载入/分享开新）一并清渲染现场。
      _structuredTurns.clear();
      _envelopeBuffer.reset();
      _currentConvId = conv.id;
      _currentTitle = conv.title;
      _currentWorkspaceRoot = conv.workspaceRoot;
      _currentSyncOverride = conv.syncToDesktop;
      _currentSyncState = conv.syncState;
      _applyWorkspaceRoot(conv.workspaceRoot);
      for (final msg in conv.messages) {
        // 不叫 id：那会盖住本方法的入参（会话 id），而下面还要用 conv.id。
        final msgId = '${msg.timestamp.millisecondsSinceEpoch}';
        _msgs.add(ChatMessage(
          id: msgId,
          conversationId: conv.id,
          role: msg.role == 'user' ? MessageRole.user : MessageRole.assistant,
          content: msg.content,
          // 老会话没有这个键 → null → 不渲染思维链块，行为一字不变。
          reasoning: msg.reasoning,
          timestamp: msg.timestamp,
        ));
        // 还要灌进行 store：行 notifier 首建时读的是 store 的思维链存档，
        // 只写 ChatMessage 的话那一行永远渲染不出块来——这正是本 bug 的读侧。
        _rows.setReasoning(msgId, msg.reasoning ?? '');
      }
    });
    if (mounted) Navigator.pop(context);
  }

  Future<void> _deleteConversation(String id) async {
    await ConversationDB.delete(id);
    if (_currentConvId == id) {
      _newConversation();
    } else {
      await _loadConversations();
    }
  }

  // ==================== UI ====================

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return Scaffold(
      key: _scaffoldKey,
      drawer: _buildDrawer(Theme.of(context).colorScheme),
      body: AuroraBackground(
        child: SafeArea(
          child: Column(
            children: [
              _header(palette),
              Expanded(child: _msgs.isEmpty ? _welcome(palette) : _msgList()),
              _inputDock(palette),
            ],
          ),
        ),
      ),
    );
  }

  /// 本屏仅有的两处玻璃面（规范 §4）：头部 slab 与输入 dock，共用这套配方。
  /// 正文卡与气泡禁止 blur，所以 blur 层数恒为 2，不随内容增长。
  Widget _glassSlab(
    AppPalette palette, {
    required Widget child,
    required double tint,
    EdgeInsetsGeometry padding = EdgeInsets.zero,
    EdgeInsetsGeometry margin = EdgeInsets.zero,
    BorderRadius borderRadius =
        const BorderRadius.all(Radius.circular(AppRadius.large)),
    bool showBorder = true,
  }) {
    return Padding(
      padding: margin,
      child: ClipRRect(
        borderRadius: borderRadius,
        child: BackdropFilter(
          filter:
              ui.ImageFilter.blur(sigmaX: AppGlass.sigma, sigmaY: AppGlass.sigma),
          child: Container(
            padding: padding,
            decoration: BoxDecoration(
              color: palette.surface.withValues(alpha: tint),
              borderRadius: borderRadius,
              border: showBorder
                  ? Border.all(
                      color: palette.glassStroke, width: AppStroke.thin)
                  : null,
            ),
            child: child,
          ),
        ),
      ),
    );
  }

  Duration _animDur(Duration base) =>
      MediaQuery.maybeOf(context)?.disableAnimations ?? false
          ? Duration.zero
          : base;

  /// 头部 slab：60dp 顶栏 + 能力条共用一层 blur。五件套从顶栏移走后，
  /// 标题列拿到整行宽度，不再把「khy-os」挤成两行。
  Widget _header(AppPalette palette) {
    return _glassSlab(
      palette,
      tint: AppGlass.bar,
      borderRadius: BorderRadius.zero,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 60,
            child: Padding(
              padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.cardPadNarrow),
              child: Row(
                children: [
                  IconButton(
                    icon: Icon(Icons.menu_rounded,
                        size: 22, color: palette.textSecondary),
                    onPressed: () => _scaffoldKey.currentState?.openDrawer(),
                    tooltip: '会话列表',
                    constraints:
                        const BoxConstraints(minWidth: 40, minHeight: 40),
                    padding: EdgeInsets.zero,
                  ),
                  const SizedBox(width: AppSpacing.dense),
                  // 品牌块：墨黑底 + 琥珀主标。
                  const KhyBrandTile(size: 36, radius: AppRadius.small),
                  const SizedBox(width: AppSpacing.inner),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Flexible(
                              child: Text('khy-os',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppText.title
                                    .copyWith(color: palette.textPrimary)),
                            ),
                            const SizedBox(width: AppSpacing.dense),
                            _statusDot(palette),
                          ],
                        ),
                        Text(
                          _currentModelLabel(),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppText.secondary
                              .copyWith(color: palette.textSecondary),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: Icon(Icons.settings_rounded,
                        size: 22, color: palette.textSecondary),
                    onPressed: () async {
                      await Navigator.push(context,
                          MaterialPageRoute(builder: (_) => const SettingsScreenNew()));
                      // 设置页可能改了全局同步默认或工具许可模式。回来不重读，
                      // 同步 chip 会继续按旧值说话——而它正是用户来这一页
                      // 想核对的那句话。
                      if (mounted) _loadConfig();
                    },
                    tooltip: '设置',
                    constraints:
                        const BoxConstraints(minWidth: 40, minHeight: 40),
                    padding: EdgeInsets.zero,
                  ),
                ],
              ),
            ),
          ),
          Container(height: AppStroke.thin, color: palette.glassStroke),
          _capabilityStrip(palette),
        ],
      ),
    );
  }

  /// 能力条最左的同步 chip：显示当前对话的同步状态，点开是单对话开关。
  ///
  /// 颜色不是装饰：失败用错误色、已同步用成功色、关闭用中性色。同步开但
  /// 还没发过消息时用主色——它和"关"是两回事，不该长得一样。
  Widget _syncChip(AppPalette palette) {
    final status = _currentSyncStatus;
    final color = _syncColor(status, palette);
    return GestureDetector(
      onTap: _openSyncSheet,
      child: Container(
        padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.dense, vertical: 5),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(AppRadius.small),
          border: Border.all(
            color: color.withValues(alpha: 0.45),
            width: AppStroke.thin,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(_syncIcon(status), size: 12, color: color),
            const SizedBox(width: 4),
            Text(ConversationSync.label(status),
                style: AppText.label.copyWith(color: color)),
          ],
        ),
      ),
    );
  }

  /// 单对话同步面板。
  ///
  /// 改的是 `_currentSyncOverride`：与全局默认相同时存 null（跟随默认），
  /// 不同才存显式值。这样用户以后改全局默认，没单独表过态的对话会一起走，
  /// 而不是永远停在旧默认上。
  ///
  /// 关掉时**不清空**电脑副本、也不调用任何删除——本机没有那条通路，
  /// 面板文字也如实这么说。
  Future<void> _openSyncSheet() async {
    var value = _effectiveSyncEnabled;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) {
        final palette = AppPalette.of(ctx);
        return StatefulBuilder(
          builder: (ctx, setSheetState) => Padding(
            padding: const EdgeInsets.fromLTRB(
                AppSpacing.cardPadNarrow,
                0,
                AppSpacing.cardPadNarrow,
                AppSpacing.section),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('会话同步',
                    style: AppText.title.copyWith(color: palette.textPrimary)),
                const SizedBox(height: AppSpacing.dense),
                Text(
                  ConversationSync.detail(_currentSyncStatus),
                  style: AppText.secondary
                      .copyWith(color: palette.textSecondary),
                ),
                const SizedBox(height: AppSpacing.section),
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('这个对话同步到电脑',
                              style: AppText.body
                                  .copyWith(color: palette.textPrimary)),
                          Text(
                            value
                                ? '开：每条消息写入电脑的共享会话'
                                : '关：只存本机，电脑上已有的副本保留',
                            style: AppText.secondary
                                .copyWith(color: palette.textSecondary),
                          ),
                        ],
                      ),
                    ),
                    Switch(
                      key: const Key('conversation-sync-switch'),
                      value: value,
                      onChanged: (v) async {
                        setSheetState(() => value = v);
                        setState(() {
                          _currentSyncOverride =
                              v == _globalSyncEnabled ? null : v;
                          // 重新打开时不该显示"已同步"：打开之后还没有一轮
                          // 真的写进去，那是屏幕上的一句假话。
                          if (!v) _currentSyncState = null;
                        });
                        await _saveConversation();
                      },
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.dense),
                Text(
                  '默认值在「设置 → 会话同步」里改；单独改过的对话不受它影响。',
                  style:
                      AppText.micro.copyWith(color: palette.textFaint),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  /// Mode toggle: 独立 ↔ 远程。落在能力条右端（28dp 分段控件），
  /// 不再占顶栏宽度。
  Widget _modeToggle(AppPalette palette) {
    return Container(
      decoration: BoxDecoration(
        color: palette.surfaceHigh,
        borderRadius: BorderRadius.circular(AppRadius.pill),
        border: Border.all(color: palette.strokeStrong, width: AppStroke.thin),
      ),
      padding: const EdgeInsets.all(2),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _modeChip('独立', AppMode.standalone, Icons.phone_android, palette),
          _modeChip('远程', AppMode.remote, Icons.dns, palette),
        ],
      ),
    );
  }

  Widget _modeChip(String label, AppMode mode, IconData icon, AppPalette palette) {
    final sel = _mode == mode;
    final canUse = mode == AppMode.standalone || (_api != null && _api!.isConnected);
    final fg = sel
        ? Colors.white
        : palette.textSecondary.withValues(alpha: canUse ? 1 : 0.45);
    return PressableScale(
      onTap: canUse
          ? () async {
              setState(() => _mode = mode);
              _logger.i(LogCategory.ui, '切换到${mode.name}模式');
              // 落盘：这是用户对「这一轮由谁执行」的决定，和 permissionMode
              // 同性质，不该被下一次冷启动悄悄改掉。
              await AppConfig.save(remoteMode: mode == AppMode.remote);
            }
          : null,
      child: AnimatedContainer(
        duration: _animDur(AppDuration.spring),
        curve: AppCurves.spring,
        padding:
            const EdgeInsets.symmetric(horizontal: AppSpacing.dense, vertical: 3),
        decoration: BoxDecoration(
          gradient: sel ? AppGradients.brand2 : null,
          borderRadius: BorderRadius.circular(AppRadius.pill),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 12, color: fg),
            const SizedBox(width: 3),
            Text(
              label,
              style: AppText.label.copyWith(
                color: fg,
                fontWeight: sel ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 状态点 + 状态文字并入标题行尾；点击仍是复测连接（行为不变）。
  Widget _statusDot(AppPalette palette) {
    final color = _statusColor(palette);
    return PressableScale(
      onTap: _busy ? null : _testConn,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 14,
            height: 14,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.3),
              shape: BoxShape.circle,
            ),
            child: Center(
              child: Container(
                width: 8,
                height: 8,
                decoration:
                    BoxDecoration(color: color, shape: BoxShape.circle),
              ),
            ),
          ),
          const SizedBox(width: 4),
          Flexible(
            child: Text(
              _statusText(),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppText.label.copyWith(color: palette.textSecondary),
            ),
          ),
        ],
      ),
    );
  }

  /// 能力条：就绪 chip 横滚在左、模式切换在右，各占各的层级。
  /// 窄屏（320dp）下 chip 区滚动而不溢出。版本号按规范只在设置页页脚出现。
  Widget _capabilityStrip(AppPalette palette) {
    return Container(
      height: 40,
      padding:
          const EdgeInsets.symmetric(horizontal: AppSpacing.cardPadNarrow),
      child: Row(
        children: [
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // 同步状态放在最左：它是"这条消息去哪"的答案，比"无障碍开没开"
                  // 更常被问起。点开是单对话开关。
                  _syncChip(palette),
                  const SizedBox(width: AppSpacing.dense),
                  // future 缓存在 State 字段里，不在 build 里现调：check() 走
                  // MethodChannel（异步、碰原生壳），原来每次父级重建——包括每次
                  // 按键、每个流式 chunk——都重新探测一次。能力态本来就不会
                  // 随消息变化，探测一次就够。
                  _capChip(Icons.accessibility_new, '无障碍',
                      () => _a11yReady, palette),
                  const SizedBox(width: AppSpacing.dense),
                  _capChip(Icons.screenshot, '截屏', () => _screenReady,
                      palette),
                  const SizedBox(width: AppSpacing.dense),
                  _capChip(Icons.terminal, 'Shell', () async => true, palette),
                  const SizedBox(width: AppSpacing.dense),
                  _keepAwakeChip(palette),
                ],
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.dense),
          _modeToggle(palette),
        ],
      ),
    );
  }

  /// 屏幕常亮开关。
  ///
  /// 为什么单独给一个按钮，而不是只在反代提问期间自动亮：自动那份（MainActivity
  /// 的 FLAG_KEEP_SCREEN_ON）只覆盖"正在等 amoo"这几分钟。但读气泡、逐级点目录、
  /// 长任务同样不该中途熄屏——熄一次，无障碍树过期，接着的操作全建立在旧状态上。
  /// 那种场景下用户要的是"我说别熄就别熄"，不是一个猜他意图的自动策略。
  ///
  /// 用 _KeepAwake 而不是直接调平台通道：熄屏是窗口级状态，App 内有单一事实来源
  /// 比每个页面各自 addFlags 可靠——否则两个页面同时开关会互相抵消。
  Widget _keepAwakeChip(AppPalette palette) {
    return ListenableBuilder(
      listenable: KeepAwake.instance,
      builder: (ctx, _) {
        final on = KeepAwake.instance.on;
        return GestureDetector(
          onTap: () => KeepAwake.instance.toggle(),
          child: Container(
            padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.dense, vertical: 5),
            decoration: BoxDecoration(
              color: on
                  ? palette.warning.withValues(alpha: 0.16)
                  : palette.surfaceHigh,
              borderRadius: BorderRadius.circular(AppRadius.small),
              border: Border.all(
                color: on
                    ? palette.warning.withValues(alpha: 0.5)
                    : palette.stroke,
                width: AppStroke.thin,
              ),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(on ? Icons.light_mode : Icons.light_mode_outlined,
                    size: 12, color: on ? palette.warning : palette.textSecondary),
                const SizedBox(width: 4),
                Text(on ? '常亮中' : '常亮',
                    style: AppText.label.copyWith(
                        color: on ? palette.warning : palette.textSecondary)),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _capChip(
      IconData icon, String label, Future<bool> Function() check, AppPalette palette) {
    return FutureBuilder<bool>(
      future: check(),
      builder: (ctx, snap) {
        final active = snap.data ?? false;
        return Container(
          padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.dense, vertical: 5),
          decoration: BoxDecoration(
            color: active
                ? palette.primary.withValues(alpha: 0.14)
                : palette.surfaceHigh,
            borderRadius: BorderRadius.circular(AppRadius.small),
            border: Border.all(
              color: active
                  ? palette.primary.withValues(alpha: 0.42)
                  : palette.stroke,
              width: AppStroke.thin,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon,
                  size: 12,
                  color: active ? palette.primary : palette.textSecondary),
              const SizedBox(width: 4),
              Text(label,
                  style: AppText.label.copyWith(
                      color:
                          active ? palette.primary : palette.textSecondary)),
            ],
          ),
        );
      },
    );
  }

  // ==================== Messages ====================

  /// 一条消息行。局部重建的挂载点。
  ///
  /// `ValueListenableBuilder` 只包住这一行：chunk 到达时重建范围是这一个子树，
  /// 不是整个 Scaffold。思维链块在**这个 builder 里**构造，所以它拿到的永远是
  /// 最新正文——在外面构造会留下上一次的 reasoning。
  Widget _rowFor(ChatMessage msg) {
    // 结构化回复：这一行画的是块的序列（结构化/半结构化/纯文本三档），不是
    // 普通 BubbleRow。turn 自带 revision notifier，视图内部局部重建。
    final structuredTurn = _structuredTurns[msg.id];
    if (structuredTurn != null) {
      return EnvelopeReplyView(turn: structuredTurn);
    }
    final n = _rows.notifierFor(msg);
    return ValueListenableBuilder<ChatRowState>(
      key: ValueKey(msg.id),
      valueListenable: n,
      builder: (ctx, state, _) {
        final reasoning = state.reasoning;
        // 门控：assistant 且有思维链。用户消息不可能有；空思维链不渲染空壳
        // （远程模式下 thinking_content 可能永不到达，见 ThinkingBlock 注释）。
        final thinking = msg.role == MessageRole.assistant &&
                reasoning.trim().isNotEmpty
            ? ThinkingBlock(reasoning: reasoning, streaming: _busy)
            : null;
        return ChatBubbleRow(
          message: state.message,
          thinking: thinking,
          busy: _busy,
          action: _currentAction,
        );
      },
    );
  }

  Widget _msgList() {
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.page, vertical: AppSpacing.cardGap),
      // +1 = 头部那张 amoo 反代卡（仅 amoo 在场时）。它必须常驻：一轮提问
      // 约 6 分钟，卡片滚出视野的话用户看不到进度，也点不到「停止」。
      //
      // 缺席时不加这一格。理由不是省地方：那张卡问不出去（前台预检必失败），
      // 而 AI 页第一行就是它——用户第一眼看到的是一个永远停着的东西。
      itemCount: _msgs.length +
          (_rows.toolCards.isNotEmpty ? 1 : 0) +
          (_amooOn ? 1 : 0),
      itemBuilder: (_, i) {
        if (_amooOn && i == 0) {
          return AmooTaskCard(
            key: _amooCardKey,
            target: _chatTarget,
            onReply: _onAmooReply,
            onFinished: _onAmooFinished,
          );
        }
        // 索引基准必须和 itemCount 那个条件同步改。漏改的后果不是"少一条"，
        // 是 RangeError：缺席时 i==0 直接取 _msgs[-1]，而那是每次构建都走的
        // 路径——整块 AI 页布不出来，正是本轮要修的那块屏。
        final j = i - (_amooOn ? 1 : 0);
        // Interleave tool cards before the last assistant message
        if (j < _msgs.length) {
          final msg = _msgs[j];
          final isLastAssistant =
              msg.role == MessageRole.assistant && j == _msgs.length - 1;
          if (isLastAssistant && _rows.toolCards.isNotEmpty) {
            // 工具卡整组与末条气泡挤在同一个 item 里。整组自己订阅
            // _rows.toolCardsListenable：卡数 0→1 那次仍走整屏 setState（itemCount
            // 变了，必须），之后的「建卡 / 完成」只重建这一组。
            return ListenableBuilder(
              key: ValueKey('tools_${msg.id}'),
              listenable: _rows.toolCardsListenable,
              builder: (_, _) => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ToolExecutionSummary(cards: _rows.toolCardsListenable.value),
                  for (final card in _rows.toolCardsListenable.value)
                    ToolCard(data: card),
                  _rowFor(msg),
                ],
              ),
            );
          }
          return _rowFor(msg);
        }
        return SizedBox.shrink();
      },
    );
  }


  // ==================== Input dock ====================

  /// 快捷条 + 输入区共用一只玻璃容器（规范 §6.1.5 第 2 处 blur）；
  /// 头部 slab 是第 1 处，本屏 blur 层数就此封顶。
  Widget _inputDock(AppPalette palette) {
    // 底部 margin 要从 AppSpacing.dense 抬到底栏之上：宿主 Scaffold 用了
    // extendBody: true，body 伸到玻璃底栏之下，而这个坞是**固定**的底部元素，
    // 被压住的正是发送按钮和输入框——比列表划不到底更严重。
    //
    // 只抬 margin、不动 padding：玻璃板自己的观感不变，只是整体上移让开底栏。
    // 消息列表那一侧仍然保持原样（本页底部被坞占满，没有可透出的滚动内容）。
    //
    // 坞本身不描边：输入框自带一圈描边（聚焦态还要换成主色），坞再描就是
    // 「回」字双层框。玻璃底与 blur 保留，边框只留输入框那一圈。
    return _glassSlab(
      palette,
      tint: AppGlass.dock,
      showBorder: false,
      margin: const EdgeInsets.fromLTRB(
          AppSpacing.page, 0, AppSpacing.page, AppSpacing.dense),
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _quickBar(palette),
          const SizedBox(height: AppSpacing.dense),
          _inputRow(palette),
        ],
      ),
    );
  }

  Widget _quickBar(AppPalette palette) {
    // 横向滚动：窄屏（360dp）下加第 6 个 chip 也不会 RenderFlex overflow
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _quickBtn(Icons.screenshot, '截屏', () async {
            final ok = await DeviceControl.startScreenCapture();
            if (ok) {
              await Future.delayed(const Duration(seconds: 1));
              final data = await DeviceControl.captureFrame();
              if (data != null) {
                _addSystemMsg('已截屏');
              }
            }
          }, palette),
          _quickBtn(Icons.accessibility_new, '无障碍', () {
            DeviceControl.openAccessibilitySettings();
          }, palette),
          _quickBtn(Icons.home, '主页', () async {
            await DeviceControl.a11yGlobalAction(DeviceControl.globalActionHome);
          }, palette),
          _quickBtn(Icons.arrow_back, '返回', () async {
            await DeviceControl.a11yGlobalAction(DeviceControl.globalActionBack);
          }, palette),
          _quickBtn(Icons.calculate, '计算', () {
            _input.text = '帮我计算: ';
            _inputFocus.requestFocus();
          }, palette),
          // amoo：把输入框现有内容带进发送面板，用户仍需再点一次「分享到 amoo」。
          //
          // 条件渲染而不是置灰：置灰的 chip 照样占一格、照样被点到，而它背后
          // 的 sheet 在 amoo 缺席时只会说「未安装」——那已经是设备页那张卡的
          // 职责了，快捷栏再重复一遍没有信息量。
          if (_amooOn)
            _quickBtn(Icons.forum_outlined, 'amoo', () {
              showAmooComposer(context, initialText: _input.text);
            }, palette),
          // 模型切换：放在这里而不是只放在设置页，是因为「换个模型试试」
          // 是在对话过程中冒出来的念头——为了切个模型退出对话、进设置、
          // 翻到 API 配置、选完再回来，中间还大概率被底部导航搞混。
          _quickBtn(Icons.swap_horiz, _modelLabel(), () {
            _pickModel(palette);
          }, palette),
        ],
      ),
    );
  }

  /// 快捷条上显示的模型名。空配置时说「选模型」，别显示一个空 chip。
  String _modelLabel() {
    // 对着 amoo 时显示 amoo，不显示背后那个配置好的模型名——否则用户
    // 看着 chip 上的 "glm-4.6" 以为话是它答的，而其实发去了 Amoo。
    if (_chatTarget.isDriver('amoo')) return 'Amoo';
    final m = _cfg?.model.trim() ?? '';
    if (m.isEmpty) return '选模型';
    // 模型名动辄 40+ 字符（vendor/model:free），chip 宽度有限。
    // 保留头尾、中间省略：尾部常是版本/免费标记，是区分不同档位的依据。
    if (m.length <= 18) return m;
    return '${m.substring(0, 11)}…${m.substring(m.length - 6)}';
  }

  /// 随时换模型或切 driver。选中即落盘并立即生效——下一次发送就用它。
  ///
  /// 为什么落盘：只改内存的话，切到别的 tab 再回来（或重启 App）就丢，
  /// 而用户以为选过了。那正是「选了没生效」最常见的来路。
  ///
  /// **driver 与模型分流**（Q5 裁决）：driver 是通道、模型是模型，混排会让
  /// 用户以为「选了个新模型」其实切了通道。选 driver 只切目标、不落盘
  /// （它不是一个模型档位，是另一条链路）；选模型照旧落盘。
  Future<void> _pickModel(AppPalette palette) async {
    // 先读配置再判：_cfg 是异步读的，首启欢迎页点进来时它可能还是 null——
    // 那时把「driver 不需要 API」的路也一起挡掉，用户连脚本 driver 都选不了。
    final cfg = _cfg ?? await AppConfig.loadEffective();
    if (!mounted) return;
    // driver 不需要 API：没配 key 也要能选。原来的判据是 baseUrl 空就直接
    // 返回，那会让「不花自己额度」这条路只对已经配好 key 的人生效——
    // 而那正是最需要它的人。
    final anyDriver = AppDriverRegistry.instance
        .registryFor(cfg, ToolEngineHostClient(_driverToolEngine))
        .enabledDrivers
        .isNotEmpty;
    if (cfg.baseUrl.isEmpty && !anyDriver) {
      _addSystemMsg('还没配 API：先去设置页选一个提供商、填好 Key。');
      return;
    }

    // 拉一次模型列表。拉不到就退回内置默认列表——离线时也要能换，
    // 否则「随时切换」在有网时才成立。
    List<ModelInfo> models = const [];
    if (cfg.baseUrl.isNotEmpty) {
      try {
        models = await ModelRegistry.fetchModels(cfg.baseUrl, cfg.effectiveApiKey);
      } catch (_) {
        models = const [];
      }
      if (models.isEmpty) {
        final provider = BuiltInKeys.matchBaseUrl(cfg.baseUrl);
        models = ModelRegistry.getDefaultModels(provider ?? '');
      }
    }
    // driver 组：从注册表动态生成——加第四个 driver 时这里一行不改
    // （UI 不自己维护 driver 清单，那是 T2 判据的对象）。
    final drivers = <ModelInfo>[];
    final reg = AppDriverRegistry.instance.registryFor(
      cfg,
      ToolEngineHostClient(_driverToolEngine),
    );
    for (final d in reg.enabledDrivers) {
      drivers.add(ModelInfo(
        id: d.id,
        name: AppDriverRegistry.displayName(d.id),
        provider: 'driver',
      ));
    }
    if (!mounted) return;

    final picked = await showModalBottomSheet<ModelInfo>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => ModelPickerSheet(
        models: models,
        drivers: drivers,
        // 对着 amoo 时勾选 driver 组那行，不是勾背后那个模型。
        currentId: _chatTarget.isDriver('amoo') ? 'amoo' : (_cfg?.model.trim() ?? ''),
        palette: palette,
      ),
    );
    if (picked == null || !mounted) return;

    if (picked.provider == 'driver') {
      _chatTarget.select(picked.id);
      setState(() {});
      _addSystemMsg('已切到 ${picked.name}：接下来由它回答，不需要 API Key。');
      return;
    }

    final current = _cfg?.model.trim() ?? '';
    if (picked.id == current && !_chatTarget.isDriver('amoo')) return;
    // 选回真模型时把目标也切回来。只改 model 不切 target 的话，输入框还对
    // 着某个 driver，用户会以为「选了模型但没生效」——那是比没有这个功能更糟的体验。
    _chatTarget.select(ActiveDriverNotifier.kAssistantDriverId);
    await AppConfig.save(model: picked.id);
    if (!mounted) return;
    setState(() => _cfg = _cfg!.copyWith(model: picked.id));
    _addSystemMsg('已切换到模型：${picked.name}');
  }

  Widget _quickBtn(
      IconData icon, String label, VoidCallback onTap, AppPalette palette) {
    return PressableScale(
      onTap: onTap,
      child: Container(
        height: 32,
        margin: const EdgeInsets.only(right: AppSpacing.dense),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.inner),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: palette.surfaceHigh,
          borderRadius: BorderRadius.circular(AppRadius.pill),
          border: Border.all(color: palette.stroke, width: AppStroke.thin),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: palette.primary),
            const SizedBox(width: 4),
            Text(label,
                style: AppText.label.copyWith(color: palette.textPrimary)),
          ],
        ),
      ),
    );
  }

  Widget _inputRow(AppPalette palette) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          // 聚焦描边只由 _inputFocus 驱动，不再靠整屏 setState（原 initState 里
          // 那个 `_inputFocus.addListener(() => setState(() {}))`）。TextField
          // 连同 hintText 一起在这棵子树里，重建范围就是输入坞本身。
          child: ListenableBuilder(
            listenable: _inputFocus,
            builder: (ctx, _) {
              final focused = _inputFocus.hasFocus;
              return AnimatedContainer(
                duration: _animDur(AppDuration.micro),
                curve: AppCurves.standard,
                constraints:
                    const BoxConstraints(minHeight: 48, maxHeight: 120),
                decoration: BoxDecoration(
                  color: palette.surfaceHigh,
                  borderRadius: BorderRadius.circular(AppRadius.medium),
                  border: Border.all(
                    color: focused ? palette.primary : palette.stroke,
                    width: focused ? AppStroke.focus : AppStroke.thin,
                  ),
                  boxShadow: focused ? AppShadows.glowSoft : null,
                ),
                padding:
                    const EdgeInsets.symmetric(horizontal: AppSpacing.page),
                child: TextField(
                  controller: _input,
                  focusNode: _inputFocus,
                  maxLines: null,
                  keyboardType: TextInputType.multiline,
                  textInputAction: TextInputAction.send,
                  style: AppText.body.copyWith(color: palette.textPrimary),
                  decoration: InputDecoration(
                    // 目标切换：本机助手秒回，amoo 约 6 分钟且期间它必须留在前台。
                    // 提示词要说出这个差别，否则用户对着 amoo 敲一句长问题，
                    // 等半天以为卡死了。
                    hintText: _chatTarget.isDriver('amoo')
                        ? '问 amoo（约 6 分钟，期间别切走）...'
                        : '输入消息...',
                    hintStyle: AppText.body.copyWith(color: palette.textFaint),
                    // 主题的 enabled/focused 描边（app_theme.dart inputDecorationTheme）
                    // 会把这里为 null 的字段回填成 OutlineInputBorder——与外层
                    // 容器自己的聚焦描边叠成「回」字双框。聚焦态由外层容器一手
                    // 包办（未聚焦 stroke / 聚焦 primary + glow），三条边在这里
                    // 全部显式关死，不给 applyDefaults 回填的机会。
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    contentPadding:
                        const EdgeInsets.symmetric(vertical: 12),
                  ),
                  onSubmitted: (_) {
                    if (_chatTarget.isDriver('amoo')) {
                      _askAmooFromMainInput();
                    } else {
                      _sendMessage();
                    }
                  },
                ),
              );
            },
          ),
        ),
        const SizedBox(width: AppSpacing.dense),
        _targetToggle(palette),
        const SizedBox(width: AppSpacing.dense),
        _sendButton(palette),
      ],
    );
  }

  /// 目标切换：本机助手 ↔ amoo。放在输入框左边，一眼能看到"我这句是发给谁的"。
  ///
  /// 为什么值得占这一格地方：两个目标的延迟差 60 倍（秒回 vs 约 6 分钟），
  /// 而且问 amoo 期间不能切走。不说明白，用户会对着一顿等还以为卡死。
  ///
  /// amoo 缺席时仍然渲染，只是不能切：一个永远发不出去的目标比没有这个
  /// 目标更糟，但为了它把布局改掉又是另一笔代价——toggle 的宽度会变，
  /// 输入框跟着抖。所以占位保留、onTap 置 null。
  Widget _targetToggle(AppPalette palette) {
    return ListenableBuilder(
      listenable: _chatTarget,
      builder: (ctx, _) {
        // amoo 不在时永远显示「助手」态：探测回调已经把 value 切回来了，
        // 这里再并一次是防"切过去之后才探测失败"的那个瞬间。
        final amoo = _amooOn && _chatTarget.isDriver('amoo');
        return GestureDetector(
          onTap: _amooOn
              ? () {
                  // 显式二选一而不是 notifier.toggle()：toggle 隐含「全世界
                  // 只有两个目标」，而 driver 是开放集——加第三个 driver 时
                  // toggle 会把它和助手轮流翻，那是错的切换语义。
                  _chatTarget.select(
                    _chatTarget.isDriver('amoo')
                        ? ActiveDriverNotifier.kAssistantDriverId
                        : 'amoo',
                  );
                  setState(() {});
                }
              : null,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: amoo
                  ? palette.primary.withValues(alpha: 0.16)
                  : palette.surfaceHigh,
              borderRadius: BorderRadius.circular(AppRadius.pill),
              border: Border.all(
                color: amoo ? palette.primary : palette.stroke,
                width: AppStroke.thin,
              ),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(amoo ? Icons.forum : Icons.assistant,
                    size: 13,
                    color: amoo ? palette.primary : palette.textSecondary),
                const SizedBox(width: 4),
                Text(amoo ? 'amoo' : '助手',
                    style: AppText.label.copyWith(
                        color:
                            amoo ? palette.primary : palette.textSecondary)),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _sendButton(AppPalette palette) {
    // 只订阅 _input：_canSend 里的 _busy 每次改动都发生在 setState 里
    // （_dispatchSend / _sendRemote 的 finally），整屏重建会把它带下来。
    // 原来靠 initState 里那个 `_input.addListener(() => setState(() {}))`
    // 撑住禁用态——那是每敲一个键重建整个聊天屏，代价与收益差太远。
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: _input,
      builder: (ctx, _, _) {
        final ready = _canSend;
        return PressableScale(
          // 对着 amoo 时不复用 _sendMessage：那一条要走「配没配 API」的本机助手
          // 前置检查，而问 amoo 根本不需要 API key——用户的 key 是给本机助手用的。
          // 复用的话，没配 key 的人会被一句"API 未配置"挡住，而他明明能问 amoo。
          onTap: ready
              ? () {
                  if (_chatTarget.isDriver('amoo')) {
                    _askAmooFromMainInput();
                  } else {
                    _sendMessage();
                  }
                }
              : null,
          child: Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: !_busy && ready ? AppGradients.brand : null,
              color: _busy
                  ? palette.error
                  : ready
                      ? null
                      : palette.surfaceHigh,
              boxShadow: !_busy && ready ? AppShadows.glowPrimary : null,
            ),
            child: Icon(
              _busy ? Icons.stop : Icons.send_rounded,
              size: 22,
              color: _busy || ready ? Colors.white : palette.textFaint,
            ),
          ),
        );
      },
    );
  }

  bool get _canSend => _input.text.trim().isNotEmpty && !_busy;

  // ==================== Welcome ====================

  Widget _welcome(AppPalette palette) {
    // ConstrainedBox 兜底：内容矮于视口时居中，高于视口时可完整滚动，
    // 不会像 mainAxisAlignment.center 那样把顶部裁进不可滚动区。
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.page, vertical: AppSpacing.section),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _enterItem(0, _heroLogo()),
              const SizedBox(height: AppSpacing.page),
              _enterItem(1, Text('khy-os 助手',
                  style:
                      AppText.display.copyWith(color: palette.textPrimary))),
              const SizedBox(height: AppSpacing.dense),
              _enterItem(2, Text(
                _mode == AppMode.standalone
                    ? '独立模式 · 直连 API'
                    : '远程模式 · khy-os 后端',
                style:
                    AppText.secondary.copyWith(color: palette.textSecondary),
              )),
              const SizedBox(height: AppSpacing.page),
              _enterItem(3, _exampleChips(palette)),
              const SizedBox(height: AppSpacing.section),
              _enterItem(4, _welcomeGrid(palette)),
              const SizedBox(height: AppSpacing.cardGap),
              // 反代 amoo：空会话时它是唯一的入口，所以放在能力卡片之后。
              // 有会话后同一张卡改到 _msgList 的头部（那里不会随清空消失），
              // 两处不会同时构建——`_msgs.isEmpty ? _welcome : _msgList` 只走一支。
              //
              // amoo 缺席时整张卡不渲染：空会话页用户第一眼看到的就是它，
              // 而一张问不出去的卡比没有卡更糟。设备页那张状态卡照旧显示
              // （它说的是"装没装"，不是"问一句"），两处分工不重叠。
              if (_amooOn)
                _enterItem(
                  5,
                  AmooTaskCard(
                    key: _amooCardKey,
                    target: _chatTarget,
                    onReply: _onAmooReply,
                    onFinished: _onAmooFinished,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// 进场错峰一步：fade 0→1 + 12dp 上移，随元素序号推迟起拍。
  Widget _enterItem(int index, Widget child) {
    final raw = index * 0.18;
    final start = raw > 0.8 ? 0.8 : raw;
    return AnimatedBuilder(
      animation: _enterAnim,
      builder: (context, _) {
        final t = CurvedAnimation(
          parent: _enterAnim,
          curve: Interval(start, 1, curve: AppCurves.standard),
        ).value;
        return Opacity(
          opacity: t,
          child: Transform.translate(
            offset: Offset(0, 12 * (1 - t)),
            child: child,
          ),
        );
      },
    );
  }

  Widget _heroLogo() {
    // 首屏品牌块：墨黑底 + 琥珀主标。
    return const KhyBrandTile(size: 96, radius: AppRadius.xLarge, markScale: 0.66);
  }

  /// 示例问题补上「能做什么」的表达；点击直接填入输入框并聚焦。
  Widget _exampleChips(AppPalette palette) {
    const examples = <String>['帮我打开微信', '截屏看看这页', '帮我算 358×27'];
    return SizedBox(
      width: double.infinity,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < examples.length; i++)
              Padding(
                padding: EdgeInsets.only(
                    right:
                        i == examples.length - 1 ? 0 : AppSpacing.dense),
                child: PressableScale(
                  onTap: () {
                    _input.text = examples[i];
                    _inputFocus.requestFocus();
                  },
                  child: Container(
                    height: 32,
                    padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.inner),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: palette.surfaceHigh,
                      borderRadius: BorderRadius.circular(AppRadius.pill),
                      border: Border.all(
                          color: palette.stroke, width: AppStroke.thin),
                    ),
                    child: Text(examples[i],
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppText.label
                            .copyWith(color: palette.textPrimary)),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// 2×2 等高网格：第四张卡不再被裁出视口。行内 stretch 保证同排卡片等高。
  ///
  /// IntrinsicHeight 不能省：Column 给 Row 的是无界高度，stretch 在没有有界
  /// 高度时直接抛 "BoxConstraints forces an infinite height"，整屏布不出来。
  Widget _welcomeGrid(AppPalette palette) {
    return Column(
      children: [
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: _welcomeCard(Icons.open_in_new, '打开应用',
                    '打开微信、浏览器、设置等', palette.primary, palette),
              ),
              const SizedBox(width: AppSpacing.cardGap),
              Expanded(
                child: _welcomeCard(Icons.screenshot, '截屏分析',
                    '截取屏幕并理解内容', palette.accent, palette),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.cardGap),
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: _welcomeCard(Icons.calculate, '快速计算',
                    '数学表达式计算', palette.hot, palette),
              ),
              const SizedBox(width: AppSpacing.cardGap),
              Expanded(
                child: _welcomeCard(Icons.settings, '配置',
                    '设置 API Key 和模型', palette.cyan, palette,
                    onTap: () => Navigator.push(context,
                        MaterialPageRoute(builder: (_) => const SettingsScreenNew()))),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _welcomeCard(IconData icon, String title, String sub, Color tone,
      AppPalette palette,
      {VoidCallback? onTap}) {
    final card = Container(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.large),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: tone.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(AppRadius.small),
                ),
                child: Icon(icon, size: 22, color: tone),
              ),
              const Spacer(),
              if (onTap != null)
                Icon(Icons.chevron_right, size: 18, color: palette.textFaint),
            ],
          ),
          const SizedBox(height: AppSpacing.inner),
          Text(title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
          const SizedBox(height: 2),
          Text(sub,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: AppText.secondary.copyWith(color: palette.textSecondary)),
        ],
      ),
    );
    if (onTap == null) return card;
    return PressableScale(onTap: onTap, child: card);
  }

  // ==================== 工作空间选择 ====================

  /// 新建对话时挑工作目录。返回挑中的根，或 null（没挑 / 取消）。
  ///
  /// 取消与"没挑"给同一个值是有意的：两者都意味着用 App 既有默认，
  /// 行为一字不变。区分它们只会让调用方多一个没有后果的分支。
  Future<String?> _pickWorkspaceRoot() async {
    final choices = await WorkspaceChoices.load();
    if (!mounted) return null;
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => WorkspacePickerSheet(choices: choices),
    );
  }

  /// 长按会话项：显示这个对话的文件落在哪，可复制，可尝试跳转。
  Future<void> _showConversationLocations(ConversationSummary conv) async {
    final workDir = await FileService.getWorkDir();
    if (!mounted) return;
    final logDir = await AppLogger().logDirectoryPath();
    if (!mounted) return;

    final effective = ConversationWorkspace.effectiveRoot(conv.workspaceRoot);
    final rows = <LocRow>[
      LocRow(
        label: '工作目录',
        value: ConversationWorkspace.describeRoot(conv.workspaceRoot),
        copyable: effective ?? '',
        copyHint: effective == null ? '没挑根，没有可复制的路径' : null,
      ),
      LocRow(
        label: 'App 文件工具根目录',
        value: workDir['path']?.toString() ?? '(读不到)',
        copyable: workDir['path']?.toString() ?? '',
        // isAppPrivate 由原生侧说，不用 Dart 猜：猜错的后果是告诉用户
        // "看得见"而实际在私有目录，比不提示更糟。
        copyHint: workDir['isAppPrivate'] == true
            ? 'list_files / read_file / write_file 实际生效的根（App 私有目录，文件管理器看不到）'
            : 'list_files / read_file / write_file 实际生效的根',
      ),
      LocRow(
        label: '日志目录',
        value: logDir,
        copyable: logDir,
      ),
      const LocRow(
        label: '对话库',
        value: 'FlutterSecureStorage（系统安全存储，无文件路径）',
        copyHint: '加密存储，没有可直接跳转的路径',
      ),
    ];

    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => LocationsSheet(rows: rows),
    );
  }

  Widget _buildDrawer(ColorScheme cs) {
    return Drawer(
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  const KhyBrandTile(size: 28, radius: AppRadius.small),
                  const SizedBox(width: 8),
                  Text('会话列表',
                      style: AppText.cardTitle
                          .copyWith(color: cs.onSurface)),
                ],
              ),
            ),
            const Divider(height: 1),
            ListTile(
              leading:
                  Icon(Icons.add_comment, color: cs.primary, size: 22),
              title: const Text('新对话'),
              onTap: () async {
                Navigator.pop(context);
                // 先清状态再挑目录：取消也要得到一个干净的新对话，
                // 而不是把上一个对话的工作目录带过来。
                setState(() {
                  _rows.clear();
                  _rows.clearToolCards();
                  _structuredTurns.clear();
                  _envelopeBuffer.reset();
                  _currentConvId =
                      'conv_${DateTime.now().millisecondsSinceEpoch}';
                  _currentTitle = '新对话';
                  _currentWorkspaceRoot = null;
                  _currentSyncOverride = null;
                  _currentSyncState = null;
                });
                final picked = await _pickWorkspaceRoot();
                if (!mounted) return;
                setState(() => _currentWorkspaceRoot = picked);
                // 挑了才同步。取消 = picked 为 null = 恢复 App 私有目录，
                // 这正是新对话该有的状态。
                await _applyWorkspaceRoot(picked);
              },
            ),
            const Divider(height: 1),
            Expanded(
              child: _conversations.isEmpty
                  ? Center(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(Icons.chat_bubble_outline,
                              size: 40, color: cs.outlineVariant),
                          const SizedBox(height: 8),
                          Text('暂无历史会话',
                              style: AppText.secondary.copyWith(
                                  color: AppPalette.of(context).textFaint)),
                        ],
                      ),
                    )
                  : ListView.builder(
                      itemCount: _conversations.length,
                      itemBuilder: (context, index) {
                        final conv = _conversations[index];
                        final isActive = conv.id == _currentConvId;
                        final palette = AppPalette.of(context);
                        final syncStatus = _syncStatusOf(
                          override: conv.syncToDesktop,
                          lastState: conv.syncState,
                        );
                        return ListTile(
                          leading: Icon(
                            isActive
                                ? Icons.chat_bubble
                                : Icons.chat_bubble_outline,
                            size: 18,
                            color: isActive ? cs.primary : cs.onSurfaceVariant,
                          ),
                          title: Text(
                            conv.title.isEmpty ? '新对话' : conv.title,
                            style: AppText.body.copyWith(
                              fontWeight: isActive ? FontWeight.w700 : null,
                              color: isActive ? cs.primary : cs.onSurface,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          // 副标题带同步词：列表是用户唯一能一眼扫完全部对话的地方，
                          // 状态只放在打开后的页面上，关掉的对话就再也看不见了。
                          subtitle: Text(
                            '${conv.messageCount} 条消息 · ${ConversationSync.label(syncStatus)}',
                            style: AppText.secondary
                                .copyWith(color: palette.textSecondary),
                          ),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                _syncIcon(syncStatus),
                                size: 14,
                                color: _syncColor(syncStatus, palette),
                              ),
                              IconButton(
                                icon: Icon(Icons.delete,
                                    size: 16, color: cs.onSurfaceVariant),
                                onPressed: () => _deleteConversation(conv.id),
                              ),
                            ],
                          ),
                          onTap: () => _loadConversation(conv.id),
                          // 长按看这个对话的文件落在哪。短按仍然是加载——
                          // 两个手势分开，不会因为加了长按就改变最常用的那个。
                          onLongPress: () =>
                              _showConversationLocations(conv),
                        );
                      },
                    ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(
                  horizontal: 16, vertical: 8),
              child: Text(
                '${_conversations.length} 个会话',
                style: AppText.secondary.copyWith(
                    color: AppPalette.of(context).textSecondary),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ==================== Helpers ====================

  void _addSystemMsg(String text) {
    setState(() {
      _msgs.add(ChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        conversationId: _currentConvId,
        role: MessageRole.assistant,
        content: text,
        timestamp: DateTime.now(),
      ));
    });
    _scrollToBottom();
  }

  void _setContent(String id, String c) {
    _rows.setContent(id, c);
    _scrollToBottom();
  }

  void _appendContent(String id, String chunk) {
    _rows.appendContent(id, chunk);
    _scrollToBottom();
  }

  void _setError(String id, String e) {
    _logger.e(LogCategory.api, '对话出错', details: {'message': e});
    // 正文必须走 [_rows.setContent]：那条通路同时改 _msgs 和行 notifier。
    // 直接在 setState 里改 _msgs 的话，ListView 重建时会把**旧的** notifier 传给
    // 那一行，屏幕上留着上一段正文——正是这个文件里最容易犯的错。
    _rows.setContent(id, '错误：$e');
    if (mounted) setState(() => _busy = false);
  }

  void _showError(String title, String msg) {
    _logger.w(LogCategory.ui, title, details: {'message': msg});
    _addSystemMsg('$title\n$msg');
  }

  /// 自动贴底的最小间隔。
  ///
  /// 原来每个 chunk 都调一次 animateTo(200ms)：上一次动画还没走到底就被取消重来，
  /// 于是流式期间滚动**永远**落后于内容——这就是流式滚动抖动/发涩的直接来源。
  /// 改成「至多每 200ms 起一次 + 尾部补一次」：动画能走完，chunk 停了之后仍然
  /// 保证落在最后一格。贴底本身的行为不变（仍然不判断用户是否在上滚，那是个
  /// 独立的既有问题，本轮不动）。
  static const _autoScrollInterval = Duration(milliseconds: 200);
  DateTime _lastAutoScroll = DateTime.fromMillisecondsSinceEpoch(0);
  Timer? _autoScrollTimer;

  void _scrollToBottom() {
    final since = DateTime.now().difference(_lastAutoScroll);
    if (since >= _autoScrollInterval) {
      _lastAutoScroll = DateTime.now();
      _runScrollToBottom();
      return;
    }
    // 尾部补一次：chunk 流停了之后必须落到最后一格，不能停在半路。
    _autoScrollTimer ??=
        Timer(_autoScrollInterval - since, () {
      _autoScrollTimer = null;
      _lastAutoScroll = DateTime.now();
      _runScrollToBottom();
    });
  }

  void _runScrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent + 200,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _testConn() async {
    if (_cfg == null) return;
    // Debounce: 10s 内不重复测试
    if (DateTime.now().difference(_lastTestTime) < _testDebounce) {
      _logger.i(LogCategory.network, '测试冷却中，跳过');
      return;
    }
    _lastTestTime = DateTime.now();
    setState(() => _connStatus = 'testing');
    try {
      final d = Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10)));
      final resp = await d.get('${_cfg!.baseUrl}/models',
          options: Options(
              headers: await ZenGate.requestHeaders(
                baseUrl: _cfg!.baseUrl,
                apiKey: _cfg!.effectiveApiKey,
              ),
              // 收下所有状态码自己判：validateStatus 放行 4xx 再一律当成功，
              // 会让 403 显示「已连接」——那是假成功，不是乐观。
              validateStatus: (s) => s != null));
      if (isSuccessful(resp.statusCode)) {
        setState(() => _connStatus = 'connected');
      } else {
        // 状态码之外的病因（指纹/地区/配额）只有正文认得出来。
        final verdict = classify(resp.statusCode, bodyFromData(resp.data));
        setState(() => _connStatus = null);
        _addSystemMsg(verdict.message);
      }
    } on DioException catch (e) {
      if (e.type == DioExceptionType.connectionError &&
          e.message?.contains('Failed host lookup') == true) {
        setState(() => _connStatus = 'dns_error');
      } else {
        setState(() => _connStatus = 'network_error');
      }
    }
  }

  void _handleDioErr(DioException e, String id) {
    final url = e.requestOptions.path;
    final status = e.response?.statusCode;
    final body = bodyFromData(e.response?.data);
    final verdict = classify(status, body);

    // 免费档的配额/指纹/地区三类，与「限流 429」看起来都是 4xx，但重试无用：
    // 配额按出口 IP 计，指纹和地区封锁换 key 也不会好。所以必须在 429 退避
    // 分支之前分开——否则手机上会一直显示"已自动切换并重试"。
    if (verdict.kind == ZenErrorKind.freeUsageLimit ||
        verdict.kind == ZenErrorKind.freeTier ||
        verdict.kind == ZenErrorKind.region) {
      _consecutive429 = 0;
      _logger.recordError(
        code: ErrorCode.forHttpStatus(status ?? 0),
        message: verdict.message,
        category: LogCategory.api,
        context: {
          'url': url,
          'status': status?.toString() ?? '',
          'kind': verdict.kind.name,
        },
        exception: e,
      );
      _setError(id, verdict.message);
      return;
    }

    // 上游明文说这个模型下线/不支持：记进账本，下次列表里就不再出现。
    // 门在 recordFromUpstreamError 里（只认 401/404/410 + 明文），这里不判。
    if (verdict.kind == ZenErrorKind.modelUnsupported && _cfg != null) {
      unawaited(ZenModelCatalog.recordFromUpstreamError(
        status: status,
        body: body,
        modelId: _cfg!.model,
      ));
    }

    // 429 限流：指数退避 + 自动切换备用 provider
    if (status == 429) {
      _consecutive429++;
      final backoffSec = _consecutive429 * 5;
      _logger.recordError(
        code: ErrorCode.rateLimit,
        message: '限流 429：第 $_consecutive429 次，退避 ${backoffSec}s',
        category: LogCategory.api,
        context: {'url': url, 'attempt': _consecutive429},
        exception: e,
      );
      if (_consecutive429 >= 2) {
        _autoFailover();
        _setError(id, '当前 provider 限流，已自动切换到备用。请重试。');
      } else {
        _setError(id, '请求过频 (429)：等待 ${backoffSec}s 后重试');
      }
      return;
    }

    // 非 429 错误重置计数器
    _consecutive429 = 0;

    // DNS 失败
    if (e.type == DioExceptionType.connectionError &&
        e.message?.contains('Failed host lookup') == true) {
      _logger.recordError(
        code: ErrorCode.dns,
        message: 'DNS 解析失败：无法连接 $url',
        category: LogCategory.network,
        context: {'url': url, 'type': 'connection_error'},
        exception: e,
      );
      setState(() => _connStatus = 'dns_error');
      _setError(id, 'DNS 解析失败：无法连接。检查网络后重试');
      return;
    }

    String errorCode;
    String userMsg;
    switch (e.type) {
      case DioExceptionType.connectionError:
        errorCode = ErrorCode.connection;
        userMsg = '网络连接失败：请检查 Wi-Fi 或移动数据';
        break;
      case DioExceptionType.connectionTimeout:
        errorCode = ErrorCode.timeout;
        userMsg = '连接超时：服务器响应慢，请稍后重试';
        break;
      case DioExceptionType.receiveTimeout:
        errorCode = ErrorCode.timeout;
        userMsg = '响应超时：服务器处理时间过长';
        break;
      case DioExceptionType.badResponse:
        final code = status ?? 0;
        errorCode = ErrorCode.forHttpStatus(code);
        // 认得出的病按识别出的原因说；认不出才退回状态码通用文案。
        userMsg = verdict.kind == ZenErrorKind.unknown
            ? 'API 返回 $code：${_describeHttpStatus(code)}'
            : verdict.message;
        if (code == 404) {
          userMsg = '404：模型 "$_cfg?.model" 在 $url 不存在。请检查模型名称或切换 provider';
        }
        break;
      case DioExceptionType.unknown:
        errorCode = ErrorCode.unknown;
        final msg = e.message ?? '';
        if (msg.contains('connection abort') ||
            msg.contains('Software caused')) {
          userMsg = '连接中断：服务器断开，正在自动重试...';
        } else {
          userMsg = '请求异常：${msg.isNotEmpty ? msg : "未知错误，请重试"}';
        }
        break;
      default:
        errorCode = ErrorCode.unknown;
        userMsg = '请求失败：请重试';
    }

    _logger.recordError(
      code: errorCode,
      message: userMsg,
      category: LogCategory.network,
      context: {
        'url': url,
        'type': e.type.name,
        'status': status?.toString() ?? '',
        'mode': _mode.name,
      },
      exception: e,
    );
    _setError(id, userMsg);
  }

  String _describeHttpStatus(int code) {
    switch (code) {
      case 400: return '请求参数错误，请检查模型名称';
      case 401: return 'API Key 无效或过期，请在设置中更新';
      case 403: return '权限不足：该 API Key 无权访问此模型';
      case 404: return '模型不存在：请检查模型名称拼写';
      case 429: return '请求过频：请等待片刻或降低请求频率';
      case 500: return '服务器内部错误：请稍后重试';
      case 502: return '网关错误：API 服务暂不可用';
      case 503: return '服务不可用：请稍后重试';
      case 504: return '网关超时：服务器响应过慢';
      default: return '未知错误';
    }
  }

  /// 自动切换到下一个未尝试的可用 provider
  void _autoFailover() {
    final currentUrl = _cfg?.baseUrl ?? '';
    
    // 把当前 provider 加入已尝试列表
    if (currentUrl.isNotEmpty && !_triedProviders.contains(currentUrl)) {
      _triedProviders.add(currentUrl);
    }
    
    _logger.i(LogCategory.api, '触发自动切换 provider',
        details: {'tried': _triedProviders, 'current': currentUrl});
    
    // 找一个未尝试过的、能发请求的 provider。canSend 而不是 hasKey：免费档
    // 的 bearer 是 public，hasKey 对它恒 false——原判据让候选集永远是空的，
    // 于是每次都落到「所有可用 provider 均不可用」。
    final next = BuiltInKeys.providers.values.firstWhere(
      (p) => p.canSend && 
             p.baseUrl != currentUrl && 
             !_triedProviders.contains(p.baseUrl),
      orElse: () => const BuiltInProvider(
          baseUrl: '', apiKey: '', defaultModel: '', models: []),
    );
    
    if (next.baseUrl.isEmpty) {
      // 所有 provider 都试过了，重置并提示用户
      _triedProviders.clear();
      _logger.w(LogCategory.api, '所有 provider 均已尝试，无法切换');
      _addSystemMsg('所有可用 provider 均不可用，请检查网络或稍后再试。');
      return;
    }
    
    // 切换到新 provider
    setState(() {
      _cfg = _cfg!.copyWith(baseUrl: next.baseUrl, model: next.defaultModel);
      _connStatus = null;
    });
    AppConfig.save(baseUrl: next.baseUrl, model: next.defaultModel);
    _logger.i(LogCategory.api, '已切换到: ${next.baseUrl}',
        details: {'from': currentUrl, 'to': next.baseUrl, 'model': next.defaultModel});
    _addSystemMsg('已自动切换到备用 provider（${next.baseUrl}），请重试。');
  }

  Color _statusColor(AppPalette palette) {
    switch (_connStatus) {
      case 'connected':
        return palette.success;
      case 'testing':
        return palette.warning;
      case 'dns_error':
      case 'network_error':
        return palette.error;
      default:
        return palette.textFaint;
    }
  }

  String _statusText() {
    switch (_connStatus) {
      case 'connected':
        return '已连接';
      case 'testing':
        return '测试中';
      case 'dns_error':
        return 'DNS 错误';
      case 'network_error':
        return '网络错误';
      default:
        return '未连接';
    }
  }

  String _currentModelLabel() {
    if (_mode == AppMode.remote) {
      return '远程模式 · khy-os 后端';
    }
    if (_cfg == null) return '未配置';
    final provider = BuiltInKeys.matchBaseUrl(_cfg!.baseUrl);
    final model = _cfg!.model.isEmpty ? '默认' : _cfg!.model;
    if (provider != null) {
      return '$provider · $model';
    }
    return '${_cfg!.baseUrl} · $model';
  }

  // ── Approval for dangerous commands ─────────────────────────────

  /// 「高危但合法」的命令形态：这些**要问用户**才执行。
  ///
  /// 为什么这张表是子串匹配，而「危险模式」判定不是：这张表答的是
  /// 「这条命令该不该先问一声」，表里的形态（mkfs、dd、shutdown…）本来就是
  /// 固定写法；而「危险模式」判定要认得出 `rm -r -f /` 这种换个写法就变样的
  /// 命令，那必须结构化解析——见 [ShellCommandGuard]。
  static const _dangerousPatterns = [
    'rm -rf', 'mkfs', 'dd if=', 'format', 'wipe',
    'reboot', 'shutdown', 'halt',
    'chmod 777', 'chown root',
    'systemctl', 'insmod', 'rmmod',
  ];

  /// 这条命令要不要先问用户。
  ///
  /// 三层，从硬到软：
  ///   1. 危险模式（`rm -rf /`、`chmod 777 /system`…）：**直接拒绝**，不弹框。
  ///      弹了也是白问——执行层的护栏会拒。让用户点完确认再看到一句「已拒绝」，
  ///      是自己给自己找别扭。
  ///   2. 递归删除（任意目标，如 `/storage/emulated/0/Download`）：高危但合法，
  ///      问用户。判据用结构化：`rm -r -f`、`rm --recursive` 与 `rm -rf` 是
  ///      同一个意思，却不含 `rm -rf` 这个字样。
  ///   3. 其余按 [_dangerousPatterns] 的子串清单。
  bool _isDangerousCommand(Map<String, dynamic> args) {
    final cmd = _commandOf(args);
    if (cmd.isEmpty) return false;

    if (ShellCommandGuard.isDangerous(cmd)) return false;

    for (final parsed in CommandSafety.split(cmd)) {
      if (parsed.program == 'rm' && parsed.hasRecursive) return true;
    }

    final lower = cmd.toLowerCase();
    for (final pattern in _dangerousPatterns) {
      if (lower.contains(pattern)) return true;
    }
    return false;
  }

  /// 从工具参数里把命令串取出来。
  ///
  /// 三种形态都要认：`{cmd: 'shell', command: '…'}`（android 工具）、
  /// `{name: 'exec_shell', command: '…'}` 与 `{name: 'exec_shell_elevated',
  /// args: {command: '…'}}`（内置工具）。
  String _commandOf(Map<String, dynamic> args) {
    final name = args['name']?.toString() ?? '';
    if (args['cmd'] != 'shell' &&
        name != 'exec_shell' &&
        name != 'exec_shell_elevated') {
      return '';
    }
    return args['command']?.toString() ??
        (args['args']?['command']?.toString()) ?? '';
  }

  /// 这个工具这次要不要问用户。
  ///
  /// 以前这里是硬编码的 `toolName == 'exec_shell' || toolName == 'android'`，
  /// 于是两件事同时坏掉：工具自己声明的 `PermissionLevel.ask` 从来没被看过
  /// （`vision_tap` 声明了 ask，实际一次都没问过），而模式层根本不存在。
  ///
  /// 现在顺序是：模式 → 声明 → 危险命令清单。
  ///   · bypass 一律不问，这是用户显式选的；
  ///   · 工具声明了 ask 就问——声明是工具作者对这个工具说的话，本该是默认值；
  ///   · 剩下的按危险命令清单走，那是原来就有的行为，不改。
  ///
  /// 注意这里问的都是 **khy-os 自己的提示**。安卓系统那种同意框（例如
  /// MediaProjection）不归这个模式管——那不是我们的闸门，而且那条路已经改成
  /// 走无障碍服务，弹窗压根不再出现。
  /// driver 路径的授权回调。带门引擎只对 ask 工具调用本回调（危险 shell 已被
  /// gateDangerousTools 标成 ask）。判据与手动循环 _needsApproval 同序——模式→
  /// 危险命令过滤——但**不查基础引擎的 permission**：driver 引擎单独注册，
  /// 基础引擎不知道的 ask 工具（如将来注册的 vision_tap）也必须问，否则会漏。
  Future<bool> _confirmDriverTool({
    required String toolName,
    required Map<String, dynamic> params,
    String? reasoning,
  }) async {
    if (_permissionMode == PermissionMode.bypass) return true;
    if (_permissionMode == PermissionMode.auto &&
        _approvedThisSession.contains(toolName)) {
      return true;
    }
    if ((toolName == 'exec_shell' ||
            toolName == 'exec_shell_elevated' ||
            toolName == 'android') &&
        !_isDangerousCommand(params)) {
      return true;
    }
    final ok =
        await _showApprovalDialog(toolName, params, _getToolLabel(toolName, params));
    if (ok) _approvedThisSession.add(toolName);
    return ok;
  }

  Future<bool> _needsApproval(String toolName, Map<String, dynamic> args) async {
    if (_permissionMode == PermissionMode.bypass) return false;
    if (_toolEngine.getPermission(toolName) == PermissionLevel.ask) {
      // auto 档：同一个工具本次会话只问一次，记住了就不再问。
      if (_permissionMode == PermissionMode.auto &&
          _approvedThisSession.contains(toolName)) {
        return false;
      }
      return true;
    }
    // 为什么把 `exec_shell_elevated` 也算进来：它走 提权代理 提权通道，
    // 爆炸半径比普通 shell 大（能碰的东西更多），可它从来没被问过——
    // 危险命令清单只认 `exec_shell` 和 `android`，于是**最危险的那个工具
    // 恰好是唯一不问用户的那个**。
    if (toolName == 'exec_shell' ||
        toolName == 'exec_shell_elevated' ||
        toolName == 'android') {
      return _isDangerousCommand(args);
    }
    return false;
  }

  Future<bool> _showApprovalDialog(
      String toolName, Map<String, dynamic> args, String label) async {
    if (!mounted) return false;
    final cmd = args['command']?.toString() ??
        (args['args']?['command']?.toString()) ?? label;
    final cs = Theme.of(context).colorScheme;
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Row(
          children: [
            Icon(Icons.warning_amber_rounded, color: cs.error, size: 24),
            const SizedBox(width: 8),
            const Text('危险命令确认'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('即将执行以下命令：', style: AppText.body.copyWith(color: cs.onSurface)),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: cs.error.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(AppRadius.small),
                // 状态描边取状态色 35%（DESIGN-UI §4），不再用淡灰描边。
                border: Border.all(color: cs.error.withValues(alpha: 0.35)),
              ),
              child: Text(
                cmd.length > 200 ? '${cmd.substring(0, 200)}...' : cmd,
                style: AppText.cardTitleNarrow.copyWith(fontFamily: 'monospace'),
              ),
            ),
            const SizedBox(height: 8),
            Text('此操作可能影响系统，请确认你了解风险。',
                style: AppText.secondary.copyWith(color: cs.onSurfaceVariant)),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('取消', style: TextStyle(color: cs.onSurfaceVariant)),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: ElevatedButton.styleFrom(backgroundColor: cs.error),
            child: const Text('批准执行'),
          ),
        ],
      ),
    ).then((v) => v ?? false);
  }

  void _feedBack(List<Map<String, dynamic>> messages, String tool, ToolResult result, bool useTextProtocol) {
    // 用户拒绝也会走同一条收口：那句「用户拒绝了该操作」同样要让模型知道
    // 事情没发生，否则它会当成失败重试，或者当成成功继续往下说。
    messages.add(ToolVerdictFactory.toolMessage(
      tool: tool,
      result: result,
      useTextProtocol: useTextProtocol,
      callId: '${DateTime.now().millisecondsSinceEpoch}',
    ));
  }

  String _getToolLabel(String toolName, Map<String, dynamic> args) {
    switch (toolName) {
      case 'open_app':
        return '打开应用: ${args['query'] ?? ''}';
      case 'open_url':
        return '打开网址: ${args['url'] ?? ''}';
      case 'search_apps':
        return '搜索应用: ${args['query'] ?? ''}';
      case 'read_clipboard':
        return '读取剪贴板';
      case 'write_clipboard':
        return '写入剪贴板';
      case 'calculator':
        return '计算: ${args['expression'] ?? ''}';
      case 'device_info':
        return '获取设备信息';
      case 'execute_skill':
        return '执行技能: ${args['skill_name'] ?? ''}';
      case 'a11y_tap':
        return '点击: (${args['x'] ?? 0}, ${args['y'] ?? 0})';
      case 'a11y_find_and_click':
        return '查找并点击: ${args['query'] ?? ''}';
      case 'a11y_dump_ui':
        return '获取屏幕 UI 树';
      case 'a11y_list_clickable':
        return '列出可点击元素';
      case 'a11y_type_text':
        return '输入文字: ${args['text'] ?? ''}';
      case 'a11y_global_action':
        return '全局操作: ${args['action'] ?? ''}';
      case 'capture_screen':
        return '截屏';
      case 'analyze_screen':
        return '视觉分析: ${args['prompt'] ?? ''}';
      case 'exec_shell':
        return '执行命令: ${args['command'] ?? ''}';
      default:
        return '执行: $toolName';
    }
  }

  /// Compress long conversations: keep last 6 messages full, summarize older ones
  List<Map<String, dynamic>> _compactHistory(List<Map<String, dynamic>> history) {
    if (history.length <= 8) return history;
    // Keep last 6 messages, summarize the rest
    final keep = history.sublist(history.length - 6);
    final older = history.sublist(0, history.length - 6);
    final summary = _summarizeOld(older);
    return [
      {'role': 'system', 'content': '[历史摘要] $summary'},
      ...keep,
    ];
  }

  String _summarizeOld(List<Map<String, dynamic>> msgs) =>
      summarizeHistoryTail(msgs);

  String _buildSkillsSummary() {
    final buf = StringBuffer();
    buf.writeln('## 可用工具');
    buf.writeln('');
    buf.writeln('### 应用操作');
    buf.writeln('- open_app: 打开任意应用（中文名/包名/URL 均可）');
    buf.writeln('- search_apps: 搜索已安装应用');
    buf.writeln('');
    buf.writeln('### 文件系统（工作目录 = 应用存储）');
    buf.writeln('- list_files: 列出目录内容（path="" 为根目录）');
    buf.writeln('- read_file: 读取文件内容');
    buf.writeln('- write_file: 创建/覆盖文件');
    buf.writeln('- edit_file: 精确替换文件中某段文字（oldText → newText）');
    buf.writeln('- find_files: 按 glob 模式查找文件（如 *.dart, **/*.json）');
    buf.writeln('- grep_files: 正则搜索文件内容（返回 file:line: 匹配行）');
    buf.writeln('- create_dir: 创建文件夹');
    buf.writeln('');
    buf.writeln('### 屏幕/输入');
    buf.writeln('- capture_screen: 截屏（返回 base64 图片）');
    buf.writeln('- a11y_dump_ui: 获取当前屏幕 UI 树');
    buf.writeln('- a11y_tap: 点击坐标');
    buf.writeln('- a11y_swipe: 滑动（起点别靠屏幕底部，那一段是系统返回手势）');
    buf.writeln('- a11y_type_text: 向焦点输入框输入文字');
    buf.writeln('- a11y_find_and_click: 按 text/id/class 查找并点击');
    buf.writeln('- a11y_global_action: 系统级动作（返回/主页/最近任务/通知栏）');
    buf.writeln('- a11y_list_clickable: 列出当前屏幕上所有可点击元素');
    buf.writeln('');
    buf.writeln('### 视觉定位（文字模型读不了屏幕时用）');
    buf.writeln('- vision_locate: 截图并让视觉模型找出某个元素，返回 0-1000 归一化坐标');
    buf.writeln('- vision_tap: 截图 + 定位 + 点击，一步完成');
    buf.writeln('  适用于无障碍树里看不到目标的情况（如微信等第三方 App 的界面）');
    buf.writeln('');
    buf.writeln('### 系统/网络');
    buf.writeln('- device_info: 设备信息');
    buf.writeln('- exec_shell: 执行 shell 命令（getprop/dumpsys/am/pm 等）');
    buf.writeln('- web_search: 联网搜索（DuckDuckGo）');
    buf.writeln('- web_fetch: 抓取网页内容');
    buf.writeln('');
    buf.writeln('### 其他');
    buf.writeln('- read_clipboard / write_clipboard: 剪贴板');
    buf.writeln('- calculator: 数学计算');
    buf.writeln('');
    buf.writeln('## 规则');
    buf.writeln('- 用户问"手机里有什么文件" → 用 list_files 列出，再 read_file 查看');
    buf.writeln('- 用户问"某个文件夹有什么" → 用 list_files(path=文件夹名)');
    buf.writeln('- 查找文件 → 用 find_files(pattern="**/*.扩展名")');
    buf.writeln('- 搜索代码/内容 → 用 grep_files(regex="关键词")');
    buf.writeln('- 打开应用 → 只用 open_app，不要试 execute_skill');
    buf.writeln('- 工具执行失败 → 直接告知用户结果，不要反复重试');
    buf.writeln('');
    buf.writeln('## 禁止捏造（严格遵守）');
    buf.writeln('- 只使用工具返回的实际数据，绝不编造文件名、应用列表、文件内容');
    buf.writeln('- 如果 list_files 返回空，就说"目录为空"，不要猜测里面有什么');
    buf.writeln('- 如果 read_file 返回了内容，就引用实际内容，不要改写或总结成别的');
    buf.writeln('- 如果工具报错，原样展示错误信息，不要假装成功');
    buf.writeln('- 无法确定的信息 → 明确说"我无法确认"，不要编造');
    buf.writeln('');
    buf.writeln(ToolProtocol.textProtocolInstructions);
    return buf.toString();
  }
}

