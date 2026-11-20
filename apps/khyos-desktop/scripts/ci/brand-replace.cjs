// ⚠️ 有损脚本，别随手跑：它从 zcode-analysis/i18n-zh.json（ZCode 真源）全量重新生成
// src/renderer/i18n/zh-CN.json —— 真源里没有的键会被静默删除（如编辑器功能的
// codeEditor.* 全族），CLAUDE.md 登记的有意分歧（settings.messageStreamShowReasoningDescription
// 等）也会被冲回真源文案。没有 dry-run，执行即覆写 tracked 文件。跑之前先 git diff
// 该文件确认无未提交改动，跑之后立刻 diff 核对删了哪些键、要不要手工补回。
const fs = require('fs')
const path = require('path')
// 品牌域名不在这里钉字面量：替换目标与生产域同源，域迁移/自托管时跟着 serviceDefaults 走，
// 不会出现「i18n 文案还指向旧主机」这种只改一半的分叉。
const { CLOUD_DEFAULT_HOST } = require('../../../../runtime/node/backend/src/constants/serviceDefaults')

const rawPath = path.join(__dirname, '../../zcode-analysis/i18n-zh.json')
const outputPath = path.join(__dirname, '../../src/renderer/i18n/zh-CN.json')

if (!fs.existsSync(rawPath)) {
  console.error('真源文件不存在:', rawPath)
  process.exit(1)
}

const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'))

function replaceBrand(obj) {
  const result = {}
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'object' && val !== null) {
      result[key] = replaceBrand(val)
    } else if (typeof val === 'string') {
      result[key] = val
        .replace(/ZCode/g, 'KhyOS')
        .replace(/zcode\.z\.ai/g, CLOUD_DEFAULT_HOST)
        .replace(/智谱/g, 'KhyOS')
        .replace(/GLM/g, 'KhyOS')
    } else {
      result[key] = val
    }
  }
  return result
}

const replaced = replaceBrand(raw)
const outputDir = path.dirname(outputPath)
fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(outputPath, JSON.stringify(replaced, null, 2))
console.log('品牌替换完成，已写入', outputPath)
console.log('总键数:', Object.keys(replaced).length)
