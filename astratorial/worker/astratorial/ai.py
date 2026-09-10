import base64
import json
from pathlib import Path
import httpx
from jsonschema import validate


def strict_schema(schema):
    schema = json.loads(json.dumps(schema))
    def walk(node):
        if isinstance(node, dict):
            node.pop('default', None)
            if 'prefixItems' in node:
                items = node.pop('prefixItems')
                if not items or any(item != items[0] for item in items):
                    raise ValueError('Only homogeneous tuples are supported in model schemas')
                node.update(items=items[0], minItems=len(items), maxItems=len(items))
            if node.get('type') == 'object':
                node['additionalProperties'] = False
                node['required'] = list(node.get('properties', {}))
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)
    walk(schema)
    return schema


class AI:
    def __init__(self, config, budget):
        self.config, self.budget = config, budget

    async def structured(self, key, instruction, context, schema, images=(), search=False, max_output=18000, files=()):
        content = [{'type': 'input_text', 'text': json.dumps(context)}]
        # Use a deliberately conservative input ceiling, including vision tokens.
        if files:
            raise ValueError('Parse PDFs in the bounded media sandbox before sending model context')
        input_ceiling = (len(instruction.encode()) + len(content[0]['text'].encode()) +
                         len(json.dumps(schema).encode()) + 20_000 * len(images) + (32_000 if search else 0))
        if input_ceiling > 250_000:
            raise ValueError('Model context exceeds the verified standard-price window.')
        for file in images:
            content.append({'type': 'input_image', 'image_url': 'data:image/jpeg;base64,' +
                            base64.b64encode(Path(file).read_bytes()).decode(), 'detail': 'high'})
        for file in files:
            content.append({'type': 'input_file', 'filename': Path(file).name,
                'file_data': 'data:application/pdf;base64,' + base64.b64encode(Path(file).read_bytes()).decode()})
        prices = self.config.rates
        cap = input_ceiling * prices['input_million'] / 1e6 + max_output * prices['output_million'] / 1e6
        if search:
            cap += 2 * prices['search_call']
        body = {'model': self.config.model, 'instructions': instruction, 'store': False,
            'input': [{'role': 'user', 'content': content}], 'max_output_tokens': max_output,
            'text': {'format': {'type': 'json_schema', 'name': 'result', 'strict': True, 'schema': strict_schema(schema)}}}
        if search:
            body.update(tools=[{'type': 'web_search'}], max_tool_calls=2,
                        include=['web_search_call.action.sources'])
        async with self.budget.reserve(key, cap) as settlement:
            async with httpx.AsyncClient(timeout=900) as client:
                result = await client.post('https://api.openai.com/v1/responses', json=body,
                    headers={'Authorization': f'Bearer {self.config.openai_key}'})
                result.raise_for_status()
                response = result.json()
            usage = response.get('usage', {})
            settlement['actual'] = (usage.get('input_tokens', input_ceiling) * prices['input_million'] +
                                    usage.get('output_tokens', max_output) * prices['output_million']) / 1e6
            settlement['actual'] += sum(item['type'] == 'web_search_call' for item in response.get('output', [])) * prices['search_call']
        if response.get('status') != 'completed':
            raise ValueError('The model did not complete its response; retry after checking the generation budget.')
        text = ''.join(part.get('text', '') for item in response['output'] if item['type'] == 'message'
                       for part in item.get('content', []) if part['type'] == 'output_text')
        parsed = json.loads(text)
        validate(parsed, schema)
        if search and 'sources' in parsed:
            verified = {source['url'] for item in response['output'] if item['type'] == 'web_search_call'
                        for source in item.get('action', {}).get('sources', []) if 'url' in source}
            parsed['sources'] = [s for s in parsed['sources'] if s['url'] in verified]
            valid_ids = {s['id'] for s in parsed['sources']}
            for step in parsed.get('steps', []):
                step['sourceIds'] = [value for value in step['sourceIds'] if value in valid_ids]
        return parsed

    async def transcribe(self, key, source):
        import wave
        with wave.open(str(source)) as wav:
            seconds = wav.getnframes() / wav.getframerate()
        async with self.budget.reserve(key, seconds / 60 * .0045):
            async with httpx.AsyncClient(timeout=180) as client:
                with Path(source).open('rb') as audio:
                    response = await client.post('https://api.openai.com/v1/audio/transcriptions',
                        headers={'Authorization': f'Bearer {self.config.openai_key}'},
                        data={'model': 'gpt-transcribe'}, files={'file': (Path(source).name, audio, 'audio/wav')})
                response.raise_for_status()
                return response.json()['text']

    async def narrate(self, key, text, destination):
        if len(text) > 1500 or len(text.encode()) > 1800:
            raise ValueError('Narration is too long for one speech segment.')
        # A configured upper bound includes both input text and output audio cost.
        cap = len(text) * self.config.rates['tts_character']
        async with self.budget.reserve(key, cap):
            async with httpx.AsyncClient(timeout=180) as client:
                response = await client.post('https://api.openai.com/v1/audio/speech',
                    headers={'Authorization': f'Bearer {self.config.openai_key}'},
                    json={'model': 'gpt-4o-mini-tts', 'voice': 'marin', 'input': text,
                          'response_format': 'wav', 'instructions': 'Warm, clear household coach. Speak at a calm practical pace.'})
                response.raise_for_status()
                Path(destination).write_bytes(response.content)
