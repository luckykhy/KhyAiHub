import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/device_control.dart';

/// 桥起停 / 悬浮框显隐这一族通道调用的护栏。
///
/// WHY THIS FILE EXISTS. 这四个方法原来都是 `Future<void>` + 空 catch：
/// 原生侧无论回了什么、抛了什么，Dart 侧都只剩「什么都没发生」。设置页把它们
/// 做成真开关之后，这个形状不够用了——开关翻过去又弹回来，而用户看不出是
/// 原生拒绝了还是根本没执行。
///
/// 现在四个方法统一回 [BridgeCallResult]，于是有四条性质必须钉住：
///   1. 成功时 ok=true、message 为空（不把成功说成失败）；
///   2. 原生给的中文原因必须原样带出，不能让用户对着一个没动的开关猜；
///   3. 异常 / 空返回 / 旧形状一律降级成 ok=false 而不是 throw——
///      上层是 UI，抛上去只会被吞成「点了没反应」；
///   4. 旧版原生侧不上报布尔键时必须判 false（「不知道就当没成功」），
///      绝不能因为缺字段就默认成功。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');

  /// 装一个既记账又按方法名回包的 mock。
  ///
  /// 之所以只有一个入口，而不是「先装记账的、再装回包的」：
  /// `setMockMethodCallHandler` 是整体替换，后装的那个会把前一个连记账一起
  /// 换掉，于是 log 恒为空——第一版就这么写的，四条「调了哪个方法」的断言
  /// 全在对着空列表较劲。
  void install(
    Object? Function(MethodCall) respond, {
    List<String>? log,
  }) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      log?.add(call.method);
      return respond(call);
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group('overlayShow', () {
    test('成功：ok=true，message 为空', () async {
      final log = <String>[];
      install((call) {
        expect(call.method, 'overlayShow');
        return <String, Object?>{'shown': true};
      }, log: log);
      final r = await DeviceControl.overlayShow();
      expect(r.ok, isTrue);
      expect(r.message, '');
      expect(log, ['overlayShow'],
          reason: '只显示悬浮框时不该顺带动桥——桥有自己的开关');
    });

    test('无权限：ok=false，原生给的中文原因原样带出', () async {
      install((_) => <String, Object?>{
            'shown': false,
            'message': '没有悬浮窗权限',
          });
      final r = await DeviceControl.overlayShow();
      expect(r.ok, isFalse);
      expect(r.message, '没有悬浮窗权限',
          reason: '把原生给的原因吞掉，用户就只剩一个没动的开关');
    });

    test('异常：降级成 ok=false，不 throw', () async {
      install((_) => throw PlatformException(code: 'err'));
      final r = await DeviceControl.overlayShow();
      expect(r.ok, isFalse);
      expect(r.message, isNotEmpty,
          reason: '异常也要留一句可展示的兜底文案');
    });

    test('旧形状（没有 shown 键）：判 false，不崩', () async {
      // 旧版原生侧只回一个空 Map。此时不能默认成功——那会让开关显示成
      // 「已显示」而屏上什么都没有。
      install((_) => <Object?>{});
      final r = await DeviceControl.overlayShow();
      expect(r.ok, isFalse);
    });

    test('回 null：判 false，不崩', () async {
      install((_) => null);
      final r = await DeviceControl.overlayShow();
      expect(r.ok, isFalse);
      expect(r.message, '原生侧没有返回结果');
    });
  });

  group('overlayHide', () {
    test('成功：ok=true', () async {
      final log = <String>[];
      install((call) {
        expect(call.method, 'overlayHide');
        return <String, Object?>{'hidden': true};
      }, log: log);
      final r = await DeviceControl.overlayHide();
      expect(r.ok, isTrue);
      expect(log, ['overlayHide'],
          reason: '只隐藏悬浮框时不该顺带停桥');
    });

    test('失败：原因原样带出', () async {
      install((_) => <String, Object?>{
            'hidden': false,
            'message': '悬浮框服务已不在运行',
          });
      final r = await DeviceControl.overlayHide();
      expect(r.ok, isFalse);
      expect(r.message, '悬浮框服务已不在运行');
    });

    test('异常：降级成 ok=false，不 throw', () async {
      install((_) => throw PlatformException(code: 'err'));
      final r = await DeviceControl.overlayHide();
      expect(r.ok, isFalse);
    });

    test('旧形状（没有 hidden 键）：判 false', () async {
      install((_) => <Object?>{});
      final r = await DeviceControl.overlayHide();
      expect(r.ok, isFalse);
    });
  });

  group('bridgeStart / bridgeStop', () {
    test('bridgeStart 成功走 started 键', () async {
      final log = <String>[];
      install((call) {
        expect(call.method, 'bridgeStart');
        return <String, Object?>{'started': true};
      }, log: log);
      final r = await DeviceControl.bridgeStart();
      expect(r.ok, isTrue);
      expect(r.message, '');
      expect(log, ['bridgeStart']);
    });

    test('bridgeStop 成功走 stopped 键', () async {
      final log = <String>[];
      install((call) {
        expect(call.method, 'bridgeStop');
        return <String, Object?>{'stopped': true};
      }, log: log);
      final r = await DeviceControl.bridgeStop();
      expect(r.ok, isTrue);
      expect(log, ['bridgeStop']);
    });

    test('bridgeStart 失败：原因原样带出', () async {
      install((_) => <String, Object?>{
            'started': false,
            'message': '通知权限被拒，前台服务起不来',
          });
      final r = await DeviceControl.bridgeStart();
      expect(r.ok, isFalse);
      expect(r.message, '通知权限被拒，前台服务起不来');
    });

    test('bridgeStop 失败：原因原样带出', () async {
      install((_) => <String, Object?>{
            'stopped': false,
            'message': '服务已停止',
          });
      final r = await DeviceControl.bridgeStop();
      expect(r.ok, isFalse);
      expect(r.message, '服务已停止');
    });

    test('异常：降级成 ok=false，不 throw', () async {
      install((_) => throw PlatformException(code: 'timeout'));
      expect((await DeviceControl.bridgeStart()).ok, isFalse);
      expect((await DeviceControl.bridgeStop()).ok, isFalse);
    });

    test('旧形状（没有 started/stopped 键）：判 false', () async {
      install((_) => <Object?>{});
      expect((await DeviceControl.bridgeStart()).ok, isFalse);
      expect((await DeviceControl.bridgeStop()).ok, isFalse);
    });

    test('四个方法的键名互不串门：shown 不能当成 started', () async {
      // 这一族共用一个私有收口，键名是唯一区分成功与否的依据。若哪一天把
      // 键名写死成同一个，四个方法会同时「成功」或同时「失败」，而真机上
      // 的表现是「关悬浮框的结果把桥也停了」。
      install((call) {
        switch (call.method) {
          case 'bridgeStart':
            return <String, Object?>{'shown': true};
          case 'overlayShow':
            return <String, Object?>{'started': true};
          default:
            return <Object?>{};
        }
      });
      expect((await DeviceControl.bridgeStart()).ok, isFalse,
          reason: 'bridgeStart 只看 started，别的方法的布尔键不算数');
      expect((await DeviceControl.overlayShow()).ok, isFalse,
          reason: 'overlayShow 只看 shown');
    });
  });
}
