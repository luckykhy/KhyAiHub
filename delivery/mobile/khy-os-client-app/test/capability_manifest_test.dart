import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/local_model_store.dart';
import 'package:path/path.dart' as p;

/// 能力资产清单的版本判断。
///
/// WHY THIS FILE EXISTS. 「已安装」曾经由 `File.existsSync()` 回答，它分不出
/// 2026-10-27 下的那一份和一个更新版——用户会永远拿着旧模型，而且没有任何东西
/// 会告诉他。manifest 把「装没装」拆成三态（没装 / 装了但是旧版 / 就是这一版），
/// 这里钉住三态各自的判据，以及一条不能破的规则：
///
///   * 同一 sha → 跳过，不重下 2.8 GB；
///   * 不同 sha → 升级；
///   * **投影器缺失时 isReady 仍为 false**——没有投影器的引擎能照样回答文本
///     提问，那会让它对着一块看不见的屏幕给出自信的答案。`KhyLlama.load` 拒载，
///     Dart 侧必须同样拒绝。
///
/// 磁盘相关的那一组共用一个临时目录：`LocalModelStore` 是单例，存储目录只在第一次
/// `prepare()` 时解析并缓存，之后每个测试新建临时目录都不会被采纳——那样写出来的
/// 断言读的是另一个目录里的文件，会以「widget 有 bug」的样子失败。
///
/// 这一组同时钉住 `_hasFile` 的路径判据。它判的本来是「是不是绝对路径」，早期写成
/// `startsWith('/')`，在 POSIX 上等价、在 win32 上不等价：`Directory.systemTemp`
/// 在 Windows 上是 `C:\...`，于是 `isReady` 恒为 false，「两个文件都在」必失败，
/// 而两个「缺一个文件」的用例会以完全错误的原因（守卫拒掉所有路径）空洞通过。
/// 本仓主机 OS 是 win32，所以这不是假设场景。
void main() {
  // 合成资产。sha 场景要用真实哈希形状，字节数取小值，让测试不碰 2.8 GB。
  const shaA = 'a' * 64;
  const shaB = 'b' * 64;

  CapabilityAsset asset({
    String sha256 = '',
    int bytes = 1000,
    String version = 'v1',
  }) =>
      CapabilityAsset(
        name: 'thing.gguf',
        version: version,
        sha256: sha256,
        bytes: bytes,
        url: 'https://example.invalid/thing.gguf',
      );

  InstalledAsset installed({
    String version = 'v1',
    String sha256 = '',
    int bytes = 1000,
  }) =>
      InstalledAsset(
        version: version,
        sha256: sha256,
        bytes: bytes,
        installedAt: DateTime.utc(2026, 11, 4),
      );

  group('the manifest itself', () {
    test('declares name / version / sha256 / size / url for every asset', () {
      // 泛化成条目的全部意义：加一种能力 = 清单里加一行，不是 store 里加一套
      // existsSync 分支。所以每个字段都必须真的在，缺一个就退化成旧的写法。
      expect(LocalModelStore.manifest, hasLength(2));
      for (final entry in LocalModelStore.manifest) {
        expect(entry.name, isNotEmpty);
        expect(entry.version, isNotEmpty);
        expect(entry.bytes, greaterThan(0));
        expect(entry.url, startsWith('https://'));
        expect(entry.url, endsWith(entry.name));
      }
    });

    test('names both files of the vision pair', () {
      // 投影器不是可选项。两份文件一起断言，与 KhyLlama.load 拒载缺投影器的规则
      // 对齐。
      expect(
        LocalModelStore.manifest.map((e) => e.name),
        containsAll(<String>[
          LocalModelStore.modelFile,
          LocalModelStore.mmprojFile,
        ]),
      );
    });

    test('the download source is official unless the mirror flag is set', () {
      // PROCESS-013 C4：镜像不得默认生效。默认必须是官方源，opt-in 走
      // --dart-define=KHY_USE_CN_MIRROR=true。
      expect(LocalModelStore.cnMirrorFlag, 'KHY_USE_CN_MIRROR');
      expect(LocalModelStore.baseUrl, LocalModelStore.officialBaseUrl);
      // 两个源都要能用，且都指向 GGUF 仓库（不是 8.88 GB 的 safetensors 那个）。
      for (final url in <String>[
        LocalModelStore.officialBaseUrl,
        LocalModelStore.cnMirrorBaseUrl,
      ]) {
        expect(url, startsWith('https://'));
        expect(url, contains('GGUF'));
      }
    });
  });

  group('decideAssetAction', () {
    test('nothing on disk → download', () {
      // 先判这个，否则一个 0 字节的残留 .part 会被后面的 size 比较当成已安装。
      expect(
        decideAssetAction(asset: asset(), installed: null, bytesOnDisk: 0),
        AssetAction.download,
      );
    });

    test('same sha → skip, and never re-download', () {
      // 这是「本地已有且 sha 一致则跳过」的正题。2.8 GB 的连接会被手机自己
      // 打断，重下不是优化选项而是功能可用性的分界。
      expect(
        decideAssetAction(
          asset: asset(sha256: shaA),
          installed: installed(sha256: shaA),
          bytesOnDisk: 1000,
        ),
        AssetAction.skip,
      );
    });

    test('different sha → upgrade', () {
      expect(
        decideAssetAction(
          asset: asset(sha256: shaB),
          installed: installed(sha256: shaA),
          bytesOnDisk: 1000,
        ),
        AssetAction.upgrade,
      );
    });

    test('a stale version with no sha registered still upgrades', () {
      // 当前清单就是这种：sha256 未登记（2026-10-27 下载时没有登记哈希）。退化
      // 成按版本号判断，否则「版本升级」这条路从来没被走过。
      expect(
        decideAssetAction(
          asset: asset(version: 'v2'),
          installed: installed(version: 'v1'),
          bytesOnDisk: 1000,
        ),
        AssetAction.upgrade,
      );
    });

    test('same version and exact bytes → skip', () {
      expect(
        decideAssetAction(
          asset: asset(version: 'v1'),
          installed: installed(version: 'v1', bytes: 1000),
          bytesOnDisk: 1000,
        ),
        AssetAction.skip,
      );
    });

    test('same version but the file was truncated → upgrade', () {
      // installed.bytes 记的是实测长度。磁盘上少了字节就是坏了，不能跳过。
      expect(
        decideAssetAction(
          asset: asset(version: 'v1'),
          installed: installed(version: 'v1', bytes: 1000),
          bytesOnDisk: 900,
        ),
        AssetAction.upgrade,
      );
    });

    test('legacy download with no record: size within tolerance → skip', () {
      // 本功能上线前的存量下载没有登记记录。大小对就当它是这个版本，否则清单一
      // 上线所有老用户都要重下 2.8 GB。
      final declared = LocalModelStore.modelBytes;
      final offBy = LocalModelStore.sizeToleranceFor(declared) - 1;
      expect(
        decideAssetAction(
          asset: asset(bytes: declared),
          installed: null,
          bytesOnDisk: declared - offBy,
        ),
        AssetAction.skip,
      );
    });

    test('legacy download with no record: size far off → download', () {
      expect(
        decideAssetAction(
          asset: asset(bytes: LocalModelStore.modelBytes),
          installed: null,
          bytesOnDisk: 5,
        ),
        AssetAction.download,
      );
    });

    test('the tolerance is bounded, not a blanket "close enough"', () {
      // 24 MB 的 1% 太松（一个被存储满截断的文件也会被判完整），固定 2 MiB 对
      // 小资产又太松。上限 2 MiB 已覆盖实测的 1 MB 误差。
      expect(
          LocalModelStore.sizeToleranceFor(LocalModelStore.modelBytes), 2 * 1024 * 1024);
      expect(LocalModelStore.sizeToleranceFor(1000), 64);
      expect(LocalModelStore.sizeToleranceFor(200 * 1024), 2 * 1024);
    });
  });

  group('CapabilityStatus.label', () {
    test('each action has its own sentence', () {
      const notInstalled = CapabilityStatus(
        asset: CapabilityAsset(
            name: 'x.gguf', version: 'v1', sha256: '', bytes: 1, url: 'u'),
        action: AssetAction.download,
        bytesOnDisk: 0,
      );
      const partial = CapabilityStatus(
        asset: CapabilityAsset(
            name: 'x.gguf', version: 'v1', sha256: '', bytes: 1, url: 'u'),
        action: AssetAction.download,
        bytesOnDisk: 1,
      );
      const stale = CapabilityStatus(
        asset: CapabilityAsset(
            name: 'x.gguf', version: 'v2', sha256: '', bytes: 1, url: 'u'),
        action: AssetAction.upgrade,
        bytesOnDisk: 1,
      );
      const fresh = CapabilityStatus(
        asset: CapabilityAsset(
            name: 'x.gguf', version: 'v1', sha256: '', bytes: 1, url: 'u'),
        action: AssetAction.skip,
        bytesOnDisk: 1,
      );

      expect(notInstalled.label, '未安装');
      // 「下到一半」和「没下过」对用户的下一步不同，不能合成一句。
      expect(partial.label, contains('已下了一部分'));
      expect(stale.label, contains('v2'));
      expect(stale.needsFetch, isTrue);
      expect(fresh.label, contains('已是最新'));
      expect(fresh.needsFetch, isFalse);
    });
  });

  group('on disk', () {
    late Directory tmp;

    setUpAll(() async {
      // path_provider 走平台通道，必须 mock；不 mock 的话 MissingPluginException
      // 会让整个分组证明不了任何事。指向真实临时目录，文件账才真的被走到。
      TestWidgetsFlutterBinding.ensureInitialized();
      tmp = await Directory.systemTemp.createTemp('khyos-capability-test');
      addTearDown(() => tmp.deleteSync(recursive: true));
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (call) async => tmp.path,
      );
      await LocalModelStore.instance.prepare();
    });

    /// 模型目录是支持目录下的 `models/` 子目录，不是支持目录本身。
    String pathOf(String name) => '${tmp.path}/models/$name';

    /// 每个测试前清空。单例缓存的目录只有一个，不清就会读到上一个测试的残渣。
    void clearModels() {
      final models = Directory('${tmp.path}/models');
      if (!models.existsSync()) return;
      for (final entry in models.listSync()) {
        entry.deleteSync(recursive: true);
      }
    }

    void writeFile(String name, String content) {
      File(pathOf(name)).writeAsStringSync(content);
    }

    test('the paths the store hands out are absolute on the host platform', () {
      // 判据是「是不是绝对路径」，不是「是不是以 / 开头」。这条在 win32 上才会
      // 真正咬住：Directory.systemTemp 给的是 C:\...，一个只认 '/' 的守卫会把
      // 它当相对路径拒掉，于是本组后面三条 isReady 用例全部失去意义。
      clearModels();
      expect(p.isAbsolute(LocalModelStore.instance.modelPath), isTrue);
      expect(p.isAbsolute(LocalModelStore.instance.mmprojPath), isTrue);
    });

    test('a missing projector means isReady is false', () {
      // 没有投影器的引擎照样能回答文本提问——那会让它对着一块看不见的屏幕给出
      // 自信的答案。KhyLlama.load 拒载，这里必须同样拒绝。
      clearModels();
      writeFile(LocalModelStore.modelFile, 'not really a gguf');
      expect(LocalModelStore.instance.isReady, isFalse);
    });

    test('a missing text model means isReady is false too', () {
      clearModels();
      writeFile(LocalModelStore.mmprojFile, 'not really a gguf');
      expect(LocalModelStore.instance.isReady, isFalse);
    });

    test('both files present → ready', () {
      // 这条是 win32 上唯一能证明「守卫没在误杀」的用例：两个文件都在却报 false，
      // 就说明 _hasFile 把合法绝对路径当相对路径拒了。
      clearModels();
      writeFile(LocalModelStore.modelFile, 'not really a gguf');
      writeFile(LocalModelStore.mmprojFile, 'not really a gguf');
      expect(LocalModelStore.instance.isReady, isTrue);
    });

    test('a registered, matching asset is reported as up to date', () async {
      // 手写登记文件而不是走 download()：下载要 2.8 GB 真流量，而登记文件的
      // 格式本身就是磁盘契约的一部分，值得被单独钉住。
      //
      // bytes 用 3 而不是清单声明的 2.4 GB：单元测试里放一个 2.4 GB 的 fixture
      // 不可接受，而这一条要验的是「登记读得出来 + 版本比得上」，与声明大小无关
      // （大小比较由 decideAssetAction 的纯函数用例覆盖）。
      clearModels();
      final entry = LocalModelStore.manifest.first;
      writeFile(entry.name, 'abc');
      File(pathOf('capability-manifest.json')).writeAsStringSync(
        jsonEncode(<String, dynamic>{
          'assets': {
            entry.name: <String, dynamic>{
              'version': entry.version,
              'sha256': entry.sha256,
              'bytes': 3,
              'installedAt': '2026-11-04T00:00:00.000Z',
            },
          },
        }),
      );

      final statuses = await LocalModelStore.instance.capabilityStatuses();
      final model = statuses.firstWhere((s) => s.asset.name == entry.name);
      expect(model.action, AssetAction.skip);
      expect(model.label, contains('已是最新'));
      // 投影器没装，必须是 download——两个资产各自判断，不互相牵连。
      final projector = statuses.firstWhere(
          (s) => s.asset.name == LocalModelStore.mmprojFile);
      expect(projector.action, AssetAction.download);
    });

    test('a corrupt record file degrades to the legacy branch', () async {
      // 登记写一半就断电是真实风险。读不出来时按存量规则判（大小对就当是这个
      // 版本），而不是抛——抛出去会让整个设置页打不开，而损坏的登记文件不该有
      // 这个权力。
      clearModels();
      final entry = LocalModelStore.manifest.first;
      // 大小远远对不上，所以这里要的是 download：证明它确实走了存量分支，
      // 而不是碰巧跳过。
      writeFile(entry.name, 'abc');
      File(pathOf('capability-manifest.json'))
          .writeAsStringSync('{ not json');

      final statuses = await LocalModelStore.instance.capabilityStatuses();
      expect(statuses.first.action, AssetAction.download);
    });
  });
}
