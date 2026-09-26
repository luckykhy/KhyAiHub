---
name: 可交付性基线
id: PROCESS-014
domain: PROCESS
nature: 约束为主，兼权力与福利
scope: "本仓库一切「交付给外部」的路径，五组：① 交付物完整性 —— 仓库克隆完整性（git 对象库无洞、历史可完整遍历）、工作区与某个已提交状态一致、发布产物真实存在（dist/ 的 wheel / sdist / tarball 非零字节）；② 失败可见性 —— 发布链上的签名 / 校验和 / 审计类步骤不得被 `|| echo`、`|| true`、`continue-on-error: true` 吞掉；③ 产物可验证性 —— 校验和与 SBOM 必须生成**且**被发布或被消费；④ 端到端黄金路径与边界声明（含「不支持清单」）；⑤ 产品任务面本身 —— CLI 命令 / 别名 / handler 与规则条目数的棘轮（[DESIGN-DELIV-002] §2.3）。**不含**两类：仓库内部一致性（分层 / 命名 / 登记 / 孪生件 / 规则卡 —— 由既有规则管辖，本条刻意不重复）；构建机或用户本机环境的网络与镜像选择（PROCESS-013 管辖）。"
priority: P1
trigger: "新增或修改交付渠道 / 发布 workflow / 构建脚本 / 边界文档时；新增 CLI 命令、别名或规则条目时；发版前；以及任何时候想回答「现在能不能交出去」时。"
constraint: "D1–D10 十条判据 + 任务面棘轮 + 渠道 CI 完备性，由 scripts/ci/check-delivery-baseline.js 机械执行，**阈值与任务面基线全部来自** [DESIGN-DELIV-002] §4 的 `$schema=khy-delivery-surface/1` JSON 块（阈值外部化，不得硬编码在检查器内部）。D1 仓库完整性：`git fsck` 的 missing blob / missing tree / missing commit / broken link / cache-table 失效计数全为 0，且 `git log --oneline --all` 退出码为 0。D2 发布物：`dist/` 内 wheel 与 sdist 均存在且非零字节。D3 克隆零缺件：`git status --porcelain` 的 `??` 与 `D` 计数均为 0。D4 失败阻断：发布相关文件里，行内同时命中「校验类词（sign/verify/checksum/audit/sbom）」与「吞错词（`|| echo`/`|| true`/`continue-on-error: true`）」的计数为 0（注释行不参与判定）。D5 校验和：必须存在生成点，且同一文件内可见其被发布出去的回路，否则判「生成但无回路」。D6 SBOM：必须存在生成点，且同一条 workflow 内存在消费步骤（grype / osv-scanner / trivy / anchore / cyclonedx validate），只 upload-artifact 判不合格。D7 债务棘轮：复用既有 scripts/ci/check-debt-ledger.js（退出码 0 为通过），不新建机制。D8 阶段结算：与发布门相关的机制不得在 S1/S2 停留超过 s1MaxDays（默认 90 天），逾期即不合格。D9 黄金路径：必须存在 scripts/ci/check-golden-path.js **且**被 releaseGateStages.js 引用。D10 边界：边界文档必须存在且含「不支持清单」。棘轮：命令 / 别名 / handler / 规则条目四项实测值不得超过 §4 登记的基线（只降不升），且重测口径必须与基线登记的方法一致。渠道：声明的每个交付渠道要么有 ciWorkflow，要么已在边界文档声明为不承诺交付。检查器**不得**在阈值真源缺失时退回内置默认值 —— 删除真源必须报 delivery-thresholds-missing，使读数失去意义而非静默继续。"
grants: "授权用一条命令取得可交付性的全量读数（npm run check:delivery）与机读结果（--json，供测试与看板消费）；授权在 CI / 发版前以 recommend 档运行它，把「能不能交出去」从评审意见变成可回归的数字；授权维护者**冻结**命令面（棘轮只降不升）——即有权拒绝「再加一个命令」而不必逐个论证该命令无用，只需指出棘轮已满；授权在退役命令后**下调**基线，从而把「一进一出」变成可操作的动作而非口号；授权按 [DESIGN-DELIV-002] §5.2 的既定路径升阶到阻断档（改执行器 STAGE 常量 + 登记表 severity + 发布门该阶段 tier，回退为反向改回）。判据不满足时不再持有「以内部一致性通过来替代交付物存在」的余地，但持有「声明豁免并写复核到期日」的权力。"
benefit: "把「交付」从一个无法反驳也无法验证的感受，变成一个可跑、可机读、可回归的记分板。实测起点（2026-09-24）：dist/ 不存在（可安装包从未在本机产出过）、发布链上 2 处 sigstore 签名失败被 `|| echo` 吞掉、SBOM 只 upload-artifact 无任何消费者、无黄金路径检查、仓库根躺着 4 个 shell 重定向事故文件。这些**没有一个会让既有守卫变红** —— 93 条规则守的是仓库内部自洽，75 个 check-* 里 0 个检查「产物是否存在」。本规则给出的是第一个指向外部的表针，并同时给出任务面的封闭边界，使「完全不支持的任务」（如 Windows arm64、真实下单、无 CI 的三条渠道）被写明而非留白。"
exception: "两类：① 与单次提交无关的全仓状态读数（D1 仓库完整性 / D2 发布物 / D3 克隆零缺件 / D7 债务棘轮）在 `--changed` 下**不报** —— 一个 pre-commit 钩子不应要求本机存在发布产物；但任务面棘轮恒报，因为命令数与规则数正是提交动作直接改变的。② 声明「本仓不做签名」并移除相应步骤，是合法的收敛方向（D4 判的是「失败被吞掉」，不是「必须有签名」）—— 移除优于吞掉。阶段豁免：本条按 [DESIGN-PROCESS-002] / PROCESS-008 落地为 **S1 观察者**（gate=commit 会跑 + severity=advisory 只记录），[DESIGN-DELIV-001] §4.3 关于「D1/D4/D7 可直进 S3」的主张**未自动采纳**，需一次显式人工裁决。"
version: "1.0.0 (2026-09-24)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-DELIV-001] 可交付性判断标准.md / docs/10_规范/其它规范/[DESIGN-DELIV-002] 产品任务面与交付律.md"
formerly: 无
owner: governance-team
---

# [PROCESS-014] 可交付性基线

<!-- RULES-REGISTRY: PROCESS-014 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-DELIV-001] 可交付性判断标准.md / docs/10_规范/其它规范/[DESIGN-DELIV-002] 产品任务面与交付律.md。

## 约束

D1–D10 十条判据 + 任务面棘轮 + 渠道 CI 完备性，由 scripts/ci/check-delivery-baseline.js 机械执行，**阈值与任务面基线全部来自** [DESIGN-DELIV-002] §4 的 `$schema=khy-delivery-surface/1` JSON 块（阈值外部化，不得硬编码在检查器内部）。D1 仓库完整性：`git fsck` 的 missing blob / missing tree / missing commit / broken link / cache-table 失效计数全为 0，且 `git log --oneline --all` 退出码为 0。D2 发布物：`dist/` 内 wheel 与 sdist 均存在且非零字节。D3 克隆零缺件：`git status --porcelain` 的 `??` 与 `D` 计数均为 0。D4 失败阻断：发布相关文件里，行内同时命中「校验类词（sign/verify/checksum/audit/sbom）」与「吞错词（`|| echo`/`|| true`/`continue-on-error: true`）」的计数为 0（注释行不参与判定）。D5 校验和：必须存在生成点，且同一文件内可见其被发布出去的回路，否则判「生成但无回路」。D6 SBOM：必须存在生成点，且同一条 workflow 内存在消费步骤（grype / osv-scanner / trivy / anchore / cyclonedx validate），只 upload-artifact 判不合格。D7 债务棘轮：复用既有 scripts/ci/check-debt-ledger.js（退出码 0 为通过），不新建机制。D8 阶段结算：与发布门相关的机制不得在 S1/S2 停留超过 s1MaxDays（默认 90 天），逾期即不合格。D9 黄金路径：必须存在 scripts/ci/check-golden-path.js **且**被 releaseGateStages.js 引用。D10 边界：边界文档必须存在且含「不支持清单」。棘轮：命令 / 别名 / handler / 规则条目四项实测值不得超过 §4 登记的基线（只降不升），且重测口径必须与基线登记的方法一致。渠道：声明的每个交付渠道要么有 ciWorkflow，要么已在边界文档声明为不承诺交付。检查器**不得**在阈值真源缺失时退回内置默认值 —— 删除真源必须报 delivery-thresholds-missing，使读数失去意义而非静默继续。

## 授予权力

授权用一条命令取得可交付性的全量读数（npm run check:delivery）与机读结果（--json，供测试与看板消费）；授权在 CI / 发版前以 recommend 档运行它，把「能不能交出去」从评审意见变成可回归的数字；授权维护者**冻结**命令面（棘轮只降不升）——即有权拒绝「再加一个命令」而不必逐个论证该命令无用，只需指出棘轮已满；授权在退役命令后**下调**基线，从而把「一进一出」变成可操作的动作而非口号；授权按 [DESIGN-DELIV-002] §5.2 的既定路径升阶到阻断档（改执行器 STAGE 常量 + 登记表 severity + 发布门该阶段 tier，回退为反向改回）。判据不满足时不再持有「以内部一致性通过来替代交付物存在」的余地，但持有「声明豁免并写复核到期日」的权力。

## 提供福利

把「交付」从一个无法反驳也无法验证的感受，变成一个可跑、可机读、可回归的记分板。实测起点（2026-09-24）：dist/ 不存在（可安装包从未在本机产出过）、发布链上 2 处 sigstore 签名失败被 `|| echo` 吞掉、SBOM 只 upload-artifact 无任何消费者、无黄金路径检查、仓库根躺着 4 个 shell 重定向事故文件。这些**没有一个会让既有守卫变红** —— 93 条规则守的是仓库内部自洽，75 个 check-* 里 0 个检查「产物是否存在」。本规则给出的是第一个指向外部的表针，并同时给出任务面的封闭边界，使「完全不支持的任务」（如 Windows arm64、真实下单、无 CI 的三条渠道）被写明而非留白。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

两类：① 与单次提交无关的全仓状态读数（D1 仓库完整性 / D2 发布物 / D3 克隆零缺件 / D7 债务棘轮）在 `--changed` 下**不报** —— 一个 pre-commit 钩子不应要求本机存在发布产物；但任务面棘轮恒报，因为命令数与规则数正是提交动作直接改变的。② 声明「本仓不做签名」并移除相应步骤，是合法的收敛方向（D4 判的是「失败被吞掉」，不是「必须有签名」）—— 移除优于吞掉。阶段豁免：本条按 [DESIGN-PROCESS-002] / PROCESS-008 落地为 **S1 观察者**（gate=commit 会跑 + severity=advisory 只记录），[DESIGN-DELIV-001] §4.3 关于「D1/D4/D7 可直进 S3」的主张**未自动采纳**，需一次显式人工裁决。

## 版本记录

- 1.0.0 (2026-09-24) 初版 / 迁移自 无
