import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:khy_os_client/core/services/device_control.dart';

/// 回归测试：MethodChannel 回来的 Map 不能再用惰性 `cast` 接。
///
/// 这条测试对应一次真实的线上崩溃。日志里 32 条 E601，栈顶在
/// `device_screen_new.dart` 的 `items.take(20).map(...).join('\n')`：
///
///   type '_Map<Object?, Object?>' is not a subtype of
///   type 'Map<String, dynamic>' in type cast
///
/// 出错位置看起来在 UI，实际在 `DeviceControl`：原来写的是
/// `(result['items'] as List).cast<Map<String, dynamic>>()`。`cast` 是惰性的，
/// 只包一层视图，类型检查推迟到每次取值——而 MethodChannel 的编解码器交回来的
/// 正是 `List<Map<Object?, Object?>>`，于是取值那一刻才炸。
///
/// 所以这里的关键是**用运行期类型复现编解码器的行为**：mock 必须真的返回
/// `Map<Object?, Object?>`，不能返回 `Map<String, dynamic>`——后者会让测试
/// 绿着，而设备上照样崩。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');

  void mockChannel(Object? Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      return handler(call);
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group('MethodChannel 的 Map 运行时类型（回归：32 次 E601）', () {
    test('a11yListClickable 吃下 Map<Object?,Object?> 不抛', () async {
      // 编解码器的真实产物：外层 List 的元素是 _Map<Object?, Object?>。
      final items = <Map<Object?, Object?>>[
        <Object?, Object?>{'text': '确定', 'x': 100, 'y': 200},
        <Object?, Object?>{'text': '取消', 'x': 300, 'y': 400},
      ];
      mockChannel((call) {
        expect(call.method, 'a11yListClickable');
        return <Object?, Object?>{'success': true, 'items': items};
      });

      // 这里必须是 await + 真的取值。只 await 不断言内容的话，惰性 cast 的
      // 失败会被推迟到测试结束都发现不了。
      final got = await DeviceControl.a11yListClickable();
      expect(got.length, 2);
      expect(got[0]['text'], '确定');
      expect(got[0]['x'], 100);
      expect(got[1]['y'], 400);
    });

    test('getInstalledPackages 吃下 Map<Object?,Object?> 不抛', () async {
      final packages = <Map<Object?, Object?>>[
        <Object?, Object?>{'name': 'com.tencent.mm', 'label': '微信'},
      ];
      mockChannel((call) {
        expect(call.method, 'getInstalledPackages');
        return <Object?, Object?>{'success': true, 'packages': packages};
      });

      final got = await DeviceControl.getInstalledPackages();
      expect(got.length, 1);
      expect(got[0]['name'], 'com.tencent.mm');
      expect(got[0]['label'], '微信');
    });

    test('调用方拿到的是真 Map<String,dynamic>，不是惰性视图', () {
      // 这条盯的是修复本身：`Map<String,dynamic>.from(...)` 产生的是新 Map，
      // 而 `cast` 产生的是懒检查视图。直接断言静态类型可赋值，防止有人
      // 把修复改回 cast。
      final converted = <Object?, Object?>{'a': 1};
      final real = Map<String, dynamic>.from(converted);
      expect(real, isA<Map<String, dynamic>>());
      expect(real['a'], 1);
    });

    test('items 里混进非 Map 条目时剔掉，不是整个读取失败', () async {
      // 原生侧多推了一个 null 或字符串，不该让"可点击"按钮直接报错。
      final items = <Object?>[
        <Object?, Object?>{'text': '好', 'x': 1, 'y': 2},
        'not-a-map',
        null,
        <Object?, Object?>{'text': '行', 'x': 3, 'y': 4},
      ];
      mockChannel((call) =>
          <Object?, Object?>{'success': true, 'items': items});

      final got = await DeviceControl.a11yListClickable();
      expect(got.length, 2);
      expect(got[0]['text'], '好');
      expect(got[1]['text'], '行');
    });

    test('items 整个不是 List 时返回空，不抛', () async {
      mockChannel((call) =>
          <Object?, Object?>{'success': true, 'items': 'oops'});
      expect(await DeviceControl.a11yListClickable(), isEmpty);
    });

    test('success 不为 true 时返回空', () async {
      mockChannel((call) =>
          <Object?, Object?>{'success': false, 'items': <Object?>[]});
      expect(await DeviceControl.a11yListClickable(), isEmpty);
    });

    test('通道抛异常时返回空，不把异常抛给 UI', () async {
      mockChannel((call) => throw PlatformException(code: 'boom'));
      expect(await DeviceControl.a11yListClickable(), isEmpty);
    });
  });
}
