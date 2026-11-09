// khy-canary: Khy-20261101-086-6F52FYG3
import 'package:flutter/services.dart';

/// Result shape returned by [FileService] methods.
typedef FileResult = Map<String, dynamic>;

/// Coerce a raw MethodChannel map (Object?, Object?) into a String-keyed map
/// so callers can safely index with string keys and cast element types.
FileResult _mapResult(Map raw) =>
    raw.map((key, value) => MapEntry(key.toString(), value));

/// File system operations within the app's working directory.
/// All paths are relative to the app's external files dir.
class FileService {
  static const _channel = MethodChannel('com.khyos.khy_os_client/device');

  /// Get the working directory path
  static Future<Map<String, dynamic>> getWorkDir() async {
    try {
      final result = await _channel.invokeMethod('getWorkDir');
      return _mapResult(result as Map);
    } catch (_) {
      return {'path': '', 'exists': false};
    }
  }

  /// 设置文件工具的工作空间根。null / 空 = 恢复 App 私有目录。
  ///
  /// 由界面在切换/新建对话时调用：根是设备级状态而不是每次调用的参数，
  /// 少传一次就静默落回私有目录，而界面上看不出任何差别。
  static Future<Map<String, dynamic>> setWorkRoot(String? path) async {
    try {
      final result =
          await _channel.invokeMethod('setWorkRoot', {'path': path ?? ''});
      return _mapResult(result as Map);
    } catch (_) {
      return {'ok': false, 'error': 'channel error'};
    }
  }

  /// 用文件管理器打开一个目录。
  ///
  /// 返回三种结局，调用方要分别说人话：
  ///   opened=true                       —— 有 App 接了
  ///   opened=false, noApp=true          —— 没有任何文件管理器接这个 intent
  ///   opened=false, noApp=false         —— 起了 Activity 但立刻退（不认目录）
  /// 不合并成一句"失败"：用户下一步动作完全不同——前者该去装文件管理器，
  /// 后者该改用复制路径。
  static Future<Map<String, dynamic>> openDirectory(String path) async {
    try {
      final result = await _channel.invokeMethod('openDirectory', {'path': path});
      return _mapResult(result as Map);
    } catch (_) {
      return {'opened': false, 'noApp': false, 'reason': 'channel error'};
    }
  }

  /// List files in a directory (relative path, "" = root)
  static Future<Map<String, dynamic>> listFiles(String path) async {
    try {
      final result = await _channel.invokeMethod('fileList', {'path': path});
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Read a file (relative path)
  static Future<Map<String, dynamic>> readFile(String path) async {
    try {
      final result = await _channel.invokeMethod('fileRead', {'path': path});
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Write a file (relative path + content)
  static Future<Map<String, dynamic>> writeFile(String path, String content) async {
    try {
      final result = await _channel.invokeMethod('fileWrite', {
        'path': path,
        'content': content,
      });
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Create a directory
  static Future<Map<String, dynamic>> createDir(String path) async {
    try {
      final result = await _channel.invokeMethod('fileCreateDir', {'path': path});
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Edit a file (string replacement)
  static Future<Map<String, dynamic>> editFile(
    String path,
    String oldText,
    String newText, {
    bool replaceAll = false,
  }) async {
    try {
      final result = await _channel.invokeMethod('fileEdit', {
        'path': path,
        'oldText': oldText,
        'newText': newText,
        'replaceAll': replaceAll,
      });
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Find files by glob pattern
  static Future<Map<String, dynamic>> findFiles(
    String dir,
    String pattern, {
    int maxResults = 50,
  }) async {
    try {
      final result = await _channel.invokeMethod('fileFind', {
        'dir': dir,
        'pattern': pattern,
        'maxResults': maxResults,
      });
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Search file contents with regex
  static Future<Map<String, dynamic>> grepFiles(
    String dir,
    String regex, {
    String filePattern = '',
    int maxResults = 30,
  }) async {
    try {
      final result = await _channel.invokeMethod('fileGrep', {
        'dir': dir,
        'regex': regex,
        'filePattern': filePattern,
        'maxResults': maxResults,
      });
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }
}
