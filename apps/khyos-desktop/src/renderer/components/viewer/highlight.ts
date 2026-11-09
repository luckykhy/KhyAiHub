// khy-canary: Khy-20261102-336-7MKRARA1
// 代码查看器自带的轻量语法高亮 —— 零依赖，扫描式（非正则整段替换）。
//
// 为什么不在这里复用消息区的 MarkdownRenderer：
//   消息区的渲染器是「聊天正文」形态（代码块外壳、复制条、气泡排版），
//   查看器的源码视图是「文件」形态（等宽、逐行、可横向滚动、可开行号），
//   两者对同一段代码的排布要求不同；而 MarkdownRenderer 里的高亮函数是它的
//   私有实现，跨区域 import 私有函数会把两个区域焊死在一个文件上。
//   这里自带一个扫描器，成本是一份小文件，收益是两个区域互不牵制。
//   （Markdown 的**解析**是共用的：components/message/markdown/parser.ts，
//   本目录的 MarkdownPreview 直接用它，不存在第二套 Markdown 解析。）
//
// 高亮色沿用仓内既定的四个语义色（text-green-400 / yellow-400 / fuchsia-400 /
// cyan-400），与消息区代码块同一套观感（见 theme/globals.css 的高亮色令牌）。

export type ViewerLanguage =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'python'
  | 'css'
  | 'html'
  | 'shell'
  | 'markdown'
  | 'text'

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'type'
  | 'tag'
  | 'attr'

export interface Token {
  text: string
  kind: TokenKind
}

/** 令牌 → 工具类。plain 继承正文色，不额外着色。 */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: '',
  comment: 'text-foreground-muted italic',
  string: 'text-green-400',
  number: 'text-yellow-400',
  keyword: 'text-fuchsia-400 font-medium',
  type: 'text-cyan-400',
  tag: 'text-cyan-400',
  attr: 'text-foreground/75',
}

const EXT_LANGUAGE: Record<string, ViewerLanguage> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  py: 'python', pyi: 'python',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  md: 'markdown', markdown: 'markdown',
}

const NAME_LANGUAGE: Record<string, ViewerLanguage> = {
  dockerfile: 'shell',
  makefile: 'shell',
  'makefile.am': 'shell',
}

/** 按文件名推断语言；识别不出就是纯文本（不做着色，不猜）。 */
export function detectLanguage(fileName: string): ViewerLanguage {
  const lower = fileName.toLowerCase()
  if (NAME_LANGUAGE[lower]) return NAME_LANGUAGE[lower]
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return 'text'
  return EXT_LANGUAGE[lower.slice(dot + 1)] || 'text'
}

/** 文件扩展名（小写，不含点）；用于头部的小标签。 */
export function detectExtension(fileName: string): string {
  const lower = fileName.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return ''
  return lower.slice(dot + 1)
}

const TS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'new', 'class', 'extends', 'implements',
  'interface', 'type', 'enum', 'import', 'export', 'from', 'default', 'async',
  'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of',
  'keyof', 'readonly', 'public', 'private', 'protected', 'static', 'void',
  'delete', 'this', 'super', 'null', 'undefined', 'true', 'false', 'as',
  'declare', 'namespace', 'abstract', 'get', 'set', 'satisfies', 'yield',
])

const JS_KEYWORDS = new Set(
  [...TS_KEYWORDS].filter(
    (k) => !['interface', 'type', 'enum', 'implements', 'readonly', 'public', 'private', 'protected', 'declare', 'namespace', 'abstract', 'satisfies', 'keyof'].includes(k),
  ),
)

const PY_KEYWORDS = new Set([
  'def', 'class', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue',
  'return', 'import', 'from', 'as', 'try', 'except', 'finally', 'with', 'async',
  'await', 'lambda', 'yield', 'raise', 'pass', 'global', 'nonlocal', 'assert',
  'del', 'is', 'not', 'and', 'or', 'in', 'None', 'True', 'False', 'self',
  'match', 'case',
])

const SH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case',
  'esac', 'function', 'return', 'export', 'local', 'readonly', 'source',
  'alias', 'set', 'unset', 'echo', 'cd', 'exit', 'shift', 'trap', 'in', 'time',
])

const JSON_KEYWORDS = new Set(['true', 'false', 'null'])

const TS_TYPES = new Set([
  'string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'Array',
  'Promise', 'Record', 'Partial', 'Readonly', 'Map', 'Set', 'Date', 'RegExp',
  'Error', 'Symbol', 'BigInt',
])

const PY_TYPES = new Set([
  'int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'bytes',
  'object', 'type', 'Exception',
])

const EMPTY = new Set<string>()

const KEYWORDS: Partial<Record<ViewerLanguage, Set<string>>> = {
  typescript: TS_KEYWORDS,
  javascript: JS_KEYWORDS,
  python: PY_KEYWORDS,
  shell: SH_KEYWORDS,
  json: JSON_KEYWORDS,
}

const TYPES: Partial<Record<ViewerLanguage, Set<string>>> = {
  typescript: TS_TYPES,
  javascript: TS_TYPES,
  python: PY_TYPES,
}

const C_LIKE = new Set<ViewerLanguage>(['typescript', 'javascript'])
const BLOCK_COMMENT = new Set<ViewerLanguage>(['typescript', 'javascript', 'css'])
const HASH_COMMENT = new Set<ViewerLanguage>(['python', 'shell'])

interface ScanState {
  /** 块注释跨行：上一行末尾开着 /* 时本行继续按注释着色。 */
  inBlockComment: boolean
}

/**
 * 逐行高亮。跨行状态（块注释）通过 state 传递，所以必须整段文件一起调用，
 * 不能逐行独立调用。
 */
export function highlightLines(lines: string[], lang: ViewerLanguage): Token[][] {
  const state: ScanState = { inBlockComment: false }
  const keywords = KEYWORDS[lang] || EMPTY
  const types = TYPES[lang] || EMPTY
  return lines.map((line) => scanLine(line, lang, keywords, types, state))
}

function scanLine(
  line: string,
  lang: ViewerLanguage,
  keywords: Set<string>,
  types: Set<string>,
  state: ScanState,
): Token[] {
  const tokens: Token[] = []
  const push = (text: string, kind: TokenKind) => {
    if (!text) return
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind) last.text += text
    else tokens.push({ text, kind })
  }

  let i = 0
  while (i < line.length) {
    const rest = line.slice(i)
    const ch = line[i]

    // 块注释（可能跨行）
    if (state.inBlockComment) {
      const end = rest.indexOf('*/')
      if (end === -1) {
        push(rest, 'comment')
        i = line.length
      } else {
        push(rest.slice(0, end + 2), 'comment')
        i += end + 2
        state.inBlockComment = false
      }
      continue
    }
    if (BLOCK_COMMENT.has(lang) && rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2)
      if (end === -1) {
        push(rest, 'comment')
        state.inBlockComment = true
        i = line.length
      } else {
        push(rest.slice(0, end + 2), 'comment')
        i += end + 2
      }
      continue
    }

    // 行注释
    if (C_LIKE.has(lang) && rest.startsWith('//')) {
      push(rest, 'comment')
      break
    }
    if (HASH_COMMENT.has(lang) && ch === '#') {
      push(rest, 'comment')
      break
    }

    // 字符串
    if (ch === '"' || ch === "'" || (ch === '`' && C_LIKE.has(lang))) {
      const end = scanString(line, i, ch)
      let kind: TokenKind = 'string'
      if (lang === 'json' && /^\s*:/.test(line.slice(end))) kind = 'type'
      push(line.slice(i, end), kind)
      i = end
      continue
    }

    // HTML 标签
    if (lang === 'html' && ch === '<') {
      const end = scanTag(line, i)
      pushHtmlTag(line.slice(i, end), push)
      i = end
      continue
    }

    // 数字
    if (/[0-9]/.test(ch) && !/[A-Za-z0-9_$]/.test(line[i - 1] || '')) {
      const m = /^[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?[A-Za-z%]*/.exec(rest)
      if (m) {
        push(m[0], 'number')
        i += m[0].length
        continue
      }
    }

    // shell 变量
    if (lang === 'shell' && ch === '$') {
      const m = /^\$(?:\{[^}]*\}|[A-Za-z_][\w]*|[0-9@*#?$!])/.exec(rest)
      if (m) {
        push(m[0], 'type')
        i += m[0].length
        continue
      }
    }

    // 标识符 / 关键字 / 内建类型
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(rest)
      const word = m ? m[0] : ch
      if (keywords.has(word)) push(word, 'keyword')
      else if (types.has(word)) push(word, 'type')
      else push(word, 'plain')
      i += word.length
      continue
    }

    push(ch, 'plain')
    i += 1
  }

  return tokens
}

/** 返回字符串结束后的下标（未闭合时返回行尾）。 */
function scanString(line: string, start: number, quote: string): number {
  let i = start + 1
  while (i < line.length) {
    const c = line[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === quote) return i + 1
    i += 1
  }
  return line.length
}

/** 返回 HTML 标签结束后的下标（未闭合时返回行尾）。 */
function scanTag(line: string, start: number): number {
  let i = start + 1
  while (i < line.length) {
    const c = line[i]
    if (c === '"' || c === "'") {
      i = scanString(line, i, c)
      continue
    }
    if (c === '>') return i + 1
    i += 1
  }
  return line.length
}

function pushHtmlTag(raw: string, push: (text: string, kind: TokenKind) => void) {
  const head = /^<\/?[A-Za-z][\w-]*/.exec(raw)
  if (!head) {
    push(raw, 'plain')
    return
  }
  push(head[0], 'tag')
  const rest = raw.slice(head[0].length)
  const attrRe = /("[^"]*"|'[^']*')|([A-Za-z_:@][\w:.-]*)(?==)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(rest))) {
    push(rest.slice(last, m.index), 'plain')
    push(m[0], m[1] ? 'string' : 'attr')
    last = m.index + m[0].length
  }
  push(rest.slice(last), 'plain')
}
