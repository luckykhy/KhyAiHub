# khy-os 手机端视觉规范 ·「霓虹果冻」
> 施工顺序：先落 §2–§5 全局 token（重写 `app_colors.dart` / `app_theme.dart`）再动各屏。硬约束：不加 pubspec 依赖、不搬参考项目资源、不用网络图片与字体；本文数值为唯一标准，未覆盖处取最接近的既有值。
## 1 视觉主张
**深空玻璃底座上的霓虹果冻：深蓝紫暗底承载信息密度，高饱和「蓝→紫→品红」渐变只给 hero logo 与主操作钮两类元素，配 1px 发光描边、16–20dp 大圆角、120–300ms 轻弹性动效——可爱集中在焦点，正文保持冷静。**
## 2 色板（AppColors 常量，深/浅双值同表；下表重写全部颜色常量）
| 角色 | 深色 hex | 浅色 hex | 常量 AppColors.* | 用在哪 |
|---|---|---|---|---|
| 页面背景 | #0A0E1C | #F2F5FE | pageBg | Scaffold 背景 |
| 卡片表面 | #121A30 | #FFFFFF | surface | 卡片/气泡/对话框 |
| 表面高 | #1A2342 | #EBF0FC | surfaceHigh | 输入框/嵌套容器/快捷格 |
| 描边 | #263153 | #DFE6F8 | stroke | 1px 卡片描边 |
| 描边强 | #33406B | #C9D4F0 | strokeStrong | 按压描边/分段控件外框 |
| 主文字 | #EBF0FF | #171E38 | textPrimary | 标题/正文 |
| 次文字 | #96A2C5 | #5C6784 | textSecondary | 说明/副题/模型名 |
| 弱文字 | #5F6B8F | #9AA5C0 | textFaint | ≤11 号微注（时间戳/版本号） |
| 主色 | #4D7CFF | #3D6BFF | primary | 主操作/选中/运行态 |
| 辅色 | #8B5CF6 | #7C4DFF | accent | 渐变中段/次级强调 |
| 品红 | #E363F9 | #D946EF | hot | 渐变尾段/欢迎第四卡 |
| 青 | #67E8F9 | #0891B2 | cyan | 第四强调/特殊徽标 |
| 成功 | #3DDC97 | #0E9F6E | success | 已授权/成功态 |
| 警示 | #FFB74A | #DC6803 | warning | 未配置/必须项 |
| 错误 | #FF6B6B | #E5484D | error | 失败/危险操作 |

唯一渐变：`brandGradient=[primary,accent,hot]`、`brandGradient2=[primary,accent]`，均 topLeft→bottomRight；渐变只用于 hero logo、主操作钮、用户气泡三类元素，正文卡/列表/静态文字永不渐变。ColorScheme 接线：primary←primary、secondary←accent、tertiary←hot；旧 surfaceDark/surfaceVariantDark/outlineDark/outlineVariantDark/accentMid/tertiary 常量删除。第三方品牌色（微信绿 #07C160、B 站粉 #FB7299，`skills_screen_new.dart:248-273`）是识别信息，保留不动。现存 `app_colors.dart` 注释为 GBK 双重编码乱码，重写时以本表为准、注释用 UTF-8 按常量语义重写。
## 3 字号（AppText.* 常量，深浅共用，装配进 textTheme 对应 slot）
| 角色 | size | weight | 常量 / 落点 | 用在哪 |
|---|---|---|---|---|
| display | 28 | w800 | AppText.display → displaySmall | 启动页品牌名/欢迎页标题 |
| title | 20 | w700 | AppText.title → titleLarge | 各屏页头标题（现 15 号升级） |
| cardTitle | 15 | w600 | AppText.cardTitle → titleMedium | 卡片标题/对话框标题 |
| body | 14 | w400 | AppText.body → bodyMedium | 正文/气泡/输入框文本 |
| secondary | 12 | w400 | AppText.secondary → bodySmall | 说明/副题/卡片描述 |
| label | 11 | w600 | AppText.label → labelSmall | chip/徽标/Tab/快捷操作标签 |
| micro | 10 | w500 | AppText.micro（自定义） | 时长/版本号/时间戳 |

行高：display/title 1.25（letterSpacing -0.3）、body 1.5、其余 1.4；气泡与工具卡正文 ≥12 号；层级未知时向上取整（12→14），不向下；`AppBarTheme.titleTextStyle` 一并指向 AppText.title（现 18/w700 改为 20/w800）。
## 4 圆角 / 间距 / 描边 / 光晕（每个数字只在此定义一次）
- 圆角 `AppRadius`（改值不改名，新增 pill）：`small=12`（chip/图标容器/小徽标）、`medium=16`（标准卡/输入框/按钮/对话框）、`large=20`（欢迎卡/权限卡/大容器）、`xLarge=28`（hero logo/启动方块）、`pill=999`（胶囊钮/分段控件/徽标）；聊天气泡 18、发言方对侧尾角 6。现存 8/10/14/24 全部迁移：输入框 24→16、卡 10/14→16、按钮 8→16、chip 20→999。
- 间距 `AppSpacing`（新增）：`page=16`（页边距）、`section=24`（区块间）、`cardGap=12`（卡间）、`cardPad=16`（卡内边距，窄卡 12）、`inner=10`（图标↔文字）、`dense=8`（行间/徽标内边距）；禁止 6/14/20/22。
- 描边：标准卡 `stroke` 1px；输入框聚焦 `primary` 1.5px；按压 `strokeStrong`；状态描边=状态色 35% 1px；玻璃面描边深色白 8%/浅色黑 5%；全仓删除 `withValues(alpha: 0.2~0.4)` 描边写法。
- 光晕 `AppShadows`（仅可点焦点与运行态）：`glowPrimary`=primary 30% blur20 y6（主/发送钮）、`glowSoft`=primary 16% blur14 y4（36dp logo/胶囊钮）、`glowHero`=primary 36% blur32 y10（96dp logo/启动方块）、`breathe`=primary 0.18↔0.38 blur16（仅运行中）；静态文字与列表永不发光。
- 玻璃拟态仅 3 处（`BackdropFilter` sigma 18，dart:ui 自带）：顶栏+能力条 surface 72%；快捷条+输入区 surface 82%；底部导航 surface 88%。正文卡/气泡/工具卡禁止 blur；每屏可见 blur 层 ≤2。
## 5 动效（AppDuration 重写 + 内置 Curves，不引动画库；全部经 MediaQuery.disableAnimations 尊重系统减弱动效）
- press 120ms easeOut（按压缩放 0.97）· micro 200ms easeOutCubic（颜色/描边/尺寸微变、状态切换）· enter 280ms easeOutCubic（首屏进场 fade 0→1+上移 12dp，卡片 stagger 50ms，仅首屏 ≤8 元素）· spring 300ms easeOutBack（选中态 Tab 图标 1→1.12→1、分段控件滑块）· page 300ms easeOutCubic（路由/抽屉）· dots 400ms easeInOut（三点跳动 6dp 圆点，各 stagger 120ms）· breathe 1600ms 循环 sine（运行中光晕 0.18↔0.38）。
- 常驻动画只许两处：运行中 breathe、启动/检测三点跳动；欢迎页 `_pulseAnim` 缩放循环删除改 enter 进场一次；状态色切换（running→success）用 micro，不加弹跳。
## 6 逐屏改法
### 6.1 AI 首页 `chat_screen_new.dart`
1. **顶栏 `_topBar`(:525-584) 五件套拆分**：玻璃条高 60dp；左起菜单钮 40dp→36dp brandGradient2 logo（small 圆角+glowSoft）→标题列「khy-os」title 20/w800 单行（现 15 号 :561）+模型名 secondary 次文字（现 10 号 :564）；`_statusDot`(:644) 并入标题行尾（8dp 点+外圈同色 30% 光环+状态文字 label）；右侧只留设置钮 40dp。**`_modeToggle`(:591-641) 整体移出顶栏**，并入能力条右端。
2. **能力条(:667-718) 分层**：`_modeToggle` 落位右端为高 28 分段控件（外框 strokeStrong、选中段 brandGradient2 白字 pill、spring 切换）；`_capChip` 激活=primary 14% 底+42% 1px 描边、未激活=surfaceHigh+stroke（删 `Colors.grey` :707,712）；`v1.1`(:680) 删除，版本号只在设置页页脚出现。
3. **欢迎页 `_welcome`(:993-1056)**：logo 72→96dp/xLarge/glowHero，删 `_pulseAnim` 常驻循环(:995-1015)改 enter；标题 22→28/w800；副题下加**示例问题 chip** 横滚行（高 32，点击填入输入框并聚焦：「帮我打开微信」「截屏看看这页」「帮我算 358×27」）——补「能做什么」的表达。
4. **欢迎卡 `_welcomeCard`(:1058-1086) 改 2×2 网格**（间距 cardGap、等高），第四张卡不再被裁；large 圆角、描边 stroke 1px（换掉 alpha 0.3 :1059）；图标容器 44dp 色块 14%；四卡强调色依次 primary/accent/hot/cyan；AmooTaskCard 移到网格下方。
5. **三层分区**：快捷条(:845-905)+输入区(:915-982)合并为单个玻璃容器（§4 第 2 处）：快捷 chip 高 32/pill/图标 14/文字 label；输入框高 48/medium/surfaceHigh+1px stroke（换掉 alpha 0.3 :931），聚焦 primary 1.5px+glowSoft；发送钮 44→48dp 圆 brandGradient+glowPrimary（busy=error 底 stop 图标）；底栏走 §6.5 玻璃导航——三层各有底、边界清晰。
### 6.2 技能页 `skills_screen_new.dart`
1. **网格(:85-99)**：`childAspectRatio: 1.2`(:91) → 固定卡高 `mainAxisExtent: 148`、间距 12——消除卡下大片空腔；`_skillCard` 外层 Column 的 spaceBetween 改「顶部内容→Spacer→底部行」。
2. **卡内层级(:107-169)**：medium 圆角+stroke 1px；图标容器 36→44dp（skill 色 14% 底+18% 1px 描边）；标题 cardTitle（现 13 号 :142）、描述 secondary 次文字（现 11 号 :157）maxLines 2；底部加「执行 →」行（label 11 primary）填满空腔。
3. **图标去重(:227-229)**：name 含 'screenshot'→`Icons.screenshot`、含 'copy'→`Icons.content_copy`，「复制文本」与「截屏」两支分开。
4. **点击反馈**：裸 `GestureDetector`(:112) 外包 Material+Ink 或 AnimatedScale 0.97/press；按压时描边变 skill 色 45%。
5. **页头(:33-81)**：logo 32→36dp brandGradient2（small+glowSoft）、标题 title（现 15 号 :68）、副题 secondary 次文字（现 11 号 :72）；SnackBar(:171-185) medium 圆角、success/error 底、文字 12。`_colorForSkill`(:248-273) 第三方品牌色保留。
### 6.3 设备页 `device_screen_new.dart`
1. **`_capCard`(:370-441) 统一语言**：medium 圆角+stroke 1px；激活=success 16% 描边+success 6% 底（替换纯绿 alpha 0.3 :382-384）；动作钮(:424-436) 从 primary/14 胶囊改 brandGradient2/pill+glowSoft、白字 12/w600。
2. **权限三行 `_permRow`(:330-368) 收进一张卡**：medium 圆角+surface 底+stroke；行高 44+1px 分隔线；已授权=check_circle 18 success+「已授权」pill 徽标（success 12% 底）；未授权=warning 图标+「去授权」描边胶囊（高 28、warning 70% 描边文字）。
3. **快捷宫格(:236-286)**：两组 Row spaceBetween → `GridView.count(crossAxisCount: 4, 间距 12, 等比 1.0)`；格=surfaceHigh+stroke、medium 圆角、图标 24 放 40dp 圆容器（primary 12% 底）、标签 label；**「截屏」格(:261) 唯一 brandGradient 底白图标**，其余全玻璃描边——立主次。
4. **amoo 卡**：未安装整卡 Opacity 0.6+动作钮改描边不发光，`active:false` 语义保留、不冒充成功态。
5. **区块标题**：统一 13/w700 主文字 85%（替换 alpha 0.6），区块间距 section；设备信息卡 medium 圆角/surfaceHigh/monospace 12/行高 1.6。
### 6.4 设置页 `settings_screen_new.dart`
1. **圆角统一**：输入框 24→16（`app_theme.dart:102,107,110` 深浅同改）+聚焦 glowSoft；`_card`(:504-511) 14→16+stroke 实色（换掉 alpha 0.3 :507）。
2. **底部按钮(:267-289) 不被导航压住**：高 48/medium；「保存配置」=primary+glowPrimary+15/w600（loading 态 :273-278 保留）；「测试连接」=primary 1.2px 描边钮；列表尾 `SizedBox(height: 24)`(:455) → 48。验收线：作为第 4 Tab 嵌入时两钮完整可见、不被底栏压住（压住=返工）。
3. **`_presetTile`(:516-578) 三态化**：使用中=primary 10% 底+primary 1.2px 描边+「使用中」pill 徽标；内置密钥=行首 8dp success 圆点+「内置密钥 · n 个模型」secondary；需填写=「需填写密钥」warning 70% 文字+尾部 chevron（替换灰字）。三态一眼可分。
4. **ListTile 组**：leading 图标放 36dp 圆容器（primary 10% 底、图标 18 primary；状态图标 success/warning 不变）；trailing TextButton 统一描边胶囊（高 32/pill）；`_sectionHeader`(:462-474) 图标 18 放 28dp 圆容器、标题 15/w700。
5. **页脚**：列表最底加版本号 v1.1（micro/textFaint 居中、间距 section）——承接首页删除的版本显示。
### 6.5 外壳 `main.dart`（启动页+底部导航）
1. **启动页(:183-213)**：pageBg+右上角 radial 光斑（primary 18%→透明，半径 0.6 屏宽）；logo 96dp/xLarge/brandGradient+glowHero；「khy-os」display 28/w800+「AI 手机操控台」secondary；`CircularProgressIndicator`(:209) 换三点跳动（§5 dots）。
2. **底部导航(:235-249)**：高 64+玻璃底（§4 第 3 处）+顶部 1px stroke；指示药丸=primary 14%（替换纯 primaryContainer——解决白药丸+深紫图标重量差）；选中图标 24 primary+label 11/w600，未选中 onSurfaceVariant 70%+w400（labelTextStyle 按 WidgetState 分派）；选中瞬间图标 spring 1→1.12→1；outline/filled 成对图标(:108-119)保留。
3. **全局背景**：`scaffoldBackgroundColor` 换 pageBg，四 Tab 一致，滚动内容从玻璃底栏下透出。
### 6.6 装机授权 `main.dart` `_GateChecklistScreen`(:263-491)
1. **头部**：hero 头——48dp brandGradient logo（small+glowSoft）+「装机授权」title 20/w800；下方进度条 3 段 44×6dp pill（完成=brandGradient2、未完成=surfaceHigh+stroke），随授权数点亮。
2. **`_GateItemTile`(:409-491)**：medium 圆角+stroke 1px；已授权=success 6% 底+35% 描边+check_circle 22；未授权=surface+stroke；「必须」徽标→pill（warning 12% 底、label 11/w600）。
3. **「去授权」钮(:482-486)→brandGradient2 胶囊**（高 36/pill/白字 12/w600/glowSoft）；「暂不授权，直接进入」次文字居中。
4. **检测中**：`CircularProgressIndicator`(:373) 换三点跳动（§5 dots）；说明文案 12 次文字、行高 1.5。
### 6.7 悬浮气泡 `BridgeOverlayService.java`（原生，只动绘制参数与默认坐标）
1. **气泡(:130-136)**：黑方块→44dp **圆形** GradientDrawable（TL_BR→BR_TR #4D7CFF→#E363F9）+1.5dp 白 25%（`0x40FFFFFF`）描边；删 `setBackgroundColor(0xF010131A)`(:133)；「桥」字 12→13sp、DEFAULT_BOLD、白。
2. **默认位置(:136)**：`params(dp(44),dp(44),dp(8),dp(220))` → `x=screenW-dp(56), y=dp(176)`（右上吸边、顶栏之下）——不再压「khy-os」标题。
3. **面板(:200-214)**：底 `0xF010131A`(:200) → `#141A2E` 96%+radius 20dp+stroke 1dp `#263153`；标题(:204-208) `0xFF7EE0C0`→`0xFFB7C6FF` 15sp w700；状态文字(:210-214) `0xFFE8ECF4`→`0xFFC9D4F2` 12sp+行距 1.5。
4. **动作钮(:245-256)**：裸文本钮→胶囊（白 8% `0x14FFFFFF` 底/pill、padding 14×7dp、12sp `0xFFE6ECFF`）；「停止桥」例外=字 `0xFFFF9B9B`+底 `0x26FF6B6B`。触摸/吸边/零 IO 逻辑(:141-180, :258-266) 一律不动。
### 6.8 消息与工具卡 `tool_card.dart`（含 chat 气泡对齐）
1. **`ToolCard`(:246-341)**：radius 10→16(:267)、描边 1px 状态色 35%、内边距 12；状态切换 micro 200ms（现 300ms）。
2. **状态徽标(:297-312)**：radius 4→pill(:302)、label 11/w600、底=状态色 12%、字=状态色 100%。
3. **运行态(:428-443)**：spinner 12dp 保留；整卡加 breathe 光晕+primary 1px 描边——运行中是全 app 唯一会发光的卡。
4. **摘要条(:478-534)**：radius 8→12(:501)、描边→stroke 实色；底色按态：运行中 primary 6%/完成 success 6%/有失败 error 6%；文字 12 主文字 85%；错误块(:405-424) radius 6→12、error 8% 底。
5. **气泡对齐(:756-800)**：AI 气泡=surface+stroke（换掉 alpha 0.4 :799）、用户气泡=brandGradient 底白字（替换纯 cs.primary :787）；气泡 radius 16→18、尾角 4→6（:788-795 逻辑保留只改值）；AI 头像 30→32dp/small/brandGradient2+glowSoft；气泡/工具卡/摘要条垂直间距统一 8、内边距统一 12，消息列表出现第四种圆角即违规。
## 7 明确不做
1. **不加任何 pubspec 依赖**——不引 shimmer/lottie/glass_kit 类包；blur 用 dart:ui、动画用内置 Controller。
2. **不搬参考项目的任何资源**——不拷贝 Kazumi/pikapika/hibiki 的图片/字体/图标/代码；不接随机二次元壁纸 API；不用网络图片。
3. **不做二次元贴图墙**——无立绘、看板娘、Live2D、随机背景、弹幕、皮肤系统。
4. **不动业务逻辑与原生机制**——ToolEngine/AppConfig/DeviceControl/AmooService/KhyOsApi/对话状态机、气泡触摸与零 IO 约束零改动；只动绘制层（颜色/尺寸/圆角/动画/布局参数/文案样式）。
5. **信息密度不降级**——正文 ≥12 号、对比度正文 ≥4.5:1；玻璃 ≤3 处、渐变只给 hero logo/主操作钮/用户气泡；无全屏渐变背景；每屏可见列表条数减少不得超过 1 条。
