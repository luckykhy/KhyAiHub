import os
import sys
import struct
import json
import shutil

# ZCode 的安装位置随机器而异：路径由 env 给，不把某台机器的盘符钉进仓库。
asar_path = os.environ.get('ZCODE_ASAR_PATH')
if not asar_path:
    sys.exit('请设置 ZCODE_ASAR_PATH，指向本机 ZCode 安装目录下的 resources/app.asar')

output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'zcode-extracted')

# Remove output dir if exists
if os.path.exists(output_dir):
    shutil.rmtree(output_dir)

f = open(asar_path, 'rb')

# Read header
f.seek(4)
header_size = struct.unpack('I', f.read(4))[0] - 8
f.seek(f.tell() + 8)
header = f.read(header_size).decode('utf-8')
files = json.loads(header)
baseoffset = f.tell()

def extract_dir(path, files_dict, dest):
    os.makedirs(dest, exist_ok=True)
    for name, contents in files_dict.items():
        item_path = os.path.join(path, name)
        item_dest = os.path.join(dest, name)
        if 'files' in contents:
            extract_dir(item_path, contents['files'], item_dest)
        elif 'offset' in contents:
            f.seek(baseoffset + int(contents['offset']))
            data = f.read(int(contents['size']))
            with open(item_dest, 'wb') as out:
                out.write(data)
            print(f'  Extracted: {item_path}')

print('Extracting...')
extract_dir('.', files['files'], output_dir)
f.close()
print(f'Done! Extracted to {output_dir}')
