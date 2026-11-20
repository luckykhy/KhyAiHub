import os
import re

# Search for mention patterns
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'zcode-extracted', 'out', 'renderer', 'assets')
js_file = os.path.join(BASE, 'styles-DyAcaLKy.js')

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Find mention patterns
idx = content.find('mention')
while idx >= 0 and idx < 100000:
    ctx = content[max(0,idx-100):idx+300]
    print(f'--- mention at {idx} ---')
    print(ctx)
    print()
    idx = content.find('mention', idx + 1)
    if idx > 100000:
        break
