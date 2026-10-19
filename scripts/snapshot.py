#!/usr/bin/env python3
"""Capture public read-only content; rebuild the local frontend without a compiler."""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
import mimetypes
from pathlib import Path
import re
import shutil
import struct
import time
import urllib.parse
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://clocktower.gstonegames.com'
PAGE = ORIGIN + '/grimoire/'
UPSTREAM = 'https://raw.githubusercontent.com/bra1n/townsquare/1eb085b7825c5f40073c1961ac301e7c07af5071/'
RAW = ROOT / 'snapshot' / 'files'
PUBLIC = ROOT / 'public'
DATA = ROOT / 'data'
MANIFEST = ROOT / 'snapshot' / 'manifest.json'
RESOURCE = re.compile(r'\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|mp3|ogg|wav|json|css|js)(?:[?#]|$)', re.I)
URL = re.compile(r'https?://[^\s\"\x27<>`\\)]+')
args = argparse.ArgumentParser()
args.add_argument('--offline', action='store_true', help='rebuild exclusively from captured files')
args.add_argument('--refresh', action='store_true', help='refresh previously captured URLs too')
ARGS = args.parse_args()
for directory in [RAW, PUBLIC / 'grimoire', DATA]:
    directory.mkdir(parents=True, exist_ok=True)
manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {'resources': {}}
resources = manifest['resources']
failures = dict(manifest.get('failures', {}))
source_issues = dict(manifest.get('sourceIssues', {}))

def digest(b):
    return hashlib.sha256(b).hexdigest()

def request(url, payload=None):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, data=None if payload is None else json.dumps(payload).encode(), headers={
                'User-Agent': 'ClocktowerLocalSnapshot/1.0',
                **({'Content-Type': 'application/json'} if payload is not None else {})
            })
            with urllib.request.urlopen(req, timeout=45) as response:
                body = response.read()
                if not body:
                    raise ValueError('empty response')
                return body, response.headers.get('Content-Type', mimetypes.guess_type(url)[0] or 'application/octet-stream')
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)

def save_raw(body):
    sha = digest(body)
    path = RAW / sha
    if not path.exists():
        path.write_bytes(body)
    return sha

def local_url(url):
    p = urllib.parse.urlsplit(url)
    path = p.path or '/index'
    # Keep original paths so runtime-computed icon URLs continue to work.
    if any(part in ('.', '..') for part in path.split('/')):
        raise ValueError('unsafe asset path: ' + url)
    if p.query:
        path += '-' + digest(p.query.encode())[:12] + ('.css' if p.hostname == 'fonts.googleapis.com' else '')
    return '/assets/' + p.netloc + path

def fetch_asset(url):
    url = urllib.parse.urldefrag(url)[0]
    if url in resources and not ARGS.refresh:
        return url, resources[url], (RAW / resources[url]['sha256']).read_bytes()
    if ARGS.offline:
        raise RuntimeError('missing captured URL: ' + url)
    body, content_type = request(url)
    item = {'path': local_url(url), 'sha256': save_raw(body), 'bytes': len(body), 'contentType': content_type}
    return url, item, body

def capture_batch(urls):
    pending = sorted(set(urllib.parse.urldefrag(u)[0] for u in urls) - set(resources))
    if not pending:
        return []
    print('Capturing', len(pending), 'resources', flush=True)
    captured = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch_asset, u): u for u in pending}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            url = futures[future]
            try:
                url, item, body = future.result()
                resources[url] = item
                captured.append((url, item, body))
                failures.pop(url, None)
            except Exception as error:
                failures.setdefault(url, str(error))
                print('FAILED', url, str(error), flush=True)
            if index % 25 == 0 or index == len(pending):
                print('Progress', index, '/', len(pending), flush=True)
                MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return captured

def api(path, payload, key):
    cache = ROOT / 'snapshot' / (key + '.json')
    if ARGS.offline:
        body = cache.read_bytes()
    else:
        body, _ = request(ORIGIN + path, payload)
    value = json.loads(body)
    if not isinstance(value.get('data'), dict):
        raise ValueError('unexpected API response for ' + key)
    if not ARGS.offline:
        cache.write_bytes(body)
    manifest.setdefault('apiResponses', {})[key] = {'url': ORIGIN + path, 'method': 'POST', 'requestBody': payload, 'path': str(cache.relative_to(ROOT)), 'sha256': save_raw(body), 'bytes': len(body)}
    return value

def asset_urls(text, base, kind):
    urls = set()
    for url in URL.findall(text):
        if urllib.parse.urlsplit(url).hostname == 'hm.baidu.com':
            continue
        if RESOURCE.search(url) or url.startswith('https://fonts.googleapis.com/css'):
            urls.add(url.replace('&amp;', '&'))
    if kind == 'html':
        for ref in re.findall(r'(?:src|href|content)=[\"\x27]([^\"\x27]+)', text):
            if RESOURCE.search(ref) or 'fonts.googleapis.com/css' in ref:
                urls.add(urllib.parse.urljoin(base, ref.replace('&amp;', '&')))
                if ref.startswith('/static/'):
                    urls.add(urllib.parse.urljoin(PAGE, ref.lstrip('/')))
    if kind == 'css':
        for ref in re.findall(r'url\([\"\x27]?([^\s\"\x27)]+)', text):
            if not ref.startswith(('data:', '#')):
                urls.add(urllib.parse.urljoin(base, ref))
    if kind == 'js':
        for ref in re.findall(r'\w\.p\+"([^"\s]+)"', text):
            if RESOURCE.search(ref):
                urls.add(urllib.parse.urljoin(PAGE, ref))
        for ref in re.findall(r'[\"\x27]((?:\.?/?(?:static|img|fonts|sounds)/)[^\"\x27]+)[\"\x27]', text):
            if RESOURCE.search(ref):
                urls.add(urllib.parse.urljoin(PAGE, ref))
    return urls

def kind_for(url, item):
    ct = item['contentType']
    if 'json' in ct or url.endswith('.json'):
        return 'json'
    if 'javascript' in ct or url.endswith('.js'):
        return 'js'
    if 'css' in ct or 'fonts.googleapis.com/css' in url:
        return 'css'
    if 'html' in ct:
        return 'html'
    return None

print('Reading official catalog', flush=True)
roles_response = api('/ct/grimoireRoleJson/', {}, 'roles')
# Local rules correction requested for Pit-Hag; keep the captured API intact.
pit_hag = [role for role in roles_response['data']['role'] if role['id'] == 'pit-hag']
assert len(pit_hag) == 1 and pit_hag[0]['otherNight'] in (1390, 2900), 'Pit-Hag night-order patch target changed'
pit_hag[0]['otherNight'] = 2900
editions = []
for tab in [1, 2, 3]:
    first = api('/ct/grimoire_edition_list/', {'tab': tab, 'name': '', 'order': 1, 'page': 1, 'limit': 50}, f'editions-{tab}-1')
    editions.extend(dict(item, _tab=tab) for item in first['data']['items'])
    for page in range(2, int(first['data']['page_total']) + 1):
        response = api('/ct/grimoire_edition_list/', {'tab': tab, 'name': '', 'order': 1, 'page': page, 'limit': 50}, f'editions-{tab}-{page}')
        editions.extend(dict(item, _tab=tab) for item in response['data']['items'])
    assert sum(item['_tab'] == tab for item in editions) == first['data']['total'], 'incomplete catalog'

if ARGS.refresh and not ARGS.offline:
    resources.clear()
capture_batch([PAGE])
html = (RAW / resources[PAGE]['sha256']).read_text()
initial = asset_urls(html, PAGE, 'html')
initial.update(asset_urls(json.dumps(roles_response, ensure_ascii=False), ORIGIN, 'json'))
initial.update(asset_urls(json.dumps(editions, ensure_ascii=False), ORIGIN, 'json'))
capture_batch(initial)

# Discover nested JSON artwork, CSS fonts, webpack image modules, and linked script JSON.
processed = set()
while True:
    pending = set()
    for url, item in list(resources.items()):
        if url in processed:
            continue
        processed.add(url)
        kind = kind_for(url, item)
        if kind:
            text = (RAW / item['sha256']).read_text(errors='replace')
            pending.update(asset_urls(text, url, kind))
            if kind == 'json':
                try:
                    obj = json.loads(text)
                    # Manifest icon paths are relative to the manifest.
                    if isinstance(obj, dict) and 'icons' in obj:
                        pending.update(urllib.parse.urljoin(url, i['src']) for i in obj['icons'])
                        pending.update(urllib.parse.urljoin(url, i['src'].lstrip('/')) for i in obj['icons'])
                except (ValueError, TypeError, KeyError):
                    pass
    pending -= set(resources)
    pending -= set(failures)
    if not pending:
        break
    capture_batch(pending)

# Runtime-generated token URLs don't appear as complete URLs in the bundle.
icon_ids = {'custom', 'plus1', 'x', 'good', 'outsider', 'minion', 'evil', 'fabled'}
all_roles = roles_response['data']['role'] + roles_response['data']['fabled']
for role in all_roles:
    icon_ids.add(role.get('imageAlt') or role['id'])
dynamic = {'https://oss.gstonegames.com/data_file/clocktower/web/icons/' + rid + '.png' for rid in icon_ids}
dynamic.update('https://oss.gstonegames.com/data_file/clocktower/web/editions/' + edition + '.png' for edition in ['tb', 'bmr', 'snv', 'custom', 'exp', 'syyl', 'hdcs'])
capture_batch(dynamic)

# The source site itself contains dead image links. Preserve a separate issue
# record and make each local reference resolve, without silently inventing art.
all_content_roles = list(all_roles)
for url, item in list(resources.items()):
    if url.endswith('.json'):
        try:
            content = json.loads((RAW / item['sha256']).read_text())
            if isinstance(content, list):
                all_content_roles.extend(r for r in content if isinstance(r, dict) and r.get('id') != '_meta')
        except (ValueError, UnicodeError):
            pass
by_name = {}
for role in all_content_roles:
    if role.get('image') in resources:
        by_name.setdefault(role.get('name'), role['image'])
def png_chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
transparent = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + png_chunk(b'IDAT', zlib.compress(b'\x00\x00\x00\x00\x00')) + png_chunk(b'IEND', b'')
for url, error in list(failures.items()):
    if urllib.parse.urlsplit(url).hostname == 'hm.baidu.com':
        failures.pop(url)
        continue
    target = None
    issue_type = 'source-missing-placeholder'
    if '/android-icon-' in url and url.startswith(ORIGIN):
        candidate = PAGE + 'static/' + url.rsplit('/', 1)[1]
        if candidate in resources:
            target = candidate
            issue_type = 'manifest-path-repair'
    elif url.startswith(ORIGIN + '/static/'):
        candidate = PAGE + url.removeprefix(ORIGIN + '/')
        if candidate in resources:
            target = candidate
            issue_type = 'manifest-path-repair'
    elif '/web/icons/' in url:
        rid = url.rsplit('/', 1)[1].removesuffix('.png')
        for role in all_content_roles:
            if role.get('image') == url or str(role.get('id', '')).lower() == rid.lower():
                candidate = role.get('image') if role.get('image') in resources else by_name.get(role.get('name'))
                if candidate:
                    target = candidate
                    break
        if target:
            issue_type = 'existing-role-image-alias'
    elif '/web/editions/' in url:
        pass
    else:
        continue
    if target:
        replacement = dict(resources[target])
        replacement.update({'path': local_url(url), 'aliasOf': target})
    else:
        replacement = {'path': local_url(url), 'sha256': save_raw(transparent), 'bytes': len(transparent), 'contentType': 'image/png', 'placeholder': True}
    source_issues[url] = {'error': error, 'resolution': issue_type, **({'replacement': target} if target else {})}
    resources[url] = replacement
    failures.pop(url)

# Reconcile legacy manifest aliases once the correct relative icons are captured.
for url, issue in source_issues.items():
    if url.startswith(ORIGIN + '/android-icon-'):
        target = PAGE + 'static/' + url.rsplit('/', 1)[1]
        if target in resources:
            resources[url] = dict(resources[target], path=local_url(url), aliasOf=target)
            issue.update(resolution='manifest-path-repair', replacement=target)
    elif '/web/editions/' in url:
        name = {'hdcs': '华灯初上', 'syyl': '山雨欲来'}.get(url.rsplit('/', 1)[1].removesuffix('.png'))
        target = next((edition.get('image') for edition in editions if name and name in edition['name']), None)
        if target in resources:
            resources[url] = dict(resources[target], path=local_url(url), aliasOf=target)
            issue.update(resolution='existing-edition-image-alias', replacement=target)
for item in resources.values():
    if item.get('placeholder'):
        item.update(sha256=save_raw(transparent), bytes=len(transparent))

# APFS/Windows are usually case insensitive. Broken uppercase links have working
# lowercase equivalents; use that exact artwork and one canonical local path.
for url, item in list(resources.items()):
    lower = url.lower()
    if lower != url and lower in resources and ('aliasOf' in item or item.get('placeholder')):
        preferred = resources[lower]
        resources[url] = dict(preferred, aliasOf=lower)
        if url in source_issues:
            source_issues[url].update(resolution='existing-role-image-alias', replacement=lower)

def rewrite(text, base=None, kind=None):
    for url in sorted(resources, key=len, reverse=True):
        if url == PAGE:
            continue
        text = text.replace(url, resources[url]['path'])
    # The fallback token path is assembled at runtime.
    text = text.replace('https://oss.gstonegames.com/', '/assets/oss.gstonegames.com/')
    if base and kind == 'css':
        def replace_css(m):
            ref = m.group(1)
            target = urllib.parse.urljoin(base, ref)
            return 'url("' + resources[target]['path'] + '")' if target in resources else m.group(0)
        text = re.sub(r'url\([\"\x27]?([^\s\"\x27)]+)[\"\x27]?\)', replace_css, text)
    return text

print('Building local frontend', flush=True)
for url, item in resources.items():
    if url == PAGE:
        continue
    source = RAW / item['sha256']
    destination = PUBLIC / item['path'].lstrip('/')
    destination.parent.mkdir(parents=True, exist_ok=True)
    kind = kind_for(url, item)
    if kind in ('js', 'css', 'json'):
        text = rewrite(source.read_text(errors='replace'), url, kind)
        if kind == 'css' and '/grimoire/css/app.' in url:
            from session_patch import patch_session_css
            text = patch_session_css(text)
        # Also correct the bundled fallback catalog and full role definitions
        # in preset scripts, preserving their original formatting. Scripts
        # using a different night-order scale (e.g. 17) are left as authored.
        if kind in ('js', 'json'):
            night_order = r'("id"\s*:\s*"pit-hag"[^{}]*?"otherNight"\s*:\s*)1390(?=\s*[,}])'
            if kind == 'json':
                entries = json.loads(text)
                expected = sum(isinstance(role, dict) and role.get('id') == 'pit-hag' and role.get('otherNight') == 1390 for role in entries) if isinstance(entries, list) else 0
                text, changed = re.subn(night_order, lambda match: match[1] + '2900', text)
                assert changed == expected, 'Preset Pit-Hag night-order patch target changed: ' + url
            elif '/grimoire/js/app.' in url:
                assert len(re.findall(night_order.replace('1390', '(?:1390|2900)'), text)) == 1, 'Bundled Pit-Hag night-order patch target changed'
                text = re.sub(night_order, lambda match: match[1] + '2900', text)
        if kind == 'json' and url.endswith('/manifest.json'):
            web_manifest = json.loads(source.read_text())
            for icon in web_manifest.get('icons', []):
                target = urllib.parse.urljoin(url, icon['src'])
                if target in resources:
                    icon['src'] = resources[target]['path']
            web_manifest.update(start_url='/', scope='/')
            text = json.dumps(web_manifest, ensure_ascii=False, indent=2)
        if kind == 'js' and '/grimoire/js/app.' in url:
            old = 'this._wss="wss://clocktower.gstonegames.com:8081/"'
            assert text.count(old) == 1, 'WebSocket patch target changed'
            text = text.replace(old, 'this._wss=(location.protocol==="https:"?"wss://":"ws://")+location.host+"/ws/"')
            old = 'fe="https://clocktower.gstonegames.com"'
            assert text.count(old) == 1, 'API patch target changed'
            text = text.replace(old, 'fe=location.origin')
            # Original public traveler updates lack `extra`; guard the optional
            # demon-bluff payload so changing a traveler doesn't throw.
            text = text.replace('s.bluffs&&s.bluffs.forEach', 's&&s.bluffs&&s.bluffs.forEach')
            text = text.replace('this._handlePing([!0,t,0])', 'this._handlePing([t,0])')
            # Initialization runs once from cached data, then again after the
            # role API returns. Keep one socket and ignore late events from the
            # old connection when a browser refresh or room switch replaces it.
            anchor = 'connect(e){this._store.state.session.playerId||'
            assert text.count(anchor) == 1, 'Idempotent connect patch target changed'
            guard = 'connect(e){if(this._currentChannel===e&&this._socket&&this._socket.readyState<2&&this._isSpectator===this._store.state.session.isSpectator)return;this._store.state.session.playerId||'
            text = text.replace(anchor, guard)
            start = text.index('_open(e){', text.index('class Ct{'))
            end = text.index('_send(e,t){', start)
            local_open = '''_open(e){
this.disconnect();
const socket=new WebSocket(this._wss+e+"/"+(this._isSpectator?this._store.state.session.playerId:"host"));
this._socket=socket;this._currentChannel=e;
socket.addEventListener("message",event=>{if(this._socket===socket)this._handleMessage(event)});
socket.onopen=()=>{if(this._socket===socket)this._onOpen()};
socket.onclose=event=>{
if(this._socket!==socket)return;
this._socket=null;this._currentChannel=null;clearTimeout(this._pingTimer);this._pingTimer=null;
if(event.reason==="local-session-replaced"){this._store.state.session.sessionId="";this._store.state.session.isReconnecting=false;return}
if(event.code!==1000){this._store.commit("session/setReconnecting",true);this._reconnectTimer=setTimeout(()=>this.connect(e),3000)}
else{this._store.commit("session/setSessionId","");if(event.reason)St.alert(event.reason)}
}
}'''
            text = text[:start] + local_open + text[end:]
            # The captured bundle includes its state JSON dialog but no route
            # to open it. Expose it in Settings to support local state migration.
            anchor = 's("li",{on:{click:function(t){return t.stopPropagation(),e.seeGuide(t)}}}'
            assert text.count(anchor) == 1, 'Backup menu patch target changed'
            button = 's("li",{on:{click:function(t){return t.stopPropagation(),e.$store.commit("toggleModal","gameState")}}},[e._v(" 备份／载入状态 "),s("em",[e._v("[B]")])]),'
            text = text.replace(anchor, button + anchor)
            # Remove the whole promotional tab; keep the encyclopedia beside
            # the tutorial in Settings. Patch the original render function so
            # there is no hidden tab or flash of the old navigation.
            tab = 's("div",{staticClass:"svg fa-broadcast-tower",on:{click:function(t){t.stopPropagation(),e.tab="session"}}},[s("img",{attrs:{src:i("74e6"),alt:""}})]),'
            assert text.count(tab) == 1, 'Promotional tab patch target changed'
            text = text.replace(tab, '')
            start = text.index('"session"===e.tab?[')
            end = text.index('"players"!==e.tab', start)
            text = text[:start] + text[end:]
            tutorial = '[e._v(" 教程 ")])'
            assert text.count(tutorial) == 1, 'Settings wiki patch target changed'
            text = text.replace(tutorial, tutorial + ',e._m(0)')
            text = text.replace('https://clocktower-wiki.gstonegames.com/', '/wiki')
            text = text.replace('https://clocktower.gstonegames.com/guide/?type=2&bIsWM=', '/guide?type=2&bIsWM=')
            # Keep the welcome panel free of the voice-service recommendation
            # and the two promotional logos, including their empty container.
            recommendation = 'e._v(" 线上语音平台推荐使用 "),i("a",{staticStyle:{color:"#1F65FF"},attrs:{href:"https://meeting.tencent.com/marketplace/support-collect-detail?sdk_id=19800120650"}},[e._v("腾讯会议应用")]),i("br"),'
            assert text.count(recommendation) == 1, 'Voice recommendation patch target changed'
            text = text.replace(recommendation, '')
            logos = ',e.players.length?e._e():i("div",{attrs:{id:"version"}},[e._m(1),e._m(2)])'
            assert text.count(logos) == 1, 'Welcome logos patch target changed'
            text = text.replace(logos, '')
            anchor = 'case"escape":this.$store.commit("toggleModal")'
            position = text.rfind(anchor)
            assert position >= 0, 'Backup shortcut patch target changed'
            text = text[:position] + 'case"b":this.$store.commit("toggleModal","gameState");break;' + text[position:]
            from session_patch import patch_session
            text = patch_session(text)
            # webpack image modules remain relative to /grimoire/.
            for ref in re.findall(r'\w\.p\+"([^"\s]+)"', text):
                target = urllib.parse.urljoin(PAGE, ref)
                if target in resources:
                    text = text.replace('+"' + ref + '"', '+"' + resources[target]['path'] + '"')
            for ref in re.findall(r'[\"\x27]((?:\.?/?(?:static|img|fonts|sounds)/)[^\"\x27]+)[\"\x27]', text):
                target = urllib.parse.urljoin(PAGE, ref)
                if target in resources:
                    text = text.replace('"' + ref + '"', '"' + resources[target]['path'] + '"')
        if destination.exists():
            destination.unlink()
        destination.write_text(text)
    else:
        if destination.exists():
            destination.unlink()
        shutil.copyfile(source, destination)
    item['localSha256'] = digest(destination.read_bytes())

html = re.sub(r'<script>var _hmt[\s\S]*?</script>', '', html)
html = rewrite(html)
for ref in re.findall(r'(?:href|src|content)="([^\"]+)"', html):
    target = urllib.parse.urljoin(PAGE, ref)
    if target in resources and target != PAGE:
        html = html.replace('"' + ref + '"', '"' + resources[target]['path'] + '"')
for item in resources.values():
    if item.get('localSha256') and ('javascript' in item['contentType'] or 'css' in item['contentType']):
        html = html.replace('"' + item['path'] + '"', '"' + item['path'] + '?v=' + item['localSha256'][:12] + '"')
html = html.replace('</head>', '<script src="/local-runtime.js"></script><script src="/local-session.js"></script></head>')
(PUBLIC / 'index.html').write_text(html)
legacy_page = PUBLIC / 'grimoire' / 'index.html'
if legacy_page.exists():
    legacy_page.unlink()
(DATA / 'roles.json').write_text(rewrite(json.dumps(roles_response, ensure_ascii=False, indent=2)) + '\n')
(DATA / 'editions.json').write_text(rewrite(json.dumps(editions, ensure_ascii=False, indent=2)) + '\n')
manifest.update({
    'capturedAt': manifest.get('capturedAt') if ARGS.offline else datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'source': PAGE,
    'upstreamCommit': '1eb085b7825c5f40073c1961ac301e7c07af5071',
    'counts': {'roles': len(roles_response['data']['role']), 'fabled': len(roles_response['data']['fabled']), 'editions': len(editions), 'resources': len(resources)},
    'failures': failures,
    'sourceIssues': source_issues,
    'generated': {
        path: {'sha256': digest((ROOT / path).read_bytes()), 'bytes': (ROOT / path).stat().st_size}
        for path in ['public/index.html', 'public/local-runtime.js', 'public/local-session.js', 'data/roles.json', 'data/editions.json']
    }
})
MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'counts': manifest['counts'], 'failures': failures, 'sourceIssues': len(source_issues)}, ensure_ascii=False, indent=2), flush=True)
if failures:
    raise SystemExit('Snapshot has missing resources; inspect snapshot/manifest.json')
