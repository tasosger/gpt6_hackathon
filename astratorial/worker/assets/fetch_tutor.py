"""Fetch only the explicitly CC0 MakeHuman data from an immutable source revision."""
from pathlib import Path
import hashlib
import json
import urllib.request

COMMIT = 'a8bc2d54ff0ac92e78ff71431b1023eda42bf482'
BASE = f'https://raw.githubusercontent.com/makehumancommunity/makehuman/{COMMIT}/makehuman/data/'
output = Path('/opt/tutor')
output.mkdir(parents=True, exist_ok=True)
attribution = {'name': 'MakeHuman hm08 generic tutor', 'license': 'CC0-1.0',
               'source': f'https://github.com/makehumancommunity/makehuman/tree/{COMMIT}',
               'copyright': 'Data Collection AB, Joel Palmius, Jonas Hauquier; MakeHuman Community', 'files': []}
for relative in ('3dobjs/base.obj', 'rigs/default.mhskel', 'rigs/default_weights.mhw'):
    data = urllib.request.urlopen(BASE + relative, timeout=60).read()
    if 'rigs/' in relative:
        assert json.loads(data)['license'] == 'CC0'
    else:
        assert b'explicitly released as CC0' in data[:1000]
    target = output / Path(relative).name
    target.write_bytes(data)
    attribution['files'].append({'name': target.name, 'sha256': hashlib.sha256(data).hexdigest()})
(output / 'attribution.json').write_text(json.dumps(attribution, indent=2))
