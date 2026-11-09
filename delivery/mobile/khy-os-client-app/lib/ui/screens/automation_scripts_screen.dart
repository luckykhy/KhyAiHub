// 自动化脚本页：列出录制的脚本、跑它、看它每一步的结果。
//
// 「脚本能跑」和「脚本能改」是一回事的两面：这一页两者都给——运行按钮跑它，
// 编辑按钮把它当 JSON 打开让用户自己改。用户能看懂脚本，才敢让它动自己的文件。
//
// 目录事件触发器目前只登记不执行（真要监听目录变更需要原生 FileObserver），
// 所以这一页里只有「手动执行」是真能按的；其它触发方式照实标出。

import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/vfs/automation_runner.dart';
import '../../core/vfs/automation_scheduler.dart';
import '../../core/vfs/automation_script.dart';
import '../../core/vfs/vfs_context.dart';
import '../../core/vfs/vfs_watcher.dart';
import '../widgets/vfs/vfs_ai_script_sheet.dart';
import '../theme/design_tokens.dart';

/// 自动化脚本页。
class AutomationScriptsScreen extends StatefulWidget {
  const AutomationScriptsScreen({super.key});

  @override
  State<AutomationScriptsScreen> createState() => _AutomationScriptsScreenState();
}

class _AutomationScriptsScreenState extends State<AutomationScriptsScreen> {
  List<AutomationScript> _scripts = const <AutomationScript>[];
  List<VfsWatch> _watches = const <VfsWatch>[];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final scripts = await AutomationScriptStore.load();
    final watches = await VfsWatcherService.instance.list();
    if (!mounted) return;
    setState(() {
      _scripts = scripts;
      _watches = watches;
      _loading = false;
    });
  }

  /// 这个脚本绑定的目录当前是否在监听。
  bool _isWatching(AutomationScript script) =>
      _watches.any((VfsWatch watch) => watch.scriptId == script.id);

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('自动化脚本'),
        actions: <Widget>[
          IconButton(
            onPressed: _openAiGenerator,
            icon: const Icon(Icons.auto_awesome),
            tooltip: 'AI 生成脚本',
          ),
          IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: _loading
          ? Center(
              child: SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: palette.primary,
                ),
              ),
            )
          : _scripts.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(AppSpacing.page),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Icon(Icons.bolt_outlined,
                            size: 32, color: palette.textFaint),
                        const SizedBox(height: AppSpacing.cardGap),
                        Text(
                          '还没有脚本',
                          style:
                              AppText.body.copyWith(color: palette.textSecondary),
                        ),
                        const SizedBox(height: AppSpacing.dense),
                        Text(
                          '在文件管理器里点录制按钮，做一串文件操作，'
                          '然后把它们保存成脚本。',
                          textAlign: TextAlign.center,
                          style:
                              AppText.micro.copyWith(color: palette.textFaint),
                        ),
                      ],
                    ),
                  ),
                )
              : ListView.builder(
                  itemCount: _scripts.length,
                  itemBuilder: (BuildContext context, int index) {
                    final script = _scripts[index];
                    return ListTile(
                      leading: Icon(Icons.bolt_outlined,
                          size: 20, color: palette.primary),
                      title: Text(
                        script.name,
                        style:
                            AppText.body.copyWith(color: palette.textPrimary),
                      ),
                      subtitle: Text(
                        '${script.trigger.label} · ${script.steps.length} 步'
                        '${script.watchDir.isEmpty ? '' : '\n${script.watchDir}'}',
                        style: AppText.micro.copyWith(color: palette.textFaint),
                      ),
                      isThreeLine: script.watchDir.isNotEmpty,
                      trailing: script.trigger == AutomationTrigger.directoryEvent
                          ? Row(
                              mainAxisSize: MainAxisSize.min,
                              children: <Widget>[
                                Icon(
                                  _isWatching(script)
                                      ? Icons.visibility
                                      : Icons.visibility_off_outlined,
                                  size: 18,
                                  color: _isWatching(script)
                                      ? palette.success
                                      : palette.textFaint,
                                ),
                                PopupMenuButton<String>(
                                  onSelected: (String action) =>
                                      _onAction(script, action),
                                  itemBuilder: (BuildContext context) =>
                                      <PopupMenuEntry<String>>[
                                    const PopupMenuItem<String>(
                                      value: 'run',
                                      child: Text('执行'),
                                    ),
                                    const PopupMenuItem<String>(
                                      value: 'step',
                                      child: Text('逐步执行'),
                                    ),
                                    if (script.trigger ==
                                        AutomationTrigger.schedule)
                                      PopupMenuItem<String>(
                                        value: 'schedule',
                                        child: Text(
                                          script.enabled ? '停用定时' : '启用定时',
                                        ),
                                      ),
                                    if (script.trigger ==
                                        AutomationTrigger.directoryEvent)
                                      PopupMenuItem<String>(
                                        value: 'watch',
                                        child: Text(
                                          _isWatching(script) ? '停止监听' : '开始监听',
                                        ),
                                      ),
                                    const PopupMenuItem<String>(
                                      value: 'view',
                                      child: Text('查看/编辑'),
                                    ),
                                    const PopupMenuDivider(),
                                    const PopupMenuItem<String>(
                                      value: 'delete',
                                      child: Text('删除'),
                                    ),
                                  ],
                                ),
                              ],
                            )
                          : PopupMenuButton<String>(
                              onSelected: (String action) =>
                                  _onAction(script, action),
                              itemBuilder: (BuildContext context) =>
                                  <PopupMenuEntry<String>>[
                                const PopupMenuItem<String>(
                                  value: 'run',
                                  child: Text('执行'),
                                ),
                                const PopupMenuItem<String>(
                                  value: 'step',
                                  child: Text('逐步执行'),
                                ),
                                if (script.trigger ==
                                    AutomationTrigger.schedule)
                                  PopupMenuItem<String>(
                                    value: 'schedule',
                                    child: Text(
                                      script.enabled ? '停用定时' : '启用定时',
                                    ),
                                  ),
                                const PopupMenuItem<String>(
                                  value: 'view',
                                  child: Text('查看/编辑'),
                                ),
                                const PopupMenuDivider(),
                                const PopupMenuItem<String>(
                                  value: 'delete',
                                  child: Text('删除'),
                                ),
                              ],
                            ),
                    );
                  },
                ),
    );
  }

  Future<void> _onAction(AutomationScript script, String action) async {
    switch (action) {
      case 'run':
        await _run(script);
      case 'step':
        await _runStepByStep(script);
      case 'watch':
        await _toggleWatch(script);
      case 'schedule':
        await _toggleSchedule(script);
      case 'view':
        await _view(script);
      case 'delete':
        await _delete(script);
    }
  }

  /// 逐步执行：一次只跑一步，跑完看结果再决定要不要继续。
  ///
  /// 脚本是「一串不可逆的操作」，一次全跑出了问题没法停在中间。
  /// 能单步跑，就能看清是哪一步出的问题。
  Future<void> _runStepByStep(AutomationScript script) async {
    final runner = AutomationStepRunner(script);
    final palette = AppPalette.of(context);

    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => StatefulBuilder(
        builder: (BuildContext context, StateSetter setState) {
          final current = runner.current;
          return AlertDialog(
            title: const Text('逐步执行'),
            content: SizedBox(
              width: double.maxFinite,
              height: 300,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    '已完成 ${runner.doneCount} / ${runner.totalCount} 步',
                    style: AppText.cardTitle.copyWith(color: palette.textPrimary),
                  ),
                  const SizedBox(height: AppSpacing.cardGap),
                  Expanded(
                    child: current == null
                        ? Text(
                            '全部执行完毕',
                            style: AppText.body.copyWith(color: palette.success),
                          )
                        : ListView(
                            children: <Widget>[
                              for (var i = 0; i < script.steps.length; i++)
                                Padding(
                                  padding:
                                      const EdgeInsets.only(bottom: 4),
                                  child: Text(
                                    '${i < runner.doneCount ? '完成' : (i == runner.doneCount ? '待执行' : '未开始')}'
                                    ' · ${script.steps[i].description}',
                                    style: AppText.micro.copyWith(
                                      color: i < runner.doneCount
                                          ? palette.success
                                          : palette.textSecondary,
                                    ),
                                  ),
                                ),
                            ],
                          ),
                  ),
                ],
              ),
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(),
                child: const Text('关闭'),
              ),
              if (current != null)
                FilledButton(
                  onPressed: () async {
                    await runner.step();
                    setState(() {});
                  },
                  child: const Text('执行下一步'),
                ),
            ],
          );
        },
      ),
    );
    await _load();
  }

  /// 启用/停用定时执行。
  Future<void> _toggleSchedule(AutomationScript script) async {
    final next = script.copyWith(enabled: !script.enabled);
    final scripts = await AutomationScriptStore.load();
    final index = scripts.indexWhere((AutomationScript s) => s.id == script.id);
    if (index >= 0) scripts[index] = next;
    await AutomationScriptStore.saveAll(scripts);
    await AutomationScheduler.instance.tickNow();
    await _load();
    _toast(next.enabled ? '已启用定时执行' : '已停用定时执行');
  }

  /// AI 生成脚本。
  Future<void> _openAiGenerator() async {
    await VfsAiScriptSheet.show(
      context,
      vfsContext: const VfsContext(currentPath: '/'),
      onSaved: (AutomationScript script) {
        _toast('已保存脚本「${script.name}」');
        _load();
      },
    );
  }

  /// 开始/停止监听这个脚本绑定的目录。
  ///
  /// 监听是**进程内**的：App 被杀掉就没了。所以界面上说清楚这一点，
  /// 也让用户知道「停止监听」是能主动做的。
  Future<void> _toggleWatch(AutomationScript script) async {
    if (_isWatching(script)) {
      for (final watch in _watches) {
        if (watch.scriptId == script.id) {
          await VfsWatcherService.instance.stop(watch.watchId);
        }
      }
      await _load();
      _toast('已停止监听 ${script.watchDir}');
      return;
    }

    final bound = await VfsWatcherService.instance.bindScript(script);
    await _load();
    if (!bound.ok) {
      // 失败原因要说清楚：路径写错和「这个目录要 Shizuku 才能读」是两回事。
      _toast(bound.displayMessage);
      return;
    }
    _toast('已开始监听 ${script.watchDir}（App 运行期间有效）');
  }

  Future<void> _run(AutomationScript script) async {
    if (script.trigger != AutomationTrigger.manual) {
      // 定时与目录事件触发器还没有执行器——按之前不做，先说清楚。
      _toast('「${script.trigger.label}」触发器尚未接上执行器，'
          '请在文件管理器里手动执行这些步骤');
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('执行脚本'),
        content: Text(
          '即将执行「${script.name}」的 ${script.steps.length} 个步骤：\n\n'
          '${script.steps.map((AutomationStep s) => '· ${s.description}').join('\n')}',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('执行'),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;

    final result = await AutomationRunner.run(script);
    if (!mounted) return;
    await _showResult(script, result);
  }

  Future<void> _showResult(
    AutomationScript script,
    AutomationRunResult result,
  ) async {
    final palette = AppPalette.of(context);
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text('执行结果'),
        content: SizedBox(
          width: double.maxFinite,
          height: 280,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  '成功 ${result.doneCount} 步'
                  '${result.failedCount > 0 ? '，失败 ${result.failedCount} 步' : ''}',
                  style:
                      AppText.cardTitle.copyWith(color: palette.textPrimary),
                ),
                const SizedBox(height: AppSpacing.cardGap),
                for (final step in result.steps)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Text(
                      '${step.ok ? '完成' : '失败'}：${step.op}'
                      '${step.message.isEmpty ? '' : '（${step.message}）'}',
                      style: AppText.micro.copyWith(
                        color: step.ok ? palette.success : palette.error,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  Future<void> _view(AutomationScript script) async {
    final controller = TextEditingController(
      text: const JsonEncoder.withIndent('  ').convert(script.toJson()),
    );
    final edited = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('查看/编辑'),
        content: SizedBox(
          width: double.maxFinite,
          height: 360,
          child: TextField(
            controller: controller,
            maxLines: null,
            expands: true,
            style: AppText.micro,
            decoration: const InputDecoration(
              border: InputBorder.none,
              contentPadding: EdgeInsets.zero,
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(controller.text),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    if (!mounted || edited == null) return;

    try {
      final decoded = jsonDecode(edited);
      if (decoded is! Map) {
        _toast('脚本格式不对：顶层必须是对象');
        return;
      }
      final updated = AutomationScript.fromJson(
        decoded.map((Object? key, Object? value) =>
            MapEntry<String, dynamic>(key.toString(), value)),
      );
      final scripts = await AutomationScriptStore.load();
      final index = scripts.indexWhere((AutomationScript s) => s.id == script.id);
      if (index >= 0) {
        scripts[index] = updated;
      } else {
        scripts.add(updated);
      }
      await AutomationScriptStore.saveAll(scripts);
      await _load();
      _toast('脚本已更新');
    } catch (error) {
      _toast('脚本格式不对：$error');
    }
  }

  Future<void> _delete(AutomationScript script) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('删除脚本'),
        content: Text('确定删除脚本「${script.name}」吗？'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;
    final scripts = await AutomationScriptStore.load()
      ..removeWhere((AutomationScript s) => s.id == script.id);
    await AutomationScriptStore.saveAll(scripts);
    await _load();
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }
}
