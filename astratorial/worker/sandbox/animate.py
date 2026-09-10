"""Trusted Blender wrapper; generated code still executes in a credentialless sandbox."""
import json
import math
from pathlib import Path
import sys
import bpy
from mathutils import Vector, Matrix, kdtree
from mathutils.bvhtree import BVHTree

sys.path.insert(0, '/opt/worker')
from astratorial.textured_ply import read_textured_ply

ROOT = Path('/job')


def coordinates(objects):
    return [obj.matrix_world @ vertex.co for obj in objects for vertex in obj.data.vertices]


def camera(name, position, target):
    data = bpy.data.cameras.new(name)
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()
    data.lens = 32
    return obj


def import_source(reconstruction):
    vertices, faces, corner_uvs, texture = read_textured_ply(ROOT / 'source' / reconstruction['mesh'])
    transform = Matrix(reconstruction['worldTransform'])
    vertices = [transform @ Vector(point) for point in vertices]
    labels = json.loads((ROOT / 'source/face-labels.json').read_text())
    if len(labels) != len(faces):
        raise ValueError('Source segmentation does not match the textured triangle order')
    material = bpy.data.materials.new('CapturedSourceTexture')
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Roughness'].default_value = .65
    node = material.node_tree.nodes.new('ShaderNodeTexImage')
    node.image = bpy.data.images.load(str(texture))
    material.node_tree.links.new(node.outputs['Color'], shader.inputs['Base Color'])
    objects = []
    for label in sorted(set(labels)):
        indices = [index for index, value in enumerate(labels) if value == label]
        selected_faces = [faces[index] for index in indices]
        used = sorted({v for face in selected_faces for v in face})
        remap = {original: index for index, original in enumerate(used)}
        name = 'SourceRoom' if label < 0 else f'SourceItem_{label}'
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([vertices[index] for index in used], [], [[remap[v] for v in face] for face in selected_faces])
        mesh.update()
        uv = mesh.uv_layers.new(name='CapturedUV')
        for polygon, original in zip(mesh.polygons, indices):
            values = corner_uvs[original]
            for corner, loop in enumerate(polygon.loop_indices):
                uv.data[loop].uv = values[corner * 2:corner * 2 + 2]
        mesh.materials.append(material)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        objects.append(obj)
    for index, supplement in enumerate(reconstruction.get('supplements', [])):
        vertices, faces, uvs, texture_path = read_textured_ply(ROOT / 'source' / supplement['mesh'])
        matrix = Matrix(supplement['worldTransform'])
        mesh = bpy.data.meshes.new(f'ObservedSupplement_{index}')
        mesh.from_pydata([matrix @ Vector(point) for point in vertices], [], faces)
        mesh.update()
        uv = mesh.uv_layers.new(name='CapturedUV')
        for polygon, values in zip(mesh.polygons, uvs):
            for corner, loop in enumerate(polygon.loop_indices):
                uv.data[loop].uv = values[corner * 2:corner * 2 + 2]
        material = bpy.data.materials.new(f'ObservedSupplementMaterial_{index}')
        material.use_nodes = True
        shader = material.node_tree.nodes.get('Principled BSDF')
        shader.inputs['Roughness'].default_value = .65
        texture_node = material.node_tree.nodes.new('ShaderNodeTexImage')
        texture_node.image = bpy.data.images.load(str(texture_path))
        material.node_tree.links.new(texture_node.outputs['Color'], shader.inputs['Base Color'])
        mesh.materials.append(material)
        target = bpy.data.objects.get(supplement['nodeName'])
        obj = bpy.data.objects.new(f'SourceSupplement_{index}' if target else supplement['nodeName'], mesh)
        bpy.context.collection.objects.link(obj)
        if target:
            # Join preserves every vertex and its material/UV mapping. The base
            # and supplementary portions then share one rigid animated object.
            bpy.ops.object.select_all(action='DESELECT')
            obj.select_set(True); target.select_set(True)
            bpy.context.view_layer.objects.active = target
            bpy.ops.object.join()
        else:
            objects.append(obj)
    return objects


def main():
    spec = json.loads((ROOT / 'input.json').read_text())
    reconstruction = json.loads((ROOT / 'source/reconstruction.json').read_text())
    bpy.ops.wm.read_factory_settings(use_empty=True)
    source_objects = import_source(reconstruction)
    bpy.context.view_layer.update()
    before = coordinates([o for o in source_objects if o.type == 'MESH'])
    with bpy.data.libraries.load('/opt/tutor/tutor.blend', link=False) as (source, target):
        target.objects = source.objects
    for obj in target.objects:
        if obj:
            bpy.context.collection.objects.link(obj)
    scene = bpy.context.scene
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = math.ceil(spec['durationSeconds'] * 24)
    context = {'sourceObjects': source_objects, 'tutorRig': bpy.data.objects['TutorRig'],
               'tutorBody': bpy.data.objects['TutorBody'], 'plan': spec['plan'],
               'timeline': spec['timeline'], 'reconstruction': reconstruction, 'result': None}
    code = (ROOT / 'instruction.py').read_text()
    namespace = {'bpy': bpy, 'Vector': Vector, 'math': math, '__name__': 'generated_instruction'}
    exec(compile(code, '/job/instruction.py', 'exec'), namespace)
    namespace['build_tutorial'](context)
    result = context['result']
    if not isinstance(result, dict):
        raise ValueError('Instruction script did not produce scene metadata.')
    scene.frame_set(1)
    bpy.context.view_layer.update()
    # Geometry observed in the scan must survive at the rest pose. Source-named
    # meshes can be split for articulation but may not be replaced or remodelled.
    after = coordinates([o for o in scene.objects if o.type == 'MESH' and o.name.startswith('Source')])
    if not after:
        raise ValueError('The instruction script removed the reconstructed room.')
    tree = kdtree.KDTree(len(after))
    for index, point in enumerate(after):
        tree.insert(point, index)
    tree.balance()
    missing = sum(tree.find(point)[2] > .002 for point in before) / max(len(before), 1)
    if missing > .005:
        raise ValueError('The instruction changed source geometry; preserve the captured room at rest.')
    original_tree = kdtree.KDTree(len(before))
    for index, point in enumerate(before):
        original_tree.insert(point, index)
    original_tree.balance()
    if any(original_tree.find(point)[2] > .002 for point in after):
        raise ValueError('The instruction invented source surfaces that were not captured.')
    allowed_meshes = {'TutorBody', 'TutorHand_L', 'TutorHand_R'}
    if any(obj.type == 'MESH' and not obj.name.startswith('Source') and obj.name not in allowed_meshes for obj in scene.objects):
        raise ValueError('Only captured source meshes and the supplied tutor are allowed.')
    # A movable item's calibration origin is its observed base, not its centroid.
    # This matches the browser's support-plane backprojection for a base tap.
    for item in result.get('objects', []):
        obj = scene.objects.get(item['nodeName'])
        if obj is None or obj.type != 'MESH' or not obj.name.startswith('Source'):
            raise ValueError('Object metadata must identify an observed source mesh')
        points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
        if item['movable']:
            verified_node = next((entry['nodeName'] for entry in reconstruction['objectNodes'] if entry['id'] == item['id']), None)
            if not obj.name.startswith('SourceItem_') or obj.name != verified_node:
                raise ValueError('Movable objects need a verified segmented source mesh')
            lowest = min(point.z for point in points)
            base = [point for point in points if point.z <= lowest + .005]
            item['position'] = [sum(point.x for point in base) / len(base),
                                sum(point.y for point in base) / len(base), lowest]
        else:
            tree = BVHTree.FromPolygons(points, [list(face.vertices) for face in obj.data.polygons])
            nearest = tree.find_nearest(Vector(item['position']))
            if nearest[0] is None or nearest[3] > .02:
                raise ValueError('Object base/contact origin must lie on an observed source surface')
    # Bake all rig constraints and object movement into one deterministic clip.
    bpy.ops.object.select_all(action='DESELECT')
    for obj in scene.objects:
        if obj.type in {'ARMATURE', 'MESH', 'EMPTY'}:
            obj.select_set(True)
    bpy.context.view_layer.objects.active = context['tutorRig']
    bpy.ops.nla.bake(frame_start=1, frame_end=scene.frame_end, step=1, only_selected=False,
        visual_keying=True, clear_constraints=True, clear_parents=False, use_current_action=True,
        bake_types={'POSE', 'OBJECT'})
    for obj in scene.objects:
        if obj.animation_data and obj.animation_data.action:
            action = obj.animation_data.action
            track = obj.animation_data.nla_tracks.new()
            track.name = 'tutorial'
            track.strips.new('tutorial', 1, action)
            obj.animation_data.action = None
    result['rig'] = {'bodyNode': 'TutorBody', 'handNodes': ['TutorHand_L', 'TutorHand_R']}
    hand_targets = result.pop('handTargets', {})
    result['steps'] = [{**step, 'clipName': 'tutorial', 'handTargets': hand_targets.get(step['stepId'], [])} for step in spec['timeline']]
    for step in result['steps']:
        targets = step['handTargets']
        if len({target['nodeName'] for target in targets}) != len(targets) or any(
                target['nodeName'] not in ('TutorHand_L', 'TutorHand_R') or target['objectId'] not in
                {item['id'] for item in result['objects']} for target in targets):
            raise ValueError('Hand targets must identify actual hands and observed scene objects')
    result.update(version=1, units='meters', durationSeconds=spec['durationSeconds'],
                  bounds=reconstruction['bounds'], landmarks=reconstruction['landmarks'],
                  quality=reconstruction['quality'], sanitized=False, assets=[])
    result['quality']['notes'].append('Generic instructor: MakeHuman base mesh and default rig, CC0, MakeHuman Community, source revision a8bc2d54ff0ac92e78ff71431b1023eda42bf482. Skin/clothing use generated PBR materials.')
    output = ROOT / 'output'
    output.mkdir(exist_ok=True)
    scene.frame_set(1)
    # glTF and the manifest share right-handed Y-up meters. Blender stays Z-up.
    def y_up(point):
        return [point[0], point[2], -point[1]]
    def y_bounds(bounds):
        return {'min': [bounds['min'][0], bounds['min'][2], -bounds['max'][1]],
                'max': [bounds['max'][0], bounds['max'][2], -bounds['min'][1]]}
    for view in result['cameras'].values():
        view['position'], view['target'] = y_up(view['position']), y_up(view['target'])
    for item in result['objects']:
        item['position'] = y_up(item['position'])
        for anchor in item['anchors']:
            anchor['position'] = y_up(anchor['position'])
    for item in result['landmarks']:
        item['position'] = y_up(item['position'])
    result['bounds'] = y_bounds(result['bounds'])
    if result.get('publicationBounds'):
        result['publicationBounds'] = y_bounds(result['publicationBounds'])
    bpy.ops.export_scene.gltf(filepath=str(output / 'scene-detail.glb'), export_format='GLB',
        export_yup=True, export_animations=True, export_animation_mode='NLA_TRACKS',
        export_extras=True, export_cameras=True, export_lights=True)
    # Progressive delivery keeps the same geometry and animation. Reduce only
    # texture resolution, so contact geometry cannot drift through decimation.
    for texture_limit in (2048, 1024, 512):
        for image in bpy.data.images:
            if image.size[0] > texture_limit or image.size[1] > texture_limit:
                ratio = texture_limit / max(image.size)
                image.scale(max(1, round(image.size[0] * ratio)), max(1, round(image.size[1] * ratio)))
        bpy.ops.export_scene.gltf(filepath=str(output / 'scene.glb'), export_format='GLB',
            export_yup=True, export_animations=True, export_animation_mode='NLA_TRACKS',
            export_extras=True, export_cameras=True, export_lights=True)
        if (output / 'scene.glb').stat().st_size <= 20_000_000:
            break
    else:
        raise ValueError('The mobile GLB exceeds 20 MB after texture reduction. Shorten the tutorial or rescan a smaller task area; geometry is preserved.')
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'scene.blend'))
    publication_bounds = result.pop('publicationBounds', None)
    (output / 'manifest.json').write_text(json.dumps(result))
    (output / 'publication-bounds.json').write_text(json.dumps(publication_bounds))


if __name__ == '__main__':
    main()
