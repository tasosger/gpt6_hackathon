"""Render the exported GLB, not the author's source scene, on the narration clock."""
import json
import math
from pathlib import Path
import subprocess
import wave
import bpy
from mathutils import Vector

ROOT = Path('/job')


def main():
    spec = json.loads((ROOT / 'input.json').read_text())
    manifest = json.loads((ROOT / 'scene/manifest.json').read_text())
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / 'scene/scene.glb'))
    scene = bpy.context.scene
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = math.ceil(manifest['durationSeconds'] * 24)
    camera_data = bpy.data.cameras.new('PlaybackCamera')
    camera = bpy.data.objects.new('PlaybackCamera', camera_data)
    scene.collection.objects.link(camera)
    camera_data.lens = 32
    scene.camera = camera
    def from_gltf(point):
        return Vector((point[0], -point[2], point[1]))
    camera.location = from_gltf(manifest['cameras']['third']['position'])
    camera.rotation_euler = (from_gltf(manifest['cameras']['third']['target']) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    scene.world = bpy.data.worlds.new('StudioWorld')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.6, .65, .72, 1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .5
    light_data = bpy.data.lights.new('SoftKey', 'AREA')
    light_data.energy, light_data.shape, light_data.size = 500, 'DISK', 5
    light = bpy.data.objects.new('SoftKey', light_data)
    scene.collection.objects.link(light)
    light.location = camera.location + Vector((0, 0, 2))
    light.rotation_euler = camera.rotation_euler
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 16 if spec.get('qaOnly') else 24
    scene.cycles.use_denoising = True
    preferences = bpy.context.preferences.addons['cycles'].preferences
    preferences.compute_device_type = 'CUDA'
    preferences.get_devices()
    for device in preferences.devices:
        device.use = device.type != 'CPU'
    scene.cycles.device = 'GPU'
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    scene.render.resolution_percentage = 100
    output = ROOT / 'output'
    output.mkdir(exist_ok=True)
    for index, step in enumerate(manifest['steps']):
        scene.frame_set(round((step['startTime'] + step['endTime']) / 2 * 24) + 1)
        scene.render.image_settings.file_format = 'JPEG'
        scene.render.filepath = str(output / f'qa_{index:02}.jpg')
        bpy.ops.render.render(write_still=True)
    scene.frame_set(1)
    scene.render.filepath = str(output / 'poster.jpg')
    bpy.ops.render.render(write_still=True)
    if spec.get('qaOnly'):
        return
    frames = output / 'frames'
    frames.mkdir(exist_ok=True)
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = str(frames / 'frame_')
    bpy.ops.render.render(animation=True)
    inputs = []
    filters = []
    for index, step in enumerate(manifest['steps']):
        source = ROOT / 'audio' / f'{step["stepId"]}.wav'
        inputs += ['-i', str(source)]
        filters.append(f'[{index+1}:a]adelay={round(step["startTime"]*1000)}:all=1[a{index}]')
    filters.append(''.join(f'[a{i}]' for i in range(len(manifest['steps']))) +
                   f'amix=inputs={len(manifest["steps"])}:normalize=0[audio]')
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-framerate', '24', '-i', str(frames / 'frame_%04d.png'),
        *inputs, '-filter_complex', ';'.join(filters), '-map', '0:v', '-map', '[audio]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart',
        '-t', str(manifest['durationSeconds']), str(output / 'tutorial.mp4')], check=True, timeout=180)


if __name__ == '__main__':
    main()
