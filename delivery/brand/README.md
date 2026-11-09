# Khy OS 品牌资产包（内核环）

> 单一真源：[`khy-brand-geometry.js`](./khy-brand-geometry.js)（几何 + 配色，纯叶子、零 IO）。
> 构建脚本：`node scripts/brand/build-brand-assets.js` —— 改形状只改真源，然后重跑构建；
> **不要手改** `svg/` `png/` `icon/` 与 `runtime/node/backend/src/cli/tui/brandPixelArt.js`（生成物会被覆盖）。
> 预览页：[`preview.html`](./preview.html)（浏览器直接打开；与资产同源生成，不会出现「文档里的图是旧的」）。

---

## 1. 这枚标记是什么

**「内核环」** —— 四段弧叶围成一枚光圈，中心一枚菱形内核，内核上刻一道 K 形负槽。

| 元素 | 语义 | 对应真源 |
|---|---|---|
| 四段弧叶 | 四条主张：订阅套利 / 随身性 / 本土化 / 私有与便携 | `runtime/node/backend/src/constants/positioning.js` 的 `POSITIONING.claims` |
| 中心菱形 | 内核：kernel / runtime（模型调用被当作系统调用统一收口的那一层） | 同上 `POSITIONING.os.layers` |
| 内核上的 K 负槽 | 品牌字母 —— **可发现，但不主导读感** | — |
| 墨黑底 + 琥珀橙 | 品牌气质：本地、私密、终端、工程 | 见 §3 |

### 为什么不是「字母 K」

2026-10-25 之前，五端各画各的：Web 排版一个字母 K、APK 是 `Text('K')`、桌面端一个 `icon.ico`、
TUI 另有一枚 13×9 像素四叶草、CC 模式是 `✳ Khy` 字标 —— 同一进程里先后出现三种品牌样子，
正是 `[DESIGN-ARCH-134]` §1.1 B3 登记的病灶。

设计阶段实测过三条路线并被否决：

1. **通用四叶草 + 排版体 K** —— 四叶草是 2020 年代视觉通货膨胀区，且与仓内旧像素四叶草撞形；
   更关键的是，**任何排版体 K（无论装在什么容器里）读感都是「字母 K」**，与原始诉求正面冲突。
2. **四臂旋排的光圈 / 旋核** —— 四臂旋转对称在形制上过于接近卐形，不采用。
3. **蓝→紫→品红渐变** —— 2023 年后 AI 产品的通用色系，一屏之下全是同一个模子。

最终路线：**抽象几何主体（光圈 + 内核）+ 藏在负形里的字母**。字母不再是主体，而是内核上的一道刻痕。

---

## 2. 资产清单

| 文件 | 用途 |
|---|---|
| `svg/khy-kernel-mark.svg` | 主标（琥珀渐变） |
| `svg/khy-kernel-mark-mono-ink.svg` / `-mono-paper.svg` | 单色版（单色印刷 / 浅底 / 深底） |
| `svg/khy-os-lockup.svg` | 横向锁定组合：标 + 字标「khy OS」 |
| `svg/khy-os-lockup-mono-ink.svg` / `-mono-paper.svg` | 锁定组合的单色版 |
| `svg/khy-os-wordmark-outlined.svg` / `-paper.svg` | **字标单独图样**（文字商标申请用，已轮廓化） |
| `svg/khy-os-filing-mark.svg` | **图形单独图样**（图形商标申请用，黑色 + 留白） |
| `svg/khy-os-app-icon.svg` | 应用图标（墨黑圆角底 + 标） |
| `svg/khy-os-app-icon-maskable.svg` | Android 自适应图标（铺满底 + 安全区内的标） |
| `svg/khy-os-favicon.svg` | favicon（**紧凑几何**：实心内核、无 K 槽） |
| `png/khy-os-icon-{16…512}.png` | 应用图标位图 |
| `png/khy-os-mark-{16…512}.png` | 透明底主标位图 |
| `png/khy-os-favicon-{16,32}.png` | favicon 位图 |
| `icon/khy-os.ico` | 多尺寸 ICO（16/24/32/48/64/128/256） |
| `khy-brand-tokens.json` | 五端品牌令牌取值（机器可读） |
| `khy-brand-wordmark.js` | 字标的**矢量轮廓**（生成物，见下） |
| `preview.html` | 品牌预览页（与资产同源生成） |
| `filing.html` | **商标申请图样页**：图形 / 文字 / 组合三件分开排在白底上 |

### 各端落点

| 端 | 落点 | 形式 |
|---|---|---|
| Web | `delivery/web/ai-frontend/src/components/KhyMark.vue`（主标）/ `KhyLogo.vue`（品牌块） | 内联 SVG（可换色） |
| Web | `delivery/web/ai-frontend/public/favicon.svg`、`favicon-32.png`、`apple-touch-icon.png` | 静态资源 |
| 桌面端 | `apps/khyos-desktop/src/renderer/components/ui/BrandMark.tsx`（主标）/ `TitleBar.tsx`（标题栏品牌块） | 内联 SVG |
| 桌面端 | `apps/khyos-desktop/{resources/icon,public}/icon.ico`、`launcher/khyos.ico` | 多尺寸 ICO |
| 移动端 | `delivery/mobile/khy-os-client-app/lib/ui/widgets/khy_brand_mark.dart`（主标 + 品牌块） | PNG 资源（`assets/brand/`） |
| 移动端 | `.../android/app/src/main/res/mipmap-*/ic_launcher{,_foreground}.png` | 各密度 + 自适应前景 |
| TUI | `runtime/node/backend/src/cli/tui/logoArt.js` → `brandPixelArt.js`（生成物） | 13×13 字符点阵 + 三档明暗 |

**副本与漂移**：Web / 桌面端 / TUI 三处都持有路径数据的副本（跨目录 import 真源会让 dev 与 build
行为不一致），由测试锁住：

- `delivery/web/ai-frontend/src/components/__tests__/KhyMark.contract.test.js`
- `apps/khyos-desktop/tests/brandMark.test.cjs`
- `runtime/node/backend/tests/cli/tui/logoArt.test.js`

---

## 3. 配色与对比度（全部为实测值，WCAG 2.2）

| 令牌 | 值 | 用途 | 实测对比度 |
|---|---|---|---|
| amber-300 | `#FFC078` | 图形渐变亮端 | 装饰用，不作文字色 |
| amber-400 | `#F0A868` | **暗底上的文本安全琥珀** | 对 `#14110E` 9.41:1；对 `#171920` 8.78:1；对 `#0A0E1C` 9.62:1 |
| amber-500 | `#E2703A` | 图形主色 / 渐变暗端 | 对白底 3.18:1（够 UI 图形门槛） |
| amber-600 | `#C2551F` | 浅底上的 UI 强调 | 对白底 4.55:1 |
| amber-700 | `#9C4116` | **浅底上的文本安全琥珀** | 对白底 6.60:1；对 `#F6F2EC` 5.92:1；对 `#f6f7f9` 6.16:1 |
| ink | `#14110E` | 品牌底板 / 负形 | 对 paper 18.81:1 |
| paper | `#F6F2EC` | 纸底 | — |

### 五端 accent 同步取值

| 端 | 亮 | 暗 | 令牌名 |
|---|---|---|---|
| Web | `#9c4116` | `#f0a868` | `--khy-primary` |
| 桌面端 | `#9c4116` | `#f0a868` | `--color-brand` / `--color-primary` |
| 移动端 | —（深空底） | `#f0a868` | `AppColors.primary` |
| TUI | —（暗终端） | `#f0a868` | `ccTheme` 的 `brand` |
| khyquant | `#1890ff` | — | **保持金融蓝**：它是独立项目，红色/绿色另有 A 股涨跌语义，不随平台品牌迁移 |

登记于 `docs/10_规范/registry/AESTHETICS-TOKENS.json` 的 `color.accent`（平台基准 = Web）。

---

## 4. 使用禁区

- **不要**把主标换成蓝→紫→品红渐变。那是 AI 行业的通用色，一屏之下全是同一个模子。
- **不要**给主标加描边、投影或外发光。它在 16px 下必须仍然读得出「四段环 + 中心核」。
- **不要**把 K 槽单独拿出来当字标用 —— 它是负形的一部分，脱离内核就不再是这枚标记。
- **不要**在纸底上直接用 amber-300 / amber-400（对比度 1.4–2.0，不达文字门槛）。
- **必须**：品牌块底色统一用墨黑 `#14110E`；主标在墨底与纸底都用同一枚琥珀渐变。
- **必须**：≥48px 用完整几何（含 K 槽）；≤32px 用紧凑几何（实心内核、无 K 槽）。

---

## 5. 商标注册的待办（人来做）

本包是**设计**交付物，不等于**注册**。图形与文字**分开申请**的两件图样已备好
（`svg/khy-os-filing-mark.svg` 图形 / `svg/khy-os-wordmark-outlined.svg` 文字，
白底排版见 `filing.html`），剩余步骤仍需人工完成：

1. **近似检索**（图形商标需按维也纳编码做图形近似检索）：
   - 官方：中国商标网 <https://sbj.cnipa.gov.cn/>（综合查询 / 近似查询 / 图形查询；数据有 3–6 个月盲期，仅供参考）
   - 第三方：阿里云商标检索 <https://tm.aliyun.com/>、标库网 <https://www.tmkoo.com/>
2. **类别建议**（按《类似商品和服务区分表》）：第 9 类（可下载软件 / 应用软件）、
   第 42 类（SaaS / 平台服务）、第 35 类（零售/销售服务）为本产品主战场；
   若做硬件或周边再议第 14/16 类。
3. **申请拆分**：建议 **图形商标（内核环）+ 文字商标（khy / khy OS / KHYOS）分别申请** ——
   图形单独申请才能覆盖「字母变体」，文字商标则覆盖拼写保护。组合图样只作整体保护。
4. **留档**：把本目录的 `svg/`、`filing.html` 与本文件一起归档，作为申请时的图样来源。
5. ~~递交前把字标转轮廓~~ —— **已做完**（见下）。

### 字标轮廓化（已完成，2026-10-25）

原先锁定组合里的字标是 `<text font-family="…">`：递交方机器上缺字体就会走样。
现由 `scripts/brand/convert-wordmark-to-outlines.js` 解析本机 TrueType 字体
（`segoeuib.ttf`）的 `cmap`/`loca`/`glyf` 三张表，取出字形轮廓并转成 SVG 二次贝塞尔路径，
产出 `delivery/brand/khy-brand-wordmark.js`（生成物）。
**所有锁定组合与字标图样里已无 `<text>` 元素** —— 任何机器打开都一样，可直接递交。

> 字体本身仍受其授权约束（本包只取字形轮廓作为图形数据，不分发字体文件）。若正式申请
> 要求与自有字体完全一致，用品牌自有字体重跑一次该脚本即可（`--font <路径>`）。

---

## 6. 变更记录

| 日期 | 变更 | 依据 |
|---|---|---|
| 2026-10-25 | 设立品牌资产包，五端统一到「内核环」主标与琥珀族 | 人选定方向：**内核四瓣 · 琥珀橙 · 资产包 + 落地 + 五端令牌统一**；明确否决「蓝→紫→品红渐变」 |
