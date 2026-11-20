// khy-canary: Khy-20261101-085-048B50CF
import 'package:flutter/services.dart';
import 'audit_log.dart';
import 'screen_metrics.dart';
import 'shell_command_guard.dart';

/// 一键开关无障碍服务的结果。
///
/// 之所以要一个类型而不是裸 Map：UI 必须能区分三种结局，而它们对用户是
/// 三件不同的事——
///   ok=true, already=true  本来就是这个状态，什么都没改；
///   ok=true, already=false 这次真的写成功了；
///   ok=false               没写成，reason 得原样摆出来，不能让用户对着
///                          一个没动的开关猜。
class AccessibilitySetupResult {
  const AccessibilitySetupResult({
    required this.ok,
    required this.via,
    required this.already,
    required this.reason,
  });

  factory AccessibilitySetupResult.fromMap(Map<Object?, Object?>? map) {
    if (map == null) return const AccessibilitySetupResult.failureEmpty();
    return AccessibilitySetupResult(
      ok: map['ok'] == true,
      via: (map['via'] as String?) ?? '',
      already: map['already'] == true,
      reason: (map['reason'] as String?) ?? '',
    );
  }

  const AccessibilitySetupResult.failure(String why)
      : ok = false,
        via = '',
        already = false,
        reason = why;

  const AccessibilitySetupResult.failureEmpty()
      : ok = false,
        via = '',
        already = false,
        reason = '原生侧没有返回结果';

  final bool ok;

  /// 执行这条命令的通道：sidecar / app。
  final String via;

  /// 目标状态原本就已成立，本次没有写入。
  final bool already;

  /// 失败原因，中文。成功时为空。
  final String reason;

  /// 给 SnackBar 用的一句话。
  String get message {
    if (ok) {
      return already ? '已经是这个状态了' : '已通过 $via 写入';
    }
    return reason.isEmpty ? '操作失败' : reason;
  }
}

/// Device control service - bridges Dart to Android native code
/// Supports: App/URL, Clipboard, Device info, Accessibility, Screen capture, Shell
class DeviceControl {
  static const _channel = MethodChannel('com.khyos.khy_os_client/device');

  // ==================== App / URL ====================

  /// Open an Android app by package name
  static Future<bool> openApp(String packageName) async {
    try {
      final result = await _channel.invokeMethod('openApp', {'packageName': packageName});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Open a URL in the default browser
  static Future<bool> openUrl(String url) async {
    try {
      final result = await _channel.invokeMethod('openUrl', {'url': url});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Search installed apps by query
  static Future<List<AppInfo>> searchApps(String query) async {
    try {
      final result = await _channel.invokeMethod('searchApps', {'query': query});
      if (result['success'] == true) {
        return (result['apps'] as List).map((a) => AppInfo(
          label: a['label'] ?? '',
          packageName: a['package'] ?? '',
        )).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  /// List all installed apps
  static Future<List<AppInfo>> listApps() async {
    try {
      final result = await _channel.invokeMethod('listApps');
      if (result['success'] == true) {
        return (result['apps'] as List).map((a) => AppInfo(
          label: a['label'] ?? '',
          packageName: a['package'] ?? '',
        )).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  // ==================== Clipboard ====================

  /// Get clipboard text
  static Future<String> getClipboard() async {
    try {
      final result = await _channel.invokeMethod('getClipboard');
      return result['text'] ?? '';
    } catch (e) {
      return '';
    }
  }

  /// Set clipboard text
  static Future<bool> setClipboard(String text) async {
    try {
      final result = await _channel.invokeMethod('setClipboard', {'text': text});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  // ==================== Device ====================

  /// Get device information
  static Future<Map<String, dynamic>> getDeviceInfo() async {
    try {
      final result = await _channel.invokeMethod('getDeviceInfo');
      return Map<String, dynamic>.from(result);
    } catch (e) {
      return {};
    }
  }

  /// Vibrate the device
  static Future<bool> vibrate({int duration = 200}) async {
    try {
      final result = await _channel.invokeMethod('vibrate', {'duration': duration});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Get all installed packages with details
  ///
  /// 为什么用 `Map<String, dynamic>.from` 而不是 `.cast<Map<String, dynamic>>()`：
  /// `cast` 是**惰性**的，它只包一层视图，类型检查推迟到每次取值时才做。而
  /// MethodChannel 的编解码器交回来的是 `List<Map<Object?, Object?>>`——于是
  /// 取值那一刻才抛 `type '_Map<Object?, Object?>' is not a subtype of ...`，
  /// 栈顶在调用方的 `.join()` 里，看起来像 UI 的错，实际是这里的错。
  /// 设备页因此崩过 32 次（见 E601）。
  ///
  /// `whereType<Map>()` 再把格式不对的条目剔掉，而不是让整个列表读取失败。
  static Future<List<Map<String, dynamic>>> getInstalledPackages() async {
    try {
      final result = await _channel.invokeMethod('getInstalledPackages');
      if (result['success'] == true) {
        final packages = result['packages'];
        if (packages is! List) return [];
        return packages
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList(growable: false);
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  // ==================== Accessibility Service ====================

  /// Check if accessibility service is ready
  static Future<bool> isAccessibilityReady() async {
    try {
      final result = await _channel.invokeMethod('isAccessibilityReady');
      return result['ready'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Open accessibility settings to enable the service
  static Future<void> openAccessibilitySettings() async {
    try {
      await _channel.invokeMethod('openAccessibilitySettings');
    } catch (e) {}
  }

  // ── Built-in inference engine (local vision, no Ollama anywhere) ──────────

  /// Load a GGUF model and start the loopback OpenAI-compatible endpoint.
  ///
  /// On success returns `{ok: true, port, url, model, message}` where `url` is
  /// already the full base URL to store in `visionBaseUrl`. That is deliberate:
  /// the port is chosen on the device (it tries 8780 first and falls back), so
  /// a Dart-side guess about it would be wrong the moment two things want it.
  ///
  /// On failure `{ok: false, message}` with a Chinese reason naming which of the
  /// two halves failed — model load or socket bind — because the fixes are
  /// completely different.
  static Future<Map<String, dynamic>> startLocalVision(
      String modelPath, String mmprojPath,
      {int port = 0}) async {
    try {
      final r = await _channel.invokeMethod<Map<Object?, Object?>>(
          'startLocalVision', {
        'modelPath': modelPath,
        'mmprojPath': mmprojPath,
        'port': port,
      });
      return r?.cast<String, dynamic>() ??
          {'ok': false, 'message': '原生侧没有回应'};
    } catch (e) {
      return {'ok': false, 'message': '调用失败：$e'};
    }
  }

  /// Stop the endpoint and release the model (frees ~2.6 GB of RAM).
  static Future<void> stopLocalVision() async {
    try {
      await _channel.invokeMethod('stopLocalVision');
    } catch (_) {}
  }

  /// `{running, port, model}`. Used to show honest state rather than assuming
  /// the server survived an app restart — it does not; the engine is process
  /// state and dies with the process.
  static Future<Map<String, dynamic>> localVisionStatus() async {
    try {
      final r = await _channel.invokeMethod<Map<Object?, Object?>>(
          'localVisionStatus');
      return r?.cast<String, dynamic>() ?? const {'running': false, 'port': 0};
    } catch (_) {
      return const {'running': false, 'port': 0};
    }
  }

  /// 一键开启无障碍服务：由本机 uid 2000 直接写 Settings.Secure。
  ///
  /// 返回 {ok, via, already, reason}。ok=false 时 reason 说人话，via 说明
  /// 走了哪条通道（sidecar / app）。**这不是静默操作**——调用方
  /// （设置页的开关）必须先弹确认框，把「要写一条系统设置、去哪里撤销」
  /// 讲清楚，才允许调这里。
  static Future<AccessibilitySetupResult> enableAccessibility() async {
    try {
      final result = await _channel.invokeMethod<Map<Object?, Object?>>(
          'enableAccessibility');
      return AccessibilitySetupResult.fromMap(result);
    } catch (e) {
      return AccessibilitySetupResult.failure('调用失败：$e');
    }
  }

  /// 一键关闭无障碍服务（能力收缩方向，无需额外确认）。
  static Future<AccessibilitySetupResult> disableAccessibility() async {
    try {
      final result = await _channel.invokeMethod<Map<Object?, Object?>>(
          'disableAccessibility');
      return AccessibilitySetupResult.fromMap(result);
    } catch (e) {
      return AccessibilitySetupResult.failure('调用失败：$e');
    }
  }

  /// 当前哪条提权通道能用来一键开关。UI 用它提前说明一键是否可用，
  /// 而不是等失败了再解释。
  static Future<String> accessibilitySetupAdvice() async {
    try {
      final result = await _channel.invokeMethod<Map<Object?, Object?>>(
          'accessibilitySetupAdvice');
      return result?['advice'] as String? ?? '';
    } catch (e) {
      return '';
    }
  }

  /// 「重装/更新后自动恢复无障碍授权」的当前值。
  ///
  /// 默认 false，由原生侧 SharedPreferences 存。这个开关是用户对
  /// 「App 可以在自己更新之后重新拿到读屏幕权限」的明示同意——没有它，
  /// 恢复逻辑一律不动手（见 AccessibilitySetup.restoreIfConsented）。
  static Future<bool> isA11yAutoRestoreOn() async {
    try {
      final result = await _channel.invokeMethod<Map<Object?, Object?>>(
          'isA11yAutoRestoreOn');
      return result?['on'] == true;
    } catch (_) {
      return false;
    }
  }

  /// 写入上面的开关。返回是否真的写进去了——没写进去时调用方必须保持原值，
  /// 不能因为「点了就算生效」而显示一个与存储相反的状态。
  static Future<bool> setA11yAutoRestore(bool value) async {
    try {
      final result = await _channel.invokeMethod<Map<Object?, Object?>>(
          'setA11yAutoRestore', {'on': value});
      return result?['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  /// Tap at coordinates via accessibility service
  static Future<bool> a11yTap(int x, int y) async {
    try {
      final result = await _channel.invokeMethod('a11yTap', {'x': x, 'y': y});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Swipe gesture via accessibility service
  static Future<bool> a11ySwipe(int x1, int y1, int x2, int y2, {int durationMs = 300}) async {
    try {
      final result = await _channel.invokeMethod('a11ySwipe', {
        'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'durationMs': durationMs,
      });
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Find and click element by text/id/class
  static Future<bool> a11yFindAndClick(String query) async {
    try {
      final result = await _channel.invokeMethod('a11yFindAndClick', {'query': query});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Find and long-click element
  static Future<bool> a11yFindAndLongClick(String query) async {
    try {
      final result = await _channel.invokeMethod('a11yFindAndLongClick', {'query': query});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Find element and return its center bounds
  static Future<Map<String, int>?> a11yFindWithBounds(String query) async {
    try {
      final result = await _channel.invokeMethod('a11yFindWithBounds', {'query': query});
      if (result['success'] == true) {
        return {
          'x': result['x'] as int,
          'y': result['y'] as int,
          'w': result['w'] as int,
          'h': result['h'] as int,
        };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /// Dump the current UI tree (for VLM decision making)
  static Future<String> a11yDumpUi() async {
    try {
      final result = await _channel.invokeMethod('a11yDumpUi');
      return result['dump'] ?? '';
    } catch (e) {
      return '';
    }
  }

  /// List all clickable elements with their bounds
  /// 可点击元素列表。
  ///
  /// 同 [getInstalledPackages]：不能用 `.cast`，理由见那里的注释（32 次 E601
  /// 崩在设备页的「可点击」按钮上，栈顶在 `items.take(20).map(...).join()`）。
  static Future<List<Map<String, dynamic>>> a11yListClickable() async {
    try {
      final result = await _channel.invokeMethod('a11yListClickable');
      if (result['success'] == true) {
        final items = result['items'];
        if (items is! List) return [];
        return items
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList(growable: false);
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  /// Type text into focused input field
  static Future<bool> a11yTypeText(String text) async {
    try {
      final result = await _channel.invokeMethod('a11yTypeText', {'text': text});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Perform global action: 1=BACK, 2=HOME, 3=RECENTS, 4=NOTIFICATIONS
  static Future<bool> a11yGlobalAction(int action) async {
    try {
      final result = await _channel.invokeMethod('a11yGlobalAction', {'action': action});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Global action constants
  static const int globalActionBack = 1;
  static const int globalActionHome = 2;
  static const int globalActionRecents = 3;
  static const int globalActionNotifications = 4;

  // ==================== Screen Capture ====================

  /// Check if screen capture service is ready
  static Future<bool> isScreenCaptureReady() async {
    try {
      final result = await _channel.invokeMethod('isScreenCaptureReady');
      return result['ready'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Start screen capture (will prompt user for permission)
  static Future<bool> startScreenCapture() async {
    try {
      final result = await _channel.invokeMethod('startScreenCapture');
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Capture a single frame, returns base64 JPEG data
  static Future<String?> captureFrame() async {
    try {
      final result = await _channel.invokeMethod('captureFrame');
      if (result['success'] == true) {
        return result['data'] as String?;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /// The geometry of the current screenshot, for converting coordinates.
  ///
  /// Separate from [captureFrame] on purpose: asking "what do these pixels
  /// mean" should not take another screenshot. Between a capture and a tap the
  /// screen may well have changed, and re-capturing to learn the geometry
  /// would guarantee it had.
  ///
  /// Returns an unusable [ScreenMetrics] rather than throwing when the
  /// projection is down — that is a normal state, and the caller needs
  /// [ScreenMetrics.whyUnusable] to say which one it is.
  static Future<ScreenMetrics> getScreenMetrics() async {
    try {
      final result =
          await _channel.invokeMethod<Map<Object?, Object?>>('getScreenMetrics');
      if (result == null) return ScreenMetrics.none('读不到屏幕几何（通道无响应）');
      if (result['success'] != true) {
        return ScreenMetrics.none(
            result['message'] as String? ?? '读不到屏幕几何');
      }
      final m = result['metrics'];
      if (m is Map) return ScreenMetrics.fromMap(m);
      return ScreenMetrics.none('屏幕几何返回了不是对象的值');
    } catch (e) {
      return ScreenMetrics.none('读屏幕几何出错：$e');
    }
  }

  /// Stop screen capture service
  static Future<bool> stopScreenCapture() async {
    try {
      final result = await _channel.invokeMethod('stopScreenCapture');
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Screenshot through the accessibility service.
  ///
  /// Tried BEFORE [captureFrame] by the vision tools, because it needs no
  /// consent beyond the accessibility service — which those tools already
  /// require for the tap. MediaProjection, by contrast, pops a system dialog
  /// every session. So this takes the vision feature from two user consents
  /// down to one.
  ///
  /// Returns null when it does not work, and the caller is expected to fall
  /// back rather than report an error: a null here is a normal state (service
  /// off, unsupported, frozen), not a failure worth surfacing to the user.
  static Future<Map<String, dynamic>?> a11yScreenshot() async {
    try {
      final result =
          await _channel.invokeMethod<Map<Object?, Object?>>('a11yScreenshot');
      if (result == null || result['success'] != true) return null;
      final m = <String, dynamic>{
        'b64': result['b64'] ?? '',
        'w': result['w'] ?? 0,
        'h': result['h'] ?? 0,
        'orig_w': result['orig_w'] ?? 0,
        'orig_h': result['orig_h'] ?? 0,
      };
      return m;
    } catch (e) {
      return null;
    }
  }

  /// Take the most recent text shared into the app, if any.
  ///
  /// Called on every resume, so it must be cheap and must be idempotent — hence
  /// "consume": the native side clears the value, so a share is delivered once
  /// rather than replayed into whatever the user is doing later. An empty string
  /// means nothing was shared, which is the normal case and not an error.
  static Future<String> consumeSharedText() async {
    try {
      final result = await _channel.invokeMethod<String>('consumeSharedText');
      return result ?? '';
    } catch (e) {
      return '';
    }
  }

  /// 领取 App 外入口（悬浮窗「点此恢复」等）暂存的页内路由，领取即清空。
  ///
  /// 与 [consumeSharedText] 同一契约：事件不是状态，空串 = 没有待办；
  /// Flutter 侧在每个 resumed 轮询一次。未知路由名由调用方丢弃——旧 APK 的
  /// Flutter 树不认识新路由名时，绝不能拿它当异常炸掉。
  static Future<String> consumePendingRoute() async {
    try {
      final result = await _channel.invokeMethod<String>('consumePendingRoute');
      return result ?? '';
    } catch (e) {
      return '';
    }
  }

  /// Turn the 「选中文字后」 menu entry on or off.
  ///
  /// Off by default on purpose: `ACTION_PROCESS_TEXT` puts khy-os in every
  /// long-press selection menu on the device, which is a permanent and
  /// user-visible intrusion. The manifest ships the alias disabled, so this is
  /// the only thing that turns it on, and only the user can ask for that.
  static Future<bool> setProcessTextEntryEnabled(bool enabled) async {
    try {
      final result =
          await _channel.invokeMethod('setProcessTextEntryEnabled', {
        'enabled': enabled,
      });
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Whether the 「选中文字后」 menu entry is installed right now.
  ///
  /// Asks the package manager rather than a stored preference, because the
  /// component's state survives restarts but not reinstalls — a preference would
  /// go stale after exactly the event that resets it, and the settings screen
  /// would then show a switch that is on while the menu entry is absent.
  static Future<bool> processTextEntryEnabled() async {
    try {
      final result = await _channel.invokeMethod<bool>('processTextEntryEnabled');
      return result == true;
    } catch (e) {
      return false;
    }
  }

  // ==================== Shell ====================

  /// Execute a shell command (whitelist restricted)
  ///
  /// **为什么这里还要有一道判定**：原生那侧 `isCommandAllowed` 是**前缀白名单**——
  /// 它答的是「这类命令准不准跑」，不是「这条命令这个写法危不危险」。前缀白名单
  /// 看不懂参数的写法差异：`rm -rf /` 被挡住，`rm -r -f /` 却从同一道门溜过去
  /// （§9.23 实测）。原生那道是**最后一道网**；这一道是语义判定，位置更靠前——
  /// 命令连原生都到不了。
  ///
  /// **这是 AI / 设备控制 shell 通道的唯一汇聚点**：`exec_shell`、
  /// `exec_shell_elevated`、`android` 工具、skill 步骤全都走这里。
  /// 所以这道门不是「多一层保险」，是这层护栏**唯一真正生效**的地方。
  /// 同理，审计也写在这里——命令散落在各个工具里，不收口就等于没有审计。
  ///
  /// [source] 是这条命令的来源标记。**默认 AI**：这个通道绝大多数调用方都是
  /// AI 发起的；只有确定由用户手动触发的调用（例如用户在「系统应用管理」面板
  /// 里点的那一下）才需要显式传 [AuditSource.user]。默认值朝「AI 多记几条」
  /// 偏，不朝「AI 少记几条」偏——后者会让日志谎报是谁干的。
  static Future<ShellResult> execShell(
    String command, {
    AuditSource source = AuditSource.ai,
    int timeoutSeconds = 30,
  }) async {
    final denied = ShellCommandGuard.reason(command);
    if (denied != null) {
      // 被拦下的命令也要留痕：用户有权知道「AI 试图干这个、被护栏拦住了」。
      // 只记成功的，等于把「AI 曾经想删光整个存储」这段从账上抹掉。
      final blocked = ShellResult(
        success: false,
        stdout: '',
        stderr: '命令被安全护栏拒绝：$denied',
        exitCode: -1,
      );
      await _auditShell(source, 'shell', command, blocked);
      return blocked;
    }
    final result = await _runShell(command, timeoutSeconds);
    await _auditShell(source, 'shell', command, result);
    return result;
  }

  /// 真正下发给原生 shell 的那一步（不判护栏、不写审计）。
  ///
  /// 为什么要单独拆出来：提权通道在 提权代理 不可用时会**降级**到普通 shell，
  /// 而普通 shell 那条路径本身已经带护栏与审计。降级如果直接调 [execShell]，
  /// 同一条命令就会被记两次（一次算提权、一次算普通），日志里凭空多一条。
  static Future<ShellResult> _runShell(String command, int timeoutSeconds) async {
    try {
      final result = await _channel.invokeMethod('shell', {'command': command, 'timeout': timeoutSeconds});
      return ShellResult(
        success: result['success'] == true,
        stdout: result['stdout'] ?? '',
        stderr: result['stderr'] ?? '',
        exitCode: result['exitCode'] ?? -1,
        code: result['code']?.toString() ?? '',
      );
    } catch (e) {
      return ShellResult(success: false, stdout: '', stderr: e.toString(), exitCode: -1);
    }
  }

  /// 把一条命令写进操作审计。
  ///
  /// 为什么命令也进审计：文件写操作有 VFS 那一个统一出口，命令没有——每条命令
  /// 各自散落在工具里。不在这里收口，操作日志里就只剩「文件被改过」，
  /// 看不到「AI 到底在设备上跑了什么」。
  static Future<void> _auditShell(
    AuditSource source,
    String operation,
    String command,
    ShellResult result, {
    String note = '',
  }) async {
    var detail = command;
    final stderr = result.stderr.trim();
    if (!result.success && stderr.isNotEmpty) {
      detail = '$command\n$stderr';
    }
    if (note.isNotEmpty) {
      detail = '$detail\n$note';
    }
    if (detail.length > 800) {
      detail = '${detail.substring(0, 800)}…';
    }
    await AuditLog.instance.record(
      source,
      operation,
      '',
      detail: detail,
      ok: result.success,
    );
  }

  // ==================== APK Install ====================

  /// 安装一个本地 APK。
  ///
  /// 为什么单独一条而不是复用 [execShell]：
  /// [execShell] 跑在 App 自己的 uid 上，没有 INSTALL_PACKAGES——命令会"成功"
  /// 返回而什么都没装。这条走原生层的 installApk，它经
  /// `Tools.exec`（sidecar → App uid）逐级尝试，并把实际执行身份
  /// 回报在 [InstallResult.elevated] 里。
  static Future<InstallResult> installApk(String path) async {
    try {
      final result = await _channel.invokeMethod('installApk', {'path': path});
      if (result is! Map) {
        return const InstallResult(
          ok: false, code: 'unavailable', error: '原生层未返回结果');
      }
      return InstallResult(
        ok: result['ok'] == true,
        code: result['code']?.toString() ?? '',
        error: result['error']?.toString() ?? '',
        stdout: result['stdout']?.toString() ?? '',
        stderr: result['stderr']?.toString() ?? '',
        via: result['via']?.toString() ?? '',
        elevated: result['elevated'] == true,
      );
    } catch (e) {
      return InstallResult(
        ok: false, code: 'unavailable', error: '调用失败：$e');
    }
  }

  // ==================== 提权代理（shell sidecar，uid 2000） ====================
  //
  // 提权代理 is this app's own shell sidecar, started over wireless debugging
  // and running as uid 2000. It is not a third-party elevation app and has
  // nothing to install. Nothing below does any harm if the sidecar is not up:
  // each check degrades to "not available" and B-class commands are refused
  // with code=elevation_required instead of silently running as the app uid.

  /// Query whether 提权代理 is installed and its provider is reachable.
  static Future<ElevationStatus> getElevationStatus() async {
    try {
      final result = await _channel.invokeMethod('elevationStatus');
      return ElevationStatus(
        installed: result['installed'] == true,
        running: result['running'] == true,
        online: result['online'] == true,
        version: result['version']?.toString() ?? '',
        reason: result['reason']?.toString() ?? '',
        enabled: result['enabled'] == true,
        elevatedLevel: result['elevated']?.toString() ?? 'none',
        deviceAuth: result['device_auth']?.toString() ?? 'unpaired',
        lastPairMs: (result['last_pair_ms'] as num?)?.toInt() ?? 0,
      );
    } catch (_) {
      return const ElevationStatus();
    }
  }

  /// 读取/记住本机无线调试的连接端点（"IP:端口"）。
  ///
  /// 自举提权需要它：App 用这个端点连回本机的 adbd，拿到一个 uid 2000 的
  /// shell，再从那里把提权代理拉起来。端点来自手机「无线调试」那一页。
  static Future<ElevationEndpoint> getElevationEndpoint() async {
    try {
      final result = await _channel.invokeMethod('elevationEndpoint');
      return ElevationEndpoint(
        endpoint: result['endpoint']?.toString() ?? '',
        fingerprint: result['fingerprint']?.toString() ?? '',
      );
    } catch (_) {
      return const ElevationEndpoint();
    }
  }

  /// 记住无线调试端点。传空串表示清掉。
  static Future<ElevationEndpoint> setElevationEndpoint(String endpoint) async {
    try {
      final result = await _channel.invokeMethod('elevationEndpoint', {
        'endpoint': endpoint,
      });
      return ElevationEndpoint(
        endpoint: result['endpoint']?.toString() ?? '',
        fingerprint: result['fingerprint']?.toString() ?? '',
      );
    } catch (_) {
      return const ElevationEndpoint();
    }
  }

  /// 让 App 自己把提权代理拉起来（走本机无线调试，不需要电脑在场）。
  ///
  /// 返回值里的 [ElevationBootstrapResult.message] 是给用户看的中文句子；
  /// [ElevationBootstrapResult.detail] 是技术细节，失败时才看。
  static Future<ElevationBootstrapResult> bootstrapElevation() async {
    try {
      final result = await _channel.invokeMethod('elevationBootstrap');
      final parsed = ElevationBootstrapResult(
        ok: result['ok'] == true,
        message: result['message']?.toString() ?? '',
        detail: result['detail']?.toString() ?? '',
        endpoint: result['endpoint']?.toString() ?? '',
        fingerprint: result['fingerprint']?.toString() ?? '',
      );
      // 审计（T10）：「连接」类事件——代理是连上了还是没连上，这里留痕。
      await AuditLog.instance.record(
        AuditSource.user,
        'elevation.bootstrap',
        parsed.endpoint,
        detail: parsed.ok ? '提权代理已拉起（uid 2000）' : parsed.message,
        ok: parsed.ok,
      );
      return parsed;
    } catch (e) {
      return ElevationBootstrapResult(
        ok: false,
        message: '自举失败：$e',
      );
    }
  }

  /// 让 App 自己找本机的无线调试端点（mDNS）。
  ///
  /// 找不到时返回空串——调用方要能接受「自动找失败，改成手填」这一种结果，
  /// 而不是把空串当成错误。
  static Future<String> discoverElevationEndpoint() async {
    try {
      final result = await _channel.invokeMethod('elevationDiscover');
      return result['endpoint']?.toString() ?? '';
    } catch (_) {
      return '';
    }
  }

  /// 跳到无线调试开关所在的页面。
  ///
  /// 原生侧是一条回退链（实测 2026-11-18）：先试无线调试页本身
  /// （`SubSettings` + fragment extra），这台设备因 StepOS 私有权限会被拒；
  /// 再落到**包含**它的开发者选项页（实测可用）；最后才是设置根页。
  /// 回执里的 `message` 会说明落在哪一页——跳到了哪一页和「试过最好的那一跳」
  /// 是两件事，用户要知道自己该在屏幕上找什么。
  ///
  /// 只做跳转，不代按——开无线调试是系统决定，App 能带你去，不能替你按。
  static Future<bool> openWirelessDebuggingSettings() async {
    try {
      final result = await _channel.invokeMethod('openWirelessDebuggingSettings');
      return result['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  /// 旧名，保留给尚未 rebuild 的调用方；语义与 [openWirelessDebuggingSettings] 相同。
  static Future<bool> openDeveloperSettings() => openWirelessDebuggingSettings();

  /// 发通知栏收码通知（带内联输入 + 跳转无线调试）。
  ///
  /// 为什么配对码走通知栏：实测 2026-11-18，配对端点只在「使用配对码配对设备」
  /// 弹窗存续期间存在，而用户一切回 App 填码，设置页就被 stop、弹窗关闭、
  /// 服务从 mDNS 消失——**在 App 里输码这条路在平台上就走不通**。
  /// 通知栏只让设置页 pause，弹窗活着，所以收码位置必须在通知栏。
  static Future<bool> postPairingPrompt() async {
    try {
      final result = await _channel.invokeMethod('postPairingPrompt');
      return result['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  /// 用 6 位配对码把本 App 的密钥授权给本机的 adbd（2026-11-17 起的主路径）。
  ///
  /// 前提：手机正开着「使用配对码配对设备」弹窗（配对端点只在弹窗存续期间
  /// 存在）。配对码只进 SPAKE2 口令，不写日志、不落盘、不回传。
  /// 配对成功不等于代理已拉起——拉起走 [bootstrapElevation]，两步分开，
  /// 失败才能说清是哪一步失败。
  static Future<ElevationPairResult> pairElevation(String code) async {
    try {
      final result = await _channel.invokeMethod('elevationPair', {'code': code});
      final parsed = ElevationPairResult(
        ok: result['ok'] == true,
        message: result['message']?.toString() ?? '',
        detail: result['detail']?.toString() ?? '',
        endpoint: result['endpoint']?.toString() ?? '',
        fingerprint: result['fingerprint']?.toString() ?? '',
      );
      // 审计（T10）：配对属于「必须可查」的四类事件之一。detail 里只有结果
      // 与端点，绝不含配对码——码只进过 SPAKE2 口令，此后就没了。
      await AuditLog.instance.record(
        AuditSource.user,
        'elevation.pair',
        parsed.endpoint,
        detail: parsed.ok ? '配对成功' : '配对失败：${parsed.message}',
        ok: parsed.ok,
      );
      return parsed;
    } catch (e) {
      await AuditLog.instance.record(
        AuditSource.user,
        'elevation.pair',
        '',
        detail: '配对调用失败：$e',
        ok: false,
      );
      return ElevationPairResult(ok: false, message: '配对失败：$e');
    }
  }

  /// 开/关提权开关。
  ///
  /// 关闭时原生侧会尽力让运行中的提权代理自杀（它以 uid 2000 跑着，App 自己
  /// 杀不掉它，只能请它自己动手），之后的 exec 全部落回 App 层。
  /// 返回的 message 是给用户看的中文句子。
  static Future<ElevationPairResult> setElevationEnabled(bool enabled) async {
    try {
      final result = await _channel.invokeMethod('elevationSetEnabled', {
        'enabled': enabled,
      });
      final parsed = ElevationPairResult(
        ok: result['ok'] == true,
        message: result['message']?.toString() ?? '',
      );
      // 审计（T10）：开关切换是「降级」类事件的入口——关掉提权的那一刻
      // 就是「承诺以后不再用 uid 2000」的那一刻，必须留痕。
      await AuditLog.instance.record(
        AuditSource.user,
        'elevation.toggle',
        '',
        detail: enabled ? '提权开关：开' : '提权开关：关（后续 exec 全部回落 App 层）',
        ok: parsed.ok,
      );
      return parsed;
    } catch (e) {
      return ElevationPairResult(ok: false, message: '切换失败：$e');
    }
  }

  /// 提权自举的桥入口（2026-11-17）：配对、拉起、开关、状态一个动作。
  ///
  /// 与 Flutter 引导页那套按钮共用原生侧同一份实现（ElevationBootstrap）——
  /// UI 点得动、桥调得动，说的才是同一件事。
  ///
  /// [code] 只在 op=pair 时有意义，且只以字符串形态流经本方法：不写日志、
  /// 不落盘、不进审计 detail（审计只记「配对成功/失败」与设备 GUID）。
  static Future<ElevationPairResult> elevate(
    String op, {
    String code = '',
    String endpoint = '',
  }) async {
    try {
      final result = await _channel.invokeMethod('elevateTool', {
        'op': op,
        'code': code,
        'endpoint': endpoint,
      });
      final parsed = ElevationPairResult(
        ok: result['ok'] == true,
        message: result['message']?.toString() ?? '',
        detail: result['detail']?.toString() ?? '',
        endpoint: result['endpoint']?.toString() ?? '',
      );
      // 审计（T10）：配对与拉起各记一条。detail 里**绝不**放配对码。
      if (op == 'pair') {
        await AuditLog.instance.record(
          AuditSource.user,
          'elevation.pair',
          parsed.endpoint,
          detail: parsed.ok ? '配对成功' : '配对失败：${parsed.message}',
          ok: parsed.ok,
        );
      } else if (op == 'raise') {
        await AuditLog.instance.record(
          AuditSource.user,
          'elevation.bootstrap',
          parsed.endpoint,
          detail: parsed.ok ? '提权代理已拉起（uid 2000）' : parsed.message,
          ok: parsed.ok,
        );
      }
      return parsed;
    } catch (e) {
      return ElevationPairResult(ok: false, message: '提权动作失败：$e');
    }
  }

  /// Run a privileged shell command through 提权代理 when available,
  /// otherwise fall back to the plain restricted shell.
  ///
  /// 提权路径的爆炸半径比普通 shell 大（提权代理 uid 能碰的东西更多），
  /// 所以**判定必须发生在提权之前**：危险命令连 提权代理 的状态查询都不该触发。
  ///
  /// [source] 的口径与 [execShell] 一致：默认 AI，用户手动触发的调用显式传
  /// [AuditSource.user]。无论走提权还是降级，这一条命令在审计里都**只记一次**。
  static Future<ShellResult> execShellElevated(
    String command, {
    AuditSource source = AuditSource.ai,
    int timeoutSeconds = 30,
  }) async {
    final denied = ShellCommandGuard.reason(command);
    if (denied != null) {
      final blocked = ShellResult(
        success: false,
        stdout: '',
        stderr: '命令被安全护栏拒绝：$denied',
        exitCode: -1,
      );
      await _auditShell(source, 'shell.elevated', command, blocked);
      return blocked;
    }
    final status = await getElevationStatus();
    if (status.available) {
      try {
        final result = await _channel.invokeMethod('elevatedShell', {
          'command': command,
          'timeout': timeoutSeconds,
        });
        final via = result['via']?.toString() ?? 'elevation';
        if (via == 'elevation' || result['success'] == true) {
          final shell = ShellResult(
            success: result['success'] == true,
            stdout: result['stdout'] ?? '',
            stderr: result['stderr'] ?? '',
            exitCode: result['exitCode'] ?? -1,
            code: result['code']?.toString() ?? '',
          );
          await _auditShell(source, 'shell.elevated', command, shell);
          return shell;
        }
        // 提权代理 was available but the command still failed: surface it.
        final failed = ShellResult(
          success: false,
          stdout: '',
          stderr: result['message']?.toString() ?? 'sidecar 执行失败',
          exitCode: result['exitCode'] ?? -1,
          code: result['code']?.toString() ?? '',
        );
        await _auditShell(source, 'shell.elevated', command, failed);
        return failed;
      } catch (_) {
        // fall through to the plain shell
      }
    }
    final plain = await _runShell(command, timeoutSeconds);
    await _auditShell(
      source,
      'shell.elevated',
      command,
      plain,
      note: 'sidecar 未就绪，已改由 App uid 通道执行（B 类命令会被结构化拒绝）',
    );
    return plain;
  }

  // ==================== Permissions ====================

  /// Check all permission statuses
  static Future<PermissionStatus> checkPermissions() async {
    try {
      final result = await _channel.invokeMethod('checkPermissions');
      return PermissionStatus(
        notifications: result['notifications'] == true,
        overlay: result['overlay'] == true,
        accessibility: result['accessibility'] == true,
      );
    } catch (e) {
      return const PermissionStatus(
        notifications: false,
        overlay: false,
        accessibility: false,
      );
    }
  }

  /// Request notification permission (Android 13+)
  static Future<void> requestNotifications() async {
    try {
      await _channel.invokeMethod('requestNotifications');
    } catch (e) {}
  }

  /// Request overlay permission (display over other apps)
  static Future<void> requestOverlay() async {
    try {
      await _channel.invokeMethod('requestOverlay');
    } catch (e) {}
  }

  /// Open accessibility settings to enable the service
  static Future<void> requestAccessibility() async {
    try {
      await _channel.invokeMethod('requestAccessibility');
    } catch (e) {}
  }

  // ==================== Bridge（khy-os 桥） ====================

  /// 桥状态快照。令牌只回掩码——完整值只在设备上的
  /// /sdcard/bridge-amoobridge/token.txt，PC 侧 khy-os 自己读。
  static Future<BridgeStatus> bridgeStatus() async {
    try {
      final result = await _channel.invokeMethod('bridgeStatus');
      return BridgeStatus(
        online: result['online'] == true,
        port: result['port'] is int ? result['port'] as int : 0,
        tokenMasked: result['tokenMasked']?.toString() ?? '',
        // 旧版原生侧没有这个字段时判「未知」（null），不判失败。
        tokenPersisted: result['tokenPersisted'] is bool
            ? result['tokenPersisted'] as bool
            : null,
        uiReady: result['uiReady'] == true,
        toolCount: result['toolCount'] is int ? result['toolCount'] as int : 0,
        overlayRunning: result['overlayRunning'] == true,
        overlayGranted: result['overlayGranted'] == true,
        allFiles: result['allFiles'] == true,
        pcReachable: result['pcReachable'] is bool ? result['pcReachable'] as bool : null,
      );
    } catch (e) {
      return const BridgeStatus();
    }
  }

  /// 启动桥（连带悬浮框；无悬浮窗权限时悬浮框不画，桥照常）。
  ///
  /// 返回结果而不是 void：桥起停是用户在这个开关上做的决定，失败时 UI 必须
  /// 能摆出原因，不能让开关翻过去又悄悄弹回来。
  static Future<BridgeCallResult> bridgeStart() async {
    return _bridgeCall('bridgeStart', 'started');
  }

  /// 停止桥（连带撤掉悬浮框）。
  static Future<BridgeCallResult> bridgeStop() async {
    return _bridgeCall('bridgeStop', 'stopped');
  }

  /// 只显示悬浮框，不动桥。无悬浮窗权限时原生侧直接回 ok=false。
  static Future<BridgeCallResult> overlayShow() async {
    return _bridgeCall('overlayShow', 'shown');
  }

  /// 只隐藏悬浮框，不停桥。
  static Future<BridgeCallResult> overlayHide() async {
    return _bridgeCall('overlayHide', 'hidden');
  }

  /// 桥这一族方法的统一收口：一律 `result.success(Map)`，布尔键 + message
  /// 兜底。原生侧从不用 result.error（全通道唯一例外是 openAccessibilitySettings），
  /// 而 Dart 侧也必须自己吞掉异常——抛上来会被上层 catch 成「什么都没发生」，
  /// 表现为开关点了没反应。
  ///
  /// [key] 是这一族的布尔键名（started / stopped / shown / hidden）。旧版原生
  /// 侧不上报这个键，于是 `r[key] == true` 判 false，即「不知道就当没成功」，
  /// 不会把一次沉默的旧包显示成成功。
  static Future<BridgeCallResult> _bridgeCall(
      String method, String key) async {
    try {
      final r = await _channel.invokeMethod(method);
      if (r is Map) {
        return BridgeCallResult(
          ok: r[key] == true,
          message: r['message']?.toString() ?? '',
        );
      }
      return BridgeCallResult.empty;
    } catch (e) {
      return BridgeCallResult(ok: false, message: '$e');
    }
  }

  /// 打开「所有文件访问」设置页（Android 11+；桥的文件信箱与工作区同步需要）。
  static Future<void> requestAllFilesAccess() async {
    try {
      await _channel.invokeMethod('requestAllFiles');
    } catch (e) {}
  }

  // ==================== Smart Search ====================

  /// Smart search: semantic map first, then fuzzy match against installed apps.
  /// Returns null when nothing in the installed set matches the query —
  /// we never silently substitute an unrelated app.
  static Future<AppInfo?> findApp(String query) async {
    final q = query.toLowerCase().trim();
    if (q.isEmpty) return null;

    // 1. Semantic map for common Chinese/English app names (fast path,
    //    does not depend on launcher enumeration returning the target).
    for (final entry in _semanticMap.entries) {
      final key = entry.key.toLowerCase();
      if (q == key || q.contains(key) || key.contains(q)) {
        final installed = await listApps();
        for (final pkg in entry.value) {
          AppInfo? match;
          for (final a in installed) {
            if (a.packageName.toLowerCase() == pkg.toLowerCase()) {
              match = a;
              break;
            }
          }
          if (match != null) return match;
        }
      }
    }

    // 2. Fuzzy match against installed launcher apps
    final apps = await searchApps(q);
    if (apps.isEmpty) return null;

    // 3. Exact package match
    for (final app in apps) {
      if (app.packageName.toLowerCase() == q) return app;
    }

    // 4. Exact label match
    for (final app in apps) {
      if (app.label.toLowerCase() == q) return app;
    }

    // 5. Label contains query (bidirectional)
    for (final app in apps) {
      final label = app.label.toLowerCase();
      if (label.contains(q) || (q.length > 1 && q.contains(label))) return app;
    }

    // 6. Package name contains query
    for (final app in apps) {
      if (app.packageName.toLowerCase().contains(q)) return app;
    }

    // No confident match: never fall back to an arbitrary first app.
    return null;
  }

  /// Comprehensive semantic app name mapping (30+ common apps)
  static const Map<String, List<String>> _semanticMap = {
    // Communication
    '微信': ['com.tencent.mm'],
    'wechat': ['com.tencent.mm'],
    'weixin': ['com.tencent.mm'],
    'qq': ['com.tencent.mobileqq'],
    '钉钉': ['com.alibaba.android.rimet'],
    'dingtalk': ['com.alibaba.android.rimet'],
    '飞书': ['com.ss.android.lark'],
    'feishu': ['com.ss.android.lark'],
    'lark': ['com.ss.android.lark'],
    'telegram': ['org.telegram.messenger'],
    'whatsapp': ['com.whatsapp'],
    // Browser
    '浏览器': ['com.android.chrome', 'com.UCMobile', 'org.mozilla.firefox', 'com.quark.browser'],
    'chrome': ['com.android.chrome'],
    '谷歌': ['com.android.chrome'],
    'uc': ['com.UCMobile'],
    '夸克': ['com.quark.browser'],
    '百度': ['com.baidu.searchbox'],
    'baidu': ['com.baidu.searchbox'],
    // Social
    '抖音': ['com.ss.android.ugc.aweme'],
    'douyin': ['com.ss.android.ugc.aweme'],
    'b站': ['tv.danmaku.bili', 'com.bilibili.app.in'],
    'bilibili': ['tv.danmaku.bili'],
    '哔哩哔哩': ['tv.danmaku.bili'],
    '微博': ['com.sina.weibo'],
    'weibo': ['com.sina.weibo'],
    '小红书': ['com.xingin.xhs'],
    '知乎': ['com.zhihu.android'],
    'zhihu': ['com.zhihu.android'],
    // Shopping
    '淘宝': ['com.taobao.taobao'],
    'taobao': ['com.taobao.taobao'],
    '天猫': ['com.taobao.taobao'],
    '京东': ['com.jingdong.app.mall'],
    'jd': ['com.jingdong.app.mall'],
    '拼多多': ['com.xunmeng.pinduoduo'],
    'pinduoduo': ['com.xunmeng.pinduoduo'],
    '美团': ['com.sankuai.meituan'],
    'meituan': ['com.sankuai.meituan'],
    '外卖': ['com.sankuai.meituan', 'ele.me'],
    '饿了么': ['ele.me'],
    // Payment
    '支付宝': ['com.eg.android.AlipayGphone'],
    'alipay': ['com.eg.android.AlipayGphone'],
    // Maps
    '地图': ['com.autonavi.minimap'],
    '高德': ['com.autonavi.minimap'],
    'amap': ['com.autonavi.minimap'],
    '导航': ['com.autonavi.minimap'],
    // System
    '设置': ['com.android.settings'],
    'settings': ['com.android.settings'],
    '相机': ['com.android.camera', 'com.android.camera2'],
    'camera': ['com.android.camera'],
    '拍照': ['com.android.camera'],
    '相册': ['com.android.gallery3d', 'com.google.android.apps.photos'],
    '照片': ['com.android.gallery3d'],
    '电话': ['com.android.dialer', 'com.google.android.dialer'],
    '拨号': ['com.android.dialer'],
    '短信': ['com.android.mms', 'com.google.android.apps.messaging'],
    // Media
    '音乐': ['com.netease.cloudmusic', 'com.kugou.android'],
    '网易云': ['com.netease.cloudmusic'],
    '酷狗': ['com.kugou.android'],
    '视频': ['com.youku.phone', 'com.tencent.qqlive'],
    'youtube': ['com.google.android.youtube'],
    'tiktok': ['com.zhiliaoapp.musically'],
    // Utility
    '计算器': ['com.android.calculator2'],
    '天气': ['com.miui.weather2', 'cn.wildroid.weather'],
    '便签': ['com.miui.notes', 'com.miui.notepad'],
    '日历': ['com.android.calendar'],
    '时钟': ['com.android.deskclock'],
    '文件': ['com.android.fileexplorer', 'com.google.android.apps.nbu.files'],
    // International
    'twitter': ['com.twitter.android'],
    'x': ['com.twitter.android'],
    'instagram': ['com.instagram.android'],
    'netflix': ['com.netflix.mediaclient'],
    'spotify': ['com.spotify.music'],
  };
}

class AppInfo {
  final String label;
  final String packageName;

  const AppInfo({required this.label, required this.packageName});

  @override
  String toString() => '$label ($packageName)';
}

class ShellResult {
  final bool success;
  final String stdout;
  final String stderr;
  final int exitCode;

  /// 结构化拒绝码。空 = 命令确实跑了（成功或普通失败）。
  ///
  /// 目前只有 `needs_shell`（旧名 `elevation_required`，仍被识别）：B 类命令在
  /// App uid 下不会生效，原生侧直接拒绝并把原因放在 [stderr]，调用方靠这个码
  /// 区分「跑失败了」和「根本没跑」。
  ///
  /// 改名理由：旧名描述的是原因（需要提权），调用方需要知道的是缺了什么
  /// （shell 层，uid 2000）——那是用户能自己去补上的东西。
  final String code;

  /// 这条命令是否因为「没有 shell 层」而被拒绝。
  bool get needsShell => code == 'needs_shell' || code == 'elevation_required';

  const ShellResult({
    required this.success,
    required this.stdout,
    required this.stderr,
    required this.exitCode,
    this.code = '',
  });
}

/// 提权代理 availability on this device.
class ElevationStatus {
  final bool installed;
  final bool running;
  final String version;

  /// PING 通了但还没有一次 exec 成功过（原生 ShellSidecarClient.online）。
  ///
  /// 与 available 的区别是"没响应"和"通了但未证实"。available 刻意悲观，
  /// 所以刚 provision 完的那段窗口里它是 false 而 sidecar 其实通着；界面若要
  /// 决定"这个入口该不该灰"，用 canAttempt 而不是 available。
  final bool online;

  /// 为什么没就绪，中文；原生侧 elevationStatus 的 reason 键原样带回
  /// （MainActivity.elevationStatus）。空 = 没有具体原因，调用方自行给兜底文案。
  final String reason;

  /// 提权开关（用户的意图）。默认关——任务书红线：提权默认关闭，
  /// 开启需用户显式确认并知晓风险。
  final bool enabled;

  /// 当前层（设备的事实）：`none` 或 `shell`。开关开着而代理没起来时，
  /// enabled=true 而 elevatedLevel='none'——两个词各说各的，不许合成一个。
  final String elevatedLevel;

  /// 设备对本 App 密钥的授权态：unpaired | paired | expired。
  /// 「曾经配对过」不等于「现在还被信任」，撤销必须显示为 expired/unpaired。
  final String deviceAuth;

  /// 最近一次配对成功的时间（epoch ms；0 = 从未配对）。T5 的判据。
  final int lastPairMs;

  const ElevationStatus({
    this.installed = false,
    this.running = false,
    this.online = false,
    this.version = '',
    this.reason = '',
    this.enabled = false,
    this.elevatedLevel = 'none',
    this.deviceAuth = 'unpaired',
    this.lastPairMs = 0,
  });

  /// True when the shell sidecar answered its probe (started and reachable).
  bool get available => installed && running;

  /// 现在发起一次 B 类操作有没有胜算。
  ///
  /// 只用于界面置灰判断，不放宽 execShellElevated 的前置检查——那条路径
  /// 要的是 available 这种强证据。
  bool get canAttempt => available || online;

  /// 设备是否已授权本 App 的密钥（配对过，且未被撤销/过期）。
  bool get isPaired => deviceAuth == 'paired';

  @override
  String toString() =>
      available
          ? '提权代理 已就绪（uid 2000）'
          : (online
              ? '提权代理 在线但待首次执行确认'
              : '提权代理 未就绪${reason.isEmpty ? '' : '：$reason'}');
}

/// 配对 / 开关切换这类一次性动作的结果。
///
/// [message] 是给用户看的中文句子；[detail] 是技术细节，失败时才看。
/// 配对码**绝不**出现在任何一个字段里——它只进 SPAKE2 口令。
class ElevationPairResult {
  final bool ok;
  final String message;
  final String detail;
  final String endpoint;
  final String fingerprint;

  const ElevationPairResult({
    this.ok = false,
    this.message = '',
    this.detail = '',
    this.endpoint = '',
    this.fingerprint = '',
  });
}

/// 自举提权的端点与身份指纹。
class ElevationEndpoint {
  /// 无线调试的连接端点，形如 "192.168.1.7:37129"。空 = 还没填。
  final String endpoint;

  /// 本 App 的 adb 身份指纹（公钥的短哈希），配对时用来核对是不是同一把钥匙。
  final String fingerprint;

  const ElevationEndpoint({this.endpoint = '', this.fingerprint = ''});

  /// 端点是否已经填好。
  bool get ready => endpoint.isNotEmpty;
}

/// 一次自举的结果。
class ElevationBootstrapResult {
  /// 提权代理是否已经就绪。
  final bool ok;

  /// 给用户看的中文句子（成功时也有一句，例如「提权代理已就绪」）。
  final String message;

  /// 技术细节：失败时的错误信息或设备侧日志。空 = 没有。
  final String detail;

  /// 当前记住的无线调试端点。
  final String endpoint;

  /// 本 App 的 adb 身份指纹。
  final String fingerprint;

  const ElevationBootstrapResult({
    this.ok = false,
    this.message = '',
    this.detail = '',
    this.endpoint = '',
    this.fingerprint = '',
  });
}


/// 桥的起停与悬浮框显隐的统一回执。
///
/// 之所以不能像原来那样 catch 完静默返回 void：做成真开关之后，调用方必须
/// 区分「成功」和「抛异常了」，否则开关会翻过去又弹回来，看起来像 bug。
/// ok 来自原生侧的布尔键，message 是原生给的兜底文案（失败时为中文原因）。
class BridgeCallResult {
  const BridgeCallResult({required this.ok, required this.message});

  static const empty =
      BridgeCallResult(ok: false, message: '原生侧没有返回结果');

  final bool ok;
  final String message;
}

/// Permission status for all required permissions
/// 桥状态快照（设备侧 → Dart）。字段与 MainActivity.bridgeStatus 的 map 对齐。
class BridgeStatus {
  final bool online;
  final int port;
  final String tokenMasked;
  /// 令牌是否已落盘（PC 侧才能读到 token.txt）。null = 旧版未上报，判「未知」。
  final bool? tokenPersisted;
  final bool uiReady;
  final int toolCount;
  final bool overlayRunning;
  final bool overlayGranted;
  final bool allFiles;
  /// PC 侧最近是否在协作（桥只经 adb forward 被访问，见 HttpBridge.notePcSeen）。
  /// null = 旧版未上报。false 不是故障：手机此时在独立工作。
  final bool? pcReachable;

  const BridgeStatus({
    this.online = false,
    this.port = 0,
    this.tokenMasked = '',
    this.tokenPersisted,
    this.uiReady = false,
    this.toolCount = 0,
    this.overlayRunning = false,
    this.overlayGranted = false,
    this.allFiles = false,
    this.pcReachable,
  });

  /// 桥能不能被 PC 侧用起来：在线 + 端口已绑定。
  ///
  /// 断点二之后这里不再看 [tokenPersisted]：明文令牌已停写、旧文件已删，
  /// 那个字段现在恒为 false（保留只为老版本对照）。凭据改成「设备签发的证书 +
  /// 每请求签名」，它不在 status 快照里，而在 PC 自己的凭据文件里——拿
  /// tokenPersisted 当可用性判据会把一台好设备判成不可用。
  bool get usable => online && port > 0;
}

class PermissionStatus {
  final bool notifications;
  final bool overlay;
  final bool accessibility;

  const PermissionStatus({
    required this.notifications,
    required this.overlay,
    required this.accessibility,
  });

  bool get allGranted => notifications && overlay && accessibility;
  bool get anyMissing => !allGranted;

  List<String> get missingList {
    final list = <String>[];
    if (!notifications) list.add('通知权限');
    if (!overlay) list.add('悬浮窗权限');
    if (!accessibility) list.add('无障碍服务');
    return list;
  }

  String get summary {
    if (allGranted) return '全部已授权';
    if (missingList.isEmpty) return '未知';
    return '缺少：${missingList.join('、')}';
  }
}

/// 安装 APK 的结果。
///
/// [elevated] 是这个类存在的理由：`pm install` 在 App 自身 uid 上会"成功"返回
/// 而什么都没装。不把执行身份回报出来，调用方就无法分辨"装好了"和"根本没装"，
/// 而这两件事在界面上长得一模一样。
class InstallResult {
  final bool ok;
  final String code;
  final String error;
  final String stdout;
  final String stderr;

  /// 实际执行身份（sidecar / app）。
  final String via;

  /// 是否经提权执行。false 时安装不会生效，无论 stdout 说什么。
  final bool elevated;

  const InstallResult({
    required this.ok,
    this.code = '',
    this.error = '',
    this.stdout = '',
    this.stderr = '',
    this.via = '',
    this.elevated = false,
  });
}