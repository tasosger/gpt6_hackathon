"""Physically crop private geometry and replace texture atlases before publishing."""
import json
from pathlib import Path
import bpy
import bmesh
from mathutils import Vector

ROOT = Path('/job')


def from_gltf(value):
    return Vector((value[0], -value[2], value[1]))


def main():
    spec = json.loads((ROOT / 'input.json').read_text())
    bounds = spec['bounds']
    if not bounds or any(b <= a for a, b in zip(bounds['min'], bounds['max'])):
        raise ValueError('A bounded task area is required before preparing a public copy.')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / 'scene/scene.glb'))
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 1
    lower = Vector((bounds['min'][0], -bounds['max'][2], bounds['min'][1]))
    upper = Vector((bounds['max'][0], -bounds['min'][2], bounds['max'][1]))
    for obj in list(scene.objects):
        if obj.type not in ('MESH', 'ARMATURE', 'EMPTY'):
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        if obj.type != 'MESH':
            continue
        # Names are model-controlled. Every mesh is cropped, including the tutor.
        # Use deformed coordinates for skinning but remove matching original verts.
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        evaluated_mesh = evaluated.to_mesh()
        if len(evaluated_mesh.vertices) != len(obj.data.vertices):
            raise ValueError('Public crop requires topology-preserving exported meshes')
        outside_indices = {vertex.index for vertex in evaluated_mesh.vertices if any(
            (evaluated.matrix_world @ vertex.co)[axis] < lower[axis] or
            (evaluated.matrix_world @ vertex.co)[axis] > upper[axis] for axis in range(3))}
        evaluated.to_mesh_clear()
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.index in outside_indices], context='VERTS')
        bm.to_mesh(obj.data)
        bm.free()
        if not obj.data.polygons:
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        original_uv = obj.data.uv_layers.active.name if obj.data.uv_layers.active else None
        for slot in obj.material_slots:
            if slot.material:
                slot.material = slot.material.copy()
        atlas = bpy.data.images.new(f'PublicAtlas_{obj.name}', width=2048, height=2048, alpha=False)
        atlas.generated_color = (.5, .5, .5, 1)
        for material in obj.data.materials:
            if material and material.use_nodes:
                nodes = material.node_tree.nodes
                if original_uv:
                    uv = nodes.new('ShaderNodeUVMap')
                    uv.uv_map = original_uv
                    for node in list(nodes):
                        if node.type == 'TEX_IMAGE':
                            material.node_tree.links.new(uv.outputs[0], node.inputs['Vector'])
                target = nodes.new('ShaderNodeTexImage')
                target.image = atlas
                nodes.active = target
        obj.data.uv_layers.new(name='PublicUV')
        obj.data.uv_layers.active_index = len(obj.data.uv_layers) - 1
        obj.data.uv_layers.active.active_render = True
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(island_margin=.02)
        bpy.ops.object.mode_set(mode='OBJECT')
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=8)
        material = bpy.data.materials.new(f'PublicMaterial_{obj.name}')
        material.use_nodes = True
        shader = material.node_tree.nodes.get('Principled BSDF')
        texture = material.node_tree.nodes.new('ShaderNodeTexImage')
        texture.image = atlas
        material.node_tree.links.new(texture.outputs['Color'], shader.inputs['Base Color'])
        obj.data.materials.clear()
        obj.data.materials.append(material)
        for polygon in obj.data.polygons:
            polygon.material_index = 0
        for layer in list(obj.data.uv_layers):
            if layer.name != 'PublicUV':
                obj.data.uv_layers.remove(layer)
        # Export has no extras: private prompts/object paths never enter the file.
    output = ROOT / 'output'
    output.mkdir(exist_ok=True)
    for limit in (2048, 1024, 512):
        for image in bpy.data.images:
            if max(image.size) > limit:
                ratio = limit / max(image.size)
                image.scale(max(1, round(image.size[0] * ratio)), max(1, round(image.size[1] * ratio)))
        bpy.ops.export_scene.gltf(filepath=str(output / 'scene.glb'), export_format='GLB',
            export_yup=True, export_animations=True, export_animation_mode='NLA_TRACKS', export_extras=False)
        if (output / 'scene.glb').stat().st_size <= 20_000_000:
            break
    else:
        raise ValueError('The public task area exceeds the 20 MB mobile scene limit')
    manifest = json.loads((ROOT / 'scene/manifest.json').read_text())
    def inside(point):
        return all(a <= value <= b for a, value, b in zip(bounds['min'], point, bounds['max']))
    manifest['bounds'] = bounds
    manifest['objects'] = [o for o in manifest['objects'] if inside(o['position'])]
    object_ids = {obj['id'] for obj in manifest['objects']}
    for step in manifest['steps']:
        step['handTargets'] = [target for target in step.get('handTargets', []) if target['objectId'] in object_ids]
    manifest['landmarks'] = [o for o in manifest['landmarks'] if inside(o['position'])]
    manifest['sanitized'] = True
    manifest['assets'] = []
    manifest['quality']['notes'] = ['Task-area copy; outside geometry removed and texture atlases rebaked.',
        'Generic instructor: MakeHuman Community base mesh and default rig, CC0.']
    manifest.pop('publicationBounds', None)
    (output / 'manifest.json').write_text(json.dumps(manifest))


if __name__ == '__main__':
    main()
