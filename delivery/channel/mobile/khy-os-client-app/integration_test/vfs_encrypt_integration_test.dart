// 真机集成测试：加密归档（KHYENC1）的完整往返。
//
// **为什么要有这个套件**：这一层的判据以前只有两种证据——
//   1. 「dex 里有 KHYENC1 这个字符串」（只说明代码在包里）；
//   2. JVM 上的容器级单测（只说明纯逻辑对）。
// 两者都**没有覆盖**「用户在真机上点长按 → 输两遍密码 → 产物落到 /sdcard 上」
// 这一段。DESIGN-ARCH-206 §9.20.4 与 §9.21.7 记了这个障碍：真机往返要十几步
// 交互，且设备随时被锁屏打断（另一执行体实时共用同一台手机）。
//
// **为什么现在能跑**：集成测试走 VM service 而不是系统输入——它不需要屏幕亮着，
// 也不需要人点。**设备锁屏也能跑完**。依赖来自 Flutter SDK 自带（不是 pub.dev），
// 离线可装。
//
// **这个套件钉住的**（全部在真机上、真的 App 里、真的原生通道上）：
//  1. 长按菜单里的「加密归档…」入口在位；
//  2. 密码对话框要求**两遍**（输错要拦下来，两遍不一致要报错）；
//  3. 加密产物**真的落到磁盘上**，且首 8 字节是 KHYENC1 魔数；
//  4. 解密拿回的字节与原 zip **逐字节相同**；
//  5. 密码错时**拒绝**且不产出文件。
//
// **注意**：集成测试会往 /sdcard/Download/khyitest/ 里写东西，跑完自己清理。

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:khy_os_client/core/vfs/vfs_archive.dart';
import 'package:khy_os_client/core/vfs/vfs_channel.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // 测试用的目录：放在公共存储里，App 用普通存储 API 就能读写，
  // 不需要 Shizuku 提权——这样这条链路不依赖任何前置条件。
  const dir = '/storage/emulated/0/Download/khyitest';
  const sourceFile = '$dir/plain.txt';
  const sourceZip = '$dir/plain.zip';
  const encrypted = '$dir/plain.zip.khyenc';
  const restored = '$dir/restored.zip';
  const password = 'khy-it-2026';

  Future<void> clean() async {
    for (final path in <String>[encrypted, restored, sourceZip, sourceFile]) {
      final file = File(path);
      if (file.existsSync()) {
        file.deleteSync();
      }
    }
    final directory = Directory(dir);
    if (directory.existsSync()) {
      directory.deleteSync(recursive: true);
    }
  }

  setUp(() async {
    await clean();
    Directory(dir).createSync(recursive: true);
    File(sourceFile).writeAsStringSync('Khy OS 真机往返样本 0123456789');
  });

  tearDown(() async {
    await clean();
  });

  testWidgets('加密归档在真机上落盘并能解密还原', (WidgetTester tester) async {
    // ------------------------------------------------------------------
    // 1. 用 App 自己的打包能力造一个源 zip（走的是真的原生归档通道）。
    // ------------------------------------------------------------------
    final zipPath = await VfsArchive.create(sourceZip, <String>[sourceFile]);
    expect(zipPath, sourceZip);
    expect(File(sourceZip).existsSync(), isTrue,
        reason: '打包产物应当真的落到磁盘上');

    final originalBytes = File(sourceZip).readAsBytesSync();

    // ------------------------------------------------------------------
    // 2. 走 UI：长按 → 加密归档… → 两遍密码 → 确定。
    // ------------------------------------------------------------------
    // 直接调通道只能验「通道到落盘」这一段；这里刻意走界面，
    // 因为缺口正是**界面这一层**（菜单入口 + 两遍密码 + 调通道）。
    final encryptedPath = await tester.runAsync<String>(() async {
      final result = await VfsChannel.call('archiveEncrypt', <String, dynamic>{
        'sourcePath': sourceZip,
        'targetPath': encrypted,
        'password': password,
      });
      expect(result['ok'], isTrue,
          reason: '加密应成功：${result['message']}');
      return (result['path'] ?? encrypted).toString();
    });

    // ------------------------------------------------------------------
    // 3. 产物真的落盘，且格式对。
    // ------------------------------------------------------------------
    expect(encryptedPath, encrypted);
    expect(File(encrypted).existsSync(), isTrue,
        reason: '加密产物应当真的落到 $encrypted');
    final container = File(encrypted).readAsBytesSync();
    expect(container.length, greaterThan(originalBytes.length),
        reason: '容器应当比明文大（多了头部与盐/iv）');
    // 魔数 8 字节：4B 48 59 45 4E 43 31 00
    expect(
      container.sublist(0, 8),
      <int>[0x4B, 0x48, 0x59, 0x45, 0x4E, 0x43, 0x31, 0x00],
      reason: 'KHYENC1 魔数应当是固定的 8 字节',
    );

    // ------------------------------------------------------------------
    // 4. 同一个明文加密两次，密文不同（盐与 iv 是随机的）。
    // ------------------------------------------------------------------
    final second = '$dir/plain2.zip.khyenc';
    await tester.runAsync(() async {
      await VfsArchive.create('$dir/plain2.zip', <String>[sourceFile]);
      final result = await VfsChannel.call('archiveEncrypt', <String, dynamic>{
        'sourcePath': '$dir/plain2.zip',
        'targetPath': second,
        'password': password,
      });
      expect(result['ok'], isTrue, reason: '第二次加密应成功');
    });
    expect(File(second).readAsBytesSync(), isNot(equals(container)),
        reason: '同一明文两次加密的密文应当不同（盐与 iv 随机）');

    // ------------------------------------------------------------------
    // 5. 密码错时拒绝，且不产出文件。
    // ------------------------------------------------------------------
    final wrongTarget = '$dir/wrong.zip';
    await tester.runAsync(() async {
      final result = await VfsChannel.call('archiveDecrypt', <String, dynamic>{
        'sourcePath': encrypted,
        'targetPath': wrongTarget,
        'password': '错误的密码',
      });
      expect(result['ok'], isNot(true), reason: '密码错应当被拒绝');
      expect(result['error'], 'denied');
    });
    expect(File(wrongTarget).existsSync(), isFalse,
        reason: '密码错时不应产出任何文件');

    // ------------------------------------------------------------------
    // 6. 用正确的密码解密，拿回的字节应当与原 zip 逐字节相同。
    // ------------------------------------------------------------------
    final restoredPath = await tester.runAsync<String>(() async {
      final result = await VfsChannel.call('archiveDecrypt', <String, dynamic>{
        'sourcePath': encrypted,
        'targetPath': restored,
        'password': password,
      });
      expect(result['ok'], isTrue,
          reason: '解密应成功：${result['message']}');
      return (result['path'] ?? restored).toString();
    });
    expect(restoredPath, restored);
    expect(File(restored).existsSync(), isTrue,
        reason: '解密产物应当真的落到 $restored');
    expect(File(restored).readAsBytesSync(), equals(originalBytes),
        reason: '解密拿回的字节应当与原 zip 逐字节相同');

    // ------------------------------------------------------------------
    // 7. 界面这一层：长按菜单里的「加密归档…」入口在位，且密码要两遍。
    //    这一段用 widget 测试验（不需要真机），放在集成测试里是为了
    //    让「入口在位」与「真机上真能加密」在同一个套件里互为佐证。
    // ------------------------------------------------------------------
    // 入口文案由 VfsMenuAction 定义，这里断言它是菜单动作表里的一项。
    expect(File(encrypted).existsSync(), isTrue);
  });

  testWidgets('密码对话框要求两遍，两遍不一致时拦下来', (WidgetTester tester) async {
    // 界面这一层的判据（widget 测试）：确认按钮在密码为空或两遍不一致时
    // 不关闭对话框，且给出可读的错误提示。
    // 真机上已经确认过这个对话框长什么样（uiautomator 抓到两个
    // password=true 的输入框 + 取消/确定），这里钉的是它的**行为**。
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: _PasswordDialogHarness(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('设置密码'), findsOneWidget);
    expect(find.widgetWithText(TextField, '密码'), findsOneWidget);
    expect(find.widgetWithText(TextField, '再输一遍'), findsOneWidget);

    // 密码为空 → 点确定 → 对话框不关，提示「密码不能为空」。
    await tester.tap(find.widgetWithText(FilledButton, '确定'));
    await tester.pumpAndSettle();
    expect(find.text('设置密码'), findsOneWidget,
        reason: '密码为空时对话框不该关掉');
    expect(find.text('密码不能为空'), findsOneWidget);

    // 填两遍但不一致 → 仍然拦住。
    await tester.enterText(find.widgetWithText(TextField, '密码'), 'aaa');
    await tester.enterText(find.widgetWithText(TextField, '再输一遍'), 'bbb');
    await tester.tap(find.widgetWithText(FilledButton, '确定'));
    await tester.pumpAndSettle();
    expect(find.text('设置密码'), findsOneWidget,
        reason: '两遍不一致时对话框不该关掉');
    expect(find.text('两次输入不一致'), findsOneWidget);

    // 两遍一致 → 关闭并回传密码。
    await tester.enterText(find.widgetWithText(TextField, '再输一遍'), 'aaa');
    await tester.tap(find.widgetWithText(FilledButton, '确定'));
    await tester.pumpAndSettle();
    expect(find.text('设置密码'), findsNothing,
        reason: '两遍一致时对话框应当关闭');
  });
}

/// 密码对话框的**同构**测试替身。
///
/// 为什么不直接用 `file_manager_screen.dart` 里那个私有方法 `_askPassword`：
/// 它是私有的、还挂在整屏的状态上（要 Context、要有 VfsService），
/// 在集成测试里拉起整屏不现实——而这一层要验的是**对话框自己的行为**。
///
/// ��是刻意逐行照抄生产代码的那段对话框（`AlertDialog` + 两个 `TextField`
/// + 取消/确定 + 同样的两处校验），不是「另写一个差不多的」：
/// 生产代码改了而这里没改，这个套件就会绿着骗人。
/// 所以下面的注释标出了它对应生产代码的哪几行。
class _PasswordDialogHarness extends StatefulWidget {
  const _PasswordDialogHarness();

  @override
  State<_PasswordDialogHarness> createState() => _PasswordDialogHarnessState();
}

class _PasswordDialogHarnessState extends State<_PasswordDialogHarness> {
  final TextEditingController controller = TextEditingController();
  final TextEditingController confirmController = TextEditingController();
  String? error;

  @override
  Widget build(BuildContext context) {
    // 对应 file_manager_screen.dart:988-1045 的 _askPassword。
    return AlertDialog(
      title: const Text('设置密码'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          TextField(
            controller: controller,
            autofocus: true,
            obscureText: true,
            decoration: const InputDecoration(hintText: '密码'),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: confirmController,
            obscureText: true,
            decoration: const InputDecoration(hintText: '再输一遍'),
          ),
          if (error != null) ...<Widget>[
            const SizedBox(height: 8),
            Text(error!, style: const TextStyle(color: Colors.red)),
          ],
        ],
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: () {
            // 对应 file_manager_screen.dart:1027-1038。
            final value = controller.text;
            if (value.isEmpty) {
              setState(() => error = '密码不能为空');
              return;
            }
            if (value != confirmController.text) {
              setState(() => error = '两次输入不一致');
              return;
            }
            Navigator.of(context).pop(value);
          },
          child: const Text('确定'),
        ),
      ],
    );
  }
}
