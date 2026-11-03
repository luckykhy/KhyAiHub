import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

/// 思维链折叠块（assistant 消息专用）。
///
/// 默认收起，整条头部是唯一切换入口；[reasoning] 为空（或全空白）时整体不渲染
/// ——不是渲染成空壳。为什么不能做成必然出现的占位：远程模式的思维链来自后端
/// SSE 的 `thinking_content`，而它到不到取决于上游适配器是否流式、模型是否吐
/// reasoning；真机上「远程模式有思考链」与「只有部分渠道有」是并存的。
///
/// 视觉对齐桌面端
/// `apps/khyos-desktop/src/renderer/components/message/ThinkingBlock.tsx`：
/// 独立一块、底色与气泡不同、左侧一道主色描边、标题区分「正在思考 / 思考」两态。
/// 桌面端还有一个 enabled 开关（settings.showReasoning，缺省 true），本端暂无
/// 对应设置项，故不接——不传就是一律显示，与桌面端缺省值一致。
class ThinkingBlock extends StatefulWidget {
  const ThinkingBlock({
    super.key,
    required this.reasoning,
    this.streaming = false,
  });

  /// 思维链正文。空（或全空白）时本组件渲染成零尺寸。
  final String reasoning;

  /// true = 还在流式到达。只影响标题文案，不影响折叠行为：流式中用户同样
  /// 可能想展开看已经到的那部分。
  final bool streaming;

  @override
  State<ThinkingBlock> createState() => _ThinkingBlockState();
}

class _ThinkingBlockState extends State<ThinkingBlock> {
  /// 默认收起——「收取」态。思维链通常远长于正文，一展开就把答复挤出屏幕。
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final text = widget.reasoning.trim();
    if (text.isEmpty) return const SizedBox.shrink();

    final palette = AppPalette.of(context);
    final reduced = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    final dur = reduced ? Duration.zero : AppDuration.micro;

    final body = _expanded
        ? Padding(
            padding: const EdgeInsets.fromLTRB(AppSpacing.cardPadNarrow, 0,
                AppSpacing.cardPadNarrow, AppSpacing.inner),
            child: SelectableText(
              text,
              // 禁用 textFaint：它在 reasoningSurface 上只有 3.16:1 /
              // 2.16:1，过不了规范 §7.5 的正文 4.5:1。
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
          )
        : const SizedBox(width: double.infinity);

    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.dense),
      // 把内容裁回圆角：左侧那道主色描边自己是直角的（见下），不裁的话会在圆角外
      // 露出两个小尾巴。
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: palette.reasoningSurface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Container(
        // 左侧一道主色描边：本块「这是思考、不是消息」的标记。桌面端同款
        // （border-l-2 border-l-trajectory-reasoning），顺带把本块与同色的
        // 输入框 fill 分开——两者底色同档，只差这一道边。
        //
        // 为什么是这个写法而不是给外层 Container 一条非均匀 Border：Flutter 只允许
        // 「圆角 + 四边同色」，混色 BorderSide 一配 borderRadius 就直接在 paint 期
        // 抛断言。所以主色边放在一个自己没有 borderRadius 的内层 Container 上，
        // 由外层的 clipBehavior 负责把它裁圆。
        decoration: BoxDecoration(
          border: Border(
            left: BorderSide(color: palette.primary, width: AppStroke.focus),
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _header(palette, dur),
            // 展开收起是一次性 micro 过渡，不是常驻动画（规范：常驻动画只许
            // breathe 与三点 loader 两处）。收起态给零高度的占位，只动画高度，
            // 宽度始终撑满。
            //
            // 减弱动效时**不套** AnimatedSize，而不是把 duration 设成 0：
            // RenderAnimatedSize 在 duration 为 0 时会在 performLayout 里同步重启
            // 动画，撞 "A RenderObject must not re-dirty itself while still being
            // laid out"。想要「不动画」就得真的不要动画。
            reduced
                ? body
                : AnimatedSize(
                    duration: dur,
                    curve: AppCurves.standard,
                    alignment: Alignment.topCenter,
                    child: body,
                  ),
          ],
        ),
      ),
    );
  }

  /// 整条头部是唯一切换入口：不另设「展开」按钮，避免一个块两个开关。
  Widget _header(AppPalette palette, Duration dur) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => setState(() => _expanded = !_expanded),
      child: Padding(
        padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.cardPadNarrow, vertical: AppSpacing.inner),
        child: Row(
          children: [
            AnimatedRotation(
              turns: _expanded ? 0.5 : 0,
              duration: dur,
              curve: AppCurves.standard,
              child: Icon(Icons.chevron_right,
                  size: 16, color: palette.textSecondary),
            ),
            const SizedBox(width: AppSpacing.dense),
            Text(
              widget.streaming ? '正在思考' : '思考',
              style: AppText.body.copyWith(
                fontWeight: FontWeight.w600,
                color: palette.textPrimary,
              ),
            ),
            const Spacer(),
            Text(
              _expanded ? '收起' : '展开',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}
