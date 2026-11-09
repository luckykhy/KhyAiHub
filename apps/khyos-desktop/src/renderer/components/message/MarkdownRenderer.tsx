// khy-canary: Khy-20261102-298-1H8SDCX4
import { useState } from 'react'
import { Icon } from '../ui/Icon'
import { useCodeDisplaySettings } from './useCodeDisplaySettings'
import { parseMarkdown } from './markdown/parser'
import type { Block, Inline } from './markdown/parser'

interface MarkdownRendererProps {
  content: string
  isStreaming?: boolean
  // 附加在消息体根节点上的类。用于消息区按角色给正文加底板（用户轮轻底板），
  // 不新增 DOM 节点。
  className?: string
}

/* ── 代码块 ──────────────────────────────────────────────────────────────── */

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  const { highlight, lineNumbers } = useCodeDisplaySettings()

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 高亮关闭时输出纯文本行；开启时输出着色后的行内容。行容器 div 统一在
  // 渲染处生成，保证「有行号 / 无行号」两条路的行高完全一致。
  const lines: React.ReactNode[] = highlight
    ? highlightCode(code, language)
    : code.split('\n')

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-card-border">
      {/* 代码块头部 */}
      <div className="flex items-center justify-between px-4 py-2 bg-card border-b border-card-border">
        <span className="text-xs font-medium text-foreground-muted">{language || '代码'}</span>
        <button
          onClick={handleCopy}
          className="px-2.5 py-1 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5"
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      {/* 代码内容 */}
      <div className="bg-terminal-bg p-4 overflow-x-auto">
        {lineNumbers ? (
          // 行号槽：与代码同基线的两列 flex，行号列不参与横向滚动内容的宽度
          <div className="flex text-sm font-mono leading-relaxed">
            <div className="select-none text-terminal-bright-black text-right pr-3 shrink-0">
              {lines.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <pre className="whitespace-pre font-mono text-terminal-fg grow min-w-0">
              <code>
                {lines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </code>
            </pre>
          </div>
        ) : (
          <pre className="text-sm font-mono text-terminal-fg leading-relaxed whitespace-pre">
            <code>
              {lines.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </code>
          </pre>
        )}
      </div>
    </div>
  )
}

/**
 * 轻量语法高亮：按行返回**行内容**（不含行容器 div —— 行容器由 CodeBlock
 * 统一渲染，行号槽才能与代码行逐行对齐）。
 * 覆盖 ts/js、python、bash 三类；其余语言原样返回。
 */
function highlightCode(code: string, language: string): React.ReactNode[] {
  const lang = language.toLowerCase()
  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript' || lang === 'jsx' || lang === 'ts' || lang === 'js') {
    return highlightTS(code)
  }
  if (lang === 'python' || lang === 'py') {
    return highlightPython(code)
  }
  if (lang === 'bash' || lang === 'shell' || lang === 'sh' || lang === 'zsh' || lang === 'console') {
    return highlightBash(code)
  }
  return code.split('\n')
}

function highlightTS(code: string): React.ReactNode[] {
  const keywords = ['function', 'const', 'let', 'var', 'if', 'else', 'return', 'import', 'export', 'from', 'class', 'interface', 'type', 'extends', 'implements', 'new', 'async', 'await', 'try', 'catch', 'throw', 'for', 'while', 'switch', 'case', 'break', 'continue', 'default', 'typeof', 'instanceof', 'in', 'of']
  const types = ['number', 'string', 'boolean', 'any', 'void', 'null', 'undefined', 'never', 'unknown', 'object', 'Array', 'Record', 'Promise']

  return code.split('\n').map((line) => {
    const parts: React.ReactNode[] = []
    let key = 0

    // 处理注释
    const commentIndex = line.indexOf('//')
    if (commentIndex >= 0) {
      const before = line.slice(0, commentIndex)
      const comment = line.slice(commentIndex)
      parts.push(<span key={key++}>{highlightTokens(before, keywords, types)}</span>)
      parts.push(<span key={key++} className="text-foreground-muted italic">{comment}</span>)
    } else {
      parts.push(highlightTokens(line, keywords, types))
    }

    return <>{parts}</>
  })
}

function highlightTokens(text: string, keywords: string[], types: string[]): React.ReactNode {
  const parts: React.ReactNode[] = []
  const regex = /(\s+)|("[^"]*"|'[^']*'|`[^`]*`)|(\b\d+\b)|(\b(?:function|const|let|var|if|else|return|import|export|from|class|interface|type|extends|implements|new|async|await|try|catch|throw|for|while|switch|case|break|continue|default|typeof|instanceof|in|of)\b)|(\b(?:number|string|boolean|any|void|null|undefined|never|unknown|object|Array|Record|Promise)\b)|([^\s"'`]+)/g

  let match
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    const [full, space, string, number, keyword, type, other] = match
    if (space) {
      parts.push(<span key={key++}>{space}</span>)
    } else if (string) {
      parts.push(<span key={key++} className="text-green-400">{string}</span>)
    } else if (number) {
      parts.push(<span key={key++} className="text-yellow-400">{number}</span>)
    } else if (keyword) {
      parts.push(<span key={key++} className="text-fuchsia-400 font-medium">{keyword}</span>)
    } else if (type) {
      parts.push(<span key={key++} className="text-cyan-400">{type}</span>)
    } else if (other) {
      parts.push(<span key={key++}>{other}</span>)
    }
  }
  return <>{parts}</>
}

function highlightPython(code: string): React.ReactNode[] {
  const keywords = ['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'return', 'import', 'from', 'as', 'try', 'except', 'finally', 'with', 'async', 'await', 'lambda', 'yield', 'raise', 'pass', 'break', 'continue', 'in', 'is', 'not', 'and', 'or', 'True', 'False', 'None', 'self']

  return code.split('\n').map((line) => {
    const parts: React.ReactNode[] = []
    let key = 0

    const commentIndex = line.indexOf('#')
    if (commentIndex >= 0) {
      const before = line.slice(0, commentIndex)
      const comment = line.slice(commentIndex)
      parts.push(<span key={key++}>{highlightPyTokens(before, keywords)}</span>)
      parts.push(<span key={key++} className="text-foreground-muted italic">{comment}</span>)
    } else {
      parts.push(highlightPyTokens(line, keywords))
    }

    return <>{parts}</>
  })
}

function highlightPyTokens(text: string, keywords: string[]): React.ReactNode {
  const parts: React.ReactNode[] = []
  const regex = /(\s+)|("[^"]*"|'[^']*')|(\b\d+\b)|(\b(?:def|class|if|elif|else|for|while|return|import|from|as|try|except|finally|with|async|await|lambda|yield|raise|pass|break|continue|in|is|not|and|or|True|False|None|self)\b)|([^\s"'`]+)/g

  let match
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    const [full, space, string, number, keyword, other] = match
    if (space) {
      parts.push(<span key={key++}>{space}</span>)
    } else if (string) {
      parts.push(<span key={key++} className="text-green-400">{string}</span>)
    } else if (number) {
      parts.push(<span key={key++} className="text-yellow-400">{number}</span>)
    } else if (keyword) {
      parts.push(<span key={key++} className="text-fuchsia-400 font-medium">{keyword}</span>)
    } else if (other) {
      parts.push(<span key={key++}>{other}</span>)
    }
  }
  return <>{parts}</>
}

function highlightBash(code: string): React.ReactNode[] {
  return code.split('\n').map((line) => {
    if (line.startsWith('$')) {
      return <><span className="text-success">$</span>{line.slice(1)}</>
    }
    if (line.startsWith('#')) {
      return <span className="text-foreground-muted italic">{line}</span>
    }
    return line
  })
}

/* ── 行内渲染 ────────────────────────────────────────────────────────────── */

const SAFE_PROTOCOL = /^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i

function safeHref(href: string): string | null {
  if (!href) return null
  // 判协议前先剥掉控制字符与零宽字符：浏览器解析 URL 时会先剥掉制表符/换行/回车，
  // 于是 `java\tscript:alert(1)` 在浏览器眼里就是 `javascript:alert(1)`；而协议正则
  // `/^[a-z][a-z0-9+.-]*:/` 会被中间的制表符打断 → 误判成「无协议」而放行。
  // 与 parser.ts 的 isSafeHref、web 端 views/Markdown.vue 是同一套规则（三处要一起改）。
  const normalized = href.replace(/[\u0000-\u001f\u200b-\u200f\u2028\u2029]/g, '')
  if (SAFE_PROTOCOL.test(normalized)) return href
  // 相对路径（无协议、无冒号）视为站内链接
  if (!/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return href
  return null
}

function renderInline(nodes: Inline[], keyPrefix = 'i'): React.ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`
    switch (node.type) {
      case 'text':
        return <span key={key}>{node.value}</span>
      case 'code':
        // 行内代码：按 ZCode 真源 prose 规格（[DESIGN-ARCH-092] §4.10，
        // 取自解包产物 styles-*.css 的 `.prose :where(code)`）：
        //   color: var(--tw-prose-code); font-size: .875em; font-weight: 600
        // **无边框、无底色**。此前用的是「带边框的胶囊」（border + bg-surface），
        // 一条消息里出现七八个行内码时，满屏方框把正文切碎 —— 这正是
        // 「渲染有好多、不利于阅读」的观感来源。
        // 真源值随字号缩放（.875em），故用 em 而非固定 px。
        return (
          <code
            key={key}
            className="px-1 py-0.5 rounded font-mono text-foreground/90 font-semibold"
            style={{ fontSize: '0.875em' }}
          >
            {node.value}
          </code>
        )
      case 'strong':
        // 消息区 .khy-tui 走等宽栈，CJK 回退到 NSimSun —— 该字体只有一个字面，
        // font-weight 600 与 400 同形（实测 600/700 与 400 逐像素无差别），
        // 加粗只剩颜色一条路可走。色值取品牌强调令牌（[DESIGN-FE-012] 唯一彩色强调），
        // 浅色 #9c4116 / 深色 #f0a868，两套主题都不低于 6:1。
        return <strong key={key} className="font-semibold text-brand">{renderInline(node.children, key)}</strong>
      case 'em':
        return <em key={key} className="italic">{renderInline(node.children, key)}</em>
      case 'del':
        return <del key={key} className="text-foreground-muted">{renderInline(node.children, key)}</del>
      case 'br':
        return <br key={key} />
      case 'image': {
        const src = safeHref(node.src)
        if (!src) return <span key={key}>{node.alt}</span>
        return (
          <img
            key={key}
            src={src}
            alt={node.alt}
            className="inline-block max-w-full rounded-lg border border-border my-1"
          />
        )
      }
      case 'link': {
        const href = safeHref(node.href)
        const label = renderInline(node.children, key)
        if (!href) return <span key={key}>{label}</span>
        return (
          <a
            key={key}
            href={href}
            title={node.title}
            target="_blank"
            rel="noreferrer noopener"
            // 真源 `.prose :where(a)` → font-weight: 500; text-decoration: underline。
            // 颜色保留桌面端品牌琥珀（--color-brand）——真源用的是 prose-links
            // 蓝灰，但桌面端按 CLAUDE.md 的品牌替换规则走 --color-brand。
            className="text-brand font-medium underline underline-offset-2 decoration-brand/40 hover:decoration-brand transition-colors"
          >
            {label}
          </a>
        )
      }
    }
  })
}

/* ── 块级渲染 ────────────────────────────────────────────────────────────── */

/**
 * 间距口径：全部取自 ZCode 真源 prose 规格（[DESIGN-ARCH-092] §4.10，
 * 数值来自解包产物 styles-*.css 的 `.prose :where(...)` 规则）。
 *
 * 真源用 **em** 相对单位（`1.25em` / `.5em` / `1.625em`），不是固定 px：
 * 消息正文字号可由用户设置（设置 → 外观 → 消息字体大小，落在
 * --khy-message-font-size 上），em 会跟着一起缩放，px 不会。此前用手写
 * `mb-2`（8px）/ `space-y-1`（4px），字号一大就挤成一团、一小就散开。
 *
 * **注意**：类名必须是**完整的字面量**（如 'my-[1.25em]'），不能由片段拼出来
 * （如 `my-[${n}em]`）—— Tailwind 4 靠源码静态扫描提取候选类名，拼接出来的
 * 字符串扫不到，构建产物里不会有对应类，样式会静默失效。
 * 已核对构建产物 out/renderer/assets/index-*.css 确认这些类真实存在。
 */

/** 真源 `.prose :where(p|ul|ol)` → margin: 1.25em；`.prose :where(li)` → margin: .5em */
const PARA_M = 'my-[1.25em]'
const LIST_M = 'my-[1.25em] pl-[1.625em]'
const LI_M = 'my-[0.5em]'
/** 真源 `.prose :where(hr)` → margin: 3em；`.prose :where(blockquote)` → margin: 1.6em */
const HR_M = 'my-[3em]'
const QUOTE_M = 'my-[1.6em] pl-[1em]'
/** 真源 `.prose :where(table)` → margin: 2em */
const TABLE_M = 'my-[2em]'

const HEADING_CLASS: Record<number, string> = {
  1: 'text-xl font-bold text-foreground mt-[2em] mb-[1em]',
  2: 'text-lg font-semibold text-foreground mt-[2em] mb-[1em]',
  3: 'text-base font-semibold text-foreground mt-[1.6em] mb-[0.6em]',
  4: 'text-sm font-semibold text-foreground mt-[1.5em] mb-[0.5em]',
  5: 'text-sm font-semibold text-foreground/90 mt-[1.5em] mb-[0.5em]',
  6: 'text-xs font-semibold text-foreground/80 mt-[1.5em] mb-[0.5em] uppercase tracking-wide',
}

const ALIGN_CLASS: Record<string, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
}

function renderBlock(block: Block, key: string, compact = false): React.ReactNode {
  switch (block.type) {
    case 'paragraph':
      return (
        <p key={key} className={compact ? 'leading-relaxed' : `leading-relaxed ${PARA_M}`}>
          {renderInline(block.inline, key)}
        </p>
      )

    case 'heading': {
      const Tag = `h${block.depth}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return (
        <Tag key={key} className={HEADING_CLASS[block.depth]}>
          {renderInline(block.inline, key)}
        </Tag>
      )
    }

    case 'code':
      return <CodeBlock key={key} code={block.value} language={block.lang} />

    case 'hr':
      return <hr key={key} className={`${HR_M} border-t border-border`} />

    case 'quote':
      return (
        <blockquote key={key} className={`${QUOTE_M} border-l-2 border-brand/40 text-foreground/70`}>
          {block.children.map((child, i) => renderBlock(child, `${key}-${i}`))}
        </blockquote>
      )

    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul'
      return (
        <ListTag
          key={key}
          className={`${LIST_M} ${block.ordered ? 'list-decimal' : 'list-disc'} marker:text-foreground-subtle`}
          start={block.ordered && block.start !== 1 ? block.start : undefined}
        >
          {block.items.map((item, i) => (
            <li key={`${key}-${i}`} className={`leading-relaxed ${LI_M}`}>
              {item.blocks.length === 1 && item.blocks[0].type === 'paragraph'
                ? renderInline(item.blocks[0].inline, `${key}-${i}`)
                : item.blocks.map((child, j) => renderBlock(child, `${key}-${i}-${j}`, true))}
            </li>
          ))}
        </ListTag>
      )
    }

    case 'table':
      return (
        <div key={key} className={`${TABLE_M} overflow-x-auto`}>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th
                    key={i}
                    className={`bg-surface text-foreground/80 font-medium px-3 py-2 border-b border-border ${ALIGN_CLASS[block.align[i] ?? ''] ?? 'text-left'}`}
                  >
                    {renderInline(cell, `${key}-h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className={`px-3 py-2 border-b border-border/50 text-foreground/85 ${ALIGN_CLASS[block.align[c] ?? ''] ?? 'text-left'}`}
                    >
                      {renderInline(cell, `${key}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

export function MarkdownRenderer({ content, isStreaming, className = '' }: MarkdownRendererProps) {
  const blocks = parseMarkdown(content)
  const cls = className ? `message-body text-foreground ${className}` : 'message-body text-foreground'

  return (
    <div className={cls}>
      {blocks.map((block, i) => renderBlock(block, `b${i}`))}
      {isStreaming && (
        <span className="inline-block w-2.5 h-5 bg-brand animate-pulse ml-0.5 align-text-bottom rounded-sm" />
      )}
    </div>
  )
}
