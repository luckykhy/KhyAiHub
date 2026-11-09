import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/workspace/conversation_workspace.dart';
import 'package:khy_os_client/core/workspace/workspace_choices.dart';

/// 工作目录候选与仓库根探测。
///
/// 纯逻辑部分（presets / mergeRepoChoice / checkManual）确定性验证；
/// 探测部分（detectRepoRoot）在测试主机上必然返回 null——`/sdcard` 在 Windows 上
/// 不存在——所以只验证它不抛，真实探测留给真机。
void main() {
  group('presets', () {
    test('第一个是设计的工作空间且标了推荐', () {
      final presets = WorkspaceChoices.presets();
      expect(presets.first.path, ConversationWorkspace.designedRoot);
      expect(presets.first.recommended, true);
    });

    test('没有重复路径', () {
      final paths = WorkspaceChoices.presets().map((c) => c.path).toList();
      expect(paths.toSet().length, paths.length);
    });

    test('都通过校验', () {
      // 预设自己过不了校验，用户点了就存不进去，那是纯粹的尴尬。
      for (final c in WorkspaceChoices.presets()) {
        expect(WorkspaceChoices.checkManual(c.path).ok, true,
            reason: '${c.path} 应通过校验');
      }
    });
  });

  group('mergeRepoChoice', () {
    DirChoice repo(String path) => DirChoice(
          path: path,
          label: 'khy-os 仓库根',
          hint: '已检测到仓库',
          recommended: true,
        );

    test('没有探测到仓库时原样返回', () {
      final base = WorkspaceChoices.presets();
      expect(WorkspaceChoices.mergeRepoChoice(base, null), same(base));
    });

    test('仓库根排最前', () {
      final merged = WorkspaceChoices.mergeRepoChoice(
        WorkspaceChoices.presets(),
        repo('/sdcard/Download/khy-os'),
      );
      expect(merged.first.path, '/sdcard/Download/khy-os');
      expect(merged.first.recommended, true);
    });

    test('仓库根与预设同路径时替换而不是重复', () {
      // 最常见的情形：/sdcard/khy-os 本身就是仓库根。出现两条指向同一处的选项，
      // 用户会以为有两处可选——而那正是一切"文件不知去哪"的开头。
      final merged = WorkspaceChoices.mergeRepoChoice(
        WorkspaceChoices.presets(),
        repo(ConversationWorkspace.designedRoot),
      );
      final hits =
          merged.where((c) => c.path == ConversationWorkspace.designedRoot);
      expect(hits.length, 1);
      expect(hits.first.label, 'khy-os 仓库根');
    });

    test('推荐只能有一个', () {
      // 多个星标等于没有推荐。
      final merged = WorkspaceChoices.mergeRepoChoice(
        WorkspaceChoices.presets(),
        repo('/sdcard/Download/khy-os'),
      );
      expect(merged.where((c) => c.recommended).length, 1);
    });

    test('原预设降级后仍保留路径与说明', () {
      // 降级只摘星标，不能把路径和 hint 也弄丢。
      final merged = WorkspaceChoices.mergeRepoChoice(
        WorkspaceChoices.presets(),
        repo('/sdcard/Download/khy-os'),
      );
      final designed = merged
          .firstWhere((c) => c.path == ConversationWorkspace.designedRoot);
      expect(designed.recommended, false);
      expect(designed.label, 'khy-os 工作空间');
      expect(designed.hint, isNotEmpty);
    });

    test('不改变候选总数（同路径时）', () {
      final base = WorkspaceChoices.presets();
      final merged = WorkspaceChoices.mergeRepoChoice(
        base,
        repo(ConversationWorkspace.designedRoot),
      );
      expect(merged.length, base.length);
    });
  });

  group('detectRepoRoot', () {
    test('测试主机上没有 /sdcard，返回 null 且不抛', () {
      // Windows 上 /sdcard 不存在。探测是尽力而为，读不到只意味着不多这一项，
      // 不该把选择器变成一个崩掉的对话框。
      expect(WorkspaceChoices.detectRepoRoot(), completion(isNull));
    });
  });

  group('checkManual', () {
    test('合法绝对路径被接受', () {
      expect(WorkspaceChoices.checkManual('/sdcard/mygame').ok, true);
    });

    test('相对路径被拒', () {
      expect(WorkspaceChoices.checkManual('sdcard/x').ok, false);
    });

    test('含 .. 被拒', () {
      expect(WorkspaceChoices.checkManual('/sdcard/../etc').ok, false);
    });
  });
}
