import json
from pathlib import Path, PurePosixPath
from urllib.parse import quote
import httpx


def object_path(path: str, owner: str, tutorial_id: str, revision: int) -> str:
    prefix = f'{owner}/{tutorial_id}/r{revision}/'
    if not path.startswith(prefix) or '..' in PurePosixPath(path).parts or '\\' in path:
        raise ValueError('Storage path is outside the job owner and revision')
    return path


class Store:
    def __init__(self, config):
        self.url = config.supabase_url
        self.http = httpx.AsyncClient(timeout=60, headers={
            'apikey': config.supabase_key, 'Authorization': f'Bearer {config.supabase_key}'})

    async def rpc(self, name, **arguments):
        response = await self.http.post(f'{self.url}/rest/v1/rpc/{name}', json=arguments)
        response.raise_for_status()
        return response.json() if response.content else None

    async def download(self, bucket, path, destination, max_bytes=600_000_000):
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        count = 0
        async with self.http.stream('GET', f'{self.url}/storage/v1/object/{bucket}/{quote(path, safe="/")}') as response:
            response.raise_for_status()
            with destination.open('wb') as output:
                async for chunk in response.aiter_bytes():
                    count += len(chunk)
                    if count > max_bytes:
                        raise ValueError('Asset exceeds processing size limit')
                    output.write(chunk)
        return count

    async def upload(self, path, source, content_type='application/octet-stream'):
        with Path(source).open('rb') as stream:
            # File bodies are bounded artifacts, not an unbounded request read.
            response = await self.http.post(
                f'{self.url}/storage/v1/object/tutorial-assets/{quote(path, safe="/")}',
                content=stream.read(), headers={'content-type': content_type, 'x-upsert': 'true'})
        response.raise_for_status()
        return path

    async def close(self):
        await self.http.aclose()
