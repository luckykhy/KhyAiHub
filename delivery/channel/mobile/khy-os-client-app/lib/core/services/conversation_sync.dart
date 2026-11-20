/// 会话同步状态的单一判据。
///
/// 同步真做与否由后端决定（`apiChatSession` 写 `.khy/sessions`），本机只能
/// 依据三件事推断界面该说什么：开关是否打开、当前是不是远程模式、上一轮
/// 后端回了什么。三者混在 widget 里判断，迟早有两处给出不同结论——于是
/// 把这个判断收进纯函数，UI 只负责画。
///
/// 各状态对应的说法（[label]）必须互不重叠，且不允许出现"同步关闭"却仍
/// 显示"已同步"这种组合：那等于告诉用户一件后端没做到的事。
library;

enum ConversationSyncStatus {
  /// 开关关着：本对话只存本机。
  off,

  /// 开关开着，但当前是独立模式：消息压根不经过电脑，谈不上同步。
  /// 与 off 分开，是因为"用户关掉了"和"没有这条通路"该给的下一步不同。
  standalone,

  /// 开着、也在远程模式，但本对话还没有一轮可同步的消息。
  pending,

  /// 最近一轮确实写进了电脑侧共享会话。
  synced,

  /// 最近一轮没能写进去；本地副本仍在。
  failed,
}

class ConversationSync {
  /// 这两个字符串是 `Conversation.syncState` 的落盘取值，改动会读不出旧会话。
  static const stateSynced = 'synced';
  static const stateFailed = 'failed';

  /// 单对话覆盖优先于全局默认；null = 没单独表过态。
  static bool effectiveEnabled({
    required bool? override,
    required bool globalDefault,
  }) =>
      override ?? globalDefault;

  static ConversationSyncStatus status({
    required bool? override,
    required bool globalDefault,
    required bool remoteMode,
    required String? lastState,
  }) {
    if (!effectiveEnabled(override: override, globalDefault: globalDefault)) {
      return ConversationSyncStatus.off;
    }
    if (!remoteMode) return ConversationSyncStatus.standalone;
    if (lastState == stateSynced) return ConversationSyncStatus.synced;
    if (lastState == stateFailed) return ConversationSyncStatus.failed;
    return ConversationSyncStatus.pending;
  }

  static String label(ConversationSyncStatus status) {
    switch (status) {
      case ConversationSyncStatus.off:
        return '同步关';
      case ConversationSyncStatus.standalone:
        return '本机模式';
      case ConversationSyncStatus.pending:
        return '同步开';
      case ConversationSyncStatus.synced:
        return '已同步';
      case ConversationSyncStatus.failed:
        return '同步失败';
    }
  }

  /// 面板里的一句话解释。关掉同步时**必须**说明电脑上已有的副本不会删——
  /// 本机没有删远端的能力，让用户以为删了是更坏的谎。
  static String detail(ConversationSyncStatus status) {
    switch (status) {
      case ConversationSyncStatus.off:
        return '这个对话只存本机。电脑上已有的副本会保留，本机不会删除它。';
      case ConversationSyncStatus.standalone:
        return '独立模式下消息直接发给你配置的模型，不经过电脑。切到远程模式后按同步设置生效。';
      case ConversationSyncStatus.pending:
        return '同步已开。之后的消息会写进电脑的共享会话。';
      case ConversationSyncStatus.synced:
        return '最近一轮已写进电脑的共享会话。';
      case ConversationSyncStatus.failed:
        return '最近一轮没能写进电脑，本地副本还在。再发一条会重试。';
    }
  }
}
