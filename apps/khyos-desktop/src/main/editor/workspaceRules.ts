import path from 'node:path'

// 文件树 / 文件索引 / 全局搜索共用的忽略目录与可索引扩展名。
// 此前 workspace:listFiles 与 workspace:readTree 各有一份 SKIP_DIRS 副本；
// 搜索再写第三份，就会出现「文件树里看不到、搜索却能搜到」的不一致。

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.khy', 'coverage', '.next', '.turbo',
])

/** 文件索引上限（workspace:listFiles 与全局搜索的枚举阶段共用）。 */
export const MAX_INDEX_FILES = 5000
export const MAX_INDEX_DEPTH = 8

/** 参与全局搜索的文件扩展名（.env / .gitignore 这类无扩展名文件不进索引）。 */
export const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte',
  '.css', '.scss', '.less',
  '.html', '.htm', '.xml', '.svg',
  '.yml', '.yaml', '.toml', '.ini', '.env',
  '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1',
  '.py', '.rb', '.php', '.lua', '.go', '.rs', '.java', '.kt', '.swift', '.dart',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.sql', '.gradle',
])

export function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name.toLowerCase())
}

export function isTextFileName(name: string): boolean {
  return TEXT_EXTS.has(path.extname(name).toLowerCase())
}

/** 路径是否落在白名单根之内（含根本身）。roots 由主进程按设置动态解析。 */
export function isInsideAnyRoot(resolved: string, roots: Iterable<string>): boolean {
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true
  }
  return false
}
