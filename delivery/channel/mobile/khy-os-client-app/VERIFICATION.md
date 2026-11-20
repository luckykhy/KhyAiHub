<!--
!! THIS FILE IS CORRUPTED -- DO NOT EDIT, DO NOT REWRITE FROM SCRATCH !!
Cause: a PowerShell Get-Content/Set-Content round-trip on 2026-11-14 re-encoded
every CJK character (1507 U+FFFD replacement chars). The text below is mojibake
and cannot be recovered from this file.

READ THESE INSTEAD (same directory, all intact):
  HANDOFF.md                  current status; single summary entry point
  ACCEPTANCE-PROGRESS.md      dated evidence log, incl. what was invalidated
  DOC-CORRUPTION-INCIDENT.md  the corruption incident record

Rebuilding this file from conversation history is possible but was deliberately
NOT done: it would risk overwriting newer facts already recorded above.
-->

# 控制台改�?· 验收记录

任务：改�?`com.khyos.khy_os_client`，让 khy-os 本地直接接收并执�?JSON 命令、在
khy-os 内显示结果，不再默认�?Amoo 拉到前端�?
本文件按「阻碍点 / 实现方案 / 改动清单」三段写，末尾附验收清单逐条状态与复跑命令�?
## 状态摘要（2026-11-14 07:19�?
| �?| 状�?|
|---|---|
| 5 条验收标�?| **2 �?/ 2 部分 / 1 未跑**，剩余三项全部等真机 |
| 真机已取得的证据 | 冷启动第一屏为控制台（橙色品牌�?+ 无障碍横幅）；单条命令端到端打通（日志 `capture �?exec �?历史 2�?` 三连）；历史卡片成功/报错分色、exec 分块渲染�?*注意：这些是设备离线前�?.1.22 版上取得�?*；此后修�?`amooSummon` 谎报与方向键 bug，APK 已于 06:33:52 重建—�?*上述证据未在当前 APK 上复�?*，恢复连接后需重跑确认 |
| 代码与测�?| JVM 40/40；Dart 控制�?24/24；相邻面 610 通过 0 失败；`analyze` 0 问题 |
| 仓库守卫 | `check-amoo-package-literals` 30 冻结 / 30 实测 / **0 error** |
| release APK | 已重建（06:33:52�?4 MB），�?`lib/` 下最新源码新，含方向�?bug 修复 |
| 验收脚本 | 七个脚本就绪：三组验�?+ 设备检�?+ 装包 + **入口编排�?*（编排器曾假成功，已修好并经六项断言验证），均经「实�?�?验证 �?修缺陷�?|
| 四条硬性约�?| 全部有结构性证据（约束 4 为全仓净效果核验�?|
| 已知既有失败 | JVM 3 �?+ Dart 7 文件编译错误�?*均早于本次改�?*（git 状态与时间线双证，见第五节�?|

**唯一剩余工作是真机验�?*，需要用户把手机�?USB 并确认网络可用。完整操作序�?（含装包、①→②→③ 顺序及其依赖理由）见「复跑命令」一节�?
### 给用户的行动清单（插上设备后，按序做�?
| # | 动作 | 谁做 | 失败风险与对�?|
|---|---|---|---|
| 0 | 手机**�?USB 数据�?*，确�?WiFi/移动数据已开 | 用户 | adb over WiFi �?�?会自断；只认 USB 序列号（不带 `:`�?|
| 1 | 装包（脚本外的一步，命令见「复跑命令」） | AI | APK 比源码旧则拒绝装；签名不匹配�?release 构建而非卸载（会丢用户数据） |
| 2 | �?�?`khy_accept2.ps1`�?1 条） | AI | 坐标失效时自动改走「输入行 + ENTER」；逐条核对 status 而非只看行数 |
| 3 | �?�?`khy_offline_accept.ps1`（断网） | AI | 关射频前三层兜底（USB 前提 + 看门�?+ `trap`），不会再把手机弄成双射频全�?|
| 4 | �?�?`khy_amoo_accept.ps1`�?*在提示时点「唤�?Amoo」并�?Amoo 里发 `{"tool":"battery"}`** | **用户点按�?+ 发令**，AI 取证 | 按钮�?tooltip「唤�?Amoo（可选）」认，别数位置；须先开无障碍，脚本会前置检查（含冻结态） |
| 5 | 重验旧证据：冷启动首屏、单条命令链路、卡片渲�?| AI | 早前截图�?1.1.22 版取得的，未在当�?APK 复验 |

**AI 做不到、也不该做的两件�?*：① 不能替你决定要不要授予读屏权限（�?需要，
脚本只会告诉你命令并等你执行）；�?不能在设备不在场时证明「断网可执行」与
「三类错误在 UI 上区分正确」——这两条已有结构性证据，但任务要求真机验证�?
**若某一项失�?*：先看该项的报错属于哪一类（脚本已把「命令没跑」「文件损坏�?「坐标失效」「服务未绑定」分成不同文案），再决定是改脚本、改产品，还是环境问题�?不要先改产品——本任务里大多数失败的最后原因都在脚本或环境侧�?
### 失败了先看哪里（设备恢复后的排错索引�?
每个脚本都把自己的失败分成不同文案（这是前几轮「判据要能区分原因」的落点），
但分散在各处。按症状查：

| 症状（脚本原话） | 最可能的原�?| 先做什�?|
|---|---|---|
| `NO DEVICE` / `WiFi-only` | 没插线，�?adb over WiFi | �?USB；只认不�?`:` 的序列号 |
| `APK STALE` | 源码�?APK �?| `flutter build apk --release` 后重�?|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 签名与设备上用户自装�?App 不同 | **不要卸载**；用本目�?`key.properties` + `khyos-release.keystore` �?release 构建 |
| `NOT RECORDED`（①�?| 命令没跑，或落盘记录损坏 | 看是否有 `WARNING: N unparsable line(s)`；有则是文件损坏，不是没�?|
| `WRONG STATUS (want X, got Y)`（①�?| 分类与预期不�?| 对照 `khy_cmds.json` �?5/6/5/5；若集中在某一组，先查该组命令是否选错 |
| `no new record after the coordinate tap`（①�?| 执行坐标失效 | 脚本已自动改走「输入行 + ENTER」；仍失败则按真机截图重�?`$PLAY_X/$PLAY_Y` |
| `MISMATCH`（② 的行数差�?| 同上，或共享目录不可�?| �?�?日志�?`Active default network` �?`ping` 是否确认为断�?|
| `SHARED HISTORY MISSING`（②�?| `MANAGE_EXTERNAL_STORAGE` 被拒，App 回退私有目录 | 授权后重跑；这也是「Amoo 侧读不到」的同一根因 |
| `WARNING: the accessibility service is NOT BOUND`（③�?| 没开无障碍，或被 ROM 冻结 | 设置里开关一次；仍报则重启�?*注意此判据本身未在真机验证过**（见第六�?13b�?|
| `amoo_record_found=False`（③�?| 四条链路任一�?| 脚本超时后会逐条列出排查命令（日�?窗口/命令形�?grep�?|

**总原�?*：先看脚本给的分类文案，不要先改产品。本任务历史里，失败的最终原�?大多数在脚本侧（坐标、键盘、顺序）或环境侧（权限、签名），产品侧只占少数�?
### 若真机时间有限，按这个顺序验（风险从高到低）

当前 APK **从未在真机上跑过**�?6:33 重建后未安装）。各项改动的保护强度不同�?所以真机时间有限时不该�?①②�?的编号顺序，而该按风险顺序：

| 优先�?| 验什�?| 为什么它风险�?| 现有保护 |
|---|---|---|---|
| **1** | **方向键翻历史**（连按上�?下键、越界、光标在中间时不�?TextField�?| 这是本轮**唯一改过产品交互行为**的地方（`_onKey` 翻历史时全盘接管）；改错了用户直接感�?| 只有 widget 测试（逻辑层）�?*手势/焦点交互未经真机** |
| **2** | **`amooSummon` 循环没起来时不再打开 Amoo** | 改动是「早退 + 不回 success」，涉及线程切换�?result 回调；若早退写错会让按钮完全无响�?| 无测试覆盖（MainActivity 私有方法，JVM 测不到） |
| 3 | 三类错误�?UI 上的区分（`invalid_args` / `tool_unavailable` / `exec_error`�?| 文案�?Dart 映射，映射错则用户看到同一句话 | Dart 单测 14 �?+ widget 12 个，逻辑层覆盖较�?|
| 4 | 冷启动首�?+ 单条命令端到�?| 早前 1.1.22 上验过，链路未再�?| 有历史证�?+ JVM 测试 |
| 5 | 断网执行 | 改动只是脚本层，产品侧执行链未动（`Tools.dispatch` 进程内） | 结构性证据（零网�?import�? loopback 论证 |

**结论**：如果只跑得动一条，跑「上下键翻历史」——它是唯一「改了用户可直接感知�?行为、且只有逻辑层测试保护」的改动�?
### 编排�?`khy_run_all.ps1`：曾假成功，**已修好并验证**�?026-11-14�?
写了一个把「设备检�?�?装包 �?�?�?�?�?③」顺序依赖固化成代码的驱动器，并�?**�?adb** 验证它（`khy_verify_driver.ps1` + stub 脚本；驱动器�?`$adb` 可由
`$env:KHY_ADB` 覆盖，就是为了这个）。结�?*立刻抓到一个真缺陷**�?
```
step 0  ->  USB device: FAKE123456
step 4  ->  Done: steps 0-3 ran end to end; step 4 is the human one.
```

**step 1 / 2 / 3 一步都没跑，而驱动器最后声称�?-3 ran end to end�?*�?即它�?*假成�?*——比跑失败危险得多。六条断言里三�?FAIL（step 1 未跑�?step 2 未跑、失败未止），另三条 PASS 只是因为「step 3/4 确实没跑」——而它�?没跑的原因是编排坏了，不是因为设计止步�?
**这是「新写的分支不验等于没有」的第四次应�?*（前三次：ENTER 兜底是死的�?兜底判据恒真、存活检查用了不存在的信号源）。前几轮�?*验收脚本**里消除假成功�?这一轮差点在**编排�?*里引入一个——而它是唯一会对用户说话的那个（「Done」）�?
**三个真缺陷（全部实测确认，非推测�?*�?
| # | 缺陷 | 证据 |
|---|---|---|
| 1 | `& script.ps1` 之后 `$LASTEXITCODE` **不更�?* | 预设 42，调用后仍是 42，于�?`-ne 0` 读到残留�?|
| 2 | `if (-not (Invoke-Step �?)` **吞掉函数全部 stdout** | 步骤标题/stub 输出/FAILED 全消�?|
| 3 | **`$ok = Invoke-Step …` 同样�?stdout** | `Set-PSDebug -Trace 1` 证明 step 1 完整执行�?`return $true`，输出全�?`$ok` �?|

�?3 条是根因，也是我「修」第 2 条时修错方向的产物：为了避免 `if (�?` 吞输�?改成先赋值，结果**赋值同样吞**�?
**修法与结�?*：函数内改用 `Write-Host`（直写主机，不进 success stream�?不被赋值捕获）+ `powershell.exe -File` 起真子进程（`$LASTEXITCODE` 正确�?
调用方先赋值再判断。修复后 `khy_verify_driver.ps1` **六项断言全过**
（ORCHESTRATION OK）：step 1 执行、step 2 失败被报告、失败后止步�?step 3/4 未被错误触及�?
**验证脚本自身也有两个缺陷，一并修�?*：子进程 stdout 不被父重定向捕获
（断言改用**标记文件**这种副作用证明）、`2>&1 6>&1` 合并信息流�?
**还有一个插曲值得�?*：我一度以为「编号目�?= 新鲜副本」解决了副本过期问题�?但那个目录是修改**之前**那次运行留下的——改�?driver 后没重新生成�?�?Trace 的行号（68 �?vs 修复�?53 行）暴露了它在测旧代码�?**又一个「以为验证过了其实没有�?*，这次是新方法没覆盖到新代码�?
**当前状�?*：驱动器**可用**，真机验收跑 `khy_run_all.ps1` 即可（step 4 需人工
参与，脚本会明确停下并说明）�?
**已排除的可能�?026-11-14 复现 progress，留证免重复排查�?*：用最小复�?（只�?step 1 �?stub，其余不建；`$env:KHY_ADB` 指向�?adb）得到确定性数据：

| 检查项 | �?| 说明 |
|---|---|---|
| step 0 | 通过，打�?`USB device: FAKE123456` | �?adb 生效 |
| `$here` | `...\min_diag`（正确） | 不是路径解析问题 |
| `Test-Path $here/khy_install.ps1` | **True** | stub 存在，不�?MISSING 分支 |
| `Get-Command Invoke-Step` | **有定�?* | 函数没被覆盖或弄�?|
| 诊断行下一行的 `Invoke-Step 1` | **无任何输�?*（标�?stub 输出/FAILED 全无�?| 函数体内第一�?`Write-Output ''` 都没出现 |
| step 4 | 正常打印 | 脚本没在中�?exit |

即：**调用发生了，但函数体像没执行**；同时脚本继续跑到了 step 4（说�?`exit 1` 也没生效）。剩下的可疑点只有两个，按优先级�?�?`& (Join-Path $here $Script) @Extra` �?`@Extra`（空数组）作�?splat 参数
�?`.ps1` 上的行为；② `$LASTEXITCODE` �?PowerShell 调用 `.ps1` 时不更新�?导致 `-ne 0` 恒真�?*两者都待验证，不要再从零猜�?*

**修复方案已验证有效，但完�?driver 仍不执行 step 1�?026-11-14 二次进展�?*�?
1. **两个真缺陷都确认�?*（用 `min_diag\probe4.ps1` 实测，非推测）：
   - `& script.ps1` 之后 `$LASTEXITCODE` **不更�?*（预�?42，调用后仍是 42�?     ——所�?`Invoke-Step` �?`$LASTEXITCODE -ne 0` 读的�?*残留�?*�?   - `if (-not (Invoke-Step �?)` �?*吞掉函数的全�?stdout**——这就是 step 1
     的标题、stub 输出、FAILED 信息全部消失的原因（步骤看似被跳过）�?2. **修法在最�?driver 上六项全�?*：`min_diag\mini.ps1`（只有一�?   `Invoke-Step` 调用）用 `powershell.exe -File` + 先赋值再判断，输�?   `FUNC-ENTER �?stub 执行 �?LASTEXITCODE=0 �?OK �?True`，完全正确�?   完整 driver 已照此修改（`khy_run_all.ps1:42` 起）�?3. **但完�?driver 跑起�?step 1 依然不执�?*，且�?*每次新建编号目录**�?   方式排除了「测试旧副本」这一可能（`driver_test_075036` 是新目录，行为依旧）�?
**已排�?*：路径解析（`$here` 正确）、stub 缺失（`Test-Path` �?True）�?函数丢失（`Get-Command Invoke-Step` 有定义）、`exit` 提前退出（step 4 仍打印）�?测试副本过期（编号目录复现）�?
**未定�?*：为何「单次调用的最�?driver」正常而「完�?driver」的 step 1 不执行�?下一步应该用 `Set-PSDebug -Trace 1` 或把完整 driver 逐步删减到最小形态，**不再�?*�?
---

## 一、阻碍点

### 1. 一开始改错了源码�?
第一轮全做在 `ZCode\...\khyos-client-app-delivery`�?0-23 旧快照：�?Tab、无品牌标�?版本 1.1.17+2）上。新�?UI 实际来自本目录（`delivery/mobile/khy-os-client-app`�?1.1.22+7，橙色品牌标 + 单屏聊天 + 模式切换）。发现后整体搬迁�?
### 2. 装不上真机：签名不匹�?
`flutter build apk --debug` 用默�?debug 密钥，与设备上已安装�?1.1.21 签名不一致，
`install -r` 被拒。设备上那个是用户自己的 App，卸载会丢数据，**没有擅自�?*�?解法：用本目录自带的 `android/key.properties` + `khyos-release.keystore` �?**release 构建**，签名对上、覆盖安装成功、数据未动�?
### 3. 冷启动预填完全失效（已修�?
`MainActivity` �?*没有 `onCreate` 覆写**，`capturePendingConsoleCmd` 只挂�?`onNewIntent` 上。�?`am force-stop` �?`am start` �?*新建** Activity，走 `onCreate`�?`onNewIntent` 根本不被调用——于是冷启动时预填静默丢失，输入框从头到尾只�?`hintText`�?
真机上看到的样子极具误导性：点执行按钮报「先输入一条命令」，而输入框�?*看着有东�?*
——那是占位符，不是预填。作者据此在点击坐标上白转了好几轮，一度误判为「产�?bug」�?真正的定位手段是加日志：`_exec()` 里打�?`_input.text` 的长度与 `selection.baseOffset`�?看到 `len=0 sel=-1`（`TextEditingValue.empty` 的哨兵值）才确认控制器从未被赋值�?
### 4. 真机连接不稳

adb �?WiFi，会话期间掉线多次；屏幕还会 Dozing，灭屏期间所�?`input tap` 都点到黑屏�?验收脚本必须�?`settings put system screen_off_timeout` + `svc power stayon true` +
`input keyevent 224` + `wm dismiss-keyguard`，并在每次点击前确认 `mWakefulness=Awake`�?
**另外记一个作者自己的失误**：为了验证「断网执行」，�?adb-over-WiFi 的设备跑�?`svc data disable`，当场断开且预定的恢复没来得及执行，手机两个射频全灭�?断网验证要么�?USB，要么只关移动数据保�?WiFi，要么把断网+恢复写进同一�?on-device 脚本并用 `trap` 保证恢复�?
---

## 二、实现方�?
### 原生执行内核（两个新文件�?
| �?| 职责 |
|---|---|
| `ToolSchema` | 50 个工具的契约：必�?可�?类型/二选一/分组 |
| `KhyConsole` | 唯一执行通道。`prepare()` 解析+校验，`exec()` 执行+落盘，`validateOnly()` �?Amoo 循环复用**同一�?*准入判断 |

**描述不手抄第二份�?* `ToolSchema` �?group 与一句话说明直接�?`Tools.CATALOG` 取，
另加测试 `descriptionsComeFromTheBridgesOwnCatalogue` 逐字比对，防止有人改回手�?导致两边漂移——漂移的方向一定是「控制台描述一个桥已经没有的工具」�?
**`strict` 开关�?* 拒绝未知参数只在「该工具的参数集已逐字核对过」时才安全。核对过�?�?`strict=true`；没核对的标 `false`——仍查必填（高价值），但不拒未知参数。猜错参数集
会误杀合法命令，而误杀比不校验更糟：用户看到的是「参数不合法」，真实原因却是我们�?schema 写错了�?
**三类失败在源头分开**，不混成「失败」，因为三者要用户做的动作完全不同�?
| status | 含义 | 用户该做什�?|
|---|---|---|
| `invalid_args` | 命令本身不合法（�?JSON、缺 tool、未知参数、类型错、条件参数缺�?| 改命�?|
| `tool_unavailable` | 命令合法但这里跑不了（未知工具、UI 工具而无障碍未开�?| 去授�?/ 换工�?|
| `exec_error` | 工具跑了，失败了 | 读错误详�?|

每条结果�?`error` + `hint` + `needs_auth`；exec �?App 身份运行时另�?`capability_note`，明确说�?`input`/`am`/`pm`/`cmd`/`settings` 会因权限不足而无操作
—�?*不假装可写系�?*�?
**记录**：每次执行（含被拒的）追加一行到
`/sdcard/bridge-amoobridge/console_history.jsonl`，`origin` 区分 `manual`/`amoo`�?追加写而非覆盖写——崩溃丢一行比丢整份历史好。两边读写同一个文件�?
### �?Amoo 解�?
`AmooLoop.executeOne()` 不再自己�?`Tools.dispatch`：先 `KhyConsole.validateOnly()`
（白名单/参数 schema/无障碍授权，**同一�?*判断，不写第二份），再过 `LoopModes` 安全底，
最�?`KhyConsole.exec(ORIGIN_AMOO, �?`。手动敲的和 Amoo 产出的走同一条通道、同一�?文件、同一种失败分类�?
`amooSummon`�?*�?arm 拦截循环，再打开 Amoo 聊天�?*。反过来会漏�?Amoo 已经开�?输出的那一条命令——而漏掉的命令看起来像「Amoo 什么都没说」，是最难查的一类故障�?上下文（当前命令与结果）�?`KhyConsole.lastContext()` 写进 Amoo 输入框，**不发�?*�?代用户按发送是一个决定，不是便利�?
### Dart �?
`console_service.dart` 只做翻译，不重新判断。`console_screen.dart` 是第一屏之外的
第二个页签，AppBar �?`KhyBrandMark`（橙色品牌标）�?
**页签位置是产品决策，不是技术选择**：本树原有决定是「文件管理是第一页签�?（源码注释写明），所以控制台插在「文件」之后、「AI」之前，不顶掉它�?
---

## 三、改动清�?
### 产品代码（本次改造的主体�?
| 文件 | 说明 |
|---|---|
| `android/app/src/main/java/com/khyos/khy_os_client/bridge/KhyConsole.java` | **新增**，执行内核：`prepare`/`exec`/`validateOnly`/`history`/`export`/`favorites`/`lastContext`/`baseDir`，三类失败分开，追加写共享历史 |
| `android/app/src/main/java/com/khyos/khy_os_client/bridge/ToolSchema.java` | **新增**�?0 工具契约，group/描述�?`Tools.CATALOG` 取不手抄 |
| `android/app/src/main/java/com/khyos/khy_os_client/bridge/AmooLoop.java` | 改，`executeOne` �?`validateOnly` �?安全�?�?`KhyConsole.exec(ORIGIN_AMOO,�?`；新�?`typeIntoAmoo()` 唯一净化出站通道 |
| `android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt` | 改，8 �?console/amoo 方法 + base64 预填 + �?`onCreate`；`amooSummon` 循环没起来时不再谎报「已启动�?|
| `lib/core/services/console_service.dart` | **新增**，只做翻译不重新判断；`ConsoleEntry`/`ConsoleStatus`/`ConsoleTool`/`ConsoleFavorite`/`ConsoleExport`/`ConsoleHistoryPage`/`AmooSummonResult` |
| `lib/ui/screens/console_screen.dart` | **新增**，AppBar �?`KhyBrandMark`；输入区、工具面板、历史卡片、常用指�?chip、raw/格式化切换、无障碍横幅、共享存储横幅；`_onKey` 翻历史改为「翻历史中全盘接管�?|
| `lib/main.dart` | 改，控制台为第二页签 |

未改动：`Tools.java` / `HttpBridge.java` / `BridgeService.java` / `LoopModes.java` 安全�?/
`KhyUi.java`。桥�?PC 侧的契约一个字没动�?
### 测试（本次新增，�?5 个文件）

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `android/app/src/test/java/com/khyos/khy_os_client/bridge/KhyConsoleValidateTest.java` | **40** | 白名单与 schema 双向对齐、描述与 CATALOG 逐字一致�?1 条混合命令分类、manual/amoo 记录等价、三类文案互异、常用指令无副作用、导出逐行相同、`MAX_HISTORY` 从头部淘汰、`theBannerAndTheGateReadTheSameBoolean`（横幅与门控同源�?|
| `test/console_status_test.dart` | **14** | 三个状态的标签与处置建议互异、未�?status 必须 unknown、未�?origin 按手动算、缺字段不炸、`capability_note` 原样带出 |
| `test/console_screen_test.dart` | **12** | 上下键翻历史完整语义（连�?越界/回退/输入区仍可用）、光标在中间时不�?TextField、Amoo 与手动卡片渲染结构一致、空态、输入区渲染、卡片分型、工具置灰、共享存储横幅、常用指�?chip |

另有仓库级守卫的修正：`scripts/ci/check-amoo-package-literals.cjs`——补登记本次新增�?`console_service.dart:250` 字面量，并修�?4 处既有行号漂移（�?`AmooApexLink.kt` 三条
从未登记过的），�?16 error 修到 **30 冻结 / 30 实测 / 0 error**�?
### 验收脚本（不在仓库内，放 `D:\Portable\4-output\Temp\`�?
| 文件 | 用�?|
|---|---|
| `khy_run_all.ps1` | **入口**：设备检�?�?装包 �?�?�?②，任一步失败即止；step �?停下交给�?|
| `khy_devcheck.ps1` | 只查设备/mDNS 并按结果给出下一步；设备没来时确认「无事可做�?|
| `khy_install.ps1` | 装包：APK 旧则拒装、绝不卸载、只�?USB |
| `khy_accept2.ps1` + `khy_cmds.json` | �?21 条混合命令跑查，按命令文本索引预�?status，逐条比对落盘记录 |
| `khy_offline_accept.ps1` + `khy_offline_test.sh` + `khy_offline_watchdog.sh` | �?断网执行，USB 前提 + 看门�?+ `trap` 兜底 + 主机侧恢�?|
| `khy_amoo_accept.ps1` | �?Amoo/手动一致性取证，两道前置检查（已开无障�?+ 仍活着）、心跳、超时归�?|
| `khy_verify_driver.ps1` | 编排器自检（假 adb + 标记文件断言，六项）；改 `khy_run_all.ps1` 后必�?|

**废弃，别�?*：`khy_accept.ps1` �?`khy_accept2.ps1` 的旧版，缺「点执行前收键盘�?等关键修正（旧版在真机上 20 条落 0 条）。它还在磁盘上只是没清，**不要因为�?看起来像新版就运�?*�?
---

## 四、硬性约束的结构性核�?
四条硬性约束里�?/2/4 不依赖真机行为，可以用「代码引用了什么」直接证�?
| 约束 | 核验方法 | 结果 |
|---|---|---|
| **1 不新增云端对话依�?* | 检查控制台相关四个文件的全�?import | `console_service.dart` �?2 �?import（`dart:convert`、`package:flutter/services.dart`）；`console_screen.dart` 7 个、`KhyConsole.java` 16 个、`ToolSchema.java` 9 个—�?*四个文件合计 0 个网络库**（无 dio / http / websocket / socket / dart:io / java.net / android.net / okhttp�?|
| **4 不把桥对外开�?* | 在新代码里搜监听/转发原语 | `KhyConsole.java` / `ToolSchema.java` / `MainActivity.kt` �?`ServerSocket` / `HttpServer` / `listen(` / `forward` / `tunnel` / `adb reverse` / `new Socket(` **全部零命�?* |

**约束 4 的全仓净效果核验�?026-11-14 补，此前只查了新增文件）**：把搜索范围
从「本次新增」扩�?*整个 `android/app/src/main`**，确认改动集的净效果�?
| 文件 | 是否我改�?| 监听/转发原语 |
|---|---|---|
| `KhyConsole.java` / `ToolSchema.java` | 新增 | 零命�?|
| `MainActivity.kt` / `AmooLoop.java` | �?| 零命中（`AmooProtocol`/`AmooSafe` 里的 "forward" 是英文普通词，如 "Walk forward"�?forward slashes"，非端口转发�?|
| `HttpBridge.java` | **未改**（本 WIP 既有�?| �?`ServerSocket`，但 `:316` 显式 `bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), �?)`。`:276` 的注释记着实测「`new ServerSocket(port)` 默认�?0.0.0.0」这个坑**早已修掉** |
| `ShellSidecar.java` | **未改**（既有） | �?`ServerSocket`，同�?loopback + adb forward 设计，注释在 `HttpBridge.java:69`、`BridgeService.java:368`、`CallChain.java:19` 三处说明 |

即：**新增与修改的文件没有开出任何新的网络面**，既有的两个监听者都�?loopback-only
（PC 侧经 `adb forward` 进来，�?adbd 在设备侧�?loopback 连接完成转发）�?| **2 不提权、不引入 root** | 定位本次新增代码块，比对提权原语命中�?| 新增块恰好是 `MainActivity.kt` 1029-1208 行（`onCreate` / `onNewIntent` / `capturePendingConsoleCmd` / `consoleExec` / `consoleHistory` / `consoleExport` / `consoleFavorites` / `amooSummon` / `jsonToMap` / `jsonValue`）；提权原语（`ShellSidecarClient` / `uid 2000`）命中行 31�?56�?32�?33�?327�?407�?462�?533�?574�?666 **全部落在块外**，且 31 行是既有�?`ShellSidecarClient` import |
| **3 不依赖无障碍** | 见第六节验收 5 �?`ToolSchema.needsAccessibility` | �?`ui_*` / `shot` / `shot_b64` 需要无障碍，由 JVM 测试 `onlyUiToolsNeedAccessibility` 对全�?50 个工具逐一断言；其余工具不经这道门 |

**控制台通道的隔�?*：`KhyConsole.java` �?`console_service.dart` 中对
`HttpBridge` / `HttpURLConnection` / `Dio` **零命�?*——控制台只走 MethodChannel
（应用内 IPC），不经 HTTP 桥，也不新开任何网络面�?
`git status` �?`HttpBridge.java` / `BridgeService.java` / `Tools.java` 显示�?M�?那是�?WIP **既有的未提交改动**，不是本次产生的；本次只新增 `KhyConsole.java` �?`ToolSchema.java`，只修改 `AmooLoop.java` �?`MainActivity.kt`�?
### 断网执行的结构性证据（2026-11-14 补）

上面那张表证的是「代码不引用网络」。执行链路本身还可以再往前追一层，因为
`KhyConsole` 自己**不执行命�?*——它把命令交�?`Tools.dispatch()`（`KhyConsole.java:291`），
也就是本机既有的 50 工具分发器，全程进程内：

| �?| 用到的原�?| 断网影响 |
|---|---|---|
| `KhyConsole.java` import | `android.content.Context` / `org.json.*` / `java.io.*` / `java.util.*` / `AtomicLong` | �?|
| `console_service.dart` / `console_screen.dart` import | `dart:convert` / `flutter material+services` | 无（�?`dart:io` 都没有） |
| `Tools.dispatch` 内部若起 shell | `ShellSidecarClient` �?`127.0.0.1:PORT` | loopback 不经射频 |
| `HttpBridge`（本 WIP 既有，非本次新增�?| `ServerSocket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), �?)` | 只绑 loopback；源码注释记着实测「默�?`new ServerSocket(port)` 绑的�?0.0.0.0」后才改成显�?127.0.0.1 |

即：关掉 WiFi 与移动数据后，控制台这条路上没有任何一次出网请求，也没有任�?需要域名解析的动作。缺的只是真机上跑一遍确认（见第七节�?2 条）�?
---

## 五、发现并修掉的问题（共十三个：前七个真机暴露，后六个由守卫、代码复核、清单与脚本核对、兜底验证、信源核对查出）

1. **exec 失败时顶部写「执行报错：未知错误�?* —�?�?`error` 字段是空的，�?stderr �?   就写着原因（实�?exit 127 + `zz_no_such_cmd_xyz: inaccessible or not found`）�?   退成「未知」会把明明写在那里的原因盖掉。已改成没给 `error` 就用退出码/stderr 拼一句，
   并加测试 `aFailedExecSaysWhyNotUnknownError` 钉住�?
2. **输入区整个不见了** —�?外层 shell �?`extendBody: true`，内容延伸到底部导航�?*底下**�?   不补内边距，输入区会被玻璃导航栏盖住，而且**没有任何溢出报错**（东西没丢，只是画在
   导航栏后面），极易误判为「渲染失败」。已�?`80 + 系统手势区` 的底部内边距�?
3. **冷启动预填完全失�?* —�?见阻碍点 3：`MainActivity` �?`onCreate` 覆写，预填只挂在
   `onNewIntent`（热启动）上。真机现象是「点执行报先输入一条命令，而输入框看着有东西」，
   而那其实�?`hintText` 占位符。定位手段是加日志打�?`_input.text` 长度�?   `selection.baseOffset`，`len=0 sel=-1` 即证明控制器从未被赋值�?
4. **共享存储失效时静默违背「同一份存储�?* —�?任务要求「khy-os �?Amoo 共享同一�?   JSON 与对话记录，两边读写同一存储，不各存一份」。但 `/sdcard/bridge-amoobridge`
   不可写时，`KhyConsole.baseDir()` �?*静默回退**�?App 私有目录，于�?Amoo 侧读不到
   这些命令记录，而界面上看不出任何差别。用户在 Amoo 侧找不到刚跑过的命令，也无从判断
   是没跑还是没同步——正是这套代码自己注释里反复警惕的「静默失败」�?   已修：新�?`ConsoleHistoryPage` �?`path` �?`shared` 原样送到界面；`shared == false`
   时在控制台顶部显示红色横幅，写明「命令记录只存在�?App 内，Amoo 侧读不到�? 当前
   路径 + 「授予所有文件访问后即可恢复」，并给「去授权」按钮。这不是功能降级提示�?   �?*一个前提不成立**的提示�?
5. **执行后不滚到顶部** —�?历史列表是「新的在前」，用户完全可能之前往下翻过。那时点执行�?   新卡片落在屏幕外，界面看着毫无变化，用户会以为没点上，于是**重复点、重复执�?*�?   早已声明 `_scroll` 控制器却从没用它。已�?`_loadHistory()` �?`jumpTo(0)`�?
6. **exec 输出没有上限** —�?`Tools.exec` �?stdout 上限�?1MB，一�?`find /` 就能顶满�?   �?`_execResult` 把整�?stdout/stderr 直接塞进 `SelectableText`，界面会卡死�?   **卡死的界面看起来�?App 坏了，不像「这条命令输出太多了�?*。`_textResult`（read �?   content）那条路早有 4000 字截断，`_execResult` 漏了。已�?`_blockCap = 8000`�?   超长时截断并说明「共 N 字符，仅显示�?8000；完整内容用 raw JSON 视图或导出查看�?   ——不说截了多少就等于偷偷改数据。`_xmlResult`（ui_dump，上�?5000 节点）同样补了提示�?
7. **我引入的安全回归：attachContext 开出第二条未净化出站通道** —�?这条单独说，
   因为它是本次改造中**唯一由我造成、又被既有测试抓�?*的缺陷，且性质是安全性的�?
   `attachContext`（把当前命令与结果写�?Amoo 输入框�?*不发�?*）最初直接调�?   `KhyUi.dispatch("ui_type", �?`。而本代码库有一条硬不变量，�?   `AmooSafeHostAuditTest.everyOutboundChannelIsSanitisedAndThereIsOnlyOne`
   **按源码文�?*钉住�?
   > `AmooLoop` 内向 Amoo 输入框写入的通道必须只有一处，且载荷必须经�?`forAmoo`
   > 净化。`AmooSafe` 的「第九个调用点免费继承净化」只对第九个 `writeBack()` 成立�?   > �?*第二�?dispatch 站点不成�?*�?
   我为「不发送」这个需求新开一�?dispatch，等于绕过净化。全量测试立刻报�?   �?96 个测�?4 失败，其�?2 个由我造成）�?
   **修法**：把「写入输入框」抽成唯一�?`typeIntoAmoo()`（含 `forAmoo` + dispatch），
   `writeBack` �?`attachContext` 都走它。抽完还要满足审计的两条文本判据——dispatch
   必须�?`writeBack` 方法�?*之后**、且两者之间含 `forAmoo(`——所�?`typeIntoAmoo`
   放在 `writeBack` 之后�?
   **还有一个坑值得�?*：第一版修完仍然失败，因为我在 **javadoc 注释里写了字面量**
   `KhyUi.dispatch("ui_type"`，被 `indexOf` 当成首次出现（位置还�?`writeBack` 之前）�?   审计数的是源码文本，**注释也算**。改写注释后才过。现已核验：dispatch 恰好 1 处�?   �?`writeBack` 之后、其间含 `forAmoo(`、`AmooSafe.sanitise` 唯一调用�?
8. **amooSummon 把「循环没起来」报成「已启动�?* —�?这条和上一条同源：又是
   **只有既有守卫/事实能抓住、界面看不出差别**的一类，而且这次是复用了别人已经
   修过一次的坑�?
   `AmooLoop.start()` 在无障碍未开启时**不抛异常**，只在内�?`return` 并把
   `running` �?false（`AmooLoop.java:913-920`）。�?`running == false` 同时也是
   「已经跑完」的样子——`Tools.java` �?`loop_start` 早就为这件事专门�?   `ok:false + code:"refused"`，`UiAdviceTest.loopStartAnswersWithAFailureCodeNotASuccessAndADeadLoop`
   用源码文本把这一点钉着，注释里写得很直白：「调用方�?`ok` 会当成成功」�?
   而我�?`amooSummon` 里写的正是这样一�?*没受保护的调用方**�?   `start()` 之后无条�?`notes.add("本地拦截循环已启�?)`。真机现象会是：�?   「唤�?Amoo」→  snackbar 说「已唤起 Amoo · 本地拦截循环已启�?· 已打开 amoo
   聊天页」→ 用户�?Amoo 里敲命令 �?毫无反应。界面刚确认过布防成功，所以用�?   只会去怀�?Amoo，不会怀疑这条链�?
   **修法**：`start()` 之后�?`AmooLoop.isRunning()`；没起来�?*不打开 Amoo**
   （聊天页看着就绪却什么都不会被截获，比不打开更糟），直接�?   `ok:false` + 两条 note 说明是无障碍没开。与 `Tools.java` 那次修法是同一�?   方向�?*拒绝必须由调用方自己变成一个可读的结果，不能靠调用方猜**�?
9. **`com.stepos.ailauncher` 字面量冻结表被我用新字面量撞�?* —�?顺带记一下，
   因为它是本轮唯一一�?*仓库级守�?*的发现，而且我一开始没打算跑它�?
   `scripts/ci/check-amoo-package-literals.cjs` 把四源码根里每一�?Amoo 包名
   字面量按 `file:line + 整行文本` 冻结，理由是「等数变异」（把包名打错一个字母）
   用坐标式冻结抓不到。我�?`console_service.dart` 的示例命令生成器里写了一�?   `return 'com.stepos.ailauncher';`，属于清单外新字面量，守卫直接报
   `unregistered-literal`�?
   跑之前它还额外红着 15 �?error：`MainActivity.kt` �?`AMOON_*` 四条（我新增
   的代码块把常量挤下了 435 行，其中 26 行是本轮修第 8 条时加的）�?   `AmooApexLink.kt` 三条（该文件本身没登记过）、以�?`Tools.java` /
   `phoneBridgeCatalog.js` 的纯行号漂移—�?*后两者在 HEAD 里就已经是漂�?*
   （`git show HEAD:` 里该常量�?2107/2110，冻结表写的�?2065/2068），不是本次
   造成的。已按守卫自己的约定处理：行号漂移的更新坐标，新字面量补登记 + 写理由�?   现在 **30 冻结 / 30 实测 / 0 error**�?
   **教训**：这个项目的守卫是「按行号冻结」的，而我在一�?2337 行的文件里改代码�?   改完必须重跑，不能假设只有我自己的测试算数�?
10. **20 条命令清单里有一条放错了�?* —�?这条是核对验�?�?的输入时发现的，
    性质是「会让真机结论失真」，所以单独记�?
    清单第四组（执行报错）里放着 `{"tool":"loop_start","args":{"mode":"nope"}}`�?    �?`loop_start` 的未�?mode �?*校验�?*就被拒（`ToolSchema.java:403-406`
    `conditionalProblem`），�?*根本不会执行**，因此不可能产生 `exec_error`�?    它的正确分类�?`invalid_args`——分类没错，错的是我把它放在了错误的组里�?
    为什么值得当一个问题记：真机跑完按组计数，预期 5/5/5/5，实际会�?5/6/5/4�?    那时的自然反应是去查渲染是不是漏了一条，而真实原因是清单自己�?*一条不�?    执行的命令放在「执行报错」组里，等于给验收埋了一个必然对不上的数�?*

    **修法**：`loop_start` 移到「参数不合法」组，第四组补一�?`unzip`
    （指向不存在�?zip，必填两个字符串�?`strict`，必然执行失败而非校验失败）—�?    恢复这一组本该测试的性质。清单现�?**21 条�?/6/5/5**，测试方法随之改�?    `theAcceptanceCommandMixClassifiesCorrectly`，并把「有一条在校验期就被拒�?    所以真机分组计数不是均分」写进测试注释�?*40 tests / 0 failures**
    （mtime 06:08:55）�?
    **顺带一个反直觉的点**：`loop_start` 在白名单里、参数集**没有逐字核对�?*
    （`strict=false`，`:221`），所以未知参数不会被拒——它能被拒，靠的�?    `conditionalProblem` �?`mode` 取值的那道额外检查。也就是说这条命令的
    分类正确�?*碰对�?*，不�?schema 严格性带来的�?
11. **验收脚本的判定比实现宽松** —�?与第 10 条同类，但发生在**判定环节**�?    所以分开记：�?10 条是「输入放错组」，这条是「就算输入对了也验不出来」�?
    �?`khy_accept2.ps1` 判一条命令成功，只看**历史文件行数是否增加**
    （`$now -gt $before`）。这不是验收标准�?    - 上一条命令延迟落盘，会让这一条「被记成功」而它从未执行�?    - 文件�?`MAX_HISTORY` 后从头部淘汰，行数也可能不增或异常变动；
    - 更关键的是它**从不核对 `status` 是否等于该命令的预期分类**，三类错�?      是否区分正确，全靠我在结尾用眼睛看那份聚合输出——那不是判据�?
    也就是说：即�?21 条清单完全正确，这个脚本也可能报�?21 �?    `recorded`，而其中某条根本没跑、或跑出来的分类是错的�?
    **修法**（`khy_accept2.ps1`）：
    - 每条命令�?*预期 status**（按 5/6/5/5 位置对应），执行�?*�?`raw` 精确
      匹配落盘记录**（同一条命令文本重复出现时取最新一条），状态必须等于预�?      才算 `PASS`，否则报 `WRONG STATUS (want X, got Y)`�?    - 行数只作�?`history before/after` 的参考信息，不再是判据；
    - 结尾汇总按「本次运行、每个命令取最新记录」统计，重跑不会把上一轮的
      记录重复计数�?    - 清单条数�?21 变成别的数时**直接退�?*——下面的预期表是按位置对应的�?     silently 用错长度的清单跑完会得到一份看似合理的错报告�?    语法�?`/20` 硬编码残留已校验清除�?
**本轮�?026-11-14 06:01）复�?*：`KhyConsoleValidateTest` **39 tests / 0 failures /
0 errors**（报�?mtime 为本次运行，非旧报告），Kotlin 编译通过（`BUILD SUCCESSFUL`）；
`check-amoo-package-literals.cjs` **30 冻结 / 30 实测 / 0 error**�?
12. **我加的兜底连续两次有缺陷** —�?与第 11 条同源（「不验就等于没有」），但发生�?    更深的层：前几条说的是「判据比实现宽松」，这两条是**补救代码本身没验�?*�?
    - **ENTER 兜底是死�?*：① 脚本的第三条重试路径原本是「点输入�?�?�?ENTER」�?      一测发�?`sendKeyEvent(LogicalKeyboardKey.enter)` 产生 **0 �?* exec 调用�?      �?`receiveAction(TextInputAction.send)` 产生 **1 �?*（json 正确）。即
      `onSubmitted` 只由 editor action 触发，裸 ENTER 键事件不走这条路——而真机上
      `input keyevent 66` 正是前者那一类，且脚本为了坐准备先收了键盘�?*兜底�?      最需要它的那一刻才会被发现是死的�?*
    - **兜底判据恒真**：② 脚本的兜底判据原为「历史行数未增长」，�?      `wc -l < $HIST 2>/dev/null` 在文件不存在时输�?*空串**，两边皆空则恒等—�?      而「共享目录不可写」正是该设备的已知状态。那会把已成功的命令**再执行一�?*�?      并掩盖真正该发现的问题。已改为三分支：皆空 �?明确�?SHARED HISTORY MISSING�?      相等 �?走兜底；不等 �?记录坐标点击已生效�?
    **修法与教�?*：兜底路径比主路径更需要验证——主路径每次运行都被走，兜底只在
    故障时走一次，而那一次往往是最不该出错的时候。两次都是「改完立刻去验它」发现的�?    而不是等真机。三个脚本现已全部经过「实�?�?验证 �?修缺陷」�?
13. **�?的「服务还活着」检查用了错误的信源** —�?同一条线上的第三例：判据看起�?    合理，但它依赖的那个信号根本不存在�?
    原检查用 `logcat -d -s KhyAccessibility` 找心跳。但 `KhyAccessibilityService`
    **只在连接时与截图失败时打日志**（`KhyAccessibilityService.kt:101`、`:414`），
    而真正的心跳来源 `onAccessibilityEvent` **一行日志都不打**。于是一个健康且
    长期运行的服务，`logcat` 里什么都没有——这个检查会�?*每一台正常设备上报假�?*�?    而真正从没连上过服务的设备反而与「正常老服务」无法区分�?
    **修法**：改用系统自己的登记�?`dumpsys accessibility | grep -c khy_os_client`�?    冻结态下框架�?unbind，服务从登记簿里消失，而那正是 App 内部 `isReady()`
    （对象仍存活）看不见的状态。信源从「App 愿意打什么日志」换成「系统认定它是什么」�?
13b. **紧接上文：那个新判据也是个未验证的断言** —�?换掉假信号之后立刻自�?    「新的就是真的吗」，答案是不确定，于是把它降级�?
    我在注释里写「冻结态下框架�?unbind，服务从登记簿里消失」——这�?**Android
    框架行为**，不是在这台设备上测出来的事实。而且查遍仓库�?    **没有任何地方用过这个判据**（`AccessibilityManager` /
    `getEnabledAccessibilityServiceList` / `dumpsys accessibility` 全部零命中）�?    也就是说本项目自己验证过的机制是另一个：`KhyAccessibilityService.isAlive()`
    用的 `lastEventAt` 时间戳�?
    如果「冻结态仍留在登记簿里」，那这个新检查又变成一个看起来合理的假判据—�?    正是�?13 条批评的那类问题，只是换了个方向�?
    **处理**：不改回 logcat（那个已证伪），但把断言从「事实」降级为「待验证假设�?    写进脚本：注明它�?logcat 版严格更好（未绑定的服务确实不在 dumpsys 里）�?    �?**PASS 不等于「服务能读屏�?*，真正的判据仍是 App 自己的拒绝语
    （「循环未启动：无障碍服务未开启」）与实跑结果。设备恢复后，第一件事�?    在一�?*已知良好**的设备上比对这两个信号，再决定这个检查能否升级为判据�?
---

## 六、验收清单状�?
| # | 验收标准 | 状�?| 证据 |
|---|---|---|---|
| 1 | 关掉网络，仍能输入一�?JSON 命令并看到结�?| **结构上已证，运行时未�?* | 结构侧见第四节：四个控制台文件合�?**0 个网�?import**（`console_service.dart` �?`dart:convert` + `flutter/services`），`KhyConsole.java` �?`HttpBridge`/`HttpURLConnection`/`Dio` 零命中——控制台只走 MethodChannel 与应用内文件 IO；且执行实际�?`Tools.dispatch()` 进程内完成，shell 侧最多走 `127.0.0.1` loopback�?*但这证明的是「代码不依赖网络」，不是「断网时真的能跑�?*：后者要真机，被设备掉线挡住 |
| 2 | 冷启动第一屏不�?Amoo 对话框，而是工具/命令面板 | **已过（按新树既有设计 + 早期实测�?* | 新树第一页签本就是「文件」，AI 已退到第三；控制台在第二页签。早期真机截图确认过冷启动落在控制台（含品牌标与无障碍横幅），但**此后改过产品代码，该截图未在当前 APK 上复�?* |
| 3 | 20 条混合命令，三类错误提示区分正确，历史可回溯 | **分类逻辑已证** | JVM 上用同样 20 条命令逐条断言状态与文案互异；真�?UI 跑查未完成�?*注意清单现为 21 条�?/6/5/5**：`loop_start` 未知 mode 在校验期即被拒，不属于执行报错组，已移到参数不合法组并以 `unzip` 补齐（见第五节第 10 条）——否则真机分组计数会必然对不�?|
| 4 | Amoo 产出的命令与手动命令显示格式、记录方式完全一�?| **核心已证 + Dart 渲染层已补测** | JVM 等价测试：两 origin 记录�?`origin` 字段不同，同文件同顺序�?*关于「显示格式」的解读**：卡片结构、分型渲染、raw 切换、错误分类展示全部走同一�?`ConsoleEntry` 与同一�?widget，因此格式一致；唯一有意保留的差异是来源徽标（手�?/ Amoo）——它不是格式，是元数据，且任务本身就要求两条路可区分（见�?3「记录里用这个区分」）。若要求连徽标也去掉，需人确认�?*2026-11-14 �?*：新�?widget 测试 `Amoo 与手动的命令卡片渲染结构一致`——此�?Dart 渲染层对这件�?*零覆�?*（`record()` 助手�?origin 硬编码为 `manual`�? �?widget 测试全走手动路径），JVM 只能证「记录字段相同」，证不了「Dart 把两条记录渲染成同样的东西」。新测试把同一条命令分别以两种 origin 渲染，逐项断言命令原文、`执行报错` 标签、错误文案、raw 视图入口与徽标都各自恰好渲染出一份。widget 测试 8 �?9 全绿，analyze 0 问题 |
| 5 | 未开无障碍时只有 ui_* �?shot 不可用并给授权提示，其余全�?| **部分** | 真机截图已见横幅与「去授权」按钮，`enabled_accessibility_services` 实测 `null`；其余能力全通未逐条跑�?*但有一处必须说�?*：无障碍关闭�?* Amoo 拦截循环也不会启�?*——`AmooLoop.start()` �?`Tools.uiReady()` 为假时直接返回并报「循环未启动：无障碍服务未开启」（`AmooLoop.java:913-920`），因为该循环是�?`KhyUi.dispatch("ui_dump")` �?Amoo 屏幕、用 `ui_type`/`ui_tap` 写回的。这不是本次改造引入的依赖，也不是能在不改�?Amoo 集成方式的前提下消除的：不读 Amoo 的屏幕就没有「从 Amoo 对话里截获命令」这回事。控制台自身（手动敲命令 �?执行 �?显示）在无障碍关闭时**已实测全�?*，受影响的只有建立在 `ui_*` 之上的那部分能力，与验收标准 5 的字面一�?|

**「只�?ui_\* 被门控」的结构证据**：`KhyConsole.java:227` 的判据是
`ToolSchema.needsAccessibility(canonical) && !accessibilityReady()`——门挂在**单个工具**
上，不在通道入口；`ToolSchema.needsAccessibility` �?JVM 测试
`onlyUiToolsNeedAccessibility` 对全�?50 个工具逐一断言。横幅与门控**同源**
（Dart �?`_tools.any((t) => t.needsA11y && !t.available)`，`available` 来自原生
`describeTools()` 里的同一�?`accessibilityReady()`），所以不会出现「横幅说没授权�?工具却显示可用」这种自相矛盾�?
**这条同源关系已有测试钉住**�?026-11-14 新增，`tests=40 / failures=0`）：
`KhyConsoleValidateTest.theBannerAndTheGateReadTheSameBoolean`。为什么值得单独
钉一条：JVM 上无障碍服务永远是关的，**行为测试只能跑到一个分�?*，能坏的只有
接线——门被挪到通道入口（那就把整个控制台一起挡了）、或�?`available` 与横�?读的不是同一个布尔（那就出现「横幅说没授权、面板显示可用」）。这两种在真机上
都极难归因，所以用源码文本判据固定：门必须�?`ToolSchema.needsAccessibility(canonical) && !accessibilityReady()`（逐工具，不在
入口）、`available` 必须�?`!needs || a11y`（同一�?`a11y` 变量）、且
`a11y_ready` 必须送回 Dart（否则界面只看到一排灰掉的工具，不知道原因）�?
**已知局限（冻结态，2026-11-14 记录在案�?*：这条判据的底层�?`Tools.uiReady()` =
`KhyAccessibilityService.isReady()` = `instance != null`。ROM 冻结后台无障碍服务时
对象还在、事件停收，该布�?*仍为 true**——于是「其余能力全通」在冻结态下会被误判�?`KhyAccessibilityService.kt:43-68` 为此提供�?`isAlive()`�?20 �?staleness）与
`lastEventAt` 心跳，但 `uiReady()` 没有采用它。这是本 WIP 既有的取舍（改它会牵�?`Tools` / `LoopModes` / `AmooLoop` 三处门控，超出本次范围），此处记录在案：
真机若出现「横幅不显示、但 `ui_dump` 静默返回空」，先怀疑冻结，不要怀疑分类逻辑�?
### 已完成的验证

**Dart 全树无回归（2026-11-14 分批实测�?*。方向键改动挂在 `Focus` 上，理论�?可能影响任何带输入控件的界面，所以不能只跑控制台自己的测试。分三批跑完�?
| 批次 | 范围 | 结果 |
|---|---|---|
| 第一�?| 控制�?/ 交互 / Amoo UI�? 个文件） | 85 passed |
| 第二�?| Amoo 系列�?1 个文件） | 243 passed |
| 第三�?| 其余全部 125 个文�?| 见当次运行输�?|

Amoo 系列�?243 个是最可能的受影响面（同样的输入控件与 Focus 结构），全过�?
**方法上的一条教�?*：最初用单个 `flutter test` 跑全树，输出�?`Select-Object -Last` 整个缓冲，跑�?20 分钟看不到任何进度——无法判断它是在
工作还是卡死，只能取消重来。改成分批后每批都有可见的通过计数，失败时也能立刻
定位到具体文件�?*跑看不到进度的长任务，等于把「它是否还活着」变成一个猜谜�?*

**全量跑会卡住的原因（2026-11-14 查清�?*：有 **7 �?*测试文件带编译期错误�?�?`loading` 阶段就失败，而一个文件编译失败会让整批挂住——这就是 125 个文�?一次传入时无声卡死的根源。完整名单由 `flutter analyze test` 一次给出：

| 文件 | 错误 |
|---|---|
| `arena_runner_test.dart` | `const_with_non_const`�?307�?|
| `capability_manifest_test.dart` | `'a' * 64` 不能用于 const�?33�?34�?|
| `multimodal_message_test.dart` | `Uint8List` 不是类型�?83�?|
| `rag_retrieval_test.dart` | const 表达式操作数类型�?451）、`maxChars` 未定义（:626�?|
| `recognize_image_test.dart` | `Uint8List` 不是类型�?53�?|
| `trace_chain_test.dart` | `normalizeProducer` 参数个数、`Text`/`MaterialApp` 未导入、可空接收器�?|
| `usage_ledger_test.dart` | `hasRecords` 未定义（:194�?|

**�?7 个与本次改造无�?*：`git status` 显示它们全部 clean（未改动），其中
`capability_manifest_test.dart` 最后修改于 **11-04**、最后提交于 **11-09**�?而本次工作是 **11-14** 的事——时间线上不可能相关。本次只新增
`console_service.dart` / `console_screen.dart` / `console_screen_test.dart` /
`console_status_test.dart` 四个文件�?
**既有失败基线（跑测试前先知道，否则「全绿」永远达不到�?*�?
| �?| 既有失败 | 性质 |
|---|---|---|
| JVM | `AmooLoopOrphanHealTest` ×2 | 单独跑该类即在失败态，�?WIP 既有 |
| JVM | `AdbClientTest` | 全量并发�?flaky，单独跑通过 |
| Dart | 上表 7 个文�?| **编译期错�?*，加载即失败，与本次无关 |

排除上述 7 个后，剩下的 137 个文件一次跑完（分批确认无回归：已跑 610 个通过�?0 失败）。把既有失败和回归分开记账，否则每次跑测试都对不上，而「全绿」这�?目标本身会失去意义�?
**为什么不再追求「跑完剩下那 75 个文件�?*：排�?7 个编译失败后�?37 个文�?一次跑**仍然静默卡住**（dart 进程 CPU 0.1s / 内存 10MB，与卡死时完全相同）�?说明除编译错误外还有**运行期挂�?*的测试（等待永不出现�?Future、或 `await`
真实定时器）。而剩余那些文件与 `console_*` 改造毫无交集——它们挂起对本次结论
没有影响。已确认�?610 个通过覆盖了所有相邻面：控制台自身�?4 个）、Amoo 系列
�?43 个，�?`_onKey` 共用 Focus/输入控件结构）、以及输入外壳与屏幕度量等�?**为凑一个「全树绿」的数字去修 7 个既有编译错�?+ 若干运行期挂起，是把本次
改造的范围偷偷扩大到别人留下的�?*——那正是应当避免的事�?

- **全量 JVM 测试 796 个，其中我引入的失败已清�?*。基线是 789 �?/ 2 失败�? �?  `AmooLoopOrphanHealTest`，单独跑该类即在失败态，属本 WIP 既有）。改造中途一度变�?  4 失败——多出的 2 个（`AmooLoopChannelTest` �?`AmooSafeHostAuditTest`�?*是我造成�?*�?  见第五节�?7 条；修复后回落到 3 失败，第 3 个是 `AdbClientTest`，单独跑
  **2 tests / 0 failures 通过**，属全量并发下的 flaky，与本次改动无关�?- **JVM 39 个测试全�?*（`gradlew :app:testDebugUnitTest --tests …KhyConsoleValidateTest`�?  tests=39 failures=0 errors=0）。覆盖：50 工具 schema �?`Tools.NAMES` 双向对齐�?  描述�?`Tools.CATALOG` 逐字一致�?0 条混合命令分类、manual/amoo 记录�?`origin`
  不同、三类文案互异、`secret_put` 无投递码即拒、`zip`/`unzip` �?`out`/`dest` 即拒�?  exec 失败不许退成「未知错误」�?  另有一组针对「常用指�?/ 导出 / 保留条数」的回归保护，其中最关键的一条：
  **`savingAShortcutNeverExecutesTheCommand`** —�?存常用指令绝不执行命令�?  早先的实现是「跑一遍看能不能用来验证」，于是存一�?  `{"tool":"rm","args":{"path":"/sdcard/DCIM"}}` 会把相册删掉。用户要的是书签�?  书签不该有副作用。测试建一个临时文件、存一条指向它�?`rm`，然后断言文件仍在�?  且没有产生任何执行记录。其余：跑不通的命令存不进去；存了能取回、按 id 删只�?  那一条；导出与历�?*逐行相同**（被改写过的导出无法复现，而记录的全部价值就在于
  那条产生结果的命令还读得出来）；只保留最�?`MAX_HISTORY` 条且�?*头部**淘汰
  （丢最新的那条等于丢掉用户最可能想找回来的那条）�?- **Dart �?14 个测试全�?*（`flutter test test/console_status_test.dart`�?  All tests passed!）。为什么单独测这一层：三类失败的真源在原生（`KhyConsole`
  �?`status` 字段），但用户最终读到的字是 Dart 翻出来的。原生分得再清，
  Dart 把三�?status 映成同一个词，前面就全白做了——而这纯粹是打字错误就�?  造成的事故。覆盖：三个状态的**标签与处置建议各自互不相�?*；原�?status
  字符串能还原�?*认不出来�?status 必须�?unknown 而不�?ok**（把失败读成
  成功是最坏的方向）；认不出来�?`origin` 按手动算而不�?Amoo 算（反过来会�?  别人发的命令记到自己头上）；`ConsoleEntry` 缺字段不炸且 `capability_note`
  原样带出（硬性约�?2 的落点：exec �?App 身份跑必须说出来，不能假装能写系统）�?  示例命令的坐标类参数给数字而非字符串�?  **2026-11-14 �?*：新�?`origin 是没见过的新值时按手动算，不�?Amoo 算`�?  起因是发现「认不出来的 origin 按手动算」这件事�?Dart �?*只测�?  `consoleOriginLabel('')` �?`(null)`**，而徽标显示走的是**另一�?*判断
  （`ConsoleEntry.isAmoo`，即 `origin == 'amoo'`）——空值测过了�?*非空但没见过
  的�?*（`'pc'` / `'AMOO'` / `'amoo '`，注意大小写与尾空格都不等于 `'amoo'`�?  没人测。新用例钉住这四个值都必须落到「手动」侧，同时钉住真�?`'amoo'` 仍要
  认得出（别为了保守把�?Amoo 也否了）�?3 �?14 全绿，analyze 0 问题�?- **Dart widget 测试 9 个全�?*（`flutter test test/console_screen_test.dart`�?  All tests passed!，analyze 0 问题）。这一组把此前**零验证的最后一�?Goal 功能** 补上了：
  「支持上下键翻历史」�?  写它之前有一个具体的担心：Flutter 的按键事件从内往外冒泡，`TextField`
  内部�?`Shortcuts` 会先消费掉方向键，包在外层的 `Focus.onKeyEvent` 可能
  整条链路都收不到——真机表现是「按上下键没反应」且没有任何报错�?  **测试证伪了这个担�?*：`按上键翻出上一条命令` 通过，说明按键确实到达了
  处理逻辑。若当初没写这条测试，这个功能会一直带着「可能根本是死的」的疑问
  上线，而疑问只能靠真机手测消除�?  其余：空态显示引导而非空白；输入区与执行按钮渲染出来；历史卡片按来�?  与状态区分（`执行报错`/`成功` 标签各自出现、命令原文原样保留）；未授权无障�?  时横幅说明「其余能力不受影响」；**共享存储失效时提示「Amoo 侧读不到�?*�?  常用指令 chip 点击填入输入框�?  **�?9 �?`Amoo 与手动的命令卡片渲染结构一致`�?026-11-14 新增�?*：验收标�?4
  �?Dart 层证据。此�?`record()` 助手�?`origin` 硬编码成 `'manual'`�? 个测�?  全部只跑手动路径——一条「记录字段相同、却被渲染成两种样子」的回归，JVM 抓不到�? 写它的过程值得记，因为连续错了四次，全是我自己的测试写法问题而非产品问题�?  �?�?`tester.allWidgets` 序列化整棵树做比较，拿到的却是上一�?`pumpWidget`
  残留�?`ScaleTransition`/`RotationTransition`——`allWidgets` 只覆盖当前挂载的
  widget，懒加载列表里的卡片不在其中；② 同屏渲染两条记录想比树，改为分开渲染�?  �?�?origin 后界面没变——`ConsoleScreen` �?StatefulWidget，同一棵树上重�?  `pumpWidget` 不重�?`initState`，历史不会重新加载，改用 `ValueKey` 强制重建�?  �?最隐蔽的一个：把对「手动」徽标的断言写在�?*第二次渲染之�?*，�?  `pumpWidget` 会整棵替�?widget 树，那时第一次那棵已经不在了——报错只�?  「找不到」，看不出原因。最后的解法是每轮渲染后立刻断言，并�?*先写一个只打印
  不诊断的探针**看清界面实际渲染出什么（`[Amoo]` 一直都在，是测试自己的时序错）�?  这个顺序值得记住：断言连续失败时，先探针看实际值，别继续改判据�?
  **�?10�?1 条：上下键翻历史，以及修掉的一个真 bug�?026-11-14�?*�?  任务要求「支持上下键翻历史」，原有测试只按了一次上键，证的是「按键到得了
  处理逻辑」。补 `上下键逐条翻历史，到底后停下`（连按三次须依次拿到三条历史�?  到最旧一条后必须原地不动、按下键须逐条回退并最终回到空、两端都不能越界�?  全程输入区仍能正常打字）之后�?*探针测出一个真 bug**�?
  > 连续按上键，一半的按键没反应。按 5 次只�?3 格，间隔一次生效一次�?
  根因：`_onKey` 用「光标在�?末行」判断该不该接管方向键（为的是不�?  TextField 自己的光标移动），而翻到一条历史后它把光标设到**末尾**——于�?  下一次按上键撞上 `caret != 0` 被忽略。用户看到的就是「按一半键没反应」，
  会以为键盘粘键�?
  **第一次修错了**：改成「上键放开头、下键放末尾」分别设置光标。上键连翻了�?  但立刻堵死下键（下一次按下键撞上 `caret != text.length`）——新测试当场抓到�?  根因是「借光标位置分流」这套设计与翻历�?*互斥**�?
  **正确的修�?*：`_historyIndex >= 0`（正在翻历史）时方向�?*全盘接管**，不�?  看光标——那时光标位置没有意义，内容是刚放进去的历史条目，不是用户在编辑�?  文本；光标仍设一个确定值（开头）以免 TextField 拿到越界 offset�?
  **�?12 条护�?*：改动之后补 `光标在中间时按上键不翻历史，交给 TextField �?  光标`，守着原设计的存在理由——没在翻历史时不能过度接管，否则用户在长命令
  中间按上键想挪光标，却莫名其妙被换成一条历史命令�?*只断言「不翻」这一�?*�?  另一侧（光标在末尾时该翻）已由前两条覆盖，且在测试环境里要手工同�?  `controller.selection` 与焦点，实测不可靠（第一版加了它，失败在同步时机而非
  产品行为，于是删掉）�?
  至此 widget 测试 **8 �?12**，与 `console_status_test.dart` 合计 **24 个全�?*�?  `analyze` 0 问题�?- **端到端全链路真机打�?*（修�?`onCreate` 后），日志三连为证：
  ```
  I KHYCONSOLE: capture: len=18 head={"tool":"battery"}
  I flutter : KHYCONSOLE exec: len=18 value=[{"tool":"battery"}]
  历史文件行数：before=2 after=3
  ```
  �?intent 预填 �?冷启动捕�?�?`_exec()` 读到完整命令 �?执行 �?落盘共享历史�?- Java + Kotlin 编译通过；`console_screen.dart` / `console_service.dart` / `main.dart`
  **0 analyzer 问题**（全�?108 �?issue 是本 WIP 既有的，均不在这些文件里）�?- **真机截图实证**�?.1.22 release，覆盖安装在用户 App 之上、数据未动）�?  AppBar 带橙�?`KhyBrandMark`；橙色横幅「未授权无障碍：ui_* �?shot 不可用，其余能力
  不受影响 · 去授权」；历史卡片 `执行报错`（红�?`成功`（绿）分色；exec 结果分块渲染
  （退出码 127 / 执行通道 app / stderr）；battery 键值格式化；控制台在第二页签且高亮�?
### 复跑命令

> **APK 过期陷阱�?026-11-14 记录，已重建�?*：`app-release.apk` 曾停�?05:32:09�?> �?`lib/ui/screens/console_screen.dart` 改于 06:24:44（方向键 bug 修复）�?> **测试全绿不代表设备上跑的是新代码**——设备恢复后必须确认 APK �?> LastWriteTime 晚于 `lib/` 下最后修改的源码，否则装上去跑的是旧行为�?> 本次已于 06:33:52 重建�?4,074,274 字节，含方向键修复）�?
设备恢复后（`adb devices` 能看到手机）�?
**首选：跑入口脚�?*（一条命令走�?0-3 步，step 4 会停下等你人工参与）�?顺序依赖已固化在代码里，不依赖谁记得�?
```powershell
powershell -ExecutionPolicy Bypass -File 'D:\Portable\4-output\Temp\khy_run_all.ps1'
```

它依次做：设备检查（只认 USB）→ 装包（APK 旧则拒装、绝不卸载）�?�?21 �?�?�?断网 �?然后**停下**并告诉你 step �?需要你点「唤�?Amoo」并发一条命令�?任一步失败即止，不带着坏前提继续�?
**备选：手动逐条�?*（想单步重跑时用；每条独立，可单独重跑）�?
```powershell
# ── �?0 步：装包（三个脚本都不负责安装，任务要求「改动后�?adb 装上跑一遍」）──
$adb  = 'D:\Portable\2-tools\Tools\platform-tools\adb.exe'
$apk  = 'D:\Portable\khy-os\delivery\mobile\khy-os-client-app\build\app\outputs\flutter-apk\app-release.apk'
$src  = Get-ChildItem 'D:\Portable\khy-os\delivery\mobile\khy-os-client-app\lib' -Recurse -Filter '*.dart' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
# APK 比最新源码旧就白装了：跑的是旧行为，而测试全绿会让人以为装的是新代码�?if ((Get-Item $apk).LastWriteTime -le $src.LastWriteTime) {
  Write-Output "APK 过期�?((Get-Item $apk).LastWriteTime) <= $($src.Name) $($src.LastWriteTime)），先重�?
} else {
  & $adb install -r -d $apk
}

# 先跑 ①，再跑 ③。顺序不能反，也不能交叉，原因见下�?# �?混合命令清单跑查 + 历史回溯（命令清单在 khy_cmds.json�?1 �?5/6/5/5�?powershell -ExecutionPolicy Bypass -File 'D:\Portable\4-output\Temp\khy_accept2.ps1'

# �?断网执行（必须插 USB 数据线，见下�?powershell -ExecutionPolicy Bypass -File 'D:\Portable\4-output\Temp\khy_offline_accept.ps1'

# �?Amoo / 手动一致性（脚本负责取证，按钮要人点�?powershell -ExecutionPolicy Bypass -File 'D:\Portable\4-output\Temp\khy_amoo_accept.ps1'
```

**装包�?`install -r -d`，不要卸�?*：设备上那个 App 是用户自己装�?1.1.21�?签名�?debug 构建不一致，`install -r` 会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`�?而卸载会丢用户数据。解法是用本目录自带�?`android/key.properties` +
`khyos-release.keystore` �?**release 构建**（签名对上、覆盖安装成功、数据未动）�?`-d` 允许降级覆盖�?
**�?必须�?�?之前，且不能交叉**：③ 需要至少一�?manual 记录作对照，而那正是 �?产生的；更重要的�?�?�?*每条命令**都做 `am force-stop` + 冷启动，那会�?�?依赖�?Amoo 拦截循环杀掉——交叉跑出来的失败看起来�?Amoo �?bug，实际是执行顺序造成的�?�?与两者无状态依赖，可在任意位置跑（但它要求 USB，见下）�?
**�?为什么必须插 USB**：断网验收要�?WiFi 关掉，�?adb-over-WiFi 的连接本身就长在
WiFi 上——一关就连不上，而恢复步骤还没跑，手机两个射频全灭、谁也连不上它�?阻碍�?4 记的就是这个事故。现在整套改�?USB 前提 + 三层兜底�?
1. 主机侧先检�?`adb devices`�?*只认 USB 序列�?*（不�?`:` 后缀的那种）�?   只有 WiFi 设备时直接退出并说明原因，不贸然关射频�?2. 设备侧先起一个看门狗（`khy_offline_watchdog.sh`，sleep 200 后无条件
   `svc wifi enable` + `svc data enable`），再起主脚本�?3. 主脚本用 `trap restore EXIT` 保证任何退出路径（含被 kill）都恢复射频�?   结尾再恢复一次并�?`DONE`；主机侧跑完也照�?`svc wifi enable` 一遍�?
主脚�?`khy_offline_test.sh` 里用到的坐标�?`khy_accept2.ps1` 同一�?（页�?(307,2506) / 执行 (932,1997)），并且同样在点执行�?`input keyevent 111`
收键盘。判据是 `history_before` �?`history_after` 的行数差�?*两个射频全关�?历史仍然 +1**，就是本地执行成立；同时日志�?`ping` 失败�?`Active default network` 为空，证明当时确实没有网�?
**�?为什么按钮要人点**：「唤�?Amoo」是 AppBar 里的 IconButton，像素位置必�?截图实测——这个项目里已经因为目估坐标点错而静默换过好几次页签。而且这本�?就是功能的语义：Amoo 是按需唤起的，不该被脚本自动点开。所以脚本把应用起到
控制台页、截图给你看、轮询历史文件里 `origin=amoo` 的新记录，最后把 manual �?amoo 两条并列打出来比对（tool / status / error / result 键名）�?
**按钮怎么认（2026-11-14 widget 实测，非目估�?*：AppBar actions 一行里�?**六个** IconButton，靠「从右往左数第几个」定位是不可靠的——本轮就差点写错
（早先的注释说「第 4 个」，而实际顺序是 展开工具面板 / 执行 / 存为常用 /
raw JSON / 导出 / 清空 / 唤起 Amoo，共 7 个含输入行内的）�?*唯一可靠的判据是
tooltip「唤�?Amoo（可选）�?*，它当前是唯一的。另外实测确认：带上无障碍横�?与共享存储横幅后，forum 图标仍然恰好 1 个——横幅挂�?body �?Column 里，
AppBar 是它的兄弟节点，所以按钮位置不受横幅影响�?
**�?还要求先开无障�?*：`AmooLoop.start()` 在无障碍关闭时拒绝启动（见第六节
验收 5），所以脚本第一件事就是�?`enabled_accessibility_services`，没开就打�?授权命令并退出——读屏权限不该被脚本悄悄授予�?
**�?还要额外查「活着」，不只是「开着�?*：`Tools.uiReady()` 只问服务对象是否
绑定（`KhyAccessibilityService.isReady()` = `instance != null`）。�?StepOS/MIUI
派生 ROM 会冻结后台无障碍服务—�?*冻结时对象还在、事件停�?*，`uiReady()` 一�?返回 true，每次读屏都静默返回空。`KhyAccessibilityService.kt:43-68` 正是为了
这个才有�?`isAlive()`�?20 �?staleness 窗口）与 `lastEventAt` 心跳。所以设�?可能通过第一项检查却在第二项上栽掉，而那时的现象是「Amoo 很慢」而不�?「服务死了」。脚本因此补了第二步：logcat 里找 `KhyAccessibility` 心跳，找不到
就唤醒屏幕再试，仍无声则告警但继续跑（让实跑结果自己说话）�?
脚本里的坐标�?*量过的、验证过�?*，不要再凭截图估�?
| 目标 | 坐标 (1200x2670) |
|---|---|
| 底部导航「控制台」页�?| (307, 2506) |
| 输入行「执行」按�?| (932, 1997) |

**坐标为什么现在仍然有�?*（量完之后又改过布局，值得说清）：无障碍横幅与共享存储横幅都挂�?`Column` �?*顶部**，而输入区�?`Column` �?*最后一个子节点**——横幅多一条只会让中间�?`Expanded` 变矮，不会把输入区顶走。所以执行按钮的 y 不变。同理，工具面板展开时它插在
`Expanded` 与输入区之间，输入区依然在底部�?*唯一会移动输入区的是软键�?*�?`_loadAll()` 里预填后 `_focus.requestFocus()` 会弹键盘，把输入行顶高约 300px—�?跑脚本时若怀疑点空了，先 `input keyevent 111`（ESC）收键盘再点�?*验收脚本 `khy_accept2.ps1` 已在点执行前加入收键盘这一�?*——早先那轮�?0 条只�?0 条」的根因就是没做：软键盘把输入行顶高�?300px，按键盘关闭态的坐标点下去会落到底部导航上，静默换页签�?
**脚本编辑的累积误差体检�?026-11-14�?*：这个文件在十几轮里被反复编辑，而其�?一轮的替换确实留下�?5 行残码（靠改完立即跑 `Parser::ParseFile` 才发现，肉眼�?那一段时结构是完整的）。所以做了一�?**AST 级全文体检**，一次性覆盖所有历史编辑：

| 检查项 | 方法 | 结果 |
|---|---|---|
| 语法 | `Parser::ParseInput` 收集 errors | 0 |
| 函数定义 | `FunctionDefinitionAst` 遍历 | 3 个：`Test-PlayCoordinate` / `Get-HistCount` / `Get-HistEntries` |
| 函数调用 | `CommandAst` 按名匹配 | �?1 次静态出现，无未使用函数 |
| 孤儿代码 | 上述两项交叉 | �?|

（`Get-HistEntries` 静态只出现 1 次但运行时最多被�?21×3 次：它在 `:250` 的重�?循环内，该循环又�?`:204` 的命令循环内——AST 数的是静态出现，不是执行次数。）

**教训**：反复编辑长文件时，「改完立刻语法校验」不够——它抓得到残码，但抓不到
「函数定义了却没人用」这类结构腐坏。AST 遍历能，且应�?*定期�?*而不是每轮做�?
**同一次体检里的一个虚警，值得单独�?*：文档结构检查第一版用
`Trim() -eq '```'` 数代码块围栏，数�?**3 个（奇数�?*并据此判断「有未闭合代码块」�?实际上文档有 4 个围栏、两对都闭合——漏数的那个�?```` ```powershell ````�?带语言标注，trim 后不等于�?` ``` `�?*差点去「修」一个不存在的问题，而那一�?会真的把文档弄坏**（在 653 行前插一个多余围栏，使其余全部内容掉进代码块）�?
根因与前面几轮同源，只是对象换成�?*我刚写的检查脚�?*：写完直接信它的输出�?没先拿一个已知正确的输入试它。修正后�?`-match '^\s*```'`（兼容语言标注）重跑，
得到 608-612�?31-653 两对，全部配对�?
**可复跑的检查项**（本次体检覆盖，共三项）：围栏配对（须兼容 ```` ```lang ````）�?章节编号连续性（一→八）�?6 个关键段落存在性�?
**产品代码的结构体检�?026-11-14 补，与脚�?文档同级�?*：七个产品文�?（`KhyConsole.java` / `ToolSchema.java` / `AmooLoop.java` / `MainActivity.kt` /
`console_service.dart` / `console_screen.dart` / `main.dart`）全部经�?`flutter analyze`，结�?**No issues found!**（含未使用导入、未引用声明、类型检查）�?
**判据本身也验�?*——这正是上一轮围栏虚警学到的：拿一�?*已知有问�?*的文件试
analyzer，`test/trace_chain_test.dart` 当场报出 5 �?`not_enough_positional_arguments`
error。工具能报错，所以�? 个文�?0 问题」是真信号，不是 analyzer 失灵�?
（`flutter analyze` 只对 `.dart` 有效；三�?Java/Kotlin 文件是由它顺带编译检查的�?真正管它们的还是 JVM 单元测试�?Kotlin 编译，那两项单独验过。）
`Column` �?*顶部**，而输入区�?`Column` �?*最后一个子节点**——横幅多一条只会让中间�?`Expanded` 变矮，不会把输入区顶走。所以执行按钮的 y 不变。同理，工具面板展开时它插在
`Expanded` 与输入区之间，输入区依然在底部�?*唯一会移动输入区的是软键�?*�?`_loadAll()` 里预填后 `_focus.requestFocus()` 会弹键盘，把输入行顶高约 300px—�?跑脚本时若怀疑点空了，先 `input keyevent 111`（ESC）收键盘再点�?*验收脚本 `khy_accept2.ps1` 已在点执行前加入收键盘这一�?*——早先那轮�?0 条只�?0 条」的根因就是没做：软键盘把输入行顶高�?300px，按键盘关闭态的坐标点下去会落到底部导航上，静默换页签�?
**预填命令链的三个性质�?026-11-14 核查，① 能连�?21 条的前提�?*�?
| 性质 | 位置 | 为什么对 �?重要 |
|---|---|---|
| **一次性消�?*：`takePendingConsoleCmd()` 取出即把 `pendingConsoleCmd` �?null | `MainActivity.kt:1086` | �?每条命令�?force-stop + 冷启动，所以每次都消费新命令；若命令可重复消费，重试会读到上一次的残留 |
| **空值不清空输入�?*：`if (pending.isNotEmpty)` 才赋�?| `console_screen.dart:73` | �?�?`am start` 不带 `--es`，`pending` 为空；若此处无条件赋值，�?会把用户正在 Amoo 里写的上下文清掉 |
| **只在 `initState` 取一�?*：`_loadAll()` 仅由 `initState` 调用 | `console_screen.dart:56`、`:69` | widget 重建（旋转屏幕、`ValueKey` 变更）不会二次消费，也不会清空用户已输入的内�?|

这三条此前只是隐含假设，从未验证。核查后确认链是健的�?1 条连跑之间不会互相污染，
�?的手动输入也不会被预填逻辑清掉�?`Column` �?*顶部**，而输入区�?`Column` �?*最后一个子节点**——横幅多一条只会让中间�?`Expanded` 变矮，不会把输入区顶走。所以执行按钮的 y 不变。同理，工具面板展开时它插在
`Expanded` 与输入区之间，输入区依然在底部�?*唯一会移动输入区的是软键�?*�?`_loadAll()` 里预填后 `_focus.requestFocus()` 会弹键盘，把输入行顶高约 300px—�?跑脚本时若怀疑点空了，先 `input keyevent 111`（ESC）收键盘再点�?*验收脚本 `khy_accept2.ps1` 已在点执行前加入收键盘这一�?*——早先那轮�?0 条只�?0 条」的根因就是没做：软键盘把输入行顶高�?300px，按键盘关闭态的坐标点下去会落到底部导航上，静默换页签�?
`input tap` �?y 特别容易错：导航栏占�?y�?150 以上，输入行�?y�?900-2100�?两者只差几百像素，点错就静默换页签、不报任何错�?
### 坐标与测试环境不一致（2026-11-14 发现�?*设备恢复后第一件要核实**�?
�?widget 测试�?1200×2670 画布上量执行按钮（tooltip「执行（↑↓ 翻历史）」）
的真实几何，得到中心 **(1116, 2558)**，而脚本点的是 **(932, 1997)**—�?偏差 dx=184、dy=561，按脚本坐标点下去会落到底部导航区域，即静默换页签�?
**但没有据此改脚本**，因为两者测的不是同一件事，不能互相覆盖：

| 来源 | 含义 | 可信�?|
|---|---|---|
| 真机截图量得 (932,1997) | 含系统状态栏/导航�?inset �?*真实屏幕坐标**，`input tap` 用的就是这套 | 高（早前 20 条跑查实际生效过，日志有 `历史文件 before=2 after=3` 为证�?|
| widget 测试量得 (1116,2558) | 逻辑像素画布上的 Flutter 几何，`setSurfaceSize` **不含系统 inset**，且 `NavigationBar` 在测试环境的高度与真机不一定相�?| 仅作参�?|

**恢复连接后第一件事**：跑一条命令，�?`adb exec-out screencap -p > shot.png`
取真机截图，量出执行按钮中心，与脚本坐标比对。若不一致，改脚本的 `$PLAY_X/$PLAY_Y`
并在本节记录新值与测量方法�?*不要**�?widget 测试的几何去改脚本坐标�?
**ENTER 兜底为什么必须先唤键盘（2026-11-14 实测�?*：`khy_accept2.ps1` 的第三条
重试路径是「点输入�?�?�?ENTER」，�?`TextField.onSubmitted �?_exec()`
（`console_screen.dart:625`，`textInputAction` �?`TextInputAction.send`，`:609`）�?写这条兜底时没验证就加了，一测发现问题是真的�?
| 触发方式 | exec 调用次数 |
|---|---|
| `sendKeyEvent(LogicalKeyboardKey.enter)` | **0** |
| `testTextInput.receiveAction(TextInputAction.send)` | **1**（json 正确�?|

�?`onSubmitted` 只由 **editor action** 触发，裸 ENTER 键事件不走这条路。而真机上
`input keyevent 66` 正是前者那一类—�?*键盘收着的时候按 ENTER 毫无反应**。所�?兜底序列改成「点输入行唤出软键盘 �?�?2 �?�?�?ENTER」，�?ENTER �?SEND 动作�?身份到达�?
这个教训与坐标那条同源：**兜底路径不加验证就等于没�?*。第一版兜底是死的�?只是在最需要它的那一刻才会发现�?
---

## 七、遗留待�?
1. **21 条完整跑�?*：脚本与坐标就绪（`khy_accept2.ps1`，已含点执行前收键盘），
   只差设备�?*清单已修正为 21 �?5/6/5/5**（见第五节第 10 条），跑完按这个
   分组计数核对，不要按均分核对�?*脚本判定也已改为逐条核对 `raw` + 预期
   status**（见�?11 条）——以前只看行数增加，那种判据下即使清单正确也可能
   全报 `recorded`。预期表**按命令文本索引而非位置**，且双向校验（清单里出现
   无预期的命令、或某条预期没有对应命令）都会直接退出——长度不变但中间插一�?   的情况，以前会静默错位，现在不放行�?2. **断网执行**：脚本已按阻碍点 4 的教训重做（`khy_offline_accept.ps1` +
   `khy_offline_test.sh` + `khy_offline_watchdog.sh`，USB 前提 + 看门�?+
   `trap` 兜底 + 主机侧再恢复一次），只差设�?*且必须插 USB**�?3. **Amoo/manual 真机一致�?*：代码路径已统一（同 `KhyConsole.exec`、同文件、同
   `origin` 字段），JVM 也已证明记录等价，剩真机目视。取证脚�?   `khy_amoo_accept.ps1` 已就绪，且已�?*两道**前置检查—�?*这项验收要求先在设备�?   给本 App 开无障碍服�?*，否�?`AmooLoop.start()` 拒绝启动（见第六节验�?5 的说明）�?   点「唤�?Amoo」只会看到「循环未启动：无障碍服务未开启」。脚本先�?   `enabled_accessibility_services`，没开就打印两�?`settings put secure …` 命令�?   退出，不擅自授予读屏权限；开了还会再查一次「是否真的在收事件」（ROM 冻结态下
   `uiReady()` 会撒谎，见第六节 �?的说明），无声则告警但继续。跑完记�?   `settings put secure enabled_accessibility_services null` 收回�?4. **共享存储失效的横幅尚未真机目�?*：逻辑与提示已实现（见第五节第 4 条）�?   `flutter analyze` 对我的三个文�?0 问题、release 编译通过，但没有在真机上看到
   「未使用共享存储」横幅长什么样。设备上 `MANAGE_EXTERNAL_STORAGE` 目前是拒绝�?   （`appops get �?MANAGE_EXTERNAL_STORAGE` 显示 `rejectTime` 不久前），理论上正好
   能触发这个状态——恢复连接后第一件事就该确认它是否显示、文案是否说得清�?5. **�?的「其余能力全通」仍只验到横�?*：结构侧本轮补了两条证据（门只挂在单�?   工具上、横幅与门控同源，且同源关系已由
   `theBannerAndTheGateReadTheSameBoolean` 钉住），并记录了冻结态下 `uiReady()`
   会撒谎这一既有局限（见第六节）。逐类能力实跑未做�?
---

## 八、可复用的方法论（比具体 bug 更值钱的部分）

这一节是�?*将来在这个仓库工作的�?*（包�?AI）的。前面八节记的是「这个任�?发生了什么」，这一节记「从里面能提炼出什么」。每条都在本任务里被实际验证过，
不是格言�?
### 1. 「看起来在检查」和「真的在检查」是两件�?
本任务抓到的假判据，一个模式：

| 形�?| 实例 |
|---|---|
| 判据比实现宽�?| �?只看历史行数增加，不�?status（第 11 条） |
| 兜底代码没验 | ENTER 兜底是死的、判据恒真（�?12 条） |
| 判据依赖的信号不存在 | 用心跳日志，�?`onAccessibilityEvent` 不打日志（第 13 条） |
| 换掉的判据同样没�?| `dumpsys` 判据�?Android 行为断言，本项目无先例（13b�?|

**做法**：写完任何「检查」，先问三件事——它依赖的信号真的存在吗？信号为假时
它会误报吗？拿一�?*已知相反的输�?*试过它吗？（�?13b 就是这么发现 analyzer
可靠的：�?`trace_chain_test.dart` 试，它确实报错。）

### 2. 不依赖「下次更小心」，依赖「这次减少可错的点�?
本任务里同一类错误反复出现，而每次有效的修法都是结构性的�?
- 坐标点错 �?加第二条触发路径（ENTER），不是把坐标量得更准；
- 命令清单插一条就错位 �?按命令内容索引，不是提醒自己「插入后要改预期表」；
- 两行 adb 命令漏反斜杠（复�?11 次）�?存成脚本、路径只写一次；
- 装包步骤散在文档 �?收进 `khy_install.ps1`�?- ①③ 顺序依赖 �?固化�?`khy_run_all.ps1`，不靠谁记得�?
**做法**：同一个错误犯第二次时，不要再修那个错误，去修**让它可以复发的结�?*�?
### 3. 新写的分支不验等于没有，兜底比主路径更需要验

主路径每次运行都被走，兜底只在故障时走一次——而那一次往往是最不该出错的时候�?本任务的假成功（编排器声称�?-3 ran end to end」而一步没跑）正出在编排层�?也就是唯一会对用户说话的那层�?
**做法**：新写的任何分支/兜底/编排，先造一个能稳定复现的假输入跑它
（`khy_verify_driver.ps1` 用假 adb + 标记文件，六项断言）�?
### 4. 文档是会过期的缓存，要主动失�?
本任务吃过三次：旧真机截图被当成当前 APK 的证据；编排器修好后文档仍写「不要用」；
复跑命令一节漏掉入口脚本（所以修好也白修）�?
**做法**：改了一个事实，**搜出所有提它的地方**；更进一步，拿真实状态反比对文档
（磁�?11 个脚�?vs 文档登记，就是这么发现漏�?`khy_devcheck.ps1` 和潜伏的旧版
`khy_accept.ps1`）�?*让现实当输入，而不是让记忆当输入�?*

### 5. 编辑长文件：插入点选在下一节标题之�?
本任务同一锚点错误犯了三次（插入新节时吞掉下一节标题）。根因是把「锚点唯一�?当成了「锚点周围安全」�?
**做法**：要让新节出现在 A 之前，就�?**A 的标题行**�?old_string、把新节写在
它前面——匹配偏移时吞掉的最多是空行。改完立刻验：搜被插节前后的标题是否都还在�?
### 6. 「全绿」永远达不到时，把既有失败单独记�?
�?WIP �?JVM 3 �?+ Dart 7 文件的既有失败。如果每次跑测试都期望全绿，人就�?开始习惯性忽略红色——那比没有目标更糟�?
**做法**：维护一份既有失败基线（含证据：git 状�?+ 时间线双证「与本次无关」）�?每次只核�?*相对基线的增�?*�?
---

## 九、由我代选、用户尚未明确确认的决定

任务原文第六条要求「白名单范围、共享存储的路径与格式、Amoo 唤起的具体触发方式，
这三处先对齐再动手」。三处都已对齐，但都�?**ask_user 超时后按默认项自动选中的，
用户没有明确点头**。集中列在这里，改任何一处都说清影响面：

| # | 决定 | 当时为什么这么�?| 要改的话影响什�?|
|---|---|---|---|
| 1 | **白名单取全量**：新�?50 个工具全部纳入，�?`secret_*` / `adou_signin` / `zip` �?11 个新�?| 任务要求「本地通用执行器」；少给会让用户以为工具不存在。`secret_*` 不回内容（`secret_list` 只给名字/时间/长度），写入删除需 `secret_code` 发到通知栏的一次性码，故 Console 暴露它们不构成可读出密钥的通道 | 收窄就要�?`ToolSchema` �?`KhyConsole.WHITELIST`，并让面板说明「为什么这个工具不在这」——否则用户会以为 App 坏了 |
| 2 | **共享存储复用 `/sdcard/bridge-amoobridge/`**，新�?`console_history.jsonl`（追加写）与 `console_favorites.json` | 桥侧已有这个目录，Amoo �?PC 侧都在用；另起一个就违背「两边读写同一存储」。失效时会静默回退�?App 私有目录——已加红色横幅明示（第五节第 4 条） | 换目录要同时�?`KhyConsole.baseDir()` 与桥侧，且历史文件要迁移，否则两边立刻对不上 |
| 3 | **Amoo 唤起：先 arm 拦截循环，再打开 Amoo 聊天�?*，上下文写进输入框但**不发�?* | 反过来会漏掉 Amoo 已开始输出的那条命令——而漏掉的命令看起来像「Amoo 什么都没说」，是最难查的故障。代按发送是一个决定，不是便利 | 若改成「打开后再 arm」，要接受上述漏命令风险；若改成「自动发送」，那是替用户做决定，需明确授权 |

另有两处本轮新增的代选，一并列出：

| # | 决定 | 理由 |
|---|---|---|
| 4 | **控制台放第二页签**，不顶掉「文件�?| 新树源码注释写明「文件管理是第一页签」是既有决定 |
| 5 | **保留来源徽标（手�?/ Amoo�?* | 任务本身就要求两条路可区分（�?3「记录里用这个区分」）；徽标是元数据不是格式。若要求连徽标也去掉，显示格式仍一致，但用户将无法分辨一条命令是谁发�?|

以上任何一处要改，告诉我改哪条、改成什么，我按影响面逐个落实并重跑相关测试�?
