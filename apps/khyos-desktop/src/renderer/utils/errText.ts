// errText — 把未知异常压成一句可读的真实原因。
//
// 为什么需要它：面板里大量 `.catch(() => setX('…失败：主进程无响应，请重启应用'))`
// ——那句话没说错，但把真正的异常原因丢在了地里。用户拿着「主进程无响应」去排查，
// 实际可能只是一个 JSON 字段缺失。仓库规则 2.2 要求错误消息带识别码，异常原文
// 就是最硬的识别码。
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || String(err)
  if (typeof err === 'string') return err
  try {
    const s = JSON.stringify(err)
    return s && s !== '{}' ? s : String(err)
  } catch {
    return String(err)
  }
}
