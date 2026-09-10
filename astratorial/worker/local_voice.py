"""Credentialed local voice supervision. Run one instance; no scene scripts execute here."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hmac
import json
import math
import os
from pathlib import Path
from uuid import UUID

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from astratorial.config import Config, ProvisioningError
from astratorial.store import Store
from astratorial.voice import hangup, supervise

DEFAULT_RATES = {
    'input_million': 10, 'output_million': 50, 'search_call': .01,
    'cpu_second': .0006, 'gpu_second': .0012, 'tts_character': .001,
    'voice_input_million': 32, 'voice_output_million': 64,
    'voice_text_input_million': 4, 'voice_text_output_million': 24,
}


def local_config():
    load_dotenv(Path(__file__).resolve().parents[1] / '.env.local', override=False)
    def required(*names):
        value = next((os.environ[name].strip() for name in names if os.environ.get(name, '').strip()), '')
        if not value:
            raise ProvisioningError(f'{names[0]} is not configured')
        return value
    rates = {**DEFAULT_RATES, **json.loads(os.environ.get('WORKER_PRICE_CEILINGS_JSON', '{}'))}
    if any(not isinstance(rates[key], (int, float)) or not math.isfinite(rates[key]) or rates[key] < minimum
           for key, minimum in DEFAULT_RATES.items()):
        raise ProvisioningError('Price ceilings must be finite and at least the documented conservative rates')
    return Config(required('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL').rstrip('/'),
                  required('SUPABASE_SERVICE_ROLE_KEY'), required('OPENAI_API_KEY'),
                  os.environ.get('OPENAI_MODEL', 'gpt-6-astra'), rates,
                  required('NEXT_PUBLIC_APP_URL', 'APP_BASE_URL').rstrip('/'),
                  required('LOCAL_WORKER_TOKEN', 'MODAL_WORKER_TOKEN'))


class VoiceInput(BaseModel):
    voiceSessionId: UUID
    callId: str = Field(pattern=r'^[A-Za-z0-9_-]{1,200}$')


@dataclass
class Guard:
    call_id: str
    attached: asyncio.Future
    task: asyncio.Task | None = None
    watchdog: asyncio.Task | None = None


def create_app(config_factory=local_config, store_factory=Store,
               supervisor=supervise, terminate_call=hangup, ready_timeout=14):
    guards: dict[str, Guard] = {}
    config = None

    async def end_record(store, voice_id):
        response = await store.http.patch(f'{store.url}/rest/v1/voice_sessions',
            params={'id': f'eq.{voice_id}'},
            json={'status': 'ended', 'ended_at': datetime.now(timezone.utc).isoformat()})
        response.raise_for_status()

    async def stop_call(voice_id, call_id):
        store = store_factory(config)
        try:
            try:
                await terminate_call(config, call_id)
            finally:
                # Browser polling must stop audio even if provider hangup is unavailable.
                await end_record(store, voice_id)
        finally:
            await store.close()

    async def watchdog(voice_id, call_id, deadline):
        await asyncio.sleep(max(0, min(600, deadline - datetime.now(timezone.utc).timestamp())))
        try:
            await stop_call(voice_id, call_id)
        except Exception:
            # Recovery retries expired calls every five seconds; do not log credentials.
            pass
        guard = guards.get(voice_id)
        if guard and guard.task and not guard.task.done():
            guard.task.cancel()

    async def run_guard(voice_id, guard):
        store = store_factory(config)
        async def ready(attached):
            if not guard.attached.done():
                guard.attached.set_result(bool(attached))
        try:
            await supervisor(config, store, voice_id, guard.call_id, ready)
        except (Exception, asyncio.CancelledError):
            await ready(False)
        finally:
            await ready(False)
            try:
                try:
                    await terminate_call(config, guard.call_id)
                finally:
                    await end_record(store, voice_id)
            except Exception:
                pass
            await store.close()

    async def attach(voice_id, call_id, deadline):
        existing = guards.get(voice_id)
        if existing:
            if existing.call_id != call_id:
                raise HTTPException(409, 'This voice session belongs to another call')
            return existing
        if sum(bool(item.task and not item.task.done()) for item in guards.values()) >= 4:
            raise HTTPException(503, 'The local voice server is busy. Try again shortly')
        guard = Guard(call_id, asyncio.get_running_loop().create_future())
        guards[voice_id] = guard
        guard.task = asyncio.create_task(run_guard(voice_id, guard))
        guard.watchdog = asyncio.create_task(watchdog(voice_id, call_id, deadline))
        return guard

    async def recover():
        while True:
            store = store_factory(config)
            try:
                await store.rpc('expire_practice_frames')
                response = await store.http.get(f'{store.url}/rest/v1/voice_sessions',
                    params={'status': 'in.(starting,active)', 'select': 'id,call_id,expires_at'})
                response.raise_for_status()
                for row in response.json():
                    if not row['call_id']:
                        continue
                    deadline = datetime.fromisoformat(row['expires_at'].replace('Z', '+00:00')).timestamp()
                    if deadline <= datetime.now(timezone.utc).timestamp():
                        await stop_call(row['id'], row['call_id'])
                    elif row['id'] not in guards:
                        # Restarting this process reattaches unexpired persisted sessions.
                        await attach(row['id'], row['call_id'], deadline)
                for voice_id, guard in list(guards.items()):
                    if guard.task.done() and guard.watchdog.done():
                        guards.pop(voice_id, None)
            except Exception:
                pass
            finally:
                await store.close()
            await asyncio.sleep(5)

    @asynccontextmanager
    async def lifespan(application):
        nonlocal config
        config = config_factory()
        recovery = asyncio.create_task(recover())
        try:
            yield
        finally:
            recovery.cancel()
            tasks = [recovery]
            for guard in guards.values():
                for task in (guard.task, guard.watchdog):
                    if task:
                        task.cancel()
                        tasks.append(task)
            await asyncio.gather(*tasks, return_exceptions=True)

    application = FastAPI(title='Astratorial local voice', lifespan=lifespan,
                          docs_url=None, redoc_url=None, openapi_url=None)

    @application.get('/health')
    async def health():
        return {'ok': config is not None, 'service': 'voice'}

    @application.post('/voice')
    async def voice(payload: VoiceInput, request: Request):
        if not config or not hmac.compare_digest(request.headers.get('authorization', ''), f'Bearer {config.worker_token}'):
            raise HTTPException(401, 'Worker authorization required')
        voice_id = str(payload.voiceSessionId)
        store = store_factory(config)
        try:
            response = await store.http.get(f'{store.url}/rest/v1/voice_sessions', params={
                'id': f'eq.{voice_id}', 'call_id': f'eq.{payload.callId}',
                'status': 'in.(starting,active)', 'select': 'expires_at'})
            response.raise_for_status()
            rows = response.json()
        except Exception:
            raise HTTPException(503, 'The voice account could not be verified') from None
        finally:
            await store.close()
        if not rows:
            raise HTTPException(404, 'This voice session is unavailable')
        deadline = datetime.fromisoformat(rows[0]['expires_at'].replace('Z', '+00:00')).timestamp()
        if deadline <= datetime.now(timezone.utc).timestamp():
            raise HTTPException(409, 'This voice session has expired')
        guard = await attach(voice_id, payload.callId, deadline)
        try:
            attached = await asyncio.wait_for(asyncio.shield(guard.attached), timeout=ready_timeout)
            return {'guarded': bool(attached and guard.task and not guard.task.done())}
        except TimeoutError:
            guard.task.cancel()
            return {'guarded': False}

    return application


app = create_app()

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8766, access_log=False)
