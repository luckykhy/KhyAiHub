import os
import re

# Search for mention UI patterns
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'zcode-extracted', 'out', 'renderer', 'assets')
js_file = os.path.join(BASE, 'styles-DyAcaLKy.js')

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Find mention UI
idx = content.find('chat.mention')
count = 0
while idx >= 0 and count < 10:
    ctx = content[max(0,idx-200):idx+500]
    print(f'--- chat.mention at {idx} ---')
    print(ctx)
    print()
    idx = content.find('chat.mention', idx + 1)
    count += 1
