#!/usr/bin/env python3
"""Offline integrity and embedded-resource audit of tutorial/wiki snapshots."""
from pathlib import Path
from html.parser import HTMLParser
import hashlib
import json
import re
import sys
import urllib.parse as U
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'public'
m = json.loads((ROOT / 'snapshot/content-manifest.json').read_text())
index = json.loads((ROOT / 'data/wiki.json').read_text())
errors = []
sha = lambda b: hashlib.sha256(b).hexdigest()

def check(path, digest):
    if not path.is_file() or sha(path.read_bytes()) != digest:
        errors.append('Integrity: ' + str(path.relative_to(ROOT)))

for url, item in m['resources'].items():
    check(ROOT / 'snapshot/files' / item['sha256'], item['sha256'])
    if 'localSha256' in item:
        check(PUBLIC / item['path'].lstrip('/'), item['localSha256'])
    if item.get('derivedFrom') and item['contentType'] == 'image/svg+xml':
        try:
            ET.fromstring((ROOT / 'snapshot/files' / item['sha256']).read_bytes())
        except ET.ParseError:
            errors.append('Invalid extracted original SVG: ' + url)
for title, item in m['pages'].items():
    check(PUBLIC / item['path'].lstrip('/'), item['localSha256'])
for name, item in m['generated'].items():
    check(ROOT / name, item['sha256'])

class Embedded(HTMLParser):
    def __init__(self):
        super().__init__(); self.refs = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.refs.extend(a[k] for k in ('src', 'poster') if k in a)
        if tag == 'link' and a.get('rel') in ('stylesheet', 'icon', 'apple-touch-icon', 'shortcut icon', 'manifest'):
            self.refs.append(a.get('href', ''))
        self.refs.extend(p.strip().split()[0] for p in a.get('srcset', '').split(',') if p.strip())

def ref_check(ref, path):
    if ref.startswith(('data:', '#')) or not ref:
        return
    if ref.startswith(('https:', 'http:', '//')):
        errors.append(f'Remote embedded resource: {path}: {ref}')
    else:
        local = PUBLIC / U.unquote(U.urlsplit(ref).path).lstrip('/')
        if not local.is_file():
            errors.append(f'Missing embedded resource: {path}: {ref}')

html_paths = [PUBLIC / 'guide/index.html', *[PUBLIC / p['path'].lstrip('/') for p in m['pages'].values()]]
for path in html_paths:
    text = path.read_text()
    parser = Embedded(); parser.feed(text)
    for ref in parser.refs:
        ref_check(ref, path.relative_to(ROOT))
    if 'hm.baidu.com' in text:
        errors.append('Statistics script: ' + str(path))
for path, type_ in index['resources'].items():
    if 'text/css' in type_:
        text = (PUBLIC / path.lstrip('/')).read_text()
        for ref in re.findall(r'url\([\"\x27]?([^\s\"\x27)]+)', text):
            ref_check(ref, path)
for ref in re.findall(r'[\"\x27](/guide/images/[^\"\x27]+)', (PUBLIC/'guide/runtime.js').read_text()):
    ref_check(ref, 'guide/runtime.js')
if 'hm.baidu.com' in (PUBLIC / 'guide/runtime.js').read_text():
    errors.append('Guide statistics script')
if len(m['directory']) != m['counts']['pages'] or sum(p['ns'] == 0 for p in m['directory']) != m['counts']['articles']:
    errors.append('Wiki page inventory mismatch')
if m.get('failures'):
    errors.append('Download failures: ' + str(m['failures']))
print(json.dumps({'counts': m['counts'], 'errors': sorted(set(errors))}, ensure_ascii=False, indent=2))
sys.exit(bool(errors))
