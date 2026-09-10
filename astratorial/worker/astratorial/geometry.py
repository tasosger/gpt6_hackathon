"""Pure geometry used by reconstruction and tested independently of COLMAP."""
import math
import numpy as np


def camera_ray(camera: dict, observation: list[float]):
    k = np.asarray(camera['K'], dtype=float)
    rotation = np.asarray(camera['R'], dtype=float)
    translation = np.asarray(camera['t'], dtype=float)
    pixel = np.array([observation[0] * camera['width'], observation[1] * camera['height'], 1.0])
    center = -rotation.T @ translation
    direction = rotation.T @ np.linalg.solve(k, pixel)
    return center, direction / np.linalg.norm(direction)


def triangulate(rays, max_residual=0.02):
    if len(rays) < 2:
        raise ValueError('Mark each measured endpoint in at least two separated views.')
    directions = [np.asarray(ray[1]) for ray in rays]
    widest = max(math.degrees(math.acos(float(np.clip(abs(a @ b), -1, 1))))
                 for index, a in enumerate(directions) for b in directions[index + 1:])
    if widest < 3:
        raise ValueError('Measurement views are too close; capture a wider angle.')
    a = sum(np.eye(3) - np.outer(d, d) for _, d in rays)
    b = sum((np.eye(3) - np.outer(d, d)) @ origin for origin, d in rays)
    point = np.linalg.solve(a, b)
    residual = max(np.linalg.norm(np.cross(point - origin, direction))
                   / max(np.linalg.norm(point - origin), 1e-8) for origin, direction in rays)
    if residual > max_residual or any((point - origin) @ direction <= 0 for origin, direction in rays):
        raise ValueError('Measured endpoints do not agree across the selected views.')
    return point


def scale_from_measurements(measurements, frame_lookup):
    results = []
    for measurement in measurements:
        rays = [[], []]
        for observation in measurement['observations']:
            camera = frame_lookup(observation['assetId'], observation['timestamp'])
            if camera is not None:
                rays[0].append(camera_ray(camera, observation['start']))
                rays[1].append(camera_ray(camera, observation['end']))
        start, end = (triangulate(value) for value in rays)
        distance = float(np.linalg.norm(end - start))
        if distance < 1e-5:
            raise ValueError('Measured endpoints coincide.')
        results.append((measurement, start, end, distance))
    scales = [item[0]['distanceMeters'] / item[3] for item in results if item[0]['purpose'] == 'scale']
    if not scales:
        raise ValueError('A physical scale measurement is required.')
    factor = float(np.median(scales))
    errors = [abs(distance * factor - item['distanceMeters']) / item['distanceMeters']
              for item, _, _, distance in results if item['purpose'] == 'validation']
    if not errors:
        raise ValueError('An independent held-out validation measurement is required.')
    validation = [item for item in results if item[0]['purpose'] == 'validation']
    if any(abs(distance * factor - item['distanceMeters']) > max(.02, .03 * item['distanceMeters'])
           for item, _, _, distance in validation):
        raise ValueError('A held-out dimension exceeds max(3%, 2cm); rescan or correct measurements.')
    landmarks = [{'id': f'{item["id"]}-{suffix}', 'label': f'{item["label"]} {suffix}',
                  'position': (point * factor).tolist()}
                 for item, start, end, _ in results for suffix, point in [('start', start), ('end', end)]]
    return factor, errors, landmarks


def quality_gate(registered, total, errors, coverage, measurement_errors, validation_distances=None):
    reasons = []
    ratio = registered / max(total, 1)
    median = float(np.median(errors)) if len(errors) else float('inf')
    if total < 30 or registered < 24 or ratio < 0.8:
        reasons.append('Too few overlapping frames registered; repeat a slow room/work-area loop.')
    if not math.isfinite(median) or median > 1.5:
        reasons.append('Image alignment is uncertain; avoid motion blur and reflective-only views.')
    if coverage < 0.90:
        reasons.append('The reconstruction has insufficient observed surface coverage; capture missing angles.')
    tolerances = ([max(.03, .02 / distance) for distance in validation_distances]
                  if validation_distances else [.03] * len(measurement_errors))
    if not measurement_errors or len(tolerances) != len(measurement_errors) or any(
            error > limit for error, limit in zip(measurement_errors, tolerances)):
        reasons.append('The independent measured dimensions do not validate the reconstruction.')
    return {'approved': not reasons, 'registeredFrameRatio': ratio,
            'medianReprojectionError': median if math.isfinite(median) else 999,
            'measurementErrors': measurement_errors, 'notes': reasons}


def measured_work_frame(landmarks, camera_centers):
    """Two nonparallel distances on one horizontal work surface establish up.

    The capture instruction, not an SfM convention, identifies this plane as
    horizontal. We reject collinear/nonplanar markings and ambiguous camera side.
    """
    points = np.asarray([item['position'] for item in landmarks], dtype=float)
    if len(points) < 4:
        raise ValueError('Mark width and depth on the same horizontal work surface.')
    origin = points.mean(axis=0)
    _, singular, vh = np.linalg.svd(points - origin)
    if singular[1] < .05 or singular[2] > .01:
        raise ValueError('Width and depth must form a flat, noncollinear work plane.')
    normal = vh[2]
    heights = (np.asarray(camera_centers) - origin) @ normal
    side = float(np.median(heights))
    if abs(side) < .1 or np.mean(heights * side > 0) < .8:
        raise ValueError('Capture both measurements from above the horizontal work surface.')
    normal *= np.sign(side)
    horizontal = points[1] - points[0]
    horizontal -= normal * (horizontal @ normal)
    horizontal /= np.linalg.norm(horizontal)
    basis = np.stack([horizontal, np.cross(normal, horizontal), normal])
    return basis, origin


def calibration_landmarks(points, count=8):
    points = np.asarray(points, dtype=float)
    if len(points) < count:
        raise ValueError('More observed corners are needed for live-camera calibration.')
    center = np.median(points, axis=0)
    # Trim distant outliers, then pick separated measured features. These are real
    # triangulated points, never corners of an invented bounding box.
    radius = np.linalg.norm(points - center, axis=1)
    points = points[radius <= np.quantile(radius, .85)]
    selected = [int(np.argmin(np.linalg.norm(points - center, axis=1)))]
    for _ in range(count - 1):
        distances = np.min(np.linalg.norm(points[:, None] - points[selected], axis=2), axis=1)
        selected.append(int(np.argmax(distances)))
    result = points[selected]
    if np.linalg.svd(result - result.mean(axis=0), compute_uv=False)[-1] < .08:
        raise ValueError('Capture corners on several depths and heights for camera calibration.')
    # Ensure the first six fitting points, not just the held-out two, span 3D.
    if np.linalg.svd(result[:6] - result[:6].mean(axis=0), compute_uv=False)[-1] < .05:
        raise ValueError('The visible fitting landmarks are coplanar; capture a wider room angle.')
    return [{'id': f'scan-{index+1}', 'label': f'Scan marker {index+1}', 'position': point.tolist()}
            for index, point in enumerate(result)]
