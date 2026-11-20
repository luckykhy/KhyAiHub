// 命令分组目录（设置页「命令」页与 Ctrl+K 面板共用）。
// 键序即展示序：前段取后端 CATEGORIES 运行时键序（组名真源是后端，桌面复制就是
// 影子副本），后段是桌面补丁键。渲染层只按 key 归堆、按 label 显示，不自己编组名。
// 前段键数随后端变、桌面不设预期值：analysis 于 2026-11-12 收编进 CATEGORIES 末尾
// （真源今日 7 键）。写死「前 6 组」这类计数的注释会在下一次收编后变成假话。
export interface CommandGroup {
  key: string
  label: string
}
