"""Read COLMAP 4.2 mesh_texturer --output_type TXT without losing corner UVs."""
from pathlib import Path
import math


def read_textured_ply(path):
    with Path(path).open() as source:
        if source.readline().strip() != 'ply' or source.readline().strip() != 'format ascii 1.0':
            raise ValueError('Expected COLMAP ASCII textured PLY')
        vertices_count = faces_count = 0
        texture = None
        for _ in range(64):
            line = source.readline().strip()
            if line.startswith('element vertex '):
                vertices_count = int(line.split()[-1])
            elif line.startswith('element face '):
                faces_count = int(line.split()[-1])
            elif line.startswith('comment TextureFile '):
                texture = line.removeprefix('comment TextureFile ')
            elif line == 'end_header':
                break
        else:
            raise ValueError('Invalid PLY header')
        if not 0 < vertices_count <= 1_000_000 or not 0 < faces_count <= 500_000:
            raise ValueError('Textured mesh exceeds delivery limits')
        if texture != 'texture.png':
            raise ValueError('Expected local COLMAP texture atlas')
        vertices = [tuple(map(float, source.readline().split())) for _ in range(vertices_count)]
        if any(len(point) != 3 or not all(map(math.isfinite, point)) for point in vertices):
            raise ValueError('Invalid mesh coordinates')
        faces, uvs = [], []
        for _ in range(faces_count):
            parts = source.readline().split()
            if len(parts) != 11 or parts[0] != '3' or parts[4] != '6':
                raise ValueError('Expected triangular faces with six texture coordinates')
            face = tuple(map(int, parts[1:4]))
            uv = tuple(map(float, parts[5:]))
            if min(face) < 0 or max(face) >= vertices_count or not all(map(math.isfinite, uv)):
                raise ValueError('Invalid mesh face')
            faces.append(face); uvs.append(uv)
        return vertices, faces, uvs, Path(path).parent / texture


def write_textured_ply(path, vertices, faces, uvs):
    """Write a selected observed triangle set, preserving coordinates/corner UVs."""
    used = sorted({index for face in faces for index in face})
    remap = {original: index for index, original in enumerate(used)}
    with Path(path).open('w') as target:
        target.write(f'ply\nformat ascii 1.0\ncomment TextureFile texture.png\nelement vertex {len(used)}\n'
                     f'property float x\nproperty float y\nproperty float z\nelement face {len(faces)}\n'
                     'property list uchar int vertex_indices\nproperty list uchar float texcoord\nend_header\n')
        for index in used:
            target.write(' '.join(format(value, '.10g') for value in vertices[index]) + '\n')
        for face, coordinates in zip(faces, uvs):
            target.write('3 ' + ' '.join(str(remap[index]) for index in face) + ' 6 ' +
                         ' '.join(format(value, '.10g') for value in coordinates) + '\n')
