"""One independently checkpointable stationary cohort sandbox."""
import json
from pathlib import Path
import subprocess
import sys
import numpy as np
import open3d as o3d
import pycolmap
sys.path.insert(0, '/opt/worker')
from subscans import build_subscans

ROOT = Path('/job')


def run(*args):
    subprocess.run(args, check=True, timeout=540, stdin=subprocess.DEVNULL)


def main():
    specification = json.loads((ROOT / 'input.json').read_text())
    base = ROOT / 'base'
    reconstruction = json.loads((base / 'reconstruction.json').read_text())
    labels = json.loads((base / 'face-labels.json').read_text())
    state = base / 'base-state'
    output = ROOT / 'output'; output.mkdir()
    supplements, states = build_subscans(ROOT, specification['cohorts'], ROOT / 'images',
        state / 'features.db', state / 'model', pycolmap.Reconstruction(str(state / 'model')),
        o3d.io.read_triangle_mesh(str(state / 'observed.ply')), np.asarray(labels), reconstruction['objectNodes'],
        reconstruction['scale'], np.asarray(reconstruction['worldTransform']), run, output)
    (output / 'cohort.json').write_text(json.dumps({'supplements': supplements, 'observedStates': states}))


if __name__ == '__main__':
    main()
