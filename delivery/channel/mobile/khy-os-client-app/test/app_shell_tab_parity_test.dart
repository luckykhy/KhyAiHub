import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 页签表的三处数组必须条数一致，底部导航不能写死 destination 个数。
///
/// WHY THIS FILE EXISTS. `main.dart` 用一张页签表驱动四个投影：`_tabTitles`
/// （标签）、`_tabIcons` / `_tabSelectedIcons` （图标）、`screens` （IndexedStack
/// 的孩子）。2026-11 控制台作为第 2 个页签插进来时，前三处都改成了 6 条，唯独
/// 底部导航的 `for (var i = 0; i < 5; i++)` 没跟着改——于是「设置」页在
/// screens 里活着、却渲染不出 destination，用户根本点不到它。
///
/// 这个失效在 code review 里看不出来：每一行单看都合理，只有把四个投影放在一起
/// 数条数才会暴露。所以这里做源码级配平断言：不渲染 UI（那要 mock 网关、门禁和
/// 共享存储），只查这张表的四个投影条数相同、循环上界不是字面量。
void main() {
  final src = File('lib/main.dart').readAsStringSync();

  /// 取 `header` 起到第一个 `];` 之间的数组体。
  String arrayBody(String header) {
    final start = src.indexOf(header);
    expect(start, greaterThan(-1),
        reason: 'main.dart 里找不到 $header——页签表被改名或重构了，'
            '这个守卫要跟着改，不能悄悄失效');
    final end = src.indexOf('];', start);
    expect(end, greaterThan(start), reason: '$header 没有收尾的 ];');
    return src.substring(start + header.length, end);
  }

  /// 数一维数组里的顶层条目数。先剥掉注释，否则注释里的逗号会被当成条目
  /// 分隔符——本文件的注释量不小，这个坑真会踩。
  ///
  /// 尾逗号要单独算：Dart 数组写成 6 个条目带 6 个逗号是常态（dart format 的
  /// 产物），直接 `commas + 1` 会把 6 数成 7。判据是最后一个逗号之后还有没有
  /// 非空白内容。
  int topLevelEntries(String arrayText) {
    final noBlock = arrayText.replaceAll(
      RegExp(r'/\*.*?\*/', dotAll: true),
      '',
    );
    final noLine = noBlock.replaceAll(RegExp(r'//[^\n]*'), '');
    var depth = 0;
    var commas = 0;
    var lastComma = -1;
    for (var i = 0; i < noLine.length; i++) {
      final c = noLine[i];
      if (c == '[' || c == '(' || c == '{') depth++;
      if (c == ']' || c == ')' || c == '}') depth--;
      if (c == ',' && depth == 1) {
        commas++;
        lastComma = i;
      }
    }
    final tail = noLine.substring(lastComma + 1).trim();
    return commas + (tail.isEmpty ? 0 : 1);
  }

  test('页签表四个投影条数一致（标题/图标/选中图标/屏幕）', () {
    final titles = RegExp(r"'[^']*'").allMatches(arrayBody('static const _tabTitles = [')).length;
    final icons = RegExp(r'Icons\.').allMatches(arrayBody('static const _tabIcons = [')).length;
    final selected =
        RegExp(r'Icons\.').allMatches(arrayBody('static const _tabSelectedIcons = [')).length;

    final screensStart = src.indexOf('final screens = [');
    expect(screensStart, greaterThan(-1), reason: 'main.dart 里找不到 screens 数组');
    final screensEnd = src.indexOf('\n    ];', screensStart);
    expect(screensEnd, greaterThan(screensStart), reason: 'screens 数组没有收尾');
    final screens = topLevelEntries(src.substring(screensStart, screensEnd));

    expect(titles, greaterThan(0), reason: '一条标题都没解析到，是解析坏了不是表坏了');
    expect(icons, titles,
        reason: '_tabIcons 有 $icons 条、_tabTitles 有 $titles 条——页签表配平坏了');
    expect(selected, titles,
        reason: '_tabSelectedIcons 有 $selected 条、_tabTitles 有 $titles 条');
    expect(screens, titles,
        reason: 'screens 有 $screens 个孩子、_tabTitles 有 $titles 条——'
            'IndexedStack 会出现「有页面没页签」或反过来');
  });

  test('底部导航 destination 数跟着页签表走，不写死字面量', () {
    final start = src.indexOf('destinations: [');
    expect(start, greaterThan(-1), reason: 'main.dart 里找不到 destinations');
    final end = src.indexOf('\n          ],', start);
    expect(end, greaterThan(start), reason: 'destinations 块没有收尾');
    final block = src.substring(start, end);

    expect(block.contains('_tabTitles.length'), isTrue,
        reason: 'destination 循环没有用 _tabTitles.length 作上界——'
            '加页签时这里不会跟着动，2026-11 就这么把「设置」页弄丢过');
    expect(RegExp(r'i < \d').hasMatch(block), isFalse,
        reason: 'destination 循环上界是写死的数字，页签表再加一条就又对不上了');
  });
}
