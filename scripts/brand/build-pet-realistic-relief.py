# Khy OS 桌宠「写实真人 3D 模型」生成脚本（Blender headless）
#
# 用途：把**写实真人立绘**烘成带厚度的 2.5D 网格，导出 GLB，填进第三形态的模型槽位。
#
# 为什么需要这一条（v7）：
#   第三形态「写实真人」原定的产物是外部 AI 3D 服务 image-to-3D 出的**真 3D 网格**。
#   但那台机器上所有外部 3D 服务都缺 token（replicate / siliconflow / dashscope
#   可达但 401；tripo / meshy / openai / huggingface.co 超时），本地跑
#   StableFast3D 也不成立（diffusers 0.42.1 没有 StableFast3DPipeline；官方 sf3d 包
#   的 texture_baker / uv_unwrapper 是原生扩展，Windows 上装不动）。
#   本脚本给出**不依赖任何 token、不依赖 GPU** 的兜底：真人立绘照样是**真网格**
#   （有厚度、有起伏、能转），只是拓扑是 2.5D 而不是扫描出来的全身拓扑。
#
# 与 scripts/brand/build-pet-relief.py 的关系：
#   同一套抠图（梯度屏障 + 泛洪）、同一套网格生成、同一套朝向与归一化，
#   只是输入图不同、起伏参数不同（真人立绘的轮廓更细，起伏要更浅）。
#
# 与 scripts/brand/build-pet-realistic.py 的关系：
#   那一个处理**外部服务出的原始 GLB**（归一化 + 出预览 + 出转盘）；
#   这一个处理**本地立绘底图**（抠图 + 起网格 + 出预览 + 出转盘）。
#   两者产出落在**同一个槽位**上：外部服务一旦给出真扫描网格，
#   build-pet-realistic.py 会用同名文件覆盖本脚本的产物 —— 槽位不变，形态不变。
#
# 用法（仓库根目录）：
#   blender --background --python scripts/brand/build-pet-realistic-relief.py
#
# 产出：
#   delivery/brand/pet/models/khy-pet-female-realistic.glb        ← 第三形态模型槽位
#   delivery/brand/pet/models/khy-pet-male-realistic.glb          ← 第三形态模型槽位
#   delivery/brand/pet/models/khy-pet-female-realistic-turntable.png ← 无 WebGL 时的 2.5D 兜底
#   delivery/brand/pet/models/khy-pet-male-realistic-turntable.png
#   works/design/khy-mascot/model/khy-pet-*-realistic-relief-preview-*.png

import bpy
import math
import os

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_DIR = os.path.join(REPO, 'delivery', 'brand', 'pet', 'models')
PREVIEW_DIR = os.path.join(REPO, 'works', 'design', 'khy-mascot', 'model')
INBOX = os.path.join(REPO, 'works', 'design', 'khy-mascot', 'model', 'inbox')

# 网格密度。真人立绘轮廓比 Q 版立绘细密得多，128 是「132px 桌宠看不出锯齿」
# 与「包体」之间的平衡点（与 build-pet-relief.py 的 96 同一量级）。
GRID = 128
# 真人立绘是**照片级渲染**：颜色和明暗层次都靠贴图承载，网格起伏只负责
# 「转起来不是一张平面」。所以起伏比 Q 版立绘浅得多 —— 否则光照会盖过贴图。
DEPTH = 0.045       # 正面最高凸起（角色高度的 4.5%）
THICKNESS = 0.010   # 背板厚度（角色高度的 1.0%）

# 抠背景的梯度阈值（相邻像素亮度差，sRGB 0..1）。真人立绘的背景是**渐变**，
# 肤色与背景接近，用「和背景色的色差」当判据会把脸一起抠掉，所以仍然用
# 梯度屏障 + 泛洪。
EDGE_THRESHOLD = 0.035
EDGE_CLOSE_RADIUS = 2

# 输入与产物对照表：(底图, 输出 GLB, 前缀)
#
# 输出名就是**第三形态的模型槽位**（petRealisticAssets.ts 的 glob 认
# `*-realistic.glb`）。名字不带 relief —— relief 只是**当前这一版的实现方式**，
# 外部服务出真扫描网格时用同名文件覆盖即可，槽位名不必跟着实现方式变。
JOBS = (
    ('khy-pet-female-realistic-source-marked.png', 'khy-pet-female-realistic.glb', 'khy-pet-female'),
    ('khy-pet-male-realistic-source-marked.png', 'khy-pet-male-realistic.glb', 'khy-pet-male'),
)

# 转盘精灵表：6×6，每帧 256px（渲染端 frameForAngle 按同一套约定取帧）。
# 与 build-pet-model.py / build-pet-realistic.py 完全一致，不能各写各的。
SPRITE_COLS = 6
SPRITE_ROWS = 6
SPRITE_FRAME = 256
SPRITE_FRAMES = SPRITE_COLS * SPRITE_ROWS

# 转盘渲染的相机参数（与转盘图的长宽比配套：正方形）。
TURN_DIST = 2.5
TURN_HEIGHT = 0.5


def linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)


def dilate(mask):
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    return out


def erode_std(mask):
    padded = np.pad(mask, 1, constant_values=False)
    return ~dilate(~padded)[1:-1, 1:-1]


def erode(mask):
    padded = np.pad(mask, 1, constant_values=True)
    return ~dilate(~padded)[1:-1, 1:-1]


def morph_close(mask, radius):
    out = mask.copy()
    for _ in range(radius):
        out = dilate(out)
    for _ in range(radius):
        out = erode_std(out)
    return out


def flood_from_border(free, h, w):
    region = np.zeros((h, w), dtype=bool)
    region[0, :] = True
    region[h - 1, :] = True
    region[:, 0] = True
    region[:, w - 1] = True
    region &= free
    for _ in range(h + w):
        grown = dilate(region) & free
        if grown.sum() == region.sum():
            break
        region = grown
    return region


def cutout_background(pixels, w, h):
    arr = np.array(pixels, dtype=np.float32).reshape(h, w, 4)
    srgb = linear_to_srgb(arr[:, :, :3])
    lum = srgb[:, :, 0] * 0.2126 + srgb[:, :, 1] * 0.7152 + srgb[:, :, 2] * 0.0722

    barrier = np.zeros((h, w), dtype=bool)
    dx = np.abs(np.diff(lum, axis=1)) > EDGE_THRESHOLD
    barrier[:, :-1] |= dx
    barrier[:, 1:] |= dx
    dy = np.abs(np.diff(lum, axis=0)) > EDGE_THRESHOLD
    barrier[:-1, :] |= dy
    barrier[1:, :] |= dy
    barrier = morph_close(barrier, EDGE_CLOSE_RADIUS)

    BORDER = 3
    barrier[:BORDER, :] = False
    barrier[h - BORDER:, :] = False
    barrier[:, :BORDER] = False
    barrier[:, w - BORDER:] = False

    bg = flood_from_border(~barrier, h, w)
    bg[:BORDER, :] = True
    bg[h - BORDER:, :] = True
    bg[:, :BORDER] = True
    bg[:, w - BORDER:] = True

    enclosed = bg & ~flood_from_border(bg, h, w)
    solid = ~bg | enclosed

    bg_inner = erode(bg)
    alpha = np.full((h, w), 255.0, dtype=np.float32)
    alpha[bg] = 0.0
    alpha[bg & ~bg_inner] = 128.0
    return alpha, solid


def write_cutout(art_path, out_path, alpha):
    img = bpy.data.images.load(art_path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    px[:, :, 3] = alpha / 255.0
    out = bpy.data.images.new('cutout', width=w, height=h, alpha=True)
    out.pixels.foreach_set(px.reshape(-1))
    out.filepath_raw = out_path
    out.file_format = 'PNG'
    out.save()
    return out_path


def setup_scene():
    """渲染用场景：EEVEE + Standard 色彩变换（默认 AgX 会把颜色洗掉，
    渲出来的和设定值对不上，就没法拿来当比对基准）。

    开头那句 `delete()` 不能少：Blender 启动场景里有一个默认立方体，
    不删掉它，它会被一起导进 GLB —— 2×2×2 的白盒子正好糊住整个取景框。
    """
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    scene = bpy.context.scene
    try:
        scene.render.engine = 'BLENDER_EEVEE_NEXT'
    except TypeError:
        scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = True
    try:
        scene.view_settings.view_transform = 'Standard'
        scene.view_settings.look = 'None'
    except TypeError:
        pass
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    world = bpy.data.worlds.new('realisticReliefWorld')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.96, 0.95, 0.97, 1.0)
        bg.inputs[1].default_value = 1.0


def build_relief(art_name, out_name, prefix):
    art_path = os.path.join(INBOX, art_name)
    cut_path = os.path.join(INBOX, art_name.replace('.png', '-cutout.png'))

    src = bpy.data.images.load(art_path)
    w, h = src.size
    raw = np.empty(w * h * 4, dtype=np.float32)
    src.pixels.foreach_get(raw)
    alpha, solid = cutout_background(raw, w, h)
    write_cutout(art_path, cut_path, alpha)
    print('[realistic-relief] cutout', cut_path, 'solid px', int(solid.sum()))

    solidf = solid.astype(np.float32)
    pad = np.pad(solidf, 1, mode='edge')
    soft = np.zeros((h, w), dtype=np.float32)
    for dy in range(3):
        for dx in range(3):
            soft += pad[dy:dy + h, dx:dx + w]
    soft /= 9.0

    def mask(u, v):
        x = max(0, min(w - 1, int(u * (w - 1))))
        y = max(0, min(h - 1, int(v * (h - 1))))
        return float(soft[y, x])

    setup_scene()
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=GRID, y_subdivisions=GRID, size=1.0)
    grid = bpy.context.object
    grid.name = 'realistic_relief'

    for v in grid.data.vertices:
        u = v.co.x + 0.5
        vv = v.co.y + 0.5
        m = mask(u, vv)
        v.co.z = m * DEPTH
        v.co.x *= (1.0 + m * 0.02)
        v.co.y *= (1.0 + m * 0.02)

    import bmesh
    bm = bmesh.new()
    bm.from_mesh(grid.data)
    bm.faces.ensure_lookup_table()
    to_remove = []
    for face in bm.faces:
        corners = [v.co for v in face.verts]
        us = [(c.x + 0.5, c.y + 0.5) for c in corners]
        if all(mask(u, vv) < 0.5 for u, vv in us):
            to_remove.append(face)
    bmesh.ops.delete(bm, geom=to_remove, context='FACES')
    bm.to_mesh(grid.data)
    bm.free()

    mod = grid.modifiers.new('solidify', 'SOLIDIFY')
    mod.thickness = THICKNESS
    mod.offset = 0.0

    mat = bpy.data.materials.new('realistic_relief_art')
    mat.use_nodes = True
    bsdf = None
    for node in mat.node_tree.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            bsdf = node
            break
    tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(cut_path)
    tex.interpolation = 'Linear'
    mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    if 'Alpha' in bsdf.inputs:
        mat.node_tree.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
    if 'Roughness' in bsdf.inputs:
        bsdf.inputs['Roughness'].default_value = 0.5
    try:
        mat.blend_method = 'BLEND'
    except (AttributeError, TypeError):
        pass
    grid.data.materials.append(mat)

    bpy.context.view_layer.objects.active = grid
    bpy.ops.object.modifier_apply(modifier=mod.name)

    # 绕 X 轴转 +90°：Blender Z-up → glTF Y-up，正面朝 +Z（与其它桌宠模型一致）。
    bpy.ops.object.select_all(action='DESELECT')
    grid.select_set(True)
    bpy.context.view_layer.objects.active = grid
    grid.rotation_euler = (math.radians(90.0), 0.0, 0.0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)

    zs = [v.co.z for v in grid.data.vertices]
    height = max(zs) - min(zs)
    if height > 1e-6:
        factor = 1.0 / height
        for v in grid.data.vertices:
            v.co.x *= factor
            v.co.y *= factor
            v.co.z *= factor
    min_z = min(v.co.z for v in grid.data.vertices)
    max_y = max(v.co.y for v in grid.data.vertices)
    for v in grid.data.vertices:
        v.co.z -= min_z
        v.co.y -= max_y

    out_path = os.path.join(OUT_DIR, out_name)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format='GLB',
        export_apply=True,
        export_yup=True,
        export_materials='EXPORT',
        export_image_format='AUTO',
    )
    print('[realistic-relief] exported', out_path, os.path.getsize(out_path))
    return out_path


def render_roundtrip(glb_path, prefix):
    setup_scene()
    bpy.ops.import_scene.gltf(filepath=glb_path)
    scene = bpy.context.scene

    bpy.ops.object.camera_add(location=(0, -2.4, 0.5), rotation=(math.radians(90), 0, 0))
    cam = bpy.context.object
    cam.data.lens = 55
    scene.camera = cam
    bpy.ops.object.light_add(type='AREA', location=(0.8, -1.6, 1.3))
    bpy.context.object.data.energy = 200
    bpy.context.object.data.size = 2.0
    bpy.ops.object.light_add(type='AREA', location=(-0.9, -1.2, 0.7))
    bpy.context.object.data.energy = 120
    bpy.context.object.data.size = 2.0
    bpy.ops.object.light_add(type='AREA', location=(0.0, 1.4, 1.0))
    bpy.context.object.data.energy = 120

    os.makedirs(PREVIEW_DIR, exist_ok=True)
    outs = []
    for yaw, name in ((0, 'front'), (40, 'three-quarter')):
        rad = math.radians(yaw)
        dist = 2.4
        cam.location = (math.sin(rad) * dist, -math.cos(rad) * dist, 0.5)
        cam.rotation_euler = (math.radians(90), 0, rad)
        path = os.path.join(PREVIEW_DIR, '%s-realistic-relief-preview-%s.png' % (prefix, name))
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        outs.append(path)
        print('[realistic-relief] preview', path)
    return outs


def render_turntable(glb_path, prefix):
    """36 帧转盘序列（10°/帧），供没有 WebGL 的环境做 2.5D 兜底。

    与 build-pet-realistic.py 同一套约定：6×6 精灵表、每帧 256px。
    灯跟着相机转 —— 写死光方向的话背面会黑成剪影，转盘转到后面全是黑的。
    """
    setup_scene()
    bpy.ops.import_scene.gltf(filepath=glb_path)
    scene = bpy.context.scene

    bpy.ops.object.camera_add(location=(0, -TURN_DIST, TURN_HEIGHT))
    cam = bpy.context.object
    cam.data.lens = 55
    scene.camera = cam

    offsets = ((0.45, -0.55, 0.75), (-0.6, -0.35, 0.35), (-0.2, 0.9, 0.6))
    lights = []
    for energy in (200, 120, 120):
        bpy.ops.object.light_add(type='AREA', location=(0, 0, 0))
        light = bpy.context.object
        light.data.energy = energy
        light.data.size = 2.0
        lights.append(light)

    scene.render.resolution_x = SPRITE_FRAME
    scene.render.resolution_y = SPRITE_FRAME

    frame_dir = os.path.join(PREVIEW_DIR, 'frames', prefix)
    os.makedirs(frame_dir, exist_ok=True)
    paths = []
    for i in range(SPRITE_FRAMES):
        rad = math.radians(360.0 * i / SPRITE_FRAMES)
        cam.location = (math.sin(rad) * TURN_DIST, -math.cos(rad) * TURN_DIST, TURN_HEIGHT)
        cam.rotation_euler = (math.radians(90), 0, rad)
        for light, (ox, oy, oz) in zip(lights, offsets):
            rx = ox * math.cos(rad) - oy * math.sin(rad)
            ry = ox * math.sin(rad) + oy * math.cos(rad)
            light.location = (cam.location[0] + rx, cam.location[1] + ry, cam.location[2] + oz)
        path = os.path.join(frame_dir, '%s_realistic_%03d.png' % (prefix, i))
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        paths.append(path)
    print('[realistic-relief] turntable frames', len(paths))
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
    sheet = bpy.data.images.new('petRealisticTurntable', width=sheet_w, height=sheet_h, alpha=True)
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
    print('[realistic-relief] sheet', out_path, os.path.getsize(out_path))
    return out_path


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for art_name, out_name, prefix in JOBS:
        art_path = os.path.join(INBOX, art_name)
        if not os.path.exists(art_path):
            raise SystemExit('missing base art: %s' % art_path)
        glb = build_relief(art_name, out_name, prefix)
        render_roundtrip(glb, prefix)
        if not os.environ.get('KHY_PET_SKIP_TURNTABLE'):
            frames = render_turntable(glb, prefix)
            assemble_sheet(frames, os.path.join(OUT_DIR, '%s-realistic-turntable.png' % prefix))
    print('[realistic-relief] done')
    print('[realistic-relief] next: node scripts/brand/build-brand-assets.js')


if __name__ == '__main__':
    main()
