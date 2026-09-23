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

# XOR key: 4 bytes, rotated per position
XK = [0xA3, 0x5F, 0xC2, 0x1B]

DART = (Path(__file__).resolve().parent.parent
        / 'apps/khy-os-client-app/lib/core/config/built_in_keys.dart')


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


def dart_arrays():
    """从 built_in_keys.dart 读出所有 `static const List<int> _name = [...]`。"""
    if not DART.exists():
        return {}
    txt = DART.read_text(encoding='utf-8')
    out = {}
    for m in re.finditer(r'static const List<int> _(\w+)\s*=\s*\[(.*?)\];', txt, re.S):
        out[m.group(1)] = [int(x) for x in re.findall(r'\d+', m.group(2))]
    return out


def render():
    lines = []
    for name, key in load_keys().items():
        enc = encode(key)
        assert decode(enc) == key, f'XOR 往返失败: {name}'
        lines.append(f'  static const List<int> _{name} = [')
        for i in range(0, len(enc), 12):
            lines.append('    ' + ', '.join(str(x) for x in enc[i:i + 12]) + ',')
        lines.append('  ];')
        lines.append('')
    head = [
        '// XOR key: 0xA3, 0x5F, 0xC2, 0x1B',
        '// Decode: s[i] = bytes[i] ^ KEY[i % 4]',
        '',
    ]
    return '\n'.join(head + lines)


def check():
    keys = load_keys()
    actual = dart_arrays()
    bad = 0
    for name, key in keys.items():
        if name not in actual:
            print(f'  ❌ {name}: Dart 里没有 _{name} 数组')
            bad += 1
        elif actual[name] != encode(key):
            print(f'  ❌ {name}: Dart 数组与钥匙文件不一致（需重跑生成器）')
            bad += 1
        else:
            print(f'  ✅ {name}: 一致')
    for name in actual:
        if name not in keys:
            print(f'  ⚠ {name}: 只存在于 Dart，钥匙文件没有 -> 重跑生成器会丢掉它')
            bad += 1
    if bad:
        print(f'\n{len(keys) + len(actual) - bad} 项通过，{bad} 项有问题。')
        return 1
    print(f'\n全部 {len(keys)} 把一致。')
    return 0


if __name__ == '__main__':
    if '--check' in sys.argv:
        sys.exit(check())
    print(render())
