#!/usr/bin/env python3
"""Verify raw/local integrity and all captured resource references without networking."""
from pathlib import Path
import collections
import hashlib
import json
import re
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'snapshot/manifest.json').read_text())
errors = []
sha = lambda body: hashlib.sha256(body).hexdigest()
known = set()
for name, item in manifest.get('generated', {}).items():
    path = ROOT / name
    if not path.exists() or sha(path.read_bytes()) != item['sha256']:
        errors.append('Generated file integrity: ' + name)
for key, item in manifest.get('apiResponses', {}).items():
    for path in [ROOT / item['path'], ROOT / 'snapshot/files' / item['sha256']]:
        if not path.exists() or sha(path.read_bytes()) != item['sha256']:
            errors.append('API snapshot integrity: ' + key)
for url, item in manifest['resources'].items():
    raw = ROOT / 'snapshot/files' / item['sha256']
    if not raw.exists() or sha(raw.read_bytes()) != item['sha256']:
        errors.append('Original integrity: ' + url)
    if url == manifest['source']:
        continue
    local = ROOT / 'public' / item['path'].lstrip('/')
    known.add(item['path'])
    if not local.exists() or sha(local.read_bytes()) != item.get('localSha256'):
        errors.append('Local integrity: ' + str(local))

text_files = [ROOT / 'public/index.html', ROOT / 'data/roles.json', ROOT / 'data/editions.json']
for item in manifest['resources'].values():
    if item['path'] in known and any(x in item['contentType'] for x in ['javascript', 'json', 'css']):
        text_files.append(ROOT / 'public' / item['path'].lstrip('/'))
for path in text_files:
    content = path.read_text(errors='replace')
    for match in re.finditer(r'/assets/[^\s\"\x27<>`\\)#]+', content):
        ref = match.group(0)
        if '?' in ref:
            ref = ref.split('?', 1)[0]
        if not (ROOT / 'public' / ref.lstrip('/')).exists():
            errors.append(f'Missing local reference in {path.relative_to(ROOT)}: {ref}')
    if 'text/css' in next((i['contentType'] for i in manifest['resources'].values() if (ROOT / 'public' / i['path'].lstrip('/')) == path), ''):
        for ref in re.findall(r'url\([\"\x27]?([^\s\"\x27)]+)', content):
            if ref.startswith(('http:', 'https:')):
                errors.append('Remote stylesheet resource: ' + ref)
    if 'wss://clocktower.gstonegames.com' in content or 'hm.baidu.com' in content:
        errors.append('Original runtime dependency in ' + str(path.relative_to(ROOT)))

roles = json.loads((ROOT / 'data/roles.json').read_text())['data']
editions = json.loads((ROOT / 'data/editions.json').read_text())
assert len(roles['role']) == manifest['counts']['roles']
assert len(roles['fabled']) == manifest['counts']['fabled']
assert len(editions) == manifest['counts']['editions']
assert len({item['id'] for item in editions}) == len(editions)
if manifest.get('failures'):
    errors.append('Unresolved downloads: ' + json.dumps(manifest['failures'], ensure_ascii=False))
issues = collections.Counter(item['resolution'] for item in manifest.get('sourceIssues', {}).values())
report = {'counts': manifest['counts'], 'sourceIssues': dict(issues), 'errors': sorted(set(errors))}
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(1 if errors else 0)
