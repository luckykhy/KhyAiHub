// khy-canary: Khy-20261102-331-J6SYY3ZC
import { TOKEN_CLASS, type Token } from './highlight'

// 令牌数组 → 着色后的 span 序列。高亮的唯一渲染出口：
// 源码视图（SourceView）与 Markdown 代码块（MarkdownPreview）共用，
// 保证同一段代码在两处的颜色完全一致。

export function CodeTokens({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, i) => {
        const cls = TOKEN_CLASS[token.kind]
        if (!cls) return <span key={`tk-${i}`}>{token.text}</span>
        return (
          <span key={`tk-${i}`} className={cls}>
            {token.text}
          </span>
        )
      })}
    </>
  )
}
