// khy-canary: Khy-20261101-060-DX80P494
/// 规划子智能体。
///
/// 职责：把一份**原始的**计划变成可执行的、工具名都真实存在的、顺序无环的
/// 步骤序列。它不产生计划内容——那是模型的事——它负责的是**不让一份编造的
/// 计划进入执行阶段**。
///
/// 为什么这个分工重要：模型写计划时会顺手编工具名（`read_file_contents`、
/// `list_all_apps` 这种名字并不存在）。以前这种计划会一路走到执行才失败，
/// 报一句 "Tool not found" ——用户看到的是"任务失败了"，真正的原因却是
/// "计划里有个幻觉出来的工具"。两者该分开报。
///
/// 于是这里的规矩是：**计划里的每个工具名必须在引擎里真实注册过**。
/// 这条检查放在执行前，且失败时报告说清是哪个名字不存在。
library;

import 'subagent_report.dart';

/// 计划里的一个步骤。
class PlanStep {
  /// 工具名。必须真实存在于引擎中。
  final String tool;

  final Map<String, dynamic> args;

  /// 为什么需要这一步。人审计划时看这个。
  final String rationale;

  /// 依赖的步骤下标（0 起）。空 = 无依赖，可立即执行。
  final List<int> dependsOn;

  const PlanStep({
    required this.tool,
    required this.rationale,
    this.args = const <String, dynamic>{},
    this.dependsOn = const <int>[],
  });

  Map<String, dynamic> toJson() => <String, dynamic>{
        'tool': tool,
        'args': args,
        'rationale': rationale,
        'dependsOn': dependsOn,
      };
}

/// 一份计划。
class Plan {
  /// 这份计划要达成什么。
  final String goal;

  final List<PlanStep> steps;

  /// 规划阶段发现的问题。空 = 可以直接执行。
  ///
  /// 非空时 [Plan.executable] 为 false——问题没修掉就不许执行，
  /// 而不是"先跑跑看"。
  final List<String> problems;

  const Plan({
    required this.goal,
    required this.steps,
    this.problems = const <String>[],
  });

  bool get executable => problems.isEmpty && steps.isNotEmpty;

  /// 拓扑排序后的执行顺序。有环时返回 null。
  ///
  /// 环是真实的坏计划：A 等 B、B 等 A，按原顺序执行会死等。
  /// 这里不试图"解环"（那要猜哪个依赖是多余的），直接判不可执行。
  List<PlanStep>? ordered() {
    final n = steps.length;
    final state = List<int>.filled(n, 0); // 0=未访问 1=访问中 2=完成
    final out = <PlanStep>[];

    int visit(int i) {
      if (state[i] == 2) return 0;
      if (state[i] == 1) return -1; // 回边 = 环
      state[i] = 1;
      for (final d in steps[i].dependsOn) {
        if (d < 0 || d >= n) continue; // 越界依赖已由 problems 报过
        if (visit(d) != 0) return -1;
      }
      state[i] = 2;
      out.add(steps[i]);
      return 0;
    }

    for (var i = 0; i < n; i++) {
      if (visit(i) != 0) return null;
    }
    return out;
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'goal': goal,
        'executable': executable,
        'steps': steps.map((s) => s.toJson()).toList(),
        'problems': problems,
      };
}

class PlannerAgent {
  /// 已知注册过的工具名。
  ///
  /// 传入而不是让规划器自己去问引擎：规划发生在执行前，
  /// 那时引擎就是执行时那个；但如果中途有人注册了新工具，
  /// 计划和执行看到的就该是同一份快照，不然又会漂移。
  final Set<String> knownTools;

  const PlannerAgent(this.knownTools);

  /// 一步都不许多排。计划越长，里面混进幻觉工具的概率越高，
  /// 而且长计划本来就该拆成多次。
  static const int maxSteps = 12;

  /// 从原始 JSON 构造计划。
  ///
  /// 期望形态：
  /// ```json
  /// {"goal": "...", "steps": [{"tool": "...", "args": {},
  ///                           "rationale": "...", "dependsOn": []}]}
  /// ```
  ///
  /// 形态不对时不抛：形态不对说明上游（模型）没按约定给，
  /// 那是要告诉用户"计划读不出来"的情况，不是让 App 崩。
  Plan planFromJson(Object? raw) {
    if (raw is! Map) {
      return Plan(
        goal: '',
        steps: const <PlanStep>[],
        problems: const <String>['计划不是 JSON 对象，无法解析'],
      );
    }
    final goal = raw['goal'];
    final stepsRaw = raw['steps'];
    if (goal is! String || goal.trim().isEmpty) {
      return Plan(
        goal: '',
        steps: const <PlanStep>[],
        problems: const <String>['计划缺少 goal 字段'],
      );
    }
    if (stepsRaw is! List || stepsRaw.isEmpty) {
      return Plan(
        goal: goal,
        steps: const <PlanStep>[],
        problems: const <String>['计划没有步骤'],
      );
    }
    if (stepsRaw.length > maxSteps) {
      return Plan(
        goal: goal,
        steps: const <PlanStep>[],
        problems: <String>[
          '计划有 ${stepsRaw.length} 步，超过上限 $maxSteps；请拆成多次'
        ],
      );
    }

    final steps = <PlanStep>[];
    final problems = <String>[];
    // 原始下标 → 保留步骤的下标。因为上面会跳过无效步骤，
    // 不重映射的话"依赖第 2 步"可能指向另一个工具——那比报错更坏，
    // 因为它会安安静静地按错的顺序执行。
    final keptIndex = <int, int>{};
    // 第一遍只收集，先不建 PlanStep：依赖下标要等所有 keptIndex 齐了才能映射。
    // 一遍里做不了这件事——一步完全可以依赖**后面**的步骤（"先读文件，
    // 再根据内容决定打开哪个应用"写反了顺序是很常见的事），
    // 那时 keptIndex 还没填，前向依赖会被误判成"依赖了一个无效步骤"，
    // 于是好好的依赖被静默丢掉。这是被 planner_agent_test 抓出来的。
    final collected = <_RawStep>[];

    for (var i = 0; i < stepsRaw.length; i++) {
      final s = stepsRaw[i];
      if (s is! Map) {
        problems.add('第 $i 步不是对象');
        continue;
      }
      final tool = s['tool'];
      if (tool is! String || tool.trim().isEmpty) {
        problems.add('第 $i 步缺少 tool 字段');
        continue;
      }
      // **核心检查**：工具名必须真实存在。
      //
      // 报错要说清"这个名字没注册过"，而不是笼统的"计划无效"。
      // 前者指向模型编了个名字，后者让人去翻代码。
      if (!knownTools.contains(tool)) {
        problems.add('第 $i 步的工具 "$tool" 未注册'
            '（可用：${knownTools.join(', ')}）');
        continue;
      }
      final rationale = s['rationale'];
      final argsRaw = s['args'];
      final depsRaw = s['dependsOn'];

      final args = <String, dynamic>{};
      if (argsRaw is Map) {
        args.addAll(argsRaw.map((k, v) => MapEntry('$k', v)));
      }

      // 这里只做"这个下标合不合法"的校验，映射留到第二遍。
      final deps = <int>[];
      if (depsRaw is List) {
        for (final d in depsRaw) {
          if (d is! int) continue;
          if (d == i) {
            problems.add('第 $i 步依赖自己');
            continue;
          }
          if (d < 0 || d >= stepsRaw.length) {
            problems.add('第 $i 步依赖了不存在的步骤 $d');
            continue;
          }
          deps.add(d);
        }
      }

      keptIndex[i] = collected.length;
      collected.add(_RawStep(
        tool: tool,
        rationale: rationale is String ? rationale : '',
        args: args,
        deps: deps,
      ));
    }

    // 第二遍：keptIndex 齐了，把原始下标映射成保留步骤的下标。
    for (var k = 0; k < collected.length; k++) {
      final c = collected[k];
      final mapped = <int>[];
      for (final d in c.deps) {
        final t = keptIndex[d];
        if (t == null) {
          // 依赖了一个自己被跳过的步骤（它自己有错）。箭头过去没有意义，
          // 但也不该静默丢掉：报出来，让人知道这条依赖没接上。
          problems.add('第 $k 步依赖的第 $d 步本身无效，该依赖未接上');
          continue;
        }
        mapped.add(t);
      }
      steps.add(PlanStep(
        tool: c.tool,
        rationale: c.rationale,
        args: c.args,
        dependsOn: mapped,
      ));
    }

    return Plan(goal: goal, steps: steps, problems: problems);
  }

  /// 生成一份可执行的 [SubAgentReport]。
  ///
  /// ok=false 只表示"这份计划不能执行"，不表示子智能体坏了。
  SubAgentReport review(Plan plan) {
    final ordered = plan.ordered();
    final problems = List<String>.from(plan.problems);
    if (ordered == null && plan.problems.isEmpty) {
      problems.add('步骤之间存在循环依赖，无法排定执行顺序');
    }
    if (plan.steps.isEmpty && problems.isEmpty) {
      problems.add('计划没有步骤');
    }

    return SubAgentReport(
      role: SubAgentRole.planner,
      ok: problems.isEmpty,
      observations: <Observation>[
        if (problems.isEmpty)
          Observation.verified(
            '计划可执行：${plan.steps.length} 步，工具名均已注册',
            <String, dynamic>{'success': true, 'steps': plan.steps.length},
          )
        else
          Observation.unverified(
            '计划不可执行',
            why: problems.join('；'),
          ),
      ],
      data: <String, dynamic>{
        'goal': plan.goal,
        'steps': plan.steps.map((s) => s.toJson()).toList(),
        'order': ordered?.map((s) => s.tool).toList(),
        'problems': problems,
      },
      error: problems.isEmpty ? null : problems.join('；'),
    );
  }
}

/// 第一遍收集到的中间形态。
///
/// 存在的唯一理由是依赖下标要等所有步骤都过完校验才能映射
/// （前向依赖），而 [PlanStep] 是不可变的、没有 copyWith。
class _RawStep {
  final String tool;
  final String rationale;
  final Map<String, dynamic> args;

  /// 原始下标，尚未映射。
  final List<int> deps;

  const _RawStep({
    required this.tool,
    required this.rationale,
    required this.args,
    required this.deps,
  });
}
