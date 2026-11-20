// khy-canary: Khy-20261101-127-5CMTWE5S
import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/db/amoo_turn.dart';
import '../../core/db/amoo_turn_store.dart';
import '../../core/services/amoo_chat_service.dart';
import '../../core/services/amoo_service.dart';
import '../../core/services/chat_target.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

/// amoo 反代卡片：在 khy-os 首页直接和 amoo 对话。
///
/// 为什么不放在 amoo_composer 那个 bottom sheet 里：那个 sheet 是「把文本投递给
/// amoo」的单向动作，本卡片是「问一句、等回复、贴出来」的有状态会话，生命周期
/// （轮询定时器、单飞锁）完全不同，混在一起会让 sheet 每次重建都重启一轮提问。
///
/// 交互约束：
///   - 单飞：running 期间发送按钮禁用，不会叠第二轮
///   - 轮询 2s 一次；done/failed 立即停表，不空转
///   - 「打开 amoo」只在 amoo_not_foreground 时给出（其他失败点它没用）
///   - reply 原样展示，不解析、不摘要、不声称 amoo「理解了什么」
///
/// 持久化：一笔提问约 6 分钟，期间进程随时可能死。所以**先落盘再发起**
/// （见 [AmooTurnStore.insertPending] 的注释），重启后 [initState] 回收残留行。
class AmooTaskCard extends StatefulWidget {
  final String initialText;

  /// 目标切换的监听源。主输入框对着 amoo 时，本卡收起自己的输入框。
  ///
  /// 默认给一个私有的，这样卡片单独用（预览、测试）时不依赖调用方注入。
  final ChatTargetNotifier target;

  /// 供外部（主输入框）直接把一句话发给 amoo。
  ///
  /// 用 GlobalKey 而不是回调上移：发送逻辑本身住在卡片里（单飞锁、轮询、
  /// 落库、中断全在这儿），上移就等于把那一整套复制一遍。而 GlobalKey 只是
  /// 拿到同一个 State，调用它的 _sendWith。
  final GlobalKey<AmooTaskCardState> cardKey;

  /// 每轮 poll 到新回复时回调。主输入框把它流式写进消息列表的气泡里。
  ///
  /// 为什么必须回调出去而不是只在卡里显示：回复只活在卡片自带的框里，历史记录
  /// 就看不到、滚动后看不全，也没法跟模型回复混在一列读。气泡在消息列表，
  /// 卡只负责"问"和"显示进度"。
  final ValueChanged<String>? onReply;

  /// 这一轮结束（成功/失败/中断）时回调一次，让调用方收尾（清忙态等）。
  final VoidCallback? onFinished;

  AmooTaskCard({
    super.key,
    this.initialText = '',
    ChatTargetNotifier? target,
    GlobalKey<AmooTaskCardState>? cardKey,
    this.onReply,
    this.onFinished,
  })  : target = target ?? _fallback,
        cardKey = cardKey ?? GlobalKey<AmooTaskCardState>();

  static final ChatTargetNotifier _fallback = ChatTargetNotifier();

  @override
  State<AmooTaskCard> createState() => AmooTaskCardState();
}

class AmooTaskCardState extends State<AmooTaskCard> {
  static const Duration _pollInterval = Duration(seconds: 2);

  late final ChatTargetNotifier _target = widget.target;

  late final TextEditingController _input =
      TextEditingController(text: widget.initialText);

  AmooAskState _state = AmooAskState.idle;
  String _status = '空闲';
  String _failureHint = '';
  String _recoveryHint = '';
  bool _needsOpenAmoo = false;
  bool _sending = false;
  Timer? _poller;

  /// 当前这笔提问在库里的行 id。-1 = 库不可用，这一笔没有本地记录。
  int _rowId = -1;

  /// 当前这笔提问的发起时刻（epoch ms）。状态行要报「等了多久」，原生不报步数。
  int _askedAtMs = 0;

  /// 主输入框是否正对着 amoo。true 时本卡把自己的输入框收起来（见 build）。
  bool get _mainInputOwnsMe => _target.isDriver('amoo');

  /// 最近一次经主输入框发出去的话，用于回显"我发出去的正是这句"。
  String _sentPreview = '';

  @override
  void initState() {
    super.initState();
    _target.addListener(_onTargetChanged);
    _recover();
  }

  void _onTargetChanged() => setState(() {});

  @override
  void dispose() {
    _target.removeListener(_onTargetChanged);
    _poller?.cancel();
    _input.dispose();
    super.dispose();
  }

  bool get _running => _state == AmooAskState.running;

  /// 此刻能不能发新一轮。供主输入框在建消息**之前**判断，避免单飞锁拒掉的那几轮
  /// 也留下「用户气泡 + 空 assistant 气泡」——那种假象比不显示更糟。
  bool get canSend => !_sending && !_running;

  /// 回收上次进程死亡留下的未结算提问。
  ///
  /// 只提示，不自动重发：同一句话再发一次等于问两遍，而用户并没有要求重问。
  Future<void> _recover() async {
    final stale = await AmooTurnStore.instance.recoverInterrupted();
    if (!mounted || stale.isEmpty) return;
    final last = stale.first;
    setState(() {
      _state = AmooAskState.failed;
      _status = last.statusLine;
      _recoveryHint = last.recoveryHint ?? '';
      _needsOpenAmoo = true;
    });
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending || _running) return;
    await sendWith(text);
  }

  /// 用给定文本发起一次提问。主输入框走这条（它自己管光标，不经过 _input）。
  ///
  /// 公开而不是私有：主输入框在另一个文件里，要把这句话递进来只能经 State。
  /// 见 widget.cardKey 的注释。
  ///
  /// 单飞判定放在这儿而不是调用方：调用方不知道卡里有没有未结算的提问，
  /// 而叠第二个提问会让两次回复交错，最后谁也分不清哪句答哪句。
  ///
  /// @return 是否真的发出去了。false = 被拒（空文本 / 单飞 / 已在进行）。
  Future<bool> sendWith(String raw) async {
    final text = raw.trim();
    if (text.isEmpty || _sending || _running) {
      // 被拒也要让调用方收尾：它已经建好了消息对，不收尾就会一直显示忙态。
      widget.onFinished?.call();
      return false;
    }
    setState(() {
      _sending = true;
      _failureHint = '';
      _recoveryHint = '';
      _needsOpenAmoo = false;
      _sentPreview = text;
      _status = '正在提交…';
    });
    // 顺序要紧：先落盘，再发起。反过来的窗口里进程一死，这笔提问
    // （唯一收不回来的那种）就永久没有本地记录了。
    _askedAtMs = DateTime.now().millisecondsSinceEpoch;
    _rowId = await AmooTurnStore.instance.insertPending(text, _askedAtMs);
    final outcome = await AmooChatService.ask(text);
    if (!mounted) return false;
    if (!outcome.ok) {
      await AmooTurnStore.instance.settle(
        _rowId,
        state: AmooTurnState.failed,
        error: outcome.failureDetail,
        settledAt: DateTime.now().millisecondsSinceEpoch,
      );
      setState(() {
        _sending = false;
        _state = AmooAskState.failed;
        _status = outcome.statusLine;
        _failureHint = outcome.failureDetail;
        // 「打开 amoo」按钮的出现条件：原来只认 amoo_not_foreground 一种。
        // 但 apex 路径读不到窗口时（聊天页被清出返回栈）给的建议同样是"去开一次"，
        // 文案里点了这个按钮名却不把它画出来，等于让用户去找一个不存在的控件。
        // 判据改成"失败原因是否在原生侧就建议去开 amoo"——两边保持同一个事实来源。
        _needsOpenAmoo = outcome.code == AmooAskFailure.amooNotForeground ||
            outcome.message.contains('打开 amoo') ||
            outcome.failureDetail.contains('打开 amoo');
      });
      // 必须通知调用方收尾。少了这一句，_busy 会一直停在 true——发送按钮从此
      // 再也点不动，而用户看到的是"没反应"，不是"失败了"。上一轮就是这么卡住的。
      widget.onFinished?.call();
      return false;
    }
    await AmooTurnStore.instance.markRunning(_rowId, outcome.job);
    setState(() {
      _sending = false;
      _state = AmooAskState.running;
      _status = outcome.statusLine;
    });
    _input.clear();
    _startPolling();
    return true;
  }

  void _startPolling() {
    _poller?.cancel();
    _poller = Timer.periodic(_pollInterval, (_) => _pollOnce());
  }

  Future<void> _pollOnce() async {
    final outcome = await AmooChatService.poll();
    if (!mounted) return;
    if (!outcome.ok) {
      // 轮询失败不等于 amoo 失败：可能是通道抖动。保留 running 态继续轮，
      // 但状态行要说清是「问不到状态」，不能假装还在等 amoo。
      setState(() => _status =
          '${amooWaitingLabel(askedAtMs: _askedAtMs)}（状态读取失败，重试中）');
      return;
    }
    setState(() {
      _state = outcome.state;
      _status = outcome.statusLine;
      if (outcome.state == AmooAskState.failed) {
        _failureHint = outcome.error;
        // 同 sendWith：原生说"去开 amoo"时，按钮必须真的在。
        _needsOpenAmoo = outcome.code == AmooAskFailure.amooNotForeground ||
            outcome.message.contains('打开 amoo') ||
            outcome.error.contains('打开 amoo');
      }
    });
    // 长回复是流式写进同一个气泡的，所以 running 期间每次读到新文本都要推出去，
    // 不能等 done——等的话用户要盯着"正在思考"干等 6 分钟才看见第一行字。
    if (outcome.reply.trim().isNotEmpty) widget.onReply?.call(outcome.reply);
    if (outcome.state != AmooAskState.running) {
      _poller?.cancel();
      _poller = null;
      widget.onFinished?.call();
      final stamp = DateTime.now().millisecondsSinceEpoch;
      await AmooTurnStore.instance.settle(
        _rowId,
        state: outcome.state == AmooAskState.done
            ? AmooTurnState.done
            : AmooTurnState.failed,
        reply: outcome.state == AmooAskState.done ? outcome.reply : null,
        error: outcome.error,
        settledAt: stamp,
      );
    }
  }

  Future<void> _stop() async {
    final ok = await AmooChatService.stop();
    final stamp = DateTime.now().millisecondsSinceEpoch;
    await AmooTurnStore.instance.settle(
      _rowId,
      state: AmooTurnState.failed,
      error: 'interrupted_by_user',
      settledAt: stamp,
    );
    if (!mounted) return;
    setState(() {
      _status = ok ? '已请求中断' : '中断请求失败';
      _failureHint = ok ? '提问已经发出，收不回来；amoo 可能仍在回答。' : '';
    });
    _poller?.cancel();
    _poller = null;
    widget.onFinished?.call();
    _poller = null;
    _state = AmooAskState.failed;
  }

  Future<void> _openAmoo() async {
    final ok = await AmooService.openChat();
    if (!mounted) return;
    setState(() {
      if (ok) {
        _needsOpenAmoo = false;
        _status = '已打开 amoo，回到聊天页后再提问';
      } else {
        _status = '无法打开 amoo';
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final palette = AppPalette.of(context);
    final canSend = !_sending && !_running && _input.text.trim().isNotEmpty;

    return Card(
      margin: const EdgeInsets.symmetric(
          horizontal: AppSpacing.page, vertical: AppSpacing.dense),
      // 输入框直接贴在卡上：主题卡自带 1px 描边（app_theme.dart cardTheme 的
      // side），叠上 OutlineInputBorder 就是双线，所以这里去掉 side 留 surface 底。
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.medium),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Icon(Icons.forum_outlined, size: 18, color: cs.primary),
                const SizedBox(width: 8),
                const Text('问 amoo', style: AppText.cardTitle),
                const Spacer(),
                if (_running)
                  TextButton.icon(
                    onPressed: _stop,
                    icon: const Icon(Icons.stop, size: 16),
                    label: const Text('停止'),
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.micro),
            Text(
              _status,
              style: AppText.secondary.copyWith(
                color: _state == AmooAskState.failed && _sending == false
                    ? palette.error
                    : palette.textSecondary,
              ),
            ),
            const SizedBox(height: AppSpacing.cardGap),
            // 主输入框正在对着 amoo 时，卡自己的输入框收起来。
            //
            // 不是把卡藏了：进度、停止按钮、回复区都还得靠它，只是不该再出现
            // 第二个光标。用户在底下那个框里打字，这边显示"发出去的正是这句话"。
            if (!_mainInputOwnsMe) ...[
              TextField(
                controller: _input,
                enabled: !_running && !_sending,
                minLines: 2,
                maxLines: 5,
                maxLength: 4000,
                decoration: InputDecoration(
                  hintText: _running
                      ? amooWaitingLabel(askedAtMs: _askedAtMs)
                      : '输入要问 amoo 的内容…',
                  // 主题只接管 enabled/focused 描边，disabled 态会退回这个
                  // decoration.border（默认 4 圆角），钉成 medium 与主题一致。
                  border: const OutlineInputBorder(
                    borderRadius: BorderRadius.all(
                      Radius.circular(AppRadius.medium),
                    ),
                  ),
                  counterText: '${_input.text.length}/4000',
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: AppSpacing.dense),
            ],
            if (_mainInputOwnsMe && _running) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                    horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: cs.primary.withValues(alpha: AppAlpha.weakFill),
                  borderRadius: BorderRadius.circular(AppRadius.small),
                ),
                child: Text(
                  _sentPreview.isEmpty ? '已发给 amoo' : '已发给 amoo：$_sentPreview',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.secondary,
                ),
              ),
              const SizedBox(height: AppSpacing.dense),
            ],
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: canSend ? _send : null,
                    icon: _sending
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.send, size: 16),
                    label: Text(_running ? '等待回复…' : '提问'),
                  ),
                ),
                if (_needsOpenAmoo) ...[
                  const SizedBox(width: 8),
                  OutlinedButton.icon(
                    onPressed: _openAmoo,
                    icon: const Icon(Icons.open_in_new, size: 16),
                    label: const Text('打开 amoo'),
                  ),
                ],
              ],
            ),
            if (_failureHint.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.inner),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: cs.error.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(AppRadius.small),
                  border: Border.all(
                      color: cs.error.withValues(alpha: AppAlpha.strokeWeak)),
                ),
                child: Text(
                  _failureHint,
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ],
            if (_recoveryHint.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.inner),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: cs.error.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(AppRadius.small),
                  border: Border.all(
                      color: cs.error.withValues(alpha: AppAlpha.strokeWeak)),
                ),
                child: Text(
                  _recoveryHint,
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ],
            // 回复不在这里显示：它在消息列表的气泡里（带 amoo 徽章），见
            // widget.onReply。这里再画一份就等于同一段话出现两次，而滚动时
            // 只有气泡那份是完整的。
            const SizedBox(height: AppSpacing.dense),
            Text(
              '回复显示在上方消息列表里（带 amoo 标记）。提问发出后收不回来。',
              style: AppText.micro.copyWith(color: palette.textFaint),
            ),
          ],
        ),
      ),
    );
  }
}
