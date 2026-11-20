// khy-canary: Khy-20261101-092-78P22W4X
//
// ⚠️ **本文件当前是死代码**：`createAndroidTool()` 在全仓只有一个引用——它自己
// 的定义。没有任何地方把它注册进 `ToolEngine`，所以这个工具在 App 里**根本不
// 存在**，模型看不到它，用户也调不到它。
//
// 不是「先凑合」，是一个已知的未接线项，写在这里免得下一个人（人或 AI）以为
// 它生效了——尤其是它描述得相当完整（15 个子命令、参数 schema 齐全），
// 很容易被误认为是活的。
//
// 为什么不删：文件登记在 `scripts/release/canary-manifest.json` 与
// `[DESIGN-LAY-008]` 附录A 的文件去向表里，删文件会触发守卫；而且「要不要把
// 这 15 个子命令合成一个工具」是产品决策（§9.35 记过同一类事）。
// **要接线还是删除，等拍板。**
import 'dart:async';
import 'tool_engine.dart';
import '../services/device_control.dart';
import '../services/file_service.dart';
import '../services/shell_command_guard.dart';

/// Unified professional Android system tool.
/// One tool, many subcommands - easier for LLM than 15 fragmented tools.
List<ToolDef> createAndroidTool() => [
  ToolDef(
    name: 'android',
    description:
        'Android system ops (unified). Use cmd for subcommand, action+args for details. '
        'cmds: system|shell|app|screen|input|file|network|process|settings|log',
    inputSchema: {
      'type': 'object',
      'properties': {
        'cmd': {
          'type': 'string',
          'enum': ['system','shell','app','screen','input','file','network','process','settings','log'],
        },
        'action': {'type': 'string', 'description': 'sub-action: open/stop/dump/capture/tap/swipe/text/key/list/read/write/mkdir/get/set'},
        'args': {'type': 'object', 'description': 'parameters: package, url, x, y, text, key, path, content, command, prop, key_setting, value'},
      },
      'required': ['cmd'],
    },
    execute: (toolArgs) async {
      final cmd = toolArgs['cmd'] ?? '';
      final action = toolArgs['action'] ?? '';
      final args = (toolArgs['args'] as Map<String, dynamic>?) ?? {};

      switch (cmd) {
        case 'system':
          return _cmdSystem(args);
        case 'shell':
          return _cmdShell(args);
        case 'app':
          return _cmdApp(action, args);
        case 'screen':
          return _cmdScreen(action, args);
        case 'input':
          return _cmdInput(action, args);
        case 'file':
          return _cmdFile(action, args);
        case 'network':
          return _cmdNetwork(args);
        case 'process':
          return _cmdProcess(args);
        case 'settings':
          return _cmdSettings(action, args);
        case 'log':
          return _cmdLog(args);
        default:
          return ToolResult.fail('unknown cmd: $cmd. Valid: system|shell|app|screen|input|file|network|process|settings|log');
      }
    },
    tags: ['android', 'system'],
  ),
];

// --- system ---
Future<ToolResult> _cmdSystem(Map<String, dynamic> args) async {
  if (args['prop'] != null) {
    final prop = args['prop'] as String;
    final r = await DeviceControl.execShell('getprop $prop');
    return r.success ? ToolResult.ok('$prop=${r.stdout.trim()}') : ToolResult.fail(r.stderr);
  }
  final info = await DeviceControl.getDeviceInfo();
  final json = info.entries.map((e) => '"${e.key}":"${e.value}"').join(',');
  return ToolResult.ok('{$json}');
}

// --- shell ---
Future<ToolResult> _cmdShell(Map<String, dynamic> args) async {
  final command = args['command'] as String? ?? '';
  if (command.isEmpty) return ToolResult.fail('provide args.command');
  final timeout = args['timeout'] as int? ?? 30;
  final r = await DeviceControl.execShell(command, timeoutSeconds: timeout);
  if (r.success) {
    final out = r.stdout.trim();
    return ToolResult.ok(out.isNotEmpty ? out : '(ok, no output)');
  }
  return ToolResult.fail('exit=${r.exitCode}: ${r.stderr.trim()}', );
}

// --- app ---
Future<ToolResult> _cmdApp(String action, Map<String, dynamic> args) async {
  switch (action) {
    case 'open':
    case '':
      final q = args['query'] as String? ?? args['package'] as String? ?? '';
      if (q.isEmpty) return ToolResult.fail('provide args.query or args.package');
      if (q.startsWith('http')) {
        final ok = await DeviceControl.openUrl(q);
        return ok ? ToolResult.ok('opened $q') : ToolResult.fail('open failed: $q');
      }
      final app = await DeviceControl.findApp(q);
      if (app == null) return ToolResult.fail('$q not installed. Suggest user install it.');
      final ok = await DeviceControl.openApp(app.packageName);
      return ok ? ToolResult.ok('opened ${app.label} (${app.packageName})') : ToolResult.fail('launch failed: ${app.label}');
    case 'stop':
    case 'force':
      final pkg = args['package'] as String? ?? '';
      if (pkg.isEmpty) return ToolResult.fail('provide args.package');
      final r = await DeviceControl.execShell('am force-stop $pkg');
      return r.success ? ToolResult.ok('stopped $pkg') : ToolResult.fail(r.stderr);
    case 'list':
      final q = args['query'] as String? ?? '';
      final apps = await DeviceControl.searchApps(q);
      if (apps.isEmpty) return ToolResult.fail('no apps match "$q"');
      final lines = apps.take(15).map((a) => a.label + ' (' + a.packageName + ')').join('\n');
      return ToolResult.ok(lines);
    default:
      return ToolResult.fail('app action: open|stop|force|list');
  }
}

// --- screen ---
Future<ToolResult> _cmdScreen(String action, Map<String, dynamic> args) async {
  switch (action) {
    case 'capture':
    case '':
      if (!await DeviceControl.isScreenCaptureReady()) {
        final ok = await DeviceControl.startScreenCapture();
        if (!ok) return ToolResult.fail('screen capture not authorized. Grant permission in system settings.');
        await Future.delayed(const Duration(seconds: 1));
      }
      final data = await DeviceControl.captureFrame();
      if (data == null) return ToolResult.fail('capture failed');
      return ToolResult.ok('captured (${data.length} chars base64)', metadata: {'imageData': data});
    case 'dump':
      if (!await DeviceControl.isAccessibilityReady()) {
        return ToolResult.fail('accessibility service not enabled. Enable in system settings first.');
      }
      final dump = await DeviceControl.a11yDumpUi();
      return dump.isEmpty ? ToolResult.ok('UI tree empty') : ToolResult.ok(dump.length > 3000 ? dump.substring(0, 3000) : dump);
    case 'click':
    case 'find_click':
      final q = args['query'] as String? ?? '';
      if (q.isEmpty) return ToolResult.fail('provide args.query');
      if (!await DeviceControl.isAccessibilityReady()) {
        return ToolResult.fail('accessibility service not enabled.');
      }
      final ok = await DeviceControl.a11yFindAndClick(q);
      return ok ? ToolResult.ok('clicked "$q"') : ToolResult.fail('"$q" not found on screen');
    default:
      return ToolResult.fail('screen action: capture|dump|click|find_click');
  }
}

// --- input ---
Future<ToolResult> _cmdInput(String action, Map<String, dynamic> args) async {
  if (!await DeviceControl.isAccessibilityReady()) {
    return ToolResult.fail('accessibility service required. Enable in settings.');
  }
  switch (action) {
    case 'tap':
      final x = args['x'] as int? ?? 0;
      final y = args['y'] as int? ?? 0;
      final ok = await DeviceControl.a11yTap(x, y);
      return ok ? ToolResult.ok('tapped ($x,$y)') : ToolResult.fail('tap failed');
    case 'swipe':
      final x1 = args['x1'] as int? ?? 0;
      final y1 = args['y1'] as int? ?? 0;
      final x2 = args['x2'] as int? ?? 0;
      final y2 = args['y2'] as int? ?? 0;
      final dur = args['duration'] as int? ?? 300;
      final ok = await DeviceControl.a11ySwipe(x1, y1, x2, y2, durationMs: dur);
      return ok ? ToolResult.ok('swiped') : ToolResult.fail('swipe failed');
    case 'text':
      final t = args['text'] as String? ?? '';
      if (t.isEmpty) return ToolResult.fail('provide args.text');
      final ok = await DeviceControl.a11yTypeText(t);
      return ok ? ToolResult.ok('typed "${t.length > 30 ? t.substring(0,30)+"..." : t}"') : ToolResult.fail('input failed');
    case 'key':
      final k = args['key'] as int? ?? 3;
      final ok = await DeviceControl.a11yGlobalAction(k == 1 ? DeviceControl.globalActionBack : k == 2 ? DeviceControl.globalActionHome : k == 3 ? DeviceControl.globalActionRecents : DeviceControl.globalActionNotifications);
      return ok ? ToolResult.ok('key $k sent') : ToolResult.fail('key failed');
    default:
      return ToolResult.fail('input action: tap|swipe|text|key');
  }
}

// --- file ---
Future<ToolResult> _cmdFile(String action, Map<String, dynamic> args) async {
  final path = args['path'] as String? ?? '';
  switch (action) {
    case 'read':
      if (path.isEmpty) return ToolResult.fail('provide args.path');
      final r = await FileService.readFile(path);
      return r['success'] == true
          ? ToolResult.ok((r['content'] as String).length > 5000 ? (r['content'] as String).substring(0,5000) : r['content'] as String)
          : ToolResult.fail(r['error']?.toString() ?? 'read failed');
    case 'write':
      final content = args['content'] as String? ?? '';
      if (path.isEmpty || content.isEmpty) return ToolResult.fail('provide args.path and args.content');
      final r = await FileService.writeFile(path, content);
      return r['success'] == true ? ToolResult.ok('wrote $path (${content.length} chars)') : ToolResult.fail(r['error']?.toString() ?? 'write failed');
    case 'list':
    case '':
      final r = await FileService.listFiles(path);
      if (r['success'] == true) {
        final rawFiles = (r['files'] as List? ?? []).cast<Map>();
        final files = rawFiles.map((f) => f.map((k, v) => MapEntry(k.toString(), v))).toList();
        if (files.isEmpty) return ToolResult.ok('empty dir: $path');
        return ToolResult.ok(files.map((f) => '${f['isDir'] == true ? "D" : "F"} ${f['name']}').join('\n'));
      }
      return ToolResult.fail(r['error']?.toString() ?? 'list failed');
    case 'mkdir':
      final r = await FileService.createDir(path);
      return r['success'] == true ? ToolResult.ok('created $path') : ToolResult.fail(r['error']?.toString() ?? 'mkdir failed');
    default:
      return ToolResult.fail('file action: read|write|list|mkdir');
  }
}

// --- network ---
Future<ToolResult> _cmdNetwork(Map<String, dynamic> args) async {
  // 命令里不能有 `|`、`>` 这些 shell 控制符——原生那道闸门（MainActivity
  // .isCommandAllowed）见到就整体拒绝。所以 `| head -30` 要改成 Dart 侧截断，
  // `2>/dev/null` 直接去掉：原生把 stdout 与 stderr 分开抽，错误信息本来就在
  // stderr 里，丢掉它只会让失败看起来像成功（§9.24）。
  final r = await DeviceControl.execShell('dumpsys connectivity');
  return r.success
      ? ToolResult.ok(ShellCommandGuard.firstLines(r.stdout, 30))
      : ToolResult.fail(r.stderr);
}

// --- process ---
Future<ToolResult> _cmdProcess(Map<String, dynamic> args) async {
  final pkg = args['package'] as String? ?? '';
  if (pkg.isNotEmpty) {
    final r = await DeviceControl.execShell('dumpsys meminfo $pkg');
    return r.success
        ? ToolResult.ok(ShellCommandGuard.firstLines(r.stdout, 20))
        : ToolResult.fail(r.stderr);
  }
  final r = await DeviceControl.execShell('ps -A');
  return r.success
      ? ToolResult.ok(ShellCommandGuard.firstLines(r.stdout, 30))
      : ToolResult.fail(r.stderr);
}

// --- settings ---
Future<ToolResult> _cmdSettings(String action, Map<String, dynamic> args) async {
  final key = args['key'] as String? ?? '';
  if (key.isEmpty) return ToolResult.fail('provide args.key');
  if (action == 'get') {
    // 原来是一条 `settings get global $key 2>/dev/null || settings get secure $key
    // 2>/dev/null`：`||` 是控制符，整条命令过不了原生闸门——于是「读系统设置」
    // 在真机上是死的。改成两次调用：先 global，取不到再 secure。
    final global = await DeviceControl.execShell('settings get global $key');
    final globalValue = global.stdout.trim();
    if (global.success && globalValue.isNotEmpty) {
      return ToolResult.ok('$key=$globalValue');
    }
    final secure = await DeviceControl.execShell('settings get secure $key');
    if (secure.success) {
      final secureValue = secure.stdout.trim();
      return ToolResult.ok('$key=$secureValue');
    }
    return ToolResult.fail(_settingsFailure(global, secure));
  } else {
    final val = args['value'] as String? ?? '';
    // 同上：原来靠 `||` 回退，而那条回退**漏了 `$key`**（写成
    // `settings put secure $val`），真要触发回退时发的是条错命令。
    final global = await DeviceControl.execShell('settings put global $key $val');
    if (global.success) return ToolResult.ok('$key=$val');
    final secure = await DeviceControl.execShell('settings put secure $key $val');
    if (secure.success) return ToolResult.ok('$key=$val');
    return ToolResult.fail(_settingsFailure(global, secure));
  }
}

/// 两次调用都失败时，把**有信息的那一条**说出来。
///
/// 两个失败都要留着：global 失败可能是「键不存在」，secure 失败可能是
/// 「权限不够」——只报一条，用户就得自己猜是哪一种。
String _settingsFailure(ShellResult global, ShellResult secure) {
  final parts = <String>[
    if (global.stderr.trim().isNotEmpty) global.stderr.trim(),
    if (secure.stderr.trim().isNotEmpty) secure.stderr.trim(),
  ];
  return parts.isEmpty ? '设置读写失败' : parts.join('\n');
}

// --- log ---
Future<ToolResult> _cmdLog(Map<String, dynamic> args) async {
  final lines = args['lines'] as int? ?? 50;
  final r = await DeviceControl.execShell('logcat -d -t $lines');
  return r.success ? ToolResult.ok(r.stdout) : ToolResult.fail('logcat requires shell/root: ${r.stderr}');
}