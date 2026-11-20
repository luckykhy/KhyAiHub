// 扩展名 → Monaco 语言 id / 可运行解释器。
//
// 原先内联在 viewer/CodeEditorPane.tsx 里；工作台（editor/）与侧栏编辑态现在
// 共用同一份表 —— 两处各写一份，早晚会出现「侧栏高亮 TS、工作台是纯文本」。

// 可运行扩展名 → 解释器命令（复用 pty 通道，路径由调用方加引号）
export const RUNNERS: Record<string, string> = {
  js: 'node',
  mjs: 'node',
  cjs: 'node',
  py: 'python',
}

// 未命中的落 plaintext：纯文本也能编辑，只是没有语法高亮
export const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  py: 'python',
  md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'html', xml: 'xml', svg: 'xml',
  yaml: 'yaml', yml: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', bat: 'bat', cmd: 'bat',
  sql: 'sql',
  toml: 'ini', ini: 'ini',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  rb: 'ruby', php: 'php', lua: 'lua',
  dart: 'dart', swift: 'swift',
}

function extOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() || filePath
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function languageForPath(filePath: string): string {
  return LANGUAGES[extOf(filePath)] ?? 'plaintext'
}

export function runnerForPath(filePath: string): string | undefined {
  return RUNNERS[extOf(filePath)]
}
