// khy-canary: Khy-20261102-342-11MRNM3C
// 侧栏「项目」分组的判定层（[DESIGN-ARCH-177] §3.2）—— 纯函数，零 IO、零 env。
//
// 为什么有这一层：侧栏项目 tab 原先直接拿 workspacePath 的路径末段当项目名
// （旧 WorkspaceSidebar.tsx 内联 baseName），而 workspacePath 记录的是
// 「会话当时的工作目录」，不是用户登记的「项目」。二者混用导致三类可辨识性崩塌：
//   ① 父目录冒充项目（D:\Portable → 显示 "Portable"）
//   ② 临时目录冒充项目（khy-durable-transcript-* 各占一行）
//   ③ 同名项目无法区分（两条不同路径末段都叫 backend）
//
// 2026-10-20 补第 ④ 类：**同一项目的不同子目录被拆成多个项目**。cwd 是「会话
// 当时的工作目录」，它可以是项目里的任意一层（runtime/node/backend），也可以
// 是项目根的父目录（D:\Portable）。所以分桶键不能是 cwd 本身，必须是
// 「cwd 所属的项目根」—— 登记项 path 即项目根，cwd 落在它下面（含相等）就归入。
// 语义见 findProjectRoot()：最长前缀胜出，段边界匹配。
//
// 本模块**不读写任何状态**，「登记」信息由调用方以参数传入（可选参数即回滚
// 能力：不传时行为与旧版逐项相同）。删除本模块即回到旧行为。

// ── 项目登记（对应 settingsStore.desktopProjects） ─────────────────

/** 登记项里允许的图标名。留空 = 不渲染图标（不给假数据）。 */
export type ProjectIconName =
  | 'new-task' | 'search' | 'automation' | 'plugins'
  | 'remote-mobile' | 'settings' | 'report' | 'bug'
  | 'ppt' | 'review' | 'doc' | 'idle'

/**
 * 登记可选的颜色键。刻意**不含**任何映射到 --color-brand 的键：
 * 品牌色在浅色主题下是 #000000、深色下是 #ffffff（globals.css:189 / :96），
 * 主题一切换全部项目同色 ⇒ 区分功能归零。这里只列有独立身份的语义色。
 */
export type ProjectColorKey =
  | 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'teal'

/** 单条项目登记。path 是分桶键（精确匹配，非前缀）。 */
export interface ProjectRegistration {
  path: string
  name: string
  icon?: ProjectIconName
  color?: ProjectColorKey
}

// ── 临时目录前缀表（方案 §8 待核实项 #2 的落点） ──────────────────

/**
 * 仓外流程产生的临时目录前缀。Grep 实测：这些字符串在
 * apps/khyos-desktop/src 与 services/backend/src 下**零命中** ⇒ 由仓外写入，
 * 仓内没有「谁负责清」的依据，只能在展示层归类。
 *
 * 注意：必须锚定到确切前缀常量，**不得**泛化成「名字里有随机串就过滤」——
 * 那会误杀 `khy-agents-v2` 这类真项目。新增条目时同步更新
 * tests/sidebarProjectClassify.test.cjs 的钉住用例。
 */
export const TRANSIENT_PREFIXES = [
  'khy-durable-transcript-',
] as const

/** 判定结果三态。 */
export type ProjectBucket = 'registered' | 'transient' | 'inferred'

export interface ProjectClassification {
  bucket: ProjectBucket
  /** 显示名：registered 取登记名，inferred 取路径末段，transient 为空（归入未归属）。 */
  name: string
  icon?: ProjectIconName
  color?: ProjectColorKey
  /** inferred 态才为 true —— UI 据此弱化样式并显示路径副行。 */
  inferred: boolean
  /**
   * 分桶键。registered 时是**登记的项目根**（不是 cwd 本身），调用方用它合并
   * 同一项目下不同子目录的会话；其余态等于传入的 path。
   * 注意：不拿它当显示名 —— 显示名只有 name 一个来源。
   */
  rootPath: string
}

/** 路径末段。空串与纯分隔符原样返回（不做假数据兜底）。 */
export function baseName(p: string): string {
  const seg = p.split(/[\\/]/).filter(Boolean)
  return seg.length ? seg[seg.length - 1] : p
}

/** 是否为仓外临时目录。只认**锚定前缀**，不认通用随机串形状。 */
export function isTransientPath(path: string): boolean {
  const name = baseName(path)
  return TRANSIENT_PREFIXES.some((prefix) => name.startsWith(prefix))
}

// ── 路径比较（项目根前缀匹配的地基） ─────────────────────────────

/** 统一分隔符 + 去掉尾部与重复分隔符。不做大小写折叠（见 compareKey）。 */
function normalizePath(p: string): string {
  const s = p.replace(/[\\/]+/g, '/')
  return s.length > 1 ? s.replace(/\/+$/, '') : s
}

/**
 * 比较键。Windows 盘符路径与 UNC 路径大小写不敏感（`d:\portable` 与
 * `D:\Portable` 是同一个文件夹）；POSIX 路径大小写敏感，保持原样。
 */
function compareKey(p: string): string {
  const n = normalizePath(p)
  const windowsish = /^[A-Za-z]:/.test(n) || n.startsWith('//')
  return windowsish ? n.toLowerCase() : n
}

/**
 * child 是否等于 root 或位于 root 之下。
 *
 * 注意：必须按**段边界**判定：`D:\a\bc` 不在 `D:\a\b` 之下。用裸 startsWith
 * 会把同级同前缀的兄弟目录吸进项目，是这类归并最典型的误伤。
 */
export function isUnderPath(child: string, root: string): boolean {
  if (!child || !root) return false
  const c = compareKey(child)
  const r = compareKey(root)
  if (c === r) return true
  return c.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/**
 * 一条 cwd 属于哪个登记项目：**最长前缀**胜出（同时登记 `D:\a` 与
 * `D:\a\b` 时，`D:\a\b\c` 归后者 —— 更具体的登记更接近用户意图）。
 * 未命中返回 undefined，调用方保持旧行为（按精确路径分桶）。
 */
export function findProjectRoot(
  path: string,
  registrations?: readonly ProjectRegistration[],
): ProjectRegistration | undefined {
  if (!path || !registrations?.length) return undefined
  let best: ProjectRegistration | undefined
  let bestLen = -1
  for (const reg of registrations) {
    if (!reg.path || !isUnderPath(path, reg.path)) continue
    const len = compareKey(reg.path).length
    if (len > bestLen) {
      best = reg
      bestLen = len
    }
  }
  return best
}

/** 上一级目录。已到根时原样返回（不让 `D:\` 上溯成 `D:`）。 */
export function parentPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  if (!trimmed) return p
  const sep = trimmed.includes('\\') ? '\\' : '/'
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (i < 0) return p
  const parent = trimmed.slice(0, i)
  if (!parent) return p // POSIX 根 `/`
  // 盘符根 `D:` 单独成段没有目录语义，补回分隔符
  return /^[A-Za-z]:$/.test(parent) ? parent + sep : parent
}

/** 判定层的可选外部事实。缺省时行为与只传 registrations 时逐项相同。 */
export interface ClassifyOptions {
  /**
   * 系统临时目录根（由 main 侧 `os.tmpdir()` 提供）。位于其下的路径一律
   * 视为 transient —— 临时目录不是项目文件夹。
   *
   * 这是**环境事实**，不是「目录名里有随机串」那种形状启发（177 §6 反模式）。
   * 与 `TRANSIENT_PREFIXES` 并列而非替代：前者按位置判，后者按锚定名字判。
   */
  transientRoots?: readonly string[]
}

function isUnderAnyRoot(path: string, roots?: readonly string[]): boolean {
  if (!path || !roots?.length) return false
  return roots.some((root) => !!root && isUnderPath(path, root))
}

/**
 * 三态判定。`registrations` 与 `options` 都是可选参数 —— 缺省时全部路径走
 * inferred/transient 分支，行为与旧版一致，这是本层的回滚能力。
 *
 * 判定顺序：**已登记 > 临时（锚定前缀 / 系统临时目录）> 推测**。
 * 登记排第一是因为项目是用户意图：用户明确把 Temp 下某个目录登记成项目时，
 * 尊重登记，不由位置事实推翻。
 */
export function classifyWorkspacePath(
  path: string,
  registrations?: readonly ProjectRegistration[],
  options?: ClassifyOptions,
): ProjectClassification {
  if (!path) {
    return { bucket: 'inferred', name: '未归属项目', inferred: true, rootPath: '' }
  }
  const hit = findProjectRoot(path, registrations)
  if (hit) {
    return {
      bucket: 'registered',
      name: hit.name || baseName(hit.path),
      icon: hit.icon,
      color: hit.color,
      inferred: false,
      // 分桶键是登记的项目根，不是 cwd —— 子目录会话因此并进同一个项目
      rootPath: hit.path,
    }
  }
  if (isTransientPath(path) || isUnderAnyRoot(path, options?.transientRoots)) {
    // 临时目录不进项目层级；name 留空，调用方归入「未归属」分组。
    return { bucket: 'transient', name: '', inferred: false, rootPath: path }
  }
  return { bucket: 'inferred', name: baseName(path), inferred: true, rootPath: path }
}

/**
 * 稳定色键分配：未登记项目按路径散列取一个颜色键。
 *
 * 用途是**给「推测项目名」一个可辨识的色条**（让弱化行仍能一眼分开），
 * 不是身份标识 —— 身份只能由登记产生。散列保证同一路径每次渲染颜色一致
 * （不引入随机，刷新不跳色）。
 */
export function inferredColorKey(path: string): ProjectColorKey {
  const KEYS: ProjectColorKey[] = ['green', 'blue', 'amber', 'red', 'purple', 'teal']
  let h = 0
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0
  return KEYS[h % KEYS.length]
}
