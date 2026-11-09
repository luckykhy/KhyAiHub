// 应用数据浏览器：结构化解析的判据测试。
//
// 这层解析的价值全在「解析得对不对」——SharedPreferences 与 JSON 的格式都是
// 固定的，解析规则写死就能测死；测不住的话，用户看到的就是一张空表，
// 而他没法区分「这个 App 没配过」和「我解析错了」。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/app_data_browser.dart';

void main() {
  group('SharedPreferences 解析', () {
    const xml = '''
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="nickname">Khy</string>
    <int name="launchCount" value="42" />
    <long name="lastSync" value="1700000000000" />
    <float name="scale" value="0.75" />
    <boolean name="darkMode" value="true" />
    <set name="tags">
        <string>alpha</string>
        <string>beta</string>
    </set>
</map>
''';

    test('解析出全部键值', () {
      final entries = AppDataBrowser.parseSharedPreferences(xml);
      expect(entries, hasLength(6));

      final byKey = <String, ConfigEntry>{
        for (final entry in entries) entry.key: entry,
      };
      expect(byKey['nickname']!.value, 'Khy');
      expect(byKey['launchCount']!.value, '42');
      expect(byKey['lastSync']!.value, '1700000000000');
      expect(byKey['scale']!.value, '0.75');
      expect(byKey['darkMode']!.value, 'true');
    });

    test('类型被保留', () {
      final entries = AppDataBrowser.parseSharedPreferences(xml);
      final byKey = <String, ConfigEntry>{
        for (final entry in entries) entry.key: entry,
      };
      expect(byKey['launchCount']!.type, 'int');
      expect(byKey['darkMode']!.type, 'boolean');
      expect(byKey['nickname']!.type, 'string');
      expect(byKey['tags']!.type, 'set');
    });

    test('集合的内部项不会被当成顶层条目', () {
      final entries = AppDataBrowser.parseSharedPreferences(xml);
      // alpha / beta 是 tags 集合的成员，不是独立键
      expect(entries.any((ConfigEntry e) => e.key == 'alpha'), isFalse);
      final tags = entries.firstWhere((ConfigEntry e) => e.key == 'tags');
      expect(tags.value, 'alpha, beta');
    });

    test('空 map 返回空列表', () {
      expect(AppDataBrowser.parseSharedPreferences('<map></map>'), isEmpty);
    });

    test('不是 XML 时不抛异常，返回空列表', () {
      expect(AppDataBrowser.parseSharedPreferences('乱七八糟'), isEmpty);
    });
  });

  group('JSON 解析', () {
    test('嵌套对象用点号展开', () {
      final entries = AppDataBrowser.parseJsonConfig(
        '{"server":{"url":"https://khyos.cn","port":443},"name":"khy"}',
      );
      final byKey = <String, ConfigEntry>{
        for (final entry in entries) entry.key: entry,
      };
      expect(byKey['server.url']!.value, 'https://khyos.cn');
      expect(byKey['server.port']!.value, '443');
      expect(byKey['name']!.value, 'khy');
    });

    test('数组用下标展开', () {
      final entries = AppDataBrowser.parseJsonConfig('{"tags":["a","b"]}');
      final byKey = <String, ConfigEntry>{
        for (final entry in entries) entry.key: entry,
      };
      expect(byKey['tags[0]']!.value, 'a');
      expect(byKey['tags[1]']!.value, 'b');
    });

    test('null 值显示为 null', () {
      final entries = AppDataBrowser.parseJsonConfig('{"a":null}');
      expect(entries.single.value, 'null');
      expect(entries.single.type, 'null');
    });

    test('非法 JSON 返回空列表而不是抛异常', () {
      expect(AppDataBrowser.parseJsonConfig('{not json'), isEmpty);
    });

    test('顶层数组也能展平', () {
      final entries = AppDataBrowser.parseJsonConfig('[1,2]');
      expect(entries, hasLength(2));
      expect(entries.first.key, '[0]');
    });
  });
}
