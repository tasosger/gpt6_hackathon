import json
from pathlib import Path, PurePosixPath
import stat
import zipfile
from PIL import Image, ImageDraw


def bundle(directory, target):
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(Path(directory).rglob('*')):
            if path.is_symlink():
                raise ValueError('Artifact symlinks are forbidden')
            if path.is_file():
                archive.write(path, path.relative_to(directory))


def unpack(source, target):
    with zipfile.ZipFile(source) as archive:
        if sum(info.file_size for info in archive.infolist()) > 1_000_000_000:
            raise ValueError('Artifact archive expands beyond the size limit')
        for info in archive.infolist():
            path = PurePosixPath(info.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in info.filename or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError('Unsafe artifact archive path')
        archive.extractall(target)


def files_under(directory, remote):
    return {str(PurePosixPath(remote) / p.relative_to(directory)): p
            for p in Path(directory).rglob('*') if p.is_file()}


def contact_sheet(files, target):
    files = list(files)
    columns, width, height = 4, 400, 250
    sheet = Image.new('RGB', (columns * width, max(1, (len(files) + columns - 1) // columns) * height), '#161616')
    draw = ImageDraw.Draw(sheet)
    for index, path in enumerate(files):
        with Image.open(path) as source:
            source = source.convert('RGB')
            source.thumbnail((width, height - 25))
            x, y = index % columns * width, index // columns * height
            sheet.paste(source, (x, y))
            draw.text((x + 5, y + height - 23), f'{index + 1}: {Path(path).stem}', fill='white')
    sheet.save(target, quality=90)


def validate_glb(path, max_bytes=80_000_000):
    import struct
    data = Path(path).read_bytes()
    if len(data) > max_bytes or len(data) < 20:
        raise ValueError('Scene is empty or exceeds the mobile asset budget')
    magic, version, length = struct.unpack_from('<4sII', data)
    if magic != b'glTF' or version != 2 or length != len(data):
        raise ValueError('Invalid glTF binary header')
    chunk_length, chunk_type = struct.unpack_from('<II', data, 12)
    if chunk_type != 0x4e4f534a:
        raise ValueError('GLB must begin with its JSON manifest')
    document = json.loads(data[20:20 + chunk_length])
    for collection in ('images', 'buffers'):
        if any('uri' in item for item in document.get(collection, [])):
            raise ValueError('Scene must be self-contained; external URLs are forbidden')
    if not document.get('meshes') or not document.get('animations'):
        raise ValueError('Scene requires actual geometry and baked animation')
    return document
