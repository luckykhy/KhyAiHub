/// VFS 失败的统一载体。
///
/// ## 为什么单独成文件
///
/// 它原先住在 `vfs_service.dart` 里。但 `vfs_copy_task.dart` 也要抛它——
/// 而 `vfs_service.dart` 已经 import 了 `vfs_copy_task.dart`（门面要用
/// `VfsCopyTasks.instance.start`）。直接让 `vfs_copy_task` 反过来 import
/// `vfs_service` 就是**循环依赖**。
///
/// 拆出来之后：`vfs_copy_task` 直接 import 本文件，环就断了。
/// `vfs_service.dart` 用 `export` 把它再露出去，所以**全仓 53 处
/// `VfsException` 引用一行都不用改**（它们多半是靠 `vfs_service.dart` 的
/// 传递导入拿到这个类型的）。
///
/// 带上机器码，是为了让「失败」也能被程序处理，而不只是给人看一句话。
/// Dart 侧把它还原成 VfsException(error, message)，机器码原样透传。
class VfsException implements Exception {
  /// 机器码（与原生契约同一套词表）。
  final String error;

  /// 中文说明。
  final String message;

  const VfsException(this.error, this.message);

  @override
  String toString() => 'VfsException($error): $message';
}
