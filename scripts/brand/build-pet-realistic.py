# Khy OS 桌宠「写实真人 3D」资产归一化脚本（Blender headless）
#
# 用途：把**外部 AI 3D 服务**（image-to-3D：真人立绘 → GLB）出的原始模型
# 归一化成桌宠能直接用的资产：
#   · 朝向统一：Y-up、正面朝 +Z（glTF 规范）——与 Q 版真 3D 模型、浮雕同一套朝向
#   · 尺度统一：角色高度 = 1.05 单位（与 build-pet-model.py 同一套构图）
#   · 落地居中：脚下贴 Z=0，水平中心归到原点（转盘才不会变成「绕着轨道转」）
#   · 去杂物：服务常附赠的地面板/底座会被剔掉（否则包围盒被撑大、相机拉远）
#   · 出兜底图：36 帧转盘序列（6×6 精灵表）供没有 WebGL 的环境使用
#
# 为什么需要这一层归一化：不同服务的输出约定不一致（有的 Z-up、有的背朝前、
# 有的自带一块地面）。桌面端的渲染器按「Y-up、正面朝 +Z、高度约 1.05」构图，
# 不归一化就会躺平、背对镜头、或者缩成一小撮。
#
# 用法（仓库根目录）：
#   blender --background --python scripts/brand/build-pet-realistic.py -- \
#       <原始GLB路径> <角色ID: female|male> [--flip] [--up z]
#
#   --flip   原始模型背朝前时加：绕竖轴转 180°
#   --up z   原始模型是 Z-up 时加：绕 X 轴转 -90° 把它立起来
#
# 产出：
#   delivery/brand/pet/models/khy-pet-<角色>-realistic.glb
#   delivery/brand/pet/models/khy-pet-<角色>-realistic-turntable.png
#   works/design/khy-mascot/model/khy-pet-<角色>-realistic-preview-*.png
#   works/design/khy-mascot/model/frames/<前缀>_NNN.png（中间帧，可删）

import bpy
import math
import os
import sys

import numpy as np
from mathutils import Vector

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_DIR = os.path.join(REPO, 'delivery', 'brand', 'pet', 'models')
PREVIEW_DIR = os.path.join(REPO, 'works', 'design', 'khy-mascot', 'model')
FRAME_DIR = os.path.join(PREVIEW_DIR, 'frames')

# 与 build-pet-model.py 同一套构图参数。
TARGET_HEIGHT = 1.05
CAM_DIST = 3.15
CAM_LENS = 62
CAM_HEIGHT = 1.0

# 转盘精灵表：6×6，每帧 256px（渲染端 frameForAngle 按同一套约定取帧）。
SPRITE_COLS = 6
SPRITE_ROWS = 6
SPRITE_FRAME = 256
SPRITE_FRAMES = SPRITE_COLS * SPRITE_ROWS

PET_LIGHTS = []


# ── 参数 ──────────────────────────────────────────────────────────────

def parse_args():
    """取 `blender --python script.py -- <参数>` 的参数段。"""
    argv = []
    if '--' in sys.argv:
        argv = sys.argv[sys.argv.index('--') + 1:]
    if len(argv) < 2:
        raise SystemExit(
            '用法: blender --background --python scripts/brand/build-pet-realistic.py -- '
            '<原始GLB> <female|male> [--flip] [--up z] [--out-dir DIR] [--preview-dir DIR]'
        )
    raw = os.path.abspath(argv[0])
    character = argv[1]
    if character not in ('female', 'male'):
        raise SystemExit('角色 ID 只能是 female 或 male，收到: %s' % character)
    flip = '--flip' in argv
    up = 'z' if '--up' in argv and argv[argv.index('--up') + 1].lower() == 'z' else 'y'
    out_dir = OUT_DIR
    if '--out-dir' in argv:
        out_dir = os.path.abspath(argv[argv.index('--out-dir') + 1])
    preview_dir = PREVIEW_DIR
    if '--preview-dir' in argv:
        preview_dir = os.path.abspath(argv[argv.index('--preview-dir') + 1])
    return raw, character, flip, up, out_dir, preview_dir


# ── 场景 ──────────────────────────────────────────────────────────────

def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    PET_LIGHTS.clear()


def setup_scene():
    scene = bpy.context.scene
    try:
        scene.render.engine = 'BLENDER_EEVEE_NEXT'
    except TypeError:
        scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = 700
    scene.render.resolution_y = 700
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    # 色彩管理必须 Standard：默认的 AgX/Filmic 会把贴图洗成灰蓝，
    # 设定值和渲出来的不一致，颜色就永远不是服务出的那张脸。
    try:
        scene.view_settings.view_transform = 'Standard'
        scene.view_settings.look = 'None'
    except TypeError:
        pass
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    world = bpy.data.worlds.new('petWorld')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.95, 0.95, 0.97, 1.0)
        bg.inputs[1].default_value = 1.1

    for tag, loc, energy, size in (
        ('key', (0.9, -1.8, 1.6), 190, 1.4),
        ('fill', (-1.0, -1.4, 0.9), 120, 1.6),
        ('rim', (0.0, 1.6, 1.2), 120, 1.6),
    ):
        bpy.ops.object.light_add(type='AREA', location=loc)
        light = bpy.context.object
        light.data.energy = energy
        light.data.size = size
        PET_LIGHTS.append((tag, light))

    bpy.ops.object.camera_add(location=(0, -CAM_DIST, CAM_HEIGHT),
                              rotation=(math.radians(86), 0, 0))
    cam = bpy.context.object
    cam.data.lens = CAM_LENS
    scene.camera = cam
    return scene


def aim_camera(cam, yaw_deg):
    """把相机绕竖轴转到指定偏航，光源跟着相机走（写死光方向的话背面会黑成剪影）。"""
    rad = math.radians(yaw_deg)
    cam.location = (math.sin(rad) * CAM_DIST, -math.cos(rad) * CAM_DIST, CAM_HEIGHT)
    cam.rotation_euler = (math.radians(86), 0, rad)

    def rot(offset):
        x, y, z = offset
        return (x * math.cos(rad) - y * math.sin(rad),
                x * math.sin(rad) + y * math.cos(rad), z)

    # 三盏灯按「主光偏右上、补光偏左后、轮廓光偏上后」排布，
    # 跟随相机旋转后任何角度都有一致的明暗关系。
    offsets = {
        'key': (0.45, -0.55, 0.75),
        'fill': (-0.6, -0.35, 0.35),
        'rim': (-0.2, 0.9, 0.6),
    }
    for tag, light in PET_LIGHTS:
        offset = offsets.get(tag, offsets['key'])
        moved = rot(offset)
        light.location = (cam.location[0] + moved[0],
                          cam.location[1] + moved[1],
                          cam.location[2] + offset[2])


# ── 归一化 ────────────────────────────────────────────────────────────

def world_bounds(objs):
    """所有物体的世界坐标包围盒。"""
    corners = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    if not corners:
        return None
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return lo, hi


def strip_stray_geometry(objs):
    """剔掉服务附赠的地面/底座。

    image-to-3D 服务常在模型脚下垫一块圆盘或平板。那块板会把包围盒撑大到
    角色的好几倍，相机被拉远，角色缩成一小撮；渲染出来还多一个不存在的底盘。
    判据：**扁平**（Z 厚度不足整体高度的 3%）且**横向铺开**（水平跨度超过
    整体宽度的 1.2 倍）—— 角色本体不会长这样。
    """
    bounds = world_bounds(objs)
    if bounds is None:
        return objs
    lo, hi = bounds
    height = max(hi.z - lo.z, 1e-6)
    width = max(hi.x - lo.x, 1e-6)
    depth = max(hi.y - lo.y, 1e-6)

    kept = []
    for obj in objs:
        ob_bounds = world_bounds([obj])
        if ob_bounds is None:
            continue
        o_lo, o_hi = ob_bounds
        flat = (o_hi.z - o_lo.z) < height * 0.03
        spread = max(o_hi.x - o_lo.x, o_hi.y - o_lo.y) > max(width, depth) * 1.2
        if flat and spread:
            print('[realistic] 剔除地面/底座:', obj.name)
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        kept.append(obj)
    return kept


def bake_and_normalize(objs, up_axis, flip):
    """把变换烘进网格，再统一尺度与位置。

    烘变换是必须的：glTF 导出把物体变换写成节点，节点缩放与网格缩放会叠加，
    导出的网格会缩到只剩几百分之一（三角形面积 ~1e-5，渲染出来是一堆看不见的点）。
    """
    if not objs:
        raise SystemExit('原始 GLB 里没有网格物体')

    bpy.ops.object.select_all(action='DESELECT')
    for obj in objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Z-up 的原始模型先立起来（Blender 里是 Z-up，绕 X 转 -90° 让它站直）。
    if up_axis == 'z':
        for obj in objs:
            obj.rotation_euler = (math.radians(-90.0), 0.0, 0.0)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
        print('[realistic] 原始模型是 Z-up，已绕 X 轴立起来')

    if flip:
        for obj in objs:
            obj.rotation_euler = (0.0, 0.0, math.radians(180.0))
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
        print('[realistic] 已绕竖轴翻转 180°')

    # 尺度：高度归到 TARGET_HEIGHT。
    lo, hi = world_bounds(objs)
    height = max(hi.z - lo.z, 1e-6)
    factor = TARGET_HEIGHT / height
    for obj in objs:
        obj.scale = (factor, factor, factor)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # 位置：脚下贴 Z=0，水平中心归到原点。
    lo, hi = world_bounds(objs)
    cx = (lo.x + hi.x) / 2
    cy = (lo.y + hi.y) / 2
    for obj in objs:
        obj.location.x -= cx
        obj.location.y -= cy
        obj.location.z -= lo.z
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    lo, hi = world_bounds(objs)
    print('[realistic] 归一化后 高=%.3f 宽=%.3f 深=%.3f' % (
        hi.z - lo.z, hi.x - lo.x, hi.y - lo.y))


def export_glb(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_apply=True,
        export_yup=True,
        export_materials='EXPORT',
        export_image_format='AUTO',
    )
    print('[realistic] exported', path, os.path.getsize(path))


# ── 出图 ──────────────────────────────────────────────────────────────

def render_previews(prefix, preview_dir):
    """四视角校验图：只有走这一趟才验得到「朝向对不对、贴图有没有上下颠倒」。"""
    scene = bpy.context.scene
    cam = scene.camera
    os.makedirs(preview_dir, exist_ok=True)
    outs = []
    for yaw, name in ((0, 'front'), (40, 'three-quarter'), (90, 'side'), (180, 'back')):
        aim_camera(cam, yaw)
        path = os.path.join(preview_dir, '%s-realistic-preview-%s.png' % (prefix, name))
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        outs.append(path)
        print('[realistic] preview', path)
    return outs


def render_turntable(prefix, frame_dir):
    """36 帧转盘序列（10°/帧），供没有 WebGL 的环境做 2.5D 兜底。"""
    scene = bpy.context.scene
    cam = scene.camera
    scene.render.resolution_x = SPRITE_FRAME
    scene.render.resolution_y = SPRITE_FRAME
    os.makedirs(frame_dir, exist_ok=True)
    paths = []
    for i in range(SPRITE_FRAMES):
        aim_camera(cam, 360.0 * i / SPRITE_FRAMES)
        path = os.path.join(frame_dir, '%s_realistic_%03d.png' % (prefix, i))
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        paths.append(path)
    scene.render.resolution_x = 700
    scene.render.resolution_y = 700
    print('[realistic] turntable frames', len(paths))
    return paths


def assemble_sheet(frame_paths, out_path):
    """把 36 帧拼成 6×6 精灵表。

    两处方向别搞反：
      · Blender 的像素缓冲是**自下而上**的，画布是**自上而下**的 ——
        第 0 帧要落在精灵表的**左上角**，在自下而上的缓冲里就是最后一行。
      · 帧与帧之间不能有缩放：每帧都是 256×256 原尺寸贴进去。
    """
    size = SPRITE_FRAME
    sheet_w = size * SPRITE_COLS
    sheet_h = size * SPRITE_ROWS
    sheet = bpy.data.images.new('petTurntable', width=sheet_w, height=sheet_h, alpha=True)
    buf = np.zeros((sheet_h, sheet_w, 4), dtype=np.float32)

    for index, path in enumerate(frame_paths):
        img = bpy.data.images.load(path)
        w, h = img.size
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(h, w, 4)
        col = index % SPRITE_COLS
        row = index // SPRITE_COLS
        y0 = (SPRITE_ROWS - 1 - row) * size
        x0 = col * size
        buf[y0:y0 + h, x0:x0 + w, :] = px
        bpy.data.images.remove(img)

    sheet.pixels.foreach_set(buf.ravel())
    sheet.filepath_raw = out_path
    sheet.file_format = 'PNG'
    sheet.save()
    print('[realistic] sheet', out_path, os.path.getsize(out_path))
    return out_path


def main():
    raw_glb, character, flip, up_axis, out_dir, preview_dir = parse_args()
    if not os.path.exists(raw_glb):
        raise SystemExit('原始 GLB 不存在: %s' % raw_glb)

    os.makedirs(out_dir, exist_ok=True)
    prefix = 'khy-pet-%s' % character

    clear_scene()
    setup_scene()
    bpy.ops.import_scene.gltf(filepath=raw_glb)
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    print('[realistic] 导入网格物体', len(objs))
    objs = strip_stray_geometry(objs)
    bake_and_normalize(objs, up_axis, flip)

    glb_path = os.path.join(out_dir, '%s-realistic.glb' % prefix)
    export_glb(glb_path)

    render_previews(prefix, preview_dir)
    if not os.environ.get('KHY_PET_SKIP_TURNTABLE'):
        frames = render_turntable(prefix, os.path.join(preview_dir, 'frames'))
        assemble_sheet(frames, os.path.join(out_dir, '%s-realistic-turntable.png' % prefix))

    print('[realistic] done')
    print('[realistic] 下一步: node scripts/brand/build-brand-assets.js 把资产分发到各端')


if __name__ == '__main__':
    main()
