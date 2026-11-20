// C 段真连接（裁决=wss；证书=自签 + App 内 pin）。
//
// WHY 指纹内置而不是从 /sdcard 读：能写 /sdcard 的人就能换掉它——pin 的全部
// 价值在于校验者手里那份依据不被同一只手改写。指纹是公钥的哈希，不是密钥；
// 服务端换证书时这里同步改值，并让两端对账（服务端 /cert 同值）。
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// PC 侧 device-link 证书（自签 RSA-2048，keytool 生成）的 sha256(der)。
/// 生成与查看：runtime/node/backend/src/services/crossPlatform/ws/deviceLinkWss.js
/// 的 ensureDeviceLinkCert / GET 127.0.0.1:8789/cert。
const String kPcLinkCertSha256 =
    '6653449d3fb9a286a22458757f2433e3aa158803eb30178ee69779c7294e318a';

/// pin 只认这一个指纹；系统 CA 链验证结果不参与——自签证书必然验证失败，
/// 决定权完全在指纹比对上。错指纹 = 拒绝握手，fail-closed。
bool certFingerprintMatches(X509Certificate cert) =>
    sha256.convert(cert.der).toString() == kPcLinkCertSha256;

/// 连接出向链路。
///
/// wss：挂一个只认内置指纹的 HttpClient——dart:io 的 WebSocket.connect 不暴露
/// 证书回调，但 3.0.3 的 IOWebSocketChannel.connect 收 customClient。
/// ws：明文直连（harness/回退态），行为与旧路径逐字节一致。
WebSocketChannel connectLink(
  Uri uri, {
  Duration connectTimeout = const Duration(seconds: 10),
}) {
  if (uri.scheme != 'wss') {
    return WebSocketChannel.connect(uri);
  }
  final client = HttpClient()
    ..badCertificateCallback = (cert, host, port) => certFingerprintMatches(cert);
  return IOWebSocketChannel.connect(
    uri,
    customClient: client,
    connectTimeout: connectTimeout,
  );
}
