// khy-canary: Khy-20261101-082-8HRS60RW
import 'package:flutter/services.dart';

/// amoo 本机入口（不经过 PC 桥）。
///
/// 为什么不用 phone token 走 `amoon_send`：bridge 的 scope 矩阵里
/// `amoon_send` / `amoon_inbox` 都是 operator-only（contracts.js:486、:509），
/// phone token 调用会得到 `forbidden_scope`；而且 daemon 只监听 127.0.0.1，
/// 没有 adb reverse 时手机根本到不了。所以发送走 Android Intent：
///   - `ShareActivity`：ACTION_SEND + text/plain（dumpsys 已确认有该 filter）
///   - `ChatMainActivity`：只用于打开聊天页，不承诺接收文本
///
/// 所有方法都只回「已受理/已打开」或失败原因，永远不会声称「已发送/已送达」。
class AmooService {
  static const MethodChannel _channel =
      MethodChannel('com.khyos.khy_os_client/device');

  static const String packageName = 'com.stepos.ailauncher';
  static const String shareActivity =
      'com.stepos.ailauncher.chat.activity.ShareActivity';
  static const String chatActivity =
      'com.stepos.ailauncher.chat.activity.ChatMainActivity';
  static const String openChatAction = 'com.stepos.ailauncher.action.OPEN_CHAT';

  /// 只读状态：安装态 + 两个组件是否能解析。不会启动 amoo。
  ///
  /// 通道异常（旧原生壳、MissingPluginException、PlatformException）**不能**当成
  /// 「未安装」——方向相反地违反诚实边界。这类情况返回 unknown，并带上原生 message。
  static Future<AmooStatus> status() async {
    try {
      final result = await _channel.invokeMethod('amooStatus');
      if (result is! Map) {
        return const AmooStatus(unknown: true, errorMessage: '原生层未返回状态对象');
      }
      final nativeMessage = result['message']?.toString() ?? '';
      return AmooStatus(
        installed: result['installed'] == true,
        canShare: result['canShare'] == true,
        canOpenChat: result['canOpenChat'] == true,
        versionName: result['versionName']?.toString() ?? '',
        errorMessage: nativeMessage,
      );
    } on PlatformException catch (e) {
      return AmooStatus(unknown: true, errorMessage: '${e.code}: ${e.message ?? ''}');
    } catch (e) {
      return AmooStatus(unknown: true, errorMessage: '$e');
    }
  }

  /// 用户点「分享到 amoo」后调用。空文本在 Dart 与 Kotlin 两侧都会被拒绝。
  static Future<AmooSendResult> shareText(String text) async {
    final body = text.trim();
    if (body.isEmpty) {
      return const AmooSendResult(
        ok: false,
        via: AmooSendVia.none,
        message: '内容为空，未发送',
      );
    }
    // 契约上限 4000（bridge contracts.js:490）；Kotlin 侧再截一次做纵深防御。
    final truncated = body.length > 4000;
    final capped = truncated ? body.substring(0, 4000) : body;
    try {
      final result = await _channel.invokeMethod('sendToAmoo', {'text': capped});
      if (result is! Map) {
        return AmooSendResult(
          ok: false,
          via: AmooSendVia.none,
          message: 'amoo 未返回结果',
          truncated: truncated,
        );
      }
      return AmooSendResult(
        ok: result['ok'] == true,
        via: AmooSendVia.parse(result['via']?.toString()),
        message: result['message']?.toString() ?? '',
        truncated: result['truncated'] == true || truncated,
      );
    } on PlatformException catch (e) {
      return AmooSendResult(
        ok: false,
        via: AmooSendVia.none,
        message: '调用失败：${e.message ?? e.code}',
        truncated: truncated,
      );
    } catch (e) {
      return AmooSendResult(
        ok: false,
        via: AmooSendVia.none,
        message: '调用失败：$e',
        truncated: truncated,
      );
    }
  }

  /// 打开 amoo 聊天页（不预填内容、不发送）。
  static Future<bool> openChat() async {
    try {
      final result = await _channel.invokeMethod('openAmoo');
      return result is Map && result['ok'] == true;
    } catch (_) {
      return false;
    }
  }
}

enum AmooSendVia {
  /// 显式组件被受理
  direct,

  /// 显式组件不可用，已退回系统分享面板（用户还要自己选 amoo）
  chooser,

  /// 什么也没发生
  none;

  static AmooSendVia parse(String? raw) {
    switch (raw) {
      case 'direct':
        return AmooSendVia.direct;
      case 'chooser':
        return AmooSendVia.chooser;
      default:
        return AmooSendVia.none;
    }
  }
}

class AmooStatus {
  final bool installed;
  final bool canShare;
  final bool canOpenChat;
  final String versionName;

  /// 原生通道不可用 / 返回异常。unknown=true 时 installed/canShare 都不可信。
  final bool unknown;
  final String errorMessage;

  const AmooStatus({
    this.installed = false,
    this.canShare = false,
    this.canOpenChat = false,
    this.versionName = '',
    this.unknown = false,
    this.errorMessage = '',
  });

  /// 展示用的一句话，不做任何乐观推断。
  String get summary {
    if (unknown) {
      final detail = errorMessage.isEmpty ? '' : '：$errorMessage';
      return '无法检测 amoo（原生通道异常$detail）';
    }
    if (!installed) {
      // Kotlin 侧 catch 也会带 message 返回 installed=false；那是「检测失败」，
      // 不是「确认未安装」，不能混为一谈。
      if (errorMessage.isNotEmpty) return '无法读取 amoo 安装态：$errorMessage';
      return '未安装 amoo（$packageLabel）';
    }
    if (canShare) {
      // resolveActivity 只证明组件可解析，不证明第三方 uid 能启动（exported 未证实）
      return '已安装${versionName.isEmpty ? '' : ' v$versionName'} · 已解析到分享入口（启动未验证）';
    }
    return '已安装${versionName.isEmpty ? '' : ' v$versionName'} · 未解析到分享入口';
  }

  static const String packageLabel = AmooService.packageName;
}

class AmooSendResult {
  final bool ok;
  final AmooSendVia via;
  final String message;
  final bool truncated;

  const AmooSendResult({
    required this.ok,
    required this.via,
    required this.message,
    this.truncated = false,
  });

  /// 「已交给 amoo」≠「已送达」。UI 必须原样带上这句。
  String get displayMessage {
    if (!ok) return message;
    final base = message.isEmpty ? '已交给 amoo' : message;
    return truncated ? '$base（原文超过 4000 字，已截断）' : base;
  }
}
