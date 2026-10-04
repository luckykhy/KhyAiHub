// 侧栏「项目」分组的判定层（[DESIGN-ARCH-177] §3.2）—— 纯函数，零 IO、零 env。
//
// 为什么有这一层：侧栏项目 tab 原先直接拿 workspacePath 的路径末段当项目名
// （旧 WorkspaceSidebar.tsx 内联 baseName），而 workspacePath 记录的是
// 「会话当时的工作目录」，不是用户登记的「项目」。二者混用导致三类可辨识性崩塌：
//   ① 父目录冒充项目（D:\Portable → 显示 "Portable"）
//   ② 临时目录冒充项目（khy-durable-transcript-* 各占一行）
//   ③ 同名项目无法区分（两条不同路径末段都叫 backend）
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
 * ⚠ 必须锚定到确切前缀常量，**不得**泛化成「名字里有随机串就过滤」——
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

/**
 * 三态判定。`registrations` 为可选参数 —— 缺省（undefined）时全部路径走
 * inferred/transient 分支，行为与旧版一致，这是本层的回滚能力。
 */
export function classifyWorkspacePath(
  path: string,
  registrations?: readonly ProjectRegistration[],
): ProjectClassification {
  if (!path) {
    return { bucket: 'inferred', name: '未归属项目', inferred: true }
  }
  const hit = registrations?.find((r) => r.path === path)
  if (hit) {
    return {
      bucket: 'registered',
      name: hit.name || baseName(path),
      icon: hit.icon,
      color: hit.color,
      inferred: false,
    }
  }
  if (isTransientPath(path)) {
    // 临时目录不进项目层级；name 留空，调用方归入「未归属」分组。
    return { bucket: 'transient', name: '', inferred: false }
  }
  return { bucket: 'inferred', name: baseName(path), inferred: true }
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
