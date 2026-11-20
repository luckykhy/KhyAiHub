import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_sanitize.dart';

/// Sanitize/truncate pins. Two of these guard against copying the wrong
/// precedent: ragTruncate's normalizeSpace (which would flatten multi-line
/// bodies) and a path pattern loose enough to eat prose.
void main() {
  group('amooMirrorSanitizeText — 凭据形态', () {
    test('Bearer 令牌 → [已脱秘]', () {
      expect(
        amooMirrorSanitizeText('Authorization: Bearer abcdefghijklmnopqrst'),
        contains('[已脱秘]'),
      );
      expect(
        amooMirrorSanitizeText('Authorization: Bearer abcdefghijklmnopqrst'),
        isNot(contains('abcdefghijklmnopqrst')),
      );
    });

    test('sk- 令牌 → [已脱秘]', () {
      final out = amooMirrorSanitizeText('用 sk-abcdef123456 调用');
      expect(out, contains('[已脱秘]'));
      expect(out, isNot(contains('sk-abcdef123456')));
    });

    test('短凭据串（不足 8 位）不误伤', () {
      // 判据抄 amoo_approval.dart:155-156：{8,} 与 {4,} 是那里的长度门
      expect(amooMirrorSanitizeText('Bearer short'), contains('Bearer short'));
    });
  });

  group('amooMirrorSanitizeText — 绝对路径', () {
    test('Unix 绝对路径 → [路径]', () {
      expect(
        amooMirrorSanitizeText('日志在 /data/user/0/com.khyos.khy_os_client/files/x.log'),
        contains('[路径]'),
      );
      expect(
        amooMirrorSanitizeText('日志在 /data/user/0/com.khyos.khy_os_client/files/x.log'),
        isNot(contains('/data/user/0')),
      );
    });

    test('Windows 盘符路径与 UNC → [路径]', () {
      expect(
        amooMirrorSanitizeText('配置在 C:\\Users\\25789\\AppData\\x.json'),
        contains('[路径]'),
      );
      expect(
        amooMirrorSanitizeText('共享在 \\\\server\\share\\a.txt'),
        contains('[路径]'),
      );
    });

    test('正常行文不误伤：URL、/v1 后缀、中文行文', () {
      // URL 的路径段对路径正则也长得像绝对路径，必须整体跳过
      expect(
        amooMirrorSanitizeText('端点 http://127.0.0.1:8931/v1/chat/completions'),
        contains('http://127.0.0.1:8931/v1/chat/completions'),
      );
      expect(amooMirrorSanitizeText('OpenAI 兼容层挂在 /v1 下'), contains('/v1 下'));
      expect(amooMirrorSanitizeText('读/写 权限已获取'), '读/写 权限已获取');
      expect(amooMirrorSanitizeText('输入/输出 都要看'), '输入/输出 都要看');
      // 日期与比例不是路径
      expect(amooMirrorSanitizeText('截止 12/31/2024，进度 3/4'), '截止 12/31/2024，进度 3/4');
    });

    test('幂等：跑两遍结果一致', () {
      const raw = 'Bearer abcdefghijklmnop 写到了 /data/user/0/x/y.log '
          '见 http://127.0.0.1:8931/v1';
      final once = amooMirrorSanitizeText(raw);
      expect(amooMirrorSanitizeText(once), once);
    });
  });

  group('amooMirrorTruncate', () {
    test('正好 800 不截', () {
      final text = '啊' * 800;
      final result = amooMirrorTruncate(text);
      expect(result.truncated, isFalse);
      expect(result.text, text);
    });

    test('799 不截', () {
      final result = amooMirrorTruncate('x' * 799);
      expect(result.truncated, isFalse);
    });

    test('801 截，保留前 800 + 省略标记', () {
      final text = 'x' * 801;
      final result = amooMirrorTruncate(text);
      expect(result.truncated, isTrue);
      expect(result.text, '${'x' * 800}…');
    });

    test('多行正文截断后换行保留（不压平）', () {
      // ragTruncate 第一步 normalizeSpace 会把空白压成一个空格；镜像刻意不抄
      final text = '第一行\n第二行\n${'第三行' * 400}';
      final result = amooMirrorTruncate(text);
      expect(result.truncated, isTrue);
      expect(result.text, contains('\n'));
      expect(result.text.split('\n').length, greaterThan(2));
      // 前 800 字符逐字保留
      expect(result.text.startsWith('第一行\n第二行\n第三行'), isTrue);
    });

    test('自定义 maxChars 生效', () {
      final result = amooMirrorTruncate('abcdefg', maxChars: 3);
      expect(result.truncated, isTrue);
      expect(result.text, 'abc…');
    });

    test('代理对边界不切出半个 surrogate', () {
      // U+1F600（😀）是代理对；正好落在截断点上时宁短一个字符
      final text = '${'x' * 799}😀tail';
      final result = amooMirrorTruncate(text);
      expect(result.truncated, isTrue);
      final last = result.text.codeUnitAt(result.text.length - 2); // 省略号前一个单元
      expect(last >= 0xD800 && last <= 0xDBFF, isFalse,
          reason: '截断点落成了高代理');
    });
  });

  group('amooMirrorOneLine', () {
    test('多行摘要归一为一行', () {
      expect(
        amooMirrorOneLine('第一行\n  第二行\t第三行  '),
        '第一行 第二行 第三行',
      );
    });

    test('空串返回空串', () {
      expect(amooMirrorOneLine('   \n  '), '');
    });
  });
}
