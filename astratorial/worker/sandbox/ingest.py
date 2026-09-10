"""Runs with no network/credentials. Only declared capture files are decoded."""
import json
from pathlib import Path
import subprocess
from PIL import Image, ImageStat

ROOT = Path('/job')


def run(*args):
    subprocess.run(args, check=True, timeout=180, stdin=subprocess.DEVNULL)


def main():
    spec = json.loads((ROOT / 'input.json').read_text())
    output = ROOT / 'output'
    images = output / 'images'
    images.mkdir(parents=True, exist_ok=True)
    frames = []
    manual_context = []
    manual_bytes = sum((ROOT / 'inputs' / asset['id']).stat().st_size for asset in spec['assets'] if asset['kind'] == 'manual')
    if manual_bytes > 10_000_000:
        raise ValueError('Manual PDFs must total at most 10 MB.')
    for asset in spec['assets']:
        source = ROOT / 'inputs' / asset['id']
        if asset['kind'] == 'manual':
            if asset['mimeType'] != 'application/pdf':
                raise ValueError('Manual uploads must be PDF files.')
            manuals = output / 'manuals'
            manuals.mkdir(exist_ok=True)
            text_path = manuals / f'{asset["id"]}.txt'
            run('pdftotext', '-layout', '-nopgbrk', str(source), str(text_path))
            text = text_path.read_text(errors='replace')
            manual_context.append({'id': asset['id'], 'name': asset['name'], 'text': text})
            if len(json.dumps(manual_context).encode()) > 90_000:
                raise ValueError('The manuals contain too much text for a reviewed task. Upload the relevant sections or add official reference links.')
            run('pdftoppm', '-f', '1', '-l', '2', '-scale-to', '1600', '-jpeg', str(source), str(manuals / asset['id']))
            continue
        if asset['kind'] not in ('video', 'image', 'audio'):
            continue
        if asset['kind'] == 'image':
            times = [0.0]
        else:
            probe = subprocess.check_output(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(source)])
            metadata = json.loads(probe)
            duration = float(metadata['format']['duration'])
            if duration > 600 or duration <= 0:
                raise ValueError('Use clips between 1 and 600 seconds.')
            if any(stream.get('codec_type') == 'audio' for stream in metadata['streams']):
                audio = output / 'audio'
                audio.mkdir(exist_ok=True)
                run('ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(source), '-vn',
                    '-ac', '1', '-ar', '16000', str(audio / f'{asset["id"]}.wav'))
            if asset['kind'] == 'audio':
                continue
            times = [round(index * duration / min(120, max(2, int(duration * 2))), 4)
                     for index in range(min(120, max(2, int(duration * 2))))]
        # Preserve exact marked measurement frames instead of guessing the nearest sample.
        times += [observation['timestamp'] for m in spec['measurements']
                  for observation in m['observations'] if observation['assetId'] == asset['id']]
        for index, timestamp in enumerate(sorted(set(times))):
            name = f'{asset["id"]}_{index:04}.jpg'
            target = images / name
            run('ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', str(timestamp), '-i', str(source),
                '-frames:v', '1', '-vf', 'scale=1600:1600:force_original_aspect_ratio=decrease', '-q:v', '2', str(target))
            with Image.open(target) as image:
                mean = ImageStat.Stat(image.convert('L')).mean[0]
                if not 8 < mean < 247:
                    target.unlink()
                    continue
            frames.append({'name': name, 'assetId': asset['id'], 'timestamp': timestamp, 'pass': asset.get('pass', 'room')})
    if len(frames) > 480:
        raise ValueError('Capture has too many frames; use shorter guided passes.')
    (output / 'frames.json').write_text(json.dumps(frames))
    (output / 'manuals.json').write_text(json.dumps(manual_context))


if __name__ == '__main__':
    main()
