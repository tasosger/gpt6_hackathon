"""Keep distinct observed sides while removing redundant co-oriented surfaces."""
import numpy as np
import open3d as o3d


def novel_triangles(vertices, faces, reference, scale=1.0, tolerance=.006):
    vertices, faces = np.asarray(vertices), np.asarray(faces)
    corners = vertices[faces]
    centers = corners.mean(axis=1)
    normals = np.cross(corners[:,1] - corners[:,0], corners[:,2] - corners[:,0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    closest = reference.compute_closest_points(o3d.core.Tensor(centers.astype(np.float32)))
    distance = np.linalg.norm(closest['points'].numpy() - centers, axis=1) * scale
    facing = (normals * closest['primitive_normals'].numpy()).sum(axis=1)
    # A nearby underside is distinct geometry: never discard it just because a
    # thin object's front lies a few millimeters away.
    return (distance > tolerance) | (facing < .9)
