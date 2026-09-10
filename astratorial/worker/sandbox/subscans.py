"""Register stationary supplementary states without mixing their dense imagery."""
import json
from pathlib import Path
import shutil
import numpy as np
import open3d as o3d
import pycolmap
from PIL import Image, ImageDraw
from astratorial.cohorts import validate_registration, observed_state_transform
from astratorial.segmentation import polygon_membership, supported_faces
from surface_union import novel_triangles


def cohort_polygons(cohort, name):
    frames = [frame for frame in cohort['masks'] if frame['name'] == name]
    if len(frames) != 1:
        raise ValueError('Every stationary cohort frame needs one unambiguous segmentation')
    objects = [item for item in frames[0]['objects'] if item['id'] == cohort['objectId']]
    if len(objects) != 1 or not objects[0]['polygons']:
        raise ValueError('The supplementary object/surface outline is missing in a selected frame')
    polygons = objects[0]['polygons']
    polygon_membership([[.5, .5]], polygons)  # Validate coordinates before a decoder uses them.
    return polygons


def mesh_from_faces(mesh, selected):
    result = o3d.geometry.TriangleMesh()
    result.vertices = o3d.utility.Vector3dVector(np.asarray(mesh.vertices).copy())
    result.triangles = o3d.utility.Vector3iVector(np.asarray(mesh.triangles)[selected].copy())
    result.remove_unreferenced_vertices()
    result.compute_vertex_normals()
    return result


def object_alignment(source_mesh, target_mesh, scale):
    # Geometry stays metric; FPFH supplies an initialization without assuming the
    # object remained at the same position between independently fixed states.
    registration = o3d.pipelines.registration
    def cloud(mesh):
        value = mesh.sample_points_uniformly(number_of_points=min(20_000, max(3000, len(mesh.vertices))))
        value.scale(scale, center=(0,0,0))
        value = value.voxel_down_sample(.004)
        value.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=.016, max_nn=40))
        features = registration.compute_fpfh_feature(value, o3d.geometry.KDTreeSearchParamHybrid(radius=.04, max_nn=100))
        return value, features
    o3d.utility.random.seed(11)
    source_all, _ = cloud(source_mesh)
    held_indices = list(range(0, len(source_all.points), 5))
    held_out = source_all.select_by_index(held_indices)
    source = source_all.select_by_index(held_indices, invert=True)
    source_features = registration.compute_fpfh_feature(source, o3d.geometry.KDTreeSearchParamHybrid(radius=.04, max_nn=100))
    target, target_features = cloud(target_mesh)
    candidates = []
    for seed in (17, 43):
        o3d.utility.random.seed(seed)
        initial = registration.registration_ransac_based_on_feature_matching(
            source, target, source_features, target_features, True, .02,
            registration.TransformationEstimationPointToPoint(False), 4,
            [registration.CorrespondenceCheckerBasedOnEdgeLength(.9),
             registration.CorrespondenceCheckerBasedOnDistance(.02)],
            registration.RANSACConvergenceCriteria(50_000, .999))
        refined = registration.registration_icp(source, target, .01, initial.transformation,
            registration.TransformationEstimationPointToPlane(), registration.ICPConvergenceCriteria(max_iteration=80))
        candidates.append(refined)
    best, other = sorted(candidates, key=lambda candidate: (-candidate.fitness, candidate.inlier_rmse))
    delta = np.linalg.inv(best.transformation) @ other.transformation
    angle = np.degrees(np.arccos(np.clip((np.trace(delta[:3,:3]) - 1) / 2, -1, 1)))
    if (other.fitness >= best.fitness - .02 and other.inlier_rmse <= best.inlier_rmse + .001
        and (angle > 5 or np.linalg.norm(delta[:3,3]) > .01)):
        raise ValueError('The object has ambiguous symmetric alignment; include distinctive handles/controls in both scans.')
    held = registration.evaluate_registration(held_out, target, .01, best.transformation)
    if held.fitness < .65 or held.inlier_rmse > .005:
        raise ValueError('Held-out observed surfaces do not validate the supplementary rigid alignment')
    return best.transformation, best.fitness, best.inlier_rmse


def project_visible(mesh, camera, pose, polygons, ray_scene, scale):
    vertices, triangles = np.asarray(mesh.vertices), np.asarray(mesh.triangles)
    centers = vertices[triangles].mean(axis=1)
    rotation, translation = pose.rotation.matrix(), pose.translation
    points = centers @ rotation.T + translation
    f, cx, cy, radial = camera.params
    xy = points[:, :2] / np.maximum(points[:, 2:3], 1e-12)
    xy *= 1 + radial * (xy ** 2).sum(axis=1, keepdims=True)
    pixels = (xy * f + [cx, cy]) / [camera.width, camera.height]
    origin = -rotation.T @ translation
    direction = centers - origin
    distance = np.linalg.norm(direction, axis=1)
    rays = np.c_[np.broadcast_to(origin, direction.shape), direction / np.maximum(distance[:,None], 1e-12)]
    hit = ray_scene.cast_rays(o3d.core.Tensor(rays.astype(np.float32)))['t_hit'].numpy()
    visible = (points[:,2] > 0) & ((np.abs(hit - distance) * scale) < .015)
    visible &= (pixels >= 0).all(axis=1) & (pixels <= 1).all(axis=1)
    return polygon_membership(pixels, polygons), visible


def build_subscans(root, cohorts, images, base_database, base_path, base_model, base_mesh,
                   face_labels, object_nodes, scale, world_transform, run, output):
    supplements, states = [], []
    static_mesh = mesh_from_faces(base_mesh, np.asarray(face_labels) < 0)
    static_scene = o3d.t.geometry.RaycastingScene()
    static_scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(static_mesh))
    by_id = {entry['id']: entry for entry in object_nodes}
    for cohort in cohorts:
        work = root / f'cohort-{cohort["id"]}'
        work.mkdir()
        database = work / 'features.db'
        shutil.copy2(base_database, database)
        names = cohort['frameNames']
        image_list = work / 'images.txt'; image_list.write_text('\n'.join(names))
        masks = work / 'registration-masks'; masks.mkdir()
        for name in names:
            polygons = cohort_polygons(cohort, name)
            with Image.open(images / name) as source:
                width, height = source.size
            mask = Image.new('L', (width, height), 255)
            draw = ImageDraw.Draw(mask)
            for polygon in polygons:
                draw.polygon([(x * width, y * height) for x, y in polygon], fill=0)
                # Add a small exclusion border: object-edge descriptors must not
                # be treated as fixed background constraints.
                draw.line([(x * width, y * height) for x, y in polygon + [polygon[0]]], fill=0, width=24)
            mask.save(masks / f'{name}.png')
        run('colmap', 'feature_extractor', '--database_path', str(database), '--image_path', str(images),
            '--image_list_path', str(image_list), '--ImageReader.camera_model', 'SIMPLE_RADIAL',
            '--ImageReader.single_camera_per_image', 'true', '--ImageReader.mask_path', str(masks))
        run('colmap', 'exhaustive_matcher', '--database_path', str(database))
        registered_path = work / 'registered'; registered_path.mkdir()
        constant_cameras = work / 'constant-cameras.txt'
        constant_cameras.write_text('\n'.join(str(identifier) for identifier in sorted(base_model.cameras)))
        run('colmap', 'image_registrator', '--database_path', str(database), '--input_path', str(base_path),
            '--output_path', str(registered_path), '--Mapper.abs_pose_min_num_inliers', '50',
            '--Mapper.abs_pose_max_error', '3', '--Mapper.constant_camera_list_path', str(constant_cameras))
        registered = pycolmap.Reconstruction(str(registered_path))
        # Registration is a PnP operation. Base cameras are an immutable reference.
        for image in base_model.images.values():
            current = registered.images[image.image_id]
            if (not np.allclose(image.cam_from_world().matrix(), current.cam_from_world().matrix(), atol=1e-7)
                or not np.allclose(base_model.cameras[image.camera_id].params, registered.cameras[current.camera_id].params, atol=1e-7)):
                raise ValueError('Supplementary registration modified the fixed base reconstruction')
        selected = [registered.images[identifier] for identifier in registered.reg_image_ids()
                    if registered.images[identifier].name in names]
        validate_registration(np.eye(4), 1, 0, len(selected), len(names))
        reprojection = []
        for image in selected:
            camera = registered.cameras[image.camera_id]
            pose = image.cam_from_world()
            for point in image.points2D:
                if point.point3D_id in registered.points3D:
                    position = registered.points3D[point.point3D_id].xyz
                    pixel = camera.img_from_cam(pose.rotation.matrix() @ position + pose.translation)
                    reprojection.append(np.linalg.norm(np.asarray(pixel) - point.xy))
        if len(reprojection) < 50 * len(selected) or np.median(reprojection) > 1.5:
            raise ValueError('Fixed-background controls do not independently support the supplementary camera poses')
        poses = {image.name: (registered.cameras[image.camera_id], image.cam_from_world()) for image in selected}
        # Delete the registered base views from this temporary model BEFORE stereo.
        # The new state can never use an image of the previous state for depth.
        for frame_id in {registered.images[identifier].frame_id for identifier in registered.reg_image_ids()
                         if registered.images[identifier].name not in names}:
            registered.deregister_frame(frame_id)
        cohort_path = work / 'sparse'; cohort_path.mkdir(); registered.write(str(cohort_path))
        dense = work / 'dense'; dense.mkdir()
        run('colmap', 'image_undistorter', '--image_path', str(images), '--input_path', str(cohort_path),
            '--output_path', str(dense), '--output_type', 'COLMAP', '--max_image_size', '1200')
        run('colmap', 'patch_match_stereo', '--workspace_path', str(dense), '--workspace_format', 'COLMAP',
            '--PatchMatchStereo.geom_consistency', 'true', '--PatchMatchStereo.max_image_size', '1200')
        run('colmap', 'stereo_fusion', '--workspace_path', str(dense), '--input_type', 'geometric',
            '--output_path', str(dense / 'fused.ply'))
        cloud = o3d.io.read_point_cloud(str(dense / 'fused.ply'))
        if len(cloud.points) < 2000:
            raise ValueError('Supplementary state has insufficient observed surface depth')
        mesh, _ = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(cloud, depth=8)
        distance = np.asarray(o3d.geometry.PointCloud(mesh.vertices).compute_point_cloud_distance(cloud)) * scale
        mesh.remove_vertices_by_mask(distance > .015)
        mesh.remove_degenerate_triangles().remove_duplicated_triangles().remove_unreferenced_vertices()
        ray_scene = o3d.t.geometry.RaycastingScene()
        ray_scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(mesh))
        votes, visibility = [], []
        for name, (camera, pose) in poses.items():
            vote, visible = project_visible(mesh, camera, pose, cohort_polygons(cohort, name), ray_scene, scale)
            votes.append(vote); visibility.append(visible)
        selected_faces = supported_faces(votes, visibility)
        if selected_faces.sum() < 100:
            raise ValueError('Supplementary object/surface masks do not agree in three dimensions')
        part = mesh_from_faces(mesh, selected_faces)
        alignment, fitness, rmse = np.eye(4), 1., 0.
        if cohort['kind'] == 'object':
            if cohort['objectId'] not in by_id:
                raise ValueError('The object needs visible overlapping surfaces in the base work-area scan')
            entry = by_id[cohort['objectId']]
            target = mesh_from_faces(base_mesh, np.asarray(face_labels) == entry['label'])
            alignment, fitness, rmse = object_alignment(part, target, scale)
            validate_registration(alignment, fitness, rmse, len(selected), len(names))
            node_name = entry['nodeName']
            # The overlap remains the original base mesh. Only newly observed
            # triangles are added, avoiding duplicate surfaces and z-fighting.
            reference = o3d.t.geometry.RaycastingScene()
            reference.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(target))
            points = np.asarray(part.vertices) * scale
            canonical_points = (points @ alignment[:3,:3].T + alignment[:3,3]) / scale
            novel = novel_triangles(canonical_points, part.triangles, reference, scale)
        else:
            node_name = f'SourcePatch_{cohort["id"]}'
            novel = novel_triangles(part.vertices, part.triangles, static_scene, scale)
        canonical, observed = observed_state_transform(world_transform, scale, alignment)
        state = {'cohortId': cohort['id'], 'objectId': cohort['objectId'], 'stateLabel': cohort['stateLabel'],
            'kind': cohort['kind'], 'nodeName': node_name, 'observedTransform': observed.tolist(),
            'registeredFrameRatio': len(selected) / len(names), 'alignmentFitness': fitness, 'alignmentRmseMeters': rmse,
            'backgroundReprojectionError': float(np.median(reprojection)), 'novelFaces': int(novel.sum()),
            'cameraCentersMetric': [(alignment[:3,:3] @ (-pose.rotation.matrix().T @ pose.translation * scale)
                                      + alignment[:3,3]).tolist() for camera, pose in poses.values()]}
        states.append(state)
        if novel.sum() >= 10:
            part = mesh_from_faces(part, novel)
            mesh_path = dense / 'selected.ply'; o3d.io.write_triangle_mesh(str(mesh_path), part)
            destination = output / 'supplements' / cohort['id']; destination.mkdir(parents=True)
            run('colmap', 'mesh_texturer', '--workspace_path', str(dense), '--input_path', str(mesh_path),
                '--output_path', str(destination), '--output_type', 'TXT')
            supplements.append({'mesh': str((destination / 'mesh.ply').relative_to(output)),
                'nodeName': node_name, 'objectId': cohort['objectId'], 'worldTransform': canonical.tolist()})
    return supplements, states
