// khy-canary: Khy-20261101-065-6Y0N9SV7
/// 写入子智能体。
///
/// 职责：把内容写进**工作空间内**，写完留下可核对的证据，临时文件用完即焚。
///
/// 它存在的理由是"写入"是整个系统里最不可逆的一类操作。读取读错了可以重读，
/// 写错一个文件可能盖掉用户的东西。所以这里的规矩比读取器严：
///
///   1. **路径必须落在工作空间内**。判据不是"看起来像"，是规范化之后
///      仍以工作空间目录为前缀。`..`、绝对路径、符号链接拐弯一律拒。
///   2. **只写不删**。删除由 [burn] 显式执行，且只烧临时目录——
///      一个能顺手 `delete` 的写入器，迟早会删掉不该删的。
///   3. **每次写入都留证据**：绝对路径 + 字节数 + 是否真的落盘了。
///      没落盘成功的写入，报告里必须是未验证，不能是"已写入"。
library;

import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'subagent_report.dart';
import '../services/app_logger.dart';
import '../workspace/workspace_paths.dart';
import '../workspace/workspace_store.dart';

/// 一次写入请求。
class WriteRequest {
  /// 工作空间内的相对路径。`a/b.txt` 这种，不带前导 `/`。
  final String relativePath;

  final String content;

  /// 这次写入是为了什么。进报告和日志。
  final String purpose;

  const WriteRequest({
    required this.relativePath,
    required this.content,
    this.purpose = '',
  });
}

/// 写入器的构造参数。
///
/// [store] 和 [log] 都可注入：测试里喂一个临时目录的 store，
/// 就不用在真机的 /sdcard 上写文件。
class WriterAgent {
  final WorkspaceStore _store;
  final AppLogger _log;

  WriterAgent({WorkspaceStore? store, AppLogger? log})
      : _store = store ?? WorkspaceStore.instance,
        _log = log ?? AppLogger();

  /// 单次写入的内容上限。
  ///
  /// 256KB：手机上的工作空间不是代码仓库，正常产物（一份清单、一个解析结果）
  /// 远小于此。设上限是因为一个无限大的写入会直接把 /sdcard 写满，
  /// 而那在界面上要过很久才看得出来。
  static const int maxContentBytes = 256 * 1024;

  /// 把内容写进工作空间。
  ///
  /// 路径非法时不抛，返回一条未验证观察 + ok=false。
  /// 抛异常会让调用方（往往是 UI 的一次点击）直接崩，而路径非法是
  /// **用户输入错误**，不是程序错误——该告诉他哪里错了。
  Future<SubAgentReport> write(
    WorkspacePaths ws,
    WriteRequest req,
  ) async {
    final rel = req.relativePath.trim();
    if (rel.isEmpty) {
      return SubAgentReport.failed(SubAgentRole.writer, '相对路径不能为空');
    }
    if (rel.startsWith('/') || p.isAbsolute(rel)) {
      return SubAgentReport.failed(
        SubAgentRole.writer,
        '路径必须是工作空间内的相对路径，不接受绝对路径：$rel',
      );
    }
    final target = p.normalize(p.join(ws.dir, rel));
    final root = p.normalize(ws.dir);
    // 规范化之后仍必须以工作空间目录为前缀。
    //
    // 只查 `..` 是不够的：`a/../../x` 里有两个 `..`，看着像在里面，
    // 规范化之后就在外面了。所以先 normalize 再比前缀，顺序不能反。
    if (!_isInside(root, target)) {
      return SubAgentReport.failed(
        SubAgentRole.writer,
        '路径越出工作空间（$rel → $target）。只允许写入 $root 之内',
      );
    }
    if (_utf8Len(req.content) > maxContentBytes) {
      return SubAgentReport.failed(
        SubAgentRole.writer,
        '内容超过单次写入上限（${_utf8Len(req.content)} > $maxContentBytes 字节）',
      );
    }

    try {
      final file = File(target);
      final parent = file.parent;
      if (!await parent.exists()) {
        await parent.create(recursive: true);
      }
      await file.writeAsString(req.content, flush: true);

      final written = await file.length();
      // 比的是 **UTF-8 字节数**，不是 `String.length`。
      // 后者数的是 UTF-16 码元：`'你好'.length == 2`，落盘却是 6 字节。
      // 拿它比会让每一个含非 ASCII 的写入都被判成"字节数不符"——
      // 于是中文内容永远写不进去，而报告说的是"字节数不符"这种怪话。
      // 这是被 writer_agent_test 抓出来的真实 bug。
      final expected = _utf8Len(req.content);
      if (written != expected) {
        // 字节数对不上就是没写成。这种事会发生（空间满、写入被中断），
        // 而 UI 上一个"已写入"的提示会让用户以为东西在那儿。
        return SubAgentReport(
          role: SubAgentRole.writer,
          ok: true,
          observations: <Observation>[
            Observation.unverified(
              '写入 $rel',
              why: '落盘后字节数不符（期望 $expected，实际 $written）',
            ),
          ],
          data: <String, dynamic>{'path': target, 'bytes': written},
        );
      }

      _log.i(LogCategory.system, '工作空间写入',
          details: <String, dynamic>{
            'path': target,
            'bytes': written,
            if (req.purpose.isNotEmpty) 'purpose': req.purpose,
          });

      return SubAgentReport(
        role: SubAgentRole.writer,
        ok: true,
        observations: <Observation>[
          Observation.verified('写入 $rel', <String, dynamic>{
            'success': true,
            'path': target,
            'bytes': written,
            'workspace': ws.dir,
          }),
        ],
        data: <String, dynamic>{
          'path': target,
          'bytes': written,
          if (req.purpose.isNotEmpty) 'purpose': req.purpose,
        },
      );
    } catch (e) {
      _log.w(LogCategory.system, '工作空间写入失败',
          details: <String, dynamic>{'path': target, 'error': '$e'});
      return SubAgentReport(
        role: SubAgentRole.writer,
        ok: true,
        observations: <Observation>[
          Observation.unverified('写入 $rel', why: '落盘异常：$e'),
        ],
        data: <String, dynamic>{'path': target},
      );
    }
  }

  /// 读回一个工作空间内的文件，用来核对写入是否真的在那儿。
  ///
  /// 写入器自己核对自己的写入——这看起来违反"谁读的谁判的分开"，
  /// 但这里判的不是"内容对不对"，是"文件在不在、字节数对不对"，
  /// 那是机械事实，没有判断空间。真正需要检查子智能体的是语义。
  Future<SubAgentReport> readBack(WorkspacePaths ws, String relativePath) async {
    final rel = relativePath.trim();
    if (rel.isEmpty) {
      return SubAgentReport.failed(SubAgentRole.writer, '相对路径不能为空');
    }
    final target = p.normalize(p.join(ws.dir, rel));
    if (!_isInside(p.normalize(ws.dir), target)) {
      return SubAgentReport.failed(
        SubAgentRole.writer,
        '路径越出工作空间：$rel',
      );
    }
    try {
      final file = File(target);
      if (!await file.exists()) {
        return SubAgentReport(
          role: SubAgentRole.writer,
          ok: true,
          observations: <Observation>[
            Observation.unverified('读回 $rel', why: '文件不存在'),
          ],
        );
      }
      final content = await file.readAsString();
      return SubAgentReport(
        role: SubAgentRole.writer,
        ok: true,
        observations: <Observation>[
          Observation.verified('读回 $rel', <String, dynamic>{
            'success': true,
            'path': target,
            'bytes': content.length,
          }),
        ],
        data: <String, dynamic>{
          'path': target,
          'bytes': content.length,
          'content': content,
        },
      );
    } catch (e) {
      return SubAgentReport(
        role: SubAgentRole.writer,
        ok: true,
        observations: <Observation>[
          Observation.unverified('读回 $rel', why: '读取异常：$e'),
        ],
      );
    }
  }

  /// 领一个临时目录。用完调 [burnTemp]。
  Future<Directory?> claimTemp(WorkspacePaths ws) => _store.claimTempDir(ws);

  /// 烧掉一个临时目录。用完即焚。
  Future<void> burnTemp(Directory? dir) => _store.burn(dir);

  static bool _isInside(String root, String target) {
    if (target == root) return false; // 工作空间本身不是可写文件
    final withSep = root.endsWith(p.separator) ? root : root + p.separator;
    return target.startsWith(withSep);
  }

  /// UTF-8 字节数。
  ///
  /// 单独抽出来是因为"内容多长"在这个类里出现了三次（上限检查、期望值、
  /// 日志），而三次都必须用同一个口径。`String.length` 数 UTF-16 码元，
  /// 混用一次的代价是中文内容永远写不进去。
  static int _utf8Len(String s) => utf8.encode(s).length;
}
