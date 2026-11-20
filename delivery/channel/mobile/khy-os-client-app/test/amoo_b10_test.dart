import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/security/amoo_security_spec.dart';
import 'package:khy_os_client/core/services/audit_log.dart';

/// B10 安全收敛的单元侧：凭据落点规则、无障碍按需能力表、审计按时间查。
///
/// 判据锚点：TASK.md §4 B10「密钥清零、token 不落 /sdcard、无障碍按需+审计；
/// 判静态无内置密钥；无障碍关时主功能可用；审计可按时间查调用方与用途」，
/// contract.md K-72（默认不出本机清单）/ K-75（凭据只进 App 私有目录 + Keystore、
/// 永不落 /sdcard）/ K-83（审计可按时间查调用方与用途）。
///
/// 分工（不要在这里重复造）：
///   - 「静态无内置密钥」由 `checks/b10_static_keys.cmd`（源码+配置）与
///     `checks/b10_apk_scan.cmd`（出厂件）判。这个文件再去扫源码，就会出现
///     两个能各自翻绿的同一判据。
///   - 「运行后 /sdcard 无新 token.txt」是设备侧观测，见 `device/B10.md`；
///     私钥落点谓词的特例在 B3 的 `AmooIdentitySpec`（`test/amoo_b3_test.dart`），
///     这里管的是**所有凭据**（桥令牌、证书、沙箱密钥）的通盘落点规则。
///   - 「无障碍关时主功能可用」的设备侧证见 `device/B10.md` B10-a；这里钉的是
///     那份能力表本身——没有它，设备判定连「主功能」指什么都没法机械回答。
///
/// `lib/core/security/amoo_security_spec.dart` 尚不存在，`AuditLog` 也还没有
/// 时间窗查询，所以这个套件今天是红的（缺模块 + 缺行为）。符号名与形状就是契约：
/// 要改先回 contract.md §2/§9 重新推导，不许为了让测试过而把断言改松。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('credential location', () {
    test('共享存储不是凭据的落脚点', () {
      // K-75 原文：凭据只进 App 私有目录 + Keystore、永不落 /sdcard。
      // 桥的 Bearer 令牌今天落在 /sdcard（contract R-7 记的迁移期双轨），
      // 那正是这条规则要挡住的东西。
      for (final path in const [
        '/sdcard',
        '/sdcard/bridge-amoobridge/token.txt',
        '/storage/emulated/0/amoo_cert.json',
        '/data/local/tmp/amoo_key.pem',
        '/mnt/sdcard/secret.bin',
      ]) {
        expect(AmooCredentialSpec.isSharedStoragePath(path), isTrue,
            reason: '$path 是共享/可读存储');
        expect(AmooCredentialSpec.allowsCredentialWrite(path), isFalse,
            reason: '$path 不许写凭据');
      }
    });

    test('App 私有目录才是凭据的落脚点', () {
      for (final path in const [
        '/data/data/com.khyos.khy_os_client/files/amoo_cert.json',
        '/data/user/0/com.khyos.khy_os_client/app_flutter/amoo_key.pem',
      ]) {
        expect(AmooCredentialSpec.isAppPrivatePath(path), isTrue,
            reason: '$path 是 App 私有目录');
        expect(AmooCredentialSpec.allowsCredentialWrite(path), isTrue);
      }
    });

    test('空串与相对路径不许写凭据', () {
      // 相对路径的落点取决于进程 cwd，那不是「私有」的保证——与 B3 的
      // 私钥落点谓词同一条理由，两边不许给出不同答案。
      expect(AmooCredentialSpec.allowsCredentialWrite(''), isFalse);
      expect(AmooCredentialSpec.allowsCredentialWrite('token.txt'), isFalse);
      expect(AmooCredentialSpec.allowsCredentialWrite('vfs/amoo_key.pem'), isFalse);
    });

    test('共享存储与 App 私有目录不能互相冒充', () {
      // 谓词不是同一个布尔值的两种拼写：一条路径被判「共享」时它必须不是私有的，
      // 否则规则自相矛盾，实现方可以挑一个宽松的用。
      const shared = '/sdcard/bridge-amoobridge/token.txt';
      const private = '/data/data/com.khyos.khy_os_client/files/amoo_cert.json';
      expect(AmooCredentialSpec.isAppPrivatePath(shared), isFalse);
      expect(AmooCredentialSpec.isSharedStoragePath(private), isFalse);
    });
  });

  group('accessibility on demand', () {
    test('主链路功能不依赖无障碍', () {
      // B10 判据原文「无障碍关时主功能可用」。这份表是那句话的机械定义：
      // 设备侧据此逐项核验，实现方也没法悄悄让主链路依赖上读屏能力。
      for (final feature in AmooAccessibilitySpec.mainFeatures) {
        expect(AmooAccessibilitySpec.requiresAccessibility(feature), isFalse,
            reason: '$feature 是主链路功能，关掉无障碍也必须可用');
      }
    });

    test('读屏/手势/截屏才依赖无障碍', () {
      for (final feature in AmooAccessibilitySpec.accessibilityFeatures) {
        expect(AmooAccessibilitySpec.requiresAccessibility(feature), isTrue,
            reason: '$feature 走无障碍服务');
      }
    });

    test('两份清单不交叠，且都不是空的', () {
      // 空的主功能清单会让「主功能可用」变成一句无对象的话；
      // 交叠则意味着同一个功能既被承诺可用又被声明依赖一个可能关闭的服务。
      expect(AmooAccessibilitySpec.mainFeatures, isNotEmpty);
      expect(AmooAccessibilitySpec.accessibilityFeatures, isNotEmpty);
      expect(
        AmooAccessibilitySpec.mainFeatures
            .toSet()
            .intersection(AmooAccessibilitySpec.accessibilityFeatures.toSet()),
        isEmpty,
      );
    });

    test('没分类的功能不许被悄悄当成主链路', () {
      // 新增功能却不进表，是最容易发生的退化：表看着没缩水，
      // 新功能既没被承诺也没被声明依赖。宁可这里炸，也不要一个无声的答案。
      expect(
        () => AmooAccessibilitySpec.requiresAccessibility('not_a_real_feature'),
        throwsArgumentError,
      );
    });
  });

  group('audit query by time window', () {
    late Directory tmp;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('khy_audit_b10');
      AuditLog.useDirectoryForTest(tmp);
    });

    tearDown(() {
      AuditLog.useDirectoryForTest(null);
      try {
        tmp.deleteSync(recursive: true);
      } catch (_) {}
    });

    final base = DateTime.utc(2026, 11, 13, 10);

    AuditEntry entryAt(DateTime t, String operation, {String detail = 'ls /sdcard'}) {
      return AuditEntry(
        time: t,
        source: AuditSource.ai,
        operation: operation,
        path: '',
        detail: detail,
      );
    }

    void seedFile(List<AuditEntry> entries) {
      // 直接写盘，模拟「上一个进程已经记过账」：查询必须从文件答得出，
      // 而不是只答得出本进程内存里那几条。
      final file = File('${tmp.path}${Platform.pathSeparator}audit.jsonl');
      file.writeAsStringSync(
        '${entries.map((e) => '${jsonEncode(e.toJson())}\n').join()}',
      );
    }

    test('窗口两端都含，窗口外一条不带', () async {
      seedFile([
        entryAt(base.subtract(const Duration(minutes: 1)), 'shell'),
        entryAt(base, 'shell'),
        entryAt(base.add(const Duration(minutes: 5)), 'shell'),
        entryAt(base.add(const Duration(minutes: 10)), 'shell'),
        entryAt(base.add(const Duration(minutes: 11)), 'shell'),
      ]);

      final windowEnd = base.add(const Duration(minutes: 10));
      final got = await AuditLog.instance.queryWindow(from: base, to: windowEnd);

      expect(got.length, 3, reason: '窗口 [10:00, 10:10] 该带回三条，边界含');
      // 审计文件里 time 是 epoch ms，回灌出来是本地时刻；窗口边界用的是 UTC。
      // DateTime 的 == 分 isUtc，直接比对象永远不相等——要比的是时刻本身。
      expect(got.map((e) => e.time.toUtc()).toList(), [
        base.add(const Duration(minutes: 10)),
        base.add(const Duration(minutes: 5)),
        base,
      ], reason: '与 recent 同序：新的在前');
    });

    test('每条都答得出调用方与用途', () async {
      // K-83：审计可按时间查调用方与用途。查回来一条看不出是谁、为了什么的记录，
      // 等于没查。
      seedFile([
        AuditEntry(
          time: base,
          source: AuditSource.ai,
          operation: 'shell',
          path: '',
          detail: 'ls -l /sdcard/bridge-amoobridge',
        ),
      ]);

      final got = await AuditLog.instance.queryWindow(from: base, to: base);
      expect(got, hasLength(1));
      final entry = got.single;
      expect(entry.source, AuditSource.ai);
      expect(entry.operation, 'shell');
      expect(entry.detail, contains('ls -l /sdcard/bridge-amoobridge'));
      expect(entry.time.toUtc(), base);
    });

    test('本进程刚记的也能按时间查回来', () async {
      // 真实顺序是「先操作、后查账」——与 audit_log_test 钉过的回灌次序同一处。
      await AuditLog.instance.record(
        AuditSource.user,
        'terminal',
        '',
        detail: 'echo b10',
      );
      final got = await AuditLog.instance.queryWindow(
        from: DateTime.now().subtract(const Duration(minutes: 1)),
        to: DateTime.now().add(const Duration(minutes: 1)),
      );
      expect(got, isNotEmpty);
      expect(got.first.operation, 'terminal');
      expect(got.first.detail, contains('echo b10'));
    });

    test('from 晚于 to 时答空，不答错', () async {
      seedFile([entryAt(base, 'shell')]);
      final got = await AuditLog.instance.queryWindow(
        from: base.add(const Duration(minutes: 1)),
        to: base,
      );
      expect(got, isEmpty);
    });

    test('查询不影响 recent（不许为了新行为改旧语义）', () async {
      seedFile([entryAt(base, 'shell'), entryAt(base.add(const Duration(minutes: 1)), 'copy', detail: '/a -> /b')]);
      await AuditLog.instance.queryWindow(from: base, to: base.add(const Duration(minutes: 1)));
      final recent = await AuditLog.instance.recent();
      expect(recent.length, 2);
      expect(recent.first.operation, 'copy');
    });
  });
}
