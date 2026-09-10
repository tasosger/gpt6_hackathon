"""Build a generic clothed tutor from pinned CC0 MakeHuman mesh/rig/weights."""
import json
from pathlib import Path
import bpy
import bmesh
from mathutils import Vector

ASSETS = Path('/opt/tutor')
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
vertices, faces, uvs, face_uvs = [], [], [], []
group = ''
for line in (ASSETS / 'base.obj').read_text().splitlines():
    parts = line.split()
    if not parts:
        continue
    if parts[0] == 'v':
        x, y, z = map(float, parts[1:4])
        vertices.append((x * 0.1, -z * 0.1, y * 0.1))
    elif parts[0] == 'vt':
        uvs.append(tuple(map(float, parts[1:3])))
    elif parts[0] == 'g':
        group = parts[1]
    elif parts[0] == 'f' and group == 'body':
        faces.append([int(part.split('/')[0]) - 1 for part in parts[1:]])
        face_uvs.append([int(part.split('/')[1]) - 1 for part in parts[1:]])
mesh = bpy.data.meshes.new('MakeHumanBody')
mesh.from_pydata(vertices, [], faces)
mesh.update()
body = bpy.data.objects.new('TutorBody', mesh)
bpy.context.collection.objects.link(body)
uv_layer = mesh.uv_layers.new()
for poly, indices in zip(mesh.polygons, face_uvs):
    for loop, uv in zip(poly.loop_indices, indices):
        uv_layer.data[loop].uv = uvs[uv]
    poly.use_smooth = True
for name, color, roughness in [('Skin', (0.43, 0.24, 0.16, 1), .48),
                               ('UtilityJumpsuit', (.06, .14, .16, 1), .78),
                               ('Shoes', (.035, .045, .05, 1), .65)]:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = color
    shader.inputs['Roughness'].default_value = roughness
    body.data.materials.append(material)
for poly in mesh.polygons:
    center = sum((Vector(vertices[i]) for i in poly.vertices), Vector()) / len(poly.vertices)
    # Modest generic work clothing; preserve facial and hand topology.
    poly.material_index = 0 if center.z > 1.45 or abs(center.x) > .63 else (2 if center.z < .13 else 1)
definition = json.loads((ASSETS / 'default.mhskel').read_text())
weights = json.loads((ASSETS / 'default_weights.mhw').read_text())
assert definition['license'] == 'CC0' and weights['license'] == 'CC0'
armature = bpy.data.armatures.new('TutorSkeleton')
rig = bpy.data.objects.new('TutorRig', armature)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
for name, bone in definition['bones'].items():
    edit = armature.edit_bones.new(name)
    for endpoint in ('head', 'tail'):
        points = definition['joints'][bone[endpoint]]
        setattr(edit, endpoint, sum((Vector(vertices[i]) for i in points), Vector()) / len(points))
    if (edit.tail - edit.head).length < .0001:
        edit.tail.z += .001
for name, bone in definition['bones'].items():
    if bone['parent']:
        armature.edit_bones[name].parent = armature.edit_bones[bone['parent']]
bpy.ops.object.mode_set(mode='OBJECT')
for name, entries in weights['weights'].items():
    group = body.vertex_groups.new(name=name)
    for index, weight in entries:
        group.add([index], weight, 'REPLACE')
modifier = body.modifiers.new('Skeleton', 'ARMATURE')
modifier.object = rig
body.parent = rig
body['attribution'] = 'MakeHuman Community hm08 mesh/default rig, CC0; generic tutor, not a likeness.'
# Separate skinned forearm/hand meshes let the camera overlay hide the body while
# retaining skeletal animation. Bone names alone do not identify drawable meshes.
face_sets = {}
for side in ('L', 'R'):
    names = {name for name in weights['weights'] if name.endswith('.' + side)
             and name.startswith(('lowerarm', 'wrist', 'finger', 'metacarpal'))}
    influence = {}
    for name in names:
        for vertex, weight in weights['weights'][name]:
            influence[vertex] = influence.get(vertex, 0) + weight
    face_sets[side] = {p.index for p in body.data.polygons
                       if sum(influence.get(v, 0) for v in p.vertices) / len(p.vertices) > .55}
    hand = body.copy()
    hand.data = body.data.copy()
    hand.name = f'TutorHand_{side}'
    bpy.context.collection.objects.link(hand)
    bm = bmesh.new(); bm.from_mesh(hand.data); bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[p for p in bm.faces if p.index not in face_sets[side]], context='FACES_ONLY')
    bm.to_mesh(hand.data); bm.free()
bm = bmesh.new(); bm.from_mesh(body.data); bm.faces.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[p for p in bm.faces if p.index in face_sets['L'] | face_sets['R']], context='FACES_ONLY')
bm.to_mesh(body.data); bm.free()
bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / 'tutor.blend'))
