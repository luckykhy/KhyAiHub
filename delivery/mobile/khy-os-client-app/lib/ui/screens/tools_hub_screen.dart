// khy-canary: Khy-20261101-122-T09CZB5Y
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/tools/builtin_tools.dart';
import '../../core/tools/tool_engine.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import '../widgets/aurora.dart';
import 'plugin_market_screen.dart';

/// 工具与智能体总览。
///
/// 为什么单独一页而不是散在各处：khy-os 的能力分三层——本机工具、桥（uid 2000
/// 的 shell）、以及借来的智能体。三者入口不同、权限不同、可用性不同，混在
/// 「技能」网格里时，用户看到一个工具名却不知道它归谁管、要不要先做点什么。
///
/// 三张清单都从**活的对象**取，不手抄：
///   - 本机工具：来自 ToolEngine 注册表
///   - 桥工具：经 MethodChannel 问桥要 Tools.NAMES
///   - 智能体：写死四个，但每个都带真实的可用性状态
/// 手抄的清单会在加工具的那一刻开始说谎，而那种说谎很难发现——界面列出一个个
/// 桥上并没有的工具，用户点了才知道。
class ToolsHubScreen extends StatefulWidget {
  const ToolsHubScreen({super.key});

  @override
  State<ToolsHubScreen> createState() => _ToolsHubScreenState();
}

class _ToolsHubScreenState extends State<ToolsHubScreen> {
  static const _channel = MethodChannel('com.khyos.khy_os_client/device');

  late final ToolEngine _engine;
  List<String> _bridgeTools = const [];
  bool _bridgeSidecar = false;
  String _bridgeWhy = '';
  bool _loadingBridge = true;

  @override
  void initState() {
    super.initState();
    _engine = ToolEngine();
    _engine.registerAll(createBuiltinTools());
    _loadBridge();
  }

  Future<void> _loadBridge() async {
    try {
      final r = await _channel.invokeMethod('bridgeTools');
      if (r is Map && mounted) {
        final tools = r['tools'];
        setState(() {
          _bridgeTools = tools is List
              ? tools.map((e) => e.toString()).toList(growable: false)
              : const [];
          _bridgeSidecar = r['sidecar'] == true;
          _bridgeWhy = r['sidecar_why']?.toString() ?? '';
          _loadingBridge = false;
        });
        return;
      }
    } catch (_) {
      // 原生壳太旧：没有这个方法。下面按"取不到"显示，不猜内容。
    }
    if (mounted) {
      setState(() {
        _bridgeTools = const [];
        _loadingBridge = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return DefaultTabController(
      length: 4,
      child: Scaffold(
        body: SafeArea(
          child: Column(
            children: [
              _header(palette),
              TabBar(
                labelColor: palette.primary,
                unselectedLabelColor: palette.textSecondary,
                indicatorColor: palette.primary,
                tabs: const [
                  Tab(text: '本机工具'),
                  Tab(text: '桥'),
                  Tab(text: '插件市场'),
                  Tab(text: '智能体'),
                ],
              ),
              const Divider(height: 1),
              Expanded(
                child: TabBarView(
                  children: [
                    _localToolsTab(palette),
                    _bridgeTab(palette),
                    const PluginMarketScreen(),
                    _agentsTab(palette),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(AppPalette palette) {
    return Container(
      padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.page, vertical: AppSpacing.cardGap),
      decoration: BoxDecoration(
        color: palette.surface,
        boxShadow: [
          BoxShadow(
              color: Colors.black.withValues(alpha: 0.04),
              blurRadius: 4,
              offset: const Offset(0, 2)),
        ],
      ),
      child: Row(
        children: [
          const GradientTile(icon: Icons.handyman_outlined, size: 36),
          const SizedBox(width: AppSpacing.inner),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('工具与智能体',
                    style: AppText.cardTitle
                        .copyWith(color: palette.textPrimary)),
                Text(
                  '本机 ${_engine.allTools.length} 个 · '
                  '桥 ${_loadingBridge ? '…' : _bridgeTools.length} 个 · '
                  '智能体 ${_borrowedAgents.length + _subagents.length} 个',
                  style: AppText.label.copyWith(color: palette.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ---------------- 本机工具 ----------------

  Widget _localToolsTab(AppPalette palette) {
    final defs = _engine.allTools;
    final grouped = <String, List<ToolDef>>{};
    for (final d in defs) {
      grouped.putIfAbsent(_groupOf(d.name), () => <ToolDef>[]).add(d);
    }
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.page),
      children: [
        for (final entry in grouped.entries) ...[
          _sectionTitle(palette, entry.key),
          for (final d in entry.value) _toolRow(palette, d),
          const SizedBox(height: AppSpacing.section),
        ],
        _note(palette,
            '这些工具由 khy-os 自己在 App 进程内执行，不需要桥、不需要提权。'
            '涉及点按和截屏的仍要无障碍/录屏授权。'),
      ],
    );
  }

  // ---------------- 桥 ----------------

  Widget _bridgeTab(AppPalette palette) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.page),
      children: [
        _sectionTitle(palette, '提权状态'),
        Container(
          padding: const EdgeInsets.all(AppSpacing.cardPad),
          decoration: BoxDecoration(
            color: palette.surfaceHigh,
            borderRadius: BorderRadius.circular(AppRadius.medium),
            border: Border.all(
                color: _bridgeSidecar ? palette.success : palette.warning,
                width: AppStroke.thin),
          ),
          child: Row(
            children: [
              Icon(_bridgeSidecar ? Icons.verified_user : Icons.info_outline,
                  size: 16,
                  color: _bridgeSidecar ? palette.success : palette.warning),
              const SizedBox(width: AppSpacing.inner),
              Expanded(
                child: Text(
                  _bridgeSidecar
                      ? 'shell sidecar 在线（uid 2000），input/am/pm/screencap 可用'
                      : (_bridgeWhy.isEmpty
                          ? '未提权：重启手机或重跑 adb 提权命令后恢复'
                          : _bridgeWhy),
                  style: AppText.secondary
                      .copyWith(color: palette.textPrimary),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.section),
        _sectionTitle(palette, '桥提供的工具'),
        if (_loadingBridge)
          const Padding(
            padding: EdgeInsets.all(AppSpacing.cardPad),
            child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
          )
        else if (_bridgeTools.isEmpty)
          _note(palette, '取不到桥的工具清单（原生壳可能太旧）。')
        else
          Wrap(
            spacing: AppSpacing.dense,
            runSpacing: AppSpacing.dense,
            children: [
              for (final t in _bridgeTools) _chip(palette, t),
            ],
          ),
        const SizedBox(height: AppSpacing.section),
        _note(palette,
            '桥跑在 uid 2000（shell），比 App 自身权限高，但还不是 root。'
            '重启手机后提权会掉，需要重跑 PC 侧的提权命令。'),
      ],
    );
  }

  // ---------------- 智能体 ----------------

  Widget _agentsTab(AppPalette palette) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.page),
      children: [
        _sectionTitle(palette, '借来的智能体'),
        for (final a in _borrowedAgents) ...[
          _agentCard(palette, a),
          const SizedBox(height: AppSpacing.dense),
        ],
        const SizedBox(height: AppSpacing.section),
        _sectionTitle(palette, '内置子智能体'),
        for (final s in _subagents) ...[
          _subagentCard(palette, s),
          const SizedBox(height: AppSpacing.dense),
        ],
        const SizedBox(height: AppSpacing.section),
        _sectionTitle(palette, '怎么用'),
        _note(palette,
            '1. 设置页配好 API（ Agnes 是默认提供商，key 自备）。\n'
            '2. AI 页直接对话，用的是本机助手。\n'
            '3. 要动手机（点、滑、读写文件）就说出来，本机助手或 amoo 会把命令交给桥。\n'
            '4. 想直接问 amoo，用 AI 页顶部那张「问 amoo」卡片。\n'
            '5. 长时间盯着屏幕的操作，先开能力条上的「常亮」——熄一次屏，'
            '无障碍树就过期了，后面的操作全建立在旧状态上。'),
        const SizedBox(height: AppSpacing.section),
        _sectionTitle(palette, '内置子智能体怎么分工'),
        _note(palette,
            '读：只观察，不改状态。一次最多 8 个工具调用、64KB 证据，超了就停'
            '并在报告里说清停了——静默截断会被当成"看的是全量"。\n'
            '写：只写工作空间内（/sdcard/khy-os/workspace 或 tasks/<任务名>/）。'
            '路径规范化之后仍越界的一律拒；只写不删，删除只走临时目录的焚毁。\n'
            '查：核对声明与证据。没证据=无法验证，证据说失败=被推翻，两者不同。\n'
            '划：计划里每个工具名必须真实注册过。模型编出来的名字在**执行前**'
            '就会被挡住，而不是跑到一半才报 Tool not found。\n\n'
            '共同规矩：一条"已验证"的观察在类型上就必然带着证据 JSON。'
            '没有任何代码路径能造出不带证据的已验证——所以 amoo 说"完成了"'
            '不等于任务完成了，报告里会写明几条有证据、几条没有。'),
      ],
    );
  }

  // ---------------- 内置子智能体 ----------------

  Widget _subagentCard(AppPalette palette, _Subagent s) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPad),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: palette.primary.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(s.tag,
                style: AppText.label.copyWith(
                    color: palette.primary,
                    fontFamily: 'monospace',
                    fontSize: 11)),
          ),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.name,
                    style: AppText.body.copyWith(fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Text(s.note,
                    style: AppText.secondary.copyWith(
                        color: palette.textSecondary, height: 1.5)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ---------------- pieces ----------------

  Widget _sectionTitle(AppPalette palette, String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.dense),
      child: Text(text,
          style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
    );
  }

  Widget _toolRow(AppPalette palette, ToolDef d) {
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.dense),
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: palette.primary.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(d.name,
                style: AppText.label.copyWith(
                    color: palette.primary,
                    fontFamily: 'monospace',
                    fontSize: 11)),
          ),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Text(d.description,
                style: AppText.secondary.copyWith(color: palette.textSecondary)),
          ),
        ],
      ),
    );
  }

  Widget _chip(AppPalette palette, String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: palette.surfaceHigh,
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Text(text,
          style: AppText.label.copyWith(
              color: palette.textPrimary, fontFamily: 'monospace')),
    );
  }

  Widget _agentCard(AppPalette palette, _Agent a) {
    final color = switch (a.state) {
      _AgentState.ready => palette.success,
      _AgentState.needsSetup => palette.warning,
      _AgentState.needsKey => palette.warning,
      _AgentState.conditional => palette.textSecondary,
    };
    final label = switch (a.state) {
      _AgentState.ready => '可用',
      _AgentState.needsSetup => '需部署',
      _AgentState.needsKey => '需配 key',
      _AgentState.conditional => '看提权状态',
    };
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPad),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(a.icon, size: 20, color: palette.primary),
          const SizedBox(width: AppSpacing.inner),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(a.name,
                        style: AppText.body
                            .copyWith(fontWeight: FontWeight.w600)),
                    const SizedBox(width: AppSpacing.dense),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 6, vertical: 1),
                      decoration: BoxDecoration(
                        color: color.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(label,
                          style: AppText.label.copyWith(
                              color: color, fontSize: 10)),
                    ),
                  ],
                ),
                Text(a.role,
                  style: AppText.label.copyWith(color: palette.textSecondary)),
                const SizedBox(height: 4),
                Text(a.note,
                    style: AppText.secondary
                        .copyWith(color: palette.textSecondary, height: 1.5)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _note(AppPalette palette, String text) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.surfaceHigh.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(AppRadius.small),
      ),
      child: Text(text,
          style: AppText.secondary.copyWith(
              color: palette.textSecondary, height: 1.6)),
    );
  }

  /// 按工具名归组。写死而不是从 tags 取：tags 是给检索用的，语义不保证稳定，
  /// 而这里的分组是给用户看的，必须稳定。
  String _groupOf(String name) {
    if (name.startsWith('a11y') || name == 'capture_screen') return '屏幕与手势';
    if (name.contains('clipboard')) return '剪贴板';
    if (name.contains('shell') || name.contains('shizuku')) return '执行';
    if (name.contains('file') || name.contains('dir') || name == 'edit_file') {
      return '文件';
    }
    if (name == 'open_app' || name == 'open_url' || name == 'search_apps') {
      return '应用';
    }
    if (name.startsWith('web')) return '网络';
    if (name == 'analyze_screen' || name == 'execute_skill') return '技能';
    return '其他';
  }
}

class _Agent {
  final IconData icon;
  final String name;
  final String role;
  final _AgentState state;
  final String note;

  const _Agent({
    required this.icon,
    required this.name,
    required this.role,
    required this.state,
    required this.note,
  });
}

enum _AgentState { ready, needsSetup, needsKey, conditional }

/// 内置子智能体的静态描述。
///
/// 这四个**不**是写死的假清单：每一项对应 `core/agent/` 下一个真实类，
/// 括号里的数字是它们的真实上限（`ReaderAgent.maxSteps` /
/// `maxEvidenceBytes` / `PlannerAgent.maxSteps` / `WriterAgent.maxContentBytes`）。
/// 改代码时这里要跟着改——所以每条 note 都写清了依据，改的人有处可查。
/// 借来的智能体：不在本进程里跑，可用性取决于外部条件。
///
/// 提到顶层是为了让标题栏的计数和这一页用的是同一份——两处各写一份
/// "4 个"的话，加一个就会只说一边，而那正是这整页在防的事。
const List<_Agent> _borrowedAgents = <_Agent>[
  _Agent(
    icon: Icons.chat_bubble_outline,
    name: 'amoo',
    role: '手机内置助手',
    state: _AgentState.ready,
    note: '经桥反代。提问期间它必须留在前台（回复从它的气泡读），'
        '所以一次约 6 分钟不能切走。',
  ),
  _Agent(
    icon: Icons.smart_toy_outlined,
    name: 'gelab / STEP-GUI',
    role: '界面操作智能体',
    state: _AgentState.needsSetup,
    note: '模型不随包分发，需要时才拉取部署。未部署时只有动作文法可用，'
        '点按仍走桥。',
  ),
  _Agent(
    icon: Icons.psychology_outlined,
    name: '本机助手',
    role: 'AI 页的对话',
    state: _AgentState.needsKey,
    note: '走设置页里配的 API。配好后每次发送前会重新读一次配置。',
  ),
  _Agent(
    icon: Icons.terminal,
    name: '桥执行器',
    role: '不是智能体，是执行底座',
    state: _AgentState.conditional,
    note: 'uid 2000 的 shell。上面三个凡是真要落到手机上的动作，最后都过它。',
  ),
];

class _Subagent {
  final String tag;
  final String name;
  final String note;

  const _Subagent({
    required this.tag,
    required this.name,
    required this.note,
  });
}

const List<_Subagent> _subagents = <_Subagent>[
  _Subagent(
    tag: 'reader',
    name: '读取',
    note: '只观察不改状态。一次最多 8 个工具调用、64KB 证据；'
        '每步都带回原始 JSON，没有证据的观察在类型上造不出来。',
  ),
  _Subagent(
    tag: 'writer',
    name: '写入',
    note: '只写工作空间内，路径规范化后仍越界的一律拒。'
        '单次上限 256KB。只写不删；删除只走临时目录的用完即焚。',
  ),
  _Subagent(
    tag: 'checker',
    name: '检查',
    note: '核对声明与证据。没证据=无法验证，证据说失败=被推翻，'
        '两者在报告里分开显示。amoo 说"完成了"在这里过一遍才算数。',
  ),
  _Subagent(
    tag: 'planner',
    name: '规划',
    note: '一次最多 12 步。计划里每个工具名必须真实注册过，'
        '模型编出来的名字在执行前就被挡住并点名。',
  ),
];
