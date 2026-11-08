# Khy OS 桌宠 3D 模型生成脚本（Blender headless）
#
# 用途：把两位桌宠（澪 / 凯）建成**真正的 3D 立体模型**并导出 GLB，
#       供桌面端用原生 WebGL 加载渲染（可旋转、有体积、有材质与贴图）。
#
# 造型基准：delivery/brand/pet/khy-pet-{female,male}-idle.png（AI 定妆照）。
#   澪：长蓝发 + 猫耳 + 奶白荷叶头饰 + 藏青/奶白女仆裙 + 青领结 +
#       红金御守（嵌真商标）+ 脚下金鲤环 + 漂浮金币与光点 + 圆形金座。
#   凯：藏青短发 + 白蓝机能外套 + 金鲤胸章 + 金币 + 金座。
#
# 为什么不用生成模型：仓库与可用的连接器里**没有任何图生 3D 服务**，
# 程序化建模是唯一能拿到真实网格的路子。
#
# 为什么护身符/胸牌用贴图而不是几何：Khy OS 商标必须逐像素来自品牌几何真源
#（delivery/brand/khy-brand-geometry.js → png），用贴图上才是真商标；
# 几何复刻只会变成「像商标的商标」。
#
# 用法（仓库根目录）：
#   blender --background --python scripts/brand/build-pet-model.py
#
# 产出：
#   delivery/brand/pet/models/khy-pet-female.glb   澪（含御守真商标贴图）
#   delivery/brand/pet/models/khy-pet-male.glb     凯（含胸章真商标贴图）
#   works/design/khy-mascot/model/*-preview-*.png  四视角渲染预览
#   works/design/khy-mascot/model/frames/*.png     36 帧转盘序列（无 WebGL 时兜底）

import bpy
import math
import os
from mathutils import Vector

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_DIR = os.path.join(REPO, 'delivery', 'brand', 'pet', 'models')
PREVIEW_DIR = os.path.join(REPO, 'works', 'design', 'khy-mascot', 'model')
MARK_PNG = os.path.join(REPO, 'delivery', 'brand', 'png', 'khy-os-mark-256.png')

# 品牌/角色色板（见 works/design/khy-mascot/README.md「三条线」）
C = {
    'skin':      (0xFF, 0xE6, 0xD6),
    'hair_blue': (0x8C, 0xCF, 0xF0),
    'hair_tip':  (0xC6, 0xED, 0xFB),
    'hair_navy': (0x44, 0x57, 0x78),
    'navy':      (0x2C, 0x43, 0x70),
    'navy_dark': (0x22, 0x31, 0x52),
    'cream':     (0xFF, 0xF6, 0xE9),
    'white':     (0xF7, 0xFA, 0xFC),
    'teal':      (0x2F, 0xB8, 0xC4),
    'teal_2':    (0x00, 0xBC, 0xD4),
    'gold':      (0xE8, 0xC3, 0x6B),
    'amber':     (0xF0, 0xA8, 0x68),
    'red':       (0xD8, 0x54, 0x3E),
    'pink':      (0xF3, 0xA9, 0xB4),
    'eye_white': (0xFF, 0xFF, 0xFF),
    'eye_iris':  (0x3C, 0x8F, 0xE0),
    'pupil':     (0x14, 0x21, 0x3D),
    'ink':       (0x1B, 0x1F, 0x2A),
}


def srgb(hex_rgb):
    """hex → linear float tuple（Blender 的 Base Color 是线性空间）。"""
    out = []
    for v in hex_rgb:
        c = v / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (out[0], out[1], out[2], 1.0)


def make_mat(name, hex_rgb, rough=0.45, metal=0.0, emit=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = None
    for node in mat.node_tree.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            bsdf = node
            break
    if bsdf is None:
        raise RuntimeError('no Principled BSDF in ' + name)

    def set_input(key, value):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = value

    set_input('Base Color', srgb(hex_rgb))
    set_input('Roughness', rough)
    set_input('Metallic', metal)
    if emit is not None:
        set_input('Emission Color', srgb(emit))
        set_input('Emission Strength', 2.2)
    return mat


def make_mark_mat(name):
    """真商标贴图材质：透明 PNG 直接当贴图，落在护身符/胸牌正面。"""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = None
    for node in nt.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            bsdf = node
            break
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(MARK_PNG)
    tex.interpolation = 'Closest'
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    if 'Alpha' in tex.outputs:
        nt.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
    return mat


def shade_smooth(obj):
    for poly in obj.data.polygons:
        poly.use_smooth = True


# ── 建模基元 ────────────────────────────────────────────────────

def add_sphere(name, loc, scale, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=28, ring_count=14, radius=1.0, location=loc, rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(mat)
    shade_smooth(obj)
    return obj


def add_cyl(name, loc, radius, depth, mat, rot=(0, 0, 0), verts=32):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=loc, rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    shade_smooth(obj)
    return obj


def add_cone(name, loc, r1, r2, depth, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=r1, radius2=r2, depth=depth, location=loc, rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    shade_smooth(obj)
    return obj


def add_cube(name, loc, scale, mat, rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc, rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(mat)
    if bevel > 0:
        mod = obj.modifiers.new('bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = 3
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=mod.name)
        obj.select_set(False)
    shade_smooth(obj)
    return obj


def add_torus(name, loc, major, minor, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=40, minor_segments=14,
                                     location=loc, rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    shade_smooth(obj)
    return obj


def add_plane(name, loc, size, mat, rot=(math.pi / 2, 0, 0)):
    bpy.ops.mesh.primitive_plane_add(size=size, location=loc, rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def add_octa(name, loc, size, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=size, location=loc, rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def add_capsule(name, p0, p1, radius, mat):
    """两点之间的胶囊（躯干、四肢）。"""
    p0, p1 = Vector(p0), Vector(p1)
    mid = (p0 + p1) / 2.0
    length = (p1 - p0).length
    rot = (p1 - p0).to_track_quat('Z', 'Y').to_euler()
    shaft = add_cyl(name + '_shaft', mid, radius, length, mat, rot=rot, verts=20)
    add_sphere(name + '_cap0', p0, (radius, radius, radius), mat)
    add_sphere(name + '_cap1', p1, (radius, radius, radius), mat)
    return shaft


def add_strand(name, points, radius, mat, tip_mat=None, tip_ratio=0.0):
    """一束头发/缎带：贝塞尔曲线 + 圆截面，倒角成实体。tip_ratio>0 时末段换成浅色发梢。"""
    curve = bpy.data.curves.new(name + '_curve', 'CURVE')
    curve.dimensions = '3D'
    curve.bevel_depth = radius
    curve.bevel_resolution = 3
    curve.resolution_u = 8
    spline = curve.splines.new('BEZIER')
    spline.bezier_points.add(len(points) - 1)
    for i, p in enumerate(points):
        spline.bezier_points[i].co = p
        spline.bezier_points[i].handle_left_type = 'AUTO'
        spline.bezier_points[i].handle_right_type = 'AUTO'
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    if tip_mat is not None and tip_ratio > 0:
        obj.data.materials.append(tip_mat)
        # 末端按比例分配到浅色材质槽（1 = 浅色发梢）
        spline.material_index = 0
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target='MESH')
    obj = bpy.context.object
    obj.name = name
    if tip_mat is not None and tip_ratio > 0:
        for poly in obj.data.polygons:
            center = sum((obj.data.vertices[i].co for i in poly.vertices), Vector()) / len(poly.vertices)
            # 用归一化高度近似判断是否属于发梢段
            if center.z < min(p[2] for p in points) + (max(p[2] for p in points) - min(p[2] for p in points)) * tip_ratio:
                poly.material_index = 1
    shade_smooth(obj)
    obj.select_set(False)
    return obj


def add_face(prefix, eye_x, eye_z, face_y, iris_mat, pupil_mat, white_mat, brow_mat, lash_mat, mouth_mat):
    """二次元大眼 + 眉毛 + 上睫线 + 小嘴。"""
    for side in (-1, 1):
        ex = side * eye_x
        add_sphere(prefix + '_eye_white_' + str(side), (ex, face_y, eye_z), (0.15, 0.06, 0.175), white_mat)
        add_sphere(prefix + '_iris_' + str(side), (ex, face_y - 0.045, eye_z), (0.115, 0.05, 0.14), iris_mat)
        add_sphere(prefix + '_iris_dark_' + str(side), (ex, face_y - 0.07, eye_z - 0.01), (0.055, 0.03, 0.075), pupil_mat)
        add_sphere(prefix + '_glint_' + str(side), (ex + 0.038, face_y - 0.095, eye_z + 0.06), (0.034, 0.026, 0.034), white_mat)
        # 上睫线：一小段弧
        add_capsule(prefix + '_lash_' + str(side),
                    (ex - 0.13, face_y - 0.005, eye_z + 0.09),
                    (ex + 0.13, face_y - 0.005, eye_z + 0.125),
                    0.016, lash_mat)
        # 眉毛
        add_capsule(prefix + '_brow_' + str(side),
                    (ex - 0.11, face_y + 0.01, eye_z + 0.2),
                    (ex + 0.1, face_y + 0.01, eye_z + 0.225),
                    0.014, brow_mat)
    add_sphere(prefix + '_mouth', (0, face_y - 0.015, eye_z - 0.21), (0.045, 0.022, 0.03), mouth_mat)


def add_coins(prefix, positions, mat):
    """漂浮金币：带倒角的薄圆柱。"""
    for i, (loc, rot) in enumerate(positions):
        add_cyl('%s_coin_%d' % (prefix, i), loc, 0.085, 0.022, mat, rot=rot, verts=24)


# ── 角色：澪 ────────────────────────────────────────────────────

def build_female(mats):
    """澪：长蓝发、猫耳、奶白荷叶头饰、藏青/奶白女仆裙、青领结、红金御守、金鲤环。"""
    skin = mats['skin']
    hair = mats['hair_blue']
    tip = mats['hair_tip']

    # 头（含下巴收一点）
    add_sphere('head', (0, 0, 1.74), (0.42, 0.4, 0.43), skin)
    add_sphere('chin', (0, -0.03, 1.44), (0.24, 0.22, 0.18), skin)
    # 耳
    for side in (-1, 1):
        add_sphere('ear_%d' % side, (side * 0.42, -0.02, 1.7), (0.05, 0.06, 0.1), skin)

    # 后发大块 + 披发
    add_sphere('hair_back', (0, 0.14, 1.66), (0.47, 0.42, 0.48), hair)
    add_sphere('hair_long', (0, 0.15, 1.06), (0.47, 0.42, 0.68), hair)
    add_sphere('hair_tip_mass', (0, 0.16, 0.56), (0.4, 0.34, 0.3), tip)
    # 两侧长发绺
    for side in (-1, 1):
        add_strand('side_lock_%d' % side, [
            (side * 0.34, -0.18, 1.92),
            (side * 0.46, -0.12, 1.45),
            (side * 0.42, -0.02, 1.0),
            (side * 0.36, 0.06, 0.72),
        ], 0.085, hair, tip_mat=tip, tip_ratio=0.18)
    # 刘海：中分 + 斜刘海
    for i in range(5):
        t = (i - 2) / 2.0
        add_strand('fringe_%d' % i, [
            (t * 0.18, -0.02, 2.05),
            (t * 0.3, -0.3, 1.95),
            (t * 0.34, -0.38, 1.82),
        ], 0.075, hair, tip_mat=tip, tip_ratio=0.15)
    # 呆毛
    add_strand('ahoge', [(0.02, -0.02, 2.12), (0.08, -0.06, 2.32), (0.0, -0.02, 2.46)], 0.022, hair)

    # 猫耳（藏青外 + 粉内 + 白毛边）
    for side in (-1, 1):
        add_cone('cat_ear_%d' % side, (side * 0.26, -0.02, 2.16), 0.2, 0.03, 0.46, mats['hair_navy'],
                 rot=(0, side * -0.22, 0))
        add_cone('cat_ear_in_%d' % side, (side * 0.26, -0.13, 2.14), 0.12, 0.02, 0.32, mats['pink'],
                 rot=(0, side * -0.22, 0))
        for k in range(4):
            a = -0.5 + k * 0.33
            add_sphere('ear_fluff_%d_%d' % (side, k),
                       (side * 0.25 + math.sin(a) * 0.11, -0.06 + math.cos(a) * 0.04, 2.06 + math.cos(a) * 0.11),
                       (0.05, 0.05, 0.05), mats['white'])
    # 奶白荷叶头饰
    add_torus('headband', (0, 0.06, 1.98), 0.4, 0.04, mats['white'])
    for k in range(9):
        a = math.pi * (0.12 + 0.76 * k / 8.0)
        add_sphere('band_frill_%d' % k,
                   (math.sin(a) * 0.4, -math.cos(a) * 0.4 * 0.45, 2.0 + math.cos(a) * 0.03),
                   (0.05, 0.05, 0.05), mats['white'])

    # 脸
    add_face('mio', 0.165, 1.7, -0.445, mats['eye_iris'], mats['pupil'], mats['eye_white'],
             mats['hair_blue'], mats['ink'], mats['red'])

    # 身体：颈 + 藏青上衣 + 奶白围裙
    add_cyl('neck', (0, 0, 1.4), 0.12, 0.16, skin, verts=20)
    add_capsule('bodice', (0, 0, 1.02), (0, 0, 1.46), 0.28, mats['navy'])
    add_cone('skirt', (0, 0, 0.8), 0.6, 0.29, 0.6, mats['navy'])
    # 围裙（奶白，前片）
    add_cone('apron', (0, -0.24, 0.9), 0.22, 0.16, 0.3, mats['cream'], rot=(0.08, 0, 0))
    # 围裙荷叶边
    for k in range(9):
        a = math.pi * (0.08 + 0.84 * k / 8.0)
        add_sphere('apron_frill_%d' % k,
                   (math.sin(a) * 0.32, -0.34 - math.cos(a) * 0.12, 0.62),
                   (0.055, 0.055, 0.04), mats['cream'])
    # 金色滚边
    add_torus('skirt_trim', (0, 0, 0.62), 0.55, 0.018, mats['gold'])
    add_torus('waist_trim', (0, 0, 1.04), 0.29, 0.02, mats['gold'])
    add_torus('collar_trim', (0, 0, 1.42), 0.2, 0.016, mats['gold'])
    # 青领结
    add_sphere('bow_knot', (0, -0.32, 1.32), (0.08, 0.06, 0.07), mats['teal_2'])
    for side in (-1, 1):
        add_cone('bow_wing_%d' % side, (side * 0.15, -0.32, 1.32), 0.14, 0.02, 0.2, mats['teal_2'],
                 rot=(0, side * 1.35, 0))
        add_cone('bow_tail_%d' % side, (side * 0.09, -0.31, 1.16), 0.08, 0.015, 0.2, mats['teal_2'],
                 rot=(0, side * 0.28, 0))
    # 红腰封 + 金结
    add_torus('sash', (0, 0, 1.08), 0.3, 0.05, mats['red'])
    add_sphere('sash_knot', (0, -0.28, 1.06), (0.07, 0.05, 0.06), mats['gold'])

    # 手臂：左手举御守，右手自然下垂
    add_capsule('arm_r', (0.26, 0, 1.34), (0.42, -0.16, 1.0), 0.085, skin)
    add_sphere('glove_r', (0.44, -0.18, 0.94), (0.1, 0.09, 0.1), mats['cream'])
    add_capsule('arm_l', (-0.26, 0, 1.34), (-0.42, -0.2, 1.12), 0.085, skin)
    add_sphere('glove_l', (-0.44, -0.22, 1.08), (0.1, 0.09, 0.1), mats['cream'])
    # 御守（红金 + 真商标）
    add_cube('omamori', (-0.5, -0.3, 1.02), (0.27, 0.15, 0.29), mats['red'], rot=(0, 0.25, 0.3), bevel=0.07)
    add_cube('omamori_plate', (-0.5, -0.43, 1.02), (0.16, 0.02, 0.16), mats['gold'], rot=(0, 0.25, 0.3), bevel=0.01)
    add_plane('omamori_mark', (-0.5, -0.45, 1.02), 0.14, mats['mark'], rot=(math.pi / 2, 0, 0.25))
    add_torus('omamori_cord', (-0.46, -0.26, 1.13), 0.07, 0.018, mats['gold'])

    # 腿 + 鞋
    for side in (-1, 1):
        add_capsule('leg_%d' % side, (side * 0.14, 0, 0.62), (side * 0.14, 0, 0.2), 0.085, skin)
        add_sphere('shoe_%d' % side, (side * 0.14, -0.04, 0.12), (0.11, 0.15, 0.08), mats['ink'])

    # 脚下金鲤环（参考图里绕身一圈的金色鱼环）
    add_torus('koi_ring', (0, 0.04, 0.5), 0.62, 0.085, mats['gold'], rot=(0.1, 0, 0))
    add_sphere('koi_body', (-0.42, -0.42, 0.62), (0.19, 0.075, 0.085), mats['gold'], rot=(0, 0.35, 0.5))
    add_cone('koi_tail', (-0.58, -0.38, 0.72), 0.09, 0.005, 0.16, mats['gold'], rot=(0, 0.35, 0.9))
    add_cone('koi_fin', (-0.34, -0.5, 0.6), 0.06, 0.005, 0.11, mats['gold'], rot=(0.4, 0.2, 0.4))

    # 金币与光点
    add_coins('mio', [
        ((0.5, -0.1, 1.75), (0.3, 0.2, 0.4)),
        ((-0.62, 0.06, 1.5), (0.1, 0.5, 1.1)),
        ((0.62, 0.12, 1.1), (0.4, 0.1, 2.0)),
        ((-0.52, -0.16, 0.92), (0.2, 0.3, 0.6)),
        ((0.3, -0.3, 2.1), (0.5, 0.4, 0.2)),
        ((-0.2, 0.28, 2.28), (0.1, 0.2, 0.9)),
    ], mats['gold'])
    for i, loc in enumerate([(0.36, -0.3, 2.24), (-0.44, -0.1, 2.06), (0.66, -0.2, 1.42), (-0.66, 0.12, 1.82)]):
        add_octa('spark_%d' % i, loc, 0.045, mats['amber'])

    # 底座
    add_cyl('base', (0, 0, 0.06), 0.6, 0.12, mats['amber'])
    add_torus('base_ring', (0, 0, 0.12), 0.46, 0.022, mats['gold'])
    add_cyl('base_top', (0, 0, 0.125), 0.42, 0.01, mats['amber'])


# ── 角色：凯 ────────────────────────────────────────────────────

def build_male(mats):
    """凯：藏青短发、白蓝机能外套、金鲤胸章、硬币、金座。"""
    skin = mats['skin']
    hair = mats['hair_navy']

    add_sphere('head', (0, 0, 1.72), (0.42, 0.4, 0.43), skin)
    add_sphere('chin', (0, -0.02, 1.46), (0.22, 0.2, 0.17), skin)
    for side in (-1, 1):
        add_sphere('ear_%d' % side, (side * 0.4, -0.02, 1.7), (0.05, 0.06, 0.1), skin)

    # 短发：头顶壳 + 斜刘海 + 碎发
    add_sphere('hair_cap', (0, 0.04, 1.82), (0.47, 0.45, 0.42), hair)
    add_sphere('hair_back', (0, 0.14, 1.62), (0.46, 0.42, 0.42), hair)
    for i in range(5):
        t = (i - 2) / 2.0
        add_strand('fringe_%d' % i, [
            (t * 0.2, 0.0, 2.02),
            (t * 0.32, -0.28, 1.92),
            (t * 0.36, -0.36, 1.78),
        ], 0.07, hair)
    for side in (-1, 1):
        add_strand('side_%d' % side, [
            (side * 0.36, -0.1, 1.9),
            (side * 0.44, -0.06, 1.6),
            (side * 0.4, 0.02, 1.42),
        ], 0.07, hair)
    add_strand('ahoge', [(0.02, -0.02, 2.1), (0.09, -0.05, 2.28), (0.0, -0.02, 2.42)], 0.022, hair)

    add_face('kai', 0.155, 1.7, -0.43, mats['eye_iris'], mats['pupil'], mats['eye_white'],
             mats['hair_navy'], mats['ink'], mats['ink'])

    # 身体：深色内搭 + 白蓝外套
    add_cyl('neck', (0, 0, 1.4), 0.12, 0.16, skin, verts=20)
    add_capsule('undershirt', (0, 0, 1.05), (0, 0, 1.42), 0.25, mats['navy_dark'])
    for side in (-1, 1):
        add_capsule('jacket_%d' % side, (side * 0.2, 0.02, 1.66), (side * 0.26, 0.0, 1.0), 0.14, mats['white'])
        add_capsule('collar_%d' % side, (side * 0.13, 0.0, 1.76), (side * 0.2, -0.02, 1.52), 0.1, mats['navy'])
    add_capsule('zip', (0, -0.25, 1.7), (0, -0.25, 1.08), 0.022, mats['teal_2'])
    add_torus('belt', (0, 0, 1.02), 0.3, 0.045, mats['navy_dark'])
    add_cube('belt_buckle', (0, -0.3, 1.02), (0.08, 0.03, 0.06), mats['gold'], bevel=0.01)
    # 胸章：金牌 + 真商标贴图
    add_cyl('badge', (0.17, -0.26, 1.42), 0.13, 0.02, mats['gold'], rot=(math.pi / 2, 0, 0), verts=32)
    add_plane('badge_mark', (0.17, -0.28, 1.42), 0.16, mats['mark'], rot=(math.pi / 2, 0, 0))
    # 裤 + 靴
    for side in (-1, 1):
        add_capsule('leg_%d' % side, (side * 0.15, 0, 0.92), (side * 0.15, 0, 0.2), 0.1, mats['navy_dark'])
        add_sphere('boot_%d' % side, (side * 0.15, -0.04, 0.12), (0.12, 0.16, 0.09), mats['ink'])

    # 手臂：左手插兜，右手抛金币
    add_capsule('arm_l', (-0.28, 0, 1.34), (-0.4, -0.06, 1.02), 0.09, mats['white'])
    add_sphere('glove_l', (-0.42, -0.08, 0.98), (0.1, 0.1, 0.1), mats['ink'])
    add_capsule('arm_r', (0.28, 0, 1.34), (0.48, -0.14, 1.72), 0.09, mats['white'])
    add_sphere('glove_r', (0.51, -0.16, 1.79), (0.1, 0.1, 0.1), mats['ink'])
    add_cyl('coin_hand', (0.54, -0.18, 1.9), 0.09, 0.022, mats['gold'], rot=(0.2, 0.3, 0.4), verts=24)

    add_coins('kai', [
        ((-0.58, -0.06, 1.46), (0.2, 0.4, 0.8)),
        ((0.56, 0.06, 1.24), (0.4, 0.2, 0.3)),
        ((-0.2, 0.3, 2.2), (0.1, 0.3, 1.4)),
        ((0.66, -0.1, 1.9), (0.3, 0.5, 0.6)),
    ], mats['gold'])
    for i, loc in enumerate([(0.2, -0.28, 2.26), (-0.5, -0.14, 1.98)]):
        add_octa('spark_%d' % i, loc, 0.042, mats['amber'])

    add_cyl('base', (0, 0, 0.06), 0.6, 0.12, mats['amber'])
    add_torus('base_ring', (0, 0, 0.12), 0.46, 0.022, mats['gold'])
    add_cyl('base_top', (0, 0, 0.125), 0.42, 0.01, mats['amber'])


# ── 场景 / 导出 ─────────────────────────────────────────────────

def build_materials():
    return {
        'skin': make_mat('skin', C['skin'], rough=0.55),
        'hair_blue': make_mat('hair_blue', C['hair_blue'], rough=0.32),
        'hair_tip': make_mat('hair_tip', C['hair_tip'], rough=0.32),
        'hair_navy': make_mat('hair_navy', C['hair_navy'], rough=0.4),
        'navy': make_mat('navy', C['navy'], rough=0.5),
        'navy_dark': make_mat('navy_dark', C['navy_dark'], rough=0.5),
        'cream': make_mat('cream', C['cream'], rough=0.6),
        'white': make_mat('white', C['white'], rough=0.45),
        'teal': make_mat('teal', C['teal'], rough=0.4),
        'teal_2': make_mat('teal_2', C['teal_2'], rough=0.4),
        'gold': make_mat('gold', C['gold'], rough=0.22, metal=0.8),
        'amber': make_mat('amber', C['amber'], rough=0.3, metal=0.25, emit=C['amber']),
        'red': make_mat('red', C['red'], rough=0.5),
        'pink': make_mat('pink', C['pink'], rough=0.5),
        'eye_white': make_mat('eye_white', C['eye_white'], rough=0.2),
        'eye_iris': make_mat('eye_iris', C['eye_iris'], rough=0.2),
        'pupil': make_mat('pupil', C['pupil'], rough=0.2),
        'ink': make_mat('ink', C['ink'], rough=0.5),
        'mark': make_mark_mat('brand_mark'),
    }


PET_LIGHTS = []


def setup_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    # 上一角色的灯对象已被删除，引用会变成野 RNA，必须清掉。
    PET_LIGHTS.clear()
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
    # 色彩管理：默认的 AgX/Filmic 会把深藏青洗成灰蓝、浅蓝洗成白 ——
    # 设定值和渲出来的对不上，色块就永远不像定妆照。改用 Standard。
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
    bpy.ops.object.light_add(type='AREA', location=(1.1, -1.35, 1.45))
    bpy.context.object.data.energy = 260
    bpy.context.object.data.size = 1.6
    PET_LIGHTS.append(('key', bpy.context.object))
    bpy.ops.object.light_add(type='AREA', location=(-1.3, -0.9, 1.0))
    bpy.context.object.data.energy = 150
    bpy.context.object.data.size = 1.6
    PET_LIGHTS.append(('fill', bpy.context.object))
    bpy.ops.object.light_add(type='AREA', location=(0.2, 1.5, 1.2))
    bpy.context.object.data.energy = 140
    bpy.context.object.data.size = 1.4
    PET_LIGHTS.append(('rim', bpy.context.object))
    bpy.ops.object.light_add(type='AREA', location=(0.0, 1.1, 2.0))
    bpy.context.object.data.energy = 200
    bpy.context.object.data.size = 1.6
    bpy.ops.object.light_add(type='AREA', location=(1.5, -0.5, 0.75))
    bpy.context.object.data.energy = 190
    bpy.context.object.data.size = 1.4
    bpy.ops.object.light_add(type='AREA', location=(-1.5, -0.5, 0.75))
    bpy.context.object.data.energy = 190
    bpy.context.object.data.size = 1.4
    bpy.ops.object.camera_add(location=(0, -3.15, 1.0), rotation=(math.radians(88), 0, 0))
    cam = bpy.context.object
    cam.data.lens = 62
    scene.camera = cam
    return scene


def normalize_scale(target_height):
    """把位置/旋转/缩放**全部烘进网格**，再整体缩放到目标高度。

    为什么必须烘：Blender 的 glTF 导出把每个物体的变换写成节点，而节点上的
    缩放与网格里的缩放会叠加——导出的网格会缩到只剩原来的几百分之一
    （三角形面积 ~1e-5，渲染出来是一堆看不见的小点）。
    烘完之后每个物体的网格就是世界坐标，节点变换为单位阵，导出即正确。
    """
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not objs:
        return
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    zmin = min((o.matrix_world @ Vector(c)).z for o in objs for c in o.bound_box)
    zmax = max((o.matrix_world @ Vector(c)).z for o in objs for c in o.bound_box)
    factor = target_height / max(zmax - zmin, 1e-6)
    for o in objs:
        o.scale = (factor, factor, factor)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for o in objs:
        o.location.z -= zmin * factor
    bpy.ops.object.select_all(action='DESELECT')


def export_glb(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_apply=True,
        export_yup=True,
        export_materials='EXPORT',
        export_image_format='AUTO',
    )


def aim_camera(cam, yaw_deg, height=1.0, dist=3.15):
    rad = math.radians(yaw_deg)
    cam.location = (math.sin(rad) * dist, -math.cos(rad) * dist, height)
    cam.rotation_euler = (math.radians(86), 0, rad)
    # 主光与补光**跟着相机走**：写死世界坐标时，转到背面就没人打光了。
    def rot(offset):
        x, y, z = offset
        return (x * math.cos(rad) - y * math.sin(rad),
                x * math.sin(rad) + y * math.cos(rad), z)
    for tag, light in PET_LIGHTS:
        if tag == 'key':
            light.location = (cam.location[0] + rot((0.45, -0.55, 0.75))[0],
                             cam.location[1] + rot((0.45, -0.55, 0.75))[1],
                             cam.location[2] + 0.75)
        elif tag == 'fill':
            light.location = (cam.location[0] + rot((-0.6, -0.35, 0.35))[0],
                             cam.location[1] + rot((-0.6, -0.35, 0.35))[1],
                             cam.location[2] + 0.35)
        else:
            light.location = (cam.location[0] + rot((-0.2, 0.9, 0.6))[0],
                             cam.location[1] + rot((-0.2, 0.9, 0.6))[1],
                             cam.location[2] + 0.6)


def render_views(prefix):
    scene = bpy.context.scene
    cam = scene.camera
    out = []
    for yaw, name in ((0, 'front'), (35, 'three-quarter'), (90, 'side'), (180, 'back')):
        aim_camera(cam, yaw)
        path = os.path.join(PREVIEW_DIR, '%s-preview-%s.png' % (prefix, name))
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        out.append(path)
    return out


def render_turntable(prefix, frames=36, size=256):
    """转盘序列：把真 3D 模型绕 Y 轴渲染成 N 帧，供没有 WebGL 的环境做 2.5D 兜底。"""
    scene = bpy.context.scene
    cam = scene.camera
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    frame_dir = os.path.join(PREVIEW_DIR, 'frames')
    os.makedirs(frame_dir, exist_ok=True)
    paths = []
    for i in range(frames):
        aim_camera(cam, 360.0 * i / frames)
        path = os.path.join(frame_dir, '%s_%03d.png' % (prefix, i))
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        paths.append(path)
    scene.render.resolution_x = 700
    scene.render.resolution_y = 700
    return paths


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(PREVIEW_DIR, exist_ok=True)

    for prefix, builder in (('khy-pet-female', build_female), ('khy-pet-male', build_male)):
        setup_scene()
        mats = build_materials()
        builder(mats)
        normalize_scale(1.05)
        glb_path = os.path.join(OUT_DIR, prefix + '.glb')
        export_glb(glb_path)
        print('[pet-model] exported', glb_path, os.path.getsize(glb_path))
        for p in render_views(prefix):
            print('[pet-model] rendered', p)
        if not os.environ.get('KHY_PET_SKIP_TURNTABLE'):
            frames = render_turntable(prefix)
            print('[pet-model] turntable frames', len(frames), prefix)

    print('[pet-model] done')


if __name__ == '__main__':
    main()
