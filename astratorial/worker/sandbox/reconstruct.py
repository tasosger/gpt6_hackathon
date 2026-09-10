"""COLMAP 4.2 CUDA + observed-surface filtering + calibrated source texture atlas."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import numpy as np
import open3d as o3d
import pycolmap

sys.path.insert(0, '/opt/worker')
from astratorial.geometry import scale_from_measurements, quality_gate, calibration_landmarks, measured_work_frame
from astratorial.segmentation import polygon_membership, supported_faces, angular_coverage

ROOT = Path('/job')


def run(*args):
    subprocess.run(args, check=True, timeout=840, stdin=subprocess.DEVNULL)


def main():
    spec = json.loads((ROOT / 'input.json').read_text())
    frames = json.loads((ROOT / 'images' / 'frames.json').read_text())
    images, sparse, dense = ROOT / 'images', ROOT / 'sparse', ROOT / 'dense'
    sparse.mkdir(exist_ok=True)
    dense.mkdir(exist_ok=True)
    db = str(ROOT / 'features.db')
    base_list = ROOT / 'base-images.txt'
    base_list.write_text('\n'.join(frame['name'] for frame in frames))
    run('colmap', 'feature_extractor', '--database_path', db, '--image_path', str(images),
        '--ImageReader.camera_model', 'SIMPLE_RADIAL', '--image_list_path', str(base_list))
    run('colmap', 'exhaustive_matcher', '--database_path', db)
    run('colmap', 'mapper', '--database_path', db, '--image_path', str(images), '--output_path', str(sparse))
    models = [(p, pycolmap.Reconstruction(str(p))) for p in sparse.iterdir() if p.is_dir()]
    if not models:
        raise ValueError('No connected reconstruction. Repeat the scan with slower overlapping views.')
    source_path, model = max(models, key=lambda value: len(value[1].images))
    # Dense undistortion supplies PINHOLE cameras matching the images used below.
    run('colmap', 'image_undistorter', '--image_path', str(images), '--input_path', str(source_path),
        '--output_path', str(dense), '--output_type', 'COLMAP', '--max_image_size', '1600')
    undistorted = pycolmap.Reconstruction(str(dense / 'sparse'))
    cameras = {}
    original_cameras = {}
    for image in model.images.values():
        camera = model.cameras[image.camera_id]
        pose = image.cam_from_world()
        original_cameras[image.name] = (camera, pose)
    for image in undistorted.images.values():
        camera = undistorted.cameras[image.camera_id]
        pose = image.cam_from_world()
        cameras[image.name] = {'K': camera.calibration_matrix().tolist(), 'R': pose.rotation.matrix().tolist(),
            't': pose.translation.tolist(), 'width': camera.width, 'height': camera.height}

    def lookup(asset_id, timestamp):
        selected = min((f for f in frames if f['assetId'] == asset_id),
                       key=lambda f: abs(f['timestamp'] - timestamp), default=None)
        if not selected or abs(selected['timestamp'] - timestamp) > 0.05:
            return None
        return cameras.get(selected['name'])

    # Convert endpoint pixels through the original distortion model; measurement
    # observations were marked before image_undistorter changed the pixel grid.
    measurements = json.loads(json.dumps(spec['measurements']))
    for measurement in measurements:
        for observation in measurement['observations']:
            frame = min((f for f in frames if f['assetId'] == observation['assetId']),
                        key=lambda f: abs(f['timestamp'] - observation['timestamp']), default=None)
            if not frame or frame['name'] not in original_cameras:
                continue
            original, _ = original_cameras[frame['name']]
            target = cameras[frame['name']]
            for endpoint in ('start', 'end'):
                xy = np.array(observation[endpoint]) * [original.width, original.height]
                ray = original.cam_from_img(xy)
                pixel = np.asarray(target['K']) @ np.array([ray[0], ray[1], 1.0])
                observation[endpoint] = (pixel[:2] / [target['width'], target['height']]).tolist()
    scale, measurement_errors, landmarks = scale_from_measurements(measurements, lookup)
    centers = [(-np.asarray(camera['R']).T @ np.asarray(camera['t'])) * scale for camera in cameras.values()]
    basis, origin = measured_work_frame(landmarks, centers)
    def aligned(points):
        return (np.asarray(points) * scale - origin) @ basis.T
    transform = np.eye(4)
    transform[:3, :3] = basis * scale
    transform[:3, 3] = -basis @ origin
    observed_features = [point.xyz * scale for point in model.points3D.values()
                         if point.error < 1 and point.track.length() >= 4]
    landmarks = calibration_landmarks(observed_features) + landmarks
    for landmark in landmarks:
        landmark['position'] = (basis @ (np.asarray(landmark['position']) - origin)).tolist()
    run('colmap', 'patch_match_stereo', '--workspace_path', str(dense), '--workspace_format', 'COLMAP',
        '--PatchMatchStereo.geom_consistency', 'true', '--PatchMatchStereo.max_image_size', '1600')
    run('colmap', 'stereo_fusion', '--workspace_path', str(dense), '--workspace_format', 'COLMAP',
        '--input_type', 'geometric', '--output_path', str(dense / 'fused.ply'))
    pointcloud = o3d.io.read_point_cloud(str(dense / 'fused.ply'))
    if len(pointcloud.points) < 20_000:
        raise ValueError('Too few observed surface points. Capture textured surfaces from more angles.')
    # Measurement endpoints must lie on observed dense surfaces, not empty space.
    physical_points = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(np.asarray(pointcloud.points) * scale))
    marks = [item for item in landmarks if not item['id'].startswith('scan-')]
    mark_cloud = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(
        np.asarray([basis.T @ np.asarray(mark['position']) + origin for mark in marks])))
    if max(mark_cloud.compute_point_cloud_distance(physical_points), default=1) > .025:
        raise ValueError('Work-surface marks do not lie on reconstructed surfaces; mark visible physical corners.')
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pointcloud, depth=9)
    # Poisson can invent closed walls across missing observations. Remove them.
    vertex_cloud = o3d.geometry.PointCloud(mesh.vertices)
    distances = np.asarray(vertex_cloud.compute_point_cloud_distance(pointcloud)) * scale
    observed = distances < 0.025
    coverage = float(observed.mean())
    mesh.remove_vertices_by_mask(~observed)
    mesh.remove_degenerate_triangles().remove_duplicated_triangles().remove_unreferenced_vertices()
    mesh = mesh.simplify_quadric_decimation(250_000)
    mesh.compute_vertex_normals()
    o3d.io.write_triangle_mesh(str(dense / 'observed.ply'), mesh)
    quality = quality_gate(len(model.images), len(frames),
        [point.error for point in model.points3D.values()], coverage, measurement_errors,
        [item['distanceMeters'] for item in measurements if item['purpose'] == 'validation'])
    output = ROOT / 'output'
    output.mkdir(exist_ok=True)
    (output / 'quality.json').write_text(json.dumps(quality))
    if not quality['approved']:
        return  # The trusted orchestrator turns this into a recapture request.
    # Lift image polygons to observed mesh faces only where raycasting confirms
    # visibility. An occluded background triangle cannot inherit a prop label.
    triangles = np.asarray(mesh.triangles)
    vertices = np.asarray(mesh.vertices)
    face_centers = vertices[triangles].mean(axis=1)
    ray_scene = o3d.t.geometry.RaycastingScene()
    ray_scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(mesh))
    segmentation = spec.get('segmentation', {'requiredIds': [], 'frames': []})
    labels = np.full(len(triangles), -1, dtype=int)
    object_nodes = []
    for object_index, object_id in enumerate(segmentation['requiredIds']):
        supplemented = any(cohort['kind'] == 'object' and cohort['objectId'] == object_id for cohort in spec.get('cohorts', []))
        votes, visibilities, supported_cameras = [], [], []
        for frame in segmentation['frames']:
            if frame['name'] not in original_cameras:
                continue
            match = next((item for item in frame['objects'] if item['id'] == object_id), None)
            if not match or not match['polygons']:
                continue
            camera, pose = original_cameras[frame['name']]
            rotation, translation = pose.rotation.matrix(), pose.translation
            camera_points = face_centers @ rotation.T + translation
            # Feature extraction explicitly uses SIMPLE_RADIAL for original images.
            f, cx, cy, radial = camera.params
            normalized = camera_points[:, :2] / np.maximum(camera_points[:, 2:3], 1e-12)
            distorted = normalized * (1 + radial * (normalized ** 2).sum(axis=1, keepdims=True))
            pixels = (distorted * f + [cx, cy]) / [camera.width, camera.height]
            camera_center = -rotation.T @ translation
            rays = face_centers - camera_center
            distance = np.linalg.norm(rays, axis=1)
            origins = np.broadcast_to(camera_center, rays.shape)
            cast = ray_scene.cast_rays(o3d.core.Tensor(np.c_[origins, rays / distance[:, None]].astype(np.float32)))
            visible = (camera_points[:, 2] > 0) & (np.abs(cast['t_hit'].numpy() - distance) * scale < .015)
            visible &= (pixels >= 0).all(axis=1) & (pixels <= 1).all(axis=1)
            votes.append(polygon_membership(pixels, match['polygons']))
            visibilities.append(visible)
            supported_cameras.append(camera_center * scale)
        if len(votes) < (2 if supplemented else 3):
            raise ValueError(f'Object {object_id} needs visible stationary close-ups from at least three separated angles.')
        selected = supported_faces(votes, visibilities)
        if selected.sum() < 100 or np.any(labels[selected] >= 0):
            raise ValueError(f'Object {object_id} cannot be separated consistently from its surroundings; repeat a stationary work-area loop.')
        object_points = vertices[np.unique(triangles[selected])] * scale
        orbit = angular_coverage(supported_cameras, object_points.mean(axis=0), basis)
        if orbit < 220 and not supplemented:
            raise ValueError(f'Object {object_id} lacks rear/side coverage; capture a stationary full loop with the object raised on a small stable support if needed.')
        # Open boundaries indicate unobserved surfaces. Keep ordinary cup openings
        # but reject substantial missing panels; do not close them procedurally.
        edges = np.sort(np.concatenate([triangles[selected][:, [0, 1]], triangles[selected][:, [1, 2]], triangles[selected][:, [2, 0]]]), axis=1)
        edges, counts = np.unique(edges, axis=0, return_counts=True)
        boundary = edges[counts == 1]
        boundary_length = np.linalg.norm(vertices[boundary[:, 0]] - vertices[boundary[:, 1]], axis=1).sum() * scale
        span = np.linalg.norm(np.ptp(object_points, axis=0))
        if boundary_length > max(.08, span * 1.5) and not supplemented:
            raise ValueError(f'Object {object_id} has uncaptured interaction surfaces; add underside and handle views without moving it during a scan pass.')
        labels[selected] = object_index
        object_nodes.append({'id': object_id, 'nodeName': f'SourceItem_{object_index}', 'label': object_index,
            'orbitDegrees': orbit, 'observedFaces': int(selected.sum()), 'centerMetric': object_points.mean(axis=0).tolist(),
            'cameraCentersMetric': [point.tolist() for point in supported_cameras], 'boundaryLengthMeters': float(boundary_length),
            'spanMeters': float(span), 'requiresSupplement': supplemented})
    (output / 'face-labels.json').write_text(json.dumps(labels.tolist()))
    run('colmap', 'mesh_texturer', '--workspace_path', str(dense),
        '--input_path', str(dense / 'observed.ply'), '--output_path', str(output / 'room'), '--output_type', 'TXT')
    if not (output / 'room/mesh.ply').exists() or not (output / 'room/texture.png').exists():
        raise ValueError('COLMAP produced no textured mesh; do not replace it with invented geometry.')
    bounds_points = aligned(np.asarray(mesh.vertices))
    quality['notes'].append('Coordinate up is established by marked width/depth on the horizontal work surface; source points remain observed, with no gap filling.')
    (output / 'reconstruction.json').write_text(json.dumps({
        'scale': scale, 'mesh': 'room/mesh.ply', 'worldTransform': transform.tolist(),
        'bounds': {'min': bounds_points.min(axis=0).tolist(), 'max': bounds_points.max(axis=0).tolist()},
        'landmarks': landmarks, 'cameras': cameras, 'center': aligned(np.asarray(pointcloud.points).mean(axis=0)).tolist(),
        'objectNodes': object_nodes,
        'quality': quality, 'coverage': coverage,
    }))
    # Only the bounded data needed by later independently checkpointed subscans.
    # These private reconstruction files never become a browser scene asset.
    if spec.get('cohorts'):
        state = output / 'base-state'; state.mkdir()
        shutil.copy2(db, state / 'features.db')
        shutil.copytree(source_path, state / 'model')
        shutil.copy2(dense / 'observed.ply', state / 'observed.ply')


if __name__ == '__main__':
    main()
