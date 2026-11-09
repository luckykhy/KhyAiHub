import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:khy_os_client/core/services/device_control.dart';

/// install_apk 的契约测试。
///
/// 重点不在"能装上"（那要真机 + 提权），而在**边界**：这条工具能执行任意 APK
/// 安装，是整套工具里权限最高的一条之一。校验松一级，就等于把"装任意应用到
/// 这台手机"交给任何能发消息的一方。
///
/// 所以这里逐条钉住原生层的拒绝理由分类，确保 Dart 侧如实透出、不吞掉。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');
  Map<String, Object?>? lastArgs;

  void mock(Object? Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      // 用 `as Map` 而不是 `as Map<String, Object?>`：MethodChannel 的编解码器
      // 交回来的是 Map<Object?, Object?>，带类型参数的强转会抛——而抛在这里会被
      // 外层 catch 吞成 unavailable，于是测试看到的是"调用失败"而不是真实结果。
      // （这个坑在 device_control 里已经踩过一次，见 DeviceControl 的注释。）
      final a = call.arguments;
      lastArgs = a is Map ? Map<String, Object?>.from(a) : null;
      return handler(call);
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group('路径与参数传递', () {
    test('路径原样交给原生层，不做本地改写', () async {
      // Dart 层刻意不改写路径：大小写、多余斜杠、相对段都原样传下去，
      // 由原生层 trim + 校验。这里改一次（比如顺手 normalize），原生层的校验
      // 就和实际收到的路径对不上了，而那种不一致在现场极难发现。
      mock((call) => <Object, Object?>{
            'ok': true, 'via': 'sidecar', 'elevated': true,
            'stdout': 'Success', 'stderr': '',
          });
      const path = '/sdcard/Download/My App v1.2.apk';
      await DeviceControl.installApk(path);
      expect(lastArgs!['path'], path);
    });

    test('通道方法名是 installApk', () async {
      mock((call) => <Object, Object?>{'ok': true, 'via': 'sidecar'});
      await DeviceControl.installApk('/sdcard/Download/a.apk');
      expect(lastArgs, isNotNull);
      expect(lastArgs!['path'], '/sdcard/Download/a.apk');
    });
  });

  group('原生层的拒绝分类如实透出', () {
    // 这四条对应原生层 installApk 的四个 code。Dart 侧的职责是把 code 带到
    // 界面上——调用方要能分辨"路径不对"和"没权限"，处理方式完全不同。
    for (final entry in <String, String>{
      'not_apk': '只接受 .apk',
      'path_traversal': '不允许包含 ..',
      'forbidden_scope': '只允许安装这两个目录',
      'empty_path': '路径为空',
    }.entries) {
      test('code=${entry.key} 不被吞', () async {
        mock((call) => <Object, Object?>{
              'ok': false, 'code': entry.key, 'error': entry.value,
            });
        final r = await DeviceControl.installApk('/whatever');
        expect(r.ok, false);
        expect(r.code, entry.key);
        expect(r.error, entry.value);
      });
    }

    test('通道异常时返回 unavailable，不抛给 UI', () async {
      mock((call) => throw PlatformException(code: 'boom'));
      final r = await DeviceControl.installApk('/sdcard/Download/a.apk');
      expect(r.ok, false);
      expect(r.code, 'unavailable');
    });
  });

  group('elevated —— 这个字段是整条工具的意义', () {
    test('未提权时 elevated=false，即使 ok=true', () async {
      // 最骗人的一种情况：pm install 在 App 自身 uid 上"成功"返回，
      // 而什么都没装。elevated 是唯一能戳破它的信号。
      mock((call) => <Object, Object?>{
            'ok': true, 'via': 'app', 'elevated': false,
            'stdout': '', 'stderr': '',
          });
      final r = await DeviceControl.installApk('/sdcard/Download/a.apk');
      expect(r.ok, true);
      expect(r.elevated, false,
          reason: 'via=app 必须判为未提权，否则界面会把没装说成装了');
    });

    test('经 sidecar 时 elevated=true', () async {
      mock((call) => <Object, Object?>{
            'ok': true, 'via': 'sidecar', 'elevated': true,
            'stdout': 'Success', 'stderr': '',
          });
      final r = await DeviceControl.installApk('/sdcard/Download/a.apk');
      expect(r.elevated, true);
      expect(r.via, 'sidecar');
    });

    test('经 Shizuku 也算提权', () async {
      mock((call) => <Object, Object?>{
            'ok': true, 'via': 'shizuku', 'elevated': true,
          });
      final r = await DeviceControl.installApk('/sdcard/Download/a.apk');
      expect(r.elevated, true);
    });

    test('默认 elevated=false（原生层没给这个字段时）', () async {
      // 旧原生壳不会返回 elevated。缺省必须落在"没提权"那一侧：
      // 保守的错误是多说一句"可能没装上"，保守的反面是谎报成功。
      mock((call) => <Object, Object?>{'ok': true, 'stdout': 'Success'});
      final r = await DeviceControl.installApk('/sdcard/Download/a.apk');
      expect(r.elevated, false);
    });
  });

  group('返回值不是 Map 时', () {
    test('按 unavailable 处理', () async {
      mock((call) => 'not-a-map');
      final r = await DeviceControl.installApk('/sdcard/Download/a.apk');
      expect(r.ok, false);
      expect(r.code, 'unavailable');
    });
  });
}
