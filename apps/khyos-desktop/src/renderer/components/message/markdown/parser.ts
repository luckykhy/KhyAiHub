// khy-canary: Khy-20261102-301-9RQYDWD5
// 无依赖的 Markdown 解析器（块级 + 行内）。
//
// 之前 MarkdownRenderer.tsx 是逐行 regex：只认标题 / `- ` 列表 / `1. ` 列表 /
// 围栏代码，其余一律当段落按空格拼接。模型输出稍复杂（表格、链接、引用、嵌套
// 列表）就整段退化成纯文本，链接变成裸 URL、`|` 表格变成一行行挤在一起的字。
//
// 设计口径（与本轮评审一致）：
//   1. 不新增任何依赖。本文件是纯函数、无 React、无 DOM 依赖，便于单测。
//   2. 覆盖不过就降级，不崩：任何拿不准的构造都回退成文本节点 / 纯文本段落，
//      绝不抛异常、绝不吞内容。
//   3. 不做完整 CommonMark/GFM 兼容，只覆盖模型实际会输出的那一批构造。
//
// 上游若将来引入 react-markdown + remark-gfm（需单独提 PR、连带锁文件与打包
// 验证），本文件应整体删除、由组件映射表接管。

export type Align = 'left' | 'center' | 'right' | null

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; href: string; title?: string; children: Inline[] }
  | { type: 'image'; src: string; alt: string }
  | { type: 'br' }

export interface ListItem {
  blocks: Block[]
}

export type Block =
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6; inline: Inline[] }
  | { type: 'code'; lang: string; value: string }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'table'; header: Inline[][]; align: Align[]; rows: Inline[][][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'hr' }

/* ── 块级构造的识别 ──────────────────────────────────────────────────────── */

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})/
// 分割线：同一字符连续出现 3 次及以上（`- - -` / `***` / `___` 也算）。
// 捕获组只放**单个**字符，`\1` 才有意义；写成 `(-{1,}|...)` 时 \1 会贪婪吃掉
// 整串，反引用要求 3 份整串，`---` 反而匹配不上。
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const RE_HEADING = /^ {0,3}(#{1,6})(\s+(.*?))?\s*$/
const RE_QUOTE = /^ {0,3}>/
const RE_LIST_ITEM = /^(\s*)([-+*]|\d{1,9}[.)])(\s+)(.*)$|^(\s*)([-+*]|\d{1,9}[.)])\s*$/

/** 该行是否开启一个新的块级构造（用于列表项的惰性续行判定）。 */
function isBlockStart(line: string): boolean {
  return (
    RE_FENCE.test(line) ||
    RE_HR.test(line) ||
    RE_HEADING.test(line) ||
    RE_QUOTE.test(line) ||
    RE_LIST_ITEM.test(line)
  )
}

function indentOf(line: string): number {
  let n = 0
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++
  return n
}

/** 按未转义的 `|` 切分表格行；首尾的竖线与转义竖线不算分隔符。 */
function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += s[i]
  }
  cells.push(cur.trim())
  return cells
}

function isDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c))
}

/** 第 i 行是否是表头、第 i+1 行是否是对齐分隔行（即此处可起一张表）。 */
function startsTable(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length) return false
  const head = lines[i]
  const sep = lines[i + 1]
  if (!head.includes('|') || !sep.includes('|')) return false
  return isDelimiterRow(splitTableRow(sep))
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/* ── 块级解析 ────────────────────────────────────────────────────────────── */

/**
 * 把 Markdown 源码切成块序列。永不抛异常：解析不了的内容以 paragraph +
 * 纯文本 inline 的形式原样出现。
 */
export function parseMarkdown(source: string): Block[] {
  if (!source) return []
  try {
    return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'))
  } catch {
    return [{ type: 'paragraph', inline: [{ type: 'text', value: source }] }]
  }
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    // 围栏代码块（``` 或 ~~~，闭合围栏长度需 ≥ 开启长度）
    const fence = RE_FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const lang = line.slice(fence[0].length).trim()
      const body: string[] = []
      i++
      while (i < lines.length) {
        const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`)
        if (close.test(lines[i])) { i++; break }
        body.push(lines[i]); i++
      }
      out.push({ type: 'code', lang, value: body.join('\n') })
      continue
    }

    // 分割线
    if (RE_HR.test(line)) { out.push({ type: 'hr' }); i++; continue }

    // 标题
    const heading = RE_HEADING.exec(line)
    if (heading) {
      out.push({
        type: 'heading',
        depth: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        inline: parseInline((heading[3] ?? '').trim()),
      })
      i++
      continue
    }

    // 引用块（`>` 前缀 + 惰性续行）
    if (RE_QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        if (RE_QUOTE.test(lines[i])) {
          inner.push(lines[i].replace(/^ {0,3}> ?/, ''))
          i++
          continue
        }
        // 惰性续行：引用块内未加 `>` 的普通段落行
        if (lines[i].trim() && !isBlockStart(lines[i])) { inner.push(lines[i]); i++; continue }
        break
      }
      out.push({ type: 'quote', children: parseBlocks(inner) })
      continue
    }

    // 表格（当前行含 `|`，下一行是对齐分隔行）
    if (startsTable(lines, i)) {
      const header = splitTableRow(lines[i])
      const align = splitTableRow(lines[i + 1]).map(alignOf)
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitTableRow(lines[i])
        while (cells.length < header.length) cells.push('')
        rows.push(cells.slice(0, header.length).map(parseInline))
        i++
      }
      out.push({ type: 'table', header: header.map(parseInline), align, rows })
      continue
    }

    // 列表（有序 / 无序，支持缩进嵌套与多行续写）
    const item = RE_LIST_ITEM.exec(line)
    if (item) {
      const { list, next } = parseList(lines, i)
      out.push(list)
      i = next
      continue
    }

    // 段落：连续的非空且不另起块级的行
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      // 模型常常在表格前漏掉空行。此处让一步：若当前行是表头、下一行是对齐
      // 分隔行，就跳出段落交给表格分支处理（GFM 严格语义不允许表格打断段落，
      // 但对模型输出而言「宽松解析」比「整段退化成一行字」好得多）。
      if (startsTable(lines, i)) break
      // 只裁行首缩进：**行尾的两个空格是 GFM 硬换行标记**，整行 trim 掉就丢了
      para.push(lines[i].replace(/^[ \t]+/, ''))
      i++
    }
    if (para.length > 0) out.push({ type: 'paragraph', inline: parseInline(para.join('\n')) })
  }

  return out
}

interface ListMatch { indent: number; marker: string; rest: string }

function matchListItem(line: string): ListMatch | null {
  const m = RE_LIST_ITEM.exec(line)
  if (!m) return null
  if (m[2]) return { indent: m[1].length, marker: m[2], rest: m[4] ?? '' }
  return { indent: m[5].length, marker: m[6], rest: '' }
}

/** 从 start 行开始收集一个列表，返回列表与下一个待处理行号。 */
function parseList(lines: string[], start: number): { list: Extract<Block, { type: 'list' }>; next: number } {
  const first = matchListItem(lines[start])!
  const baseIndent = first.indent
  const ordered = /\d/.test(first.marker)
  const startNo = ordered ? parseInt(first.marker, 10) || 1 : 1
  const items: ListItem[] = []
  let i = start

  while (i < lines.length) {
    const head = matchListItem(lines[i])
    if (!head || head.indent !== baseIndent) break
    const sameKind = /\d/.test(head.marker) === ordered
    if (!sameKind) break

    // 标记之后的正文本起始列：用于剥离续行缩进
    const contentIndent = head.indent + head.marker.length + 1
    const itemLines: string[] = [head.rest]
    i++

    while (i < lines.length) {
      const l = lines[i]
      if (!l.trim()) {
        // 空行：后面若仍是本项的续行（更深缩进 / 非新块起点）则并入，否则收尾
        let j = i
        while (j < lines.length && !lines[j].trim()) j++
        if (j >= lines.length) { i = j; break }
        if (indentOf(lines[j]) > baseIndent || !isBlockStart(lines[j])) {
          for (let k = i; k < j; k++) itemLines.push('')
          i = j
          continue
        }
        i = j
        break
      }
      const ind = indentOf(l)
      if (ind > baseIndent) {
        // 缩进的续行 / 嵌套块：按需剥掉列表内容列缩进
        itemLines.push(l.slice(Math.min(ind, contentIndent)))
        i++
        continue
      }
      if (isBlockStart(l)) break // 同级新项或另起块级构造
      itemLines.push(l.trim()) // 惰性段落续行
      i++
    }

    items.push({ blocks: parseBlocks(itemLines) })
  }

  return { list: { type: 'list', ordered, start: startNo, items }, next: i }
}

/* ── 行内解析 ────────────────────────────────────────────────────────────── */

const ESCAPABLE = /[!-/:-@[-`{-~]/
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i
// 可点击的协议白名单。模型输出里出现的 javascript: / data: 链接一律降级成
// 纯文本（渲染层另有一道 safeHref 兜底，这里先拦一道，避免任何下游消费者
// 拿到危险 href）。
const SAFE_PROTOCOL = /^(https?:|mailto:|tel:)/i
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  let i = 0

  const flush = () => {
    if (buf) { out.push({ type: 'text', value: buf }); buf = '' }
  }

  while (i < src.length) {
    const ch = src[i]

    // 反斜杠转义
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
      buf += src[i + 1]; i += 2; continue
    }

    // 硬换行：行尾两空格 + \n（GFM）；单个 \n 是软换行，渲染成一个空格
    // （与 CommonMark 默认渲染一致，也与本仓库此前「多行拼成一段」的读感一致）
    if (ch === '\n') {
      const hard = /\s{2,}$/.test(buf)
      buf = buf.replace(/\s+$/, '')
      flush()
      if (hard) out.push({ type: 'br' })
      else out.push({ type: 'text', value: ' ' })
      i++
      continue
    }

    // 行内代码
    if (ch === '`') {
      const m = matchDelimited(src, i, '`')
      if (m) {
        flush()
        out.push({ type: 'code', value: m.content.trim() })
        i = m.end
        continue
      }
    }

    // 图片 ![alt](src)
    if (ch === '!' && src[i + 1] === '[') {
      const m = matchLink(src, i + 1)
      if (m) {
        flush()
        out.push({ type: 'image', src: m.href, alt: plainText(parseInline(m.label)) })
        i = m.end
        continue
      }
    }

    // 链接 [text](href)
    if (ch === '[') {
      const m = matchLink(src, i)
      if (m) {
        flush()
        out.push({ type: 'link', href: m.href, title: m.title, children: parseInline(m.label) })
        i = m.end
        continue
      }
    }

    // 尖括号自动链接 <https://…>
    if (ch === '<') {
      const close = src.indexOf('>', i)
      if (close > i) {
        const inner = src.slice(i + 1, close)
        if (/^(https?:\/\/|mailto:)[^\s<>]+$/i.test(inner)) {
          flush()
          out.push({ type: 'link', href: inner, children: [{ type: 'text', value: inner }] })
          i = close + 1
          continue
        }
      }
    }

    // 删除线 ~~…~~
    if (ch === '~' && src[i + 1] === '~') {
      const close = src.indexOf('~~', i + 2)
      if (close > i + 1) {
        flush()
        out.push({ type: 'del', children: parseInline(src.slice(i + 2, close)) })
        i = close + 2
        continue
      }
    }

    // 强调 **bold** / __bold__ / *italic* / _italic_
    if (ch === '*' || ch === '_') {
      const strong = src[i + 1] === ch
      const marker = strong ? ch + ch : ch
      // 开标记必须 left-flanking：内容首字符不能是空白，且下划线不参与词内强调。
      // 官方判据：`** foo bar**` / `foo_bar_` 均应保持字面量。
      const close = canOpenEmphasis(src, i, marker)
        ? findEmphasisClose(src, i + marker.length, marker)
        : -1
      if (close > -1) {
        const inner = src.slice(i + marker.length, close)
        // 「闭合前有空白」时该位置对**强标记**无效（官方 `**foo bar **` → 字面量），
        // 但同一对分隔符仍可按**单枚**消耗（官方 `**foo*` → * + <em>foo</em>）。
        // 两种消耗的「可闭合」判定不同，故这里分别处理。
        const closeUsable = !/\s/.test(src[close - 1] ?? ' ')
        if (strong) {
          if (closeUsable && inner.trim()) {
            flush()
            out.push({ type: 'strong', children: parseInline(inner) })
            i = close + marker.length
            continue
          }
        } else if (inner.trim()) {
          flush()
          out.push({ type: 'em', children: parseInline(inner) })
          i = close + marker.length
          continue
        }
        // 强标记不可用 → 降级为单枚消耗（CommonMark 的「部分消耗」语义）
        if (strong) {
          const singleInner = src.slice(i + 1, close)
          if (closeUsable && singleInner.trim()) {
            flush()
            out.push({ type: 'em', children: parseInline(singleInner) })
            i = close + 1
            continue
          }
        }
      }
    }

    // 裸 URL（http(s)://）
    if ((ch === 'h' || ch === 'H') && (src.startsWith('http://', i) || src.startsWith('https://', i))) {
      const m = BARE_URL.exec(src.slice(i))
      if (m) {
        const href = trimUrlTail(m[0])
        flush()
        out.push({ type: 'link', href, children: [{ type: 'text', value: href }] })
        i += href.length
        continue
      }
    }

    buf += ch
    i++
  }

  flush()
  return out
}

/**
 * 开标记能否开启强调（CommonMark left-flanking 判据的实用子集）。
 *
 * 官方判据（spec.txt）：
 *   · `** foo bar**`  → 字面量（开标记后紧跟空白 → 内容不能以空白开头）
 *   · `_foo_bar`       → 字面量（下划线不做词内强调）
 *   · `foo__bar__`     → 字面量（同上）
 *   · `foo*bar*`       → <em>bar</em>（星号允许词内强调）
 *   · `foo**bar**`     → <strong>bar</strong>（双星号同样允许词内强调）
 *   · `_пристаням_стремятся` → 字面量（下划线开标记前是字母）
 *
 * 官方原文：「Many implementations have also restricted intraword emphasis to
 * the `*` forms, to avoid unwanted emphasis in words containing internal
 * underscores.」——但那是"many implementations"的取舍，**规范本身允许
 * `foo**bar**`**。故此处只禁下划线词内，星号与双星号一律放行（与规范一致）。
 */
function canOpenEmphasis(src: string, at: number, marker: string): boolean {
  const n = marker.length
  const first = src[at + n]
  // 内容不能以空白开头（`** foo**` / `* foo*` 都不是强调）
  if (first === undefined || /\s/.test(first)) return false
  // 开标记前紧贴字母/数字/下划线 → 词内位置
  const before = src[at - 1]
  if (before !== undefined && /[\p{L}\p{N}_]/u.test(before)) {
    // 下划线开标记不参与词内强调（否则 snake_case 标识符会被拆开）
    if (marker[0] === '_') return false
  }
  return true
}

/** 截取与 start 处同长度、以同一串定界符闭合的一段内容（用于行内代码）。 */
function matchDelimited(src: string, start: number, marker: string): { content: string; end: number } | null {
  let n = 0
  while (src[start + n] === marker) n++
  const open = start + n
  const needle = marker.repeat(n)
  let from = open
  for (;;) {
    const at = src.indexOf(needle, from)
    if (at < 0) return null
    // 闭合串必须恰好 n 个（更长的是另一个分隔串）
    let after = at
    while (src[after] === marker) after++
    if (after - at === n) return { content: src.slice(open, at), end: after }
    from = after
  }
}

/**
 * CommonMark 风格的闭合标记判定。
 *
 * 判据来自官方测试集 spec.txt（commonmark/commonmark-spec）与 marked 15：
 *   · `**foo bar **` → 字面量（闭合标记**前**有空白 → 不可闭合）
 *   · `**foo**bar`   → <strong>foo</strong>bar（闭合后紧跟普通字符**合法**）
 *   · `**foo**`      → <strong>foo</strong>（闭合后紧跟标点/行尾亦合法）
 *
 * 此前实现多了一条错误约束「闭合标记后必须跟空白或行尾」，于是模型极常见的
 * `**Amoo 是什么**: 装在…`（闭合后紧跟冒号）整段退化成字面量文本，`**` 直接
 * 漏到屏幕上；同时漏了「闭合标记前不能有空白」这条，于是 `**foo bar **` 反而
 * 被误判成 em。两处都按官方判据改正。
 *
 * 返回值：闭合标记的**起始位置**；-1 表示没找到候选位置。
 * 注意「候选位置」与「可用闭合点」的区别 —— 位置存在但因「闭合前有空白」
 * 而不可用时，仍返回该位置，由调用方决定是否降级（CommonMark 的分隔符栈
 * 里，同一对分隔符先按 2 枚消耗、失败再按 1 枚消耗）。
 */
function findEmphasisClose(src: string, from: number, marker: string): number {
  const n = marker.length
  for (let i = from; i <= src.length - n; i++) {
    if (src[i] !== marker[0] || src.slice(i, i + n) !== marker) continue
    // 闭合标记前不能有空白（否则内容末尾是空格，不是强调）。
    // 但**不**就此放弃该位置 —— 它仍是「同一对分隔符」的候选，
    // 调用方可能以更少的标记消耗它（降级路径）。
    const before = src[i - 1] ?? ' '
    if (/\s/.test(before)) return i
    // 下划线闭合标记不做词内闭合：`_пристаням_стремятся` 里的下划线夹在
    // 西文字母之间，不是强调（marked / CommonMark 均如此）。
    // 星号允许词内：`foo*bar*` → <em>bar</em>。
    if (marker[0] === '_' && before !== undefined && /[\p{L}\p{N}]/u.test(before)) {
      // 但闭合标记后紧跟非字母（如 `_foo_.`）仍合法，故此处只在「后也是字母」时排除
      const afterChar = src[i + n]
      if (afterChar !== undefined && /[\p{L}\p{N}]/u.test(afterChar)) continue
    }
    // 闭合标记处可能连着多枚同类标记（`***foo***`）。按 CommonMark 的
    // 「部分消耗」规则，多出来的标记归外层强调用：
    //   · `***foo***` → <em><strong>foo</strong></em>
    // 故此处**不**因「后面还有同种标记」而否决该闭合点，交由调用方按需
    // 只消耗所需数量，余量留给外层。
    return i
  }
  return -1
}

function trimUrlTail(url: string): string {
  let s = url
  for (;;) {
    const last = s[s.length - 1]
    if (last === '.' || last === ',' || last === ';' || last === ':' || last === '!' || last === '?') {
      s = s.slice(0, -1); continue
    }
    if (last === ')' && (s.match(/\)/g) ?? []).length > (s.match(/\(/g) ?? []).length) {
      s = s.slice(0, -1); continue
    }
    break
  }
  return s
}

/** 相对路径（无协议、无冒号）视为站内链接，其余带协议的一律走白名单。 */
function isSafeHref(href: string): boolean {
  if (!href) return false
  // 判协议前先剥掉控制字符与零宽字符：浏览器解析 URL 时会先剥掉制表符/换行/回车，
  // 于是 `java\tscript:alert(1)` 在浏览器眼里就是 `javascript:alert(1)`；而协议正则
  // `/^[a-z][a-z0-9+.-]*:/` 会被中间的制表符打断 → 误判成「无协议」而放行。
  // 同仓 web 端 views/Markdown.vue 用的是同一套剥离规则（此处对齐）。
  const normalized = href.replace(/[\u0000-\u001f\u200b-\u200f\u2028\u2029]/g, '')
  if (SAFE_PROTOCOL.test(normalized)) return true
  if (HAS_SCHEME.test(normalized)) return false
  return true
}

/** 解析 `[label](href "title")`，label 内允许一层方括号。 */
function matchLink(src: string, start: number): { label: string; href: string; title?: string; end: number } | null {
  if (src[start] !== '[') return null
  let depth = 0
  let close = -1
  for (let i = start; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue }
    if (src[i] === '[') depth++
    else if (src[i] === ']') {
      depth--
      if (depth === 0) { close = i; break }
    }
  }
  if (close < 0 || src[close + 1] !== '(') return null

  let paren = 0
  let end = -1
  for (let i = close + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue }
    if (src[i] === '(') paren++
    else if (src[i] === ')') {
      paren--
      if (paren === 0) { end = i; break }
    }
  }
  if (end < 0) return null

  const inner = src.slice(close + 2, end).trim()
  const tm = /^(\S*?)(?:\s+["'(](.*)["')])?$/.exec(inner)
  const href = tm ? tm[1] : inner
  if (!href) return null
  // 危险协议不生成可点击链接：label 仍作为文本渲染，href 置空
  if (!isSafeHref(href)) {
    return { label: src.slice(start + 1, close), href: '', title: tm?.[2], end: end + 1 }
  }
  return { label: src.slice(start + 1, close), href, title: tm?.[2], end: end + 1 }
}

/** 行内节点取纯文本（图片 alt、链接标签兜底都用它）。 */
export function plainText(nodes: Inline[]): string {
  return nodes
    .map(n => {
      switch (n.type) {
        case 'text': return n.value
        case 'code': return n.value
        case 'image': return n.alt
        case 'br': return ' '
        default: return plainText(n.children)
      }
    })
    .join('')
}