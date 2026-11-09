// khy-canary: Khy-20261101-131-6PES8C69
import 'package:flutter/material.dart';

import '../../core/config/project_profile.g.dart';

/// 「项目」区块：这个 APK 是凭什么构建出来的。
///
/// 为什么值得占一屏：用户问"这个包是什么状态"时，答案必须可核对，而不是一句
/// 宣传语。所以每项都来自构建期真实取值——git commit、版本真源、守卫快照。
///
/// 守卫结论**一律带日期**。一个没有日期的绿灯比不显示更糟：它会让半年前的
/// 通过看起来像刚刚的通过，而 `check-repo-layout` 这类基线性守卫是会随代码
/// 增长重新变红的。
///
/// 做成共享 widget 而不是写进某个设置页：这屏上有两个设置界面
/// （settings_screen / settings_screen_new），早先只改了一个，结果真机上看到的
/// 是另一个——卡片等于没落地。共用一份就不会再出现"改了没生效"。
class ProjectInfoCard extends StatelessWidget {
  const ProjectInfoCard({super.key});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final info = BuildInfo.current;
    final tracks =
        info.versionTracks.map((t) => '${t.track}  ${t.version}').join('\n');

    String commitLine;
    if (info.commit.isEmpty) {
      commitLine = '仓库无提交（版本轨道为准）';
    } else {
      final date = info.commitDate.isEmpty ? '' : '  ${info.commitDate}';
      commitLine = '${info.commit}$date';
    }

    final guardLines = <String>[];
    if (info.guards == null) {
      guardLines.add('构建时未记录（跑过守卫后可重新生成画像）');
    } else {
      final taken = info.guards!.takenAt.isEmpty ? '时间未知' : info.guards!.takenAt;
      guardLines.add('快照时间：$taken');
      for (final g in info.guards!.results) {
        final mark = g.status == 'pass'
            ? '✓'
            : g.status == 'fail'
                ? '✗'
                : '–';
        guardLines.add('$mark ${g.id}${g.detail.isEmpty ? '' : '  ${g.detail}'}');
      }
    }

    Widget row(IconData icon, String title, String subtitle) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 18, color: cs.onSurfaceVariant),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: TextStyle(
                          fontSize: 12, color: cs.onSurfaceVariant)),
                  const SizedBox(height: 2),
                  // 可选中：这些串用户要复制去核对，不让全选太折磨。
                  SelectableText(subtitle,
                      style: TextStyle(fontSize: 13, color: cs.onSurface)),
                ],
              ),
            ),
          ],
        ),
      );
    }

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.account_tree_rounded, size: 18, color: cs.primary),
                const SizedBox(width: 8),
                Text('项目',
                    style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: cs.onSurface)),
              ],
            ),
            const SizedBox(height: 12),
            row(Icons.tag_rounded, '版本轨道',
                tracks.isEmpty ? '（构建时读不到版本真源）' : tracks),
            const Divider(height: 1),
            row(Icons.commit_rounded, '构建基线', commitLine),
            const Divider(height: 1),
            row(Icons.fact_check_rounded, '守卫结论', guardLines.join('\n')),
            const Divider(height: 1),
            row(
              Icons.schema_rounded,
              '项目结构',
              ProjectProfileData.layout.map((e) => '${e[0]}  ${e[1]}').join('\n'),
            ),
            const Divider(height: 1),
            row(
              Icons.gavel_rounded,
              '红线（AI 动手前须知道）',
              ProjectProfileData.redLines.map((e) => '${e[0]}  ${e[1]}').join('\n'),
            ),
          ],
        ),
      ),
    );
  }
}
