import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// Where the built-in vision model lives and how it gets there.
///
/// WHY THIS EXISTS. The requirement (2026-10-27) is a local vision model with no
/// Ollama install anywhere. The engine half is llama.cpp linked into the APK
/// (see `android/app/src/main/cpp/`); this file is the other half — the model
/// file itself, fetched on demand rather than shipped.
///
/// WHY NOT SHIP IT IN THE APK. The quantised pair is ~2.8 GB. Bundled as assets
/// that would mean a 2.8 GB APK, and because assets are stored compressed it
/// would have to be extracted on first run — 5.6 GB of peak storage and a first
/// launch measured in minutes. Downloaded on demand into the app's private
/// directory it is 2.8 GB once, resumable, and deletable from settings.
///
/// WHY THESE TWO FILES. `Qwen3VL-4B-Instruct-Q4_K_M.gguf` is the text model and
/// `mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf` is the vision projector that turns
/// pixels into embeddings. Both are required: without the projector the engine
/// can still answer text prompts, which is a trap — it would produce confident
/// answers about a screen it cannot see. `KhyLlama.load` therefore refuses a
/// missing projector rather than degrading, and [LocalModelStore.isReady] is the
/// same rule on the Dart side.
///
/// WHY QWEN3-VL AND NOT GELAB-Zero. The plan names GELab-Zero-4B, which is a
/// GUI-grounding fine-tune of exactly this base model — but it is published only
/// as 8.88 GB of bf16 safetensors, and llama.cpp consumes GGUF. Converting would
/// mean downloading 8.88 GB and running a torch conversion. The official
/// pre-quantised Qwen3-VL-4B GGUF is 2.8 GB and needs no conversion. It grounds
/// less sharply out of the box; that is a real quality difference, recorded here
/// rather than papered over, and the prompt in `vision_tools.dart` is written to
/// compensate (it asks for JSON with explicit 0-1000 coordinates and the parser
/// audits which coordinate space the model actually used).
///
/// WHY A MANIFEST (2026-11-04). Before, "is the model installed?" was answered by
/// `File.existsSync()`, which cannot tell a 2026-10-27 download from a newer one:
/// the user would keep an old pair forever and have no way to learn that. The
/// manifest below gives each asset a name / version / sha256 / size / url so the
/// store can answer "installed", "installed but stale" and "not installed"
/// separately — which is the whole difference between an update that works and an
/// update that silently does nothing.
class LocalModelStore {
  LocalModelStore._();

  static final LocalModelStore instance = LocalModelStore._();

  /// 显式 opt-in 的国内镜像开关名（`PROCESS-013` C4）。
  ///
  /// 判据是「镜像不得默认生效、不得由 locale/TZ 猜测触发」，所以这个名字必须与
  /// 镜像 URL 出现在同一个文件里——本文件。开启方式是编译期注入：
  /// `flutter build apk --dart-define=KHY_USE_CN_MIRROR=true`。
  ///
  /// 为什么默认走官方源：镜像同步有延迟，同一份代码在两处构建会拿到不同字节的
  /// 「同一个版本」，而流程照样成功——出问题时无从判断文件到底来自哪里。默认官方
  /// 源让这件事可复现；需要加速的人一键可开。
  static const String cnMirrorFlag = 'KHY_USE_CN_MIRROR';
  static const bool preferCnMirror = bool.fromEnvironment(cnMirrorFlag);

  /// HuggingFace 上的官方 GGUF 仓库（默认源）。
  static const officialBaseUrl =
      'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main';

  /// ModelScope 上的同一份 GGUF（字节相同的镜像，显式 opt-in 后才用）。
  ///
  /// 2026-10-23 实测：开发机所在网络直连 HuggingFace 不通、ModelScope 通。这个
  /// 事实记录在这里，是为了下一个在这种网络里构建的人知道该加哪个 dart-define，
  /// 不是为了把镜像变成默认值。
  static const cnMirrorBaseUrl =
      'https://modelscope.cn/models/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/master';

  /// 当前生效的下载源。
  static String get baseUrl =>
      preferCnMirror ? cnMirrorBaseUrl : officialBaseUrl;

  static const modelFile = 'Qwen3VL-4B-Instruct-Q4_K_M.gguf';
  static const mmprojFile = 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf';

  /// Approximate sizes, used for the progress UI before the first byte arrives.
  ///
  /// The authoritative size comes from the response's Content-Length (and a
  /// `Content-Range: bytes 0-0/<total>` probe, which is how these were measured
  /// on 2026-10-27); these are only a starting estimate so the bar is not empty
  /// for the first second. Both are within 1 MB of the real values.
  ///
  /// They double as the manifest's declared size, which is what the stale-check
  /// falls back to when no sha256 is registered (see [CapabilityAsset.sha256]).
  static const modelBytes = 2497281664;
  static const mmprojBytes = 453974304;

  /// 能力资产清单。当前唯一可独立下载的能力是内置视觉模型（文本模型 + 投影器一对）。
  ///
  /// `static final` 而不是 `const`：url 要拼 [baseUrl]，而 baseUrl 取决于编译期
  /// 的镜像开关，不是常量表达式。
  ///
  /// `sha256` 一律留空，这是**如实记录**而不是占位：2026-10-27 下载这对文件时
  /// 没有登记哈希，事后也没有重下 2.8 GB 去算。没有哈希时 [decideAssetAction]
  /// 退化成按版本号 + 字节数判断，并在 UI 上说明「未经哈希校验」——比填一个假
  /// 哈希、让用户以为校验过了要好。要启用真校验，把发布方给的 sha256 填进来即可，
  /// 判定逻辑不用改。
  static final List<CapabilityAsset> manifest = <CapabilityAsset>[
    CapabilityAsset(
      name: modelFile,
      version: 'qwen3-vl-4b-instruct-q4_k_m@2026-10-27',
      sha256: '',
      bytes: modelBytes,
      url: '$baseUrl/$modelFile',
    ),
    CapabilityAsset(
      name: mmprojFile,
      version: 'mmproj-qwen3-vl-4b-instruct-q8_0@2026-10-27',
      sha256: '',
      bytes: mmprojBytes,
      url: '$baseUrl/$mmprojFile',
    ),
  ];

  static const _partSuffix = '.part';

  /// 登记文件：哪个版本的能力资产已经装好。与资产同目录，删资产时一起删。
  static const _recordFile = 'capability-manifest.json';

  /// 声明字节数与实测的容差。
  ///
  /// [modelBytes] / [mmprojBytes] 是 2026-10-27 量的近似值（注释里写明与真实值
  /// 相差 1 MB 以内）。拿它们做**相等**比较，会让所有在本功能上线前就下好的模型
  /// 被判成「版本不符」而重下 2.8 GB——那正是增量判断要避免的事。
  ///
  /// 取「声明值的 1%、下限 64 B、上限 2 MiB」而不是一个固定值：2.4 GB 资产的 1%
  /// 是 24 MB（太松，一个被存储满截断的文件也会被判成完整），固定 2 MiB 对一个
  /// 假设中的 100 KB 资产又太松。上限 2 MiB 已经覆盖实测的 1 MB 误差。
  /// 只有存量分支（没有登记记录）用得到它；有登记时比的是实测长度，可以精确相等。
  static int sizeToleranceFor(int declaredBytes) {
    final relative = declaredBytes ~/ 100;
    if (relative < 64) return 64;
    const cap = 2 * 1024 * 1024;
    return relative > cap ? cap : relative;
  }

  /// Total bytes still to fetch, for the "will use ~2.8 GB" warning.
  int get totalBytes => modelBytes + mmprojBytes;

  bool get isReady {
    return _hasFile(modelPath) && _hasFile(mmprojPath);
  }

  bool _hasFile(String path) {
    // An unresolved directory makes `path` a bare filename, i.e. a RELATIVE
    // path — and File.existsSync on a relative path resolves against the
    // process CWD, which on Android is "/" . That would answer "not ready"
    // while the model is sitting right there, or worse, match an unrelated file
    // of the same name. Refusing to guess is the only safe reading.
    //
    // isAbsolute 而不是 startsWith('/')：判据本来是「是不是绝对路径」，而
    // startsWith('/') 只在 POSIX 上等于它。Windows 上 `C:\...\models\x.gguf`
    // 是绝对路径却被拒掉，于是 `flutter test` 在 win32（本仓主机 OS）上跑
    // isReady 相关用例时恒为 false——两个「缺一个文件」的用例会以完全错误的原因
    // 空洞通过，「两个文件都在」的用例必失败。Android 上两种写法等价（都是 POSIX
    // 上下文），改的只是让判据在测试机上真的被执行。
    if (path.isEmpty || !p.isAbsolute(path)) return false;
    final f = File(path);
    return f.existsSync() && f.lengthSync() > 0;
  }

  /// Absolute path to the text model, or '' before [prepare] has resolved the
  /// storage directory.
  ///
  /// Empty rather than relative, for the reason in [_hasFile]: a caller that
  /// forwards this to native gets a path the native side will refuse, instead
  /// of one that happens to resolve somewhere unintended.
  String get modelPath => _abs(modelFile);

  /// Absolute path to the vision projector, or '' before [prepare].
  String get mmprojPath => _abs(mmprojFile);

  String _abs(String filename) {
    final dir = _resolvedDirOrNull;
    return dir == null ? '' : '${dir.path}/$filename';
  }

  Directory? _resolvedDirOrNull;

  /// Resolve the storage directory lazily.
  ///
  /// path_provider needs a platform channel, which is not available in a plain
  /// `flutter test` — so this is resolved on first real use rather than in the
  /// constructor, and the pure helpers below never touch it.
  Future<Directory> _resolveDir() async {
    final cached = _resolvedDirOrNull;
    if (cached != null) return cached;
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/models');
    if (!d.existsSync()) d.createSync(recursive: true);
    _resolvedDirOrNull = d;
    return d;
  }

  /// Bytes already on disk for a given file, 0 if absent.
  int downloadedBytes(String filename) {
    // Same guard as _hasFile: a null directory must not silently become a
    // relative path. Returns 0, which the UI renders as "nothing downloaded" —
    // the honest answer when we do not know where the files are yet.
    final dir = _resolvedDirOrNull;
    if (dir == null) return 0;
    final f = File('${dir.path}/$filename');
    if (!f.existsSync()) return 0;
    return f.lengthSync();
  }

  /// Prepare storage and report what is already there.
  ///
  /// Returns the directory and the per-file byte counts so the UI can show
  /// "2.1 GB of 2.8 GB" on a cold start, which is the difference between a
  /// download that looks stuck and one that looks resumable.
  Future<LocalModelState> prepare() async {
    final d = await _resolveDir();
    return LocalModelState(
      dir: d.path,
      modelBytes: _sizeOf(modelFile),
      mmprojBytes: _sizeOf(mmprojFile),
      complete: isReady,
    );
  }

  int _sizeOf(String name) {
    final f = File('${_resolvedDirOrNull?.path}/$name');
    return f.existsSync() ? f.lengthSync() : 0;
  }

  CapabilityAsset? _assetFor(String filename) {
    for (final asset in manifest) {
      if (asset.name == filename) return asset;
    }
    return null;
  }

  /// 清单里每个能力资产与本地的比对结果，供设置页如实呈现。
  ///
  /// 与 [prepare] 的分工：那个回答「磁盘上有多少字节」，这个回答「这些字节是不
  /// 是清单说的那一版」。前者是进度，后者是版本，两者混在一起就会把「下到一半」
  /// 显示成「已装旧版」。
  Future<List<CapabilityStatus>> capabilityStatuses() async {
    final dir = await _resolveDir();
    _resolvedDirOrNull = dir;
    final installed = await _readInstalled();
    return manifest.map((asset) {
      final f = File('${dir.path}/${asset.name}');
      final onDisk = f.existsSync() ? f.lengthSync() : 0;
      return CapabilityStatus(
        asset: asset,
        action: decideAssetAction(
          asset: asset,
          installed: installed[asset.name],
          bytesOnDisk: onDisk,
        ),
        bytesOnDisk: onDisk,
      );
    }).toList();
  }

  Future<Map<String, InstalledAsset>> _readInstalled() async {
    final dir = _resolvedDirOrNull;
    if (dir == null) return const {};
    final f = File('${dir.path}/$_recordFile');
    if (!f.existsSync()) return const {};
    try {
      final parsed = jsonDecode(f.readAsStringSync());
      if (parsed is! Map) return const {};
      final assets = parsed['assets'];
      if (assets is! Map) return const {};
      final out = <String, InstalledAsset>{};
      assets.forEach((key, value) {
        if (value is Map) {
          out['$key'] = InstalledAsset.fromJson(Map<String, dynamic>.from(value));
        }
      });
      return out;
    } catch (_) {
      // 登记文件损坏时当作「没有登记」，让调用方走存量分支（按大小判断）。
      // 抛出去会让整个设置页打不开，而损坏的登记文件不该有这个权力。
      return const {};
    }
  }

  Future<void> _recordInstalled(CapabilityAsset asset, {required int bytes}) async {
    final dir = await _resolveDir();
    _resolvedDirOrNull = dir;
    final current = await _readInstalled();
    current[asset.name] = InstalledAsset(
      version: asset.version,
      sha256: asset.sha256,
      bytes: bytes,
      installedAt: DateTime.now().toUtc(),
    );
    final f = File('${dir.path}/$_recordFile');
    // 先写临时文件再改名：登记写一半就断电，会在下次启动时把「已安装」变成
    // 「没有登记」，用户被要求重下 2.8 GB。
    final tmp = File('${f.path}.tmp');
    tmp.writeAsStringSync(
      const JsonEncoder.withIndent('  ').convert(<String, dynamic>{
        'assets': {
          for (final entry in current.entries)
            entry.key: entry.value.toJson(),
        },
      }),
    );
    if (f.existsSync()) f.deleteSync();
    tmp.renameSync(f.path);
  }

  /// Download one file, resuming from whatever `.part` already holds.
  ///
  /// Returns true when the file is complete and in place.
  ///
  /// RESUME IS THE WHOLE DESIGN. A 2.8 GB download on a phone will be
  /// interrupted — the user locks the screen, switches apps, the ROM reclaims
  /// the socket. Restarting from zero each time makes the feature unusable in
  /// practice, so: download to `<name>.part`, and on the next attempt send a
  /// `Range` header for the remainder. The `.part` file is renamed into place
  /// only after the server confirms the full length, so an interrupted download
  /// never leaves a truncated file that looks complete.
  ///
  /// A server that ignores `Range` is handled too — see the 200-vs-206 check
  /// below. Appending a full response to an existing `.part` would produce a
  /// double-length file that passes the length check.
  Future<bool> download(
    String filename, {
    required void Function(int received, int total) onProgress,
  }) async {
    final dir = await _resolveDir();
    _resolvedDirOrNull = dir;
    final target = File('${dir.path}/$filename');
    final part = File('${dir.path}/$filename$_partSuffix');
    final asset = _assetFor(filename);

    if (asset != null) {
      // 增量判断：本地已有且与清单一致 → 跳过，不重下。
      //
      // 这里原先只判「文件存在且非空」，那意味着清单改了版本号也不会重下——用户
      // 拿着旧模型以为自己是新的，而这没有任何症状。改成与清单比对后又多一个
      // 风险：本功能上线前的存量下载没有登记记录，一律重下会让老用户重来 2.8 GB。
      // 存量那条路由 decideAssetAction 的 installed == null 分支兜住（大小对就当
      // 是这个版本，并顺手补登记）。
      final action = decideAssetAction(
        asset: asset,
        installed: (await _readInstalled())[filename],
        bytesOnDisk: target.existsSync() ? target.lengthSync() : 0,
      );
      if (action == AssetAction.skip) {
        final have = target.lengthSync();
        onProgress(have, have);
        await _recordInstalled(asset, bytes: have);
        return true;
      }
      if (action == AssetAction.upgrade) {
        // 升级必须连 .part 一起删。留着旧版的半截文件，下一次的 Range 会从旧版
        // 的偏移量接着写，拼出一份新旧混合、谁都不会认的文件。
        if (target.existsSync()) target.deleteSync();
        if (part.existsSync()) part.deleteSync();
      }
    } else if (target.existsSync() && target.lengthSync() > 0) {
      // 清单外的文件名（内部路径，正常不会发生）：保持「已在即跳过」。
      onProgress(target.lengthSync(), target.lengthSync());
      return true;
    }

    var have = part.existsSync() ? part.lengthSync() : 0;
    final request = http.Request('GET', Uri.parse(asset?.url ?? '$baseUrl/$filename'));
    if (have > 0) {
      request.headers['Range'] = 'bytes=$have-';
    }

    final response = await http.Client().send(request);
    if (response.statusCode != 200 && response.statusCode != 206) {
      throw ModelDownloadException(
          '下载失败（HTTP ${response.statusCode}）——镜像或网络问题，可重试');
    }

    // 服务端不理 Range 时回 200 而不是 206：它给的是**完整**文件。此时若把响应
    // append 到已有的 .part 上，得到的是「旧半截 + 完整全文」的双倍长文件，而下面
    // 的 received == total 会通过——一份加载后 deep inside llama.cpp 崩掉、且崩得
    // 没有任何指向性的模型。宁可从零重下，也不留一份看起来下完了的坏文件。
    // upgrade 分支删 .part 是同一回事，只是它按清单版本判断；这里按服务端的实际
    // 响应码判断，覆盖「清单没变但服务端行为不符合预期」的那种情况。
    if (have > 0 && response.statusCode == 200) {
      part.deleteSync();
      have = 0;
    }

    final total = have + (response.contentLength ?? 0);
    if (total <= 0) {
      throw ModelDownloadException('服务器没给文件长度，无法判断是否下完');
    }

    final sink = part.openSync(
        mode: have > 0 ? FileMode.append : FileMode.write);
    var received = have;
    try {
      await for (final chunk in response.stream) {
        sink.writeFromSync(chunk);
        received += chunk.length;
        onProgress(received, total);
      }
    } finally {
      sink.closeSync();
    }

    if (received < total) {
      // Connection dropped mid-stream. Leave the .part file; the next call
      // resumes from it. Reported as incomplete, not as an error, because it is
      // the expected outcome of a phone doing something else.
      return false;
    }

    // Rename only now, when the length matches. A rename on a short file would
    // produce a model that loads and then crashes deep inside llama.cpp, which
    // is the least diagnosable failure available.
    if (target.existsSync()) target.deleteSync();
    part.renameSync(target.path);
    onProgress(received, total);
    // 登记放在改名之后：写一半的登记比没有登记更糟（它会说「已安装」而文件不在）。
    // bytes 记**实测**长度而不是清单声明值：下一次判断拿它和磁盘上的实际大小比，
    // 记声明值等于把 1 MB 的估算误差带进每一次比较。
    if (asset != null) await _recordInstalled(asset, bytes: received);
    return true;
  }

  /// Delete the downloaded model, freeing ~2.8 GB.
  Future<void> deleteModel() async {
    final dir = await _resolveDir();
    _resolvedDirOrNull = dir;
    for (final asset in manifest) {
      final f = File('${dir.path}/${asset.name}');
      if (f.existsSync()) f.deleteSync();
      final p = File('${dir.path}/${asset.name}$_partSuffix');
      if (p.existsSync()) p.deleteSync();
    }
    // 登记一起删。留着它会让「删掉的模型」在版本判断里显示成已安装，用户要再点
    // 一次删除才发现什么都没发生。
    final record = File('${dir.path}/$_recordFile');
    if (record.existsSync()) record.deleteSync();
  }

  /// Cancel an in-flight download by deleting its partial file.
  ///
  /// The stream itself cannot be cancelled from here — [download] owns it — so
  /// this removes the bytes and the next write attempt fails, which surfaces as
  /// an incomplete return. Honest about the limitation rather than pretending to
  /// abort the socket.
  Future<void> cancelPartial(String filename) async {
    final dir = await _resolveDir();
    _resolvedDirOrNull = dir;
    final p = File('${dir.path}/$filename$_partSuffix');
    if (p.existsSync()) p.deleteSync();
  }
}

/// 一个可独立下载、可独立升级的能力资产。
///
/// 泛化成条目而不是两个硬编码文件名的理由：视觉模型对只是**当前**唯一可独立
/// 下载的能力。将来每多一种（更大的投影器、另一个量化档），要加的是清单里一行，
/// 而不是 store 里一套新的 existsSync 分支。
class CapabilityAsset {
  const CapabilityAsset({
    required this.name,
    required this.version,
    required this.sha256,
    required this.bytes,
    required this.url,
  });

  /// 磁盘上的文件名。
  final String name;

  /// 清单里的版本标识。不要求是 semver——它只需要在发布方换文件时变一下。
  final String version;

  /// 发布方公布的 sha256。空串表示「未登记」，此时判定退化为版本号 + 字节数，
  /// 且 UI 必须说明未经哈希校验（见 [LocalModelStore.manifest] 的说明）。
  final String sha256;

  /// 声明字节数。既是「将要下载多少」的预估，也是没有 sha 时的比对依据。
  final int bytes;

  /// 完整下载地址。镜像 / 官方源的选择在 [LocalModelStore.baseUrl] 一处完成。
  final String url;
}

/// 已安装登记的条目：哪一版、多大、什么时候装的。
class InstalledAsset {
  const InstalledAsset({
    required this.version,
    required this.sha256,
    required this.bytes,
    required this.installedAt,
  });

  factory InstalledAsset.fromJson(Map<String, dynamic> json) => InstalledAsset(
        version: (json['version'] ?? '').toString(),
        sha256: (json['sha256'] ?? '').toString(),
        bytes: json['bytes'] is int ? json['bytes'] as int : 0,
        installedAt: DateTime.tryParse((json['installedAt'] ?? '').toString()) ??
            DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      );

  final String version;
  final String sha256;
  final int bytes;
  final DateTime installedAt;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'version': version,
        'sha256': sha256,
        'bytes': bytes,
        'installedAt': installedAt.toIso8601String(),
      };
}

/// 对一个能力资产该做什么。三态，对应设置页三种按钮/文案。
enum AssetAction {
  /// 本地没有，要下载。
  download,

  /// 本地有一份，但不是清单这一版，要升级。
  upgrade,

  /// 本地就是清单这一版，什么都不做。
  skip,
}

/// 增量判断的纯函数。整个文件唯一需要单测的判定逻辑。
///
/// 顺序是刻意的：先看磁盘上有没有字节，再看登记。反过来会让一个 0 字节的残留
/// `.part`（或一个被删了一半的文件）走到 size 比较里，被当成「已安装」。
AssetAction decideAssetAction({
  required CapabilityAsset asset,
  required InstalledAsset? installed,
  required int bytesOnDisk,
}) {
  if (bytesOnDisk <= 0) return AssetAction.download;

  if (installed == null) {
    // 没有登记记录。这是本功能上线前的存量下载：文件在、大小对，就当它是这个
    // 版本——否则清单一上线，所有老用户都要重下 2.8 GB。登记在下次同步时补写。
    //
    // 用容差而不是相等，理由见 sizeToleranceFor。
    final nearDeclared = (bytesOnDisk - asset.bytes).abs() <=
        LocalModelStore.sizeToleranceFor(asset.bytes);
    return nearDeclared ? AssetAction.skip : AssetAction.download;
  }

  if (installed.sha256.isNotEmpty && asset.sha256.isNotEmpty) {
    return installed.sha256 == asset.sha256
        ? AssetAction.skip
        : AssetAction.upgrade;
  }

  // 清单没登记 sha 时（当前视觉模型对就是这种），退化成按版本号 + 字节数判断。
  // installed.bytes 记的是实测长度，所以这里可以精确相等。
  final sameVersion = installed.version == asset.version;
  return sameVersion && bytesOnDisk == installed.bytes
      ? AssetAction.skip
      : AssetAction.upgrade;
}

/// 一个能力资产的当前状态，供 UI 直接渲染。
class CapabilityStatus {
  const CapabilityStatus({
    required this.asset,
    required this.action,
    required this.bytesOnDisk,
  });

  final CapabilityAsset asset;
  final AssetAction action;

  /// 磁盘上现有的字节数。0 表示没有，[asset.bytes] 附近表示下完。
  final int bytesOnDisk;

  bool get needsFetch => action != AssetAction.skip;

  /// 一行中文状态，已含「动作 + 目标 + 进度」。
  String get label {
    switch (action) {
      case AssetAction.download:
        return bytesOnDisk > 0 ? '已下了一部分，未完成' : '未安装';
      case AssetAction.upgrade:
        return '有新版本 ${asset.version} 可升级';
      case AssetAction.skip:
        return '已是最新 ${asset.version}';
    }
  }
}

/// What is on disk right now, for the settings UI.
class LocalModelState {
  const LocalModelState({
    required this.dir,
    required this.modelBytes,
    required this.mmprojBytes,
    required this.complete,
  });

  final String dir;
  final int modelBytes;
  final int mmprojBytes;
  final bool complete;

  int get totalBytes => modelBytes + mmprojBytes;

  /// Absolute path for one of the two files, given its name.
  ///
  /// Exists so the settings UI can hand the native side a real path without
  /// knowing where the app's support directory is. The alternative — exposing
  /// the store's private directory — would let a caller build paths for files
  /// that are not part of the model pair.
  String modelPathFor(String filename) => '$dir/$filename';

  String get humanTotal {
    final mb = totalBytes / (1024 * 1024);
    return mb >= 1024 ? '${(mb / 1024).toStringAsFixed(1)} GB' : '${mb.toStringAsFixed(0)} MB';
  }
}

/// Thrown by [LocalModelStore.download] with a user-facing reason.
///
/// Deliberately NOT named IOException — `dart:io` already exports one and
/// shadowing it would make every `catch (e)` in the file ambiguous about which
/// type it caught.
class ModelDownloadException implements Exception {
  ModelDownloadException(this.message);
  final String message;
  @override
  String toString() => message;
}
