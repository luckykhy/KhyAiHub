// 红绿 diff 行模型：APK 侧重新实现的判据测试。
//
// 为什么值得测：
//   1. 它是**重新实现**——`runtime/node/backend/src/cli/writeDiffRows.js` 是
//      三端（后端/桌面/网页）共用的唯一生产者，APK 是独立进程、不连那条链，
//      只能按同一份契约（[DESIGN-ARCH-157]）自己算一次。两边算错一点，
//      用户在手机上看到的 diff 就和桌面上不一样，而没有任何机制会发现。
//   2. 它有真实消费方（tool_card / agent_screen_new / chat_screen_new），
//      不是死代码。
//   3. 它此前**零测试**——全 lib/ 扫「没有测试引用」时捞出来的纯逻辑之一。
//
// 钉住的不变量：
//   1. 无变化 → null（不画一个空 diff 框）；
//   2. 新文件 → 全 add；删文件 → 全 del；
//   3. 改一行 → 前后各 3 行上下文 + 1 del + 1 add（契约：3 行上下文）；
//   4. 两处相距远的改动 → 中间折成**一条** gap，行数是真实未改行数；
//   5. added / removed 计数与行内容一致；
//   6. 行尾换行不产生幽灵空行（"a\nb\n" 与 "a\nb" 同结果）；
//   7. 超过行数上限 → 截断 + more 行 + truncated=true；
//   8. 行号口径：del 带旧号，add 带新号。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/write_diff.dart';

void main() {
  WriteDiff? build(String before, String after) =>
      WriteDiffBuilder.build(filePath: 'a.txt', before: before, after: after);

  List<String> texts(WriteDiff d) => d.rows.map((WriteDiffRow r) => r.text).toList();
  List<String> kinds(WriteDiff d) => d.rows.map((WriteDiffRow r) => r.kind).toList();

  group('无变化', () {
    test('前后相同返回 null', () {
      expect(build('a\nb\n', 'a\nb\n'), isNull);
    });

    test('只有行尾换行差异也算无变化', () {
      // "a\nb\n" 与 "a\nb" 拆出来的行表相同——不该画出一个空 diff。
      expect(build('a\nb\n', 'a\nb'), isNull);
    });

    test('两者都空也返回 null', () {
      expect(build('', ''), isNull);
    });
  });

  group('单边改动', () {
    test('新文件全是 add 行', () {
      final d = build('', 'one\ntwo\nthree')!;
      expect(kinds(d), <String>['add', 'add', 'add']);
      expect(d.added, 3);
      expect(d.removed, 0);
      expect(texts(d), <String>['one', 'two', 'three']);
    });

    test('删文件全是 del 行', () {
      final d = build('one\ntwo\nthree', '')!;
      expect(kinds(d), <String>['del', 'del', 'del']);
      expect(d.added, 0);
      expect(d.removed, 3);
    });

    test('单边改动也遵守行数上限', () {
      final many = List<String>.generate(500, (int i) => 'line $i').join('\n');
      final d = build('', many)!;
      expect(d.truncated, isTrue);
      expect(d.rows.last.kind, 'more');
      // 上限 300 行 + 1 行 more 标记。
      expect(d.rows.length, 301);
    });
  });

  group('改一行：3 行上下文', () {
    test('前后各 3 行上下文，中间 1 del + 1 add', () {
      final before = List<String>.generate(10, (int i) => 'L${i + 1}').join('\n');
      final after = List<String>.generate(10, (int i) => i == 4 ? 'CHANGED' : 'L${i + 1}')
          .join('\n');
      final d = build(before, after)!;

      expect(d.added, 1);
      expect(d.removed, 1);
      // 契约是「前后各 3 行上下文」：del 前 3 个 ctx（L2/L3/L4），
      // add 后 3 个 ctx（L6/L7/L8）；L1 与 L9/L10 折成 gap。
      expect(
        kinds(d),
        <String>['gap', 'ctx', 'ctx', 'ctx', 'del', 'add', 'ctx', 'ctx', 'ctx', 'gap'],
      );
      expect(d.rows[3].text, 'L4');
      expect(d.rows[4].kind, 'del');
      expect(d.rows[4].text, 'L5');
      expect(d.rows[5].kind, 'add');
      expect(d.rows[5].text, 'CHANGED');
      // 前面的 gap 是第 1 行（L1），后面是 L9/L10 两行。
      expect(d.rows[0].text, contains('1 行未改动'));
      expect(d.rows[9].text, contains('2 行未改动'));
    });

    test('文件太短时上下文自然变少，不越界', () {
      final d = build('a\nb', 'a\nX')!;
      // 只有 3 个 op：eq(a)、del(b)、add(X)。keep 覆盖全部，没有 gap。
      expect(kinds(d), <String>['ctx', 'del', 'add']);
      expect(d.added, 1);
      expect(d.removed, 1);
    });
  });

  group('多处改动折成一条 gap', () {
    test('两处相距远的改动，中间折成一条且行数真实', () {
      final before = List<String>.generate(30, (int i) => 'L${i + 1}').join('\n');
      final after = List<String>.generate(
        30,
        (int i) => i == 1 ? 'X2' : (i == 27 ? 'X28' : 'L${i + 1}'),
      ).join('\n');
      final d = build(before, after)!;

      expect(d.added, 2);
      expect(d.removed, 2);
      final gapRows = d.rows.where((WriteDiffRow r) => r.kind == 'gap').toList();
      expect(gapRows, hasLength(1), reason: '两处改动之间只能有一条 gap');
      // keep 区间是 [0..5] 与 [25..31]，未保留的索引 6..24 共 19 行。
      expect(gapRows.single.text, contains('19 行未改动'));
    });

    test('三处改动有两条 gap', () {
      final before = List<String>.generate(40, (int i) => 'L${i + 1}').join('\n');
      final after = List<String>.generate(
        40,
        (int i) => switch (i) {
          2 => 'A',
          20 => 'B',
          37 => 'C',
          _ => 'L${i + 1}',
        },
      ).join('\n');
      final d = build(before, after)!;
      expect(d.added, 3);
      expect(d.removed, 3);
      expect(d.rows.where((WriteDiffRow r) => r.kind == 'gap').length, 2);
    });
  });

  group('行号口径（与参考实现对齐）', () {
    test('del 只带旧行号，add 带新行号且 numNew 同值，ctx 两个都带', () {
      // 口径对齐 utils/diff/structuredHunks.js 的 dual gutter：
      //   del → num  only；add → num = numNew = 新行号；ctx → 两个都带。
      // 消费方 tool_card 是 `isAdd ? (numNew ?? num) : num`，所以下面这些
      // 字段怎么填都不改变显示值——钉的是**线上契约**，让「三端口径一致」
      // 这句话是真的。
      final before = 'a\nb\nc';
      final after = 'a\nB\nc';
      final d = build(before, after)!;
      final del = d.rows.firstWhere((WriteDiffRow r) => r.kind == 'del');
      final add = d.rows.firstWhere((WriteDiffRow r) => r.kind == 'add');
      final ctx = d.rows.firstWhere((WriteDiffRow r) => r.kind == 'ctx');

      expect(del.num, 2, reason: 'del 的 num 是旧文件行号');
      expect(del.numNew, isNull, reason: 'del 没有新文件行号');
      expect(add.num, 2, reason: 'add 的 num 也是新文件行号（dual gutter）');
      expect(add.numNew, 2);
      expect(ctx.num, 1);
      expect(ctx.numNew, 1);
    });

    test('新文件路径的 add 行只带 num，不带 numNew', () {
      // 与 writeDiffRows.js 的 new-file 分支对齐（单列行号）。
      final d = build('', 'x\ny')!;
      for (var i = 0; i < d.rows.length; i++) {
        expect(d.rows[i].num, i + 1);
        expect(d.rows[i].numNew, isNull);
      }
    });

    test('删文件路径的 del 行只带 num', () {
      final d = build('x\ny', '')!;
      for (var i = 0; i < d.rows.length; i++) {
        expect(d.rows[i].num, i + 1);
        expect(d.rows[i].numNew, isNull);
      }
    });
  });

  group('截断', () {
    test('超过行数上限时截断并如实报告少了多少行', () {
      // 500 行全改 → 500 del + 500 add = 1000 行，远超 300 上限。
      final before = List<String>.generate(500, (int i) => 'old $i').join('\n');
      final after = List<String>.generate(500, (int i) => 'new $i').join('\n');
      final d = build(before, after)!;

      expect(d.truncated, isTrue);
      expect(d.rows.last.kind, 'more');
      expect(d.rows.length, 301, reason: '300 行内容 + 1 行 more 标记');
      expect(d.rows.last.text, contains('700 行未显示'));
      // 计数仍然是全量事实，不因截断而少算。
      expect(d.added, 500);
      expect(d.removed, 500);
    });

    test('文件行数超限时走「整段删 + 整段加」并标记截断', () {
      // _maxLines = 1500：任一侧超过就放弃逐行 diff。
      final big = List<String>.generate(1600, (int i) => 'x $i').join('\n');
      final d = build(big, big.replaceAll('x ', 'y '))!;
      expect(d.truncated, isTrue);
      expect(kinds(d).last, 'more');
      // 整段删 + 整段加，各取上限的一半。
      expect(d.rows.where((WriteDiffRow r) => r.kind == 'del').length, 150);
      expect(d.rows.where((WriteDiffRow r) => r.kind == 'add').length, 150);
    });
  });

  group('fromMetadata', () {
    test('没有 writeDiff 键时返回 null', () {
      expect(WriteDiffBuilder.fromMetadata(null), isNull);
      expect(WriteDiffBuilder.fromMetadata(<String, dynamic>{}), isNull);
      expect(
        WriteDiffBuilder.fromMetadata(<String, dynamic>{'writeDiff': 'not a map'}),
        isNull,
      );
    });

    test('从 metadata 取出前后原文并构建', () {
      final d = WriteDiffBuilder.fromMetadata(<String, dynamic>{
        'writeDiff': <String, dynamic>{
          'filePath': 'src/a.txt',
          'before': 'a\nb',
          'after': 'a\nB',
        },
      })!;
      expect(d.filePath, 'src/a.txt');
      expect(d.added, 1);
      expect(d.removed, 1);
    });

    test('缺 before/after 时按空串处理（新文件 / 删文件）', () {
      final newFile = WriteDiffBuilder.fromMetadata(<String, dynamic>{
        'writeDiff': <String, dynamic>{'filePath': 'n.txt', 'after': 'hello'},
      })!;
      expect(newFile.added, 1);
      expect(newFile.removed, 0);
    });
  });

  group('行拆分', () {
    test('行尾换行不产生幽灵空行', () {
      final withTrailing = build('a\nb\nc\n', 'a\nB\nc\n')!;
      final without = build('a\nb\nc', 'a\nB\nc')!;
      expect(texts(withTrailing), texts(without));
    });

    test('中间的空行是真实内容，要保留', () {
      final d = build('a\n\nc', 'a\n\nC')!;
      expect(d.removed, 1);
      expect(d.rows.any((WriteDiffRow r) => r.text.isEmpty && r.kind == 'ctx'), isTrue);
    });
  });
}
