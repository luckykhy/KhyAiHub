#!/usr/bin/env python3
"""校验「出厂客户端里没有明文内置密钥/端点」——即 APK 里只有混淆后的字节数组。

为什么需要它
------------
`built_in_keys.dart` 里的密钥与「不希望暴露在 APK 里」的端点都是 XOR 混淆的
（`s[i] = bytes[i] ^ KEY[i % 4]`），所以 **APK 里不应出现任何明文**。这个脚本把
Dart 数组**解码**成明文候选，再去源树与 APK 里搜，命中即失败。

端点为什么也走这套：端点是「这个包连着哪」的答案。明文写在 APK 里，任何一次
`strings app.apk` 都能列出来——等于把自建网关的位置和免费档入口一起递给任何
拿到安装包的人。R2 只强制密钥，但同一条理由适用于端点。

与旧版 `check_keys.ps1` 的区别（旧版有三个坑，都已修）：
1. 旧版硬编码 6 个前缀 ⇒ 第 7 把 `_stepfun` 从未被检查；
2. 旧版路径写 `build/app/outputs/flutter-apk/app-release.apk`，实际发布件在 `release/*.apk`
   ⇒ 文件不存在时会直接抛异常，等于没检查；
3. 旧版每加一把钥匙就要手改 ⇒ 必然漂移。**本脚本从 Dart 数组自动派生，不需要维护清单。**

用法
----
    python scripts/check_builtin_keys.py              # 扫源树 + 所有 APK
    python scripts/check_builtin_keys.py --src-only   # 只扫源树（不依赖已构建 APK）
    python scripts/check_builtin_keys.py --changed    # 只扫本次暂存的改动文件（pre-commit 快档）
    python scripts/check_builtin_keys.py --gate       # 输出规则门约定的聚合 finding 行
    python scripts/check_builtin_keys.py --json       # 机器可读输出

退出码
------
    0  干净
    1  发现明文密钥
    2  用法 / 环境错误（如 Dart 文件缺失、解不出任何数组）

门集成（ruleguard）
-------------------
**本脚本不是 ruleguard 执行器**。规则 `SECURITY-001` 的 `exec.script` 是
`scripts/ci/check-change-safety.js`，由它 `--json` 调本脚本、再把命中重新表述成自己的
finding（id = `builtin-key-plaintext`）。那个 id 必须在 `SECURITY-001` 的 `exec.findings`
里被认领，否则会被记成 `checker-failure` 未认领错误。

`--gate` 是**手动/调试**出口：直接按 `scripts/ruleguard/lib/run.js` 的
`FINDING_LINE_AGGREGATE` 方言打印（`- [error] <说明> (id: builtin-key-plaintext)`），
**当前无任何调用者** —— 若哪天要把本脚本直接登记成执行器，这条才是入口。
`--changed` 隐含跳过 APK 扫描（APK 是构建产物，不存在于提交时刻）。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

# 本脚本的人类可读输出含中文与 ✓/✗/⚠ 等符号，在 Windows 默认 GBK 控制台上
# 会抛 UnicodeEncodeError——把「扫描通过」变成「扫描崩溃」，守卫一崩就等于没跑。
# 在任何 stdout 使用前统一切到 UTF-8，并对无法编码的字符降级而不中断。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):  # 非 TextIO（重定向到二进制流等）
        pass

ROOT = Path(__file__).resolve().parent.parent
# Flutter 客户端已从 apps/ 迁到 delivery/mobile/（apps/ 现只剩 khyos-desktop 桌面端）。
# 路径不跟随迁移就会让本脚本在 DART 不存在时以 exit 2 退出——守卫不是「发现明文」，
# 而是「跑不起来」，后者更危险：R2 的 0 命中承诺从未被真正验证过。
CLIENT = ROOT / 'delivery' / 'mobile' / 'khy-os-client-app'
DART = CLIENT / 'lib' / 'core' / 'config' / 'built_in_keys.dart'

# 与 built_in_keys.dart / gen_keys.py 保持一致
XOR_KEY = (0xA3, 0x5F, 0xC2, 0x1B)

# 作者侧生成器本身含明文，按项目决定豁免（不进 APK，不参与打包）
ALLOWLIST = {'scripts/gen_keys.py'}

# 供 ruleguard 认领的 finding id（与登记表 exec.findings 必须逐字一致）
FINDING_ID = 'builtin-key-plaintext'

SKIP_DIR_PARTS = {'build', '.dart_tool', '.git', 'node_modules', '__pycache__'}

_ARRAY_RE = re.compile(r'static const List<int> _(\w+)\s*=\s*\[(.*?)\];', re.S)
_NUM_RE = re.compile(r'\d+')
# 数组体内的注释。必须先剥掉再取数字，否则注释里的日期（"2026-09-27 消毒"）
# 会被当成字节解出一串垃圾——而搜那串垃圾永远搜不到，守卫于是**假绿**：
# 报告"无明文密钥"，实际上一个字节都没查。这比没有守卫更危险。
_COMMENT_RE = re.compile(r'//[^\n]*|/\*.*?\*/', re.S)


def array_bytes(body: str) -> list[int]:
    return [int(x) for x in _NUM_RE.findall(_COMMENT_RE.sub('', body))]


def decode_arrays(dart_path: Path = DART) -> dict[str, str]:
    """从 Dart 源里解出全部明文候选。键 = 数组名（去掉前导下划线）。

    钥匙数组（`_supxh` 等）与端点数组（`_epKhyosGw` 等）用同一套 XOR，
    所以这里一并解出；调用方按 `ep` 前缀区分两类。
    """
    if not dart_path.exists():
        raise FileNotFoundError(f'找不到 {dart_path}')
    txt = dart_path.read_text(encoding='utf-8')
    out: dict[str, str] = {}
    for m in _ARRAY_RE.finditer(txt):
        name = m.group(1)
        nums = array_bytes(m.group(2))
        if not nums:
            continue
        out[name] = ''.join(
            chr(b ^ XOR_KEY[i % 4]) for i, b in enumerate(nums)
        )
    return out


def iter_source_files():
    """遍历客户端源树。用 os.walk 就地剪枝，避免 rglob 下潜 build/ 之类的巨大目录。"""
    import os
    for dirpath, dirnames, filenames in os.walk(CLIENT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_PARTS]
        for fn in filenames:
            p = Path(dirpath) / fn
            if p.suffix == '.apk':
                continue
            yield p


def changed_paths() -> set[str] | None:
    """本次**暂存**的改动路径（repo 相对、正斜杠）。取不到 git 时返回 None = 不过滤。

    判改动集一律用 `--cached`：工作区里还混着别的会话的 WIP，
    只看工作区会把无关文件算进来。
    """
    try:
        proc = subprocess.run(
            ['git', 'diff', '--cached', '--name-only', '-z',
             '--diff-filter=ACMR'],
            cwd=str(ROOT), capture_output=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return {p for p in proc.stdout.decode('utf-8', 'replace').split('\0') if p}


def find_apks() -> list[Path]:
    """已知的出厂件位置。用定点 glob 而不是 build/** 深挖（build/ 可能很大）。"""
    patterns = (
        'release/*.apk',
        'build/app/outputs/flutter-apk/*.apk',
        'build/app/outputs/apk/**/*.apk',
    )
    seen: list[Path] = []
    for pat in patterns:
        for p in CLIENT.glob(pat):
            # Shizuku 是第三方上游二进制，不含我们的内置密钥
            if 'shizuku' in p.name.lower():
                continue
            if p not in seen:
                seen.append(p)
    return sorted(seen)


def scan_blob(data: bytes, plains: dict[str, str]) -> list[str]:
    return [name for name, val in plains.items() if val and val.encode() in data]


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    out = ap.add_mutually_exclusive_group()
    out.add_argument('--json', action='store_true', help='机器可读输出')
    out.add_argument('--gate', action='store_true',
                     help='输出 ruleguard 聚合 finding 行（- [error] … (id: …)）')
    ap.add_argument('--src-only', action='store_true', help='只扫源树，跳过 APK')
    ap.add_argument('--changed', action='store_true',
                    help='只扫本次暂存的改动文件（隐含 --src-only）')
    args = ap.parse_args()

    try:
        decoded = decode_arrays()
    except Exception as exc:  # noqa: BLE001
        print(f'ERROR: {exc}', file=sys.stderr)
        return 2
    # 两类分开：钥匙与端点都该只以混淆形态随包分发，但报告里必须说清是哪类
    # 泄露——把端点泄露标成「密钥」会让人去轮换一把并不存在的钥匙。
    keys = {k: v for k, v in decoded.items()
            if not k.startswith('ep') and v and v != 'public'}
    endpoints = {k: v for k, v in decoded.items()
                 if k.startswith('ep') and v and v != 'public'}
    plains = {**keys, **endpoints}
    if not plains:
        # 仓库消毒后的常态：所有数组都是空的，没有任何明文值可搜。
        #
        # 这里必须显式说清「本次一个值都没校验」，而不是打一句「无明文密钥」——
        # 后者正是这个脚本修掉的假绿：以前它把注释里的日期当字节解出 3 个垃圾
        # 字符，然后搜那串垃圾，永远搜不到，于是每次都"通过"。
        #
        # 放行（exit 0）是因为不变 vacuously 成立：没有密钥/端点，就没有明文可泄漏。
        # 但开发者机器上跑过 gen_keys.py 贴回数组后，这里就变成真校验了。
        if args.json:
            print(json.dumps({
                'ok': True,
                'keys': [],
                'endpoints': [],
                'scannedSourceFiles': 0,
                'apks': [],
                'findings': [],
                'note': 'no arrays decoded; nothing was actually verified',
            }, ensure_ascii=False, indent=2))
            return 0
        print(f'{DART.name}: 所有 XOR 数组均为空（仓库消毒后的常态）')
        print('  ⚠ 本次未校验任何明文值——没有密钥/端点可搜。')
        print('  ⚠ 本机跑过 `python scripts/gen_keys.py` 贴回数组后，这里才是真校验。')
        print('\n结论: ✓ 通过（vacuously —— 无值可泄漏）')
        return 0

    # --changed 只看暂存改动；APK 是构建产物，提交时刻不存在 ⇒ 一并跳过
    src_only = args.src_only or args.changed
    only = changed_paths() if args.changed else None

    findings: list[dict] = []
    scanned_src = 0
    for p in iter_source_files():
        rel = p.relative_to(ROOT).as_posix()
        if rel in ALLOWLIST:
            continue
        if only is not None and rel not in only:
            continue
        scanned_src += 1
        try:
            data = p.read_bytes()
        except OSError:
            continue
        for name in scan_blob(data, plains):
            kind = 'endpoint' if name.startswith('ep') else 'key'
            findings.append({'where': rel, 'kind': 'source',
                             'key': name, 'secret': kind})

    scanned_apk: list[dict] = []
    if not src_only:
        for apk in find_apks():
            entry = {'apk': apk.relative_to(ROOT).as_posix(),
                     'bytes': apk.stat().st_size, 'leaks': []}
            try:
                with zipfile.ZipFile(apk) as z:
                    for nm in z.namelist():
                        try:
                            data = z.read(nm)
                        except (OSError, zipfile.BadZipFile):
                            continue
                        for name in scan_blob(data, plains):
                            entry['leaks'].append(
                                {'entry': nm, 'key': name,
                                 'secret': 'endpoint' if name.startswith('ep') else 'key'})
            except (OSError, zipfile.BadZipFile) as exc:
                entry['error'] = str(exc)
            scanned_apk.append(entry)
            for leak in entry['leaks']:
                findings.append({'where': f"{entry['apk']}!{leak['entry']}",
                                 'kind': 'apk', 'key': leak['key'],
                                 'secret': leak['secret']})

    ok = not findings

    if args.json:
        print(json.dumps({
            'ok': ok,
            'keys': sorted(keys),
            'endpoints': sorted(endpoints),
            'scannedSourceFiles': scanned_src,
            'apks': scanned_apk,
            'findings': findings,
        }, ensure_ascii=False, indent=2))
        print(f"Summary: {len(findings)} plaintext hit(s) / "
              f"{len(keys)} key(s) + {len(endpoints)} endpoint(s) / {scanned_src} file(s)")
        return 0 if ok else 1

    if args.gate:
        # 只输出聚合 finding 行，保持 stdout 对 ruleguard 解析器干净。
        for f in findings:
            what = '端点' if f.get('secret') == 'endpoint' else '密钥'
            print(f'- [error] 出厂件出现明文内置{what} [{f["key"]}] @ {f["where"]} '
                  f'(id: {FINDING_ID})')
        return 0 if ok else 1

    print(f'内置密钥 {len(keys)} 把、隐藏端点 {len(endpoints)} 个'
          f'（从 {DART.name} 解码，自动派生）')
    # 不打印密钥/端点前缀：本行既非判据所需，又会在 Windows GBK 控制台上抛
    # UnicodeEncodeError（值含非 GBK 码位时）把整个扫描打断——让「扫描通过」
    # 变成「扫描崩溃」，比多打几个字符危险得多。只报名字与长度。
    for name in sorted(keys):
        print(f'  _{name:<12} (len={len(keys[name])})')
    for name in sorted(endpoints):
        print(f'  _{name:<12} (len={len(endpoints[name])}) [endpoint]')

    scope = '（仅本次暂存改动）' if only is not None else ''
    print(f'\n[源树] 扫描 {scanned_src} 个文件{scope}'
          f'（豁免: {", ".join(sorted(ALLOWLIST))}）')
    src_hits = [f for f in findings if f['kind'] == 'source']
    if src_hits:
        for f in src_hits:
            what = '端点' if f.get('secret') == 'endpoint' else '密钥'
            print(f'  ✗ [明文{what}] {f["where"]}  <- {f["key"]}')
    else:
        print('  ✓ 源树无明文密钥/端点')

    if src_only:
        print('\n[APK] 已跳过（' + ('--changed' if args.changed else '--src-only') + '）')
    else:
        print('\n[APK]')
        if not scanned_apk:
            print('  ⚠ 未找到 APK（先构建，或用 --src-only 只查源树）')
        for entry in scanned_apk:
            if entry.get('error'):
                print(f'  ⚠ {entry["apk"]}: 读取失败 {entry["error"]}')
            elif entry['leaks']:
                print(f'  ✗ {entry["apk"]} ({entry["bytes"]:,}B) 发现明文:')
                for leak in entry['leaks']:
                    what = '端点' if leak['secret'] == 'endpoint' else '密钥'
                    print(f'      [{what}:{leak["key"]}] in {leak["entry"]}')
            else:
                print(f'  ✓ {entry["apk"]} ({entry["bytes"]:,}B) 无明文密钥/端点')

    print('\n结论: ' + ('✓ 通过 —— 出厂客户端只有混淆密钥与端点' if ok
                      else f'✗ 失败 —— {len(findings)} 处明文'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
