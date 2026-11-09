#!/usr/bin/env python3
"""内置 API 密钥 -> Dart XOR 字节数组。

用法
----
    python scripts/gen_keys.py            # 打印 Dart 数组块（贴回 built_in_keys.dart）
    python scripts/gen_keys.py --check    # 校验 built_in_keys.dart 与钥匙文件是否一致

钥匙真源（2026-09-27 消毒后）
------------------------------
**明文钥匙不在仓库里。** 真源是本机用户级文件：

    ~/.khyquant/built-in-keys.json      （可用环境变量 KHY_BUILTIN_KEYS_FILE 覆盖路径）

格式：{"<名称>": "<钥匙>", ...}，键名必须与 built_in_keys.dart 里的数组名
（去掉前导下划线）逐字一致。本文件只负责「读钥匙 -> XOR 编码 -> 生成 Dart 数组」，
因此仓库历史与发布件里都不再出现明文或可逆编码的凭据。

历史备注：2026-09-27 之前钥匙曾明文写在本文件并提交入库（当时的项目决定视为
免费额度钥匙可暴露）。2026-09-27 仓库历史重建时消毒迁出；那些钥匙应视为
已泄漏并在各供应商侧轮换。
"""
import json
import os
import re
import sys
from pathlib import Path

# 与 scripts/check_builtin_keys.py 同一处修法：本脚本输出含中文与 ✓/✗/⚠，
# 在 Windows 默认 GBK 控制台上会抛 UnicodeEncodeError——把「校验不一致」变成
# 「脚本崩溃」，而崩溃看起来像跑过了。在任何 stdout 使用前统一切到 UTF-8，
# 无法编码的字符降级而不中断。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):  # 非 TextIO（重定向到二进制流等）
        pass

# XOR key: 4 bytes, rotated per position
XK = [0xA3, 0x5F, 0xC2, 0x1B]

DART = (Path(__file__).resolve().parent.parent
        / 'delivery/mobile/khy-os-client-app/lib/core/config/built_in_keys.dart')


def keys_file() -> Path:
    return Path(os.environ.get(
        'KHY_BUILTIN_KEYS_FILE',
        str(Path.home() / '.khyquant' / 'built-in-keys.json'),
    ))


def load_keys() -> dict:
    p = keys_file()
    if not p.exists():
        sys.exit(
            f'未找到钥匙文件：{p}\n'
            '明文钥匙自 2026-09-27 起不入仓库。请在该路径创建 JSON：\n'
            '  {"<名称>": "<钥匙>", ...}   # 键名与 built_in_keys.dart 数组名一致\n'
            '或用环境变量 KHY_BUILTIN_KEYS_FILE 指定其它路径。'
        )
    # 以 $ 开头的键是元数据（如 $note），不是钥匙
    return {k: v for k, v in json.loads(p.read_text(encoding='utf-8')).items()
            if not k.startswith('$')}


def encode(s):
    return [ord(c) ^ XK[i % 4] for i, c in enumerate(s)]


def decode(b):
    return ''.join(chr(x ^ XK[i % 4]) for i, x in enumerate(b))


def dart_arrays(prefix=None):
    """从 built_in_keys.dart 读出所有 `static const List<int> _name = [...]`。

    prefix 给定时只取该前缀的数组（'ep' → 只取端点数组），否则只取钥匙数组。
    两类数组必须分开：端点不是钥匙，混在一起会让 --check 互相报
    「只存在于 Dart」，而两边其实都对。
    """
    if not DART.exists():
        return {}
    txt = DART.read_text(encoding='utf-8')
    out = {}
    for m in re.finditer(r'static const List<int> _(\w+)\s*=\s*\[(.*?)\];', txt, re.S):
        name = m.group(1)
        if prefix is None:
            if name.startswith('ep'):
                continue
        elif not name.startswith(prefix):
            continue
        out[name] = [int(x) for x in re.findall(r'\d+', m.group(2))]
    return out


def load_endpoints() -> dict:
    """从钥匙文件读出端点表。

    放在 `$endpoints` 元数据键下（`$` 开头的是元数据，不是钥匙）：

        {"$endpoints": {"khyos-gw": "https://...", "opencode-free": "https://..."}}

    键名会被拼成 Dart 数组名 `_epKhyosGw` / `_epOpencodeFree`：连字符转驼峰。
    与钥匙同一套规矩——仓库内保持空数组，本机生成后贴回、不提交。
    """
    data = json.loads(keys_file().read_text(encoding='utf-8'))
    eps = data.get('$endpoints') or {}
    if not isinstance(eps, dict):
        sys.exit('$endpoints 必须是 {"<名称>": "<端点>"} 形态的对象')
    return {k: v for k, v in eps.items() if not k.startswith('$')}


def camel(name: str) -> str:
    """khyos-gw → KhyosGw，供 Dart 数组名 _epKhyosGw 使用。"""
    parts = re.split(r'[-_\s]+', name.strip())
    return ''.join(p[:1].upper() + p[1:] for p in parts if p)


def _emit(name: str, value: str, lines: list) -> None:
    enc = encode(value)
    assert decode(enc) == value, f'XOR 往返失败: {name}'
    lines.append(f'  static const List<int> _{name} = [')
    for i in range(0, len(enc), 12):
        lines.append('    ' + ', '.join(str(x) for x in enc[i:i + 12]) + ',')
    lines.append('  ];')
    lines.append('')


def render():
    lines = []
    for name, key in load_keys().items():
        _emit(name, key, lines)
    # 端点紧随钥匙，用同一套 XOR。数组名 _ep<驼峰>，与钥匙数组分开。
    for name, ep in load_endpoints().items():
        _emit(f'ep{camel(name)}', ep, lines)
    head = [
        '// XOR key: 0xA3, 0x5F, 0xC2, 0x1B',
        '// Decode: s[i] = bytes[i] ^ KEY[i % 4]',
        '',
    ]
    return '\n'.join(head + lines)


def check():
    bad = 0

    keys = load_keys()
    actual = dart_arrays()
    for name, key in keys.items():
        if name not in actual:
            print(f'  ✗ {name}: Dart 里没有 _{name} 数组')
            bad += 1
        elif actual[name] != encode(key):
            print(f'  ✗ {name}: Dart 数组与钥匙文件不一致（需重跑生成器）')
            bad += 1
        else:
            print(f'  ✓ {name}: 一致')
    for name in actual:
        if name not in keys:
            print(f'  ⚠ {name}: 只存在于 Dart，钥匙文件没有 -> 重跑生成器会丢掉它')
            bad += 1

    # 端点单独一组校验。空数组是仓库内的正常状态，所以「文件里没有这个端点」
    # 只提示不计数——本地没配就不配，不该让 --check 红。
    eps = load_endpoints()
    ep_actual = dart_arrays(prefix='ep')
    expected = {f'ep{camel(n)}' for n in eps}
    for name, ep in eps.items():
        arr = f'ep{camel(name)}'
        if arr not in ep_actual:
            print(f'  ✗ {arr}: Dart 里没有 _{arr} 数组')
            bad += 1
        elif ep_actual[arr] != encode(ep):
            print(f'  ✗ {arr}: Dart 数组与端点文件不一致（需重跑生成器）')
            bad += 1
        else:
            print(f'  ✓ {arr}: 一致')
    for arr, value in ep_actual.items():
        if arr in expected:
            continue
        if value:
            print(f'  ⚠ {arr}: Dart 里有值但端点文件没有对应项 -> 重跑会丢掉它')
            bad += 1
        else:
            print(f'  – {arr}: 空数组（仓库常态，本地未配置）')

    total = len(keys) + len(eps)
    if bad:
        print(f'\n{total} 项来源，{bad} 项有问题。')
        return 1
    print(f'\n全部一致（{len(keys)} 把钥匙 + {len(eps)} 个端点）。')
    return 0


if __name__ == '__main__':
    if '--check' in sys.argv:
        sys.exit(check())
    print(render())
