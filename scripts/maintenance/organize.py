#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
khy-os 仓库整理器 —— [DESIGN-LAY-003] 仓库整理与巡检规范 (LAYOUT-004) 的执行者。

上级真源:
  - [DESIGN-LAY-002] 目录层级与文件归类规范 (LAYOUT-001)   ← 新文件放哪
  - [DESIGN-LAY-005] 仓库层级板块规范                     ← L0-L6 层级模型
  - [DESIGN-LAY-003] 仓库整理与巡检规范                    ← 存量杂物怎么清

红线实现: HK-1 git 已跟踪不动 / HK-2 运行时数据只读 / HK-3 只隔离不删除 /
          HK-4 html 孪生不当孤儿 / HK-5 不穿透软链 / HK-7 单批限流 /
          HK-8 不覆盖目标

用法:
    python scripts/maintenance/organize.py --report   # 只出报告（默认）
    python scripts/maintenance/organize.py --apply    # 额外隔离白名单内超期临时文件
    python scripts/maintenance/organize.py --check    # 智能体卫生观察者（S1）：全仓只读扫描
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat as stat_mod
import subprocess
import sys
import datetime as dt
from pathlib import Path

# 落地阶段（PROCESS-008 / [DESIGN-PROCESS-002]）：S1 观察者，只记录不阻断，恒 exit 0。
# 登记于 FEATURE-OWNERSHIP.json rollout.mechanisms[] 的 agent-hygiene-check。
# 阶段权威在 Python 常量本身；check-rollout-stage.js 用 JS 形态正则找它，
# 故行尾保留同一字面供机器比对（Python 没有 const 关键字）。
GUARD_STAGE = 'S1'  # const GUARD_STAGE = 'S1'

# ------------------------------------------------------------------ 配置

# 本文件位于 <repo>/scripts/maintenance/organize.py
REPO = Path(__file__).resolve().parents[2]
# 隔离区落在**数据家的临时区** `works/data/khy/T4-transient/tmp/housekeeping/`。
#
# ⚠ 2026-10-24 修 B8 复发：原值是 `REPO / ".khyos" / "housekeeping"` ——
#   那落在**仓库根**，而仓库根的 `.khyos/` 是 CLAUDE.md §二 B8 明令禁止的影子目录，
#   守卫 root-shadow-dir 会亮红（实测 2026-10-18 的「根临时文件收容」批次
#   又造出了一棵 .khyos/housekeeping/，是 B8 的第 8 次复发）。
#   数据家的临时区（works/data/khy/T4-transient/tmp/）本就是章程指定的临时件落点，
#   被 .gitignore 忽略、不污染 git 状态，且不触犯根目录禁令。
OUT_ROOT = REPO / "works" / "data" / "khy" / "T4-transient" / "tmp" / "housekeeping"

GUARD_DIRS = {
    ".git", ".khy", ".khyos", "node_modules", "khy_os.egg-info",
    ".venv", "venv", "__pycache__", "dist", "build", ".next",
}
GUARD_PREFIX = (".git-backup",)

RESEARCH_TMP = ".research-tmp"
ARTIFACTS = "_产物"
RESEARCH_MAX_AGE_DAYS = 7
BATCH_LIMIT = 10

MIRROR_SCAN_DIRS = [
    ".", ".ai", ".github", ".opencode", ".zcode",
    "docs", "kernel", "scripts", "tests", "apps", ARTIFACTS,
]
ALLOWED_DOT = {".ai", ".github", ".opencode", ".zcode"}
MIRROR_MAX_DEPTH = 4
MIRROR_SKIP = {
    "extensions", "platform", "services", "software", "tools",
    "electron", "packaging", "patches", "deploy", "node_modules",
    "coverage", "locale", "locales", "assets",
}

BAD_NAME_RE = re.compile(
    r"(对抗修复版|最终对抗版|最终版|最终稿|最新版|副本|拷贝|未命名|新建|"
    r"final|copy|backup|\(1\)|（1）)",
    re.IGNORECASE,
)
VERSION_SUFFIX_RE = re.compile(r"_(v\d+|\d{8}|对抗.*|最终.*)$")

BIG_FILE_MB = 500
MAX_DIRS_LISTED = 40


# ------------------------------------------------------------------ 工具


def now() -> dt.datetime:
    return dt.datetime.now()


def age_days(p: Path) -> float:
    try:
        return (now().timestamp() - p.stat().st_mtime) / 86400.0
    except OSError:
        return 0.0


def size_mb(p: Path) -> float:
    try:
        return p.stat().st_size / 1048576.0
    except OSError:
        return 0.0


def rel(p: Path) -> str:
    try:
        return str(p.relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(p)


def is_guard(name: str) -> bool:
    return name in GUARD_DIRS or name.startswith(GUARD_PREFIX)


def is_link(p: Path) -> bool:
    """符号链接与 Windows junction 都算（HK-5）。"""
    try:
        st = os.lstat(p)
    except OSError:
        return False
    if stat_mod.S_ISLNK(st.st_mode):
        return True
    return bool(getattr(st, "st_file_attributes", 0) & 0x400)


def _norm_link(t: str) -> str:
    return t[4:] if t.startswith("\\\\?\\") else t


def link_target(p: Path) -> str:
    for fn in (lambda: os.readlink(p), lambda: os.path.realpath(p)):
        try:
            t = fn()
            if t:
                return _norm_link(t)
        except OSError:
            continue
    return "（目标读取失败）"


def link_scope(p: Path) -> str:
    raw = link_target(p)
    if raw.startswith("（"):
        return "目标未知"
    try:
        Path(raw).resolve().relative_to(REPO.resolve())
        return "仓库内"
    except ValueError:
        return "越界"


def git(*args: str) -> str:
    """一次性 safe.directory，不写全局配置（仓库属主与当前用户不同）。"""
    try:
        r = subprocess.run(
            ["git", "-c", f"safe.directory={REPO.as_posix()}", *args],
            cwd=str(REPO), capture_output=True, text=True, timeout=180,
            encoding="utf-8", errors="replace",
        )
        return r.stdout if r.returncode == 0 else ""
    except Exception:  # noqa: BLE001
        return ""


def unique_target(dst: Path) -> Path:
    """HK-8：绝不覆盖。"""
    if not dst.exists():
        return dst
    stem, suf = dst.stem, dst.suffix
    i = 1
    while True:
        c = dst.with_name(f"{stem}_{i}{suf}")
        if not c.exists():
            return c
        i += 1


def walk_bounded(base: Path, max_depth: int, allow_dot: bool = False):
    """限深遍历；不穿透软链/junction；点开头目录需白名单。"""
    base = base.resolve()
    stack: list[tuple[Path, int]] = [(base, 0)]
    while stack:
        cur, depth = stack.pop()
        try:
            entries = sorted(cur.iterdir())
        except OSError:
            continue
        dirs, files = [], []
        for e in entries:
            if e.is_dir():
                n = e.name
                if is_guard(n) or is_link(e):
                    continue
                if n.startswith(".") and n not in ALLOWED_DOT and not allow_dot:
                    continue
                if n in MIRROR_SKIP:
                    continue
                dirs.append(e)
            else:
                files.append(e)
        yield cur, files
        if depth < max_depth:
            for d in dirs:
                stack.append((d, depth + 1))


# ------------------------------------------------------------------ 主体


class Auditor:
    def __init__(self, apply: bool):
        self.apply = apply
        self.tracked: set[str] = set()
        self.moves: list[dict] = []
        self.errors: list[str] = []
        self.mirror_dirs: dict[str, int] = {}
        self.root_mirrors: list[str] = []
        self.sec: dict[str, list[str]] = {
            "orphan_html": [], "artifacts": [], "research": [],
            "symlinks": [], "badname": [], "bigfile": [], "tracked_hit": [],
        }
        self.quarantine: list[tuple[Path, str]] = []

    def load_tracked(self) -> None:
        out = git("ls-files", "-z")
        if out:
            self.tracked = {p.replace("\\", "/") for p in out.split("\0") if p}
        else:
            self.errors.append("git ls-files 无输出，已跟踪判定不可用")

    def is_tracked(self, p: Path) -> bool:
        return rel(p) in self.tracked

    # ---------- 生成物镜像

    def scan_mirrors(self) -> None:
        seen: set[str] = set()
        for d in MIRROR_SCAN_DIRS:
            base = REPO if d == "." else REPO / d
            if not base.is_dir():
                continue
            for cur, files in walk_bounded(base, MIRROR_MAX_DEPTH, allow_dot=(d == ".")):
                for f in files:
                    if not f.name.lower().endswith(".html"):
                        continue
                    r = rel(f)
                    if r in seen:
                        continue
                    seen.add(r)
                    if f.with_suffix(".md").exists():
                        parent = rel(cur)
                        self.mirror_dirs[parent] = self.mirror_dirs.get(parent, 0) + 1
                    else:
                        # HK-4：只报告，绝不据此删除
                        tag = " [git已跟踪]" if self.is_tracked(f) else " [疑似入口文件，勿删]"
                        self.sec["orphan_html"].append(f"{r}{tag}")
        self.root_mirrors = sorted(
            f.name for f in REPO.iterdir()
            if f.is_file() and f.suffix.lower() == ".html"
            and f.with_suffix(".md").exists()
        )

    # ---------- _产物

    def scan_artifacts(self) -> None:
        d = REPO / ARTIFACTS
        if not d.is_dir():
            return
        groups: dict[tuple[str, str], list[str]] = {}
        for p in sorted(d.iterdir()):
            if is_link(p):
                self.sec["symlinks"].append(
                    f"`{rel(p)}` → `{link_target(p)}` （{link_scope(p)}）")
                continue
            if p.is_dir():
                n = sum(1 for _ in p.rglob("*") if _.is_file())
                self.sec["artifacts"].append(f"`{rel(p)}/` 目录，{n} 个文件")
                continue
            if BAD_NAME_RE.search(p.name):
                self.sec["badname"].append(rel(p))
            base = VERSION_SUFFIX_RE.sub("", p.stem)
            groups.setdefault((base, p.suffix.lower()), []).append(p.name)
        for (base, suf), names in sorted(groups.items()):
            if len(names) > 1:
                self.sec["artifacts"].append(
                    f"**版本冗余 x{len(names)}** `{base}*{suf}` → " + " / ".join(sorted(names)))

    # ---------- .research-tmp

    def scan_research_tmp(self) -> None:
        d = REPO / RESEARCH_TMP
        if not d.is_dir():
            return
        for p in sorted(d.rglob("*")):
            if not p.is_file() or is_link(p):
                continue
            a = age_days(p)
            if a > RESEARCH_MAX_AGE_DAYS:
                self.sec["research"].append(f"{rel(p)} （{int(a)} 天）")
                self.quarantine.append((p, "G4-research-tmp"))

    # ---------- 根目录

    def scan_root(self) -> None:
        for p in sorted(REPO.iterdir()):
            if is_link(p):
                self.sec["symlinks"].append(
                    f"`{rel(p)}` → `{link_target(p)}` （{link_scope(p)}）")
                continue
            if p.is_dir():
                continue
            r = rel(p)
            if size_mb(p) > BIG_FILE_MB:
                self.sec["bigfile"].append(f"{r} （{size_mb(p):.0f} MB）")
            if BAD_NAME_RE.search(p.name):
                self.sec["badname"].append(r)

    # ---------- 隔离

    def do_quarantine(self) -> None:
        if not self.apply or not self.quarantine:
            return
        if not self.tracked:
            self.errors.append(
                f"git 跟踪基线为空，已拒绝执行隔离（{len(self.quarantine)} 个候选原地保留）")
            return
        dst_root = OUT_ROOT / now().strftime("%Y-%m-%d")
        for i, (src, rule) in enumerate(self.quarantine):
            if i >= BATCH_LIMIT:  # HK-7
                self.errors.append(f"达到单批上限 {BATCH_LIMIT}，剩余候选留待下次")
                break
            if self.is_tracked(src):  # HK-1
                self.sec["tracked_hit"].append(rel(src))
                continue
            try:
                dst_root.mkdir(parents=True, exist_ok=True)
                dst = unique_target(dst_root / src.name)
                shutil.move(str(src), str(dst))
                self.moves.append({"rule": rule, "from": str(src), "to": str(dst),
                                   "size_mb": round(size_mb(dst), 3)})
            except Exception as exc:  # noqa: BLE001
                self.errors.append(f"隔离失败 {src}: {exc}")

    # ---------- 产出

    def render(self) -> str:
        mode = "隔离执行" if self.apply else "只读报告（未改动任何文件）"
        dirty_n = len([l for l in git("status", "--porcelain").splitlines() if l.strip()])
        head = git("log", "-1", "--format=%h %ad %s", "--date=short").strip()
        total = sum(self.mirror_dirs.values())
        L = [
            f"# khy-os 整理报告 · {now().strftime('%Y-%m-%d %H:%M')}", "",
            f"- 模式：**{mode}**",
            f"- 目标仓库：`{REPO}`",
            f"- 最后提交：`{head or '（读取失败）'}`",
            f"- 未提交变更：**{dirty_n}** 处",
            f"- git 跟踪基线：{len(self.tracked)} 个文件", "",
            "> 规范依据：`docs/10_规范/DESIGN-LAY/[DESIGN-LAY-003] 仓库整理与巡检规范.md`（LAYOUT-004）",
        ]
        if dirty_n > 0:
            L += ["", f"> ⚠ 仓库存在 {dirty_n} 处未提交变更，本次未对源码区做任何改动。"]

        if self.moves:
            L += ["", "## 一、本次已隔离", "", "| 规则 | 原位置 | 新位置 |", "|---|---|---|"]
            L += [f"| {m['rule']} | `{rel(Path(m['from']))}` | `{rel(Path(m['to']))}` |"
                  for m in self.moves]

        L += [
            "", "## 生成物镜像（.html ↔ .md 孪生）", "",
            f"全仓共 **{total}** 个，分布在 **{len(self.mirror_dirs)}** 个目录。", "",
            "**LAY-5 强制要求，属合法产出，不得清理（HK-4）。**", "",
            f"根目录镜像（{len(self.root_mirrors)} 个）："
            + ("、".join(f"`{n}`" for n in self.root_mirrors) if self.root_mirrors else "无"), "",
        ]
        if self.mirror_dirs:
            L += ["镜像最集中的目录：", ""]
            top = sorted(self.mirror_dirs.items(), key=lambda kv: -kv[1])[:MAX_DIRS_LISTED]
            L += [f"- `{d}/` — {n} 个" for d, n in top]
            if len(self.mirror_dirs) > MAX_DIRS_LISTED:
                L.append(f"- …（其余 {len(self.mirror_dirs) - MAX_DIRS_LISTED} 个目录略）")

        def sec(title: str, key: str) -> None:
            items = self.sec[key]
            L.extend(["", f"## {title}", ""])
            L.extend([f"- {i}" for i in items] if items else ["_无。_"])

        sec("孤立 .html（无同名 .md，仅报告不处理）", "orphan_html")
        sec("_产物 内容与版本冗余", "artifacts")
        sec("待隔离：.research-tmp 超期文件（>7 天）", "research")
        sec("软链 / 联接", "symlinks")
        sec("命名违规", "badname")
        sec("大文件（>500MB）", "bigfile")
        sec("命中 git 跟踪、已拒绝操作（HK-1）", "tracked_hit")

        L += [
            "", "## 处置建议", "",
            "1. **`.html` 孪生**：LAY-5 要求，保持现状。",
            "2. **`_产物/` 版本冗余**：保留最新一版，其余按 `_v1/_v2` 重命名或移入隔离区。",
            "3. **`.research-tmp/`**：超期文件隔离；若长期使用应改正式目录名并纳入版本控制。",
            "4. **越界软链**：`_产物/<某链接>` 指向仓库外，建议删除或改仓库内相对路径。",
            "5. **L3 删除**：脚本永不执行（HK-3）。",
            "", "---", "",
            f"> 隔离区：`{OUT_ROOT}\\`（已被 .gitignore 忽略，HK-6）",
            "> 撤回：按 manifest 原路移回即可。",
        ]
        if self.errors:
            L += ["", "## 异常", ""] + [f"- {e}" for e in self.errors]
        return "\n".join(L)

    def manifest(self) -> dict:
        return {
            "run_at": now().isoformat(timespec="seconds"),
            "mode": "apply" if self.apply else "report",
            "repo": str(REPO),
            "move_count": len(self.moves),
            "moves": self.moves,
            "quarantine_candidates": len(self.quarantine),
            "mirror_total": sum(self.mirror_dirs.values()),
            "errors": self.errors,
        }

    def run(self) -> int:
        if not REPO.is_dir():
            print(f"[致命] 仓库不存在: {REPO}")
            return 2
        self.load_tracked()
        self.scan_mirrors()
        self.scan_artifacts()
        self.scan_research_tmp()
        self.scan_root()
        self.do_quarantine()

        report, mf = self.render(), self.manifest()
        date = now().strftime("%Y-%m-%d")
        try:
            (OUT_ROOT / "reports").mkdir(parents=True, exist_ok=True)
            (OUT_ROOT / "manifests").mkdir(parents=True, exist_ok=True)
            (OUT_ROOT / "reports" / f"khy-os-{date}.md").write_text(report, encoding="utf-8")
            (OUT_ROOT / "manifests" / f"khy-os-{date}-manifest.json").write_text(
                json.dumps(mf, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            print(f"[警告] 写报告失败: {exc}")

        print(f"模式: {'apply' if self.apply else 'report'}")
        print(f"仓库: {REPO}")
        print(f"git 跟踪基线: {len(self.tracked)} 文件")
        print(f"生成物镜像: {sum(self.mirror_dirs.values())} 个 / {len(self.mirror_dirs)} 目录")
        print(f"根目录镜像: {len(self.root_mirrors)}")
        for k, label in [("orphan_html", "孤立 .html"), ("artifacts", "_产物条目"),
                         ("research", "待隔离临时文件"), ("symlinks", "软链/联接"),
                         ("badname", "命名违规"), ("bigfile", "大文件")]:
            print(f"{label}: {len(self.sec[k])}")
        print(f"隔离候选 {len(self.quarantine)} / 实际隔离 {len(self.moves)}")
        for e in self.errors:
            print(f"错误: {e}")
        print(f"报告: {OUT_ROOT / 'reports' / f'khy-os-{date}.md'}")
        return 0


# ------------------------------------------------------------------ --check：智能体卫生观察者
#
# 真源：docs/10_规范/DESIGN-LAY/[DESIGN-LAY-011] 新增文件落位与命名规程.md §五「检测与守卫」
# + 附录一「禁物清单」。该节把本模式定为**观察者**：全树扫 .tmp-*、碎片名、junction、
# 根白名单外条目 → findings，恒 exit 0（S1，PROCESS-008）。
#
# 与 --report / --apply 三者互斥，且本模式**只读**：不写报告、不写 manifest、不隔离任何文件。
# 毕业看样本量（≥200 条），不看时间。

# 临时件的唯一合法落点（[DESIGN-LAY-011] §一 ⑥ 与 §二「四桶落位」）。
# 出现在它之外的 .tmp-* 即 finding；落点之内一律放行（隔离区 .../tmp/housekeeping/ 也在其内）。
T4_TRANSIENT_REL = "works/data/khy/T4-transient"

# 全树扫描的排除集。.git / node_modules / dist / build / vendor / third_party / flutter
# 与 works/data/khy/perf（夹具）是任务书为 reparse point 一类点名排除的；名字形态一类
# 借同一集合只为省时间——本仓实测加上/去掉该集合，.tmp-* 命中都是 38 条
# （node_modules 内 0 条），判定结果不变。
SCAN_SKIP_DIRS = {".git", "node_modules", "dist", "build", "vendor", "third_party", "flutter"}
SCAN_SKIP_PREFIXES = ("works/data/khy/perf",)

# 碎片名签名（[DESIGN-LAY-011] 附录一「引号、括号、分号事故」+ Windows 保留设备名）。
# 刻意**不含**空格、方括号、圆括号：全树 125,704 个文件实测它们分别有约 1958 / 1926 / 33 处
# **合法**命中——`[DESIGN-ARCH-116] …(@khy-plugin-sdk).md` 是文档命名铁律（[MGMT-STD-007] R3），
# electron 安装包名带空格，一律收进来会把观察者变成误报机器。
# 圆括号只认 `])` 一种形状：`m[1])` / `x[1])` 这类 JS 下标取用残段，实测全树 3 处全是事故、
# 0 处合法。根级的括号事故由 check-repo-layout.js 的 root-junk 兜（它只看根，误报面小得多）。
FRAGMENT_NAME_CHARS = "'\"`{};"
FRAGMENT_NAME_SEQ = "])"
WINDOWS_RESERVED_NAMES = {"nul", "con", "prn", "aux"} | {
    f"{stem}{n}" for stem in ("com", "lpt") for n in range(1, 10)
}

# 根级封闭清单的**运行时真源**：不在这里抄第二份（[MGMT-STD-008] §2.2 重叠即违规）。
# 规范真源 [MGMT-STD-001] §1.3；机器真源就是下面这个文件里的六处声明。
ROOT_WHITELIST_SOURCE = "scripts/ci/check-repo-layout.js"
ROOT_WHITELIST_OBJECTS = ("ROOT_CATALOG", "LAYERS", "CROSSCUTTING")
ROOT_WHITELIST_SETS = ("ROOT_DOC_WHITELIST", "GENERATED_TOP_LEVEL_DIRS", "ROOT_ALWAYS_OK")
ROOT_WHITELIST_MIN_KEYS = 20


def fragment_name_reason(name: str) -> str | None:
    """碎片名判据（[DESIGN-LAY-011] 附录一）。命中返回一句原因，否则 None。"""
    for ch in FRAGMENT_NAME_CHARS:
        if ch in name:
            return f"含 {ch!r}（shell 元字符）"
    if FRAGMENT_NAME_SEQ in name:
        return f"含 {FRAGMENT_NAME_SEQ!r}（JS 下标取用残段）"
    if name.lower() in WINDOWS_RESERVED_NAMES:
        return "Windows 保留设备名"
    return None


def _slice_js_object(src: str, name: str) -> str:
    """按花括号配平切出 `const <name> = { ... };` 的体（跨行、含嵌套）。"""
    m = re.search(rf"const {name} = \{{", src)
    if not m:
        return ""
    depth, i = 0, src.index("{", m.start())
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[i:j + 1]
    return ""


def _slice_js_set(src: str, name: str) -> str:
    """切出 `const <name> = new Set([ ... ]);` 的数组体。"""
    m = re.search(rf"const {name} = new Set\(\[", src)
    if not m:
        return ""
    i = src.index("[", m.start())
    j = src.index("]", i)
    return src[i + 1:j]


def _js_object_keys(block: str) -> set[str]:
    """对象字面量的键名。注释行不参与——ROOT_CATALOG 的注释里到处是带引号的路径。"""
    keys: set[str] = set()
    for line in block.splitlines():
        s = line.strip()
        if s.startswith(("//", "*", "/*")):
            continue
        m = re.match(r"^'([^']+)'\s*:", s) or re.match(r"^([A-Za-z_$][\w$]*)\s*:", s)
        if m:
            keys.add(m.group(1))
    return keys


def load_root_whitelist(src: str) -> tuple[set[str], str]:
    """从 check-repo-layout.js 的源码里现取根级封闭清单。返回 (名单, 问题说明)。

    解析出的条目少得可疑时名单为空、问题非空——调用方只报 finding，
    绝不把「判据取不到」当成「根目录干净」（RUNTIME-010 A2-7：判定失败禁止静默放行）。
    """
    names: set[str] = set()
    for obj in ROOT_WHITELIST_OBJECTS:
        names |= _js_object_keys(_slice_js_object(src, obj))
    for st in ROOT_WHITELIST_SETS:
        names |= set(re.findall(r"'([^']+)'", _slice_js_set(src, st)))
    # LAYERS / CROSSCUTTING 的键是仓库根相对路径，顶层名取首段
    # （同 JS 的 topLevelNamesCoveredByRegistry：目录搬进某一层，仍是那棵树的顶层成员）。
    names |= {n.split("/")[0] for n in names if "/" in n}

    if len(names) < ROOT_WHITELIST_MIN_KEYS:
        return set(), (
            f"{ROOT_WHITELIST_SOURCE} 里只解析出 {len(names)} 个条目"
            f"（阈值 {ROOT_WHITELIST_MIN_KEYS}）——ROOT_CATALOG/LAYERS/CROSSCUTTING 的形状大概被改过，"
            "本条判据不敢用；修好解析再跑，别把读不到当成干净。"
        )
    return names, ""


def load_readme_variant_re(src: str) -> re.Pattern | None:
    m = re.search(r"const README_VARIANT_RE = /([^/\n]+)/", src)
    if not m:
        return None
    try:
        return re.compile(m.group(1))
    except re.error:
        return None


def iter_tree(base: Path):
    """全树遍历，yield (Path, kind)，kind ∈ {"dir", "file", "reparse"}。

    不穿透 reparse point（HK-5）：链接只报、绝不顺着它往下走，否则既可能绕出仓库，
    也会让同一棵子树被数两遍。生成/供应商目录与夹具区的排除见 SCAN_SKIP_DIRS /
    SCAN_SKIP_PREFIXES。
    """
    stack = [base]
    while stack:
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                entries = sorted(it, key=lambda e: e.name)
        except OSError:
            continue
        for e in entries:
            p = Path(e.path)
            if is_link(p):
                yield p, "reparse"
                continue
            try:
                if e.is_dir(follow_symlinks=False):
                    if e.name in SCAN_SKIP_DIRS:
                        continue
                    r = rel(p)
                    if any(r == pre or r.startswith(pre + "/") for pre in SCAN_SKIP_PREFIXES):
                        continue
                    stack.append(p)
                    yield p, "dir"
                    continue
            except OSError:
                continue
            yield p, "file"


def _under(p: Path, prefix_rel: str) -> bool:
    r = rel(p)
    return r == prefix_rel or r.startswith(prefix_rel + "/")


class HygieneAuditor:
    """--check：全仓只读扫描，输出 JSON findings（S1 观察者，恒 exit 0）。"""

    def __init__(self) -> None:
        self.findings: list[dict] = []
        self.counts: dict[str, int] = {}
        self.scanned_files = 0
        self.scanned_dirs = 0
        self.root_whitelist: set[str] = set()
        self.readme_variant: re.Pattern | None = None

    def add(self, kind: str, path: str, hint: str) -> None:
        self.findings.append({"kind": kind, "path": path, "hint": hint})
        self.counts[kind] = self.counts.get(kind, 0) + 1

    # ---------- ①+② 一趟遍历：名字形态与 reparse point ----------

    def scan_tree(self) -> None:
        """全树一趟：计数 + reparse point + .tmp-*/碎片名（T4-transient 之外）。"""
        for p, kind in iter_tree(REPO):
            if kind == "reparse":
                self.add(
                    "reparse-point", rel(p),
                    f"指向 {link_target(p)}（{link_scope(p)}）；[DESIGN-LAY-011] §二/附录一 2026-11-18 裁决"
                    "禁用 junction / symlink，四个桶必须是磁盘上的真目录",
                )
                continue
            if kind == "dir":
                self.scanned_dirs += 1
            else:
                self.scanned_files += 1
            if _under(p, T4_TRANSIENT_REL):
                continue  # 临时件的合法落点，其内一律放行
            name = p.name
            if ".tmp-" in name:
                self.add(
                    "tmp-name-outside-t4", rel(p),
                    "临时件唯一合法落点是 works/data/khy/T4-transient/（[DESIGN-LAY-011] §一 ⑥）；"
                    "收工删掉，或隔离进 .../tmp/housekeeping/<日期>/ 并留 manifest（只隔离不删除，HK-3）",
                )
                continue
            why = fragment_name_reason(name)
            if why:
                self.add(
                    "fragment-name", rel(p),
                    f"{why}：shell / node -e 载荷被展开成文件名的事故残骸，"
                    "内容通常也是工具输出碎片；隔离进 .../tmp/housekeeping/<日期>/（HK-3）",
                )

    # ---------- ③ 根级封闭清单 ----------

    def scan_root_catalog(self) -> None:
        try:
            src = (REPO / ROOT_WHITELIST_SOURCE).read_text(encoding="utf-8")
        except OSError as exc:
            self.add("root-whitelist-unavailable", ROOT_WHITELIST_SOURCE,
                     f"读不到 {ROOT_WHITELIST_SOURCE}：{exc}")
            return
        whitelist, problem = load_root_whitelist(src)
        if problem:
            self.add("root-whitelist-unavailable", ROOT_WHITELIST_SOURCE, problem)
            return
        self.root_whitelist = whitelist
        self.readme_variant = load_readme_variant_re(src)
        for p in sorted(REPO.iterdir()):
            n = p.name
            if n in whitelist:
                continue
            if self.readme_variant and self.readme_variant.match(n):
                continue
            self.add(
                "root-uncatalogued", n,
                "根级实体未登记；补 scripts/ci/check-repo-layout.js 的 ROOT_CATALOG 条目"
                "（category/reason/reviewBy）或归入既有层。若它其实是临时/事故残留，先删再补——"
                "真源 [MGMT-STD-001] §1.3",
            )

    # ---------- 汇总 ----------

    def run(self) -> int:
        if not REPO.is_dir():
            print(json.dumps({"stage": GUARD_STAGE, "error": f"仓库不存在: {REPO}"},
                             ensure_ascii=False))
            return 0
        self.scan_tree()
        self.scan_root_catalog()
        payload = {
            "stage": GUARD_STAGE,
            "mode": "check",
            "repo": str(REPO),
            "generatedAt": now().isoformat(timespec="seconds"),
            "ssot": "docs/10_规范/DESIGN-LAY/[DESIGN-LAY-011] 新增文件落位与命名规程.md §五 + 附录一",
            "scanned": {"files": self.scanned_files, "dirs": self.scanned_dirs},
            "counts": self.counts,
            "findingCount": len(self.findings),
            "findings": self.findings,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="khy-os 仓库整理器 (LAYOUT-004)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--report", action="store_true", help="只出报告（默认）")
    g.add_argument("--apply", action="store_true", help="隔离白名单内超期临时文件")
    g.add_argument("--check", action="store_true",
                   help="智能体卫生观察者（S1）：全仓只读扫描，输出 JSON findings，恒 exit 0")
    args = ap.parse_args()
    if args.check:
        return HygieneAuditor().run()
    return Auditor(apply=bool(args.apply)).run()


if __name__ == "__main__":
    sys.exit(main())
