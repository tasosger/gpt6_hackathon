"""Real Open3D/pycolmap fixtures; optional on machines without their wheels."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest
import numpy as np
sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parents[1] / 'geometry_tools')]
try:
    import open3d as o3d
    import pycolmap
    from subscans import object_alignment, project_visible
    from surface_union import novel_triangles
    from validate_scans import merge_supplements
    NATIVE = True
except ImportError:
    NATIVE = False
from astratorial.cohorts import validate_registration
from astratorial.textured_ply import read_textured_ply, write_textured_ply


@unittest.skipUnless(NATIVE, 'Requires pinned Open3D0.19.0 and pycolmap4.2.0 runtime')
class NativeGeometryTests(unittest.TestCase):
    def test_recover_asymmetric_rigid_object_from_actual_fpfh_and_icp(self):
        o3d.utility.random.seed(937)
        mesh = o3d.geometry.TriangleMesh.create_sphere(radius=.10, resolution=26)
        vertices = np.asarray(mesh.vertices)
        vertices[:,0] *= 1.4; vertices[:,1] *= .78
        vertices[:,0] += .025 * np.exp(-((vertices[:,2]-.065)**2 + (vertices[:,1]-.018)**2)/.0005)
        vertices[:,2] += .018 * np.exp(-((vertices[:,0]+.10)**2 + (vertices[:,1]+.025)**2)/.0004)
        mesh.compute_vertex_normals()
        rotation = o3d.geometry.get_rotation_matrix_from_xyz([.27, .51, .38])
        translation = np.array([.14, -.085, .10])
        source = copy.deepcopy(mesh).rotate(rotation, center=(0,0,0)).translate(translation)
        matrix, fitness, rmse = object_alignment(source, mesh, .8)
        validate_registration(matrix, fitness, rmse, 8, 8)
        np.testing.assert_allclose(matrix[:3,:3], rotation.T, atol=.004)
        self.assertLess(np.linalg.norm(matrix[:3,3] + .8 * rotation.T @ translation), .002)

    def test_real_radial_camera_projection_and_mesh_occlusion(self):
        camera = pycolmap.Camera(model='SIMPLE_RADIAL', width=1600, height=1200,
                                params=[1000,800,600,.45], camera_id=1)
        pose = pycolmap.Rigid3d()
        vertices = np.array([[.8,.2,2],[1.2,.2,2],[1,.5,2],[1.2,.3,3],[1.8,.3,3],[1.5,.75,3]])
        mesh = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(vertices),
                                       o3d.utility.Vector3iVector([[0,1,2],[3,4,5]]))
        ray_scene = o3d.t.geometry.RaycastingScene()
        ray_scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(mesh))
        x, y = camera.img_from_cam(vertices[:3].mean(axis=0)) / [1600,1200]
        polygons = [[[x-.008,y-.008],[x+.008,y-.008],[x+.008,y+.008],[x-.008,y+.008]]]
        vote, visible = project_visible(mesh, camera, pose, polygons, ray_scene, 1)
        self.assertEqual(vote.tolist(), [True, True])
        self.assertEqual(visible.tolist(), [True, False])

    def test_symmetric_object_alignment_is_rejected(self):
        mesh = o3d.geometry.TriangleMesh.create_sphere(.08, resolution=30)
        rotation = o3d.geometry.get_rotation_matrix_from_xyz([.35,.67,.21])
        moved = copy.deepcopy(mesh).rotate(rotation, center=(0,0,0)).translate([.14,.08,.03])
        with self.assertRaisesRegex(ValueError, 'ambiguous symmetric'):
            object_alignment(moved, mesh, 1)

    def test_nearby_opposite_side_survives_while_duplicate_surface_is_removed(self):
        vertices = np.array([[0,0,0],[1,0,0],[0,1,0]])
        reference = o3d.t.geometry.RaycastingScene()
        reference.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(o3d.geometry.TriangleMesh(
            o3d.utility.Vector3dVector(vertices), o3d.utility.Vector3iVector([[0,1,2]]))))
        candidate = np.concatenate([vertices, vertices + [0,0,.003]])
        retained = novel_triangles(candidate, np.array([[0,1,2],[3,5,4]]), reference)
        self.assertEqual(retained.tolist(), [False, True])

    def test_overlapping_surface_patches_keep_original_corner_uvs(self):
        vertices = [[0,0,0],[1,0,0],[0,1,0]]
        first = [[2,0,0],[3,0,0],[2,1,0]]
        other = first + [[4,0,0],[5,0,0],[4,1,0]]
        uv_one, uv_two = (0.,0.,1.,0.,0.,1.), (.1,.2,.3,.4,.5,.6)
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'source', Path(directory) / 'output'
            output.mkdir()
            supplements = []
            for name, points, faces, uvs in [('one', first, [[0,1,2]], [uv_one]),
                                           ('two', other, [[0,1,2],[3,4,5]], [uv_one, uv_two])]:
                path = source / 'supplements' / name / 'mesh.ply'; path.parent.mkdir(parents=True)
                write_textured_ply(path, points, faces, uvs)
                (path.parent / 'texture.png').write_bytes(b'fixture atlas')
                supplements.append({'objectId': 'surface', 'mesh': f'supplements/{name}/mesh.ply',
                                    'worldTransform': np.eye(4).tolist()})
            reconstruction = {'objectNodes': [], 'supplements': supplements}
            merge_supplements(source, output, reconstruction, np.asarray(vertices), np.array([[0,1,2]]), np.array([-1]))
            points, faces, uvs, _ = read_textured_ply(output / 'supplements/two/mesh.ply')
            self.assertEqual(points[0], (4.,0.,0.))
            self.assertEqual(faces, [(0,1,2)])
            self.assertEqual(uvs, [uv_two])

    def test_deregistering_base_frames_leaves_only_cohort_views_and_fixed_poses(self):
        model = pycolmap.synthesize_dataset(pycolmap.SyntheticDatasetOptions())
        identifiers = list(model.reg_image_ids())
        removed = model.images[identifiers[0]]
        remaining = {identifier: model.images[identifier].cam_from_world().matrix().copy()
                     for identifier in identifiers if model.images[identifier].frame_id != removed.frame_id}
        model.deregister_frame(removed.frame_id)
        with tempfile.TemporaryDirectory() as directory:
            model.write(directory)
            restored = pycolmap.Reconstruction(directory)
            self.assertEqual(set(restored.reg_image_ids()), set(remaining))
            for identifier, matrix in remaining.items():
                np.testing.assert_array_equal(restored.images[identifier].cam_from_world().matrix(), matrix)


if __name__ == '__main__':
    unittest.main()
