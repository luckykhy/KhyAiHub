// khy-canary: Khy-20261101-085-048B50CF
import 'package:flutter/services.dart';
import 'screen_metrics.dart';

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

  /// 执行这条命令的通道：sidecar / shizuku / app。
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
  /// 走了哪条通道（sidecar / shizuku / app）。**这不是静默操作**——调用方
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
  static Future<ShellResult> execShell(String command, {int timeoutSeconds = 30}) async {
    try {
      final result = await _channel.invokeMethod('shell', {'command': command, 'timeout': timeoutSeconds});
      return ShellResult(
        success: result['success'] == true,
        stdout: result['stdout'] ?? '',
        stderr: result['stderr'] ?? '',
        exitCode: result['exitCode'] ?? -1,
      );
    } catch (e) {
      return ShellResult(success: false, stdout: '', stderr: e.toString(), exitCode: -1);
    }
  }

  // ==================== APK Install ====================

  /// 安装一个本地 APK。
  ///
  /// 为什么单独一条而不是复用 [execShell]：
  /// [execShell] 跑在 App 自己的 uid 上，没有 INSTALL_PACKAGES——命令会"成功"
  /// 返回而什么都没装。这条走原生层的 installApk，它经
  /// `Tools.exec`（sidecar → Shizuku → App uid）逐级尝试，并把实际执行身份
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

  // ==================== Shizuku (privilege without root) ====================
  //
  // Shizuku lets this app borrow the system app's uid to run privileged
  // shell commands (am / input / pm / screencap / dumpsys) on a non-root
  // phone. Nothing below does any harm if Shizuku is not installed: each
  // check degrades to "not available" and callers fall back to the plain
  // (restricted) shell.

  /// Query whether Shizuku is installed and its provider is reachable.
  static Future<ShizukuStatus> getShizukuStatus() async {
    try {
      final result = await _channel.invokeMethod('shizukuStatus');
      return ShizukuStatus(
        installed: result['installed'] == true,
        running: result['running'] == true,
        version: result['version']?.toString() ?? '',
      );
    } catch (_) {
      return const ShizukuStatus();
    }
  }

  /// Run a privileged shell command through Shizuku when available,
  /// otherwise fall back to the plain restricted shell.
  static Future<ShellResult> execShellElevated(
    String command, {
    int timeoutSeconds = 30,
  }) async {
    final status = await getShizukuStatus();
    if (status.available) {
      try {
        final result = await _channel.invokeMethod('shizukuShell', {
          'command': command,
          'timeout': timeoutSeconds,
        });
        final via = result['via']?.toString() ?? 'shizuku';
        if (via == 'shizuku' || result['success'] == true) {
          return ShellResult(
            success: result['success'] == true,
            stdout: result['stdout'] ?? '',
            stderr: result['stderr'] ?? '',
            exitCode: result['exitCode'] ?? -1,
          );
        }
        // Shizuku was available but the command still failed: surface it.
        return ShellResult(
          success: false,
          stdout: '',
          stderr: result['message']?.toString() ?? 'Shizuku 执行失败',
          exitCode: result['exitCode'] ?? -1,
        );
      } catch (_) {
        // fall through to the plain shell
      }
    }
    return execShell(command, timeoutSeconds: timeoutSeconds);
  }

  /// Result of an auto-install attempt.
  /// Trigger installation of the bundled Shizuku APK. The user still has to
  /// confirm the install once in the system package installer (Android
  /// security), but never has to download Shizuku from a store.
  static Future<ShizukuInstallOutcome> autoInstallShizuku() async {
    try {
      final result = await _channel.invokeMethod('shizukuAutoInstall');
      return ShizukuInstallOutcome(
        triggered: result['triggered'] == true,
        reason: result['reason']?.toString() ?? '',
      );
    } catch (e) {
      return ShizukuInstallOutcome(triggered: false, reason: '通道错误: $e');
    }
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

  const ShellResult({
    required this.success,
    required this.stdout,
    required this.stderr,
    required this.exitCode,
  });
}

/// Shizuku availability on this device.
class ShizukuStatus {
  final bool installed;
  final bool running;
  final String version;

  const ShizukuStatus({this.installed = false, this.running = false, this.version = ''});

  /// True when Shizuku is installed AND its provider IPC is reachable.
  bool get available => installed && running;

  @override
  String toString() =>
      available
          ? 'Shizuku v$version 已就绪'
          : (installed
              ? 'Shizuku 已安装但未启动 (v$version)'
              : '未安装 Shizuku');
}

/// Outcome of [DeviceControl.autoInstallShizuku].
class ShizukuInstallOutcome {
  final bool triggered;
  final String reason;

  const ShizukuInstallOutcome({required this.triggered, required this.reason});
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

  /// 桥能不能被 PC 侧用起来：在线 + 令牌已在设备上落盘。落盘状态未知
  /// （旧版未上报）不算失败——只把明确知道「没落盘」的情形拒掉。
  bool get usable => online && port > 0 && tokenPersisted != false;
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

  /// 实际执行身份（sidecar / shizuku / app）。
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
