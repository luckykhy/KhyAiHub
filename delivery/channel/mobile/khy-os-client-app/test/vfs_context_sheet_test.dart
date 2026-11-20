// 长按菜单（bottom sheet）的可达性测试。
//
// 为什么要有这个套件：2026-11-09 真机上（1200×2670，OnePlus），长按菜单默认的
// `showModalBottomSheet` 只有 9/16 屏高，而菜单项有十来条——末尾几项
// （「AI 建议…」「属性」「删除」）被裁在屏幕外，**看得见、点不到**。
//
// 菜单项被裁掉等于没有：目标 §一 要求「所有标准文件管理功能（含删除）都可用」，
// 目标 §四 要求「长按菜单能唤起 AI 面板」。这两条在裁切的菜单上都不成立。
//
// 判据不是「弹层高度够不够」，而是「最后一项能不能被滚到并点到」——
// 只有后者才是用户真正要的。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_node.dart';
import 'package:khy_os_client/ui/theme/app_theme.dart';
import 'package:khy_os_client/ui/widgets/vfs/vfs_context_sheet.dart';

void main() {
  // 真机上的那套菜单项（目标 §三 要求 APK 还要多挂「卸载/冻结/禁用」，
  // 所以实际项数比文件的长按更多，这里按最坏情况给）。
  final actions = <VfsMenuAction>[
    const VfsMenuAction('预览', Icons.visibility_outlined),
    const VfsMenuAction('编辑', Icons.edit_note),
    const VfsMenuAction('复制到…', Icons.copy_outlined),
    const VfsMenuAction('移动到…', Icons.drive_file_move_outlined),
    const VfsMenuAction('重命名', Icons.drive_file_rename_outline),
    const VfsMenuAction('压缩为 ZIP…', Icons.folder_zip_outlined),
    const VfsMenuAction('压缩为 TAR.GZ…', Icons.compress_outlined),
    const VfsMenuAction('加密归档…', Icons.lock_outline),
    const VfsMenuAction('加标签…', Icons.label_outline),
    const VfsMenuAction('AI 建议…', Icons.auto_awesome_outlined),
    const VfsMenuAction('属性', Icons.info_outline),
    const VfsMenuAction('删除', Icons.delete_outline, destructive: true),
  ];

  final node = VfsNode(
    name: 'probe.apk',
    path: '/storage/emulated/0/Download/probe.apk',
    isDirectory: false,
  );

  /// 开弹层并把 [label] 那一项滚进可视区。
  ///
  /// 为什么要自己写循环而不用 `scrollUntilVisible`：这个版本在 finder 为空时
  /// 会走 `Iterable.isEmpty` → `.first` 直接抛 StateError——还没开始拖就炸了。
  Future<void> scrollTo(WidgetTester tester, String label) async {
    final target = find.text(label);
    for (var i = 0; i < 40 && !tester.any(target); i++) {
      await tester.drag(find.byType(Scrollable).last, const Offset(0, -220));
      await tester.pumpAndSettle();
    }
    expect(tester.any(target), isTrue,
        reason: '滚了 40 次还没见到「$label」，说明菜单项被裁在屏幕外够不到');
    await tester.ensureVisible(target);
    await tester.pumpAndSettle();
  }

  testWidgets('末位菜单项（删除）能被滚到并点到', (tester) async {
    // 用真机那种窄高比：默认 800×600 的测试视口装不下这么多项，
    // 反而测不出「被裁掉」这件事。
    tester.view.physicalSize = const Size(1200, 2670);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    VfsMenuAction? picked;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark(),
        home: Builder(
          builder: (BuildContext context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  picked = await VfsContextSheet.show(
                    context,
                    node: node,
                    multiSelect: false,
                    actions: actions,
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await scrollTo(tester, '删除');
    await tester.tap(find.text('删除'));
    await tester.pumpAndSettle();

    expect(picked?.label, '删除',
        reason: '「删除」必须真的能点到——它是文件管理器的基本操作');
  });

  testWidgets('中段菜单项（AI 建议）能被滚到并点到', (tester) async {
    tester.view.physicalSize = const Size(1200, 2670);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    VfsMenuAction? picked;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark(),
        home: Builder(
          builder: (BuildContext context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  picked = await VfsContextSheet.show(
                    context,
                    node: node,
                    multiSelect: false,
                    actions: actions,
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await scrollTo(tester, 'AI 建议…');
    await tester.tap(find.text('AI 建议…'));
    await tester.pumpAndSettle();

    expect(picked?.label, 'AI 建议…',
        reason: '目标 §四 要求 AI 能从长按菜单唤起，这一项必须够得到');
  });
}
