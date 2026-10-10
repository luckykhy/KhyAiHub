/**
 * Strip model-facing control text from user-visible message content.
 *
 * The backend agentic loop injects `[SYSTEM: ...]` steering blocks (change-watch
 * verdicts, task-closure nudges, loop protection...) into the prompt it sends to
 * the model, and that augmented prompt is what gets persisted as the user turn
 * (toolUseLoopCore pushes `currentMessage` into conversationMessages). Loading a
 * session therefore renders internal control text inside the user's bubble —
 * a system-prompt leak (固定缺陷: 消息面板暴露系统提示词).
 *
 * Mirrors the backend's single source `stripInternalControlText`
 * (services/backend/src/cli/repl/displayFormatters.js) — same regexes, display
 * only; the model-facing copy is untouched. Pure functions, no I/O.
 */

// Whole model-only nudge blocks. The backend builds these without an inner `]`
// before the closing one, so lazy match to the first `]` is exact.
const SYSTEM_BLOCK = /\[SYSTEM:[\s\S]*?\]/g
// Tag-only control markers that may precede human-readable text.
const TAG_MARKERS = /\[(?:STOP|LoopDetector:[^\]]*|LoopWarning:[^\]]*)\]/g

/** Remove inject blocks + collapse whitespace, keeping line structure. */
export function stripSystemInjectBlocks(s: string): string {
  if (typeof s !== 'string' || !s) return ''
  return s
    .replace(SYSTEM_BLOCK, '')
    .replace(TAG_MARKERS, '')
    .split('\n')
    .map((ln) => ln.replace(/[ \t]+/g, ' ').trim())
    .filter((ln) => ln !== '')
    .join('\n')
    .trim()
}

/**
 * Display-safe user message content: the raw text with every injected
 * `[SYSTEM: ...]` block removed. Returns '' when the message was ENTIRELY an
 * inject (synthetic steering turn, e.g. the task-closure nudge) — callers
 * should drop such messages instead of rendering an empty bubble.
 */
export function sanitizeUserContent(s: string): string {
  return stripSystemInjectBlocks(s)
}
