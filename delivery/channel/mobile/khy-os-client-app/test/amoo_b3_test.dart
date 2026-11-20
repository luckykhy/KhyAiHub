import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/pairing.dart';
import 'package:khy_os_client/core/identity/amoo_identity.dart';

/// B3 身份统一的单元级完成判定（测试先行，TASK.md §B.0.1「没有判定不开工」）。
///
/// 判据锚点：TASK.md §4 B3（「pairing 换短期证书、下线内置 sk-、私钥仅 App
/// 私有目录」）与 contract.md §2 K-10 / K-11 / K-13 / K-14、错误码表
/// （`unknown_peer` / `credential_expired`）。
///
/// 分工（不要在这里重复造）：
///   - 静态那条「内置 sk- 命中 0」由 `checks/B3_static_identity.cmd` 判。这个
///     文件若也去扫源码，就会出现两个能各自翻绿的同一判据。
///   - 设备那三条（运行后 /sdcard 无新 token.txt、私钥落点的系统侧读数、
///     重装后旧凭证被拒与 24h 内续期）见 `device/B3.md`，要 adb 才能取证。
///
/// `lib/core/identity/amoo_identity.dart` 尚不存在，所以这个套件今天是红的
/// （缺模块）。符号名与形状就是契约：要改先回 contract.md §2 重新推导，
/// 不许为了让测试过而把断言改松。
///
/// 除 flutter_test 外只 import 两个业务模块：本案缺失的 amoo_identity，与
/// K-11 点名复用的 pairing（仓内既有，`test/pairing_test.dart` 30 个全绿）。
/// 仓库现在还有一批基线红（TASK.md §A：analyze 多个 error、既有单测编译不过），
/// 多 import 一个模块就会把别人的红混进 B3 的首败里，届时分不清是谁没干活。
void main() {
  final issuedAt = DateTime.utc(2026, 11, 12, 10);
  final expiresAt = issuedAt.add(AmooIdentitySpec.certLifetime);

  AmooCert issueCert({String peerId = 'amoo-cloud', DateTime? issued}) =>
      AmooIdentity.issue(
        pairing: const PairingPayload(apiBaseUrl: 'http://192.168.1.9:3000'),
        peerId: peerId,
        issuedAt: issued ?? issuedAt,
      );

  group('pairing 换短期证书（K-11）', () {
    test('配对载荷换出一张 24h 短期证书，绑定签发时的对等体与后端', () {
      final cert = issueCert();
      expect(cert.peerId, 'amoo-cloud');
      expect(cert.apiBaseUrl, 'http://192.168.1.9:3000');
      expect(cert.issuedAt, issuedAt);
      expect(cert.expiresAt, expiresAt);
      expect(
        cert.expiresAt.difference(cert.issuedAt),
        AmooIdentitySpec.certLifetime,
      );
    });

    test('身份形状不合格，签不出证书', () {
      // 空白或带空格的 identity 挂不上 K-13 的登记簿，签发处就拒，
      // 别等到握手交换时才发现对面报了个名字回来却不知道是谁。
      expect(() => issueCert(peerId: ''), throwsArgumentError);
      expect(() => issueCert(peerId: '   '), throwsArgumentError);
      expect(() => issueCert(peerId: 'amoo cloud'), throwsArgumentError);
    });
  });

  group('cert lifetime（K-11：24h 是判据数值）', () {
    test('证书有效期就是 24h', () {
      // 24h 是判据 N11 的数值，不是随手取的值。
      expect(AmooIdentitySpec.certLifetime, const Duration(hours: 24));
    });

    test('续期提前量落在 (0, 24h) 内', () {
      // 判据只钉「24h 内续期」，提前量取多少是实现自由；但 0 会让证书签发后
      // 立刻 expiringSoon，>= 24h 则永远等不到续期窗口——两种都让「24h 内
      // 续期」变成空话。
      expect(AmooIdentitySpec.renewLead, greaterThan(Duration.zero));
      expect(AmooIdentitySpec.renewLead, lessThan(AmooIdentitySpec.certLifetime));
    });

    test('窗口内 valid，到期那一刻 expired', () {
      // 「窗口内」的准确含义是「离到期还有超过一个续期提前量」。刚过
      // 23:59:59 那种采样点落在 renewLead 之内，属于续期窗口（下一组），
      // 不是 valid——原判定在这里埋了一个 renewLead≈0 的隐含假设。
      expect(
        AmooIdentitySpec.stateAt(
          issuedAt: issuedAt,
          expiresAt: expiresAt,
          now: issuedAt,
        ),
        AmooCertState.valid,
      );
      expect(
        AmooIdentitySpec.stateAt(
          issuedAt: issuedAt,
          expiresAt: expiresAt,
          now: expiresAt.subtract(
              AmooIdentitySpec.renewLead + const Duration(milliseconds: 1)),
        ),
        AmooCertState.valid,
      );
      expect(
        AmooIdentitySpec.stateAt(
          issuedAt: issuedAt,
          expiresAt: expiresAt,
          now: expiresAt,
        ),
        AmooCertState.expired,
      );
    });

    test('进入续期窗口就报 expiringSoon，不等它过期', () {
      expect(
        AmooIdentitySpec.stateAt(
          issuedAt: issuedAt,
          expiresAt: expiresAt,
          now: expiresAt.subtract(AmooIdentitySpec.renewLead),
        ),
        AmooCertState.expiringSoon,
      );
    });

    test('时钟回拨不会把 expired 翻回 valid', () {
      // 过期是「已经过去」的事实，不该被系统时间改动改写。
      expect(
        AmooIdentitySpec.stateAt(
          issuedAt: issuedAt,
          expiresAt: expiresAt,
          now: expiresAt.add(const Duration(hours: 5)),
        ),
        AmooCertState.expired,
      );
    });
  });

  group('error code（K-14）', () {
    test('过期给 credential_expired，不是笼统的 unauthorized', () {
      // K-14：续期失败要能说清是哪一种失效，否则用户只会看到「未授权」。
      expect(AmooIdentitySpec.errorCredentialExpired, 'credential_expired');
      expect(
        AmooIdentitySpec.stateErrorCode(AmooCertState.expired),
        'credential_expired',
      );
      expect(AmooIdentitySpec.stateErrorCode(AmooCertState.valid), isNull);
      // 拒绝码只挂在到期：续期窗口内的提醒不是拒绝——契约错误码表
      // （K-23 那 15 个）里没有「即将过期」这个码，窗口内照常受理。
      expect(AmooIdentitySpec.stateErrorCode(AmooCertState.expiringSoon), isNull);
    });

    test('剩多久到期要说清，且过期后读数是 0 不是负数', () {
      // K-14 的「明确报凭证将在 X 后失效」——X 从这里读。负的倒计时拼进
      // 用户可见文本就是「将在 -1 小时后失效」。
      expect(
        AmooIdentitySpec.remainingUntilExpiry(
          expiresAt: expiresAt,
          now: expiresAt.subtract(const Duration(minutes: 90)),
        ),
        const Duration(minutes: 90),
      );
      expect(
        AmooIdentitySpec.remainingUntilExpiry(
          expiresAt: expiresAt,
          now: expiresAt.add(const Duration(minutes: 5)),
        ),
        Duration.zero,
      );
    });
  });

  group('private key location（K-11）', () {
    test('模块自己推导的私钥落点过自己的私有谓词，且不落共享存储', () {
      // 谓词与落点必须闭环：只钉谓词，实现尽可以一边让谓词判 /sdcard 不私有、
      // 一边把钥匙写到 /sdcard。设备侧 B3-b 核的就是这条链的末端。
      final path = AmooIdentitySpec.privateKeyPath('com.khyos.khy_os_client');
      expect(path, isNotEmpty);
      expect(path, contains('com.khyos.khy_os_client'));
      expect(
        AmooIdentitySpec.isPrivateLocation(path),
        isTrue,
        reason: '私钥落点必须落在 App 私有目录：$path',
      );
      expect(path, isNot(contains('/sdcard')));
      expect(path, isNot(contains('/storage/emulated')));
    });

    test('App 私有目录算私有', () {
      expect(
        AmooIdentitySpec.isPrivateLocation(
            '/data/user/0/com.khyos.khy_os_client/app_flutter/amoo_key.pem'),
        isTrue,
      );
      expect(
        AmooIdentitySpec.isPrivateLocation(
            '/data/data/com.khyos.khy_os_client/files/amoo_key.pem'),
        isTrue,
      );
    });

    test('共享存储与 shell 可读目录一律不算私有', () {
      // ProvisioningCode.java 的原文：桥的 Bearer 令牌落在 /sdcard 上，
      // 「持有桥令牌」于是不是强声明——任何有存储权限的 App、adb shell、
      // 一台连上线的电脑都读得到。私钥不能走同一条路。
      for (final path in const [
        '/sdcard',
        '/sdcard/bridge-amoobridge/token.txt',
        '/sdcard/amoo_key.pem',
        '/storage/emulated/0/amoo_key.pem',
        '/data/local/tmp/amoo_key.pem',
      ]) {
        expect(
          AmooIdentitySpec.isPrivateLocation(path),
          isFalse,
          reason: '$path 不是 App 私有目录',
        );
      }
    });

    test('空串与相对路径不算私有', () {
      // 相对路径的落点取决于进程 cwd，那不是「私有」的保证。
      expect(AmooIdentitySpec.isPrivateLocation(''), isFalse);
      expect(AmooIdentitySpec.isPrivateLocation('amoo_key.pem'), isFalse);
    });
  });

  group('peer registry（K-13 / K-10）', () {
    test('未登记的对等体一律拒', () {
      final peers = AmooPeerRegistry();
      expect(peers.isRegistered('amoo-cloud'), isFalse);
      expect(AmooIdentitySpec.errorUnknownPeer, 'unknown_peer');
    });

    test('握过手的才放行，且大小写不糊弄', () {
      final peers = AmooPeerRegistry();
      peers.register('amoo-cloud');
      expect(peers.isRegistered('amoo-cloud'), isTrue);
      expect(peers.isRegistered('amoo-Cloud'), isFalse);
    });

    test('登记簿是每次握手一份，不是进程全局', () {
      // K-13 的登记来自握手交换。进程全局的登记表会让上一段连接登记过的
      // 身份在新连接里直接放行——那等于没有握手。
      AmooPeerRegistry().register('amoo-cloud');
      expect(AmooPeerRegistry().isRegistered('amoo-cloud'), isFalse);
    });

    test('身份形状：1-64 位 [A-Za-z0-9_-]，与信封 session_id 同款', () {
      // 握手交换的 identity 与信封 session_id 同一套形状（contract §3.1），
      // 两端才不用为对方的身份长什么样猜规则。
      expect(AmooIdentitySpec.isValidIdentity('amoo-cloud'), isTrue);
      expect(AmooIdentitySpec.isValidIdentity('A_b-9'), isTrue);
      expect(AmooIdentitySpec.isValidIdentity(''), isFalse);
      expect(AmooIdentitySpec.isValidIdentity('amoo cloud'), isFalse);
      expect(AmooIdentitySpec.isValidIdentity('amoo.cloud'), isFalse);
      expect(AmooIdentitySpec.isValidIdentity('中文'), isFalse);
      expect(AmooIdentitySpec.isValidIdentity('x' * 65), isFalse);
    });

    test('形状不合格的身份登记不进来', () {
      expect(() => AmooPeerRegistry().register('amoo cloud'), throwsArgumentError);
      expect(() => AmooPeerRegistry().register(''), throwsArgumentError);
    });
  });

  group('verify：拒的理由要说清（K-13 + K-14，B3-c 设备读数同源）', () {
    test('握过手且在窗口内 → 放行', () {
      final peers = AmooPeerRegistry()..register('amoo-cloud');
      expect(
        AmooIdentity.verify(
          cert: issueCert(),
          peers: peers,
          now: issuedAt.add(const Duration(hours: 1)),
        ),
        isNull,
      );
    });

    test('过期 → credential_expired', () {
      final peers = AmooPeerRegistry()..register('amoo-cloud');
      expect(
        AmooIdentity.verify(cert: issueCert(), peers: peers, now: expiresAt),
        AmooIdentitySpec.errorCredentialExpired,
      );
    });

    test('没握过手的对等体 → unknown_peer', () {
      final peers = AmooPeerRegistry()..register('amoo-other');
      expect(
        AmooIdentity.verify(
          cert: issueCert(),
          peers: peers,
          now: issuedAt.add(const Duration(hours: 1)),
        ),
        AmooIdentitySpec.errorUnknownPeer,
      );
    });

    test('从签发到拒的闭环：续期窗口内照常受理，跨过到期线即拒', () {
      // 设备侧 B3-c 能读到的就是「被拒 + 错误码」；这一条把单元侧的同一幕
      // 钉住：同一张证书，到期线两侧各验一次。K-14 的「停止受理」挂在
      // 到期，不挂在「该续期了」这个提醒上——否则每张证书的最后 renewLead
      // 都会变成一段拒绝窗口。
      final cert = issueCert();
      final peers = AmooPeerRegistry()..register('amoo-cloud');
      expect(
        AmooIdentity.verify(
          cert: cert,
          peers: peers,
          now: cert.expiresAt.subtract(AmooIdentitySpec.renewLead),
        ),
        isNull,
      );
      expect(
        AmooIdentity.verify(cert: cert, peers: peers, now: cert.expiresAt),
        AmooIdentitySpec.errorCredentialExpired,
      );
    });
  });
}
