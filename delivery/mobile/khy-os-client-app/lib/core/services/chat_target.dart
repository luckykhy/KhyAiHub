// khy-canary: Khy-20261101-083-F8AF8X14
import 'package:flutter/foundation.dart';

/// 底部输入框当前发给谁。
///
/// 为什么需要它：AI 页原来有两个输入框——amoo 反代卡一个、主对话一个。两个框
/// 并排摆在用户面前，第一件事就成了猜"我该敲哪个"，而它们的语义完全不同
/// （一个等 6 分钟，一个秒回）。
///
/// 合成一个：主输入框始终是那个输入框，加一个目标切换。选 amoo 时反代卡把
/// 自己的输入框收起来，只留状态和回复——卡还在（进度、停止、历史都靠它），
/// 但不再有两个光标。
///
/// 做成全局可监听而不是传参：主输入框在 chat_screen_new，卡在
/// amoo_task_card，两者隔着几层 widget；而底部导航让四个页同时活着，
/// 用 InheritedWidget 反而要在每一层都挂上。
enum ChatTarget { assistant, amoo }

class ChatTargetNotifier extends ValueNotifier<ChatTarget> {
  ChatTargetNotifier() : super(ChatTarget.assistant);

  bool get isAmoo => value == ChatTarget.amoo;

  void toggle() => value =
      value == ChatTarget.assistant ? ChatTarget.amoo : ChatTarget.assistant;
}
