// ScreenshotThumbnailStore 契约测试：全 fake——shrink 注入，不碰 dart:ui 解码。
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/floating/screenshot_thumbnails.dart';

/// 可控的缩略函数：记录调用的 maxWidth，按脚本回内容。
class FakeShrink {
  final calls = <int>[];
  Uint8List? next = Uint8List.fromList(const [1, 2, 3, 4]);
  int throws = 0;

  Future<Uint8List?> shrink(Uint8List raw, int maxWidth) async {
    calls.add(maxWidth);
    if (throws > 0) {
      throws--;
      throw StateError('fake shrink boom');
    }
    return next;
  }
}

void main() {
  late Directory tmp;
  late FakeShrink shrink;
  late ScreenshotThumbnailStore store;
  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('thumb-test');
    shrink = FakeShrink();
    store = ScreenshotThumbnailStore(Directory('${tmp.path}/floating/screenshots'),
        shrink: shrink.shrink);
  });
  tearDown(() {
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  test('base64 写成 png 文件并返回路径；宽度约束传给 shrink', () async {
    final path = await store.saveFromBase64('aGVsbG8='); // 'hello'
    expect(path, isNotNull);
    expect(path, startsWith(tmp.path));
    expect(path, endsWith('.png'));
    expect(File(path!).readAsBytesSync(), [1, 2, 3, 4]);
    expect(shrink.calls, [320], reason: '默认缩到 320px 宽');
  });

  test('data URL 前缀与空白被剥掉再解码', () async {
    final path = await store.saveFromBase64('data:image/jpeg;base64,aGVsbG8=');
    expect(path, isNotNull);
    expect(shrink.calls, [320]);
  });

  test('坏 base64 / 空 shrink 结果 / shrink 抛错都回 null，不落盘', () async {
    expect(await store.saveFromBase64('!!!not base64!!!'), isNull);

    shrink.next = null;
    expect(await store.saveFromBase64('aGVsbG8='), isNull);
    expect(tmp.listSync(recursive: true), isEmpty,
        reason: 'null 结果不写文件');

    shrink.next = Uint8List.fromList(const [1]);
    shrink.throws = 1;
    expect(await store.saveFromBase64('aGVsbG8='), isNull);
    expect(tmp.listSync(recursive: true), isEmpty);
  });

  test('目录里最多留 5 张，删的是最旧的', () async {
    final paths = <String>[];
    for (var i = 0; i < 7; i++) {
      final p = await store.saveFromBase64('aGVsbG8=');
      expect(p, isNotNull);
      paths.add(p!);
      // 文件 mtime 可能同毫秒重合，稍微错开，保证排序有依据。
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    final remaining = Directory('${tmp.path}/floating/screenshots')
        .listSync()
        .whereType<File>()
        .map((f) => f.path)
        .toSet();
    expect(remaining, hasLength(5));
    expect(remaining.containsAll(paths.take(2)), isFalse,
        reason: '最旧两张应被清掉');
    expect(remaining.containsAll(paths.skip(2)), isTrue);
  });
}
