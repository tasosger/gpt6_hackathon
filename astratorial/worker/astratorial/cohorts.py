"""Stationary scan cohorts and scale-preserving registration gates."""
import re
import numpy as np


def validate_cohorts(cohorts, frames, object_ids):
    if len(cohorts) > 3:
        raise ValueError('Use at most three supplementary stationary scan states per revision.')
    index = {frame['name']: frame for frame in frames}
    used, identifiers = set(), set()
    for cohort in cohorts:
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', cohort['id']) or cohort['id'] in identifiers:
            raise ValueError('Invalid or duplicated stationary cohort identifier')
        identifiers.add(cohort['id'])
        names = cohort['frameNames']
        if not 6 <= len(names) <= 16 or len(set(names)) != len(names):
            raise ValueError('Each stationary state needs six to sixteen separated camera views.')
        if cohort['kind'] == 'object' and cohort['objectId'] not in object_ids:
            raise ValueError('Supplementary object must match the reviewed task inventory')
        if cohort['kind'] not in ('object', 'surface'):
            raise ValueError('Unsupported scan cohort kind')
        if not cohort['stationary']:
            raise ValueError('The object must stay still while the camera moves around each state.')
        asset_ids = set()
        for name in names:
            if name not in index or index[name]['pass'] not in ('object', 'open_closed', 'empty_surface') or name in used:
                raise ValueError('Stationary cohorts cannot overlap or include base room images')
            used.add(name); asset_ids.add(index[name]['assetId'])
        if len(asset_ids) != 1:
            raise ValueError('A stationary cohort must come from one continuous capture clip')
    return cohorts


def rigid_fit(source, target):
    """Kabsch, with no scaling; known correspondence fixtures exercise the gate."""
    source, target = np.asarray(source, dtype=float), np.asarray(target, dtype=float)
    if source.shape != target.shape or len(source) < 4:
        raise ValueError('Rigid alignment needs matching observed control points')
    a, b = source.mean(axis=0), target.mean(axis=0)
    u, singular, vt = np.linalg.svd((source - a).T @ (target - b))
    if singular[1] < 1e-8:
        raise ValueError('Rigid alignment points are collinear')
    rotation = vt.T @ u.T
    if np.linalg.det(rotation) < 0:
        vt[-1] *= -1; rotation = vt.T @ u.T
    transform = np.eye(4)
    transform[:3, :3] = rotation
    transform[:3, 3] = b - rotation @ a
    error = np.linalg.norm(source @ rotation.T + transform[:3, 3] - target, axis=1)
    return transform, float(np.sqrt(np.mean(error ** 2)))


def validate_registration(transform, fitness, rmse, registered, total):
    transform = np.asarray(transform)
    if transform.shape != (4, 4) or not np.isfinite(transform).all():
        raise ValueError('Invalid supplementary scan transform')
    rotation = transform[:3, :3]
    if (not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-5)
        or abs(np.linalg.det(rotation) - 1) > 1e-5 or not np.allclose(transform[3], [0,0,0,1])):
        raise ValueError('Supplementary alignment must preserve physical scale and handedness')
    if registered < 6 or registered / max(total, 1) < .8:
        raise ValueError('Supplementary scan lacks fixed-background registration; include unchanged surroundings.')
    if fitness < .65 or rmse > .005:
        raise ValueError('Supplementary object alignment is uncertain; capture more overlapping distinctive surfaces.')


def observed_state_transform(world, scale, alignment):
    """Convert canonical object pose back to its independently observed state."""
    metric = np.diag([scale, scale, scale, 1.])
    world, alignment = np.asarray(world), np.asarray(alignment)
    canonical = world @ np.linalg.inv(metric) @ alignment @ metric
    observed = world @ np.linalg.inv(metric) @ np.linalg.inv(alignment) @ metric @ np.linalg.inv(world)
    return canonical, observed
