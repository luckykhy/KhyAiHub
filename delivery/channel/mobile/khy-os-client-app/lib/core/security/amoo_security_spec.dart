// B10 安全收敛的两份机器可判真源：凭据落点规则、无障碍按需能力表。
//
// 为什么单独一份：这两份表要被三方同时读到——单元门
// （test/amoo_b10_test.dart）机械钉住形状，设备侧判定（device/B10.md）据此
// 逐项核验，桥与 Dart 的调用点据此决定「这个操作允不允许落在这里」。
// 拆成两个类是因为它们回答两个不同的问题；合成一个类，改一边就会顺手
// 改掉另一边。
//
// 纯 Dart、不 import Flutter：和 core/security/guard.dart 同一个理由——
// 判定表要能在任何跑得起来 Dart 的地方被执行。

library;

import '../vfs/vfs_route.dart';

/// 凭据（桥 Bearer 令牌、配对证书、沙箱 secret_*、私钥）允许落在哪。
///
/// 判据只有一条（contract K-75）：凭据只进 App 私有目录 + Keystore、永不落
/// /sdcard。所以主谓词是 [allowsCredentialWrite]；另外两个是它拆出来的可读
/// 半边——设备侧判定要把「私有」与「共享」分别报给人看，一个布尔答不出。
abstract final class AmooCredentialSpec {
  /// App 私有目录前缀。复用 VfsRoots.privatePrefixes，不在这里抄第二份：
  /// 抄了就会出现「VFS 认的私有」与「凭据认的私有」不是同一处。
  static const List<String> _privatePrefixes = VfsRoots.privatePrefixes;

  /// App 私有目录之外的落点。三类，理由各不相同：
  ///  - `/storage/emulated/`：共享存储的真身。VfsPath.normalize 会把
  ///    `/sdcard`、`/storage/self/primary` 两个别名折到这里，所以这一个前缀
  ///    就覆盖了用户最常敲的那几种写法（vfs_route.dart:232-241）。
  ///  - `/mnt/sdcard`：老 ROM 上的符号链接形态，别名表里没有它、折不过来，
  ///    而桥的历史信箱目录正是在这种形态下被找到的。
  ///  - `/data/local/tmp`：adb shell 与世界可读的临时目录。它不是「共享存储」，
  ///    但任何能连 adb 的人都能把它整个读走——对凭据来说与共享存储同罪。
  static const List<String> _outsidePrivatePrefixes = <String>[
    '/storage/emulated/',
    '/mnt/sdcard',
    '/data/local/tmp',
  ];

  /// 这个路径是不是 App 私有目录（含 App 自己建的子目录）。
  static bool isAppPrivatePath(String path) =>
      _hasPrefix(VfsPath.normalize(path), _privatePrefixes);

  /// 这个路径是不是「别的进程 / adb 也碰得到」的位置。
  ///
  /// 名字叫 shared 是契约（单元门钉住这个符号），判据是「私有可能守不住」，
  /// 而不是「它一定叫共享存储」——见 [_outsidePrivatePrefixes] 的第三条。
  static bool isSharedStoragePath(String path) =>
      _hasPrefix(VfsPath.normalize(path), _outsidePrivatePrefixes);

  /// 凭据允不允许写到这里。默认拒绝：没被认出是 App 私有目录的路径一律不许
  /// 写——「不认识」不等于「安全」。
  static bool allowsCredentialWrite(String path) {
    final normalized = VfsPath.normalize(path);
    // 相对路径与空串：落点取决于进程 cwd，那不是私有性的保证。与 B3 的私钥
    // 落点谓词同一条理由，两边必须给出同一个答案。
    if (!normalized.startsWith('/')) return false;
    if (isSharedStoragePath(normalized)) return false;
    return isAppPrivatePath(normalized);
  }

  /// 整段相等、或以其 + `/` 开头才算命中。纯 startsWith 会把 `/sdcardX` 这种
  /// 用户自建目录误判成 `/sdcard` 的别名（vfs_route.dart:222 同一个理由）。
  static bool _hasPrefix(String path, List<String> prefixes) {
    for (final prefix in prefixes) {
      if (path == prefix) return true;
      if (path.startsWith(prefix.endsWith('/') ? prefix : '$prefix/')) {
        return true;
      }
    }
    return false;
  }
}

/// 「无障碍按需」的能力表：哪些功能关掉无障碍也必须可用，哪些走无障碍服务。
///
/// B10 判据原文「无障碍关时主功能可用」。这句话要能机械回答，就得有一份表
/// 说清「主功能」指什么——没有它，设备侧判定只能挑两个工具试试，实现方也
/// 可以悄悄让主链路依赖上读屏能力而没人发现。
///
/// 名字用桥的工具名（`bridge/Tools.java` 的 NAMES；contract K-41：设备侧
/// 工具名逐字等于桥名，不许造别名）。
abstract final class AmooAccessibilitySpec {
  /// 走无障碍服务的功能：读屏、手势、截屏，外加 Amoo 反代循环的两个发起面。
  ///
  /// 前 11 个是路由事实：Tools.java 把 `ui_*` / `shot` / `shot_b64` 一律转给
  /// KhyUi.dispatch，它再转给 app 的 KhyAccessibilityService
  /// （Tools.java:1797-1799）。
  /// `amoo_ask` 与 `loop_start` 在表里，是因为循环读 Amoo 的界面、往输入框
  /// 写字、点发送全走同一个服务（AmooLoop.java 的 KhyUi.dispatch 调用链；
  /// Tools.java:97-124 记着实测：无障碍没开时 amoo_ask 不 fail-fast，空转满
  /// 预算才报 timeout）。`loop_status` / `loop_stop` / `amoo_result` /
  /// `amoo_memory` / `amoo_stop` 只读写循环态与记忆文件、不碰屏幕，所以不在这张表里。
  static const List<String> accessibilityFeatures = <String>[
    'ui_dump', 'ui_tap', 'ui_click', 'ui_swipe', 'ui_longpress', 'ui_type',
    'ui_back', 'ui_home', 'ui_recents', 'shot', 'shot_b64',
    'amoo_ask', 'loop_start',
  ];

  /// 主链路功能：关掉无障碍也必须答得了。
  ///
  /// 与 [accessibilityFeatures] 合起来正好覆盖桥的 NAMES 全部 50 个——漏一个
  /// 就是「新功能既没被承诺可用、也没被声明依赖」。这里显式列出来而不是算
  /// 差集：Dart 侧没有桥的 NAMES 可对，写出来才能被单元门钉住、被人 review。
  static const List<String> mainFeatures = <String>[
    'ping', 'info', 'tools',
    'exec', 'ls', 'read', 'write', 'mkdir', 'rm', 'mv', 'cp', 'stat',
    'start_app', 'open_url', 'share_text', 'clipboard', 'toast', 'notify',
    'list_apps', 'battery', 'volume', 'brightness', 'vibrate', 'record_audio',
    'camera_open', 'adou_signin', 'zip', 'unzip',
    'secret_code', 'secret_put', 'secret_list', 'secret_del',
    'loop_stop', 'loop_status', 'amoo_result', 'amoo_memory', 'amoo_stop',
  ];

  /// 这个功能依不依赖无障碍服务。
  ///
  /// 没分类的功能一律 ArgumentError，不返回 false：新增工具却不进表是最容易
  /// 发生的退化——表看着没缩水，新功能既没被承诺也没被声明依赖。宁可在这里炸，
  /// 也不要一个无声的答案。
  static bool requiresAccessibility(String feature) {
    if (mainFeatures.contains(feature)) return false;
    if (accessibilityFeatures.contains(feature)) return true;
    throw ArgumentError.value(
      feature,
      'feature',
      '未分类：既不在主链路清单也不在无障碍依赖清单，先归类再调用',
    );
  }
}
