# scripts/quarantine — 源码入口缓冲区

## 这是什么

5-3-1 §4「入口缓冲：新代码禁直写核心域」在本仓的物理落点。判据真源
[`[RESEARCH-018] 5-3-1 架构符合性调研与迁移设计`](../../docs/11_报告/RESEARCH/[RESEARCH-018]%205-3-1架构符合性调研与迁移设计-2026-09-28.md)
§4 C-5，落地动作是同一篇 §3 的 **P5 行**：新代码必须先落
`D5/quarantine/<日期>/`，再按判据晋级进核心域。

## 为什么是 scripts/ 下面，而不是根级 `quarantine/`

1. 按 `[RESEARCH-018]` §2.2，D5 的第二层轴本来就是**生命周期阶段**
   （build / verify / record / **quarantine**），所以缓冲区的名字是 `quarantine`，
   它属于 D5 而不需要一个新根。
2. 根级目录白名单是**封闭集合**（`[MGMT-STD-001]` §1.3），新增根属
   `[DESIGN-LAY-005]` 的 A 档动作，而 A 档的前置（`[DESIGN-LAY-008]` 第 0 步
   `.git` 重建 + 引用审计）尚未闭合。
3. 最关键的一条：`scripts` 已经在 `DOMAIN-DEPS.json` 的 `D5.roots` 里，
   于是「任何运行时代码不得 require 进这里」这条**早已被
   `no-reach-into-archive` 强制**——缓冲区天然不可被依赖，不必再造第三条禁止边。
   把缓冲区别处放，就得为「不可依赖」再写一条规则。

## 怎么用（三步）

```text
scripts/quarantine/2026-09-28/myUnit/
  myThing.js
  myThing.test.js        ← 与源同目录（晋级判据 1）
  README.md              ← 单元级：谁要 / 为什么 / 怎么验（晋级判据 2，规则 9 三问）
  khy.module.json        ← 声明 domain / mayDependOn / fanIn / lifecycle.stage=staged
```

1. **入缓冲**：新写的单元先落在 `scripts/quarantine/<YYYY-MM-DD>/<单元名>/`，
   带一份 `khy.module.json`，`lifecycle.stage` 写 `staged`。
2. **达标**：补齐三条晋级判据（`DOMAIN-DEPS.json` 的 `_entry_buffer.promotionCriteria`）：
   单元目录有 `README.md`、manifest 有整数 `fanIn` 声明、每个源文件有同名同目录测试。
   `npm run check:layout` 的 `entry-buffer` 规则会逐条点名还缺哪一半。
3. **晋级**：判据齐了，把整个单元目录搬进它 `domain` 字段指名的核心域，
   并把 `lifecycle.stage` 改成 `stable`。
   ⚠ 第 3 步的搬移动作 = `git mv`，**在第 0 步 `.git` 重建闭合前禁止执行**
   （`git fsck` 尚有断链，rename 会把损坏写进历史）。所以缓冲区现在只收
   「全新写、尚未被任何核心域代码 require」的单元；存量文件的补记走下面那条路。

## 存量怎么办

核心域里已有的代码没有一份走过这个缓冲区——它们是**机制建立之前**就在的。
守卫对它们只做一件事：数「有多少核心域源文件还没有可用的生命周期记录」，
把那个数当成只降不升的棘轮（建档基线见 `scripts/ci/repo-layout-baseline.json`
的 `counts["entry-buffer"]`）。补记的方式是给单元目录放一份
`khy.module.json`，并在 `lifecycle` 里如实写
`"provenance": "recorded-after-the-fact"`——声明「这份记录是事后补的」，
而不是假装它走过缓冲。第一例：
`services/backend/src/services/domain/onboarding/`。

## 字段从哪来

不在本文件里定义 schema 真源。可机判的一切字段（核心域清单、缓冲区路径、
manifest 文件名、阶段取值、晋级判据）真源是
[`docs/10_规范/registry/DOMAIN-DEPS.json`](../../docs/10_规范/registry/DOMAIN-DEPS.json)
的 `_entry_buffer` 块，执行器是 `scripts/ci/check-repo-layout.js` 的
`checkEntryBuffer()`。改那张表就改了守卫，本文件只解释为什么这么放。
