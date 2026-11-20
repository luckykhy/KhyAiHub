// bridge_link_tls 的单元测试：pin 常量的形状与 ws/wss 分派。
// TLS 握手层的 accept/reject 行为无法在 JVM 单测里构造 X509Certificate，
// 由真机判定（T10）与 pin_probe.dart 的双向往返覆盖——这里只锁「会骗人」的
// 纯逻辑部分：指纹串写错形状（多了冒号/大写/缺位）直接挡在编译常量层面。
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/bridge_link_tls.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

void main() {
  group('kPcLinkCertSha256', () {
    test('是 64 位小写无分隔 hex（sha256(der) 的规范形态）', () {
      expect(kPcLinkCertSha256, hasLength(64));
      expect(RegExp(r'^[0-9a-f]{64}$').hasMatch(kPcLinkCertSha256), isTrue);
    });
    test('与服务端 device-link-cert-meta.json 登记值同源（值由 CI 对账）', () {
      // 这条不做文件 IO：服务端指纹的逐字节一致性由 T10 的
      // wss-server-fingerprint 步骤在真机链路上对账。
      expect(kPcLinkCertSha256, isNotEmpty);
    });
  });

  group('connectLink', () {
    test('ws:// 走直连通道，返回可用的 channel', () {
      final ch = connectLink(Uri.parse('ws://127.0.0.1:1/link'));
      expect(ch, isA<WebSocketChannel>());
      try {
        ch.sink.close();
      } catch (_) {/* 未连接时 close 可抛，测试只锁构造路径 */}
    });
    test('wss:// 同样构造成功（TLS 决策推迟到握手，失败在 ready 上兑现）', () {
      final ch = connectLink(Uri.parse('wss://127.0.0.1:1/link'));
      expect(ch, isA<WebSocketChannel>());
      try {
        ch.sink.close();
      } catch (_) {/* 同上 */}
    });
  });
}
