"""Fixture integration: real orchestrator/checkpoints, fake cloud execution boundary.

These tests intentionally do not claim COLMAP or Blender ran on this machine.
"""
import asyncio
import copy
import json
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
import wave
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from astratorial.pipeline import Pipeline
from astratorial.config import BudgetPaused, NeedsContext


PLAN = {'version': 1, 'title': 'Point to a control', 'goal': 'Locate the button', 'description': 'Observed button',
    'category': 'home', 'difficulty': 'Beginner', 'estimatedMinutes': 1,
    'objects': [{'id': 'button', 'name': 'Button', 'kind': 'control', 'observed': True, 'notes': 'Visible'}],
    'steps': [{'id': 'point', 'title': 'Locate it', 'instruction': 'Point to the button', 'narration': 'Here is the button.',
        'durationSeconds': 1, 'objectIds': ['button'], 'observable': True, 'completionCriteria': 'Hand near button',
        'sourceIds': [], 'action': 'point'}], 'sources': [], 'questions': [], 'constraints': []}
QUALITY = {'approved': True, 'registeredFrameRatio': 1, 'medianReprojectionError': .2,
           'measurementErrors': [.01], 'notes': ['Synthetic orchestration fixture']}
MANIFEST = {'version': 1, 'units': 'meters', 'assets': [], 'durationSeconds': 1,
    'cameras': {name: {'position': [0, 1, 2], 'target': [0, 0, 0]} for name in ('first', 'third')},
    'bounds': {'min': [-1, -1, -1], 'max': [1, 1, 1]}, 'landmarks': [],
    'objects': [{'id': 'button', 'nodeName': 'SourceRoom', 'position': [0, 0, 0], 'movable': False, 'anchors': []}],
    'steps': [{'stepId': 'point', 'startTime': 0, 'endTime': 1, 'clipName': 'tutorial',
               'handTargets': [{'nodeName': 'TutorHand_L', 'objectId': 'button'}]}],
    'rig': {'bodyNode': 'TutorBody', 'handNodes': ['TutorHand_L', 'TutorHand_R']},
    'quality': QUALITY, 'sanitized': False}


def glb_fixture(path):
    # Actual glTF triangle plus a baked object translation track.
    binary = struct.pack('<9f', 0, 0, 0, .1, 0, 0, 0, .1, 0)
    binary += struct.pack('<2f', 0, 1)
    binary += struct.pack('<6f', 0, 0, 0, .1, 0, 0)
    document = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}],
        'nodes': [{'name': 'SourceRoom', 'mesh': 0}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}],
        'buffers': [{'byteLength': len(binary)}],
        'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 36},
                        {'buffer': 0, 'byteOffset': 36, 'byteLength': 8},
                        {'buffer': 0, 'byteOffset': 44, 'byteLength': 24}],
        'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3', 'min': [0,0,0], 'max': [.1,.1,0]},
                      {'bufferView': 1, 'componentType': 5126, 'count': 2, 'type': 'SCALAR', 'min': [0], 'max': [1]},
                      {'bufferView': 2, 'componentType': 5126, 'count': 2, 'type': 'VEC3'}],
        'animations': [{'name': 'tutorial', 'samplers': [{'input': 1, 'output': 2, 'interpolation': 'LINEAR'}],
                        'channels': [{'sampler': 0, 'target': {'node': 0, 'path': 'translation'}}]}]}
    content = json.dumps(document).encode(); content += b' ' * (-len(content) % 4)
    path.write_bytes(struct.pack('<4sII', b'glTF', 2, 28 + len(content) + len(binary)) +
        struct.pack('<II', len(content), 0x4e4f534a) + content + struct.pack('<II', len(binary), 0x004e4942) + binary)


class MemoryStore:
    def __init__(self):
        self.files, self.events, self.alive = {}, [], True

    async def rpc(self, name, **arguments):
        self.events.append((name, arguments))
        return self.alive if name == 'heartbeat_job' else True

    async def upload(self, key, path, mime):
        self.events.append(('upload', key)); self.files[key] = Path(path).read_bytes()

    async def download(self, bucket, key, target, **kwargs):
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        Path(target).write_bytes(self.files.get(key, b'fake capture'))


class FixtureAI:
    def __init__(self):
        self.calls = []

    async def structured(self, key, *args, **kwargs):
        self.calls.append(key)
        return {'approved': True, 'sourceMismatch': False, 'findings': []} if key.startswith('visual-qa') else {'script': '# fake execution boundary'}

    async def narrate(self, key, text, target):
        self.calls.append(key)
        with wave.open(str(target), 'wb') as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000)
            output.writeframes(b'\0' * 6400)


class FixtureSandbox:
    def __init__(self):
        self.calls = []
        self.extra_frames = []

    async def run(self, key, script, inputs, spec, output, **kwargs):
        self.calls.append(key)
        output.mkdir(parents=True, exist_ok=True)
        if script == 'ingest':
            (output / 'images').mkdir()
            frames = [{'name': f'{name}.jpg', 'assetId': name, 'timestamp': 0, 'pass': name} for name in ('room', 'work_area')]
            frames.extend(self.extra_frames)
            for frame in frames:
                Image.new('RGB', (100, 100), 'gray').save(output / 'images' / frame['name'])
            (output / 'frames.json').write_text(json.dumps(frames))
            (output / 'manuals.json').write_text('[]')
        elif script == 'reconstruct':
            self.assert_only_static(inputs)
            (output / 'quality.json').write_text(json.dumps(QUALITY))
            (output / 'reconstruction.json').write_text(json.dumps({'quality': QUALITY, 'cameras': {}}))
        elif script == 'subscan':
            (output / 'cohort.json').write_text(json.dumps({'supplements': [], 'observedStates': []}))
        elif script == 'validate_scans':
            (output / 'reconstruction.json').write_bytes(Path(inputs['/job/source/reconstruction.json']).read_bytes())
        elif script == 'animate':
            glb_fixture(output / 'scene.glb'); glb_fixture(output / 'scene-detail.glb')
            (output / 'manifest.json').write_text(json.dumps(MANIFEST))
            (output / 'publication-bounds.json').write_text(json.dumps(MANIFEST['bounds']))
        elif spec.get('qaOnly'):
            Image.new('RGB', (100,100), 'gray').save(output / 'qa_1.jpg')
        else:
            Image.new('RGB', (100,100), 'gray').save(output / 'poster.jpg')
            (output / 'tutorial.mp4').write_bytes(b'fake renderer boundary')

    @staticmethod
    def assert_only_static(inputs):
        metadata = json.loads(Path(inputs['/job/images/frames.json']).read_text())
        if any(frame['pass'] not in ('room', 'work_area') for frame in metadata):
            raise AssertionError('Moving states entered static reconstruction')


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    def pipeline(self):
        store = MemoryStore()
        claim = {'job': {'id': 'job', 'revision': 1, 'kind': 'generate', 'stage': 'upload', 'progress': 0},
            'tutorial': {'ownerId': 'owner', 'id': 'tutorial', 'assets': [{'id': 'clip', 'path': 'owner/tutorial/r1/clip'}],
                         'plan': copy.deepcopy(PLAN), 'measurements': []}, 'checkpoint': {}}
        pipeline = Pipeline(SimpleNamespace(rates={}), store, None, None, claim, 'worker')
        pipeline.ai, pipeline.runner = FixtureAI(), FixtureSandbox()
        return pipeline, store

    async def test_delivery_contract_and_restart_skip_completed_paid_stages(self):
        pipeline, store = self.pipeline()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'first'; root.mkdir()
            await pipeline.generate(root)
            self.assertEqual(pipeline.tutorial['status'], 'ready')
            scene = pipeline.tutorial['scene']
            self.assertEqual({asset['kind'] for asset in scene['assets']}, {'scene','detail','poster','video','narration'})
            self.assertEqual(scene['steps'][0]['handTargets'][0]['objectId'], 'button')
            paid_calls = pipeline.runner.calls[:], pipeline.ai.calls[:]
            resumed = Path(directory) / 'resumed'; resumed.mkdir()
            await pipeline.generate(resumed)
            self.assertEqual((pipeline.runner.calls, pipeline.ai.calls), paid_calls)
            for index, (name, _) in enumerate(store.events):
                if name == 'upload':
                    self.assertEqual(store.events[index - 1][0], 'heartbeat_job')

    async def test_revoked_lease_cannot_upload_checkpoint(self):
        pipeline, store = self.pipeline(); store.alive = False
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'artifact'; root.mkdir(); (root / 'x').write_text('private')
            with self.assertRaisesRegex(RuntimeError, 'lease ended'):
                await pipeline.persist('artifact', root)
            self.assertFalse(store.files)

    async def test_model_path_identifier_cannot_reach_narration_filesystem(self):
        pipeline, store = self.pipeline()
        pipeline.tutorial['plan']['steps'][0]['id'] = '../../outside'
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'identifiers'):
                await pipeline.generate(Path(directory))
            self.assertFalse(pipeline.ai.calls)

    async def test_second_cohort_failure_restores_base_and_first_cohort(self):
        pipeline, _ = self.pipeline()
        cohorts = []
        for name in ('lifted', 'turned'):
            names = [f'{name}_{index}.jpg' for index in range(6)]
            pipeline.runner.extra_frames.extend({'name': item, 'assetId': name, 'timestamp': index,
                'pass': 'object'} for index, item in enumerate(names))
            cohorts.append({'id': name, 'objectId': 'button', 'kind': 'object', 'stateLabel': name,
                'stationary': True, 'frameNames': names, 'maskBatches': {'0': [], '4': []}})
        pipeline.checkpoint['cohorts'] = cohorts
        original = pipeline.runner.run
        fail = True

        async def interrupted(key, *args, **kwargs):
            nonlocal fail
            if key == 'cohort-turned' and fail:
                fail = False
                raise RuntimeError('simulated interrupted second scan')
            await original(key, *args, **kwargs)

        pipeline.runner.run = interrupted
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / 'first'; first.mkdir()
            with self.assertRaises(NeedsContext):
                await pipeline.generate(first)
            self.assertIn('reconstruction-base', pipeline.checkpoint['bundles'])
            self.assertIn('cohort-lifted', pipeline.checkpoint['bundles'])
            resumed = Path(directory) / 'resumed'; resumed.mkdir()
            await pipeline.generate(resumed)
            self.assertEqual(pipeline.runner.calls.count('reconstruct-base'), 1)
            self.assertEqual(pipeline.runner.calls.count('cohort-lifted'), 1)
            self.assertEqual(pipeline.runner.calls.count('cohort-turned'), 1)
            self.assertEqual(pipeline.tutorial['status'], 'ready')

    async def test_completed_animation_candidate_survives_qa_interruption(self):
        pipeline, _ = self.pipeline()
        original = pipeline.runner.run
        fail = True

        async def interrupted(key, *args, **kwargs):
            nonlocal fail
            if key == 'qa-render/0' and fail:
                fail = False
                raise asyncio.CancelledError()
            await original(key, *args, **kwargs)

        pipeline.runner.run = interrupted
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / 'first'; first.mkdir()
            with self.assertRaises(asyncio.CancelledError):
                await pipeline.generate(first)
            self.assertEqual(pipeline.checkpoint['animationRepair']['activeCandidate'], 0)
            resumed = Path(directory) / 'resumed'; resumed.mkdir()
            await pipeline.generate(resumed)
            self.assertEqual(pipeline.runner.calls.count('animate/0'), 1)
            self.assertEqual(pipeline.ai.calls.count('script/0'), 1)

    async def test_restart_cannot_reset_two_repair_limit(self):
        pipeline, _ = self.pipeline()
        original = pipeline.ai.structured

        async def rejected(key, *args, **kwargs):
            if key.startswith('visual-qa'):
                return {'approved': False, 'sourceMismatch': False, 'findings': ['Hand misses control']}
            if key == 'script/2':
                raise asyncio.CancelledError()
            return await original(key, *args, **kwargs)

        pipeline.ai.structured = rejected
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / 'first'; first.mkdir()
            with self.assertRaises(asyncio.CancelledError):
                await pipeline.generate(first)
            self.assertEqual(pipeline.checkpoint['animationRepair']['nextAttempt'], 3)
            paid_calls = pipeline.runner.calls[:], pipeline.ai.calls[:]
            resumed = Path(directory) / 'resumed'; resumed.mkdir()
            with self.assertRaisesRegex(NeedsContext, 'two repairs'):
                await pipeline.generate(resumed)
            self.assertEqual((pipeline.runner.calls, pipeline.ai.calls), paid_calls)

    async def test_budget_pause_is_not_misreported_as_recapture(self):
        for stage in ('ingest', 'reconstruct-base'):
            with self.subTest(stage=stage):
                pipeline, _ = self.pipeline()
                original = pipeline.runner.run

                async def denied(key, *args, **kwargs):
                    if key == stage:
                        raise BudgetPaused('Reservation denied')
                    await original(key, *args, **kwargs)

                pipeline.runner.run = denied
                with tempfile.TemporaryDirectory() as directory:
                    with self.assertRaises(BudgetPaused):
                        await pipeline.generate(Path(directory))


if __name__ == '__main__':
    unittest.main()
