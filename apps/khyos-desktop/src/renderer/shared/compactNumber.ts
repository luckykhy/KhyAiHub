// Compact magnitude formatting for large counters (tokens, requests).
// Single source for the desktop UI — do not reintroduce per-component
// toLocaleString copies for the same numbers.

const UNITS: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000_000, 'T'],
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K'],
]

function formatScaled(scaled: number, symbol: string): string {
  const digits = Math.abs(scaled) >= 100 ? 0 : 1
  return `${scaled.toFixed(digits).replace(/\.0$/, '')}${symbol}`
}

export function formatCompactNumber(input: number): string {
  if (!Number.isFinite(input)) return '0'
  let n = input
  if (Math.abs(n) < 1_000) {
    const rounded = Math.round(n)
    if (Math.abs(rounded) < 1_000) return String(rounded)
    n = rounded
  }
  const abs = Math.abs(n)
  for (let i = 0; i < UNITS.length; i += 1) {
    const [value, symbol] = UNITS[i]
    if (abs < value) continue
    const scaled = n / value
    const digits = Math.abs(scaled) >= 100 ? 0 : 1
    // 999.95K rounds to 1000K; promote to the next unit instead.
    if (Math.abs(Number(scaled.toFixed(digits))) >= 1_000 && i > 0) {
      const [nextValue, nextSymbol] = UNITS[i - 1]
      return formatScaled(n / nextValue, nextSymbol)
    }
    return formatScaled(scaled, symbol)
  }
  const [topValue, topSymbol] = UNITS[0]
  return formatScaled(n / topValue, topSymbol)
}
