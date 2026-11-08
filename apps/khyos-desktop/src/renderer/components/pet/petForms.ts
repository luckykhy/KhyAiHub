/**
 * petForms —— 桌宠的「形态」枚举与文案。
 *
 * 真源只有一个：settings.json 的 `desktopPetForm`。这里只定义**取值集合**与
 * 中文名，不持有状态——设置页与桌宠卡片读同一份 settings、写同一个键，
 * 不另开 localStorage（那是第二个真源）。
 *
 * 三种形态并存（人的拍板，2026-11-04）：
 *   relief    立绘浮雕 —— 把定妆照烘成带厚度的 2.5D 网格，像素级最像本人（默认）
 *   model     真 3D 模型 —— 程序化 Q 版造型，可整圈转
 *   realistic 写实真人 3D —— 外部 AI 3D 服务 image-to-3D 出的 GLB，真人比例
 *
 * 这个模块**不碰资产、不碰 React**：纯类型 + 纯常量，
 * 设置页与桌宠卡片都从这里取，避免同一份文案在两处各写一遍。
 */

export type PetForm = 'relief' | 'model' | 'realistic'

/** 形态的稳定顺序：设置页三选一与卡片头部轮换按钮共用这一份。 */
export const PET_FORMS: readonly PetForm[] = ['relief', 'model', 'realistic'] as const

/** 形态的短名（卡片头部那个小按钮上显示的就是当前形态）。 */
export const PET_FORM_LABELS: Record<PetForm, string> = {
  relief: '立绘',
  model: '3D',
  realistic: '真人',
}

/** 形态的长名（设置页选项文案用）。 */
export const PET_FORM_LONG_LABELS: Record<PetForm, string> = {
  relief: '立绘浮雕',
  model: '3D 模型',
  realistic: '写实真人 3D',
}

/**
 * 卡片头部那个小按钮的 aria-label：**说的是「点下去会切到哪个形态」**。
 * 取证脚本按这个语义读按钮（曾写反过一次），所以文案集中在这里。
 */
export const PET_FORM_NEXT_LABELS: Record<PetForm, string> = {
  relief: '切换到3D模型',
  model: '切换到真人模型',
  realistic: '切换到立绘形态',
}

/** 轮换到下一个形态：relief → model → realistic → relief。 */
export function nextPetForm(form: PetForm): PetForm {
  const index = PET_FORMS.indexOf(form)
  return PET_FORMS[(index + 1) % PET_FORMS.length]
}

/**
 * 形态值是否合法。settings.json 里可能是任何东西：旧版本写的值、
 * 手改过的值、别的分支留下的值——一律当非法，退回默认。
 */
export function isPetForm(value: unknown): value is PetForm {
  return value === 'relief' || value === 'model' || value === 'realistic'
}
