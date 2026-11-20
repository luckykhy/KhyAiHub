import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/conversation_sync.dart';

/// 同步状态判据的测试。
///
/// 这一组守的是"界面不许说一句后端没做到的话"：关掉的对话不能显示已同步、
/// 独立模式不能显示同步开、失败必须显示失败而不是继续挂上次的成功。
void main() {
  group('effectiveEnabled', () {
    test('没单独表过态时跟随全局默认', () {
      expect(ConversationSync.effectiveEnabled(override: null, globalDefault: true), true);
      expect(ConversationSync.effectiveEnabled(override: null, globalDefault: false), false);
    });

    test('单对话覆盖优先于全局默认，两个方向都算数', () {
      expect(ConversationSync.effectiveEnabled(override: false, globalDefault: true), false);
      expect(ConversationSync.effectiveEnabled(override: true, globalDefault: false), true);
    });
  });

  group('status', () {
    test('全局关闭 + 远程模式 = off，而不是 pending', () {
      expect(
        ConversationSync.status(
            override: null, globalDefault: false, remoteMode: true, lastState: 'synced'),
        ConversationSyncStatus.off,
      );
    });

    test('单对话关掉时，哪怕全局开着也是 off', () {
      expect(
        ConversationSync.status(
            override: false, globalDefault: true, remoteMode: true, lastState: null),
        ConversationSyncStatus.off,
      );
    });

    test('开着但独立模式 = standalone（不是 off）', () {
      // 两者的下一步不同：off 是"你可以打开"，standalone 是"切到远程模式"。
      expect(
        ConversationSync.status(
            override: null, globalDefault: true, remoteMode: false, lastState: null),
        ConversationSyncStatus.standalone,
      );
    });

    test('开着、远程、还没同步过 = pending', () {
      expect(
        ConversationSync.status(
            override: null, globalDefault: true, remoteMode: true, lastState: null),
        ConversationSyncStatus.pending,
      );
    });

    test('后端回了 synced / failed 就按回的结果说', () {
      ConversationSyncStatus st(String? last) => ConversationSync.status(
          override: null, globalDefault: true, remoteMode: true, lastState: last);
      expect(st(ConversationSync.stateSynced), ConversationSyncStatus.synced);
      expect(st(ConversationSync.stateFailed), ConversationSyncStatus.failed);
      expect(st('something-else'), ConversationSyncStatus.pending);
    });
  });

  group('label / detail', () {
    test('每个状态都有各自的说法，没有两个状态共用一句话', () {
      final labels = ConversationSyncStatus.values.map(ConversationSync.label).toSet();
      expect(labels.length, ConversationSyncStatus.values.length);

      final details = ConversationSyncStatus.values.map(ConversationSync.detail).toSet();
      expect(details.length, ConversationSyncStatus.values.length);
    });

    test('关闭同步的说明必须提到电脑上已有副本保留', () {
      // 本机没有删远端的通路，让用户以为删了是更坏的谎。
      expect(ConversationSync.detail(ConversationSyncStatus.off), contains('保留'));
    });
  });
}
