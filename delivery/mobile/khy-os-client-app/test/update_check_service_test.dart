import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/update_check_service.dart';

/// 版本探测的纯函数与「四源归类」。
///
/// WHY THIS FILE EXISTS. 这个功能唯一真正的风险不是连不上网，而是**把「查不到」
/// 显示成「已是最新」**。后端 `latestVersionResolver` 为此立了红线：三个源全失败
/// 时判 `indeterminate`，调用方必须诚实降级。Dart 侧继承了这个字段，所以这里钉的
/// 正是那条红线在 Dart 这边没有被改写——
///
///   * `indeterminate: true` 永远不能推出 `upToDate`；
///   * 本机版本读不到（调试构建的 `kAppVersion == 'unknown'`）也不是「已是最新」；
///   * 一源被 env 关掉必须报 `disabled`，不能和「查了但没查到」混成一类。
///
/// 网络行为不在这个文件的范围内：那部分逻辑在后端，真机上要连的是真后端。
void main() {
  group('numericVersion', () {
    test('strips the v prefix and the prerelease suffix', () {
      // 后端 numericVersion 的正则就是 \d+(?:\.\d+)*，Dart 侧必须同义，否则
      // 同一个 tag 在两边会取出不同的数字核。
      expect(numericVersion('v1.2.3'), '1.2.3');
      expect(numericVersion('1.2.3-rc1'), '1.2.3');
      expect(numericVersion('1.2'), '1.2');
      expect(numericVersion('1'), '1');
    });

    test('returns null when there is no numeric core at all', () {
      expect(numericVersion('unknown'), isNull);
      expect(numericVersion(''), isNull);
      expect(numericVersion('dev'), isNull);
    });
  });

  group('isComparableVersion', () {
    test('the debug-build sentinel is not comparable', () {
      // kAppVersion 在没注入 FLUTTER_BUILD_NAME 时就是 'unknown'。把它当成
      // 一个版本去比，会得到「已是最新」——一个纯粹由构建方式决定的谎。
      expect(isComparableVersion('unknown'), isFalse);
      expect(isComparableVersion(''), isFalse);
      expect(isComparableVersion('1.1.17'), isTrue);
    });
  });

  group('compareVersions', () {
    test('compares segment by segment, missing segments count as zero', () {
      // 与后端 versionService.compareVersions 同义：缺段补 0。1.2 与 1.2.0 相等，
      // 报成不等会让「没有新版」在两边给出不同答案。
      expect(compareVersions('1.2.3', '1.2.3'), 0);
      expect(compareVersions('1.2', '1.2.0'), 0);
      expect(compareVersions('1.2.3', '1.2.4'), lessThan(0));
      expect(compareVersions('1.3.0', '1.2.9'), greaterThan(0));
      expect(compareVersions('2.0.0', '1.9.9'), greaterThan(0));
    });

    test('tolerates the v prefix and a prerelease suffix', () {
      expect(compareVersions('v1.1.17', '1.1.7'), greaterThan(0));
      expect(compareVersions('1.2.0-rc1', '1.2.0'), 0);
    });

    test('a non-numeric segment is zero, not NaN', () {
      // 后端 Number('abc') 得 NaN，整个比较会静默变 NaN。这里明确当 0，并且
      // 不抛——一个认不出的版本段不该让设置页打不开。
      expect(compareVersions('1.x.3', '1.0.3'), 0);
      expect(compareVersions('abc', '0.0.1'), lessThan(0));
    });
  });

  group('classifyUpdateResult — the three states', () {
    test('a higher published version is updateAvailable', () {
      expect(
        classifyUpdateResult(current: '1.1.7', latest: '1.2.0'),
        UpdateVerdict.updateAvailable,
      );
    });

    test('equal or higher local version is upToDate', () {
      // 手机端与平台是两条独立版本线（pubspec 1.1.x vs 后端 1.2.x），本机高于
      // 发布版本是正常状态，不是异常。
      expect(
        classifyUpdateResult(current: '1.1.17', latest: '1.1.7'),
        UpdateVerdict.upToDate,
      );
      expect(
        classifyUpdateResult(current: '1.1.7', latest: '1.1.7'),
        UpdateVerdict.upToDate,
      );
    });

    test('indeterminate is NEVER reported as upToDate', () {
      // 这是本文件存在的理由。latestVersionResolver 三个源全失败时置
      // indeterminate: true；把它和 upToDate 混同，就是本功能要防的那个事故。
      expect(
        classifyUpdateResult(current: '1.1.7', latest: '1.2.0', indeterminate: true),
        UpdateVerdict.indeterminate,
      );
      expect(
        classifyUpdateResult(current: '9.9.9', indeterminate: true),
        UpdateVerdict.indeterminate,
      );
    });

    test('a missing latest version is indeterminate, not upToDate', () {
      expect(
        classifyUpdateResult(current: '1.1.7'),
        UpdateVerdict.indeterminate,
      );
      expect(
        classifyUpdateResult(current: '1.1.7', latest: ''),
        UpdateVerdict.indeterminate,
      );
    });

    test('an unreadable local version is indeterminate, not upToDate', () {
      expect(
        classifyUpdateResult(current: 'unknown', latest: '1.2.0'),
        UpdateVerdict.indeterminate,
      );
    });
  });

  group('classifySourceOutcome — four outcomes for four sources', () {
    test('enabled with a version is available', () {
      expect(
        classifySourceOutcome(enabled: true, version: '1.1.7'),
        SourceOutcome.available,
      );
    });

    test('disabled is its own outcome, not "missing"', () {
      // 「我们不查」和「我们查了但没查到」对用户的下一步完全不同：前者要看部署
      // 配置，后者要点重试。合成一类，用户就不知道该做哪一件。
      expect(
        classifySourceOutcome(enabled: false, version: null),
        SourceOutcome.disabled,
      );
      expect(
        classifySourceOutcome(enabled: false, version: '1.1.7'),
        SourceOutcome.disabled,
      );
    });

    test('enabled without a version is missing', () {
      expect(
        classifySourceOutcome(enabled: true, version: null),
        SourceOutcome.missing,
      );
      expect(
        classifySourceOutcome(enabled: true, version: ''),
        SourceOutcome.missing,
      );
    });

    test('the local snapshot source is not a version source', () {
      // 本地快照源既不报版本也不报失败——把它算进「有版本」会让取胜源变成它。
      expect(
        UpdateCheckResult.fromJson(<String, dynamic>{}).sources.last.outcome,
        SourceOutcome.notAVersionSource,
      );
    });
  });

  group('UpdateSourceReading.readout', () {
    UpdateSourceReading reading({
      required SourceOutcome outcome,
      String label = 'PyPI',
      bool enabled = true,
      String? version,
      String? error,
    }) =>
        UpdateSourceReading(
          channel: 'pypi',
          label: label,
          enabled: enabled,
          outcome: outcome,
          version: version,
          error: error,
        );

    test('a version reads as label + v + version', () {
      expect(
        reading(outcome: SourceOutcome.available, version: '1.1.7').readout,
        'PyPI v1.1.7',
      );
    });

    test('a disabled source says so, and does not invent a version', () {
      expect(
        reading(outcome: SourceOutcome.disabled, enabled: false).readout,
        'PyPI 渠道已禁用',
      );
    });

    test('a missing source carries its own reason', () {
      // 后端给每个源都带了 error（超时 / 未配置 / 元数据缺 version）。原样呈现，
      // 用户才知道该去配 KHY_UPDATE_GITHUB_REPOSITORY 还是该重试。
      expect(
        reading(outcome: SourceOutcome.missing, error: '请求超时').readout,
        'PyPI 请求超时',
      );
      expect(
        reading(outcome: SourceOutcome.missing).readout,
        'PyPI 未取到版本',
      );
    });

    test('the local source never claims a version', () {
      expect(
        reading(
          outcome: SourceOutcome.notAVersionSource,
          label: '本地快照',
        ).readout,
        '本地快照 不参与版本比较',
      );
      expect(
        reading(
          outcome: SourceOutcome.notAVersionSource,
          label: '本地快照',
          enabled: false,
        ).readout,
        '本地快照 渠道已禁用',
      );
    });
  });

  group('UpdateCheckResult.fromJson — the real backend payload', () {
    Map<String, dynamic> payload({
      Object? latest,
      Object? sourceLabel,
      bool indeterminate = false,
      List<Map<String, dynamic>> sources = const [],
      Object? localSourceEnabled = true,
      Object? releasePage,
      Object? backendRunningVersion,
      Object? platformUpdateState,
    }) =>
        <String, dynamic>{
          'releaseChannel': 'stable',
          'current': '1.1.17',
          if (latest != null) 'latest': latest,
          if (sourceLabel != null) 'sourceLabel': sourceLabel,
          'indeterminate': indeterminate,
          'sources': sources,
          'localSourceEnabled': localSourceEnabled,
          if (releasePage != null) 'releasePage': releasePage,
          if (backendRunningVersion != null)
            'backendRunningVersion': backendRunningVersion,
          if (platformUpdateState != null)
            'platformUpdate': <String, dynamic>{'state': platformUpdateState},
        };

    test('the happy path classifies every source and names the winner', () {
      // 形状对齐 runtime/node/backend/src/routes/mobileUpdate.js 的真实返回
      // （2026-11-04 实测：GitHub 未配置、PyPI/npm 各报一个版本）。
      final result = UpdateCheckResult.fromJson(
        payload(
          latest: '1.1.7',
          sourceLabel: 'PyPI',
          releasePage: 'https://github.com/luckykhy/khy_os/releases',
          backendRunningVersion: '1.2.1',
          platformUpdateState: 'idle',
          sources: <Map<String, dynamic>>[
            <String, dynamic>{
              'channel': 'github',
              'label': 'GitHub',
              'enabled': true,
              'version': null,
              'raw': null,
              'error': '未配置更新源：设 KHY_UPDATE_GITHUB_REPOSITORY',
            },
            <String, dynamic>{
              'channel': 'pypi',
              'label': 'PyPI',
              'enabled': true,
              'version': '1.1.7',
              'error': null,
            },
            <String, dynamic>{
              'channel': 'npm',
              'label': 'npm',
              'enabled': true,
              'version': '1.1.7',
              'error': null,
            },
          ],
        ),
        current: '1.1.17',
      );

      expect(result.verdict, UpdateVerdict.upToDate);
      expect(result.latest, '1.1.7');
      expect(result.sourceLabel, 'PyPI');
      expect(result.releasePage, isNotNull);
      expect(result.backendRunningVersion, '1.2.1');
      expect(result.platformUpdateState, 'idle');
      // 四个源一个不少，顺序固定。
      expect(result.sources.map((s) => s.channel).toList(),
          ['github', 'pypi', 'npm', 'local']);
      expect(result.sources[0].outcome, SourceOutcome.missing);
      expect(result.sources[1].outcome, SourceOutcome.available);
      expect(result.sources[3].outcome, SourceOutcome.notAVersionSource);
      expect(result.indeterminateReason, isEmpty);
      expect(result.sourceReadout,
          contains('PyPI v1.1.7 · npm v1.1.7 · 本地快照 不参与版本比较'));
    });

    test('all sources failed → indeterminate, and the reason says so', () {
      final result = UpdateCheckResult.fromJson(
        payload(
          indeterminate: true,
          sources: <Map<String, dynamic>>[
            <String, dynamic>{
              'channel': 'github',
              'label': 'GitHub',
              'enabled': true,
              'version': null,
              'error': '请求超时',
            },
            <String, dynamic>{
              'channel': 'pypi',
              'label': 'PyPI',
              'enabled': true,
              'version': null,
              'error': '网络错误',
            },
            <String, dynamic>{
              'channel': 'npm',
              'label': 'npm',
              'enabled': false,
              'version': null,
              'error': null,
            },
          ],
        ),
        current: '1.1.7',
      );

      expect(result.verdict, UpdateVerdict.indeterminate);
      expect(result.latest, isNull);
      // 「这不是『已是最新』」必须出现在给用户看的那句话里——这句是这个功能
      // 区别于「永远显示已是最新」的全部所在。
      expect(result.indeterminateReason, contains('这不是「已是最新」'));
      expect(result.indeterminateReason, contains('请求超时'));
      // 被关掉的源要说「已禁用」，不能说成超时。
      expect(result.sourceReadout, contains('npm 渠道已禁用'));
    });

    test('a disabled local snapshot source is reported as disabled', () {
      final result = UpdateCheckResult.fromJson(
        payload(latest: '1.1.7', localSourceEnabled: false),
        current: '1.1.7',
      );
      final local = result.sources.last;
      expect(local.channel, 'local');
      expect(local.enabled, isFalse);
      expect(local.outcome, SourceOutcome.notAVersionSource);
      expect(local.readout, '本地快照 渠道已禁用');
    });

    test('a malformed payload degrades to indeterminate, never throws', () {
      // 调用方是 UI。形状不匹配时显示「查不到 + 原因」，比把整个设置页打穿好。
      final result = UpdateCheckResult.fromJson(
        <String, dynamic>{'sources': 'not-a-list'},
        current: '1.1.7',
      );
      expect(result.verdict, UpdateVerdict.indeterminate);
      expect(result.sources, hasLength(1));
      expect(result.sources.single.channel, 'local');
      // 判定是「查不到」，原因就不能是空的——一句没有原因的「查不到」和
      // 「已是最新」一样没有信息量。
      expect(result.indeterminateReason, contains('这不是「已是最新」'));
    });

    test('an unreadable local version names the build, not the network', () {
      final result = UpdateCheckResult.fromJson(
        payload(latest: '1.2.0'),
        current: 'unknown',
      );
      expect(result.verdict, UpdateVerdict.indeterminate);
      expect(result.indeterminateReason, contains('FLUTTER_BUILD_NAME'));
      expect(result.indeterminateReason, contains('无法与发布版本比较'));
    });

    test('no release page is null, so the UI can say so honestly', () {
      final result = UpdateCheckResult.fromJson(
        payload(latest: '1.1.7'),
        current: '1.1.7',
      );
      expect(result.releasePage, isNull);
    });

    test('the release channel defaults to stable when the backend omits it', () {
      // 空串会让 UI 无法区分「后端没报轨道」和「轨道是 stable」，而这两件事对
      // preview 提示的显隐是相反的——少一句提示就是让用户以为预览版在生效。
      final result = UpdateCheckResult.fromJson(
        payload(latest: '1.1.7'),
        current: '1.1.7',
      );
      expect(result.releaseChannel, 'stable');
    });

    test('a preview track is carried through verbatim', () {
      final result = UpdateCheckResult.fromJson(
        <String, dynamic>{
          'releaseChannel': 'preview',
          'latest': '1.1.7',
          'sources': const <Map<String, dynamic>>[],
        },
        current: '1.1.7',
      );
      expect(result.releaseChannel, 'preview');
    });
  });
}
