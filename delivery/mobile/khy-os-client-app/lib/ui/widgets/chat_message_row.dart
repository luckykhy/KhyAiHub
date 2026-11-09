import 'dart:io';

import 'package:flutter/material.dart';

import '../../data/models/models.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import 'aurora.dart';
import 'tool_card.dart';

/// 一条消息行的可观察内容：正文 + 思维链。
///
/// 思维链在 `ChatMessage.reasoning` 上有字段（`lib/data/models/models.dart`），
/// 但行内局部重建要求快照**同时装着正文与思维链**：一次 chunk 可能两者都推进，
/// 分开放两个源就要通知两个 listenable，还得处理两者不一致的中间态。装进一个值里，
/// 「一次更新 = 一次重建」是恒等式，不是约定。
///
/// 快照与消息字段必须同值：保存（`_saveConversation`）与上送后端历史读消息字段，
/// 行内 builder 读快照，两份各写各的就会「UI 有、存下去是空」。所以两份只经
/// [_writeReasoning] 一个口写。
class ChatRowState {
  const ChatRowState(this.message, this.reasoning);

  final ChatMessage message;

  /// 思维链正文，空串 = 没有。只有 assistant 消息可能有。
  final String reasoning;
}

/// 消息行的局部重建通路：notifier 管理 + 正文/思维链/工具卡的唯一改写入口。
///
/// 为什么值得单独立一个类，而不是把这些字段摊在 State 上：它们是「一次 chunk
/// 只重建一行」这套机制的全部状态，与「怎么画一行」同生同死，放一个文件里改一处
/// 不用跳两个文件；更直接的原因是 `_ChatScreenNewState` 已经 2500 行量级
/// （R4 的 god-file 门），再往里堆 notifier 管理必然越线。
class ChatRowStore {
  ChatRowStore(this.messages);

  /// 消息列表。列表本身归屏幕 State（历史拼接、保存、上送后端都要读它），
  /// 但所有改写都必须经本类——只改列表会让已经建了 notifier 的那行显示旧正文，
  /// 只改 notifier 会让上送后端的历史缺这一段。
  final List<ChatMessage> messages;

  /// 工具卡组。卡数变化会让 ListView 的 itemCount 变，所以「0→1」那一次仍得走
  /// 整屏 setState（由屏幕负责判断），本类只负责把快照推给订阅那一组的 builder。
  final List<ToolCardData> toolCards = <ToolCardData>[];

  /// [toolCards] 的快照。订阅方是 `_msgList` 里那个复合 item。
  final ValueNotifier<List<ToolCardData>> toolCardsListenable =
      ValueNotifier<List<ToolCardData>>(const <ToolCardData>[]);

  final Map<String, ValueNotifier<ChatRowState>> _notifiers = {};

  /// 思维链正文，按消息 id 存的**镜像**，不是真源。
  ///
  /// 唯一真源是 [messages] 里那条消息的 `ChatMessage.reasoning`——保存
  /// （`_saveConversation`）和上送后端历史读的都是它。这里存一份同样的值，
  /// 只为解决两个时序问题：消息可能还没被渲染过（notifier 未建）就收到思维链，
  /// 以及每个 chunk 都要读「当前已累加到哪」。
  ///
  /// 既然是镜像，它就必须与消息字段同生同灭，且只经由 [_writeReasoning]
  /// 一个口写入。两处各写各的，正是「切会话再切回思维链全丢」那个 bug 的成因。
  final Map<String, String> _reasoningById = {};

  void dispose() {
    // 只 dispose 此刻还在 map 里的那些。切会话时 [clear] 故意不 dispose：
    // 同一帧里旧的 builder 还要拿 notifier 退订，先 dispose 会撞
    // "used after being disposed"；没人引用的那些交给 GC。
    for (final n in _notifiers.values) {
      n.dispose();
    }
    toolCardsListenable.dispose();
  }

  /// 清消息列表。notifier 与思维链存档必须一起清：只清 messages 的话，切会话后
  /// 旧 id 的 notifier 还挂在 map 里，而新会话完全可能复用同一个 id（id 是毫秒
  /// 时间戳，跨会话撞上的概率不为零），那时局部通知会写进已经不在列表里的行。
  void clear() {
    messages.clear();
    _notifiers.clear();
    // 思维链镜像跟着清。不清的话，新会话复用同一个 id 时第一行会带上上一个
    // 会话的思维链——界面上多出一段用户没问过的话，比丢一段更糟。
    _reasoningById.clear();
  }

  void clearToolCards() {
    toolCards.clear();
    toolCardsListenable.value = const <ToolCardData>[];
  }

  /// 推一份工具卡快照。必须换 List 实例：原地改 [toolCards] 的话 notifier 看不出
  /// 值变了（ValueNotifier 按身份比较），局部重建不会发生。
  void notifyToolCards() {
    toolCardsListenable.value = List<ToolCardData>.of(toolCards);
  }

  /// 这一行的 notifier，第一次被渲染时才建（没显示过的消息不占 notifier）。
  ValueNotifier<ChatRowState> notifierFor(ChatMessage msg) {
    return _notifiers.putIfAbsent(
      msg.id,
      () => ValueNotifier<ChatRowState>(
        // 先存档、后消息字段：流式期间存档是累加值；从历史构造出来、还没来得
        // 及灌存档的消息走自己的字段，否则那一行的思维链渲染不出来。
        ChatRowState(msg, _reasoningById[msg.id] ?? msg.reasoning ?? ''),
      ),
    );
  }

  void setContent(String id, String c) {
    patch(id, (m) => m.copyWith(content: c));
  }

  /// 远程模式每个流式 chunk 走这里。
  void appendContent(String id, String chunk) {
    patch(id, (m) => m.copyWith(content: m.content + chunk));
  }

  /// 远程模式每个 thinking_content chunk 走这里。
  void appendReasoning(String id, String chunk) {
    if (chunk.isEmpty) return;
    _writeReasoning(id, (_reasoningById[id] ?? '') + chunk);
  }

  /// 本地非流式模式：reasoning_content 随整个响应一起回来，整段替换而非累加。
  void setReasoning(String id, String text) {
    if (text.trim().isEmpty) return;
    _writeReasoning(id, text);
  }

  /// 思维链的**唯一**写入口。两份状态一起写，这就是「不会出现 UI 显示思维链
  /// 但存下去是空（或反之）」的全部机制：
  ///
  /// - `messages[i].reasoning`：唯一真源，保存与上送历史读它；
  /// - [_reasoningById]：它的镜像，notifier 首建与累加读它。
  ///
  /// 曾经这里传的是恒等 patch（`(m) => m`），于是消息字段永远是 null，思维链
  /// 只活在 notifier 快照里——一切会话就整段消失。所以现在补的是 `copyWith`，
  /// 不是快照那一侧。
  void _writeReasoning(String id, String text) {
    _reasoningById[id] = text;
    patch(id, (m) => m.copyWith(reasoning: text), reasoning: text);
  }

  void patch(
    String id,
    ChatMessage Function(ChatMessage) patch, {
    String? reasoning,
  }) {
    final i = messages.indexWhere((m) => m.id == id);
    if (i < 0) return;
    final updated = patch(messages[i]);
    messages[i] = updated;
    // 快照的思维链：显式传入优先（思维链写入路径），否则按消息自己的字段——
    // 保存与上送历史都以它为准，快照不能与它不一致；存档只兜「消息还没进
    // 列表」那一种情况。
    _notifiers[id]?.value = ChatRowState(
      updated,
      reasoning ?? updated.reasoning ?? _reasoningById[id] ?? '',
    );
  }
}

/// 一条聊天消息（头像 + 气泡 + 可选思维链块）。
///
/// 从 `chat_screen_new.dart` 的 `_bubble` 抽出来的唯一理由：让整屏 `setState`
/// 不再是更新一条消息的唯一途径。整屏 setState 一次重建的是整个 Scaffold
/// （头部 slab、能力条、全部消息、输入坞、drawer 配置），而流式期间每来一个
/// chunk 只有**这一行**的内容变了——由调用方用 `ValueListenableBuilder` 包住
/// 本组件，重建范围就从「整个聊天屏」缩到「这一个子树」。
///
/// 抽成独立文件而不是留在原文件里：原文件 2423 行，R4 的 2500 行门只剩 77 行，
/// 再往里堆 notifier 管理逻辑必然越线。
class ChatBubbleRow extends StatelessWidget {
  const ChatBubbleRow({
    super.key,
    required this.message,
    required this.busy,
    required this.action,
    this.thinking,
  });

  final ChatMessage message;

  /// 屏幕级忙态。为什么是普通值而不是又一个 notifier：这两个字段在本屏的每一次
  /// 改动都发生在 `setState` 里（`_dispatchSend` / `_sendWithAgentLoop` /
  /// `_sendRemote` 的 finally），整屏重建本来就会把新值带下来；只有 chunk 走
  /// 行内局部通知，而 chunk 不改变忙态。所以这里现读即最新。
  final bool busy;

  /// 忙态转圈旁边显示的动作文案。
  final String action;

  /// 思维链块，null = 不渲染。由调用方在**局部重建的 builder 里**构造：
  /// 放在外面构造会拿到上一次的 reasoning，块里永远是旧正文。
  final Widget? thinking;

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final isUser = message.role == MessageRole.user;
    // 附件只可能是用户发过来的（assistant 侧没有产生图片附件的入口），所以
    // 缩略行也只在用户消息上找。
    final thumbs = isUser ? _attachmentThumbs(palette) : null;

    final bubble = Container(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        gradient: isUser ? AppGradients.brand : null,
        color: isUser ? null : palette.surface,
        borderRadius: const BorderRadius.all(Radius.circular(18)).copyWith(
          bottomLeft:
              isUser ? const Radius.circular(6) : const Radius.circular(18),
          bottomRight:
              isUser ? const Radius.circular(18) : const Radius.circular(6),
        ),
        border: isUser
            ? null
            : Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: message.content.isEmpty && busy && !isUser
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: palette.primary),
                ),
                const SizedBox(width: AppSpacing.dense),
                Text(
                  // 空动作只出现在远程模式首块到达前；按规则 2.5 显示等待目标。
                  action.isNotEmpty ? action : '等待远程后端响应',
                  style:
                      AppText.secondary.copyWith(color: palette.textSecondary),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            )
          : SelectableText(
              message.content,
              style: AppText.body.copyWith(
                  color: isUser ? Colors.white : palette.textPrimary),
            ),
    );

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.dense),
      child: Row(
        mainAxisAlignment: isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isUser) ...[
            const GradientTile(icon: Icons.hub, size: 32),
            const SizedBox(width: AppSpacing.dense),
          ],
          Flexible(
            // 有思维链或图片时才套 Column：块在气泡之上，读作「先想后答」。两者
            // 都没有时直接给气泡，布局与抽组件之前逐字节一致（无思维链的回复与
            // 不带图的用户消息走这条）。
            child: thinking == null && thumbs == null
                ? bubble
                : Column(
                    crossAxisAlignment:
                        isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (thinking != null) thinking!,
                      if (thumbs != null) thumbs!,
                      bubble,
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  /// 用户消息的图片缩略行。没有图片附件时返回 null——那一行的布局与加这个
  /// 功能之前一致。
  Widget? _attachmentThumbs(AppPalette palette) {
    final images = message.imageAttachments;
    if (images.isEmpty) return null;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.dense),
      child: Wrap(
        alignment: WrapAlignment.end,
        spacing: AppSpacing.dense,
        runSpacing: AppSpacing.dense,
        children: [
          for (final a in images)
            _AttachmentThumb(attachment: a, palette: palette),
        ],
      ),
    );
  }
}

/// 一张图片附件的缩略块。
///
/// 文件不在就画占位框而不是让整行崩掉：相册/相机挑出来的临时文件可能已被系统
/// 清掉，而缩略图是这条消息的附属信息——为一张图毁掉整行正文说不通。
class _AttachmentThumb extends StatelessWidget {
  const _AttachmentThumb({required this.attachment, required this.palette});

  final MessageAttachment attachment;
  final AppPalette palette;

  static const double _edge = 64;

  @override
  Widget build(BuildContext context) {
    final file = File(attachment.path);
    return Container(
      width: _edge,
      height: _edge,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: palette.surfaceHigh,
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      // existsSync 先把「临时文件已不在」这条路定下来，errorBuilder 兜另一种
      // （文件在但不是能解码的图）。两条都落到同一个占位框。
      child: file.existsSync()
          ? Image.file(
              file,
              fit: BoxFit.cover,
              errorBuilder: (_, _, _) => _placeholder(),
            )
          : _placeholder(),
    );
  }

  Widget _placeholder() => Icon(
        Icons.image_not_supported_outlined,
        size: 22,
        color: palette.textFaint,
      );
}
