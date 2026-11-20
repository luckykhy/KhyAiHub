// khy-canary: Khy-20261101-093-7KZJZ8KY
import 'dart:convert';
import 'dart:math';
import 'package:flutter/services.dart';
import 'package:dio/dio.dart';
import 'tool_engine.dart';
import '../services/device_control.dart';
import '../services/file_service.dart';
import '../gateway/zen_gate.dart';
import 'skills.dart';
import 'vision_tools.dart';
import '../config/app_config.dart';
import '../services/amoo_chat_service.dart';

/// All built-in tools for the Flutter client
List<ToolDef> createBuiltinTools() => [
  // ---- App Control ----
  ToolDef(
    name: 'open_app',
    description: '打开手机上的任意应用（统一入口）。支持中文名、英文名、拼音、包名。如: "微信"、"Baidu"、"qq"、"com.android.chrome"。也支持直接传 URL 打开网页。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'query': {'type': 'string', 'description': '应用名称或包名，如 "浏览器"、"微信"、"com.android.chrome"'},
      },
      'required': ['query'],
    },
    execute: (args) async {
      final query = args['query'] ?? '';
      if (query.isEmpty) return ToolResult.fail('请指定要打开的应用');

      // Check if it's a URL
      if (query.startsWith('http://') || query.startsWith('https://')) {
        final ok = await DeviceControl.openUrl(query);
        return ok ? ToolResult.ok('已打开 $query') : ToolResult.fail('打开失败: $query');
      }

      // Resolve: semantic map → fuzzy search → null when truly not installed.
      // Never pick an arbitrary app when nothing matches the query.
      final app = await DeviceControl.findApp(query);
      if (app == null) {
        return ToolResult.fail(
          '应用未安装: "$query"。建议: 到应用商店安装该应用，或改打开其他已安装的应用'
          '（可用 search_apps 搜索）。');
      }

      final ok = await DeviceControl.openApp(app.packageName);
      return ok
          ? ToolResult.ok('已打开 ${app.label}', metadata: {'package': app.packageName})
          : ToolResult.fail('启动失败: ${app.label}，请确认应用可正常运行');
    },
  ),

  ToolDef(
    name: 'open_url',
    description: '在系统浏览器中打开一个网址。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'url': {'type': 'string', 'description': '完整 URL，如 "https://www.baidu.com"'},
      },
      'required': ['url'],
    },
    execute: (args) async {
      final url = args['url'] ?? '';
      if (url.isEmpty) return ToolResult.fail('请提供 URL');
      final ok = await DeviceControl.openUrl(url);
      return ok ? ToolResult.ok('已打开 $url') : ToolResult.fail('打开失败: $url');
    },
  ),

  ToolDef(
    name: 'search_apps',
    description: '搜索手机上已安装的应用列表。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'query': {'type': 'string', 'description': '搜索关键词（应用名或包名）'},
      },
    },
    execute: (args) async {
      final query = (args['query'] ?? '').toString().trim();
      final apps = query.isEmpty
          ? await DeviceControl.listApps()
          : await DeviceControl.searchApps(query);
      if (apps.isEmpty) {
        return ToolResult.fail(query.isEmpty
            ? '未列出应用：请检查设备连接与权限'
            : '未找到匹配 "$query" 的已安装应用。建议: 更换关键词，或在应用商店安装该应用。');
      }
      final list = apps.take(10).map((a) => '${a.label} (${a.packageName})').join('\n');
      return ToolResult.ok(
          '匹配 "${query.isEmpty ? "(全部)" : query}" 的应用 ${apps.length} 个:\n$list',
          metadata: {'count': apps.length, 'query': query});
    },
  ),

  // ---- Clipboard ----
  ToolDef(
    name: 'read_clipboard',
    description: '读取系统剪贴板中的文本内容。',
    inputSchema: {'type': 'object', 'properties': {}},
    execute: (args) async {
      try {
        final data = await Clipboard.getData(Clipboard.kTextPlain);
        final text = data?.text ?? '';
        return text.isEmpty
            ? ToolResult.ok('剪贴板为空')
            : ToolResult.ok('剪贴板内容:\n$text');
      } catch (e) {
        return ToolResult.fail('读取剪贴板失败: $e');
      }
    },
  ),

  ToolDef(
    name: 'write_clipboard',
    description: '将文本写入系统剪贴板。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'text': {'type': 'string', 'description': '要写入的文本'},
      },
      'required': ['text'],
    },
    execute: (args) async {
      final text = args['text'] ?? '';
      await Clipboard.setData(ClipboardData(text: text));
      return ToolResult.ok('已写入剪贴板: ${text.length > 50 ? text.substring(0, 50) + "..." : text}');
    },
  ),

  // ---- Calculator ----
  ToolDef(
    name: 'calculator',
    description: '计算数学表达式。支持加减乘除、括号、幂运算等。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'expression': {'type': 'string', 'description': '数学表达式，如 "2+3*4"、"sqrt(144)"'},
      },
      'required': ['expression'],
    },
    execute: (args) async {
      final expr = args['expression'] ?? '';
      if (expr.isEmpty) return ToolResult.fail('请提供数学表达式');
      try {
        final result = _evalExpression(expr);
        return ToolResult.ok('$expr = $result');
      } catch (e) {
        return ToolResult.fail('计算错误: $e');
      }
    },
  ),

  // ---- App Info ----
  ToolDef(
    name: 'device_info',
    description: '获取当前设备信息（平台、版本等）。',
    inputSchema: {'type': 'object', 'properties': {}},
    execute: (args) async {
      final info = {
        'platform': 'Android',
        'app': 'khy-os-client',
        'version': '1.1.16',
      };
      return ToolResult.ok(jsonEncode(info), metadata: info);
    },
  ),

  // ---- HTTP Request ----
  ToolDef(
    name: 'http_request',
    description: '发送 HTTP 请求。仅允许访问白名单域名。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'url': {'type': 'string', 'description': '请求 URL'},
        'method': {'type': 'string', 'enum': ['GET', 'POST'], 'default': 'GET'},
        'body': {'type': 'string', 'description': 'POST 请求体（JSON 字符串）'},
      },
      'required': ['url'],
    },
    execute: (args) async {
      final url = args['url'] ?? '';
      final method = args['method'] ?? 'GET';
      // Simplified: just return URL info for now
      return ToolResult.ok('HTTP $method $url\n(网络请求功能将在后续版本完善)');
    },
  ),

  // ---- Note / Search ----
  ToolDef(
    name: 'search_notes',
    description: '搜索本地保存的笔记/备忘录。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'query': {'type': 'string', 'description': '搜索关键词'},
      },
    },
    execute: (args) async {
      return ToolResult.ok('(笔记功能将在后续版本完善)');
    },
  ),

  // ---- Accessibility Service ----
  ToolDef(
    name: 'a11y_tap',
    description: '通过无障碍服务模拟点击屏幕指定坐标。需要先在系统设置中启用无障碍服务。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'x': {'type': 'integer', 'description': 'X 坐标'},
        'y': {'type': 'integer', 'description': 'Y 坐标'},
      },
      'required': ['x', 'y'],
    },
    execute: (args) async {
      final x = args['x'] ?? 0;
      final y = args['y'] ?? 0;
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用，请先在设置中启用');
      final ok = await DeviceControl.a11yTap(x, y);
      return ok ? ToolResult.ok('已点击 ($x, $y)') : ToolResult.fail('点击失败');
    },
  ),

  // Added 2026-10-26 because the chat screen's system prompt had been
  // advertising `a11y_swipe` for a while without the tool existing. A tool
  // named in the prompt but absent from the registry fails on every call, and
  // the model has no way to learn that it will — it just retries.
  //
  // WHY THE DESCRIPTION WARNS ABOUT THE BOTTOM EDGE. Measured on this device:
  // a swipe that starts near y=2300 is claimed by the system's back gesture
  // and navigates away from the current app instead of scrolling. That failure
  // looks like "the swipe did nothing" from the outside and is very hard to
  // diagnose, so the constraint is stated where the model will read it.
  ToolDef(
    name: 'a11y_swipe',
    description: '通过无障碍服务模拟滑动。从 (x1,y1) 滑到 (x2,y2)，durationMs 为时长（毫秒）。'
        '注意：起点不要太靠近屏幕底部（本机约 y=2300 以下）——那一段被系统返回手势占用，'
        '滑动手势会被当成"返回"而离开当前应用。上翻列表请从屏幕中上部起手。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'x1': {'type': 'integer', 'description': '起点 X'},
        'y1': {'type': 'integer', 'description': '起点 Y'},
        'x2': {'type': 'integer', 'description': '终点 X'},
        'y2': {'type': 'integer', 'description': '终点 Y'},
        'durationMs': {
          'type': 'integer',
          'description': '时长（毫秒）。默认 300；翻页可用 200-300，慢速拖动可到 800',
        },
      },
      'required': ['x1', 'y1', 'x2', 'y2'],
    },
    execute: (args) async {
      final x1 = (args['x1'] ?? 0) as num;
      final y1 = (args['y1'] ?? 0) as num;
      final x2 = (args['x2'] ?? 0) as num;
      final y2 = (args['y2'] ?? 0) as num;
      final ms = (args['durationMs'] ?? 300) as int;
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用，请先在设置中启用');
      final ok = await DeviceControl.a11ySwipe(x1.toInt(), y1.toInt(),
          x2.toInt(), y2.toInt(), durationMs: ms);
      return ok
          ? ToolResult.ok('已滑动 ($x1,$y1) → ($x2,$y2)，${ms}ms')
          : ToolResult.fail('滑动失败');
    },
  ),

  ToolDef(
    name: 'a11y_find_and_click',
    description: '通过无障碍服务查找并点击 UI 元素。支持 text=xxx / id=xxx / class=xxx 查询。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'query': {'type': 'string', 'description': '查询条件，如 "text=确定"、"id=com.example:id/btn"'},
      },
      'required': ['query'],
    },
    execute: (args) async {
      final query = args['query'] ?? '';
      if (query.isEmpty) return ToolResult.fail('请提供查询条件');
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用');
      final ok = await DeviceControl.a11yFindAndClick(query);
      return ok ? ToolResult.ok('已找到并点击: $query') : ToolResult.fail('未找到匹配元素: $query');
    },
  ),

  ToolDef(
    name: 'a11y_dump_ui',
    description: '通过无障碍服务获取当前屏幕的 UI 树结构（文本、ID、类名等）。用于了解屏幕内容。',
    inputSchema: {'type': 'object', 'properties': {}},
    execute: (args) async {
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用');
      final dump = await DeviceControl.a11yDumpUi();
      return dump.isEmpty ? ToolResult.ok('UI 树为空') : ToolResult.ok(dump);
    },
  ),

  ToolDef(
    name: 'a11y_list_clickable',
    description: '列出当前屏幕上所有可点击的元素及其坐标。用于 Agent 决策。',
    inputSchema: {'type': 'object', 'properties': {}},
    execute: (args) async {
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用');
      final items = await DeviceControl.a11yListClickable();
      if (items.isEmpty) return ToolResult.ok('无可点击元素');
      final list = items.take(20).map((item) =>
        '${item['text']} (${item['class']}) @ (${item['x']},${item['y']})'
      ).join('\n');
      return ToolResult.ok('可点击元素 (${items.length} 个):\n$list');
    },
  ),

  ToolDef(
    name: 'a11y_type_text',
    description: '通过无障碍服务在当前焦点输入框中输入文字。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'text': {'type': 'string', 'description': '要输入的文字'},
      },
      'required': ['text'],
    },
    execute: (args) async {
      final text = args['text'] ?? '';
      if (text.isEmpty) return ToolResult.fail('请提供要输入的文字');
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用');
      final ok = await DeviceControl.a11yTypeText(text);
      return ok ? ToolResult.ok('已输入: $text') : ToolResult.fail('输入失败');
    },
  ),

  ToolDef(
    name: 'a11y_global_action',
    description: '执行全局操作：返回(1)、主页(2)、最近任务(3)、通知栏(4)。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'action': {'type': 'integer', 'description': '操作代码: 1=返回, 2=主页, 3=最近任务, 4=通知栏'},
      },
      'required': ['action'],
    },
    execute: (args) async {
      final action = args['action'] ?? 2;
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用');
      final ok = await DeviceControl.a11yGlobalAction(action);
      final names = {1: '返回', 2: '主页', 3: '最近任务', 4: '通知栏'};
      return ok ? ToolResult.ok('已执行: ${names[action] ?? "未知操作"}') : ToolResult.fail('操作失败');
    },
  ),

  // ---- Screen Capture ----
  ToolDef(
    name: 'capture_screen',
    description: '截取当前屏幕截图。需要先启动屏幕捕获服务。',
    inputSchema: {'type': 'object', 'properties': {}},
    execute: (args) async {
      final ready = await DeviceControl.isScreenCaptureReady();
      if (!ready) {
        final started = await DeviceControl.startScreenCapture();
        if (!started) return ToolResult.fail('启动屏幕捕获失败，请在弹窗中授权');
        // Wait a moment for service to start
        await Future.delayed(const Duration(seconds: 1));
      }
      final data = await DeviceControl.captureFrame();
      if (data == null) return ToolResult.fail('截屏失败');
      return ToolResult.ok('已截屏 (${data.length} bytes base64)', metadata: {'imageData': data});
    },
  ),

  // ---- Shell Command ----
  ToolDef(
    name: 'exec_shell',
    description: '执行 shell 命令。仅允许白名单命令（am, pm, dumpsys, settings, input 等）。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'command': {'type': 'string', 'description': '要执行的 shell 命令'},
      },
      'required': ['command'],
    },
    execute: (args) async {
      final command = args['command'] ?? '';
      if (command.isEmpty) return ToolResult.fail('请提供命令');
      final result = await DeviceControl.execShell(command);
      if (result.success) {
        return ToolResult.ok(result.stdout.isEmpty ? '(无输出)' : result.stdout);
      } else {
        return ToolResult.fail('命令失败 (exit=${result.exitCode}): ${result.stderr}');
      }
    },
  ),

  // ---- 提权自举 ----
  //
  // 2026-11-17 起，配对与拉起不再只能由人点按钮：App 用自己的密钥与本机
  // adbd 配对（SPAKE2 + 6 位配对码），再把 uid 2000 的代理拉起来。模型
  // 也能驱动这条链——所以它既是产品能力，也是调试通道。
  //
  // 开关默认关是红线：raise 在开关关着时直接拒绝，没有静默提权的路。
  ToolDef(
    name: 'elevate',
    description: '提权自举：与本机 adbd 配对、拉起 uid 2000 的提权代理、查询或切换提权开关。'
        '全程不 root、不装第二个 App、不需要电脑在场。'
        'op: status（查状态）| pair（配对，需 6 位配对码）| raise（拉起代理）| on（开开关）| off（关开关）。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'op': {
          'type': 'string',
          'enum': ['status', 'pair', 'raise', 'on', 'off'],
          'description': '要做的动作',
        },
        'code': {
          'type': 'string',
          'description': '6 位配对码（仅 op=pair 用）。手机「使用配对码配对设备」弹窗里显示的那 6 位；'
              '码只进 SPAKE2 口令，不落盘、不回传、不进日志。',
        },
        'endpoint': {
          'type': 'string',
          'description': '可选：本机无线调试的连接端点（IP:端口）。留空则用自动发现或上次记住的。',
        },
      },
      'required': ['op'],
    },
    execute: (args) async {
      final op = (args['op'] ?? '').toString();
      final code = (args['code'] ?? '').toString();
      final endpoint = (args['endpoint'] ?? '').toString();
      switch (op) {
        case 'status':
        case 'pair':
        case 'raise':
        case 'on':
        case 'off':
          break;
        default:
          return ToolResult.fail('op 必须是 status/pair/raise/on/off 之一');
      }
      // 配对码只在这一步有意义，且只以字符串形态流经本函数——不写日志。
      if (op == 'pair' && code.length != 6) {
        return ToolResult.fail('配对码是 6 位数字；填手机「使用配对码配对设备」弹窗里显示的那 6 位。');
      }
      final result = await DeviceControl.elevate(op, code: code, endpoint: endpoint);
      return result.ok
          ? ToolResult.ok(result.message.isEmpty ? '(无输出)' : result.message)
          : ToolResult.fail(result.message.isEmpty ? '提权动作失败' : result.message);
    },
  ),

  // ---- APK Install ----
  ToolDef(
    name: 'install_apk',
    description: '安装一个本地 APK 文件。只接受 /sdcard/Download 和 /sdcard/khy-os 下的 .apk；'
        '安装前必须先把 apk 下载到本地（pm install 不接受 URL）。'
        '会经 shell 提权执行，未提权时明确返回而不是假装成功。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'path': {
          'type': 'string',
          'description': 'APK 的绝对路径，必须以 .apk 结尾，且位于 '
              '/sdcard/Download 或 /sdcard/khy-os 之下',
        },
      },
      'required': ['path'],
    },
    execute: (args) async {
      final path = (args['path'] ?? '').toString().trim();
      if (path.isEmpty) return ToolResult.fail('请提供 APK 路径');
      final r = await DeviceControl.installApk(path);
      if (!r.ok) {
        // code 是原生层给的分类，直接透出：调用方要能分辨"路径不对"和"没权限"，
        // 这两种的处理方式完全不同。
        return ToolResult.fail('安装被拒（${r.code}）：${r.error}');
      }
      if (!r.elevated) {
        // 最常见也最骗人的一种失败：命令跑通了，但跑在 App 自己的 uid 上，
        // 于是静悄悄地什么也没装上。必须说清，不能只报 stderr。
        return ToolResult.fail(
            '未提权，安装不会生效（当前执行身份：App 自身 uid）。'
            '需要 shell 层：先在 App 内完成「激活提权」（走无线调试，本机即可），'
            '或在电脑上重跑一次 sidecar 启动脚本。');
      }
      final out = r.stdout.trim();
      if (out.isEmpty) {
        // pm install 退出码 0 且无输出。这是一个**成功形态但零验证**的结果：
        // 退出码 0 也可能来自一个静默失败的安装，而我们这里没有做事后查询
        // （没有比对安装前的 versionCode/lastUpdateTime）。
        //
        // 所以不报成"已装好"，而是在 metadata 里显式声明未验证。
        // ToolVerdictFactory 会读这个字段，把结论写成"未验证"喂回模型——
        // 否则模型会把这句话当成安装成功的证据，而 UI 上两者一模一样。
        return ToolResult.ok('安装命令已执行（无输出）',
            metadata: <String, dynamic>{
              'via': r.via,
              'elevated': r.elevated,
              'verified': false,
              'verify_why': 'pm install 退出码为 0 且无输出，'
                  '但未做事后查询（没有比对安装前的版本信息），无法确认装上',
            });
      }
      return ToolResult.ok(out,
          metadata: <String, dynamic>{'via': r.via, 'elevated': r.elevated});
    },
  ),

  // ---- 提权代理 Privilege (self-owned shell sidecar, uid 2000) ----
  ToolDef(
    name: 'elevation_status',
    description:
        '查询 shell 提权通道（提权代理 = khy-os 自带的 sidecar，uid 2000）是否就绪。'
        'am/input/pm/settings 与 /data 读写这类 B 类命令在 App uid 下不会生效，'
        '执行前先用这里确认当前走哪条层级。',
    inputSchema: {'type': 'object', 'properties': {}},
    execute: (args) async {
      final status = await DeviceControl.getElevationStatus();
      if (status.available) {
        return ToolResult.ok(
            '提权代理 已就绪（uid 2000）。'
            '可调用 exec_shell 执行 am/input/pm/screencap/dumpsys 等需要 shell 层的命令。');
      }
      if (status.installed) {
        return ToolResult.ok(
            '提权代理 在线但尚未完成首次执行确认。'
            '直接调用 exec_shell：第一次真实执行成功后会转为已就绪。');
      }
      final why = status.reason.isEmpty ? '' : '原因：${status.reason}。';
      return ToolResult.ok(
          '提权代理 未就绪。$why'
          '它是 khy-os 自带的 shell sidecar，不需要安装任何外部应用。两条启动途径：'
          'App 内「激活提权」（走手机无线调试，本机完成）；或在电脑上跑一次 sidecar 启动脚本。'
          '当前只有 App uid：文件、剪贴板、通知、截图、无障碍点击等 A 类能力照常；'
          'am/input/pm/settings 与 /data 读写会被拒绝，返回 code=needs_shell。');
    },
    tags: ['elevation', 'privilege'],
  ),


  // ---- Elevated Shell (via 提权代理 when available) ----
  ToolDef(
    name: 'exec_shell_elevated',
    description:
        '执行需要 shell 层的命令（am/pm/dumpsys/settings/input/screencap 等）。'
        '优先走 提权代理（uid 2000）；提权代理未就绪时命令按 App uid 执行，'
        'B 类命令会返回 code=needs_shell，不会假成功。命令仍受白名单限制。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'command': {'type': 'string', 'description': '要执行的 shell 命令'},
      },
      'required': ['command'],
    },
    execute: (args) async {
      final command = (args['command'] ?? '').toString();
      if (command.isEmpty) return ToolResult.fail('请提供命令');
      final result = await DeviceControl.execShellElevated(command);
      if (result.success) {
        return ToolResult.ok(
            result.stdout.isEmpty ? '(无输出)' : result.stdout,
            metadata: {'exit': result.exitCode});
      }
      final codeSuffix = result.code.isEmpty ? '' : ' [${result.code}]';
      return ToolResult.fail(
          '命令失败 (exit=${result.exitCode})$codeSuffix: ${result.stderr}。'
          '若提示权限不足，先调用 elevation_status 确认提权通道。');
    },
    tags: ['shell', 'elevation', 'elevated'],
  ),

  // ---- Web Search & Fetch ----
  ToolDef(
    name: 'web_search',
    description: '搜索网络信息。多端点降级（DuckDuckGo → Bing → 搜狗），返回摘要与结果链接。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'query': {
          'type': 'string',
          'description': '搜索关键词',
        },
        'count': {
          'type': 'integer',
          'description': '返回结果数量（默认 5）',
        },
      },
      'required': ['query'],
    },
    execute: (args) async {
      final query = (args['query'] ?? '').toString().trim();
      if (query.isEmpty) return ToolResult.fail('请提供搜索关键词');
      final count = (args['count'] as int? ?? 5).clamp(1, 20);

      // Multi-endpoint fallback: try each provider in order; first one that
      // returns content wins. Each gets its own connect/receive budget so one
      // slow/walled provider cannot stall the whole call.
      final providers = <_SearchProvider>[
        _DuckDuckGoProvider(),
        _BingProvider(),
        _SogouProvider(),
      ];

      final errors = <String>[];
      for (final p in providers) {
        final r = await p.search(query, count);
        if (r.results.isNotEmpty) {
          return ToolResult.ok(
            '搜索结果 "$query"（来源: ${p.name}，${r.results.length} 条）:\n'
            '${r.results.join('\n')}',
            metadata: {'source': p.name, 'count': r.results.length},
          );
        }
        if (r.error.isNotEmpty) errors.add('${p.name}: ${r.error}');
      }

      // Every provider failed: give an actionable, specific message.
      return ToolResult.fail(
        '联网搜索失败（${providers.length} 个端点均未返回）：'
        '可能网络受限或代理未生效。请检查手机网络/代理设置，或稍后重试。'
        '最近错误: ${errors.join('；')}',
      );
    },
  ),

  ToolDef(
    name: 'web_fetch',
    description:
        '抓取网页内容并提取正文。支持任意 URL，自动去除 HTML 标签。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'url': {
          'type': 'string',
          'description': '要抓取的网页 URL',
        },
      },
      'required': ['url'],
    },
    execute: (args) async {
      final url = args['url'] ?? '';
      if (url.isEmpty) return ToolResult.fail('请提供 URL');

      final dio = Dio(BaseOptions(
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 30),
      ));

      try {
        final resp = await dio.get(url);
        final html = resp.data as String;

        // 简单 HTML → 文本转换
        final text = html
            .replaceAll(RegExp(r'<script[^>]*>.*?</script>',
                caseSensitive: false, dotAll: true), '')
            .replaceAll(RegExp(r'<style[^>]*>.*?</style>',
                caseSensitive: false, dotAll: true), '')
            .replaceAll(RegExp(r'<[^>]+>'), ' ')
            .replaceAll(RegExp(r'\s+'), ' ')
            .trim();

        // 截取前 2000 字符
        final result = text.length > 2000
            ? '${text.substring(0, 2000)}...'
            : text;

        return result.isEmpty
            ? ToolResult.fail('页面内容为空')
            : ToolResult.ok('网页内容:\n$result',
                metadata: {'url': url, 'length': text.length});
      } on DioException catch (e) {
        return ToolResult.fail('抓取失败 (${e.response?.statusCode}): ${e.message}');
      }
    },
  ),

  // ---- Skill Executor ----
  ToolDef(
    name: 'execute_skill',
    description: '执行辅助技能（截屏提示、回主页、返回、计算等）。注意: 打开应用请用 open_app 工具。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'skill_name': {
          'type': 'string',
          'description': '技能名称，如 "open-wechat", "open-browser", "go-home", "go-back", "screenshot", "calculate"',
          'enum': builtinSkills.map((s) => s.name).toList(),
        },
      },
      'required': ['skill_name'],
    },
    execute: (args) async {
      final name = args['skill_name'] ?? '';
      if (name.isEmpty) return ToolResult.fail('请提供技能名称');

      final skill = builtinSkills.firstWhere(
        (s) => s.name == name,
        orElse: () => const Skill(name: '', label: '', description: ''),
      );
      if (skill.name.isEmpty) return ToolResult.fail('未知技能: $name');

      final result = await SkillExecutor.execute(skill);
      if (result.isPrompt) {
        // Prompt skills are handled by AI, return hint
        return ToolResult.ok('[技能提示] ${skill.description}', metadata: {'skill': skill.name, 'type': 'prompt'});
      }
      return result.success
          ? ToolResult.ok(result.message)
          : ToolResult.fail(result.message);
    },
  ),

  // ---- Vision / Screenshot Analysis ----
  ToolDef(
    name: 'analyze_screen',
    description:
        '截取当前屏幕并用视觉模型分析。返回屏幕内容的文字描述。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'prompt': {
          'type': 'string',
          'description':
              '分析指令，如"描述屏幕上有哪些按钮"、"找到搜索框的位置"',
        },
      },
    },
    execute: (args) async {
      final prompt = args['prompt'] ?? '描述当前屏幕内容';
      final cfg = await AppConfig.loadEffective();

      if (!cfg.hasVisionConfig) {
        return ToolResult.fail('未配置视觉模型。请在设置中填写。');
      }

      var ready = await DeviceControl.isScreenCaptureReady();
      if (!ready) {
        final started = await DeviceControl.startScreenCapture();
        if (!started) return ToolResult.fail('无法启动屏幕捕获');
        await Future.delayed(const Duration(seconds: 1));
        ready = await DeviceControl.isScreenCaptureReady();
        if (!ready) return ToolResult.fail('屏幕捕获未就绪');
      }

      final dataUrl = await DeviceControl.captureFrame();
      if (dataUrl == null) return ToolResult.fail('截屏失败');

      final base64Image = dataUrl.split(',').last;
      final dio = Dio(BaseOptions(
        connectTimeout: const Duration(seconds: 30),
        receiveTimeout: const Duration(minutes: 2),
      ));

      try {
        // 走 ZenGate 而不是裸 POST：visionBaseUrl 指到 Zen 的 VL 免费模型时，
        // 裸请求会被指纹门 403，而用户会把它当成"视觉功能坏了"。
        final data = await ZenGate.postChatCompletion(
          dio: dio,
          baseUrl: cfg.visionBaseUrl,
          apiKey: cfg.effectiveVisionKey,
          body: {
            'model': cfg.visionModel,
            'messages': [
              {
                'role': 'user',
                'content': [
                  {'type': 'text', 'text': prompt},
                  {
                    'type': 'image_url',
                    'image_url': {
                      'url': 'data:image/jpeg;base64,$base64Image'
                    },
                  },
                ],
              },
            ],
            'max_tokens': 1024,
          },
        );

        final content = data['choices']?[0]?['message']?['content'] ?? '';
        return ToolResult.ok(content, metadata: {'model': cfg.visionModel});
      } on DioException catch (e) {
        return ToolResult.fail(
            '视觉模型请求失败 (HTTP ${e.response?.statusCode}): ${e.message}');
      }
    },
  ),

  // ---- File System (working directory: app external storage) ----
  ToolDef(
    name: 'list_files',
    description: '列出工作目录下的文件。path 为相对路径（空=根目录）。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'path': {'type': 'string', 'description': '相对目录路径，空字符串表示根目录'},
      },
      'required': ['path'],
    },
    execute: (args) async {
      final path = (args['path'] ?? '').trim();
      final result = await FileService.listFiles(path);
      if (result['success'] == true) {
        final rawFiles = (result['files'] as List? ?? []).cast<Map>();
        final files = rawFiles.map((f) => f.map((k, v) => MapEntry(k.toString(), v))).toList();
        final label = path.isEmpty ? '(根)' : path;
        if (files.isEmpty) return ToolResult.ok('目录为空: $label');
        final lines = files.map((f) => '  ${f['isDir'] == true ? "[D]" : "[F]"} ${f['name']}').join('\n');
        // 截断必须说出来。原来只说"目录 X (N 项)"，而那 N 项是被砍过的也照样说——
        // 调用方看到的是一个看起来完整的清单。说清"还有多少没看到"，
        // 它才知道该换一种问法（指定子目录）而不是把这份当成全部。
        final truncated = result['truncated'] == true;
        if (truncated) {
          final total = result['total'];
          return ToolResult.ok('目录 $label (显示 ${files.length}/$total 项，已截断；'
              '要看得更全请指定子目录):\n$lines');
        }
        return ToolResult.ok('目录 $label (${files.length} 项):\n$lines');
      }
      return ToolResult.fail(result['error'] ?? 'list failed');
    },
  ),
  ToolDef(
    name: 'read_file',
    description: '读取工作目录中的文件内容。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'path': {'type': 'string', 'description': '文件相对路径'},
      },
      'required': ['path'],
    },
    execute: (args) async {
      final path = (args['path'] ?? '').trim();
      if (path.isEmpty) return ToolResult.fail('请提供文件路径');
      final result = await FileService.readFile(path);
      if (result['success'] == true) {
        final content = result['content'] as String;
        // 两层截断要分开说，原来混成一句"(截断)"：
        //   - 原生层截断（文件 > 256KB）：我们只拿到了一个前缀
        //   - 本层截断（> 5000 字符）：为了不撑爆上下文又砍了一次
        // 调用方需要知道是哪一层，否则它无法判断"这文件就这么长"还是"还有更多"。
        final nativeTruncated = result['truncated'] == true;
        final shown = content.length > 5000
            ? content.substring(0, 5000)
            : content;
        final body = shown.length < content.length
            // ${shown.length} 不能写成 $shown.length：Dart 的字符串插值只取标识符，
            // 那样会把整个 5000 字符内容再插一遍，后面还跟一句字面量「.length 字符」。
            ? '$shown\n... (本层截断，仅显示前 ${shown.length} 字符)'
            : shown;
        return ToolResult.ok(
          body,
          metadata: <String, dynamic>{
            'path': path,
            'size': result['size'],
            'truncated': nativeTruncated || shown.length < content.length,
            'source_truncated': nativeTruncated,
            'shown_chars': shown.length,
          },
        );
      }
      return ToolResult.fail(result['error'] ?? 'read failed');
    },
  ),
  ToolDef(
    name: 'write_file',
    description: '写入/创建工作目录中的文件。会覆盖已有文件。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'path': {'type': 'string', 'description': '文件相对路径'},
        'content': {'type': 'string', 'description': '要写入的完整内容'},
      },
      'required': ['path', 'content'],
    },
    execute: (args) async {
      final path = (args['path'] ?? '').trim();
      final content = args['content'] ?? '';
      if (path.isEmpty) return ToolResult.fail('请提供文件路径');
      final result = await FileService.writeFile(path, content);
      if (result['success'] == true) {
        // 新文件 before 就是空串；已存在却没拿到原文 = 文件超过读取上限，
        // 这时不猜内容，卡片只说结果。
        final existed = result['existed'] == true;
        final before = result['before'] as String?;
        final Map<String, dynamic>? metadata = (!existed || before != null)
            ? {
                'writeDiff': {
                  'filePath': path,
                  'before': before ?? '',
                  'after': content,
                }
              }
            : null;
        return ToolResult.ok('已写入 $path (${content.length} 字符)', metadata: metadata);
      }
      return ToolResult.fail(result['error'] ?? 'write failed');
    },
  ),
  ToolDef(
    name: 'create_dir',
    description: '在工作目录中创建文件夹。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'path': {'type': 'string', 'description': '目录相对路径'},
      },
      'required': ['path'],
    },
    execute: (args) async {
      final path = (args['path'] ?? '').trim();
      if (path.isEmpty) return ToolResult.fail('请提供目录路径');
      final result = await FileService.createDir(path);
      if (result['success'] == true) return ToolResult.ok('已创建目录: $path');
      return ToolResult.fail(result['error'] ?? 'mkdir failed');
    },
  ),

  // ---- Code Search (equivalent to Pi Agent: edit/find/grep) ----
  ToolDef(
    name: 'edit_file',
    description: 'Precise string replacement in a file. Like Pi Agent edit tool.',
    inputSchema: {
      'type': 'object',
      'properties': {
        'path': {'type': 'string', 'description': 'file relative path'},
        'oldText': {'type': 'string', 'description': 'exact text to find'},
        'newText': {'type': 'string', 'description': 'replacement text'},
        'replaceAll': {'type': 'boolean', 'description': 'replace all occurrences (default false)'},
      },
      'required': ['path', 'oldText', 'newText'],
    },
    execute: (args) async {
      final path = (args['path'] ?? '').trim();
      final oldText = args['oldText']?.toString() ?? '';
      final newText = args['newText']?.toString() ?? '';
      final replaceAll = args['replaceAll'] == true;
      if (path.isEmpty || oldText.isEmpty) return ToolResult.fail('path and oldText required');
      final r = await FileService.editFile(path, oldText, newText, replaceAll: replaceAll);
      if (r['success'] == true) {
        final count = (r['replacements'] as int?) ?? (replaceAll ? 0 : 1);
        final before = r['before'] as String?;
        final after = r['after'] as String?;
        final Map<String, dynamic>? metadata = (before != null && after != null)
            ? {
                'writeDiff': {
                  'filePath': path,
                  'before': before,
                  'after': after,
                }
              }
            : null;
        return ToolResult.ok('已在 $path 替换 $count 处', metadata: metadata);
      }
      return ToolResult.fail(r['error']?.toString() ?? 'edit failed');
    },
    tags: ['file', 'edit'],
  ),
  ToolDef(
    name: 'find_files',
    description: 'Find files by glob pattern in working directory. Like Pi Agent find tool.',
    inputSchema: {
      'type': 'object',
      'properties': {
        'dir': {'type': 'string', 'description': 'search directory (empty = root)'},
        'pattern': {'type': 'string', 'description': 'glob pattern e.g. *.dart, **/*.json'},
        'maxResults': {'type': 'integer', 'description': 'limit (default 50)'},
      },
      'required': ['pattern'],
    },
    execute: (args) async {
      final dir = (args['dir'] ?? '').toString();
      final pattern = (args['pattern'] ?? '*').toString();
      final max = args['maxResults'] as int? ?? 50;
      final r = await FileService.findFiles(dir, pattern, maxResults: max);
      if (r['success'] == true) {
        final files = (r['files'] as List? ?? []).cast<String>();
        if (files.isEmpty) return ToolResult.ok('未找到匹配 "$pattern" 的文件');
        return ToolResult.ok(files.join('\n') + (r['truncated'] == true ? '\n...(more)' : ''));
      }
      return ToolResult.fail(r['error']?.toString() ?? 'find failed');
    },
    tags: ['file', 'search'],
  ),
  ToolDef(
    name: 'grep_files',
    description: 'Search file contents with regex. Like Pi Agent grep tool. Returns file:line matches.',
    inputSchema: {
      'type': 'object',
      'properties': {
        'dir': {'type': 'string', 'description': 'search directory (empty = root)'},
        'regex': {'type': 'string', 'description': 'regex pattern to search'},
        'filePattern': {'type': 'string', 'description': 'optional regex to filter filenames'},
        'maxResults': {'type': 'integer', 'description': 'limit (default 30)'},
      },
      'required': ['regex'],
    },
    execute: (args) async {
      final dir = (args['dir'] ?? '').toString();
      final regex = (args['regex'] ?? '').toString();
      final filePattern = (args['filePattern'] ?? '').toString();
      final max = args['maxResults'] as int? ?? 30;
      if (regex.isEmpty) return ToolResult.fail('regex required');
      final r = await FileService.grepFiles(dir, regex, filePattern: filePattern, maxResults: max);
      if (r['success'] == true) {
        final rawMatches = (r['matches'] as List? ?? []).cast<Map>();
        final matches = rawMatches
            .map((m) => m.map((k, v) => MapEntry(k.toString(), v)))
            .toList();
        if (matches.isEmpty) return ToolResult.ok('未找到匹配 /$regex/ 的内容');
        final lines = matches.map((m) => '${m['file']}:${m['line']} :: ${m['text']}').join('\n');
        return ToolResult.ok(lines, metadata: {'count': matches.length});
      }
      return ToolResult.fail(r['error']?.toString() ?? 'grep failed');
    },
    tags: ['file', 'search'],
  ),

  // ---- Amoo：把本机 STEPX 助手当一个可调用的模型 ----
  //
  // 为什么值得占一个工具位：Amoo 有它自己的账号额度和它自己那套工具（它在手机上
  // 真能点、真能看），而你配置的模型只有网络。让模型能"我去问 Amoo"，两边的能力
  // 才拼得起来；否则 Amoo 在这个 App 里只是个切换目标，模型根本看不见它。
  //
  // 三条硬约束，都是实测出来的，改之前先读：
  //   1. 它会把 Amoo 的聊天页拉到前台、并把屏幕点亮。apex 的捕获管理器取的是
  //      当前焦点窗口，Amoo 不在前台就什么都读不到。这是机制决定的，不是实现选择。
  //      所以描述里必须写明，让模型自己权衡要不要付这个代价。
  //   2. 一轮约 1-6 分钟，且是流式写进同一个气泡的。所以这里轮询到"连续两次读到
  //      同一段回复"才算完成，只读一次会拿到半句。
  //   3. 单飞。AmooChatService 内部已有 SecurityGuard 闸门，不在这里重复造。
  ToolDef(
    name: 'amoo_ask',
    // 文案去品牌化（工具位保留，Q1 冻结）：Tool Host 的工具面不宣传任何一个
    // driver 的品牌——描述的是「把提问交给本机另一个助手」这个能力本身。
    description: '向本机的反代助手提问，并拿回它的回复原文。'
        '反代助手有独立的账号额度和你没有的设备操作能力，适合让它做"需要真机视角"或'
        '"借它额度"的那部分。注意：调用时会把它的聊天页拉到前台并点亮屏幕，'
        '且一轮可能要等数分钟——只在确有必要时用。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'prompt': {'type': 'string', 'description': '要问 Amoo 的内容'},
        'timeout_ms': {
          'type': 'integer',
          'description': '等待回复的上限（毫秒），默认 300000（5 分钟）',
        },
      },
      'required': ['prompt'],
    },
    execute: (args) async {
      final prompt = (args['prompt'] ?? '').toString().trim();
      if (prompt.isEmpty) return ToolResult.fail('请输入要问 Amoo 的内容');
      final timeoutMs = (args['timeout_ms'] as num?)?.toInt() ?? 300000;
      final budget = timeoutMs.clamp(15000, 1800000);

      final started = await AmooChatService.ask(prompt, timeoutMs: budget);
      if (!started.ok) {
        // 原话上屏：singleFlight 的意思是"等"，refused 的意思是"你去开条件"，
        // 两者下一步完全相反，压成一句"调用失败"模型就没法自己纠正。
        return ToolResult.fail(started.failureDetail);
      }

      final deadline = DateTime.now().millisecondsSinceEpoch + budget;
      var last = '';
      var stable = 0;
      while (DateTime.now().millisecondsSinceEpoch < deadline) {
        await Future.delayed(const Duration(seconds: 2));
        final r = await AmooChatService.poll();
        if (!r.ok) return ToolResult.fail(r.failureDetail);
        if (r.state == AmooAskState.failed) {
          final why = r.error.isNotEmpty ? r.error : '未知原因';
          return ToolResult.fail('未拿到 Amoo 的回复：$why');
        }
        if (r.state != AmooAskState.done) continue;
        final reply = r.reply.trim();
        if (reply.isEmpty) continue;
        if (reply == last) {
          stable++;
        } else {
          stable = 0;
          last = reply;
        }
        // 连续两次一致才算写完：Amoo 是流式写进同一个气泡的，第一次读很可能只有半句。
        if (stable >= 1) return ToolResult.ok(reply);
      }
      return ToolResult.fail(
        '等待 Amoo 回复超时（${budget ~/ 1000}s）。已发出去的提问收不回来，可再调一次。',
      );
    },
    tags: ['amoo', 'model'],
  ),

  // ---- Vision: locate and tap by screenshot ----
  //
  // Kept out of this file on purpose. They are the only tools whose
  // correctness rests on a coordinate conversion, and the prompt, the parser
  // and the conversion need to sit next to each other — a change to the
  // prompt's coordinate space must force a look at the parser that reads it.
  ...createVisionTools(),
];

/// Simple expression evaluator
double _evalExpression(String expr) {
  // Remove spaces
  expr = expr.replaceAll(' ', '');

  // Handle sqrt
  expr = expr.replaceAllMapped(
    RegExp(r'sqrt\(([^)]+)\)'),
    (m) {
      final val = _evalExpression(m.group(1)!);
      return sqrt(val).toString();
    },
  );

  // Handle pow
  expr = expr.replaceAllMapped(
    RegExp(r'pow\(([^,]+),([^)]+)\)'),
    (m) {
      final base = _evalExpression(m.group(1)!);
      final exp = _evalExpression(m.group(2)!);
      return pow(base, exp).toString();
    },
  );

  return _parseAddSub(expr, 0).$1;
}

(double, int) _parseAddSub(String expr, int pos) {
  var (left, p) = _parseMulDiv(expr, pos);
  while (p < expr.length && (expr[p] == '+' || expr[p] == '-')) {
    final op = expr[p];
    final (right, p2) = _parseMulDiv(expr, p + 1);
    left = op == '+' ? left + right : left - right;
    p = p2;
  }
  return (left, p);
}

(double, int) _parseMulDiv(String expr, int pos) {
  var (left, p) = _parseUnary(expr, pos);
  while (p < expr.length && (expr[p] == '*' || expr[p] == '/' || expr[p] == '%')) {
    final op = expr[p];
    final (right, p2) = _parseUnary(expr, p + 1);
    left = op == '*' ? left * right : op == '/' ? left / right : left % right;
    p = p2;
  }
  return (left, p);
}

(double, int) _parseUnary(String expr, int pos) {
  if (pos < expr.length && expr[pos] == '-') {
    final (val, p) = _parsePrimary(expr, pos + 1);
    return (-val, p);
  }
  return _parsePrimary(expr, pos);
}

(double, int) _parsePrimary(String expr, int pos) {
  if (pos < expr.length && expr[pos] == '(') {
    final (val, p) = _parseAddSub(expr, pos + 1);
    return (val, p + 1); // skip ')'
  }
  // Parse number
  var end = pos;
  while (end < expr.length && (expr[end].codeUnitAt(0) >= 48 && expr[end].codeUnitAt(0) <= 57 || expr[end] == '.')) {
    end++;
  }
  final num = double.parse(expr.substring(pos, end));
  return (num, end);
}

// ==================== Web Search Providers ====================
//
// Each provider is self-contained (its own Dio + timeout budget) so a single
// slow/walled endpoint cannot stall the others. They degrade in order;
// web_search returns the first provider that yields content.

/// Result of a single provider attempt.
class _SearchOutcome {
  final List<String> results;
  final String error;
  const _SearchOutcome(this.results, this.error);
}

abstract class _SearchProvider {
  final String name;
  final int connectSeconds;
  final int receiveSeconds;
  _SearchProvider(this.name, this.connectSeconds, this.receiveSeconds);

  Future<_SearchOutcome> search(String query, int count);

  /// Per-provider Dio with its own timeouts and a desktop UA (some endpoints
  /// throttle the default Flutter UA harder).
  Dio _dio() => Dio(BaseOptions(
        connectTimeout: Duration(seconds: connectSeconds),
        receiveTimeout: Duration(seconds: receiveSeconds),
        headers: {
          'User-Agent':
              'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      ));
}

class _DuckDuckGoProvider extends _SearchProvider {
  _DuckDuckGoProvider() : super('DuckDuckGo', 8, 12);

  @override
  Future<_SearchOutcome> search(String query, int count) async {
    final dio = _dio();
    try {
      final resp = await dio.get(
        'https://api.duckduckgo.com/?q=${Uri.encodeComponent(query)}'
        '&format=json&no_html=1&compact=true&kl=cn-zh',
      );
      final data = resp.data as Map<String, dynamic>;
      final results = <String>[];
      final heading = data['Heading']?.toString() ?? '';
      final abstract = data['Abstract']?.toString() ?? '';
      if (heading.isNotEmpty) results.add('摘要: $heading');
      if (abstract.isNotEmpty) results.add('说明: $abstract');
      final related = data['RelatedTopics'] as List?;
      if (related != null) {
        for (final topic in related.take(count)) {
          if (topic is Map) {
            final text = topic['Text']?.toString() ?? '';
            final url = topic['URL']?.toString() ?? '';
            if (text.isNotEmpty) {
              results.add(text);
              if (url.isNotEmpty) results.add(url);
            }
          }
        }
      }
      return _SearchOutcome(results, results.isEmpty ? '无内容' : '');
    } on DioException catch (e) {
      return _SearchOutcome([], _describeDio(e));
    }
  }
}

class _BingProvider extends _SearchProvider {
  _BingProvider() : super('Bing', 10, 15);

  @override
  Future<_SearchOutcome> search(String query, int count) async {
    final dio = _dio();
    try {
      // html scrape — no key required
      final resp = await dio.get(
        'https://www.bing.com/search?q=${Uri.encodeComponent(query)}'
        '&count=$count&setlang=zh-hans',
      );
      final html = resp.data as String;
      final lines = _parseBingHtml(html, count);
      return _SearchOutcome(lines, lines.isEmpty ? '无内容' : '');
    } on DioException catch (e) {
      return _SearchOutcome([], _describeDio(e));
    }
  }

  /// Very small, dependency-free Bing result scraper. Targets the organic
  /// result blocks only; deliberately simple and tolerant of layout drift.
  static List<String> _parseBingHtml(String html, int count) {
    final results = <String>[];
    // Bing wraps each organic result in <li class="b_algo">
    final blocks =
        RegExp(r'<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>(.*?)</li>',
                dotAll: true)
            .allMatches(html)
            .toList();
    for (final block in blocks) {
      if (results.length >= count) break;
      final body = block.group(1) ?? '';
      final title = _firstMatch(RegExp(r'<h2>(.*?)</h2>', dotAll: true), body);
      final snippet = _firstMatch(RegExp(r'<p[^>]*>(.*?)</p>', dotAll: true), body);
      final url = _firstMatch(RegExp(r'href="(https?://[^"]+)"', dotAll: true), body);
      final cleaned = (title.isNotEmpty ? title : snippet)
          .replaceAll(RegExp(r'<[^>]+>'), '')
          .trim();
      if (cleaned.isEmpty) continue;
      results.add(url.isNotEmpty ? '$cleaned\n$url' : cleaned);
    }
    return results;
  }

  static String _firstMatch(RegExp re, String in_) {
    final m = re.firstMatch(in_);
    return m?.group(1)?.trim() ?? '';
  }
}

class _SogouProvider extends _SearchProvider {
  _SogouProvider() : super('Sogou', 10, 15);

  @override
  Future<_SearchOutcome> search(String query, int count) async {
    final dio = _dio();
    try {
      // Sogou works reliably on CN mobile networks without a key.
      final resp = await dio.get(
        'https://sogou.com/web?query=${Uri.encodeComponent(query)}&num=$count',
      );
      final html = resp.data as String;
      final lines = _parseSogouHtml(html, count);
      return _SearchOutcome(lines, lines.isEmpty ? '无内容' : '');
    } on DioException catch (e) {
      return _SearchOutcome([], _describeDio(e));
    }
  }

  static List<String> _parseSogouHtml(String html, int count) {
    final results = <String>[];
    // Sogou organic results: <div class="vrwrap"> ... <h3><a ...>title</a>
    final blocks =
        RegExp(r'<div[^>]*class="[^"]*vrwrap[^"]*"[^>]*>(.*?)</div>',
                dotAll: true)
            .allMatches(html)
            .toList();
    for (final block in blocks) {
      if (results.length >= count) break;
      final body = block.group(1) ?? '';
      final title = _firstMatch(
          RegExp(r'<h3[^>]*>.*?<a[^>]*>(.*?)</a>', dotAll: true), body);
      final snippet = _firstMatch(
          RegExp(r'<p class="str-text"[^>]*>(.*?)</p>', dotAll: true), body);
      final url = _firstMatch(RegExp(r'href="(https?://[^"]+)"'), body);
      final cleaned = (title.isNotEmpty ? title : snippet)
          .replaceAll(RegExp(r'<[^>]+>'), '')
          .trim();
      if (cleaned.isEmpty) continue;
      results.add(url.isNotEmpty ? '$cleaned\n$url' : cleaned);
    }
    return results;
  }

  static String _firstMatch(RegExp re, String in_) {
    final m = re.firstMatch(in_);
    return m?.group(1)?.trim() ?? '';
  }
}

/// Compact, actionable description of a Dio network error (AGENTS rule 2.2:
/// problem + identifier + fix suggestion, no raw exception dumps).
String _describeDio(DioException e) {
  switch (e.type) {
    case DioExceptionType.connectionTimeout:
      return '连接超时 (${e.message})';
    case DioExceptionType.sendTimeout:
      return '发送超时 (${e.message})';
    case DioExceptionType.receiveTimeout:
      return '响应超时 (${e.message})';
    case DioExceptionType.transformTimeout:
      return '响应解析超时 (${e.message})';
    case DioExceptionType.badResponse:
      final code = e.response?.statusCode ?? '?';
      return 'HTTP $code';
    case DioExceptionType.badCertificate:
      return '证书校验失败';
    case DioExceptionType.cancel:
      return '请求被取消';
    case DioExceptionType.connectionError:
      return '网络不可达，请检查网络/代理';
    case DioExceptionType.unknown:
      final msg = e.message ?? '';
      return msg.isNotEmpty ? msg : '未知网络错误';
  }
}