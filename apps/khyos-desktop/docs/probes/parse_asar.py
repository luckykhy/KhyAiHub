import struct
import json
import os
import sys

# ZCode 的安装位置随机器而异：路径由 env 给，不把某台机器的盘符钉进仓库。
asar_path = os.environ.get('ZCODE_ASAR_PATH')
if not asar_path:
    sys.exit('请设置 ZCODE_ASAR_PATH，指向本机 ZCode 安装目录下的 resources/app.asar')

output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'zcode-extracted')

with open(asar_path, 'rb') as f:
    data = f.read(16)
    print(f'First 16 bytes: {data.hex()}')
    
    # asar format: 4 bytes pickle_size, then pickle data
    # pickle data contains: 4 bytes header_size, then header JSON
    pickle_size = struct.unpack('<I', data[0:4])[0]
    header_size = struct.unpack('<I', data[4:8])[0]
    print(f'pickle_size={pickle_size}, header_size={header_size}')
    
    # Read header JSON starting at offset 8
    f.seek(8)
    header_bytes = f.read(header_size)
    print(f'Read {len(header_bytes)} bytes')
    
    # Try to parse JSON
    try:
        header = json.loads(header_bytes.decode('utf-8'))
    except:
        # Maybe there's extra data, try to find the JSON end
        # Find the last } character
        header_str = header_bytes.decode('utf-8', errors='ignore')
        last_brace = header_str.rfind('}')
        if last_brace > 0:
            header = json.loads(header_str[:last_brace+1])
        else:
            raise
    
    files = header.get('files', {})
    print(f'Total files: {len(files)}')
    
    css_files = [k for k in files if k.endswith('.css')]
    print(f'CSS files ({len(css_files)}):')
    for c in css_files[:10]:
        print(f'  {c}')
    
    js_files = [k for k in files if k.endswith('.js')]
    print(f'JS files ({len(js_files)}):')
    for j in js_files[:10]:
        print(f'  {j}')
