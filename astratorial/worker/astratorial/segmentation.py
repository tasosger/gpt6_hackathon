"""Source-space projection and multi-view voting; no generated object geometry."""
import numpy as np
from PIL import Image, ImageDraw


def polygon_membership(pixels, polygons):
    mask = Image.new('1', (1024, 1024))
    draw = ImageDraw.Draw(mask)
    for polygon in polygons:
        if not 3 <= len(polygon) <= 128 or any(len(p) != 2 or not all(0 <= v <= 1 for v in p) for p in polygon):
            raise ValueError('Invalid source-space object polygon')
        draw.polygon([(int(x * 1023), int(y * 1023)) for x, y in polygon], fill=1)
    pixels = np.asarray(pixels)
    valid = np.isfinite(pixels).all(axis=1) & (pixels >= 0).all(axis=1) & (pixels <= 1).all(axis=1)
    result = np.zeros(len(pixels), dtype=bool)
    index = np.clip(np.nan_to_num(pixels[valid]) * 1023, 0, 1023).astype(int)
    result[valid] = np.asarray(mask)[index[:, 1], index[:, 0]]
    return result


def supported_faces(votes, visible):
    votes, visible = np.asarray(votes, dtype=bool), np.asarray(visible, dtype=bool)
    support = (votes & visible).sum(axis=0)
    views = visible.sum(axis=0)
    return (support >= 2) & (support >= .75 * views)


def angular_coverage(centers, object_center, basis):
    rays = (np.asarray(centers) - object_center) @ np.asarray(basis).T
    angles = np.sort(np.mod(np.arctan2(rays[:, 1], rays[:, 0]), 2 * np.pi))
    if len(angles) < 3:
        return 0.0
    gaps = np.diff(np.r_[angles, angles[0] + 2 * np.pi])
    return float(np.degrees(2 * np.pi - gaps.max()))
