<#
.SYNOPSIS
    修复 / 重建 khy-os 仓库根的 7 个受控目录联接（Junction）。

.DESCRIPTION
    这个仓库是便携式（Portable）项目：整个 khy-os 目录可能被从 D 盘复制到 E 盘、
    U 盘，或改变父文件夹名称。而 7 个第三方 AI 工具（Cursor / OpenCode / ZCode /
    WorkBuddy / CodeArts Doer）以及 khyos 自己的轨迹数据家，都硬性要求按**仓库根
    路径**读写自己的配置目录。

    为同时满足「仓库根整洁」与「工具按根路径读写」，数据物理存放在 works/data/ 下，
    再用目录联接把原路径映射回根目录：

        khy-Trajectory -> works/data/khy
        .cursor        -> works/data/cursor
        .opencode      -> works/data/opencode
        .zcode         -> works/data/zcode
        .workbuddy     -> works/data/workbuddy
        .workbuddy-ai  -> works/data/workbuddy-ai
        .codeartsdoer  -> works/data/codeartsdoer

    联接创建时记录的是**绝对路径**。一旦目录被整体移动，这些记录不会自动更新，
    于是全部静默断裂——Explorer 里文件夹图标照旧，点进去才报错。本脚本就是用来
    在任何时候（尤其是移动目录之后）安全地重建它们。

    ★ 安全底线（本脚本的核心设计）：
      1. 目标目录不存在 -> 报错并跳过，绝不凭空创建空数据目录掩盖问题。
      2. 联接位当前是**普通物理文件夹** -> 警告并停止该项，提示人工用 robocopy
         合并。绝不自动删除物理文件夹——那可能装着唯一的数据。
      3. 删除旧联接只用 `cmd /c rmdir`，严禁 `Remove-Item -Recurse`（见下方
         「为什么用 rmdir 而不是 Remove-Item」）。

.PARAMETER ProjectRoot
    显式指定项目根目录。缺省时由脚本自身位置向上查找（见 Get-ProjectRoot）。
    一般不需要传——脚本自己算得出来，而且算得比传参更可靠。

.PARAMETER WhatIf
    模拟运行（dry-run）。只打印"打算做什么"，不执行任何删除与创建。
    **第一次运行、或刚移动完目录后，强烈建议先带这个参数跑一遍**，确认它找到的
    路径符合预期，再去掉参数真正执行。

.EXAMPLE
    .\repair-junctions.ps1 -WhatIf
    演习一遍，只看不动。

.EXAMPLE
    .\repair-junctions.ps1
    真正修复。

.NOTES
    为什么用 rmdir 而不是 Remove-Item -Recurse
    ------------------------------------------
    `cmd /c rmdir <链接>`（不带 /s）对 Junction / 目录符号链接**只移除重解析点
    本身**，不进入目标、不碰目标里的任何文件。这是 Win32 层面对联接的既定语义，
    有契约保证。

    `Remove-Item -Recurse -Force` 在现代 Windows + PowerShell 5.1 上**实测**也
     表现为"只删链接"（本机 2026-11-04 验证：联接指向的 t2\keep.txt 存活）。
     但这是**观察到的行为，不是契约**：
       · .NET Framework 历史上在"目录符号链接 + 递归删除"上出现过跟随目标删除
         的真实缺陷类；不同框架版本、不同链接类型（Junction vs SymbolicLink）、
         目标是否存在，行为都可能不同。
       · 一旦某次跟随了目标，删掉的就是 works/data/khy 下全部会话与轨迹数据，
         且不可恢复。
     用一个"这次没出事"的实现去换"契约上保证不出事"的实现，没有意义。所以本脚本
     只用 rmdir。

    为什么必须动态计算路径
    ----------------------
    脚本里绝不出现 D:\ 、C:\Users\<名>\ 或任何盘符。根目录由脚本自身位置推导
    （PowerShell 的 $PSScriptRoot，相当于批处理的 %~dp0），目标路径一律
    Join-Path $ProjectRoot "works\data\<名>"。这样无论盘符怎么变、父文件夹怎么
     改名，脚本算出来的永远是"它自己所在的那棵树的根"。

    为什么目标是 Join-Path 拼出来的绝对路径
    ------------------------------------
    Junction 在 NTFS 里存的就是绝对路径（不像符号链接可以存相对路径）。所以修复
     时必须写绝对路径，而这个绝对路径必须由 $ProjectRoot 现算，不能从旧联接的
     Target 字段读——那个字段正是坏掉的东西。
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'

# �0────────────────────────────────────────────────────────────────────────────
#   颜色输出助手
# ────────────────────────────────────────────────────────────────────────────
function Write-Ok   ([string]$m) { Write-Host $m -ForegroundColor Green }
function Write-Warn ([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Write-Err  ([string]$m) { Write-Host $m -ForegroundColor Red }
function Write-Step ([string]$m) { Write-Host $m -ForegroundColor Cyan }
function Write-Plain([string]$m) { Write-Host $m }

# ─────────────────────────────────────────────────────────────────────────────
#   1. 联接映射表
#
#   Link : 仓库根下的联接名（就是 Explorer 里看到的那个名字）
#   Sub  : works/data/ 下的物理子目录名
#   Why  : 一句话说明它是什么，仅用于摘要输出，便于人review
#
#   故意把 Link 和 Sub 分成两个字段而不是让它们默认相同：khy-Trajectory 的物理
#   目录叫 khy，两者已经分叉过一次，写成两个字段以后再怎么改都不用动逻辑。
# ─────────────────────────────────────────────────────────────────────────────
$JunctionMap = [ordered]@{
    'khy-Trajectory' = @{ Sub = 'khy';       Why = 'khyos 轨迹/会话数据家（works/data/khy）' }
    '.cursor'        = @{ Sub = 'cursor';    Why = 'Cursor 编辑器配置与状态' }
    '.opencode'      = @{ Sub = 'opencode';  Why = 'OpenCode 配置与状态' }
    '.zcode'         = @{ Sub = 'zcode';     Why = 'ZCode 配置与状态' }
    '.workbuddy'     = @{ Sub = 'workbuddy'; Why = 'WorkBuddy 配置与状态' }
    '.workbuddy-ai'  = @{ Sub = 'workbuddy-ai'; Why = 'WorkBuddy-AI 配置与状态' }
    '.codeartsdoer'  = @{ Sub = 'codeartsdoer'; Why = 'CodeArts Doer 工具状态' }
}

# ─────────────────────────────────────────────────────────────────────────────
#   2. 路径归一化
#
#   联接的 Target 在不同 API 下可能带回车/换行、首尾空格、Win32 设备前缀
#   （\\?\ 或 \??\）。直接字符串比较会把"其实指向正确"误判成"断链"。
# ─────────────────────────────────────────────────────────────────────────────
function Remove-DevicePrefix([string]$p) {
    if ([string]::IsNullOrEmpty($p)) { return '' }
    $s = $p.Trim()
    if ($s.StartsWith('\\?\')) { $s = $s.Substring(4) }
    if ($s.StartsWith('\??\')) { $s = $s.Substring(4) }
    return $s
}

function Get-NormalizedPath([string]$p) {
    $s = Remove-DevicePrefix $p
    if ([string]::IsNullOrEmpty($s)) { return '' }
    try { $s = [System.IO.Path]::GetFullPath($s) } catch { }
    return $s.TrimEnd('\')
}

function Test-SamePath([string]$a, [string]$b) {
    $na = Get-NormalizedPath $a
    $nb = Get-NormalizedPath $b
    if ([string]::IsNullOrEmpty($na) -or [string]::IsNullOrEmpty($nb)) { return $false }
    # Windows 路径不区分大小写，用 OrdinalIgnoreCase；用 -eq 也行但语义不显式
    return [string]::Equals($na, $nb, [StringComparison]::OrdinalIgnoreCase)
}

# ─────────────────────────────────────────────────────────────────────────────
#   3. 定位项目根目录
#
#   优先级：命令行 -ProjectRoot > 从 $PSScriptRoot 向上找标记。
#
#   标记是两个同时成立的条件：
#     · .portable 文件存在（khy-os 便携安装的官方标记，文件里写明"Do not delete"）
#     · works/data 目录存在（联接目标的父目录）
#   两个都查是为了避免在错误的树上瞎猜——只认其中一个可能匹配到无关目录。
#
#   为什么不直接写 "根就是 $PSScriptRoot"：本脚本放在 scripts/portable/ 下，
#   比根深两级。用标记向上查找意味着脚本在树内任何位置都能正确定位，且是
#   **自我验证**的，不是靠"我以为我在第几层"。
# ─────────────────────────────────────────────────────────────────────────────
function Get-ProjectRoot([string]$explicit) {
    if (-not [string]::IsNullOrWhiteSpace($explicit)) {
        $r = Get-NormalizedPath $explicit
        if (-not [System.IO.Directory]::Exists($r)) {
            throw ("显式指定的 -ProjectRoot 不存在：{0}" -f $explicit)
        }
        return $r
    }

    $here = $PSScriptRoot
    if ([string]::IsNullOrEmpty($here)) {
        throw '无法确定脚本自身位置（$PSScriptRoot 为空）。请显式传 -ProjectRoot。'
    }

    $dir = Get-NormalizedPath $here
    for ($i = 0; $i -lt 6; $i++) {
        $marker = Join-Path $dir '.portable'
        $dataDir = Join-Path $dir 'works\data'
        if ((Test-Path -LiteralPath $marker -PathType Leaf) -and
            (Test-Path -LiteralPath $dataDir -PathType Container)) {
            return $dir
        }
        $parent = Split-Path -Parent $dir
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $dir) { break }
        $dir = $parent
    }

    throw @'
未能从脚本位置向上找到 khy-os 项目根。

判定条件（两者需同时成立）：
  · <候选根>\.portable      文件存在
  · <候选根>\works\data     目录存在

排查方向：
  · 脚本是否被单独拷出了仓库？本脚本必须在 khy-os 仓库内运行。
  · 仓库是否不完整（缺 .portable 标记或 works/data 目录）？
  · 确认无误可用 -ProjectRoot <路径> 显式指定根目录。
'@
}

# ─────────────────────────────────────────────────────────────────────────────
#   4. 读取联接位当前状态
#
#   ★ 这里刻意不用 Test-Path 判断"联接在不在"。
#     Test-Path 对断链的行为在本机实测为 True（PS 5.1.26100），但这不是可以依赖
#     的契约——不同版本可能返回 False。用"枚举父目录 + 读条目自身属性"才是可靠
#     的：Get-ChildItem 列出父目录时不会跟随重解析点，所以断链也能被看见，
#     且能同时拿到 IsReparse / LinkType / Target 三样东西。
# ─────────────────────────────────────────────────────────────────────────────
function Get-LinkEntry([string]$root, [string]$linkName) {
    $hit = Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -eq $linkName }
    if (-not $hit) { return $null }
    return $hit
}

# ─────────────────────────────────────────────────────────────────────────────
#   5. 主流程
# ─────────────────────────────────────────────────────────────────────────────
$results = New-Object System.Collections.ArrayList
$exitCode = 0

function Add-Result([string]$link, [string]$status, [string]$detail) {
    [void]$results.Add([pscustomobject]@{
        联接   = $link
        状态   = $status
        说明   = $detail
    })
}

try {
    $root = Get-ProjectRoot $ProjectRoot
} catch {
    Write-Err ('[错误] ' + $_.Exception.Message)
    exit 1
}

Write-Step ('项目根目录 : ' + $root)
Write-Step ('联接数量   : ' + $JunctionMap.Count)
if ($WhatIf) { Write-Warn '*** DRY-RUN（-WhatIf）：只打印计划，不执行任何删除/创建 ***' }
Write-Plain ''

foreach ($linkName in $JunctionMap.Keys) {
    $sub      = $JunctionMap[$linkName].Sub
    $why      = $JunctionMap[$linkName].Why
    $linkPath = Join-Path $root $linkName
    $wantTgt  = Join-Path $root ('works\data\' + $sub)
    $wantTgt  = Get-NormalizedPath $wantTgt

    Write-Step ('── ' + $linkName + '  ->  works\data\' + $sub)

    # 步骤 A：目标必须真的存在。不存在就报错跳过，绝不创建空目录。
    if (-not [System.IO.Directory]::Exists($wantTgt)) {
        Write-Err ('    [错误] 目标目录不存在：' + $wantTgt)
        Write-Err ('            不创建空目录——那会把"数据丢了"伪装成"修好了"。')
        Write-Err ('            请先确认 works\data\' + $sub + ' 是否被误删或未迁移。')
        Add-Result $linkName '目标缺失' $wantTgt
        $script:exitCode = 1
        Write-Plain ''
        continue
    }

    # 步骤 B：判断联接位当前状态
    $entry = Get-LinkEntry $root $linkName

    if ($null -eq $entry) {
        # 情况 1：不存在 -> 直接创建
        Write-Warn '    [缺失] 联接不存在，准备创建。'
        if ($PSCmdlet.ShouldProcess($linkPath, ('创建 Junction -> ' + $wantTgt))) {
            try {
                $created = New-Item -ItemType Junction -Path $linkPath -Target $wantTgt -ErrorAction Stop
                $verify  = Get-LinkEntry $root $linkName
                $vTgt    = if ($verify) { Remove-DevicePrefix (($verify.Target -join ';')) } else { '' }
                if ($verify -and (Test-SamePath $vTgt $wantTgt)) {
                    Write-Ok ('    [已创建] ' + $created.FullName + ' -> ' + $wantTgt)
                    Add-Result $linkName '已创建' $wantTgt
                } else {
                    throw ('创建后校验失败：读回 Target="' + $vTgt + '"，期望="' + $wantTgt + '"')
                }
            } catch {
                Write-Err ('    [错误] 创建失败：' + $_.Exception.Message)
                Add-Result $linkName '创建失败' $_.Exception.Message
                $script:exitCode = 1
            }
        } else {
            Write-Warn ('    [dry-run] 将创建：' + $linkPath + '  ->  ' + $wantTgt)
            Add-Result $linkName '待创建(dry-run)' $wantTgt
        }
        Write-Plain ''
        continue
    }

    $isReparse = [bool]($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    $linkType  = $entry.LinkType
    $curTgt    = Remove-DevicePrefix (($entry.Target -join ';'))

    if (-not $isReparse) {
        # 情况 2：是普通物理文件夹 -> 停下，交人工处理
        Write-Err  ('    [需人工] 这个位置现在是普通物理文件夹，不是联接！')
        Write-Err  ('              路径：' + $linkPath)
        Write-Warn ('              这通常意味着里面有未迁移的真实数据。')
        Write-Warn ('              本脚本绝不自动删除物理文件夹。请人工核对内容后二选一：')
        Write-Warn ('                ① 数据要保留 -> 用 robocopy 合并进目标，再删掉这个物理目录：')
        Write-Warn ('                     robocopy "' + $linkPath + '" "' + $wantTgt + '" /E /XO')
        Write-Warn ('                   （/XO 表示目标已存在且较新的文件不覆盖，先拷贝后核对更稳）')
        Write-Warn ('                ② 确认是空壳或废弃 -> 手工 rmdir "' + $linkPath + '" 后重跑本脚本')
        Write-Warn ('              处理完再跑一次本脚本即可自动补上联接。')
        Add-Result $linkName '需人工(物理文件夹)' $linkPath
        $script:exitCode = 1
        Write-Plain ''
        continue
    }

    if ($linkType -ne 'Junction' -and $linkType -ne 'SymbolicLink') {
        Write-Err ('    [需人工] 是重解析点但类型异常：LinkType="' + $linkType + '"')
        Add-Result $linkName '需人工(异常链接类型)' $linkType
        $script:exitCode = 1
        Write-Plain ''
        continue
    }

    if (Test-SamePath $curTgt $wantTgt) {
        # 情况 3：指向正确
        Write-Ok ('    [良好] ' + $linkType + ' -> ' + $curTgt)
        Add-Result $linkName '良好' $curTgt
        Write-Plain ''
        continue
    }

    # 情况 4：是联接但指错了（断链 / 指向旧盘符） -> 修复
    Write-Warn ('    [断链] 当前指向：' + $curTgt)
    Write-Warn ('            应为    ：' + $wantTgt)
    Write-Warn '            进入修复流程。'

    if ($PSCmdlet.ShouldProcess($linkPath, ('删除旧联接并重建 -> ' + $wantTgt))) {
        $repaired = $false
        try {
            # 只用 rmdir 删链接。绝不用 Remove-Item -Recurse（见文件头注释）。
            $rmOut = cmd /c rmdir "$linkPath" 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw ('rmdir 退出码 ' + $LASTEXITCODE + '：' + ($rmOut -join ' '))
            }
            # 删完必须确认联接位真的没了，否则 New-Item 会在已存在的路径上行为不定
            $stillThere = Get-LinkEntry $root $linkName
            if ($null -ne $stillThere) { throw 'rmdir 报告成功但联接仍然存在，已中止（未删除任何数据）' }

            $created = New-Item -ItemType Junction -Path $linkPath -Target $wantTgt -ErrorAction Stop
            $verify  = Get-LinkEntry $root $linkName
            $vTgt    = if ($verify) { Remove-DevicePrefix (($verify.Target -join ';')) } else { '' }
            if ($verify -and (Test-SamePath $vTgt $wantTgt)) {
                Write-Ok ('    [已修复] -> ' + $wantTgt)
                Add-Result $linkName '已修复' $wantTgt
                $repaired = $true
            } else {
                throw ('重建后校验失败：读回 Target="' + $vTgt + '"')
            }
        } catch {
            Write-Err ('    [错误] 修复失败：' + $_.Exception.Message)
            Write-Warn ('            联接当前状态：' + $(if ($null -eq (Get-LinkEntry $root $linkName)) { '已不存在' } else { '仍存在' }))
            Add-Result $linkName '修复失败' $_.Exception.Message
            $script:exitCode = 1
        }
    } else {
        Write-Warn ('    [dry-run] 将执行：rmdir "' + $linkPath + '" 然后重建为 -> ' + $wantTgt)
        Add-Result $linkName '待修复(dry-run)' $wantTgt
    }
    Write-Plain ''
}

# ─────────────────────────────────────────────────────────────────────────────
#   6. 摘要
# ─────────────────────────────────────────────────────────────────────────────
Write-Step '══════════════ 摘要 ══════════════'

$good     = @($results | Where-Object { $_.状态 -eq '良好' }).Count
$created  = @($results | Where-Object { $_.状态 -in @('已创建') }).Count
$repaired = @($results | Where-Object { $_.状态 -in @('已修复') }).Count
$dry      = @($results | Where-Object { $_.状态 -like '*dry-run*' }).Count
$bad      = @($results | Where-Object { $_.状态 -like '*需人工*' -or $_.状态 -like '*失败' -or $_.状态 -eq '目标缺失' }).Count

$results | ForEach-Object {
    $c = 'Green'
    if ($_.状态 -like '*需人工*' -or $_.状态 -like '*失败*' -or $_.状态 -eq '目标缺失') { $c = 'Red' }
    elseif ($_.状态 -like '*dry-run*') { $c = 'Yellow' }
    elseif ($_.状态 -in @('已创建','已修复')) { $c = 'Cyan' }
    Write-Host ('  {0,-22} {1,-20} {2}' -f $_.联接, $_.状态, $_.说明) -ForegroundColor $c
}

Write-Plain ''
Write-Plain ('  合计 {0} 项：良好 {1} · 已创建 {2} · 已修复 {3} · 待处理(dry-run) {4} · 需人工/失败 {5}' -f `
    $results.Count, $good, $created, $repaired, $dry, $bad)

if ($WhatIf) {
    Write-Plain ''
    Write-Warn '  以上为 DRY-RUN 结果，未做任何改动。确认无误后去掉 -WhatIf 重跑。'
}

if ($bad -gt 0) {
    Write-Plain ''
    Write-Warn '  有需要人工处理的项。请按上面各项的提示操作后重跑本脚本。'
    Write-Warn '  提醒：移动整个仓库后，若某些工具仍在运行，可能仍持有旧路径的目录句柄；'
    Write-Warn '        建议先关掉相关工具再跑本脚本。'
}

Write-Plain ''
if ($exitCode -eq 0) { Write-Ok '结果：全部正常。' } else { Write-Err '结果：有未解决项，请处理。' }

exit $exitCode
