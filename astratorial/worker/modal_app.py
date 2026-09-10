"""Deploy: modal deploy worker/modal_app.py. No credentials go into render images."""
import asyncio
from datetime import datetime, timezone
import hmac
from pathlib import Path
import re
import sys
import uuid
import modal

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
app = modal.App('astratorial-worker')
trusted_image = (modal.Image.debian_slim(python_version='3.12')
    .pip_install_from_requirements(str(HERE / 'requirements.txt'))
    .add_local_dir(HERE, '/opt/worker', copy=True,
                   ignore=['.venv/**', '**/__pycache__/**', '.env*', 'tests/**'])
    .env({'PYTHONPATH': '/opt/worker'}))
render_image = modal.Image.from_dockerfile(HERE / 'Dockerfile', context_dir=HERE)
secrets = [modal.Secret.from_name('astratorial-services')]
guards = modal.Dict.from_name('astratorial-voice-guards', create_if_missing=True)


@app.function(image=render_image, timeout=60)
def verify_render_image():
    """Explicit image smoke check. No secrets and no user scripts execute here."""
    import subprocess
    import json
    result = {name: subprocess.check_output([name, argument], text=True, stderr=subprocess.STDOUT).splitlines()[0]
              for name, argument in [('blender', '--version'), ('ffmpeg', '-version'), ('colmap', '-h')]}
    modules = subprocess.check_output(['python', '-c',
        'import json,pycolmap,open3d; print(json.dumps({"pycolmap":pycolmap.__version__,"open3d":open3d.__version__}))'], text=True)
    result.update(json.loads(modules))
    return result


@app.function(image=trusted_image, secrets=secrets, timeout=7200, max_containers=4)
async def process_jobs():
    from astratorial.config import Config
    from astratorial.store import Store
    from astratorial.pipeline import Pipeline
    config = Config.from_env()
    store = Store(config)
    worker_id = str(uuid.uuid4())
    try:
        claim = await store.rpc('claim_job', p_worker_id=worker_id, p_lease_seconds=180)
        if claim:
            await Pipeline(config, store, app, render_image, claim, worker_id).run()
    finally:
        await store.close()


@app.function(image=trusted_image, secrets=secrets, schedule=modal.Period(minutes=1), timeout=60)
async def recover_queue():
    for _ in range(4):
        await process_jobs.spawn.aio()
    # Recover expired sessions even if both independent supervisors were restarted.
    from astratorial.config import Config
    from astratorial.store import Store
    from astratorial.voice import hangup
    config = Config.from_env(); store = Store(config)
    try:
        await store.rpc('expire_practice_frames')
        result = await store.http.get(f'{store.url}/rest/v1/voice_sessions', params={
            'status': 'in.(starting,active)', 'expires_at': f'lt.{datetime.now(timezone.utc).isoformat()}',
            'select': 'id,call_id'})
        result.raise_for_status()
        for row in result.json():
            if row['call_id']:
                await hangup(config, row['call_id'])
            await store.http.patch(f'{store.url}/rest/v1/voice_sessions', params={'id': f'eq.{row["id"]}'},
                json={'status': 'ended', 'ended_at': datetime.now(timezone.utc).isoformat()})
    finally:
        await store.close()


@app.function(image=trusted_image, secrets=secrets, timeout=660)
async def voice_watchdog(voice_id: str, call_id: str):
    from astratorial.config import Config
    from astratorial.store import Store
    from astratorial.voice import hangup
    config = Config.from_env(); store = Store(config)
    try:
        response = await store.http.get(f'{store.url}/rest/v1/voice_sessions',
            params={'id': f'eq.{voice_id}', 'call_id': f'eq.{call_id}', 'select': 'expires_at'})
        response.raise_for_status()
        if not response.json():
            return
        expiry = datetime.fromisoformat(response.json()[0]['expires_at'].replace('Z', '+00:00'))
        await asyncio.sleep(max(0, min(600, (expiry - datetime.now(timezone.utc)).total_seconds())))
        await hangup(config, call_id)
    finally:
        await store.close()


@app.function(image=trusted_image, secrets=secrets, timeout=660, max_containers=20)
async def guard_voice(voice_id: str, call_id: str):
    from astratorial.config import Config
    from astratorial.store import Store
    from astratorial.voice import supervise
    config = Config.from_env(); store = Store(config)
    async def ready(attached):
        await guards.put.aio(voice_id, 'attached' if attached else 'failed')
    try:
        await supervise(config, store, voice_id, call_id, ready)
    finally:
        await guards.put.aio(voice_id, 'ended')
        await store.close()


@app.function(image=trusted_image, secrets=secrets, timeout=45)
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def api():
    import os
    from fastapi import FastAPI, HTTPException, Request
    application = FastAPI(title='Astratorial cloud worker', docs_url=None, redoc_url=None)

    def authenticate(request):
        configured = os.environ.get('MODAL_WORKER_TOKEN')
        if not configured or not hmac.compare_digest(request.headers.get('authorization', ''), f'Bearer {configured}'):
            raise HTTPException(status_code=401, detail='Worker authorization required')

    @application.post('/wake')
    async def wake(request: Request):
        authenticate(request)
        payload = await request.json()
        uuid.UUID(payload['jobId'])
        call = await process_jobs.spawn.aio()
        return {'queued': True, 'dispatchId': call.object_id}

    @application.post('/voice')
    async def voice(request: Request):
        authenticate(request)
        payload = await request.json()
        voice_id = str(uuid.UUID(payload['voiceSessionId']))
        call_id = payload['callId']
        if not isinstance(call_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', call_id):
            raise HTTPException(status_code=400, detail='Invalid call ID')
        if not await guards.put.aio(voice_id, 'starting', skip_if_exists=True):
            return {'guarded': await guards.get.aio(voice_id) == 'attached'}
        await voice_watchdog.spawn.aio(voice_id, call_id)
        await guard_voice.spawn.aio(voice_id, call_id)
        for _ in range(70):
            state = await guards.get.aio(voice_id)
            if state == 'attached':
                return {'guarded': True}
            if state in ('failed', 'ended'):
                break
            await asyncio.sleep(.2)
        return {'guarded': False}

    return application
