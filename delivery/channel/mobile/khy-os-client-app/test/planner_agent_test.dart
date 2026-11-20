import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/planner_agent.dart';

/// 规划子智能体的测试。
///
/// 重点是 `unknownToolIsRejected` 那一组：模型会在计划里编工具名，
/// 以前这种计划要走到执行阶段才报 "Tool not found"，用户看到的是
/// "任务失败"而不是"计划里有个幻觉工具"。现在它在执行前就被挡住，
/// 且报错说清是哪个名字没注册过。
void main() {
  const known = {'open_app', 'read_file', 'list_files', 'amoo_ask'};
  const planner = PlannerAgent(known);

  Map<String, dynamic> planJson(List<dynamic> steps,
          {String goal = '做点事'}) =>
      {'goal': goal, 'steps': steps};

  group('正常计划', () {
    test('工具名都存在 → executable', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'list_files', 'rationale': '先看有什么'},
        {'tool': 'read_file', 'rationale': '再读', 'dependsOn': [0]},
      ]));
      expect(p.problems, isEmpty);
      expect(p.executable, isTrue);
      expect(p.steps.length, 2);
    });

    test('拓扑排序按依赖展开', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'read_file', 'rationale': 'b', 'dependsOn': [1]},
        {'tool': 'list_files', 'rationale': 'a'},
      ]));
      final order = p.ordered();
      expect(order, isNotNull);
      expect(order!.map((s) => s.tool), ['list_files', 'read_file']);
    });

    test('无依赖的步骤保持原序', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'open_app', 'rationale': '1'},
        {'tool': 'list_files', 'rationale': '2'},
      ]));
      expect(p.ordered()!.map((s) => s.tool), ['open_app', 'list_files']);
    });

    test('args 原样带过去', () {
      final p = planner.planFromJson(planJson([
        {
          'tool': 'open_app',
          'args': {'query': '微信'},
          'rationale': '打开',
        },
      ]));
      expect(p.steps.single.args['query'], '微信');
    });

    test('review 返回可执行的报告', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'open_app', 'rationale': '打开'},
      ]));
      final r = planner.review(p);
      expect(r.ok, isTrue);
      expect(r.role.wire, 'planner');
      expect(r.observations.single.verified, isTrue);
      expect(r.data['order'], ['open_app']);
    });
  });

  group('幻觉工具名', () {
    test('未注册的工具名被拒，且报错说清是哪个', () {
      // 报错必须点名。笼统一句"计划无效"会让人去翻代码而不是改提示词。
      final p = planner.planFromJson(planJson([
        {'tool': 'read_all_files_everywhere', 'rationale': '瞎编的'},
      ]));
      expect(p.executable, isFalse);
      expect(p.problems.single, contains('read_all_files_everywhere'));
      expect(p.problems.single, contains('未注册'));
    });

    test('报错列出可用工具，便于模型自我纠正', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'nope', 'rationale': 'x'},
      ]));
      expect(p.problems.single, contains('open_app'));
    });

    test('有效步骤仍被保留，不因一步坏掉全丢', () {
      // 全丢的话，用户看到的还是"任务失败"。保留好的那几步，
      // 至少能告诉他"这两步是可以做的"。
      final p = planner.planFromJson(planJson([
        {'tool': 'open_app', 'rationale': '好的'},
        {'tool': 'nope', 'rationale': '坏的'},
        {'tool': 'list_files', 'rationale': '也好的'},
      ]));
      expect(p.steps.length, 2);
      expect(p.steps.map((s) => s.tool), ['open_app', 'list_files']);
      expect(p.problems.length, 1);
    });

    test('review 对坏计划返回 ok=false 且带原因', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'nope', 'rationale': 'x'},
      ]));
      final r = planner.review(p);
      expect(r.ok, isFalse);
      expect(r.error, isNotNull);
      expect(r.observations.single.verified, isFalse);
      expect(r.observations.single.why, contains('nope'));
    });
  });

  group('依赖', () {
    test('自依赖被拒', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'open_app', 'rationale': 'x', 'dependsOn': [0]},
      ]));
      expect(p.problems, contains('第 0 步依赖自己'));
    });

    test('越界依赖被拒', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'open_app', 'rationale': 'x', 'dependsOn': [7]},
      ]));
      expect(p.problems.single, contains('不存在的步骤 7'));
    });

    test('成环 → ordered() 为 null 且 review 报出来', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'open_app', 'rationale': 'a', 'dependsOn': [1]},
        {'tool': 'list_files', 'rationale': 'b', 'dependsOn': [0]},
      ]));
      expect(p.ordered(), isNull);
      final r = planner.review(p);
      expect(r.ok, isFalse);
      expect(r.error, contains('循环依赖'));
    });

    test('菱形依赖不是环', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'list_files', 'rationale': 'a'},
        {'tool': 'read_file', 'rationale': 'b', 'dependsOn': [0]},
        {'tool': 'open_app', 'rationale': 'c', 'dependsOn': [0]},
        {'tool': 'amoo_ask', 'rationale': 'd', 'dependsOn': [1, 2]},
      ]));
      expect(p.ordered(), isNotNull);
      expect(p.executable, isTrue);
    });

    test('跳过一步后，依赖下标被重映射', () {
      // 不重映射的话，"依赖第 2 步"会指向另一个工具——那比报错更坏，
      // 因为它会安安静静地按错的顺序执行。
      final p = planner.planFromJson(planJson([
        {'tool': 'list_files', 'rationale': 'a'},
        {'tool': 'nope', 'rationale': '坏的'},
        {'tool': 'read_file', 'rationale': 'c', 'dependsOn': [0]},
      ]));
      expect(p.steps.length, 2);
      // read_file 现在在下标 1，它的依赖应从 0 重映射到 0（list_files 没动）。
      expect(p.steps[1].dependsOn, [0]);
    });

    test('依赖一个被跳过的步骤 → 明确报出，不静默丢', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'nope', 'rationale': '坏的'},
        {'tool': 'read_file', 'rationale': 'c', 'dependsOn': [0]},
      ]));
      expect(p.steps.length, 1);
      expect(p.steps.single.dependsOn, isEmpty);
      expect(p.problems.any((s) => s.contains('该依赖未接上')), isTrue);
    });
  });

  group('形态异常', () {
    test('非对象 → 计划不可执行', () {
      final p = planner.planFromJson('我不是计划');
      expect(p.executable, isFalse);
      expect(p.problems.single, contains('不是 JSON 对象'));
    });

    test('缺 goal → 报出来', () {
      final p = planner.planFromJson({'steps': [
        {'tool': 'open_app', 'rationale': 'x'},
      ]});
      expect(p.problems.single, contains('goal'));
    });

    test('空 goal 字符串也算缺', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'open_app', 'rationale': 'x'},
      ], goal: '   '));
      expect(p.problems.single, contains('goal'));
    });

    test('没有步骤 → 报出来', () {
      final p = planner.planFromJson({'goal': 'g', 'steps': []});
      expect(p.problems.single, contains('没有步骤'));
    });

    test('steps 不是列表 → 报出来', () {
      final p = planner.planFromJson({'goal': 'g', 'steps': 'abc'});
      expect(p.problems.single, contains('没有步骤'));
    });

    test('某一步不是对象 → 记问题但继续', () {
      final p = planner.planFromJson(planJson([
        '我不是步骤',
        {'tool': 'open_app', 'rationale': 'x'},
      ]));
      expect(p.steps.length, 1);
      expect(p.problems.single, contains('第 0 步不是对象'));
    });

    test('缺 tool 字段 → 记问题', () {
      final p = planner.planFromJson(planJson([
        {'rationale': '没说用哪个工具'},
      ]));
      expect(p.problems.single, contains('缺少 tool'));
    });

    test('tool 不是字符串 → 记问题', () {
      final p = planner.planFromJson(planJson([
        {'tool': 42, 'rationale': 'x'},
      ]));
      expect(p.problems.single, contains('缺少 tool'));
    });

    test('args 不是 Map → 当空参数，不抛', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'open_app', 'args': 'abc', 'rationale': 'x'},
      ]));
      expect(p.executable, isTrue);
      expect(p.steps.single.args, isEmpty);
    });

    test('dependsOn 里的非 int 被忽略', () {
      final p = planner.planFromJson(planJson([
        {'tool': 'open_app', 'rationale': 'x', 'dependsOn': ['0', null]},
      ]));
      expect(p.executable, isTrue);
      expect(p.steps.single.dependsOn, isEmpty);
    });

    test('超步数上限 → 拒绝并要求拆分', () {
      final steps = List.generate(
        PlannerAgent.maxSteps + 1,
        (i) => {'tool': 'read_file', 'rationale': '$i'},
      );
      final p = planner.planFromJson(planJson(steps));
      expect(p.executable, isFalse);
      expect(p.problems.single, contains('上限'));
      expect(p.problems.single, contains('拆成多次'));
    });
  });

  group('已知工具集为空', () {
    test('所有计划都不可执行，但不抛', () {
      const empty = PlannerAgent(<String>{});
      final p = empty.planFromJson(planJson([
        {'tool': 'open_app', 'rationale': 'x'},
      ]));
      expect(p.executable, isFalse);
      expect(p.problems.single, contains('未注册'));
    });
  });
}
