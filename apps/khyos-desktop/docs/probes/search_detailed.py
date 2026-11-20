import os
import re

# Search the main styles JS file for specific patterns
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'zcode-extracted', 'out', 'renderer', 'assets')
js_file = os.path.join(BASE, 'styles-DyAcaLKy.js')

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Find dropdown pattern - looks like model selector
idx = content.find('dropdown')
while idx >= 0:
    start = max(0, idx - 200)
    end = min(len(content), idx + 500)
    context = content[start:end]
    print(f'\n=== dropdown at {idx} ===')
    print(context)
    print('---')
    idx = content.find('dropdown', idx + 1)
    if idx > 2000000:  # Limit search
        break
