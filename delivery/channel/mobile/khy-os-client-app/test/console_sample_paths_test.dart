import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/console_service.dart';

/// S5 / T15：控制台的示例参数不许再把 Download 当默认落点。
///
/// 示例值就是给 Agent 与用户照抄的：`cp` 的 dest、`zip` 的 out 指到
/// /sdcard/Download，每一条照抄的命令都在往交接目录里堆东西——而
/// install_apk 的白名单恰好认这个目录，杂物越多真包越容易被拿错。
void main() {
  ConsoleTool toolWith(List<String> required) => ConsoleTool(
        name: 'probe',
        desc: '',
        group: '',
        required: required,
        optional: const <List<String>>[],
        oneOf: const <String>[],
        needsA11y: false,
        available: true,
      );

  test('path/dest/out 的示例值不指向 /sdcard/Download', () {
    for (final req in [
      ['path'],
      ['dest'],
      ['out'],
    ]) {
      final sample = toolWith(req).sample;
      expect(sample, isNot(contains('/sdcard/Download')),
          reason: '示例值在教人往 Download 写东西：$req → $sample');
    }
  });

  test('示例值仍然是可以直接执行的合法路径', () {
    final sample = toolWith(['dest']).sample;
    expect(sample, contains('/sdcard/khy-os'),
        reason: 'khy-os 工作空间是 install_apk 的另一个白名单根，示例落在那里：$sample');
  });
}
