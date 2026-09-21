// Service endpoint single source of truth (SSOT).
//
// The first-party production backend domain lives HERE and ONLY here, so a
// domain migration or self-hosting changes exactly one line instead of leaving
// scattered modules pointing at a dead host. Every other module MUST import
// DEFAULT_BACKEND_URL from this file rather than hardcoding the literal — this
// is enforced by scripts/check-agent-rules.js (rule `no-hardcoded-prod-domain`,
// which exempts `constants/serviceDefaults.js` as the designated source of truth).
//
// Overridable at build time via Vite's VITE_BACKEND_URL environment variable.
export const DEFAULT_BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://khyquant.top'

// AI 管理前端（apps/ai-frontend）的**基准端口**，不是「它一定在这里」的契约：
// 基准端口被别的进程占用时，实际实例会漂到下一个空闲端口，因此消费方必须先做身份
// 探测（见 src/utils/aiFrontendEntry.js）再打开，不能直接拼出 8090 就跳。
// 基准值与 apps/ai-frontend、services/backend/src/constants/serviceDefaults.js 的同名基准一致。
export const AI_FRONTEND_BASE_PORT = Number(import.meta.env.VITE_AI_FRONTEND_PORT || 8090)
// 探测窗口：基准端口起往后扫多少个端口（与后端定位器的扫描窗口同量级）。
export const AI_FRONTEND_SCAN_WINDOW = 10
