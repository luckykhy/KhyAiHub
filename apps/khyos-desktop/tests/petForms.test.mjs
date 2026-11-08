/**
 * petForms —— 桌宠「形态」枚举的测试。
 *
 * 这一层跑的是纯函数（Node 22.6+ 类型剥离，直接 import .ts，不经构建），
 * 锁死三件事：
 *   ① 形态集合：三形态并存且顺序稳定（设置页三选一与卡片轮换共用这一份）；
 *   ② 轮换：立绘 → 3D → 真人 → 立绘，闭环；
 *   ③ 合法性：settings.json 里可能是任何东西，非法值一律判假。
 *
 * 「真人」这一形态的**资产**是可选的（外部 AI 3D 服务出的模没进仓时不存在），
 * 那一层的降级行为在 tests/khyPetModel.contract.test.cjs 里锁。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  PET_FORMS,
  PET_FORM_LABELS,
  PET_FORM_LONG_LABELS,
  PET_FORM_NEXT_LABELS,
  isPetForm,
  nextPetForm,
} = await import('../src/renderer/components/pet/petForms.ts')

test('形态集合：三形态并存，顺序稳定', () => {
  assert.deepEqual([...PET_FORMS], ['relief', 'model', 'realistic'])
  // 顺序稳定是契约：卡片头部轮换按钮按 PET_FORMS 的顺序走，
  // 设置页三选一也按同一顺序显示 —— 两处不许各排各的。
  assert.equal(PET_FORMS[0], 'relief', '默认形态必须是立绘浮雕（最像定妆照）')
  assert.equal(PET_FORMS.length, 3)
})

test('每个形态都有短名、长名与「点下去会切到哪个」的按钮文案', () => {
  for (const form of PET_FORMS) {
    assert.ok(PET_FORM_LABELS[form], `${form} 缺短名`)
    assert.ok(PET_FORM_LONG_LABELS[form], `${form} 缺长名`)
    assert.ok(PET_FORM_NEXT_LABELS[form], `${form} 缺按钮文案`)
    // 按钮文案说的是「下一个形态」，不是当前形态 —— 取证脚本按这个语义读按钮。
    assert.match(PET_FORM_NEXT_LABELS[form], /^切换到/)
  }
  // 短名要短：卡片头部只有 148px 宽，按钮上塞不下长句。
  for (const form of PET_FORMS) {
    assert.ok(PET_FORM_LABELS[form].length <= 2, `${form} 的短名太长`)
  }
})

test('轮换闭环：立绘 → 3D → 真人 → 立绘', () => {
  assert.equal(nextPetForm('relief'), 'model')
  assert.equal(nextPetForm('model'), 'realistic')
  assert.equal(nextPetForm('realistic'), 'relief')
  // 走一圈回到原点
  let form = 'relief'
  for (let i = 0; i < PET_FORMS.length; i += 1) form = nextPetForm(form)
  assert.equal(form, 'relief')
})

test('合法性：只认三种形态，其余一律判假（防止脏值进渲染层）', () => {
  for (const form of PET_FORMS) {
    assert.equal(isPetForm(form), true, `${form} 应当合法`)
  }
  for (const bad of ['', 'Realistic', 'RELIEF', 'chibi', null, undefined, 0, 1, {}, []]) {
    assert.equal(isPetForm(bad), false, `${JSON.stringify(bad)} 不该被判成合法形态`)
  }
})
