import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/skills/local_skill_store.dart';
import 'package:khy_os_client/core/tools/skills.dart';

void main() {
  group('SkillMatcher', () {
    test('exact name match gets highest score', () {
      final matches = SkillMatcher.matchAll('screenshot');
      expect(matches, isNotEmpty);
      expect(matches.first.skill.name, 'screenshot');
      expect(matches.first.score, greaterThan(0));
    });

    test('keyword in input matches', () {
      final matches = SkillMatcher.matchAll('take a screenshot please');
      final names = matches.map((m) => m.skill.name).toList();
      expect(names, contains('screenshot'));
    });

    test('no match below threshold returns empty', () {
      final matches = SkillMatcher.matchAll('xyzabc');
      expect(matches, isEmpty);
    });

    test('limit caps results', () {
      final matches = SkillMatcher.matchAll('open', limit: 2);
      expect(matches.length, lessThanOrEqualTo(2));
    });

    test('match returns single best or null', () {
      final best = SkillMatcher.match('screenshot');
      expect(best, isNotNull);
      expect(best!.name, 'screenshot');

      final none = SkillMatcher.match('xyzcompletelyrandom');
      expect(none, isNull);
    });
  });

  group('Skill structure', () {
    test('builtinSkills falls back to the 5 built-ins when the local directory is empty', () {
      registerLocalSkills(const <Skill>[]);
      expect(builtinSkills.length, 5);
      for (final s in builtinSkills) {
        expect(s.type, SkillType.prompt);
      }
    });

    test('local skills merge into the same table and never shadow a built-in', () {
      registerLocalSkills(<Skill>[
        const Skill(
          name: 'wechat-export',
          label: 'wechat-export',
          description: '导出微信聊天记录',
          type: SkillType.prompt,
          version: '1.2.0',
        ),
        // 与内置同名：以内置为准，磁盘上的副本不覆盖编译期实现。
        const Skill(
          name: 'screenshot',
          label: '本地截屏',
          description: '同名副本',
          type: SkillType.prompt,
        ),
      ]);
      expect(builtinSkills.length, 6);
      expect(builtinSkills.last.name, 'wechat-export');
      expect(builtinSkills.firstWhere((s) => s.name == 'screenshot').label, '截屏');
      // 重复扫描不堆叠：第二次注册同一条目仍是 6 个。
      registerLocalSkills(<Skill>[
        const Skill(
          name: 'wechat-export',
          label: 'wechat-export',
          description: '导出微信聊天记录',
          type: SkillType.prompt,
        ),
      ]);
      expect(builtinSkills.length, 6);
      registerLocalSkills(const <Skill>[]);
      expect(builtinSkills.length, 5);
    });

    test('registerLocalSkills de-duplicates locals among themselves', () {
      // 两个同名本地技能会让 execute_skill 的 enum 出现重复值，execute 的
      // firstWhere 又会静默取第一个——调用方看不出少了哪一个。
      registerLocalSkills(<Skill>[
        const Skill(name: 'twin', label: '第一个', description: 'a', type: SkillType.prompt),
        const Skill(name: 'twin', label: '第二个', description: 'b', type: SkillType.prompt),
      ]);
      expect(builtinSkills.where((s) => s.name == 'twin'), hasLength(1));
      expect(builtinSkills.firstWhere((s) => s.name == 'twin').label, '第一个');
      registerLocalSkills(const <Skill>[]);
      expect(builtinSkills.length, 5);
    });

    test('no delegation skills remain', () {
      final delegations = builtinSkills.where((s) => s.type == SkillType.delegation).toList();
      expect(delegations, isEmpty);
    });

    test('allPackages empty for prompt skills (no appPackage)', () {
      for (final s in builtinSkills) {
        expect(s.appPackage, isNull);
      }
    });

    test('allPackages includes alternates when set', () {
      final skill = Skill(
        name: 'test',
        label: 'Test',
        description: 'desc',
        appPackage: 'com.main',
        alternatePackages: ['com.alt1', 'com.alt2'],
      );
      expect(skill.allPackages, ['com.main', 'com.alt1', 'com.alt2']);
    });

    test('allPackages skips null appPackage', () {
      final skill = Skill(
        name: 'test',
        label: 'Test',
        description: 'desc',
        alternatePackages: ['com.alt'],
      );
      expect(skill.allPackages, ['com.alt']);
    });
  });

  group('SkillResult', () {
    test('isPrompt defaults to false', () {
      final r = SkillResult(true, 'done');
      expect(r.isPrompt, false);
    });

    test('prompt result has isPrompt true', () {
      final r = SkillResult(true, '[PROMPT_SKILL:x]', isPrompt: true);
      expect(r.isPrompt, true);
    });
  });

  group('本地技能目录装载', () {
    // 这些钉的是装载层的判定，不是 UI：读盘在 LocalSkillStore.load，这里测它
    // 前面的纯函数，都不需要原生 MethodChannel。
    test('空目录：没有技能，也没有跳过原因', () async {
      final scan = await parseLocalSkills(const <String>[], (_) async => null);
      expect(scan.skills, isEmpty);
      expect(scan.skipped, isEmpty);
      expect(scan.warnings, isEmpty);
      expect(scan.isEmpty, isTrue);
    });

    test('没有 SKILL.md 的目录被跳过并说明缺什么', () async {
      final scan = await parseLocalSkills(
        <String>['wechat-export'],
        (_) async => null,
      );
      expect(scan.skills, isEmpty);
      expect(scan.skipped, hasLength(1));
      expect(scan.skipped.single, contains('wechat-export'));
      expect(scan.skipped.single, contains('SKILL.md'));
    });

    test('坏 frontmatter（缺 name）被跳过，不注册一个模型寻址不了的技能', () async {
      final scan = await parseLocalSkills(
        <String>['broken'],
        (_) async =>
            LocalSkillFileRead(content: '---\nversion: 1.0.0\ndescription: 没有 name\n---\n正文'),
      );
      expect(scan.skills, isEmpty);
      expect(scan.skipped.single, contains('frontmatter'));
      expect(scan.skipped.single, contains('name'));
    });

    test('没有 frontmatter 块的 Markdown 报的是"不是技能定义"，不是缺 name', () async {
      final scan = await parseLocalSkills(
        <String>['notes'],
        (_) async => const LocalSkillFileRead(content: '# 只是篇笔记\n'),
      );
      expect(scan.skills, isEmpty);
      expect(scan.skipped.single, contains('frontmatter 块'));
      expect(scan.skipped.single, isNot(contains('没有 name')));
    });

    test('路径逃逸的技能名在变成目录名之前就被拒绝', () async {
      // reader 对每个名字都给出合法 SKILL.md：通过即说明逃逸校验发生在读文件之前。
      final scan = await parseLocalSkills(
        <String>['../escape', 'a/b', '..'],
        (_) async => const LocalSkillFileRead(content: '---\nname: x\n---\n正文'),
      );
      expect(scan.skills, isEmpty);
      expect(scan.skipped, hasLength(3));
      for (final reason in scan.skipped) {
        expect(reason, contains('跳出技能目录'));
      }
    });

    test('Windows 编辑器带的 UTF-8 BOM 不让 frontmatter 解析失败', () async {
      final scan = await parseLocalSkills(
        <String>['bom'],
        (_) async => const LocalSkillFileRead(content: '\uFEFF---\nname: bom-skill\n---\n正文'),
      );
      expect(scan.skills, hasLength(1));
      expect(scan.skills.single.name, 'bom-skill');
      expect(scan.skipped, isEmpty);
    });

    test('两个目录写同一个 name 时只留一个，并说明跳过了哪个', () async {
      final scan = await parseLocalSkills(
        <String>['alpha', 'beta'],
        (dir) async => LocalSkillFileRead(content: '---\nname: twin\nversion: 1.0\n---\n$dir'),
      );
      expect(scan.skills, hasLength(1));
      expect(scan.skills.single.name, 'twin');
      expect(scan.skipped, hasLength(1));
      expect(scan.skipped.single, contains('beta'));
      expect(scan.skipped.single, contains('重复'));
    });

    test('SKILL.md 超过读取上限时给出警告，技能仍然注册', () async {
      final scan = await parseLocalSkills(
        <String>['big'],
        (_) async => const LocalSkillFileRead(
          content: '---\nname: big\n---\n正文',
          truncated: true,
        ),
      );
      expect(scan.skills, hasLength(1));
      expect(scan.warnings, hasLength(1));
      expect(scan.warnings.single, contains('截断'));
    });

    test('列举超过 200 项上限的告警由 load 一侧带上，不当成扫完了', () async {
      // parseLocalSkills 只负责把 warnings 原样带出：上限是原生 listFiles 的属性。
      final scan = await parseLocalSkills(
        <String>['a'],
        (_) async => const LocalSkillFileRead(content: '---\nname: a\n---\n'),
        warnings: const <String>['技能目录超过单次列举上限 200 项'],
      );
      expect(scan.warnings.single, contains('200'));
      expect(scan.isEmpty, isFalse);
    });

    test('没有 frontmatter 的 Markdown 不是技能', () {
      expect(parseSkillFrontmatter('# 只是篇文档\n'), isNull);
      expect(parseSkillFrontmatter(''), isNull);
      expect(hasFrontmatterBlock('# 只是篇文档\n'), isFalse);
      expect(hasFrontmatterBlock('---\nname: x\n---\n'), isTrue);
    });

    test('正常 SKILL.md 解析最小子集，注册后匹配器看得见', () async {
      final scan = await parseLocalSkills(
        <String>['wechat-export'],
        (_) async => const LocalSkillFileRead(
          content:
              '---\nname: wechat-export\nversion: 1.2.0\ndescription: "导出微信聊天记录"\n---\n\n# 正文\n',
        ),
      );
      expect(scan.skills, hasLength(1));
      final skill = scan.skills.single;
      expect(skill.name, 'wechat-export');
      expect(skill.version, '1.2.0');
      // 引号要剥掉：带着引号的 description 会原样显示给用户。
      expect(skill.description, '导出微信聊天记录');
      expect(skill.type, SkillType.prompt);

      registerLocalSkills(scan.skills);
      expect(builtinSkills.map((s) => s.name), contains('wechat-export'));
      expect(SkillMatcher.matchAll('wechat-export'), isNotEmpty);
      registerLocalSkills(const <Skill>[]);
    });

    test('frontmatter 缺 description 时有可读的回落，不留空行', () async {
      final scan = await parseLocalSkills(
        <String>['bare'],
        (_) async => const LocalSkillFileRead(content: '---\nname: bare\n---\n正文'),
      );
      expect(scan.skills.single.description, contains('SKILL.md'));
      expect(scan.skills.single.description, isNotEmpty);
    });
  });
}
