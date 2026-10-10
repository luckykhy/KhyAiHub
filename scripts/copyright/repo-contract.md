# 本仓口径覆盖（khy-os repo contract）

上游 `vendor/software-copyright-materials/` 逐字入库、**一行未改**（见
`upstream-manifest.json`，`[DESIGN-SOURCING-001]` B-M1 #5）。本文件是本仓对它的**唯一**
覆盖层：两者冲突时以本文件为准，语义真源是 `[DESIGN-IP-002]`。
守卫 `scripts/ci/check-copyright-readiness.js` 会检查本文件的存在与关键小节，
缺失即报 `copyright-overlay-missing` —— 因为一旦本文件消失，上游默认口径会静默生效。

## 1. 名称与版本的真源

上游要求正式资料的软件全称/版本号取自 `草稿/申请表信息.md`。在本仓：

- 唯一真源 = `docs/10_规范/registry/COPYRIGHT.json`（登记全称 / 登记版本 / 工程版本）；
- `草稿/申请表信息.md` 只能**抄**这份登记，不得自造，也不得用 `package.json` 之外的推测值；
- 页眉、文件名、正文标题一律使用该登记的「软件全称 + 登记版本」，
  与 `--version` / `khy about` 画面的**工程版本**双口径关系见 `[DESIGN-IP-001]` C-MAT2。

## 2. 60 页选材的真源（覆盖上游「优先抽取前端代码」）

上游 SKILL.md 写「优先抽取前端代码：入口、路由、页面、核心组件」，
`scripts/propose_code_selection.py` 亦按 `FRONTEND_EXTS` 给候选打 `selection_tier=frontend`。
**在本仓这只用于排序候选，不得用于决定选材结论。** 结论的唯一真源是
`docs/10_规范/registry/COPYRIGHT-MATERIALS.json`：

- 前 30 页 = 启动链（Python 层入口 → 环境检测 → Node 供给）；
- 后 30 页 = 手写内核（引导 → 中断 → 调度 → 内存 → 进程）；
- 编制原则是「按运行时调用顺序串成一条链，不东摘西摘」，不是「审核员易读的前端优先」；
- `草稿/代码文件选择.json` 必须由这份登记派生，`model_reason` 逐条引用登记条目；
- 每页 ≥50 行的口径、行数换算与「剥注释口径」以该登记的 `页数要求` 段为准，
  不用上游 `propose_code_selection.py` 的默认估算替代。

原因：登记客体是「Khy OS 平台底座」，全称里每个词都得在页内有代码（C-MAT1/C-MAT3）；
`apps/ai-frontend` 与 `software/khyquant/frontend` 属于其它界面载体，khyquant 更是独立项目
（另案申报），按上游前端优先会把材料导向与本件无关的载体。

## 3. 第三方与生成物边界

`vendor/`、`*_gen.*`、`*_blob.h`、字体数据表、`dist/`、`out/`、`unpacked/`、`node_modules/`
不得进登记材料（C-X3）。本 vendored 目录刻意落在含 `vendor` 路径段的位置，
使既有排除规则**天然命中**，无需第二份排除清单。

## 4. 输出落点

上游固定输出目录为当前工作目录下的 `软件著作权申请资料/`。在本仓：

- 草稿与中间产物：`软件著作权申请资料/`（仓库根，gitignore，属本机态）；
- 正式 Word/TXT：收进 `evidence/06_申报材料/` 的对应件，不另起第二份材料树；
- 上游 `生成demo/` 与本仓无关，未随 vendored 入库。

## 5. 门禁对齐

上游 7 个 `STOP_FOR_USER` 门禁（environment / project / business / application-fields /
code-selection / screenshot-method / markdown）在本仓**一个都不放宽**，并且：

- `business` 与 `code-selection` 两个门禁的确认对象是本文件 §1–§2 的两份登记；
- `screenshot-method` 选出的截图必须落入 `evidence/03_图片/` 的四类口径（C-MAT1）；
- 任何门禁不得用「用户未选择则默认继续」绕过（上游原文同款红线）。

## 6. 环境前置

- Python 3.10+（本仓实测 3.11.9：`D:\Portable\Python\python.exe`）；
- DOCX 后端 OfficeCLI 固定验证版本 `1.0.151`，运行时 `OFFICECLI_SKIP_UPDATE=1`；
  缺失或版本不符时必须停下问人（上游 environment 门禁），不得静默安装、
  不得回退到 python-docx/Pandoc/.NET；
- 无 OfficeCLI 时只生成 Markdown/TXT，不得伪报 DOCX 成功。
