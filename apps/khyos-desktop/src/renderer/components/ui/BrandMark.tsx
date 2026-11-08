// khy-canary: Khy-20261102-320-VZ4YP7V5
import { useId } from 'react'

/**
 * BrandMark — Khy OS 品牌主标（内核环）。
 *
 * 形态：四段弧叶围成的光圈（= 四条主张）+ 中心菱形内核（= kernel / runtime），
 * 内核上刻一道 K 形负槽（= 品牌字母，可发现但不主导读感）。
 *
 * 几何真源：`delivery/brand/khy-brand-geometry.js` —— 本文件里的路径数据是它的**副本**，
 * 由 `apps/khyos-desktop/tests/brandMark.test.cjs` 断言两者逐字节一致。
 * 改形状请改真源后跑 `node scripts/brand/build-brand-assets.js`，不要手改这里。
 */
export function BrandMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  // 渐变 id 必须逐实例唯一：同页可能出现多个主标，id 撞车会让后者取到前者的定义。
  const gradId = `khyBrandMark${useId().replace(/:/g, '')}`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      className={className}
      role="img"
      aria-label="Khy OS"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand-from, #FFC078)" />
          <stop offset="1" stopColor="var(--brand-to, #E2703A)" />
        </linearGradient>
      </defs>
      <g fill={`url(#${gradId})`}>
        <path d="M 101.532 69.945 A 38 38 0 0 1 69.945 101.532 L 61.647 90.897 A 27 27 0 0 0 88.854 74.55 Z" />
        <path d="M 58.055 101.532 A 38 38 0 0 1 26.468 69.945 L 37.103 61.647 A 27 27 0 0 0 53.45 88.854 Z" />
        <path d="M 26.468 58.055 A 38 38 0 0 1 58.055 26.468 L 66.353 37.103 A 27 27 0 0 0 39.146 53.45 Z" />
        <path d="M 69.945 26.468 A 38 38 0 0 1 101.532 58.055 L 90.897 66.353 A 27 27 0 0 0 74.55 39.146 Z" />
      </g>
      {/* 菱形内核 + K 形负槽（evenodd ⇒ 槽是真洞，不是描边）。 */}
      <path
        fill={`url(#${gradId})`}
        fillRule="evenodd"
        d="M 64 45 L 83 64 L 64 83 L 45 64 Z M 56 74 L 60 74 L 60 54 L 56 54 Z M 60 66.75 L 70 59.5 L 70 54 L 60 61.25 Z M 60 66.75 L 70 74 L 70 68.5 L 60 61.25 Z"
      />
    </svg>
  )
}
