import 'amoo_mirror_api.dart';

/// Rule 2.2 three-part Chinese text (problem + identifier + fix). The UI banner
/// and the log line share this one sentence — two owners writing their own
/// wording is how "限流" and "429" end up describing different states.
String describeAmooMirrorError(AmooMirrorApiException e) {
  switch (e.kind) {
    case AmooMirrorErrorKind.unauthorized:
      return '未授权 (401)：设备令牌无效或过期，请在设置「对话记录」重新配对（粘贴 device_token）';
    case AmooMirrorErrorKind.notFound:
      return '会话不存在 (404)：服务端已无此会话，已缓存的副本仍可查看';
    case AmooMirrorErrorKind.cursorStale:
      return '游标失效 (409)：服务端拒绝了增量游标，将整体重拉一次';
    case AmooMirrorErrorKind.rateLimited:
      return '限频 (429)：请求过于频繁，请稍后重试';
    case AmooMirrorErrorKind.server:
      return '服务端异常 (${e.status ?? '5xx'})：Amoo 数据服务暂不可用，请稍后重试';
    case AmooMirrorErrorKind.transport:
      return '网络连接失败：请检查网络或服务端地址后重试';
    case AmooMirrorErrorKind.timeout:
      return '请求超时：网络或服务端响应慢，请稍后重试';
    case AmooMirrorErrorKind.badResponse:
      return '响应不符合契约 (${e.status ?? '2xx'})：Amoo 数据服务返回了无法解析的数据';
  }
}
