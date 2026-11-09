// khy-canary: Khy-20261101-127-5CMTWE5S
import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/db/amoo_turn.dart';
import '../../core/db/amoo_turn_store.dart';
import '../../core/services/amoo_chat_service.dart';
import '../../core/services/amoo_service.dart';
import '../../core/services/chat_target.dart';

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

  AmooTaskCard({
    super.key,
    this.initialText = '',
    ChatTargetNotifier? target,
    GlobalKey<AmooTaskCardState>? cardKey,
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
  String _reply = '';
  String _failureHint = '';
  String _recoveryHint = '';
  bool _needsOpenAmoo = false;
  bool _sending = false;
  Timer? _poller;

  /// 当前这笔提问在库里的行 id。-1 = 库不可用，这一笔没有本地记录。
  int _rowId = -1;

  /// 主输入框是否正对着 amoo。true 时本卡把自己的输入框收起来（见 build）。
  bool get _mainInputOwnsMe => _target.isAmoo;

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
    if (text.isEmpty || _sending || _running) return false;
    setState(() {
      _sending = true;
      _reply = '';
      _failureHint = '';
      _recoveryHint = '';
      _needsOpenAmoo = false;
      _sentPreview = text;
      _status = '正在提交…';
    });
    // 顺序要紧：先落盘，再发起。反过来的窗口里进程一死，这笔提问
    // （唯一收不回来的那种）就永久没有本地记录了。
    _rowId = await AmooTurnStore.instance
        .insertPending(text, DateTime.now().millisecondsSinceEpoch);
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
        _needsOpenAmoo = outcome.code == AmooAskFailure.amooNotForeground;
      });
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
      setState(() => _status = 'amoo 正在思考…（状态读取失败，重试中）');
      return;
    }
    setState(() {
      _state = outcome.state;
      _status = outcome.statusLine;
      if (outcome.state == AmooAskState.done) _reply = outcome.reply;
      if (outcome.state == AmooAskState.failed) {
        _failureHint = outcome.error;
      }
    });
    if (outcome.state != AmooAskState.running) {
      _poller?.cancel();
      _poller = null;
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
    final canSend = !_sending && !_running && _input.text.trim().isNotEmpty;

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
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
                const Text('问 amoo',
                    style:
                        TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                const Spacer(),
                if (_running)
                  TextButton.icon(
                    onPressed: _stop,
                    icon: const Icon(Icons.stop, size: 16),
                    label: const Text('停止'),
                  ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              _status,
              style: TextStyle(
                fontSize: 12,
                color: _state == AmooAskState.failed && _sending == false
                    ? cs.error
                    : cs.onSurface.withValues(alpha: 0.6),
              ),
            ),
            const SizedBox(height: 12),
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
                  hintText:
                      _running ? 'amoo 正在思考…' : '输入要问 amoo 的内容…',
                  border: const OutlineInputBorder(),
                  counterText: '${_input.text.length}/4000',
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 8),
            ],
            if (_mainInputOwnsMe && _running) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                    horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: cs.primary.withValues(alpha: 0.06),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  _sentPreview.isEmpty ? '已发给 amoo' : '已发给 amoo：$_sentPreview',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12),
                ),
              ),
              const SizedBox(height: 8),
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
              const SizedBox(height: 10),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: cs.error.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(10),
                  border:
                      Border.all(color: cs.error.withValues(alpha: 0.3)),
                ),
                child: Text(
                  _failureHint,
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ],
            if (_recoveryHint.isNotEmpty) ...[
              const SizedBox(height: 10),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: cs.error.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(10),
                  border:
                      Border.all(color: cs.error.withValues(alpha: 0.3)),
                ),
                child: Text(
                  _recoveryHint,
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ],
            if (_reply.isNotEmpty) ...[
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: cs.primary.withValues(alpha: 0.06),
                  borderRadius: BorderRadius.circular(10),
                  border:
                      Border.all(color: cs.primary.withValues(alpha: 0.25)),
                ),
                child: SelectableText(
                  _reply,
                  style: const TextStyle(fontSize: 13, height: 1.5),
                ),
              ),
            ],
            const SizedBox(height: 8),
            Text(
              '回复取自 amoo 最新气泡的原始文本，未解析。提问发出后收不回来。',
              style: TextStyle(
                fontSize: 11,
                height: 1.4,
                color: cs.onSurface.withValues(alpha: 0.5),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
