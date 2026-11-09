// khy-canary: Khy-20261102-335-6QJZWPZV
import { useMemo } from 'react'
import { CodeTokens } from './CodeTokens'
import { highlightLines, type ViewerLanguage } from './highlight'

// 源码视图 —— 文件查看器的「源码」形态。
//
// 两个此前缺失的能力在这里接上（设计稿 §5.7）：
//   1. 行号：读「设置 → 外观 → 行号显示」（settings.codeLineNumbers）。
//      行号按**逻辑行**编号（内容按 \n 切分后的下标），所以开自动换行时
//      长行折成多行也不会让后面的行号错位。
//   2. 语法高亮：读「设置 → 外观 → 代码块语法高亮」（settings.codeHighlight），
//      关闭时退化为纯文本，颜色与设置无关（只影响着色，不影响可读性）。
//
// 布局：不开行号时保持单个 <pre>（与旧版一致，横向滚动由 pre 负责）；
// 开行号时改成「每行一个 flex 行」—— 行号槽 sticky 贴左，横向滚动时
// 行号不被代码推走；代码列在换行模式下占满剩余宽度并折行。

interface SourceViewProps {
  content: string
  language: ViewerLanguage
  showLineNumbers: boolean
  highlight: boolean
  wrap: boolean
}

export function SourceView({
  content,
  language,
  showLineNumbers,
  highlight,
  wrap,
}: SourceViewProps) {
  const lines = useMemo(() => content.split('\n'), [content])
  const tokenLines = useMemo(
    () => (highlight ? highlightLines(lines, language) : null),
    [lines, language, highlight],
  )

  if (!showLineNumbers) {
    return (
      <pre
        className={`text-xs font-mono text-foreground/90 leading-relaxed p-4 ${
          wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
        }`}
      >
        <code>
          {tokenLines
            ? tokenLines.map((tokens, i) => (
                <span key={`src-${i}`}>
                  <CodeTokens tokens={tokens} />
                  {i < lines.length - 1 ? '\n' : ''}
                </span>
              ))
            : content}
        </code>
      </pre>
    )
  }

  return (
    <div className="py-2 text-xs font-mono leading-relaxed">
      {lines.map((line, i) => (
        <div key={`row-${i}`} className={wrap ? 'flex' : 'flex w-max min-w-full'}>
          <span
            aria-hidden="true"
            className="sticky left-0 z-10 shrink-0 w-10 pr-3 text-right select-none text-foreground-muted bg-panel"
          >
            {i + 1}
          </span>
          <span
            className={
              wrap
                ? 'flex-1 min-w-0 pr-4 whitespace-pre-wrap break-all'
                : 'whitespace-pre pr-4'
            }
          >
            {tokenLines ? <CodeTokens tokens={tokenLines[i]} /> : line}
          </span>
        </div>
      ))}
    </div>
  )
}
