// khy-canary: Khy-20261102-333-7ENECMTZ
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../ui/Icon'
import { CodeTokens } from './CodeTokens'
import { detectLanguage, highlightLines } from './highlight'
import { parseMarkdown, type Block, type Inline } from '../message/markdown/parser'

// 文件预览用的 Markdown 渲染器（文档级）。
//
// 解析复用消息区的无依赖解析器（components/message/markdown/parser.ts）——
// 表格、链接、引用、嵌套列表都在那份解析器里，查看器不再自带第二套解析。
// 本文件只负责**排版**：把解析出的块/行内节点排成「文档」形态
// （表格有边框与表头底、链接是品牌蓝、引用有左条、行内代码是中性表面），
// 与消息区的聊天排版分开——文件预览里表格与链接是一等公民。

type TableBlock = Extract<Block, { type: 'table' }>

const HEADING_CLASS: Record<number, string> = {
  1: 'text-xl font-semibold text-foreground mt-5 mb-2',
  2: 'text-lg font-semibold text-foreground mt-4 mb-2',
  3: 'text-base font-semibold text-foreground mt-4 mb-1.5',
  4: 'text-sm font-semibold text-foreground mt-3 mb-1.5',
  5: 'text-sm font-medium text-foreground/90 mt-3 mb-1.5',
  6: 'text-sm font-medium text-foreground/80 mt-3 mb-1.5',
}

const INLINE_CODE_CLASS =
  'px-1.5 py-0.5 rounded-md border border-border/50 bg-surface text-foreground/90 font-mono text-[0.9em]'

export function MarkdownPreview({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdown(content), [content])

  if (blocks.length === 0) {
    return <div className="px-5 py-4 text-sm text-foreground-subtle" />
  }

  return (
    <div className="text-sm text-foreground/90 leading-relaxed">
      {blocks.map((block, i) => (
        <BlockView key={`block-${i}`} block={block} />
      ))}
    </div>
  )
}

function BlockView({ block, inList = false }: { block: Block; inList?: boolean }) {
  switch (block.type) {
    case 'paragraph':
      return (
        <p className={`${inList ? 'mb-0' : 'mb-3'} whitespace-pre-wrap break-words`}>
          <InlineNodes nodes={block.inline} />
        </p>
      )
    case 'heading': {
      const Tag = `h${block.depth}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return (
        <Tag className={HEADING_CLASS[block.depth] || HEADING_CLASS[6]}>
          <InlineNodes nodes={block.inline} />
        </Tag>
      )
    }
    case 'code':
      return <CodeBlockView lang={block.lang} text={block.value} />
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag
          className={`${block.ordered ? 'list-decimal' : 'list-disc'} pl-5 space-y-1 mb-3 marker:text-foreground-subtle`}
          start={block.ordered ? block.start : undefined}
        >
          {block.items.map((item, i) => (
            <li key={`li-${i}`} className="break-words">
              <div className="space-y-1">
                {item.blocks.map((b, j) => (
                  <BlockView key={`li-${i}-b${j}`} block={b} inList />
                ))}
              </div>
            </li>
          ))}
        </Tag>
      )
    }
    case 'quote':
      return (
        <blockquote className="border-l-2 border-brand/40 pl-3 text-foreground/70 my-3">
          {block.children.map((child, i) => (
            <BlockView key={`q-${i}`} block={child} />
          ))}
        </blockquote>
      )
    case 'table':
      return <TableView block={block} />
    case 'hr':
      return <hr className="border-t border-border my-4" />
  }
}

function TableView({ block }: { block: TableBlock }) {
  const alignClass = (i: number) => {
    const a = block.align[i]
    if (a === 'center') return 'text-center'
    if (a === 'right') return 'text-right'
    return 'text-left'
  }
  return (
    <div className="my-3 overflow-x-auto rounded-lg border border-card-border">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr>
            {block.header.map((cell, i) => (
              <th
                key={`th-${i}`}
                className={`bg-surface ${alignClass(i)} px-3 py-2 border-b border-border font-medium text-foreground whitespace-nowrap`}
              >
                <InlineNodes nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={`tr-${r}`}>
              {row.map((cell, c) => (
                <td
                  key={`td-${r}-${c}`}
                  className={`${alignClass(c)} px-3 py-2 border-b border-border/50 align-top`}
                >
                  <InlineNodes nodes={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CodeBlockView({ lang, text }: { lang: string; text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const language = detectLanguage(lang || 'text')
  const lines = useMemo(() => text.split('\n'), [text])
  const tokenLines = useMemo(() => highlightLines(lines, language), [lines, language])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用（无焦点/无权限）时不做提示，避免误导
    }
  }

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-card-border">
      <div className="flex items-center justify-between px-3 py-1.5 bg-card border-b border-card-border">
        <span className="text-[11px] font-medium text-foreground-muted uppercase tracking-wide">
          {lang}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
        >
          <Icon name={copied ? 'check' : 'copy'} size={11} />
          <span>{copied ? t('chat.message.copy.copied') : t('chat.message.copy')}</span>
        </button>
      </div>
      <div className="bg-card p-3 overflow-x-auto">
        <pre className="text-xs font-mono leading-relaxed">
          <code>
            {tokenLines.map((tokens, i) => (
              <span key={`code-${i}`} className="block">
                <CodeTokens tokens={tokens} />
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  )
}

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i) => (
        <InlineNode key={`in-${i}`} node={node} />
      ))}
    </>
  )
}

function InlineNode({ node }: { node: Inline }) {
  switch (node.type) {
    case 'text':
      return <>{node.value}</>
    case 'code':
      return <code className={INLINE_CODE_CLASS}>{node.value}</code>
    case 'strong':
      return (
        <strong className="font-semibold text-foreground">
          <InlineNodes nodes={node.children} />
        </strong>
      )
    case 'em':
      return (
        <em className="italic">
          <InlineNodes nodes={node.children} />
        </em>
      )
    case 'del':
      return (
        <span className="line-through text-foreground-muted">
          <InlineNodes nodes={node.children} />
        </span>
      )
    case 'link':
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-brand hover:underline underline-offset-2 break-words"
        >
          <InlineNodes nodes={node.children} />
        </a>
      )
    case 'image':
      return <img src={node.src} alt={node.alt} className="max-w-full rounded-md my-1.5" />
    case 'br':
      return <br />
  }
}
