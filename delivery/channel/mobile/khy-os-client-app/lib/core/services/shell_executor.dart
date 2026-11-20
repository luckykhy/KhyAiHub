// khy-canary: Khy-20261101-090-9S72G7V6
import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';
import '../services/app_logger.dart';
import 'audit_log.dart';
import 'device_control.dart';

/// Shell 命令执行结果
class ShellResult {
  final bool success;
  final String stdout;
  final String stderr;
  final int exitCode;
  final int durationMs;
  final String command;

  const ShellResult({
    required this.success,
    required this.stdout,
    required this.stderr,
    required this.exitCode,
    required this.durationMs,
    required this.command,
  });

  /// 输出行列表
  List<String> get outputLines =>
      stdout.split('\n').where((l) => l.trim().isNotEmpty).toList();

  /// JSON 解析（如果输出是 JSON）
  Map<String, dynamic>? get json {
    try {
      final trimmed = stdout.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return jsonDecode(trimmed) as Map<String, dynamic>;
      }
    } catch (_) {}
    return null;
  }

  List<dynamic>? get jsonList {
    try {
      final trimmed = stdout.trim();
      if (trimmed.startsWith('[')) {
        return jsonDecode(trimmed) as List<dynamic>;
      }
    } catch (_) {}
    return null;
  }

  @override
  String toString() =>
      'ShellResult(success=$success, exit=$exitCode, stdout=${stdout.length} chars, stderr=${stderr.length} chars)';
}

/// Shell 执行器（无 root 环境）
/// 能力边界：以 app UID 执行，不能访问其他 app 私有目录，不能修改系统文件
class ShellExecutor {
  static const _channel = MethodChannel('com.khyos.khy_os_client/device');
  static final _logger = AppLogger();

  /// 执行单条命令（AI / 设备控制通道）。
  ///
  /// **为什么委托给 [DeviceControl.execShell] 而不是自己直连原生**：原生那道
  /// `shell` 通道上挂着两道闸——Dart 侧的语义护栏（[ShellCommandGuard]）与原生侧的
  /// 前缀白名单。自己直连就等于**绕过前一道**：命令能带着 `rm -r -f /` 这类写法
  /// 一路走到原生，只靠原生那道前缀白名单兜（§9.18 实测它漏网 13 条写法）。
  /// 顺带还绕过审计——§9.25 的记账点就在 [DeviceControl.execShell] 上。
  ///
  /// 这扇门此前在生产代码里**零调用点**：没人走，但随时会有人走。现在它只是
  /// DeviceControl 的薄封装。
  ///
  /// **原来的 `env` 参数已删**：原生 `shell` 的方法签名只读 `command` 与 `timeout`
  /// （`MainActivity.kt` 的 `"shell" ->` 分支），`env` 从来没被读过——一个假装能用的
  /// 旋钮比没有旋钮更坏：调用方会以为环境变量生效了。
  static Future<ShellResult> exec(
    String command, {
    int timeoutSeconds = 30,
  }) async {
    final startTime = DateTime.now();
    try {
      final result = await DeviceControl.execShell(
        command,
        source: AuditSource.ai,
        timeoutSeconds: timeoutSeconds,
      );
      final duration = DateTime.now().difference(startTime).inMilliseconds;
      return ShellResult(
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: duration,
        command: command,
      );
    } catch (e) {
      final duration = DateTime.now().difference(startTime).inMilliseconds;
      _logger.w(LogCategory.system, 'Shell 调用失败: $command');
      return ShellResult(
        success: false,
        stdout: '',
        stderr: e.toString(),
        exitCode: -1,
        durationMs: duration,
        command: command,
      );
    }
  }

  /// 执行一条**人工终端**命令。
  ///
  /// 与 [exec] 的区别有两处，且都是刻意分开的：
  ///   1. 走独立的 `terminalShell` 通道——那条通道用人工命令区自己的准入策略，
  ///      AI 与设备控制的严白名单原样保留，两者互不影响。
  ///   2. cwd 作为**独立参数**传，不拼成 `cd <dir> && cmd`。拼法会让命令体里出现
  ///      `&&`，而命令体里的 shell 控制符是硬禁的——真机上终端因此一条命令都发不出去。
  static Future<ShellResult> execTerminal(
    String command, {
    String? cwd,
    int timeoutSeconds = 30,
  }) async {
    final startTime = DateTime.now();
    try {
      final result = await _channel.invokeMethod('terminalShell', {
        'command': command,
        'timeout': timeoutSeconds,
        'cwd': ?cwd,
      }).timeout(Duration(seconds: timeoutSeconds + 5));

      final duration = DateTime.now().difference(startTime).inMilliseconds;
      final shell =
          _toResult(Map<String, dynamic>.from(result as Map), command, duration);
      await _auditTerminal(command, shell, cwd: cwd);
      return shell;
    } on TimeoutException {
      final duration = DateTime.now().difference(startTime).inMilliseconds;
      _logger.w(LogCategory.system, 'Shell 超时: $command');
      final shell = ShellResult(
        success: false,
        stdout: '',
        stderr: '命令执行超时 (${timeoutSeconds}s)',
        exitCode: -1,
        durationMs: duration,
        command: command,
      );
      await _auditTerminal(command, shell, cwd: cwd);
      return shell;
    } catch (e) {
      final duration = DateTime.now().difference(startTime).inMilliseconds;
      final shell = ShellResult(
        success: false,
        stdout: '',
        stderr: e.toString(),
        exitCode: -1,
        durationMs: duration,
        command: command,
      );
      await _auditTerminal(command, shell, cwd: cwd);
      return shell;
    }
  }

  /// 人工终端的命令也记一笔。
  ///
  /// 为什么：操作日志要能回答「这个设备上发生过什么」。文件操作、AI 命令、人工
  /// 终端命令——三样都记，账才是完整的。人工终端记「用户手动」，因为那确实是人
  /// 自己敲的；不记的话，账上只剩 AI 的动静，人的动静反而看不见。
  static Future<void> _auditTerminal(
    String command,
    ShellResult result, {
    String? cwd,
  }) async {
    final where = cwd == null || cwd.isEmpty ? '' : '[cwd=$cwd] ';
    await AuditLog.instance.record(
      AuditSource.user,
      'terminal',
      '',
      detail: '$where$command',
      ok: result.success,
    );
  }
  static ShellResult _toResult(
    Map<String, dynamic> map,
    String command,
    int durationMs,
  ) {
    return ShellResult(
      success: map['success'] == true,
      stdout: map['stdout']?.toString() ?? '',
      stderr: map['stderr']?.toString() ?? '',
      exitCode: map['exitCode'] as int? ?? -1,
      durationMs: durationMs,
      command: command,
    );
  }

  /// 执行多条命令（串行）
  static Future<List<ShellResult>> execAll(
    List<String> commands, {
    int timeoutSeconds = 30,
  }) async {
    final results = <ShellResult>[];
    for (final cmd in commands) {
      final r = await exec(cmd, timeoutSeconds: timeoutSeconds);
      results.add(r);
      if (!r.success) break; // 失败则停止
    }
    return results;
  }

  /// 执行并解析 JSON 输出
  static Future<ShellResult> execForJson(String command, {int timeoutSeconds = 30}) async {
    final result = await exec(command, timeoutSeconds: timeoutSeconds);
    return result;
  }

  /// 检查命令是否可用
  static Future<bool> isAvailable(String command) async {
    final which = await exec('command -v $command', timeoutSeconds: 5);
    return which.success && which.stdout.trim().isNotEmpty;
  }

  /// 获取系统属性
  static Future<String> getProp(String key) async {
    final r = await exec('getprop $key', timeoutSeconds: 5);
    return r.stdout.trim();
  }

  /// 获取 Android 版本信息
  static Future<Map<String, String>> getSystemInfo() async {
    final info = <String, String>{};
    final keys = [
      'ro.build.version.release',
      'ro.build.version.sdk',
      'ro.product.model',
      'ro.product.brand',
      'ro.product.name',
      'ro.build.display.id',
    ];
    for (final key in keys) {
      final value = await getProp(key);
      if (value.isNotEmpty) info[key] = value;
    }
    return info;
  }
}

/// 常用命令快捷方式
class ShellCommands {
  /// 列出已安装包
  static String listPackages({bool onlyThirdParty = false}) =>
      onlyThirdParty
          ? 'pm list packages -3'
          : 'pm list packages';

  /// 获取包信息
  static String packageInfo(String packageName) =>
      'dumpsys package $packageName';

  /// 启动应用
  ///
  /// 不用 `monkey -p ...`：`monkey` 不在原生白名单里，AI 通道发出去会被整条拒掉
  /// （前缀不匹配）。`am start` 在白名单里，且这条形式不需要先知道 Activity 名。
  static String openApp(String packageName) =>
      'am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p $packageName';

  /// 启动 Activity
  static String startActivity(String component) =>
      'am start -n $component';

  /// 模拟点击
  static String tap(int x, int y) => 'input tap $x $y';

  /// 模拟滑动
  static String swipe(int x1, int y1, int x2, int y2, {int durationMs = 300}) =>
      'input swipe $x1 $y1 $x2 $y2 $durationMs';

  /// 模拟输入文字
  static String inputText(String text) => 'input text "${text.replaceAll('"', '\\"')}"';

  /// 模拟按键
  static String keyEvent(int keycode) => 'input keyevent $keycode';

  /// 截屏
  static String screenshot(String path) => 'screencap -p $path';

  /// 获取当前 Activity
  ///
  /// 不带 `| grep`：命令体里的管道是硬禁的，原生闸门会把整条命令拒掉（不是只
  /// 拒掉管道后面那段）。过滤在 Dart 侧做——原始输出更全，也省一趟子进程。
  static String currentActivity() => 'dumpsys activity activities';

  /// 获取窗口信息
  static String windowInfo() => 'dumpsys window windows';

  /// 获取运行中的进程
  static String runningProcesses() => 'ps -A';

  /// 获取内存信息
  static String memoryInfo(String packageName) =>
      'dumpsys meminfo $packageName';

  /// 获取电池信息
  static String batteryInfo() => 'dumpsys battery';

  /// 获取网络状态
  static String networkStatus() => 'dumpsys connectivity';

  /// 列出目录
  static String listDir(String path) => 'ls -la $path';

  /// 读取文件
  static String readFile(String path) => 'cat $path';

  /// 文件是否存在
  ///
  /// 不用 `[ -f x ] && echo yes || echo no`：`[` 开头不在白名单里（前缀不匹配），
  /// 而且 `&&` 是硬禁控制符。改成 `ls -d`：存在则退出码 0、stdout 是那行路径，
  /// 不存在则非零退出——判断依据放在退出码上，不放在解析 stdout 上。
  static String fileExists(String path) => 'ls -d $path';

  /// 获取文件权限
  static String filePermissions(String path) => 'ls -la $path';

  /// 获取设备 IP
  ///
  /// 不用 `| grep inet`：管道是硬禁的，整条命令会被原生闸门拒掉。`ip addr show`
  /// 已加进原生白名单（只读命令；看不到网卡地址就查不了 IP）。
  static String deviceIp() => 'ip addr show wlan0';

  /// 获取 WiFi 信息
  static String wifiInfo() => 'dumpsys wifi';

  /// 获取蓝牙状态
  static String bluetoothStatus() => 'dumpsys bluetooth_manager';

  /// 获取传感器列表
  static String sensors() => 'dumpsys sensorservice';

  /// 获取输入设备
  static String inputDevices() => 'dumpsys input';
}

