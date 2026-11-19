#!/usr/bin/env python3
"""Read the shipped installer's package inventory and feature rendering."""

import importlib.util
import json
from pathlib import Path
import sys


scripts = Path(sys.argv[1]) / 'public' / 'scripts'
spec = importlib.util.spec_from_file_location(
    'agent_dev_source_installer', scripts / 'uclusionInstall.py'
)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
features = json.loads(sys.argv[2])
rendered = {}
for key, enabled in (
    ('claims_reference', features['workClaims']),
    ('audit_reference', features['tokenAudit']),
):
    source = scripts / installer.WORKFLOW_ASSET_PATHS[key]
    relative = source.relative_to(scripts / 'skills' / 'uclusion').as_posix()
    rendered[relative] = installer.render_feature_reference(
        source.read_text(), key, enabled
    )
print(json.dumps({
    'stubs': {
        client: 'public/scripts/' + installer.WORKFLOW_ASSET_PATHS[key]
        for client, key in installer.CLIENT_STUB_ASSET.items()
    },
    'files': [
        Path(relative).as_posix()
        for _key, relative in installer.SKILL_PACKAGE_ASSETS
    ],
    'renderedFeatures': rendered,
}))
