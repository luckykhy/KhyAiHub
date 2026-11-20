import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/builtin_tools.dart';

/// The system prompt must not advertise a tool that does not exist.
///
/// WHY THIS TEST EXISTS. For a while the chat screen's system prompt listed
/// `a11y_tap / a11y_swipe / a11y_type_text` as one line — and `a11y_swipe` was
/// never registered. The symptom is not a crash: the model reads the prompt,
/// believes the tool exists, calls it, gets "unknown tool", and tries again.
/// Nothing in any log says the prompt is wrong, and the failure looks like the
/// model being confused.
///
/// So this is a consistency check between two files that have no reason to be
/// edited together: the prompt is hand-written prose, the registry is code.
/// Every tool named in the prompt's tool section must be in the registry.
///
/// WHY THE SCAN IS LIMITED TO THE `## 可用工具` BLOCK. The prompt also names
/// tools in its rules section ("用 list_files 列出"), in prose, and in Chinese.
/// Scanning the whole file would produce false positives on ordinary words;
/// scanning only the tool catalogue, where every line is a `###` header, a
/// `- name: description` bullet, or blank, makes the extraction unambiguous.
void main() {
  group('the system prompt only names tools that exist', () {
    test('every tool in the 可用工具 section is registered', () {
      final source = _readPromptSource();
      final named = _toolsNamedInPrompt(source);
      final registered =
          createBuiltinTools().map((t) => t.name).toSet();

      expect(named, isNotEmpty,
          reason: '没从提示词里解析出任何工具名——不是"没问题"，是解析坏了');

      final missing = named.where((n) => !registered.contains(n)).toList();
      expect(missing, isEmpty,
          reason: '系统提示词宣传了这些并不存在的工具，模型会一次次调它们然后失败：\n'
              '  ${missing.join('\n  ')}\n'
              '要么把工具注册进 createBuiltinTools()，要么从提示词里删掉。');
    });

    test('the vision tools are in the prompt, because they are the answer to '
        '"I cannot operate the interface"', () {
      // The point of the vision tools is that a text-only model can be told
      // they exist. If they drop out of the prompt, the model goes back to
      // answering "I cannot interact with the interface" — which is false and
      // is the exact failure the bridge exists to prevent.
      final source = _readPromptSource();
      final named = _toolsNamedInPrompt(source);
      expect(named, contains('vision_locate'));
      expect(named, contains('vision_tap'));
    });

    test('a11y_swipe is in the prompt AND registered', () {
      // The specific pair that was broken. Both halves are asserted because
      // fixing it by deleting the line from the prompt would also pass the
      // first test while losing a capability the bridge actually has.
      final named = _toolsNamedInPrompt(_readPromptSource());
      final registered =
          createBuiltinTools().map((t) => t.name).toSet();
      expect(named, contains('a11y_swipe'), reason: '提示词里没有 a11y_swipe');
      expect(registered, contains('a11y_swipe'), reason: '注册表里没有 a11y_swipe');
    });

    test('the extraction is not silently matching nothing', () {
      // A regex that quietly stops matching would turn the guard above into a
      // green no-op. This pins the mechanism itself.
      final source = _readPromptSource();
      final named = _toolsNamedInPrompt(source);
      expect(named.length, greaterThan(10),
          reason: '只解析出 ${named.length} 个工具名， extraction 很可能坏了');
      // The multi-name bullet must be split, not kept as one blob.
      expect(named, contains('read_clipboard'));
      expect(named, contains('write_clipboard'));
      expect(named, isNot(contains('read_clipboard / write_clipboard')));
    });
  });
}

/// Read the file that builds the system prompt.
String _readPromptSource() {
  final f = File('lib/ui/screens/chat_screen_new.dart');
  expect(f.existsSync(), true,
      reason: '这条测试必须从 App 目录跑（cwd 不对时会静默通过）');
  return f.readAsStringSync();
}

/// Tool names listed in the prompt's `## 可用工具` block.
///
/// Recognises `- name: description` bullets and splits the `/`-separated
/// variants (`- read_clipboard / write_clipboard: 剪贴板`). Headers, blank
/// lines and indented continuation lines are skipped by the shape of the
/// match rather than by a blocklist, so a new bullet style fails the
/// "parsed nothing" guard instead of being silently dropped.
Set<String> _toolsNamedInPrompt(String source) {
  final lines = source.split('\n');
  var inBlock = false;
  final names = <String>{};

  for (final line in lines) {
    if (line.contains("'## 可用工具'")) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.contains("'## ")) break;

    if (!inBlock) continue;

    // `    buf.writeln('- open_app: 打开任意应用（中文名/包名/URL 均可）');`
    final m = RegExp(r"writeln\('- ([a-z0-9_]+(?: / [a-z0-9_]+)*): ").firstMatch(line);
    if (m == null) continue;
    for (final n in m.group(1)!.split(' / ')) {
      names.add(n.trim());
    }
  }
  return names;
}
