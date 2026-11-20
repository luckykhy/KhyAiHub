import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/project_profile.g.dart';

/// 项目画像生成物。
///
/// 这份测试守两件事：
///   1. 生成物真的带着红线——少一条，手机上的 AI 就有机会在不知情的情况下破线；
///   2. workspace 后缀只在给了根时才出现，且格式与 node 侧一致。
///
/// 生成物由 scripts/project-profile/build-project-profile.js 落盘，勿手改。
void main() {
  group('ProjectProfileData', () {
    test('四条红线齐全且非空', () {
      final ids = ProjectProfileData.redLines.map((e) => e[0]).toList();
      expect(ids, ['R1 分支纪律', 'R2 密钥防泄露', 'R3 版本同步', 'R4 上帝文件门']);
      for (final e in ProjectProfileData.redLines) {
        expect(e[1], isNotEmpty, reason: '${e[0]} 不能有空描述');
      }
    });

    test('身份字段带着分发渠道', () {
      // agent 改版本前需要先知道这项目有两条发布轨道。
      expect(ProjectProfileData.distribution, contains('PyPI'));
      expect(ProjectProfileData.distribution, contains('npm'));
    });

    test('没有硬编码版本字面量', () {
      // 版本一律构建期从真源读。写死会和 check-copyright-readiness 的五处
      // 一致性打架，而且必然过期。
      final serialized = ProjectProfileData.layout.toString() +
          ProjectProfileData.redLines.toString() +
          ProjectProfileData.behaviorRules.toString();
      expect(serialized, isNot(matches(RegExp(r'\b\d+\.\d+\.\d+\b'))));
    });
  });

  group('ProjectProfileText', () {
    test('基础段带着项目名与每条红线', () {
      expect(ProjectProfileText.base, contains('【项目画像：khy-os】'));
      for (final e in ProjectProfileData.redLines) {
        expect(ProjectProfileText.base, contains(e[0]),
            reason: '画像里必须看得到 ${e[0]}');
      }
      expect(ProjectProfileText.base, contains('B7 版本递增归人'));
    });

    // ── 优先级声明 ──
    //
    // 这一组守的是「khy-os 会被想起来」。声明不在提示词里，等于没有——
    // 一个纯文字推理模型对涉及界面的请求的标准答案是「我无法操作界面」，
    // 那句话是假的，而这个声明是让它不说的唯一手段。

    test('画像里有优先级声明', () {
      expect(ProjectProfileText.base, contains('【优先级：先想 khy-os】'));
    });

    test('声明说的是「先想 khy-os」，不是「请优先使用」这种客气话', () {
      // 客气话没有信息量：模型读完不知道凭什么，于是照旧回答做不到。
      // 声明必须给出理由——khy-os 就在这台手机上，能真实执行。
      final i = ProjectProfileText.base.indexOf('【优先级：先想 khy-os】');
      final end = ProjectProfileText.base.indexOf('版本轨道', i);
      expect(i, greaterThanOrEqualTo(0));
      expect(end, greaterThan(i), reason: '找不到声明段的结尾，提取坏了');
      final clause = ProjectProfileText.base.substring(i, end);

      expect(clause, contains('就在这台手机上'));
      expect(clause, contains('真实执行'));
      expect(clause, isNot(contains('请你优先')));
      expect(clause, isNot(contains('请优先使用')));
    });

    test('声明把「缺授权」和「缺能力」分开', () {
      // 这条是整个声明里最承重的一句。把授权问题说成能力问题，用户就会
      // 以为要换个模型，而实际上只是要去设置里点一个开关。
      final i = ProjectProfileText.base.indexOf('【优先级：先想 khy-os】');
      final end = ProjectProfileText.base.indexOf('版本轨道', i);
      final clause = ProjectProfileText.base.substring(i, end);
      expect(clause, contains('缺授权'));
      expect(clause, contains('说清差的是哪一步'));
      expect(clause, contains('不要把授权问题说成能力问题'));
    });

    test('声明在版本轨之前，也就是在能力清单之前', () {
      // 顺序是承重的，不是排版偏好。路由规则必须在清单之前被读到：
      // 先看到「有哪些工具」再看到「该先用谁」，读到后半句时前半句已经
      // 形成印象了。放到版本轨之后会让它变成一段结尾备注——而那正是最
      // 不会被记住的位置。
      final base = ProjectProfileText.base;
      final pri = base.indexOf('【优先级：先想 khy-os】');
      final tracks = base.indexOf('版本轨道');
      final identity = base.indexOf('【项目画像');
      expect(identity, greaterThanOrEqualTo(0));
      expect(pri, greaterThan(identity), reason: '声明必须在身份段之后');
      expect(pri, lessThan(tracks), reason: '声明必须在版本轨之前');
    });

    test('没有工作目录时不渲染那一行', () {
      // "当前工作目录：undefined" 会让模型以为有个叫 undefined 的目录。
      expect(ProjectProfileText.section(), isNot(contains('当前工作目录')));
      expect(ProjectProfileText.section(workspaceRoot: ''),
          isNot(contains('当前工作目录')));
      expect(ProjectProfileText.section(workspaceRoot: '   '),
          isNot(contains('当前工作目录')));
    });

    test('有工作目录时把那几行带上', () {
      final out = ProjectProfileText.section(workspaceRoot: '/sdcard/khy-os');
      expect(out, contains('当前工作目录：/sdcard/khy-os'));
      expect(out, contains('list_files / read_file / write_file'));
    });

    test('带根时是在基础段之后追加，不是替换', () {
      final out = ProjectProfileText.section(workspaceRoot: '/sdcard/khy-os');
      expect(out.startsWith(ProjectProfileData.redLines.isEmpty
          ? ProjectProfileText.base
          : ProjectProfileText.base), true);
      expect(out.length, greaterThan(ProjectProfileText.base.length));
    });
  });

  group('BuildInfo', () {
    test('版本轨道来自真源，非空且形如 semver', () {
      expect(BuildInfo.current.versionTracks, isNotEmpty);
      for (final t in BuildInfo.current.versionTracks) {
        expect(t.version, matches(RegExp(r'^\d+\.\d+\.\d+$')),
            reason: '${t.track} 应是 semver');
      }
    });

    test('构建时间非空', () {
      expect(BuildInfo.current.buildTime, isNotEmpty);
    });

    test('没有守卫快照时不假装有；有就必须带日期', () {
      // 关键不在有没有快照，而在有的话必须能说清是何时取的——一个没有日期的绿灯
      // 比不显示更糟，基线性守卫会随代码增长重新变红。
      final guards = BuildInfo.current.guards;
      if (guards == null) return;
      expect(guards.takenAt, isNotEmpty,
          reason: '守卫快照必须带 takenAt，否则界面无法说清结论何时取的');
      for (final g in guards.results) {
        expect(g.status, isIn(['pass', 'fail', 'skip']));
        expect(g.id, isNotEmpty);
      }
    });
  });
}
