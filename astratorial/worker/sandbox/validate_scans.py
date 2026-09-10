"""Combined source coverage gate; topology welding is diagnostic only."""
import json
from pathlib import Path
import shutil
import sys
import numpy as np
import open3d as o3d
sys.path.insert(0, '/opt/worker')
from astratorial.textured_ply import read_textured_ply, write_textured_ply
from astratorial.segmentation import angular_coverage
from surface_union import novel_triangles

ROOT = Path('/job')


def points_transformed(points, transform):
    matrix = np.asarray(transform)
    return np.asarray(points) @ matrix[:3,:3].T + matrix[:3,3]


def merge_supplements(source, output, reconstruction, base_vertices, base_faces, labels):
    accumulated = {'surface': (base_vertices, base_faces[labels < 0])}
    for item in reconstruction['objectNodes']:
        accumulated[item['id']] = (base_vertices, base_faces[labels == item['label']])
    kept = []
    for supplement in reconstruction.get('supplements', []):
        identifier = supplement['objectId']
        key = identifier if identifier in accumulated else 'surface'
        original, faces, uvs, texture = read_textured_ply(source / supplement['mesh'])
        points = points_transformed(original, supplement['worldTransform'])
        faces = np.asarray(faces)
        previous, previous_faces = accumulated[key]
        reference = o3d.t.geometry.RaycastingScene()
        reference.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(o3d.geometry.TriangleMesh(
            o3d.utility.Vector3dVector(previous), o3d.utility.Vector3iVector(previous_faces))))
        # Keep the first observed surface where independently aligned states
        # overlap. This changes only duplicate face selection, never positions.
        unique = novel_triangles(points, faces, reference)
        if not unique.any():
            continue
        selected_faces = faces[unique]
        destination = output / supplement['mesh']; destination.parent.mkdir(parents=True, exist_ok=True)
        write_textured_ply(destination, original, selected_faces.tolist(), [uv for uv, keep in zip(uvs, unique) if keep])
        shutil.copy2(texture, destination.parent / 'texture.png')
        accumulated[key] = (np.concatenate([previous, points]),
                            np.concatenate([previous_faces, selected_faces + len(previous)]))
        kept.append(supplement)
    reconstruction['supplements'] = kept


def main():
    source = ROOT / 'source'
    reconstruction = json.loads((source / 'reconstruction.json').read_text())
    vertices, faces, _, _ = read_textured_ply(source / reconstruction['mesh'])
    vertices = points_transformed(vertices, reconstruction['worldTransform'])
    faces = np.asarray(faces); labels = np.asarray(json.loads((source / 'face-labels.json').read_text()))
    output = ROOT / 'output'; output.mkdir()
    merge_supplements(source, output, reconstruction, vertices, faces, labels)
    basis = np.asarray(reconstruction['worldTransform'])[:3,:3] / reconstruction['scale']
    for item in reconstruction['objectNodes']:
        points = [vertices]
        indices = [faces[labels == item['label']]]
        total = len(vertices)
        cameras = list(item['cameraCentersMetric'])
        for supplement in reconstruction.get('supplements', []):
            if supplement['objectId'] != item['id']:
                continue
            extra, triangles, _, _ = read_textured_ply(output / supplement['mesh'])
            extra = points_transformed(extra, supplement['worldTransform'])
            points.append(extra); indices.append(np.asarray(triangles) + total); total += len(extra)
        for state in reconstruction.get('observedStates', []):
            if state['objectId'] == item['id'] and state['kind'] == 'object':
                cameras.extend(state['cameraCentersMetric'])
        orbit = angular_coverage(cameras, np.asarray(item['centerMetric']), basis)
        if orbit < 220:
            raise ValueError(f'Combined object {item["id"]} lacks rear/side coverage across the observed states')
        combined = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(np.concatenate(points)),
                                           o3d.utility.Vector3iVector(np.concatenate(indices)))
        combined.remove_unreferenced_vertices()
        # Registration may leave millimeter seams. Diagnostic welding does not
        # alter any delivered vertex or replace observed surfaces.
        combined.merge_close_vertices(.006)
        combined.remove_degenerate_triangles().remove_duplicated_triangles().remove_unreferenced_vertices()
        triangles, coords = np.asarray(combined.triangles), np.asarray(combined.vertices)
        edges = np.sort(np.concatenate([triangles[:,[0,1]], triangles[:,[1,2]], triangles[:,[2,0]]]), axis=1)
        edges, counts = np.unique(edges, axis=0, return_counts=True)
        boundary = edges[counts == 1]
        length = np.linalg.norm(coords[boundary[:,0]] - coords[boundary[:,1]], axis=1).sum()
        span = np.linalg.norm(np.ptp(coords, axis=0))
        _, sizes, _ = combined.cluster_connected_triangles()
        if length > max(.08, span * 1.5) or max(sizes, default=0) / max(len(triangles),1) < .8:
            raise ValueError(f'Object {item["id"]} still has missing or disconnected interaction surfaces; capture the gaps in a stationary state')
        item['combinedOrbitDegrees'] = orbit
        item['combinedBoundaryLengthMeters'] = float(length)
        item['requiresSupplement'] = False
    reconstruction['quality']['notes'].append('Supplementary states use immutable background registration, isolated stereo and validated rigid source alignment; combined surface coverage passed.')
    (output / 'reconstruction.json').write_text(json.dumps(reconstruction))


if __name__ == '__main__':
    main()
