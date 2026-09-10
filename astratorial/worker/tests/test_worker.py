import asyncio
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zipfile
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from astratorial.geometry import triangulate, scale_from_measurements, quality_gate, calibration_landmarks, measured_work_frame
from astratorial.artifacts import unpack, validate_glb
from astratorial.budget import Budget
from astratorial.config import BudgetPaused
from astratorial.store import object_path
from astratorial.voice import VoiceLedger, usage_cost, tool_arguments
from astratorial.ai import strict_schema
from astratorial.segmentation import polygon_membership, supported_faces, angular_coverage
from astratorial.textured_ply import read_textured_ply
from astratorial.cohorts import validate_cohorts, rigid_fit, validate_registration, observed_state_transform


class GeometryTests(unittest.TestCase):
    def test_triangulation_recovers_observed_point(self):
        target = np.array([.4, .7, 3.0])
        origins = [np.array([x, 0., 0.]) for x in (-1, 1, .3)]
        rays = [(origin, (target-origin)/np.linalg.norm(target-origin)) for origin in origins]
        np.testing.assert_allclose(triangulate(rays), target, atol=1e-10)

    def test_nearly_parallel_measurement_views_fail(self):
        with self.assertRaisesRegex(ValueError, 'wider angle'):
            triangulate([(np.array([0., 0., 0.]), np.array([0., 0., 1.])),
                         (np.array([.0001, 0., 0.]), np.array([0., 0., 1.]))])

    def test_scale_and_independent_dimension(self):
        cameras = {'a': {'K': [[100, 0, 50], [0, 100, 50], [0, 0, 1]], 'R': np.eye(3).tolist(),
                          't': [0, 0, 0], 'width': 100, 'height': 100},
                   'b': {'K': [[100, 0, 50], [0, 100, 50], [0, 0, 1]], 'R': np.eye(3).tolist(),
                          't': [-1, 0, 0], 'width': 100, 'height': 100}}
        def measurement(identifier, length, purpose, endpoint):
            return {'id': identifier, 'label': identifier, 'distanceMeters': length, 'purpose': purpose,
                'observations': [{'assetId': name, 'timestamp': 0,
                    'start': [.5 - offset / 5, .5], 'end': [.5 + (endpoint-offset) / 5, .5]}
                    for name, offset in [('a', 0), ('b', 1)]]}
        measurements = [measurement('scale', 2, 'scale', 1), measurement('check', 4, 'validation', 2)]
        factor, errors, _ = scale_from_measurements(measurements, lambda asset, time: cameras[asset])
        self.assertAlmostEqual(factor, 2)
        self.assertLess(max(errors), 1e-10)
        measurements[1]['distanceMeters'] = 3
        with self.assertRaisesRegex(ValueError, '3%'):
            scale_from_measurements(measurements, lambda asset, time: cameras[asset])

    def test_quality_rejects_fabricated_poisson_surface_and_unmeasured_scale(self):
        self.assertFalse(quality_gate(90, 100, [.2] * 100, .3, [.01])['approved'])
        self.assertFalse(quality_gate(90, 100, [.2] * 100, .98, [])['approved'])
        self.assertTrue(quality_gate(90, 100, [.2] * 100, .98, [.02])['approved'])

    def test_calibration_uses_actual_nonplanar_points(self):
        points = np.random.default_rng(42).uniform(-2, 2, (1000, 3))
        landmarks = calibration_landmarks(points)
        self.assertEqual(len(landmarks), 8)
        for item in landmarks:
            self.assertTrue(np.any(np.all(points == item['position'], axis=1)))
        points[:, 2] = 0
        with self.assertRaises(ValueError):
            calibration_landmarks(points)

    def test_measured_plane_rotates_arbitrary_sfm_axes_to_up(self):
        points = [[0, 2, 0], [1, 2, 0], [0, 2, 0], [0, 2, 1]]
        basis, origin = measured_work_frame([{'position': point} for point in points],
                                           [[.5, 3, .5], [1, 3.2, 1]])
        transformed = (np.asarray(points) - origin) @ basis.T
        np.testing.assert_allclose(transformed[:, 2], 0, atol=1e-10)
        self.assertGreater((basis @ ([.5, 3, .5] - origin))[2], 0)
        self.assertAlmostEqual(np.linalg.det(basis), 1)
        with self.assertRaisesRegex(ValueError, 'noncollinear'):
            measured_work_frame([{'position': [i, 0, 0]} for i in range(4)], [[0, 1, 2]])

    def test_dimension_gate_uses_absolute_tolerance_for_short_objects(self):
        self.assertTrue(quality_gate(90, 100, [.2], .99, [.06], [.2])['approved'])
        self.assertFalse(quality_gate(90, 100, [.2], .99, [.04], [2])['approved'])

    def test_polygon_votes_exclude_occluded_background(self):
        polygons = [[[.2, .2], [.8, .2], [.8, .8], [.2, .8]]]
        self.assertEqual(polygon_membership([[.5, .5], [.9, .5], [-1, 0]], polygons).tolist(), [True, False, False])
        selected = supported_faces([[1, 1, 1], [1, 1, 0], [1, 0, 0]],
                                   [[1, 0, 1], [1, 0, 1], [1, 0, 1]])
        self.assertEqual(selected.tolist(), [True, False, False])
        angle = angular_coverage([[1,0,1], [0,1,1], [-1,0,1], [0,-1,1]], [0,0,0], np.eye(3))
        self.assertAlmostEqual(angle, 270)


class ArtifactTests(unittest.TestCase):
    def test_path_traversal_archive_cannot_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'bad.zip'
            with zipfile.ZipFile(archive, 'w') as value:
                value.writestr('../escape', 'private')
            with self.assertRaises(ValueError):
                unpack(archive, Path(directory) / 'out')
            self.assertFalse((Path(directory) / 'escape').exists())

    def test_ownership_and_revision_are_enforced(self):
        self.assertEqual(object_path('o/t/r1/scene.glb', 'o', 't', 1), 'o/t/r1/scene.glb')
        for path in ('other/t/r1/x', 'o/t/r2/x', 'o/t/r1/../../x'):
            with self.assertRaises(ValueError):
                object_path(path, 'o', 't', 1)

    def test_glb_rejects_external_media_and_accepts_baked_selfcontained_scene(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'scene.glb'
            def write(document):
                text = json.dumps(document).encode()
                text += b' ' * ((4 - len(text) % 4) % 4)
                path.write_bytes(struct.pack('<4sIIII', b'glTF', 2, 20+len(text), len(text), 0x4e4f534a) + text)
            document = {'asset': {'version': '2.0'}, 'meshes': [{}], 'animations': [{}]}
            write(document)
            self.assertEqual(validate_glb(path)['asset']['version'], '2.0')
            document['images'] = [{'uri': 'https://private/source.jpg'}]
            write(document)
            with self.assertRaises(ValueError):
                validate_glb(path)

    def test_contract_export_is_current(self):
        from jsonschema import Draft202012Validator
        for path in (Path(__file__).resolve().parents[1] / 'contracts').glob('*.json'):
            Draft202012Validator.check_schema(json.loads(path.read_text()))
        converted = strict_schema({'type': 'object', 'properties': {'name': {'type': 'string', 'default': 'x'}}})
        self.assertEqual(converted['required'], ['name'])
        self.assertFalse(converted['additionalProperties'])
        self.assertNotIn('default', converted['properties']['name'])
        tuple_schema = strict_schema({'type': 'array', 'prefixItems': [{'type': 'number'}] * 3})
        self.assertEqual(tuple_schema['items'], {'type': 'number'})
        self.assertEqual(tuple_schema['maxItems'], 3)
        self.assertNotIn('prefixItems', tuple_schema)

    def test_actual_colmap_ascii_texture_format_keeps_corner_uvs(self):
        fixture = '''ply
format ascii 1.0
comment TextureFile texture.png
element vertex 3
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
property list uchar float texcoord
end_header
1 2 3
2 2 3
1 3 3
3 0 1 2 6 0 0 1 0 0 1
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'mesh.ply'; path.write_text(fixture)
            vertices, faces, uvs, texture = read_textured_ply(path)
            self.assertEqual(vertices[0], (1., 2., 3.))
            self.assertEqual(faces, [(0, 1, 2)])
            self.assertEqual(uvs, [(0., 0., 1., 0., 0., 1.)])
            self.assertEqual(texture.name, 'texture.png')
            path.write_text(fixture.replace('texture.png', '../secret.png'))
            with self.assertRaises(ValueError):
                read_textured_ply(path)


class CohortTests(unittest.TestCase):
    def test_stationary_cohorts_exclude_motion_base_images_and_duplicate_states(self):
        frames = [{'name': f'f{i}', 'assetId': 'object-video', 'pass': 'object'} for i in range(8)]
        cohort = {'id': 'cup-raised', 'objectId': 'cup', 'kind': 'object', 'stateLabel': 'Raised',
                  'stationary': True, 'frameNames': [f'f{i}' for i in range(8)]}
        self.assertEqual(validate_cohorts([cohort], frames, {'cup'}), [cohort])
        with self.assertRaisesRegex(ValueError, 'stay still'):
            validate_cohorts([{**cohort, 'stationary': False}], frames, {'cup'})
        with self.assertRaisesRegex(ValueError, 'overlap'):
            validate_cohorts([cohort, {**cohort, 'id': 'other'}], frames, {'cup'})
        frames[0]['pass'] = 'room'
        with self.assertRaisesRegex(ValueError, 'base room'):
            validate_cohorts([cohort], frames, {'cup'})

    def test_metric_rigid_alignment_preserves_scale_and_rejects_uncertain_fit(self):
        source = np.random.default_rng(12).normal(size=(20, 3))
        rotation = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]])
        target = source @ rotation.T + [.4, .2, -.1]
        matrix, rmse = rigid_fit(source, target)
        validate_registration(matrix, .95, rmse, 9, 10)
        np.testing.assert_allclose(matrix[:3,:3], rotation, atol=1e-10)
        for invalid, fit, error, registered in [(np.diag([2,2,2,1]), 1, 0, 10),
                (matrix, .4, .001, 10), (matrix, 1, .03, 10), (matrix, 1, .001, 4)]:
            with self.assertRaises(ValueError):
                validate_registration(invalid, fit, error, registered, 10)

    def test_observed_state_roundtrip_with_arbitrary_metric_world_axes(self):
        rng = np.random.default_rng(937)
        for _ in range(100):
            rotation, _ = np.linalg.qr(rng.normal(size=(3,3)))
            rotation[:,0] *= np.linalg.det(rotation)
            other, _ = np.linalg.qr(rng.normal(size=(3,3)))
            other[:,0] *= np.linalg.det(other)
            scale = rng.uniform(.05, 3)
            world = np.eye(4); world[:3,:3] = rotation * scale; world[:3,3] = rng.normal(size=3)
            alignment = np.eye(4); alignment[:3,:3] = other; alignment[:3,3] = rng.normal(size=3)
            canonical, observed = observed_state_transform(world, scale, alignment)
            np.testing.assert_allclose(observed @ canonical, world, atol=1e-10)


class BudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_denied_reservation_does_not_execute_or_settle(self):
        class Store:
            calls = []
            async def rpc(self, name, **args):
                self.calls.append(name); return False
        store = Store()
        with self.assertRaises(BudgetPaused):
            async with Budget(store, 'j', 'w').reserve('render', 30):
                self.fail('Must not execute without budget')
        self.assertEqual(store.calls, ['reserve_job_cost'])

    async def test_ambiguous_failure_settles_conservative_cap_and_retry_is_new(self):
        class Store:
            calls = []
            async def rpc(self, name, **args):
                self.calls.append((name, args)); return True
        store = Store(); budget = Budget(store, 'j', 'w')
        for _ in range(2):
            with self.assertRaises(TimeoutError):
                async with budget.reserve('render', 2):
                    raise TimeoutError('Provider outcome unknown')
        ids = [args['p_reservation_id'] for name, args in store.calls if name == 'reserve_job_cost']
        self.assertNotEqual(ids[0], ids[1])
        self.assertTrue(all(args['p_actual'] >= 2 for name, args in store.calls if name == 'settle_job_cost'))

    async def test_actual_cost_overflow_is_recorded_and_pauses(self):
        class Store:
            calls = []
            async def rpc(self, name, **args):
                self.calls.append((name, args)); return True
        store = Store()
        with self.assertRaisesRegex(BudgetPaused, 'configured ceiling'):
            async with Budget(store, 'j', 'w').reserve('provider', 1) as settlement:
                settlement['actual'] = 1.5
        actual = next(args['p_actual'] for name, args in store.calls if name == 'settle_job_cost')
        self.assertEqual(actual, 1.5)


class VoiceTests(unittest.TestCase):
    rates = {'voice_input_million': 32, 'voice_output_million': 64,
             'voice_text_input_million': 4, 'voice_text_output_million': 24}

    def test_modality_cost_and_no_cache_discount_in_ceiling_ledger(self):
        cost = usage_cost({'input_token_details': {'text_tokens': 1000, 'audio_tokens': 1000},
                           'output_token_details': {'text_tokens': 100, 'audio_tokens': 100}}, self.rates)
        self.assertAlmostEqual(cost, .0448)

    def test_expert_tool_cannot_select_private_tutorial_or_override_budget(self):
        self.assertEqual(tool_arguments('ask_astra', {'question': 'Where should I put this?'}),
                         {'question': 'Where should I put this?'})
        for name, arguments in [('ask_astra', {'question': 'x', 'tutorialId': 'other'}),
                                ('next_step', {'confirmed': True}), ('finish_practice', {})]:
            with self.assertRaises(ValueError):
                tool_arguments(name, arguments)

    def test_one_response_in_flight_and_hard_budget_reservation(self):
        ledger = VoiceLedger(self.rates, spent=1.95)
        self.assertFalse(ledger.reserve('a', 2000))
        ledger = VoiceLedger(self.rates)
        self.assertTrue(ledger.reserve('a', 2000))
        self.assertFalse(ledger.reserve('b', 2000))
        self.assertTrue(ledger.settle('a', {'input_tokens': 100, 'output_tokens': 100}))
        self.assertAlmostEqual(ledger.spent, .0096)
        with self.assertRaises(ValueError):
            ledger.settle('unrequested', {})


if __name__ == '__main__':
    unittest.main()
