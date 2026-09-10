import asyncio
import json
from pathlib import Path, PurePosixPath
import time
import modal
from modal.types import FileType


class SandboxRunner:
    def __init__(self, app, image, config, budget):
        self.app, self.image, self.config, self.budget = app, image, config, budget

    async def run(self, key, script, inputs, specification, output_dir, *, gpu=False, seconds=900):
        rate = self.config.rates['gpu_second' if gpu else 'cpu_second']
        async with self.budget.reserve(f'compute/{key}', rate * (seconds + 120)) as settlement:
            started = time.monotonic()
            sandbox = await modal.Sandbox.create.aio(app=self.app, image=self.image,
                gpu='L4' if gpu else None, cpu=(4.0, 4.0), memory=(16384, 16384),
                timeout=seconds, block_network=True, workdir='/job')
            try:
                # No cloud credentials or writable shared volumes are injected.
                for destination, source in inputs.items():
                    path = PurePosixPath(destination)
                    if not destination.startswith('/job/') or '..' in path.parts:
                        raise ValueError('Invalid sandbox input path')
                    await sandbox.filesystem.copy_from_local.aio(str(source), destination)
                await sandbox.filesystem.write_text.aio(json.dumps(specification), '/job/input.json')
                blender = script in ('animate', 'render', 'publish')
                args = ['blender', '--background', '--factory-startup', '--disable-autoexec',
                        '--python-exit-code', '1', '--python', f'/opt/sandbox/{script}.py'] if blender else [
                        'python', f'/opt/sandbox/{script}.py']
                process = await sandbox.exec.aio(*args, timeout=seconds - 10)
                # Drain bounded diagnostics; generated code cannot fill orchestrator RAM.
                async def tail(stream):
                    value = ''
                    async for line in stream:
                        value = (value + line)[-8000:]
                    return value
                stdout, stderr, _ = await asyncio.gather(tail(process.stdout), tail(process.stderr), process.wait.aio())
                if process.returncode:
                    raise RuntimeError(f'{script} exited {process.returncode}: {(stderr or stdout)[-4000:]}')
                total = 0
                async def collect(remote, local):
                    nonlocal total
                    Path(local).mkdir(parents=True, exist_ok=True)
                    for entry in await sandbox.filesystem.list_files.aio(remote):
                        name = PurePosixPath(entry.name).name
                        if name in ('.', '..') or '/' in entry.name.strip('/'):
                            raise ValueError('Unexpected sandbox output path')
                        if name == 'frames':
                            continue  # Intermediate PNG sequences are never transferred.
                        if entry.type == FileType.DIRECTORY:
                            await collect(f'{remote}/{name}', Path(local) / name)
                        elif entry.type == FileType.FILE:
                            total += entry.size
                            if total > 1_000_000_000:
                                raise ValueError('Generated artifact set exceeds the 1 GB limit')
                            await sandbox.filesystem.copy_to_local.aio(f'{remote}/{name}', str(Path(local) / name))
                        else:
                            raise ValueError('Sandbox outputs must be regular files and directories')
                await collect('/job/output', output_dir)
            finally:
                await sandbox.terminate.aio()
                settlement['actual'] = rate * (time.monotonic() - started)
        return Path(output_dir)
