// AI 输出的安全护栏。
//
// AI 产出的东西一律当作**不可信输入**处理，哪怕它来自一个看起来很聪明的模型。
// 这里只做两件事：
//   1. 路径白名单：AI 只能碰它被允许碰的路径；
//   2. 命令黑名单：AI 如果吐出命令串而不是结构化操作，危险模式一律拒绝。
//
// 为什么放在 Dart 侧而不是原生侧：原生侧要同时防住「用户手输」和「AI 生成」，
// 但 AI 生成内容的**语义**判定（哪些操作类型允许、哪些路径允许）需要和界面上的
// 权限策略共享同一套判定。原生侧那道护栏是最后一道网，不是唯一一道。

import '../services/shell_command_guard.dart';
import 'vfs_route.dart';

/// 禁止写入的**路径本身**。
///
/// 这些是「动它等于动系统」的节点：挂载点本身、根目录本身。
/// 注意这里**不含** `/storage/emulated/0`——那是用户的内部存储，
/// 文件管理器天天在它底下建目录写文件，把它禁掉等于把 App 的主功能禁了。
const Set<String> kForbiddenWriteRoots = <String>{
  '/',
  '/data',
  '/data/data',
  '/data/user',
  '/system',
  '/vendor',
  '/product',
  '/apex',
  '/odm',
  '/proc',
  '/sys',
  '/dev',
  '/storage',
  '/storage/emulated',
};

/// 禁止写入的**子树**（路径落在其下即拒绝）。
///
/// 与上一张表的区别是这一张连 descendants 一起禁：改 `/system` 下的任何文件
/// 都是改系统，`/proc`、`/dev` 同理。
///
/// **不含 `/data`**：应用私有目录不是「禁写区」，而是「需要额外授权区」——
/// 那里写不写由 [VfsPolicy.advancedDataEdit] 决定，执行层管；过滤器这里把
/// 私有目录的删除判成**高危**（要人逐项确认），而不是直接丢弃。
/// 两层各管一件事：过滤器管「这件事该不该被提出来」，执行层管「它能不能执行」。
const Set<String> kForbiddenWriteSubtrees = <String>{
  '/system',
  '/vendor',
  '/product',
  '/apex',
  '/odm',
  '/proc',
  '/sys',
  '/dev',
};

/// 危险命令模式的正则在 [shell_command_guard.dart] 里。
///
/// 为什么搬走：命令判定现在有两层——结构化解析（主判定）与正则（兜底）——
/// 两层必须**在同一个文件、同一个入口**里，否则迟早出现「一层改了另一层没改」
/// 的缝。而这层判定的真正执行点在 core/services（[DeviceControl.execShell]），
/// 把文件放在 core/vfs 会让 core/services 反向依赖 core/vfs，绕成环。
///
/// 详见 [ShellCommandGuard] 的注释——2026-11-09 的实测：旧版纯正则在 27 条
/// 「该拦」的命令里只拦住 14 条，**漏网 13 条**（§9.23）。

/// 安全校验结果。
class SafetyVerdict {
  /// 是否放行。
  final bool allowed;

  /// 不放行时的人话原因。
  final String? reason;

  const SafetyVerdict.allow() : allowed = true, reason = null;

  const SafetyVerdict.deny(this.reason) : allowed = false;
}

/// 路径与命令的白名单校验。
abstract final class AiSafetyFilter {
  /// 校验一个 AI 提出的路径。
  ///
  /// [forWrite] 为 true 时额外禁止写入危险根目录。
  ///
  /// **必须是绝对路径**：相对路径会按「执行时的当前目录」解释，而那个目录在
  /// 计划生成时和执行时可能不是同一个——一个说不清落点的路径不该被执行。
  static SafetyVerdict checkPath(String rawPath, {bool forWrite = false}) {
    final path = VfsPath.normalize(rawPath);
    if (path == '/') {
      return const SafetyVerdict.deny('根目录不是可操作对象');
    }
    if (!rawPath.startsWith('/')) {
      return SafetyVerdict.deny('路径必须是绝对路径：$rawPath');
    }
    if (rawPath.contains('..')) {
      return const SafetyVerdict.deny('路径含 .. ，不接受越界路径');
    }
    if (forWrite && kForbiddenWriteRoots.contains(path)) {
      return SafetyVerdict.deny('禁止对 $path 执行写操作');
    }
    if (forWrite) {
      for (final root in kForbiddenWriteSubtrees) {
        if (VfsPath.isUnder(path, root)) {
          return SafetyVerdict.deny('禁止对 $root 下的内容执行写操作');
        }
      }
    }
    return const SafetyVerdict.allow();
  }

  /// 校验一条命令串。
  ///
  /// AI 优先产出结构化操作而不是命令串；这里只处理「AI 非要吐命令」的情况。
  /// 命中危险模式直接拒绝，并把命中的模式说出来——用户要能看懂为什么被拦。
  ///
  /// 判定本体在 [ShellCommandGuard]（结构化解析 + 正则兜底两层）。
  /// 这里保留这个入口是为了不打断既有调用方（[ai_plan] 的脚本生成、
  /// 聊天页的危险命令确认都走它）。
  static SafetyVerdict checkCommand(String command) {
    final trimmed = command.trim();
    if (trimmed.isEmpty) {
      return const SafetyVerdict.deny('空命令');
    }
    final why = ShellCommandGuard.reason(trimmed);
    if (why != null) {
      return SafetyVerdict.deny('命令被安全护栏拒绝：$why');
    }
    return const SafetyVerdict.allow();
  }
}
