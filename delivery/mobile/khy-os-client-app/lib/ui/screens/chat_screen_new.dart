// khy-canary: Khy-20261101-109-637JY477
import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart';
import '../../core/config/app_config.dart';
import '../../core/config/permission_mode.dart';
import '../../core/gateway/khyos_api.dart';
import '../../core/network/dns_resolver.dart';
import '../../core/network/network_autofix.dart';
import '../../core/network/smart_dns.dart';
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
import '../../core/tools/write_diff.dart';
import '../../core/tools/tool_protocol.dart';
import '../../core/tools/skills.dart';
import '../../core/services/conversation_db.dart';
import '../../core/config/project_profile.g.dart';
import '../../core/workspace/conversation_workspace.dart';
import '../../core/workspace/workspace_choices.dart';
import '../widgets/workspace_pickers.dart';
import '../../core/services/device_control.dart';
import '../../core/services/file_service.dart';
import '../../core/config/built_in_keys.dart';
import '../../core/agent/execution_log.dart';
import '../../ui/theme/app_colors.dart';
import '../../ui/theme/design_tokens.dart';
import '../../ui/widgets/aurora.dart';
import '../../ui/widgets/tool_card.dart';
import '../../ui/widgets/chat_message_row.dart';
import '../../ui/widgets/thinking_block.dart';
import '../../ui/widgets/amoo_task_card.dart';
import '../../ui/widgets/amoo_composer.dart';
import '../../ui/widgets/model_picker_sheet.dart';
import '../../core/config/model_registry.dart';
import 'settings_screen_new.dart';

/// App mode: standalone (direct API) or remote (via khy-os backend)
enum AppMode { remote, standalone }

/// Redesigned chat screen - clean top bar, tool cards, quick actions
class ChatScreenNew extends ConsumerStatefulWidget {
  final KhyOsApi? api;
  const ChatScreenNew({super.key, this.api});

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
  AppConfigData? _cfg;

  /// 底部输入框发给谁。见 [ChatTargetNotifier]：为的是消掉"两个输入框"。
  final ChatTargetNotifier _chatTarget = ChatTargetNotifier();

  /// amoo 这台设备上到底在不在。false = 反代那一整套一律不挂载。
  ///
  /// 为什么需要一个字段而不是每次 build 去问：探测要走 MethodChannel
  /// （异步、且要碰原生壳），build 里不能做；而四个入口（消息列表头卡、
  /// 欢迎页卡、快捷栏 chip、目标切换）必须按**同一个**判据决定显不显——
  /// 各问各的必然漂移，漂移的形态是"输入框多一个永失败的目标"。
  ///
  /// 默认 false 而不是 true：没探测完之前不挂，比挂一张死卡再撤掉好。
  /// 旧原生壳上 amooStatus 会抛 MissingPluginException，[AmooService.status]
  /// 把它转成 unknown，这里同样按 false 处理——那种壳下卡片同样是死卡。
  bool _amooAvailable = false;

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
  final _autoFix = NetworkAutoFix();
  final _smartDns = SmartDns();
  late final ToolEngine _toolEngine;

  // Session
  String _currentConvId = 'default';
  String _currentTitle = '新对话';

  /// 当前对话挑的工作空间根。null = 没挑 = 用 App 既有默认。
  ///
  /// 跟着会话走而不是全局：一个对话在写游戏、另一个在整理下载目录时，
  /// 共用一个根会让两者的成果和临时文件混在一起，于是谁都不敢删。
  String? _currentWorkspaceRoot;
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
    _loadConversations();
    // 系统分享／「选中文字后」送进来的文字。放在最后：它可能新建一个对话，
    // 而那不该抢在 _loadConversations 之前把列表状态搅乱。
    _drainSharedText();
    // onResume 也要排一次：用户从别的 App 分享完回到这里时，文字是那次
    // onNewIntent 送到的，而 initState 早跑完了。没有这一条，第二次起的分享
    // 会静默丢掉——症状是"我分享了但什么都没发生"。
    WidgetsBinding.instance.addObserver(this);
    _probeAmoo();
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
  Future<void> _probeAmoo() async {
    final st = await AmooService.status();
    if (!mounted) return;
    setState(() {
      _amooAvailable = st.installed;
      if (!_amooAvailable && _chatTarget.isAmoo) {
        _chatTarget.value = ChatTarget.assistant;
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
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _drainSharedText();
      // 复探一次：本页活着没重建（底部导航让四个页同时活着），而 amoo 的
      // 安装态是这期间少数真的会变的东西之一——用户可能刚在设置里装好，
      // 也可能刚卸掉。不复探的话，装好的人看不到入口，卸掉的人看到死卡。
      _probeAmoo();
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
      _currentConvId = 'conv_${DateTime.now().millisecondsSinceEpoch}';
      _currentTitle = '分享的内容';
      _currentWorkspaceRoot = null;
      _input.text = text;
    });
  }

  Future<void> _loadConfig() async {
    final c = await AppConfig.loadEffective();
    if (mounted) {
      setState(() {
        _cfg = c;
        _permissionMode = PermissionMode.fromWire(c.permissionMode);
      });
    }
  }

  Future<void> _loadConversations() async {
    final list = await ConversationDB.listAll();
    if (mounted) setState(() => _conversations = list);
  }

  // ==================== Send ====================

  void _sendMessage() {
    final text = _input.text.trim();
    if (text.isEmpty || _busy) return;

    // 对着 amoo 时，主输入框就是反代卡的输入框（卡把自己的收起来了）。
    if (_chatTarget.isAmoo) {
      _askAmooFromMainInput();
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
  void _askAmooFromMainInput() {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    _input.clear();
    setState(() {});
    _amooCardKey.currentState?.sendWith(text);
  }

  void _dispatchSend(String text) {
    // 远程模式：检查后端连接
    if (_mode == AppMode.remote) {
      if (_api == null || !_api!.isConnected) {
        _showError('未连接到 khy-os 后端', '请先连接远程后端，或切换到独立模式');
        return;
      }
    } else {
      // 独立模式：检查 API 配置
      if (_cfg == null || !_cfg!.isConfigured) {
        _showError('API 未配置', '请先到设置页选择提供商和模型');
        return;
      }
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

        final resp = await dio.post(
          '${_cfg!.baseUrl}/chat/completions',
          data: requestData,
          options: Options(
            headers: {
              'Authorization': 'Bearer ${_cfg!.effectiveApiKey}',
              'Content-Type': 'application/json',
            },
          ),
        );

        final data = resp.data as Map<String, dynamic>;
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
      if (mounted) setState(() {
        _busy = false;
        _currentAction = '';
      });
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
      
      await for (final ev in _api!.streamChat(question: text, history: h)) {
        final t = ev['type'];
        if (t == 'chunk') {
          _appendContent(id, (ev['content'] ?? '').toString());
        } else if (t == 'thinking_content') {
          // 后端早就把网关的 thinking chunk 转成这个事件下发（routes/ai.js 的
          // thinking 分支），Dart 侧原来只认 chunk/done/error，它落在无形。
          _rows.appendReasoning(id, (ev['text'] ?? '').toString());
        } else if (t == 'done') {
          final c = ev['content'];
          if (c != null) _setContent(id, c.toString());
        } else if (t == 'error') {
          _setError(id, (ev['message'] ?? '远程请求失败').toString());
          return;
        }
      }
      await _saveConversation();
    } catch (e) {
      _logger.e(LogCategory.api, '远程请求失败', error: e);
      _setError(id, 'khy-os 连接失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ==================== Session ====================

  void _updateTitleFromFirstMessage(String text) {
    if (_currentTitle == '新对话' && text.isNotEmpty) {
      setState(() => _currentTitle = text.length > 20 ? text.substring(0, 20) + '...' : text);
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
    );
    await ConversationDB.save(conv);
    await _loadConversations();
  }

  void _newConversation() {
    setState(() {
      _rows.clear();
      _rows.clearToolCards();
      _currentConvId = 'conv_${DateTime.now().millisecondsSinceEpoch}';
      _currentTitle = '新对话';
      _currentWorkspaceRoot = null;
    });
    if (mounted) Navigator.pop(context);
  }

  Future<void> _loadConversation(String id) async {
    final conv = await ConversationDB.load(id);
    if (conv == null) return;
    setState(() {
      _rows.clear();
      _rows.clearToolCards();
      _currentConvId = conv.id;
      _currentTitle = conv.title;
      _currentWorkspaceRoot = conv.workspaceRoot;
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
              border: Border.all(
                  color: palette.glassStroke, width: AppStroke.thin),
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
                    onPressed: () => Navigator.push(context,
                        MaterialPageRoute(builder: (_) => const SettingsScreenNew())),
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
          ? () {
              setState(() => _mode = mode);
              _logger.i(LogCategory.ui, '切换到${mode.name}模式');
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
          (_amooAvailable ? 1 : 0),
      itemBuilder: (_, i) {
        if (_amooAvailable && i == 0) {
          return AmooTaskCard(
            key: _amooCardKey,
            target: _chatTarget,
          );
        }
        // 索引基准必须和 itemCount 那个条件同步改。漏改的后果不是"少一条"，
        // 是 RangeError：缺席时 i==0 直接取 _msgs[-1]，而那是每次构建都走的
        // 路径——整块 AI 页布不出来，正是本轮要修的那块屏。
        final j = i - (_amooAvailable ? 1 : 0);
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
    return _glassSlab(
      palette,
      tint: AppGlass.dock,
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
          if (_amooAvailable)
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
    final m = _cfg?.model.trim() ?? '';
    if (m.isEmpty) return '选模型';
    // 模型名动辄 40+ 字符（vendor/model:free），chip 宽度有限。
    // 保留头尾、中间省略：尾部常是版本/免费标记，是区分不同档位的依据。
    if (m.length <= 18) return m;
    return '${m.substring(0, 11)}…${m.substring(m.length - 6)}';
  }

  /// 随时换模型。选中即落盘并立即生效——下一次发送就用它。
  ///
  /// 为什么落盘：只改内存的话，切到别的 tab 再回来（或重启 App）就丢，
  /// 而用户以为选过了。那正是「选了没生效」最常见的来路。
  Future<void> _pickModel(AppPalette palette) async {
    final current = _cfg?.model.trim() ?? '';
    final cfg = _cfg;
    if (cfg == null || cfg.baseUrl.isEmpty) {
      _addSystemMsg('还没配 API：先去设置页选一个提供商、填好 Key。');
      return;
    }

    // 拉一次模型列表。拉不到就退回内置默认列表——离线时也要能换，
    // 否则「随时切换」在有网时才成立。
    List<ModelInfo> models = const [];
    try {
      models = await ModelRegistry.fetchModels(cfg.baseUrl, cfg.effectiveApiKey);
    } catch (_) {
      models = const [];
    }
    if (models.isEmpty) {
      final provider = BuiltInKeys.matchBaseUrl(cfg.baseUrl);
      models = ModelRegistry.getDefaultModels(provider ?? '');
    }
    if (!mounted) return;

    final picked = await showModalBottomSheet<ModelInfo>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => ModelPickerSheet(
        models: models,
        currentId: current,
        palette: palette,
      ),
    );
    if (picked == null || !mounted) return;
    if (picked.id == current) return;

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
                    hintText: _chatTarget.isAmoo
                        ? '问 amoo（约 6 分钟，期间别切走）...'
                        : '输入消息...',
                    hintStyle: AppText.body.copyWith(color: palette.textFaint),
                    border: InputBorder.none,
                    contentPadding:
                        const EdgeInsets.symmetric(vertical: 12),
                  ),
                  onSubmitted: (_) {
                    if (_chatTarget.isAmoo) {
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
        final amoo = _amooAvailable && _chatTarget.isAmoo;
        return GestureDetector(
          onTap: _amooAvailable
              ? () {
                  _chatTarget.toggle();
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
                  if (_chatTarget.isAmoo) {
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
              if (_amooAvailable)
                _enterItem(
                  5,
                  AmooTaskCard(
                    key: _amooCardKey,
                    target: _chatTarget,
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
                  const KhyBrandTile(size: 28, radius: 6),
                  const SizedBox(width: 8),
                  Text('会话列表',
                      style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                          color: cs.onSurface)),
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
                  _currentConvId =
                      'conv_${DateTime.now().millisecondsSinceEpoch}';
                  _currentTitle = '新对话';
                  _currentWorkspaceRoot = null;
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
                              style: TextStyle(
                                  fontSize: 13,
                                  color: cs.onSurface.withValues(alpha: 0.4))),
                        ],
                      ),
                    )
                  : ListView.builder(
                      itemCount: _conversations.length,
                      itemBuilder: (context, index) {
                        final conv = _conversations[index];
                        final isActive = conv.id == _currentConvId;
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
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: isActive ? FontWeight.bold : FontWeight.normal,
                              color: isActive ? cs.primary : cs.onSurface,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: Text(
                            '${conv.messageCount} 条消息',
                            style: TextStyle(
                                fontSize: 11, color: cs.onSurfaceVariant),
                          ),
                          trailing: IconButton(
                            icon: Icon(Icons.delete,
                                size: 16, color: cs.onSurfaceVariant),
                            onPressed: () => _deleteConversation(conv.id),
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
                style: TextStyle(
                    fontSize: 11, color: cs.onSurfaceVariant),
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
      await d.get('${_cfg!.baseUrl}/models',
          options: Options(
              headers: {
                'Authorization': 'Bearer ${_cfg!.effectiveApiKey}'
              },
              validateStatus: (s) => s != null && s < 500));
      setState(() => _connStatus = 'connected');
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
        userMsg = 'API 返回 $code：${_describeHttpStatus(code)}';
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
    
    // 找一个未尝试过的、有 key 的 provider
    final next = BuiltInKeys.providers.values.firstWhere(
      (p) => p.hasKey && 
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
        return AppColors.success;
      case 'testing':
        return AppColors.warning;
      case 'dns_error':
      case 'network_error':
        return AppColors.error;
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

  static const _dangerousPatterns = [
    'rm -rf', 'mkfs', 'dd if=', 'format', 'wipe',
    'reboot', 'shutdown', 'halt',
    'chmod 777', 'chown root',
    'systemctl', 'insmod', 'rmmod',
  ];

  bool _isDangerousCommand(Map<String, dynamic> args) {
    if (args['cmd'] == 'shell' || args['name'] == 'exec_shell') {
      final cmd = args['command']?.toString() ??
          (args['args']?['command']?.toString()) ?? '';
      final lower = cmd.toLowerCase();
      for (final pattern in _dangerousPatterns) {
        if (lower.contains(pattern)) return true;
      }
    }
    if (args['name'] == 'exec_shell' && args['command'] != null) {
      final cmd = args['command'].toString().toLowerCase();
      for (final pattern in _dangerousPatterns) {
        if (cmd.contains(pattern)) return true;
      }
    }
    return false;
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
    if (toolName == 'exec_shell' || toolName == 'android') {
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
            const Text('危险命令确认', style: TextStyle(fontSize: 16)),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('即将执行以下命令：', style: TextStyle(fontSize: 13, color: cs.onSurface)),
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
                cmd.length > 200 ? cmd.substring(0, 200) + '...' : cmd,
                style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
              ),
            ),
            const SizedBox(height: 8),
            Text('此操作可能影响系统，请确认你了解风险。',
                style: TextStyle(fontSize: 12, color: cs.onSurface.withValues(alpha: 0.6))),
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

  String _summarizeOld(List<Map<String, dynamic>> msgs) {
    final buf = StringBuffer();
    for (final m in msgs.sublist(msgs.length - 4)) {
      final role = m['role'] == 'user' ? '用户' : 'AI';
      final content = (m['content'] ?? '').toString();
      buf.writeln('$role: ${content.length > 100 ? content.substring(0, 100) + '...' : content}');
    }
    return buf.toString().trim();
  }

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

