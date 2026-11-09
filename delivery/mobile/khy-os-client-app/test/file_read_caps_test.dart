import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:khy_os_client/core/services/file_service.dart';

/// 批量读取上限与截断明示的回归测试。
///
/// 背景（AMOO-GUIDELINES.md §4.6）：Amoo 的红线禁止它用 ls/find/exec 静默批量导出
/// 用户数据，而且明说"判定是最终读到了什么，不是调了哪个接口"。khy-os 的桥恰好有
/// ls/read 且作用范围正是 /sdcard——工具在**我们**手里执行，它的规则管不到我们。
/// 所以上限必须由我们自己设，这不是帮它，是不给它一条我们替它破线的路。
///
/// 而比上限更要紧的是**截断必须显式**：原来 `ls` 到 2000 条静默 break、
/// `read` 到 max 静默停，调用方拿到一份看起来完整、实际被砍过的结果，且无法知道。
/// 一个看起来完整的部分结果比明确的错误更糟——错误会促使排查，部分结果会被当成结论。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');

  void mock(Object? Function(MethodCall call, Map<String, Object?> args) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      final a = call.arguments;
      return handler(call, a is Map ? Map<String, Object?>.from(a) : const {});
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group('list_files 的截断明示', () {
    test('原生给 truncated=true 时，工具文案说清"显示 N/总共 M"', () async {
      mock((call, args) => <Object, Object?>{
            'success': true,
            'path': 'DCIM',
            'files': <Object>[
              <Object, Object?>{'name': 'a.jpg', 'isDir': false, 'size': 1},
              <Object, Object?>{'name': 'b.jpg', 'isDir': false, 'size': 2},
            ],
            'count': 2,
            'truncated': true,
            'total': 1843,
            'cap': 200,
          });

      final r = await FileService.listFiles('DCIM');
      expect(r['truncated'], true);
      expect(r['total'], 1843);
      expect(r['count'], 2,
          reason: 'count 必须是实际返回的条数，不能是总数——否则分不清');
    });

    test('没截断时 truncated=false 且 total==count', () async {
      mock((call, args) => <Object, Object?>{
            'success': true,
            'files': <Object>[
              <Object, Object?>{'name': 'a.jpg', 'isDir': false, 'size': 1},
            ],
            'count': 1,
            'truncated': false,
            'total': 1,
            'cap': 200,
          });
      final r = await FileService.listFiles('.');
      expect(r['truncated'], false);
      expect(r['total'], r['count']);
    });

    test('旧原生壳不返回 truncated 时，缺省按未截断', () async {
      // 保守方向的选择：旧壳没有这个字段。缺省 false 意味着"我们认为看全了"，
      // 这不对——但缺省 true 会让每次列举都报截断，等于把字段变噪音。
      // 真正的修法是让原生层一定返回它；这里只固定缺省行为不漂。
      mock((call, args) => <Object, Object?>{
            'success': true,
            'files': <Object>[],
            'count': 0,
          });
      final r = await FileService.listFiles('.');
      expect(r['truncated'], isNot(true));
    });
  });

  group('read_file 的截断明示', () {
    test('原生层截断（文件 > 256KB）带 truncated=true', () async {
      mock((call, args) => <Object, Object?>{
            'success': true,
            'content': 'x' * 1000,
            'size': 900000,
            'truncated': true,
            'cap': 262144,
          });
      final r = await FileService.readFile('big.bin');
      expect(r['truncated'], true);
      expect(r['size'], 900000,
          reason: 'size 是文件真实大小，必须和 content 长度分开');
    });

    test('小文件不标截断', () async {
      mock((call, args) => <Object, Object?>{
            'success': true,
            'content': 'hello',
            'size': 5,
            'truncated': false,
            'cap': 262144,
      });
      final r = await FileService.readFile('a.txt');
      expect(r['truncated'], false);
    });
  });

  group('通道异常不吞成空结果', () {
    test('list 抛异常时 success=false 且带 error', () async {
      mock((call, args) => throw PlatformException(code: 'boom'));
      final r = await FileService.listFiles('.');
      expect(r['success'], false);
      expect(r['error'], isNotNull);
    });

    test('read 抛异常时 success=false 且带 error', () async {
      mock((call, args) => throw PlatformException(code: 'boom'));
      final r = await FileService.readFile('a.txt');
      expect(r['success'], false);
      expect(r['error'], isNotNull);
    });
  });
}
