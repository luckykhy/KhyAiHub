// 书签 / 最近访问 / 标签的判据测试。
//
// 重点是**降级要诚实**：真机上写盘失败、或者在测试环境里根本没有 path_provider，
// 这些情况下读写都该返回「空」而不是抛异常——书签丢一条不算事，
// 但因为书签读不出来就让文件管理器打不开，那才出事。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_organization.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('模型序列化', () {
    test('书签往返', () {
      final bookmark = VfsBookmark(
        path: '/storage/emulated/0/Download',
        name: '下载',
        createdAt: DateTime.fromMillisecondsSinceEpoch(1700000000000),
      );
      final restored = VfsBookmark.fromJson(bookmark.toJson());
      expect(restored.path, bookmark.path);
      expect(restored.name, bookmark.name);
      expect(restored.createdAt.millisecondsSinceEpoch,
          bookmark.createdAt.millisecondsSinceEpoch);
    });

    test('历史条目往返', () {
      final entry = VfsHistoryEntry(
        path: '/storage/emulated/0',
        visitedAt: DateTime.fromMillisecondsSinceEpoch(1700000000000),
      );
      final restored = VfsHistoryEntry.fromJson(entry.toJson());
      expect(restored.path, entry.path);
      expect(restored.visitedAt.millisecondsSinceEpoch,
          entry.visitedAt.millisecondsSinceEpoch);
    });

    test('标签往返并保留路径列表', () {
      const tag = VfsTag(
        name: '项目A',
        color: '#F0A868',
        paths: <String>['/a', '/b'],
      );
      final restored = VfsTag.fromJson(tag.toJson());
      expect(restored.name, '项目A');
      expect(restored.color, '#F0A868');
      expect(restored.paths, hasLength(2));
    });
  });

  group('读不出来时的降级', () {
    test('书签读不出来返回空列表而不是抛异常', () async {
      final bookmarks = await VfsOrganizationStore.loadBookmarks();
      expect(bookmarks, isEmpty);
    });

    test('历史读不出来返回空列表', () async {
      final history = await VfsOrganizationStore.loadHistory();
      expect(history, isEmpty);
    });

    test('标签读不出来返回空列表', () async {
      final tags = await VfsOrganizationStore.loadTags();
      expect(tags, isEmpty);
    });

    test('写失败不抛异常（书签丢一条不算事）', () async {
      await VfsOrganizationStore.addBookmark('/a/b', 'b');
      await VfsOrganizationStore.recordVisit('/a/b');
      await VfsOrganizationStore.tagPath('项目A', '/a/b');
      await VfsOrganizationStore.clearHistory();
      await VfsOrganizationStore.removeTag('项目A');
    });
  });
}
