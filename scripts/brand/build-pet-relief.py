# Khy OS 桌宠「立绘浮雕」生成脚本（Blender headless）
#
# 用途：把 AI 定妆照（PNG）烘成**带厚度的 2.5D 浮雕网格**并导出 GLB。
#   · 正面观感 = 定妆照本身（像素级一致，色彩/笔触全保留）
#   · 侧转时有真实厚度与起伏，不是贴一张图
#   · 角色外轮廓按背景色抠掉，网格就是角色本身
#
# 为什么要有这个形态：程序化 3D 模型给不了插画的柔和渐变与笔触
# （build-pet-model.py 出来的是另一个 Q 版角色，不是这张定妆照），
# 而「立绘浮雕」把定妆照原样保留，同时又满足桌宠要能转、能立体。
#
# 用法（仓库根目录）：
#   blender --background --python scripts/brand/build-pet-relief.py
#
# 产出：
#   delivery/brand/pet/models/khy-pet-female-relief.glb
#   delivery/brand/pet/models/khy-pet-male-relief.glb
#   delivery/brand/pet/models/khy-pet-koi-relief.glb
#   works/design/khy-mascot/model/khy-pet-*-relief-preview-*.png（往返校验图）

import bpy
import math
import os

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_DIR = os.path.join(REPO, 'delivery', 'brand', 'pet', 'models')
ART_DIR = os.path.join(REPO, 'delivery', 'brand', 'pet')
PREVIEW_DIR = os.path.join(REPO, 'works', 'design', 'khy-mascot', 'model')

# 网格密度。140 时单个 GLB 5.5MB（桌面端 ?inline 内联后渲染包多涨 13MB）；
# 96 是「132px 桌宠看不出锯齿」与「包体」之间的平衡点。
GRID = 96
# 浮雕起伏与实体厚度，都以**角色高度**为 1.0 计量。
DEPTH = 0.075       # 正面最高凸起（角色高度的 7.5%）
THICKNESS = 0.014   # 背板厚度（角色高度的 1.4%）
# 抠背景的梯度阈值（相邻像素亮度差，sRGB 0..1）。低于它算「平滑区」，
# 可以被泛洪；高于它算「屏障」，角色的描边就靠这条线挡住泛洪。
# 实测梯度分布：p90=0.023、p95=0.046、p98=0.092 —— 0.035 落在噪声与描边之间。
EDGE_THRESHOLD = 0.035
# 屏障的闭运算半径：把描边上细小的断点补上，否则泛洪会从缺口漏进角色内部
# （脸会被啃掉一块）。
EDGE_CLOSE_RADIUS = 2


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
    """标准腐蚀：图像边界外算「不在集合内」。"""
    padded = np.pad(mask, 1, constant_values=False)
    return ~dilate(~padded)[1:-1, 1:-1]


def erode(mask):
    """腐蚀。图像边界按「在集合内」处理 —— 否则最外一圈像素会被腐蚀掉，
    于是画布边框留下一圈 alpha=128 的羽化带，浮雕网格就会把它当成角色，
    渲出一圈方框。"""
    padded = np.pad(mask, 1, constant_values=True)
    return ~dilate(~padded)[1:-1, 1:-1]


def morph_close(mask, radius):
    """闭运算：先膨胀后腐蚀，把屏障上的细小断点补上。"""
    out = mask.copy()
    for _ in range(radius):
        out = dilate(out)
    for _ in range(radius):
        out = erode_std(out)
    return out


def flood_from_border(free, h, w):
    """从四边往里泛洪，只走 free 像素。"""
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


def cutout_background(pixels, w, h, edge_threshold=EDGE_THRESHOLD, edge_close_radius=EDGE_CLOSE_RADIUS):
    """把定妆照的背景抠掉，返回 (alpha 数组, 角色布尔数组)。

    不用「和背景色的色差」当判据：这张图的背景是**渐变**，而且角色的肤色
    和背景奶白几乎同色，用颜色阈值会把脸一起抠掉。
    这里改用**梯度屏障 + 泛洪**：
      1. 相邻像素亮度差超过阈值的地方 = 屏障（角色的描边、发丝轮廓），
         再做一次闭运算补上断点；
      2. 从四边往里泛洪，只走非屏障像素 —— 能走到的就是背景。
    角色内部的浅色（脸、围裙）被描边围住，泛洪进不去，于是保留。
    金币、星星这类独立小岛也保留（它们是屏障，泛洪绕着走）。
    最后把「被角色完全包住的小洞」填回去（御守上的商标块会被漏掉）。
    """
    arr = np.array(pixels, dtype=np.float32).reshape(h, w, 4)
    srgb = linear_to_srgb(arr[:, :, :3])
    lum = srgb[:, :, 0] * 0.2126 + srgb[:, :, 1] * 0.7152 + srgb[:, :, 2] * 0.0722

    barrier = np.zeros((h, w), dtype=bool)
    dx = np.abs(np.diff(lum, axis=1)) > edge_threshold
    barrier[:, :-1] |= dx
    barrier[:, 1:] |= dx
    dy = np.abs(np.diff(lum, axis=0)) > edge_threshold
    barrier[:-1, :] |= dy
    barrier[1:, :] |= dy
    barrier = morph_close(barrier, edge_close_radius)

    # 画布最外 3 像素一律当背景：那里的噪点不该参与判定。
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

    # 被角色完全包住的小洞（御守上的商标块）算角色的一部分
    enclosed = bg & ~flood_from_border(bg, h, w)
    solid = ~bg | enclosed

    # 1px 羽化边：背景内部 alpha=0，紧贴角色的那一圈半透明
    bg_inner = erode(bg)
    alpha = np.full((h, w), 255.0, dtype=np.float32)
    alpha[bg] = 0.0
    alpha[bg & ~bg_inner] = 128.0
    return alpha, solid


def write_cutout(art_path, out_path, alpha):
    """抠好的透明底立绘另存一份（桌面/网页/手机端的 2D 兜底都能用）。"""
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
    渲出来的和设定值对不上，就没法拿来当定妆照的比对基准）。"""
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
    world = bpy.data.worlds.new('reliefWorld')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.96, 0.95, 0.97, 1.0)
        bg.inputs[1].default_value = 1.0
    return scene


def build_relief(art_name, out_name, prefix, **tune):
    art_path = os.path.join(ART_DIR, art_name)
    cut_path = os.path.join(ART_DIR, art_name.replace('.png', '-cutout.png'))

    src = bpy.data.images.load(art_path)
    w, h = src.size
    raw = np.empty(w * h * 4, dtype=np.float32)
    src.pixels.foreach_get(raw)
    alpha, solid = cutout_background(raw, w, h, **tune)
    write_cutout(art_path, cut_path, alpha)
    print('[relief] cutout', cut_path)

    # 角色掩码（1 = 角色）。3×3 均值糊一下，让边缘在两三像素内渐变 ——
    # 硬边会让浮雕的轮廓出现一圈锯齿。
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
    grid.name = 'relief'

    # 顶点：按遮罩起伏；uv 保持 grid 默认（0..1，对应图像像素）
    for v in grid.data.vertices:
        u = v.co.x + 0.5
        vv = v.co.y + 0.5
        m = mask(u, vv)
        v.co.z = m * DEPTH
        # 边缘再往平面外鼓一点，像贴纸被顶起来
        v.co.x *= (1.0 + m * 0.02)
        v.co.y *= (1.0 + m * 0.02)

    # 删掉全背景的面：网格轮廓 = 角色轮廓
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

    # 厚度
    mod = grid.modifiers.new('solidify', 'SOLIDIFY')
    mod.thickness = THICKNESS
    mod.offset = 0.0

    # 材质：抠好的立绘当基础色（自带 alpha，边缘 1px 羽化）
    mat = bpy.data.materials.new('relief_art')
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
        bsdf.inputs['Roughness'].default_value = 0.55
    try:
        mat.blend_method = 'BLEND'
    except (AttributeError, TypeError):
        pass
    grid.data.materials.append(mat)

    bpy.context.view_layer.objects.active = grid
    bpy.ops.object.modifier_apply(modifier=mod.name)

    # ── 摆正朝向 ────────────────────────────────────────────────────────
    # 网格是在 Blender 的 **XY 平面**里搭的（Z 是浮雕起伏方向）。Blender 导 glTF
    # 时会把 Z-up 转成 Y-up：如果直接导，角色就**躺平**在 glTF 的 XZ 平面上，
    # 渲染器从 +Z 看过去只能看到一条边 —— 画布上一片空白。
    # 这里绕 X 轴转 +90°：Blender 里就站成 Z-up、正面朝 -Y；导出后正好是
    # 「Y-up、正面朝 +Z」，与 build-pet-model.py 的真 3D 模型同一套朝向。
    bpy.ops.object.select_all(action='DESELECT')
    grid.select_set(True)
    bpy.context.view_layer.objects.active = grid
    grid.rotation_euler = (math.radians(90.0), 0.0, 0.0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)

    # 归一化：角色高度（Z）= 1.0，宽度按比例；脚下贴地（Z=0），背板贴 Y=0
    zs = [v.co.z for v in grid.data.vertices]
    ys = [v.co.y for v in grid.data.vertices]
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
    print('[relief] exported', out_path, os.path.getsize(out_path))
    return out_path


def render_roundtrip(glb_path, prefix):
    """把导出的 GLB **重新导入**再渲染 —— 这是应用里看到的那一份文件，
    只有走这一趟才能验到「朝向对不对、贴图有没有上下颠倒」。"""
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
    bpy.context.object.data.size = 2.0

    os.makedirs(PREVIEW_DIR, exist_ok=True)
    outs = []
    for yaw, name in ((0, 'front'), (40, 'three-quarter')):
        rad = math.radians(yaw)
        dist = 2.4
        cam.location = (math.sin(rad) * dist, -math.cos(rad) * dist, 0.5)
        cam.rotation_euler = (math.radians(90), 0, rad)
        path = os.path.join(PREVIEW_DIR, '%s-relief-preview-%s.png' % (prefix, name))
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        outs.append(path)
        print('[relief] preview', path)
    return outs


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for art_name, out_name, prefix, tune in (
        ('khy-pet-female-idle.png', 'khy-pet-female-relief.glb', 'khy-pet-female', {}),
        # 凯的正脸均匀版肤色更亮、更平，默认阈值下泛洪从下颌漏进脸里，
        # 脸被抠掉 60%（桌宠卡片上表现为一块黑）。实测 0.015 把脸补回来，
        # 背景仍有 99.8% 保持透明、实体占比 35.4%（澪 31.0%）。
        ('khy-pet-male-idle.png', 'khy-pet-male-relief.glb', 'khy-pet-male',
         {'edge_threshold': 0.015}),
        # Koi art is a soft orange body on pure white: its painterly outline never
        # crosses the default gradient threshold, so the flood leaked straight
        # through the body and only the eyes/coins survived. Measured on the real
        # art: 0.035 keeps 12.5% of pixels (torso eaten), 0.012 keeps 29.1%.
        ('khy-pet-koi-idle.png', 'khy-pet-koi-relief.glb', 'khy-pet-koi',
         {'edge_threshold': 0.012, 'edge_close_radius': 3}),
    ):
        glb = build_relief(art_name, out_name, prefix, **tune)
        render_roundtrip(glb, prefix)
    print('[relief] done')


if __name__ == '__main__':
    main()
