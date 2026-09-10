import asyncio
from datetime import datetime, timezone
import hashlib
import json
import time
from urllib.parse import quote
import httpx
from websockets.asyncio.client import connect

TOOLS = {'get_current_step', 'repeat_step', 'pause_practice', 'resume_practice',
         'previous_step', 'next_step', 'request_visual_check', 'ask_astra'}


def tool_arguments(name, value):
    if name not in TOOLS:
        raise ValueError('Unknown voice tool')
    if name == 'ask_astra':
        if (not isinstance(value, dict) or set(value) != {'question'}
            or not isinstance(value['question'], str) or not 1 <= len(value['question']) <= 1500):
            raise ValueError('Expert questions must contain only a bounded question')
    elif value != {}:
        raise ValueError('Voice navigation cannot accept client-controlled identifiers')
    return value


def usage_cost(usage, rates):
    incoming = usage.get('input_token_details', {})
    outgoing = usage.get('output_token_details', {})
    # Cached tokens are intentionally billed at the full rate in this safety ledger.
    if not incoming or not outgoing:
        return (usage.get('input_tokens', 0) * rates['voice_input_million'] +
                usage.get('output_tokens', 0) * rates['voice_output_million']) / 1e6
    return (incoming.get('text_tokens', 0) * rates['voice_text_input_million'] +
            incoming.get('audio_tokens', 0) * rates['voice_input_million'] +
            incoming.get('image_tokens', 0) * max(5, rates['voice_input_million']) +
            outgoing.get('text_tokens', 0) * rates['voice_text_output_million'] +
            outgoing.get('audio_tokens', 0) * rates['voice_output_million']) / 1e6


class VoiceLedger:
    def __init__(self, rates, spent=0.0, budget=2.0):
        self.rates, self.spent, self.budget = rates, spent, min(budget, 2.0)
        self.pending = {}

    def reserve(self, key, instruction_bytes):
        # post_instructions is capped at 2000 tokens, charged at the most expensive
        # input modality. Instructions/tools are bounded by their UTF-8 byte size.
        ceiling = ((instruction_bytes + 128) * self.rates['voice_text_input_million'] +
                   2200 * max(self.rates['voice_input_million'], self.rates['voice_text_input_million']) +
                   512 * max(self.rates['voice_output_million'], self.rates['voice_text_output_million'])) / 1e6
        if self.spent + ceiling > self.budget - .03 or self.pending:
            return False
        self.pending[key] = ceiling
        self.spent += ceiling
        return True

    def settle(self, key, usage):
        if key not in self.pending:
            raise ValueError('Unsolicited response was not budgeted by the server')
        ceiling = self.pending.pop(key)
        actual = usage_cost(usage, self.rates) if usage else ceiling
        self.spent += actual - ceiling
        return actual <= ceiling + .00001


async def hangup(config, call_id):
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(f'https://api.openai.com/v1/realtime/calls/{quote(call_id, safe="")}/hangup',
            headers={'Authorization': f'Bearer {config.openai_key}'})
        if response.status_code not in (200, 204, 404, 409):
            response.raise_for_status()


async def supervise(config, store, voice_id, call_id, ready):
    response = await store.http.get(f'{store.url}/rest/v1/voice_sessions', params={'id': f'eq.{voice_id}', 'select': '*'})
    response.raise_for_status()
    rows = response.json()
    if not rows or rows[0]['call_id'] != call_id or rows[0]['status'] not in ('starting', 'active'):
        raise ValueError('Voice session does not match the server record')
    row = rows[0]
    deadline = min(datetime.fromisoformat(row['expires_at'].replace('Z', '+00:00')).timestamp(), time.time() + 600)
    ledger = VoiceLedger(config.rates, float(row['spent_usd']), 2 - float(row.get('expert_spent_usd', 0)))
    response_key = None
    expected_response = False
    instruction_bytes = 0
    fingerprint = None
    attached = False

    async def persist(status=None):
        accepted = await store.rpc('update_voice_usage', p_id=voice_id,
                                   p_spent=round(ledger.spent, 6), p_status=status)
        if not accepted:
            raise RuntimeError('Voice session ended or reached its shared expert/voice budget')

    async def refresh_budget():
        result = await store.http.get(f'{store.url}/rest/v1/voice_sessions',
            params={'id': f'eq.{voice_id}', 'select': 'expert_spent_usd,status'})
        result.raise_for_status()
        rows = result.json()
        if not rows or rows[0]['status'] not in ('starting', 'active'):
            raise RuntimeError('Voice session has ended')
        ledger.budget = 2 - float(rows[0]['expert_spent_usd'])

    def signature(session):
        return hashlib.sha256(json.dumps({k: session.get(k) for k in ('instructions', 'tools', 'model')}, sort_keys=True).encode()).hexdigest()

    try:
        async with connect(f'wss://api.openai.com/v1/realtime?call_id={quote(call_id, safe="")}',
            additional_headers={'Authorization': f'Bearer {config.openai_key}'},
            open_timeout=10, max_size=2_000_000, ping_interval=15) as websocket:
            async def request_response():
                nonlocal expected_response, response_key
                if ledger.pending:
                    return
                await refresh_budget()
                key = str(time.monotonic_ns())
                if not ledger.reserve(key, instruction_bytes):
                    raise RuntimeError('Voice session reached its $2 budget')
                await persist()  # Reserve in durable storage before incurring cost.
                response_key = key
                expected_response = True
                await websocket.send(json.dumps({'type': 'response.create', 'response': {'max_output_tokens': 512}}))

            while time.time() < deadline:
                try:
                    event = json.loads(await asyncio.wait_for(websocket.recv(), timeout=min(2, deadline - time.time())))
                except TimeoutError:
                    continue
                kind = event.get('type')
                if kind == 'session.created':
                    session = event['session']
                    instruction_bytes = len(session.get('instructions', '').encode()) + len(json.dumps(session.get('tools', [])).encode())
                    fingerprint = signature(session)
                    await websocket.send(json.dumps({'type': 'session.update', 'session': {
                        'type': 'realtime', 'max_output_tokens': 512,
                        'audio': {'input': {'turn_detection': {'type': 'server_vad', 'create_response': False, 'interrupt_response': True},
                                            'transcription': None}},
                        'truncation': {'type': 'retention_ratio', 'retention_ratio': .8,
                                       'token_limits': {'post_instructions': 2000}}}}))
                elif kind == 'session.updated':
                    session = event['session']
                    vad = session.get('audio', {}).get('input', {}).get('turn_detection', {})
                    if (session.get('max_output_tokens') != 512 or vad.get('create_response') is not False
                        or session.get('truncation', {}).get('token_limits', {}).get('post_instructions') != 2000
                        or signature(session) != fingerprint):
                        raise RuntimeError('Voice session settings changed outside the server guard')
                    if not attached:
                        attached = True
                        await ready(True)
                elif kind == 'input_audio_buffer.speech_stopped' and attached:
                    await request_response()
                elif kind == 'response.created':
                    if not expected_response:
                        await websocket.send(json.dumps({'type': 'response.cancel'}))
                        raise RuntimeError('Unsupervised voice response')
                    expected_response = False
                elif kind == 'response.done':
                    if not response_key or not ledger.settle(response_key, event['response'].get('usage')):
                        raise RuntimeError('Voice usage exceeded its reserved ceiling')
                    response_key = None
                    await persist()
                    # Server validates tools against current ownership, revision,
                    # practice state and allowed names. Arguments never mutate progress directly.
                    tool_outputs = [item for item in event['response'].get('output', []) if item.get('type') == 'function_call']
                    for item in tool_outputs:
                        arguments = tool_arguments(item.get('name'), json.loads(item.get('arguments', '{}')))
                        async with httpx.AsyncClient(timeout=min(45, max(1, deadline - time.time()))) as client:
                            result = await client.post(f'{config.app_url}/api/internal/voice/{voice_id}/tool',
                                headers={'Authorization': f'Bearer {config.worker_token}'},
                                json={'name': item['name'], 'arguments': arguments, 'requestId': item['call_id']})
                            result.raise_for_status()
                        await websocket.send(json.dumps({'type': 'conversation.item.create', 'item': {
                            'type': 'function_call_output', 'call_id': item['call_id'], 'output': result.text[:12000]}}))
                    if tool_outputs:
                        await request_response()
                elif kind == 'error':
                    raise RuntimeError('Realtime reported an error; ending supervised voice')
    finally:
        if not attached:
            await ready(False)
        try:
            await hangup(config, call_id)
        finally:
            await persist('ended')
