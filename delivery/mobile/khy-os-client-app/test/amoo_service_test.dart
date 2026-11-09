import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:khy_os_client/core/services/amoo_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');
  var calls = <MethodCall>[];

  void mock(Object? Function(MethodCall call) handler) {
    calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return handler(call);
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group('AmooService.status', () {
    test('解析安装态与两个可解析入口', () async {
      mock((call) {
        expect(call.method, 'amooStatus');
        return {
          'installed': true,
          'versionName': '1.0.0_20261009_004501',
          'canShare': true,
          'canOpenChat': true,
          'packageName': 'com.stepos.ailauncher',
        };
      });
      final s = await AmooService.status();
      expect(s.installed, true);
      expect(s.canShare, true);
      expect(s.canOpenChat, true);
      expect(s.versionName, '1.0.0_20261009_004501');
      expect(s.unknown, false);
      expect(s.summary, contains('启动未验证'));
      expect(s.summary, isNot(contains('可分享文本')));
    });

    test('未安装时 summary 明确说未安装，不伪造可分享', () async {
      mock((_) => {'installed': false, 'canShare': false, 'canOpenChat': false});
      final s = await AmooService.status();
      expect(s.installed, false);
      expect(s.canShare, false);
      expect(s.summary, contains('未安装 amoo'));
    });

    test('通道异常 → unknown，不能误报成未安装', () async {
      mock((_) => throw PlatformException(code: 'err', message: 'no implementation'));
      final s = await AmooService.status();
      expect(s.unknown, true);
      expect(s.summary, contains('无法检测 amoo'));
      expect(s.summary, isNot(contains('未安装')));
      expect(s.errorMessage, contains('err'));
    });

    test('原生返回 message 时保留给 UI', () async {
      mock((_) => {
            'installed': false,
            'canShare': false,
            'canOpenChat': false,
            'message': 'NameNotFoundException',
          });
      final s = await AmooService.status();
      expect(s.installed, false);
      expect(s.errorMessage, 'NameNotFoundException');
      expect(s.summary, contains('无法读取 amoo 安装态'));
      expect(s.summary, contains('NameNotFoundException'));
      expect(s.summary, isNot(contains('未安装 amoo')));
    });
  });

  group('AmooService.shareText', () {
    test('直接交给 ShareActivity：只报告已受理', () async {
      mock((call) {
        expect(call.method, 'sendToAmoo');
        expect(call.arguments['text'], '你好 amoo');
        return {
          'ok': true,
          'via': 'direct',
          'truncated': false,
          'message': '已交给 amoo 分享页（未确认送达）',
        };
      });
      final r = await AmooService.shareText('  你好 amoo  ');
      expect(r.ok, true);
      expect(r.via, AmooSendVia.direct);
      expect(r.message, contains('未确认送达'));
      expect(r.message, isNot(contains('已发送')));
    });

    test('显式组件不可用时退回 chooser，仍然不声称送达', () async {
      mock((_) => {
            'ok': true,
            'via': 'chooser',
            'truncated': false,
            'message': '已打开系统分享面板，请选择 amoo（未确认送达）',
          });
      final r = await AmooService.shareText('hi');
      expect(r.ok, true);
      expect(r.via, AmooSendVia.chooser);
      expect(r.displayMessage, contains('分享面板'));
    });

    test('空文本在 Dart 侧就被拒绝，不调用通道', () async {
      mock((_) => {'ok': true, 'via': 'direct'});
      final r = await AmooService.shareText('   ');
      expect(r.ok, false);
      expect(r.via, AmooSendVia.none);
      expect(calls, isEmpty);
    });

    test('超过 4000 字时上报截断', () async {
      mock((call) {
        expect((call.arguments['text'] as String).length, 4000);
        return {'ok': true, 'via': 'direct', 'truncated': true, 'message': '已交给 amoo'};
      });
      final r = await AmooService.shareText('x' * 4500);
      expect(r.ok, true);
      expect(r.truncated, true);
      expect(r.displayMessage, contains('已截断'));
    });

    test('PlatformException 转成可展示的失败', () async {
      mock((_) => throw PlatformException(code: 'err', message: 'boom'));
      final r = await AmooService.shareText('hi');
      expect(r.ok, false);
      expect(r.via, AmooSendVia.none);
      expect(r.message, contains('boom'));
    });
  });

  group('AmooService.openChat', () {
    test('ok=true', () async {
      mock((call) {
        expect(call.method, 'openAmoo');
        return {'ok': true, 'via': 'chat'};
      });
      expect(await AmooService.openChat(), true);
    });

    test('ok=false 或异常都返回 false', () async {
      mock((_) => {'ok': false});
      expect(await AmooService.openChat(), false);
      mock((_) => throw PlatformException(code: 'err'));
      expect(await AmooService.openChat(), false);
    });
  });

  group('模型文案', () {
    test('已安装但入口解析失败时不下结论', () {
      const s = AmooStatus(installed: true, versionName: '1.0');
      expect(s.summary, contains('未解析到分享入口'));
    });

    test('AmooSendResult 只承诺投递', () {
      const r = AmooSendResult(ok: true, via: AmooSendVia.direct, message: '');
      expect(r.displayMessage, '已交给 amoo');
      expect(r.displayMessage, isNot(contains('送达')));
    });
  });
}
