// 「这个文件能不能用内置编辑器改」的判据测试。
//
// 这是唯一一道挡在二进制文件和「保存即损坏」之间的判据：判宽了，用户对着
// 一个 APK 点「编辑」再保存，文件就没了；判窄了，该能改的配置改不了。
// 它原先住在 `FileManagerScreenState._isEditable`——一个 `_` 前缀的私有静态
// 方法，`test/` 目录调用不到，于是这条最要紧的安全属性一行测试都没有。
//
// 钉三件事：
//   1. **二进制一律不给编辑入口**（安全属性，写严一点）；
//   2. 目录永远不给；
//   3. 白名单扩展名大小写不敏感，且必须是**结尾**匹配。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/text_editable.dart';
import 'package:khy_os_client/core/vfs/vfs_node.dart';

void main() {
  VfsNode file(String name, {String mime = 'application/octet-stream'}) =>
      VfsNode(
        name: name,
        path: '/storage/emulated/0/$name',
        isDirectory: false,
        mime: mime,
      );

  VfsNode dir(String name) => VfsNode(
        name: name,
        path: '/storage/emulated/0/$name',
        isDirectory: true,
        mime: 'inode/directory',
      );

  group('安全属性：二进制不给编辑入口', () {
    test('常见二进制类型一律不可编辑', () {
      final binaries = <String>[
        'app.apk',
        'photo.jpg',
        'photo.png',
        'movie.mp4',
        'song.mp3',
        'archive.zip',
        'archive.tar.gz',
        'backup.7z',
        'old.rar',
        'libfoo.so',
        'app.db',
        'app.sqlite',
        'doc.pdf',
        'doc.docx',
        'sheet.xlsx',
        'deck.pptx',
        'book.epub',
        'font.ttf',
        'image.webp',
        'video.mkv',
      ];
      for (final name in binaries) {
        expect(
          TextEditable.isEditable(file(name)),
          isFalse,
          reason: '$name 是二进制，给编辑入口等于给一个必然改坏它的功能',
        );
      }
    });

    test('MIME 是 text/* 时可编辑（原生判据优先）', () {
      expect(TextEditable.isEditable(file('notes', mime: 'text/plain')), isTrue);
      expect(TextEditable.isEditable(file('page', mime: 'text/html')), isTrue);
      expect(TextEditable.isEditable(file('style', mime: 'text/css')), isTrue);
      expect(TextEditable.isEditable(file('data', mime: 'text/csv')), isTrue);
    });

    test('没有扩展名、MIME 又是二进制的，不给编辑', () {
      expect(TextEditable.isEditable(file('README')), isFalse);
      expect(TextEditable.isEditable(file('Makefile')), isFalse);
      expect(TextEditable.isEditable(file('.gitignore')), isFalse);
    });
  });

  group('目录永远不给', () {
    test('目录不可编辑，哪怕 MIME 是目录', () {
      expect(TextEditable.isEditable(dir('Documents')), isFalse);
    });

    test('名字以文本扩展名结尾的目录也不给', () {
      // 「config.txt」这么一个目录名不该让它变得可编辑——目录没有内容可改。
      expect(TextEditable.isEditable(dir('config.txt')), isFalse);
    });
  });

  group('白名单扩展名', () {
    test('清单里的每一种都可编辑', () {
      for (final ext in TextEditable.extensions) {
        final name = 'sample$ext';
        expect(
          TextEditable.isEditable(file(name)),
          isTrue,
          reason: '$name 在白名单里，应当可编辑',
        );
      }
    });

    test('大小写不敏感', () {
      expect(TextEditable.isEditable(file('CONFIG.TXT')), isTrue);
      expect(TextEditable.isEditable(file('Script.SH')), isTrue);
      expect(TextEditable.isEditable(file('Main.KT')), isTrue);
    });

    test('必须是结尾匹配，不能是中间出现', () {
      // 「archive.txt.bin」的扩展名是 .bin，不是 .txt——按 endsWith 判才对。
      expect(TextEditable.isEditable(file('archive.txt.bin')), isFalse);
      expect(TextEditable.isEditable(file('a.json.gz')), isFalse);
      // 反过来，白名单扩展名在结尾就要认。
      expect(TextEditable.isEditable(file('my.notes.txt')), isTrue);
    });
  });

  group('已知的覆盖缺口（如实记，钉住当前行为）', () {
    test('源码类扩展名当前不可编辑', () {
      // 这些确实是纯文本，但既不在 MIME 表里也不在白名单里——
      // 当前判据对它们返回 false。这是**已知的可用性缺口**，
      // 不是安全 bug（方向是「收紧」，不会改坏文件）。
      // 钉住它，免得以后有人「顺手」改宽时不知道这里有意收紧过。
      final notYet = <String>[
        'main.py', 'query.sql', 'a.c', 'a.h', 'a.cpp', 'main.go',
        'main.rs', 'index.ts', 'app.tsx', 'app.jsx', 'setup.cfg',
        'index.html.bak', 'a.lua', 'a.pl', 'a.rb',
      ];
      for (final name in notYet) {
        expect(
          TextEditable.isEditable(file(name)),
          isFalse,
          reason: '$name 当前不可编辑（白名单未收 + MIME 表未认）',
        );
      }
    });

    test('html / css 靠 MIME 表可编辑（不在扩展名白名单里）', () {
      // 这两个扩展名不在 TextEditable.extensions 里，但 FileMeta.mimeOf
      // 认得 text/html 与 text/css，所以走 MIME 那条路可编辑。
      expect(TextEditable.isEditable(file('page.html', mime: 'text/html')), isTrue);
      expect(TextEditable.isEditable(file('style.css', mime: 'text/css')), isTrue);
    });
  });
}
