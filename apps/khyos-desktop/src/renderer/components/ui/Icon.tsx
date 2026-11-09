// khy-canary: Khy-20261102-323-9XAT3F4T
// 全局图标注册表 —— 桌面端 UI 图标从这一处出口（侧栏导航、账户区、首页快捷卡片、
// 侧边面板磁贴、命令面板、Git 面板空态、窗口标题栏按钮）。
//
// 本套字形是 2026-10-02 用户点名重做的，**有意偏离 ZCode 1:1 复刻**（CLAUDE.md 的
// 复刻口径管布局/结构/交互，美术资产本就要求自研）：原版「设置」与「自动化」
// 同为圆+射线，14px 下无法区分，故整组换形。
//
// 底稿取自仓内既有依赖 lucide-react（ISC；smartphone/search 衍生自 Feather Icons，MIT）。
// 两枚定制字形（automation / remote-mobile）在 lucide 24 网格上缩放叠加元素。
//
// 描边统一 1.6：lucide 默认 2 在 14–15px 下发糊，原手绘件的 1.2 又太细。
// 颜色一律 currentColor，深浅主题随文字色自动走。
import type { ReactNode } from 'react'
import {
  ArrowUp,
  Bug,
  ChartColumn,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CircleX,
  Clock,
  CodeXml,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  File,
  FileArchive,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe,
  GripVertical,
  Image as ImageIcon,
  Info,
  Key,
  ListFilter,
  Menu,
  MessageSquare,
  MessageSquarePlus,
  Minus,
  Moon,
  MoonStar,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  Presentation,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  SendHorizontal,
  Settings,
  Square,
  SquarePen,
  Sun,
  Terminal,
  Trash,
  TriangleAlert,
  Upload,
  User,
  X,
} from 'lucide-react'

const STROKE = 1.6

export type IconName =
  // 侧栏顶部导航
  | 'new-task'
  | 'search'
  | 'automation'
  | 'plugins'
  // 账户区
  | 'remote-mobile'
  | 'settings'
  // 首页快捷卡片
  | 'report'
  | 'bug'
  | 'ppt'
  | 'review'
  | 'doc'
  | 'idle'
  // 侧边面板磁贴 / 命令面板（同一张注册表：磁贴与命令不再用系统字体字形，
  // 那些字符取自 Dingbats/几何区，字重与基线在 12–20px 下彼此不同）
  | 'chat'
  | 'chat-new'
  | 'terminal'
  | 'browser'
  | 'open-file'
  | 'folder'
  | 'git-branch'
  | 'reload'
  | 'side-pane'
  | 'file'
  | 'theme-dark'
  | 'theme-light'
  // 左侧栏折叠开关（与 side-pane 的右面板字形成对，同为 lucide Panel 系列）
  | 'panel-left'
  // 空态 / 状态字形（此前由系统字体里的告警/对勾/叉号等字符承担）
  | 'warning'
  | 'check'
  | 'error'
  // 通用操作字形：此前这些位置用 Unicode 装饰字符（三角形、箭头、加号…），
  // 字重与基线在 12–20px 下和线形图标对不齐，统一收进本注册表
  | 'info'
  | 'plus'
  | 'close'
  | 'copy'
  | 'send'
  | 'stop'
  | 'rotate-ccw'
  | 'arrow-up'
  | 'clock'
  | 'grip'
  | 'image'
  | 'code'
  // 内置代码编辑器工具栏（查看面板编辑态）：保存 / 运行。ZCode 无此能力，
  // 这两个动作此前不存在于注册表，按「全应用一处图标出口」的约定补入。
  | 'save'
  | 'play'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-up'
  // 补充字形：溢出菜单、窗口菜单、附件区、账户区会用到的常用动作。
  // 集中在这张注册表里是刻意的 —— 全应用只有这一处图标出口，各区域不再自带字形。
  | 'more-horizontal'
  | 'external-link'
  | 'menu'
  | 'trash'
  | 'download'
  | 'upload'
  | 'key'
  | 'user'
  | 'filter'
  // 窗口标题栏按钮（系统语义控件）：三者形态各自不同 —— 最小化是一条横线、
  // 最大化是一个方框、关闭是一个叉 —— 但描边与其余图标同为 1.6，不另立例外。
  | 'minimize'
  | 'maximize'
  // 文件类型字形（输入区附件 chip 与 @ 上下文列表共用）：图片 / PDF / Word /
  // 表格 / 演示 / 视频 / 音频 / 压缩包 / 纯文本 / 代码 / 兜底文件。
  // 前四个里 pdf 与 word 是自绘（lucide 只给了「文件+横线」的通用文档形，
  // 与 txt 撞形），其余直接取 lucide 的 File* 系列。
  | 'file-pdf'
  | 'file-word'
  | 'file-sheet'
  | 'file-slide'
  | 'file-video'
  | 'file-audio'
  | 'file-archive'
  | 'file-text'
  | 'file-markdown'

interface IconProps {
  name: IconName
  size?: number
  className?: string
}

// 自动化 = 闪电 + 留缺口圆环。环口在右上（缺口暗示"循环触发"，也避免与
// lucide 齿轮的封闭轮廓撞形）；闪电按 s 缩进环内，描边除以 s 补偿回 1.6。
function AutomationGlyph({ size, className }: { size: number; className?: string }) {
  const s = 0.64
  const off = (24 - 24 * s) / 2
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M13.8 1.7A10.5 10.5 0 1 0 21.9 8.4" />
      <g transform={`translate(${off} ${off}) scale(${s})`} strokeWidth={STROKE / s}>
        <path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z" />
      </g>
    </svg>
  )
}

// 移动端远程 = 手机机身（lucide Smartphone 比例，缩至左侧）+ 右上两道无线波纹。
// 原 6×11 小矩形在 14px 下读不出手机，波纹补的是"远程"这层语义。
function RemoteMobileGlyph({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="4.1" y="3.4" width="10.1" height="14.4" rx="1.4" />
      <path d="M9.1 15h.01" />
      <path d="M17.7 7A2.5 2.5 0 0 0 15.2 4.5" />
      <path d="M20.2 7A5 5 0 0 0 15.2 2" />
    </svg>
  )
}

// 窗口最大化 = 内缩方框（Windows 标题栏语义，与最小化的横线、关闭的叉同族）。
// 没有直接复用 lucide Square：那份已被 'stop'（停止按钮）占用，且 Square 是
// 18×18 的满格方框，落在 12px 的标题栏按钮上偏大；这里同样按 24 网格自绘，
// 描边与其他字形一致取 STROKE(1.6)。
function MaximizeGlyph({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  )
}

// 文件外壳（lucide File 的同一份轮廓）。PDF / Word / Markdown 三个字形共用它，
// 只在内部内容上分道 —— 各写一份轮廓的话，lucide 升级时三份会各自漂移。
function FileShell({ size, className, children }: { size: number; className?: string; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      {children}
    </svg>
  )
}

// 文件 + 内部字母，用于 PDF / Word 这类「lucide 没有专属字形、又必须与通用
// 文档形（三横线）区分开」的格式。字母占满文件内部，14px 下仍读得出。
const FILE_LETTERS = {
  P: 'M9.5 18.5v-8h3.2a2.4 2.4 0 0 1 0 4.8H9.5',
  W: 'M8.5 12.5l1.5 6 2-4.2 2 4.2 1.5-6',
}

function LetterFileGlyph({ size, className, letter }: { size: number; className?: string; letter: 'P' | 'W' }) {
  return (
    <FileShell size={size} className={className}>
      <path d={FILE_LETTERS[letter]} />
    </FileShell>
  )
}

// Markdown = 文件 + M + 向下箭头（Markdown 的标志性 M↓，比单字母 M 更不容易
// 和 Word 的 W 混 —— 两者方向相反，14px 下方向是最后还能分辨的东西）。
function MarkdownGlyph({ size, className }: { size: number; className?: string }) {
  return (
    <FileShell size={size} className={className}>
      <path d="M7 18.5v-6l2.3 3.2 2.3-3.2v6" />
      <path d="M17 12.5v6" />
      <path d="m15.2 16.7 1.8 1.8 1.8-1.8" />
    </FileShell>
  )
}

export function Icon({ name, size = 15, className }: IconProps) {
  switch (name) {
    case 'new-task':
      return <SquarePen size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'search':
      return <Search size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'automation':
      return <AutomationGlyph size={size} className={className} />
    case 'plugins':
      return <Puzzle size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'remote-mobile':
      return <RemoteMobileGlyph size={size} className={className} />
    case 'settings':
      return <Settings size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'report':
      return <ChartColumn size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'bug':
      return <Bug size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'ppt':
      return <Presentation size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'review':
      return <CodeXml size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'doc':
      return <FileText size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'idle':
      return <MoonStar size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'chat':
      return <MessageSquare size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'chat-new':
      return <MessageSquarePlus size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'terminal':
      return <Terminal size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'browser':
      return <Globe size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'open-file':
      return <FolderOpen size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'folder':
      return <FolderTree size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'git-branch':
      return <GitBranch size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'reload':
      return <RefreshCw size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'side-pane':
      return <PanelRight size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'panel-left':
      return <PanelLeft size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'file':
      return <File size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'theme-dark':
      return <Moon size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'theme-light':
      return <Sun size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'warning':
      return <TriangleAlert size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'check':
      return <CircleCheck size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'error':
      return <CircleX size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'info':
      return <Info size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'plus':
      return <Plus size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'close':
      return <X size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'copy':
      return <Copy size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'send':
      return <SendHorizontal size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'stop':
      return <Square size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'rotate-ccw':
      return <RotateCcw size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'arrow-up':
      return <ArrowUp size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'clock':
      return <Clock size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'grip':
      return <GripVertical size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'image':
      return <ImageIcon size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'code':
      return <CodeXml size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'save':
      return <Save size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'play':
      return <Play size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'chevron-right':
      return <ChevronRight size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'chevron-down':
      return <ChevronDown size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'chevron-left':
      return <ChevronLeft size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'chevron-up':
      return <ChevronUp size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'more-horizontal':
      return <Ellipsis size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'external-link':
      return <ExternalLink size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'menu':
      return <Menu size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'trash':
      return <Trash size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'download':
      return <Download size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'upload':
      return <Upload size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'key':
      return <Key size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'user':
      return <User size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'filter':
      return <ListFilter size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    // 窗口标题栏按钮：形态保留（横线 / 方框），描边与其余图标同为 1.6。
    case 'minimize':
      return <Minus size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'maximize':
      return <MaximizeGlyph size={size} className={className} />
    // 文件类型字形：附件 chip 与 @ 上下文列表都从这里取，格式一多也不散在组件里。
    case 'file-pdf':
      return <LetterFileGlyph size={size} className={className} letter="P" />
    case 'file-word':
      return <LetterFileGlyph size={size} className={className} letter="W" />
    case 'file-sheet':
      return <FileSpreadsheet size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'file-slide':
      return <Presentation size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'file-video':
      return <FileVideo size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'file-audio':
      // FileMusic（文件 + 音符）而不是 FileAudio —— 后者在当前 lucide 里是
      // 文件 + 耳机，14px 下读不出「音频文件」。
      return <FileMusic size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'file-archive':
      return <FileArchive size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'file-text':
      return <FileText size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'file-markdown':
      return <MarkdownGlyph size={size} className={className} />
  }
}
