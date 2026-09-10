import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_voice import create_app

VOICE_ID = '40000000-0000-4000-8000-000000000001'
CALL_ID = 'rtc_test_call'


class LocalVoiceTests(unittest.TestCase):
    def setUp(self):
        self.expires = datetime.now(timezone.utc) + timedelta(seconds=60)
        self.connected = []
        self.ended = []
        self.hung_up = []
        self.accept = True
        self.found = True

        def transport(request):
            if request.method == 'PATCH':
                self.ended.append(request.url.params.get('id'))
                return httpx.Response(204)
            if request.method == 'POST':
                return httpx.Response(200, json=0)
            # Recovery has no orphan sessions in these fixtures.
            if 'id' not in request.url.params:
                return httpx.Response(200, json=[])
            matches = request.url.params.get('call_id') == f'eq.{CALL_ID}'
            return httpx.Response(200, json=[{'expires_at': self.expires.isoformat()}]
                                  if self.found and matches else [])

        class FakeStore:
            def __init__(store, config):
                store.url = 'https://project.example'
                store.http = httpx.AsyncClient(transport=httpx.MockTransport(transport))
            async def rpc(store, name):
                return 0
            async def close(store):
                await store.http.aclose()

        async def supervisor(config, store, voice_id, call_id, ready):
            self.connected.append((voice_id, call_id))
            await ready(self.accept)
            if self.accept:
                await asyncio.Event().wait()

        async def hangup(config, call_id):
            self.hung_up.append(call_id)

        self.app = create_app(config_factory=lambda: SimpleNamespace(worker_token='local-test-token'),
                              store_factory=FakeStore, supervisor=supervisor, terminate_call=hangup)
        self.headers = {'Authorization': 'Bearer local-test-token'}
        self.payload = {'voiceSessionId': VOICE_ID, 'callId': CALL_ID}

    def test_private_endpoint_requires_token_before_supervising(self):
        with TestClient(self.app) as client:
            response = client.post('/voice', json=self.payload)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(self.connected, [])

    def test_reattempt_reuses_guard_and_shutdown_ends_call(self):
        with TestClient(self.app) as client:
            for _ in range(2):
                response = client.post('/voice', json=self.payload, headers=self.headers)
                self.assertEqual(response.json(), {'guarded': True})
            self.assertEqual(self.connected, [(VOICE_ID, CALL_ID)])
        self.assertIn(CALL_ID, self.hung_up)
        self.assertIn(f'eq.{VOICE_ID}', self.ended)

    def test_failed_guard_never_authorizes_browser_audio(self):
        self.accept = False
        with TestClient(self.app) as client:
            response = client.post('/voice', json=self.payload, headers=self.headers)
            self.assertEqual(response.json(), {'guarded': False})
        self.assertIn(CALL_ID, self.hung_up)

    def test_missing_or_expired_record_cannot_start(self):
        with TestClient(self.app) as client:
            self.found = False
            self.assertEqual(client.post('/voice', json=self.payload, headers=self.headers).status_code, 404)
            self.found = True
            self.expires = datetime.now(timezone.utc) - timedelta(seconds=1)
            self.assertEqual(client.post('/voice', json=self.payload, headers=self.headers).status_code, 409)
            self.assertEqual(self.connected, [])

    def test_independent_deadline_ends_a_stalled_supervisor(self):
        self.expires = datetime.now(timezone.utc) + timedelta(seconds=.15)
        with TestClient(self.app) as client:
            self.assertEqual(client.post('/voice', json=self.payload, headers=self.headers).json(), {'guarded': True})
            time.sleep(.25)
            self.assertIn(CALL_ID, self.hung_up)
            self.assertIn(f'eq.{VOICE_ID}', self.ended)


if __name__ == '__main__':
    unittest.main()
