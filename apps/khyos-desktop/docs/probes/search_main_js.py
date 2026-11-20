import os
import re

# Search the main styles JS file for specific patterns
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'zcode-extracted', 'out', 'renderer', 'assets')
js_file = os.path.join(BASE, 'styles-DyAcaLKy.js')

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

print(f'File size: {len(content)} bytes')

# Search for specific patterns
patterns = ['mention', 'context', 'attach', 'chip', 'permission', 'model', 'think', 'reason', 'agent', 'collapse', 'fold', 'expand', 'select', 'dropdown', 'popup', 'popover', 'input', 'prompt', 'send', 'button']

for p in patterns:
    idx = content.lower().find(p)
    if idx >= 0:
        print(f'\n=== Found "{p}" at {idx} ===')
        # Show context
        start = max(0, idx - 100)
        end = min(len(content), idx + 300)
        print(content[start:end])
        print('---')
