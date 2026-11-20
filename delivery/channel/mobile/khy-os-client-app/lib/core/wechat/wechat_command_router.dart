// In-conversation escape hatches: /status, /stop and 「记录」.
//
// /stop can only abandon the wait — AgentLoop has no interrupt channel (Dio
// cannot be cancelled mid-step; local_driver.dart says the same in its abort
// comment), so the honest reply promises less than what actually happens.
import 'wechat_progress_reporter.dart';

class WechatCommandRouter {
  WechatCommandRouter({
    required WechatSend send,
    this.recordDefaultCount = 3,
    this.recordSummaryMaxLen = 600,
  })  : _outbound = send;

  final WechatSend _outbound;
  final int recordDefaultCount;
  final int recordSummaryMaxLen;

  /// Runner-owned lookups, wired by the runner after construction. Nullable so
  /// a bare router still compiles for tests that only need one command.
  String? Function()? statusSnapshot;
  Future<bool> Function()? stopCurrent;
  List<String> Function(int max)? recentSummaries;

  static final _recordRe = RegExp(r'^记录(?:\s+(\d+))?$');

  /// Returns true when [text] was one of the commands and has been answered.
  Future<bool> handle(String contextToken, String text) async {
    final t = text.trim().toLowerCase();
    if (t == '/status') {
      final status = statusSnapshot?.call();
      await _outbound(contextToken, status ?? '当前没有正在执行的任务');
      return true;
    }
    if (t == '/stop') {
      final stopped = await stopCurrent?.call() ?? false;
      await _outbound(contextToken,
          stopped ? '已放弃等待，后台步骤可能仍在跑' : '当前没有正在执行的任务');
      return true;
    }
    final record = _recordRe.firstMatch(text.trim());
    if (record != null) {
      final n = int.tryParse(record.group(1) ?? '') ?? recordDefaultCount;
      await _sendRecords(contextToken, n);
      return true;
    }
    return false;
  }

  Future<void> _sendRecords(String contextToken, int n) async {
    final summaries = recentSummaries?.call(n) ?? const <String>[];
    if (summaries.isEmpty) {
      await _outbound(contextToken, '还没有执行记录');
      return;
    }
    final body = summaries.join('\n----\n');
    for (final chunk in splitForWechat(body)) {
      await _outbound(contextToken, chunk);
    }
  }

  /// Per-log excerpt for 「记录」. ExecutionLog.toText carries full args and
  /// outputs, so each summary is capped — the cap is announced, not silent.
  String clipSummary(String toText) {
    if (toText.length <= recordSummaryMaxLen) return toText;
    return '${toText.substring(0, recordSummaryMaxLen)}…(摘要截断，完整内容看 App 设置页轨迹)';
  }
}
