#!/usr/bin/env python3
"""Snapshot the public tutorial and read-only MediaWiki, retaining original bytes.

No runtime proxy: all HTML, skin modules, fonts and images are served locally.
--offline rebuilds exclusively from the captured manifest and raw files.
"""
import argparse
import concurrent.futures
import datetime
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
import urllib.parse as U
import urllib.request as R

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'snapshot/files'
PUBLIC = ROOT / 'public'
MANIFEST = ROOT / 'snapshot/content-manifest.json'
WIKI = 'https://clocktower-wiki.gstonegames.com'
GUIDE = 'https://clocktower.gstonegames.com/guide/'
args = argparse.ArgumentParser()
args.add_argument('--offline', action='store_true')
args.add_argument('--refresh', action='store_true')
ARGS = args.parse_args()
manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
resources = manifest.get('resources', {}) if not ARGS.refresh else {}
invalid = {u: r for u, r in resources.items() if '\\' in u or '%5C' in U.urlsplit(u).path.upper() or ('text/html' in r['contentType'] and '/index.php?' not in u and u != GUIDE)}
resources = {u: r for u, r in resources.items() if u not in invalid}
pages = manifest.get('pages', {}) if not ARGS.refresh else {}
failures = {}
source_issues = manifest.get('sourceIssues', {}) if not ARGS.refresh else {}
sha = lambda b: hashlib.sha256(b).hexdigest()


def checkpoint():
    manifest.update(resources=dict(resources), pages=pages, failures=failures, sourceIssues=source_issues)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')


def canonical(url):
    p = U.urlsplit(html.unescape(url))
    return U.urlunsplit((p.scheme, p.netloc, U.quote(U.unquote(p.path), safe='/:@!$&\'()*+,;=-._~'), p.query, ''))


def get(url):
    url = canonical(url)
    if url in resources:
        return resources[url]
    if ARGS.offline:
        raise RuntimeError('Not captured: ' + url)
    for attempt in range(3):
        try:
            with R.urlopen(R.Request(url, headers={'User-Agent': 'ClocktowerLocalSnapshot/1.0 (personal offline mirror)', 'Accept-Encoding': 'identity'}), timeout=50) as response:
                body = response.read()
                content_type = response.headers.get('Content-Type', 'application/octet-stream')
            if 'text/html' in content_type and '/index.php?' not in url and url != GUIDE:
                name = U.urlsplit(url).path.rsplit('/', 1)[1]
                if url.startswith(WIKI + '/w/resources/') and name in ('spinner.gif', 'ajax-loader.gif', 'magnify-clip-ltr.png'):
                    original = sha(body)
                    (RAW / original).write_bytes(body)
                    version = 'REL1_31' if name.endswith('.png') else 'REL1_37'
                    target = 'https://raw.githubusercontent.com/wikimedia/mediawiki/' + version + '/resources/src/mediawiki.skinning/images/' + name
                    item = dict(get(target), aliasOf=target)
                    resources[url] = item
                    source_issues[url] = {'resolution': 'missing-core-image-from-official-mediawiki', 'source': target, 'error': 'Source returned homepage HTML instead of an image', 'originalResponseSha256': original}
                    return item
                raise RuntimeError('Source returned HTML for a static resource: ' + url)
            digest = sha(body)
            (RAW / digest).write_bytes(body)
            path = U.unquote(U.urlsplit(url).path)
            query = U.urlsplit(url).query
            if url.startswith(WIKI):
                path = '/wiki' + path
            elif url.startswith(GUIDE):
                path = '/guide/' + path.removeprefix('/guide/')
            else:
                path = '/assets/content/' + U.urlsplit(url).netloc + path
            if query:
                suffix = '.js' if 'javascript' in content_type else '.css' if 'text/css' in content_type else '.json' if 'json' in content_type else '.html'
                path = '/wiki/cache/' + sha(url.encode())[:24] + suffix
            if path.endswith('/'):
                path += 'index.html'
            item = {'sha256': digest, 'bytes': len(body), 'contentType': content_type, 'path': path}
            resources[url] = item
            return item
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def batch(urls):
    todo = sorted({canonical(u) for u in urls} - resources.keys())
    if not todo:
        return
    if ARGS.offline:
        raise RuntimeError('Missing offline resources: ' + str(todo[:10]))
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futures = {pool.submit(get, url): url for url in todo}
        for number, future in enumerate(concurrent.futures.as_completed(futures), 1):
            url = futures[future]
            try:
                future.result()
                failures.pop(url, None)
            except Exception as error:
                failures[url] = str(error)
            if number % 40 == 0 or number == len(todo):
                print(f'Captured {number}/{len(todo)}; total {len(resources)}; failures {len(failures)}', flush=True)
                checkpoint()


def source(url):
    return (RAW / get(url)['sha256']).read_text(errors='replace')


def extracted_resource(url, body, path, content_type, parent, reason):
    """Keep a traceable original inline asset when an obsolete fallback fails."""
    url = canonical(url)
    digest = sha(body)
    previous = resources.get(url, {})
    if previous.get('sha256') == digest and previous.get('derivedFrom'):
        parent = min(parent, previous['derivedFrom'])
    (RAW / digest).write_bytes(body)
    resources[url] = {'sha256': digest, 'bytes': len(body), 'contentType': content_type, 'path': path, 'derivedFrom': parent}
    source_issues[url] = {'resolution': reason, 'source': parent}


def api(**params):
    return json.loads(source(WIKI + '/api.php?' + U.urlencode({'format': 'json', **params})))


def list_all(kind, **params):
    items, continuation = [], {}
    while True:
        result = api(action='query', list=kind, **params, **continuation)
        items.extend(result['query'][kind])
        if 'continue' not in result:
            return items
        continuation = result['continue']


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = set()
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for key in ('src', 'poster'):
            if a.get(key):
                self.assets.add(a[key])
        if tag == 'link' and a.get('rel') in ('stylesheet', 'icon', 'shortcut icon', 'apple-touch-icon', 'manifest'):
            self.assets.add(a.get('href', ''))
        for part in a.get('srcset', '').split(','):
            if part.strip():
                self.assets.add(part.strip().split()[0])
        self.assets.update(re.findall(r'url\([\"\x27]?([^\s\"\x27)]+)', a.get('style', '')))


def find_assets(text, base, kind):
    refs = set()
    # ResourceLoader embeds CSS in JSON strings. Decode quote/slash escaping
    # for reference discovery without changing executable source bytes.
    text = re.sub(r'\\+([\"\x27/])', r'\1', text)
    text = re.sub(r'\\+u0026', '&', text)
    # MediaWiki ships an SVG plus an obsolete PNG fallback in the same rule.
    # The source's rasterized endpoint returns 403. Extract the exact active
    # inline SVG, preserving its artwork rather than synthesizing an icon.
    for match in re.finditer(r'url\(([\"\x27]?)([^\"\x27()]*format=rasterized[^\"\x27()]*)\1\)', text):
        end = text.find('}', match.end())
        rule = text[match.end():end if end >= 0 else len(text)]
        svg = re.search(r'url\(([\"\x27])(data:image/svg\+xml,[^\"\x27]+)\1\)', rule)
        if svg:
            target = canonical(U.urljoin(base, match[2]))
            extracted_resource(target, U.unquote_to_bytes(svg[2].split(',', 1)[1]), '/wiki/fallbacks/' + sha(target.encode())[:24] + '.svg', 'image/svg+xml', base, 'original-inline-svg-for-legacy-raster-fallback')
    if base.endswith('.webmanifest'):
        refs.update(icon['src'] for icon in json.loads(text).get('icons', []))
    if kind == 'html':
        parser = References()
        parser.feed(text)
        refs |= parser.assets
    refs.update(re.findall(r'url\([\"\x27]?([^\s\"\x27)]+)', text))
    refs.update(re.findall(r'[\"\x27]((?:\./|/)?(?:images|resources|skins)/[^\"\x27<>\s]+\.(?:png|jpg|jpeg|gif|svg|woff2?|ttf|eot|css|webmanifest))', text))
    result = set()
    for ref in refs:
        if ref.startswith(('data:', '#', '+')) or '\\' in ref:
            continue
        url = canonical(U.urljoin(base, ref.replace('\\/', '/')))
        if url.startswith(WIKI + '/') or url.startswith(GUIDE):
            result.add(url)
        elif url.startswith(('https:', 'http:')) and 'hm.baidu.com/' not in url:
            result.add(url)
    return result


print('Reading public wiki directory', flush=True)
site = api(action='query', meta='siteinfo', siprop='general|namespaces|statistics')
if 'directory' not in manifest or ARGS.refresh:
    directory = []
    for ns in site['query']['namespaces'].values():
        if ns['id'] >= 0:
            directory += list_all('allpages', apnamespace=ns['id'], aplimit='max')
    manifest['directory'] = directory
    manifest['images'] = list_all('allimages', ailimit='max')
else:
    directory = manifest['directory']
print(f'{len(directory)} wiki pages, {len(manifest["images"])} original uploads', flush=True)
for page in directory:
    title = page['title']
    pages[title] = {**page, 'url': WIKI + '/index.php?' + U.urlencode({'title': title})}
# Preserve the original special-page shell and useful read-only navigation.
pages.pop('特殊:分类页面', None)  # Not an available special-page alias upstream.
for title in ['特殊:搜索', '特殊:最近更改', '特殊:所有页面', '特殊:特殊页面', '特殊:用户登录']:
    pages.setdefault(title, {'title': title, 'ns': -1, 'url': WIKI + '/index.php?' + U.urlencode({'title': title})})
pages['特殊:搜索']['url'] = WIKI + '/index.php?' + U.urlencode({'title': '特殊:搜索', 'search': 'CLOCKTOWER_LOCAL_SEARCH', 'fulltext': 1})
# The tutorial currently links to a nonexistent webmanifest (verified 404).
# Repair that invisible metadata using its own captured touch icon.
manifest_url = GUIDE + 'images/site.webmanifest'
if canonical(manifest_url) not in resources:
    try:
        get(manifest_url)
    except Exception as error:
        if getattr(error, 'code', None) != 404:
            raise
        body = json.dumps({'name': '染钟楼谜团教程', 'short_name': '钟楼教程', 'icons': [{'src': 'apple-touch-icon.png', 'sizes': '180x180', 'type': 'image/png'}], 'display': 'standalone'}, ensure_ascii=False).encode()
        extracted_resource(manifest_url, body, '/guide/images/site.webmanifest', 'application/manifest+json', GUIDE, 'source-webmanifest-404-repaired-with-original-icon')
batch([GUIDE, *[p['url'] for p in pages.values()], *[i['url'] for i in manifest['images']]])
checkpoint()

# Discover every page's styles and page modules, then capture ResourceLoader's
# complete dependency closure as independent original module responses. The
# local /wiki/load.php endpoint can combine any requested grouping offline.
startup_url = WIKI + '/load.php?lang=zh-cn&modules=startup&only=scripts&raw=1&skin=pivot'
startup = source(startup_url)
registered = json.JSONDecoder().raw_decode(startup.split('mw.loader.register(', 1)[1])[0]
registry = {item[0]: item for item in registered}
modules = {'jquery', 'mediawiki.base', 'mediawiki.searchSuggest', 'mediawiki.toc', 'mediawiki.page.ready', 'skins.pivot.js', 'jquery.makeCollapsible', 'jquery.tablesorter'}
queue = set()
for page in pages.values():
    if canonical(page['url']) not in resources:
        continue
    text = source(page['url'])
    queue |= find_assets(text, page['url'], 'html')
    match = re.search(r'RLPAGEMODULES=(\[[^;]*\])', text)
    if match:
        modules.update(json.loads(match.group(1)))
while True:
    dependencies = set()
    for name in modules:
        item = registry.get(name, [])
        for dep in (item[2] if len(item) > 2 else []):
            dependencies.add(registered[dep][0] if isinstance(dep, int) else dep)
    if dependencies <= modules:
        break
    modules |= dependencies
manifest['modules'] = {}
for name in sorted(modules):
    if name in ('user', 'user.styles', 'user.options', 'noscript'):
        continue
    url = WIKI + '/load.php?' + U.urlencode({'lang': 'zh-cn', 'modules': name, 'skin': 'pivot'})
    manifest['modules'][name] = canonical(url)
    queue.add(url)
queue |= find_assets(source(GUIDE), GUIDE, 'html')
seen = set()
while queue - seen:
    current = queue - seen
    seen |= current
    batch(current)
    queue = set()
    for url in current:
        if url not in resources:
            continue
        item = resources[url]
        if any(k in item['contentType'] for k in ('text/', 'javascript', 'json', 'manifest')):
            queue |= find_assets(source(url), url, 'text')
checkpoint()
if failures:
    raise SystemExit('Missing content resources: ' + json.dumps(failures, ensure_ascii=False))


def map_ref(ref, base):
    if ref.startswith(('data:', '#', 'javascript:', 'mailto:', 'tel:')):
        return ref
    target = canonical(U.urljoin(base, re.sub(r'\\+u0026', '&', html.unescape(ref))))
    fragment = U.urlsplit(html.unescape(ref)).fragment
    if target.startswith(WIKI + '/index.php'):
        return '/wiki' + target[len(WIKI):] + ('#' + fragment if fragment else '')
    if target in resources:
        return resources[target]['path'] + ('#' + fragment if fragment else '')
    if target.startswith(WIKI + '/'):
        return '/wiki' + target[len(WIKI):] + ('#' + fragment if fragment else '')
    if target in ('https://clocktower.gstonegames.com/', 'http://clocktower.gstonegames.com/') or re.match(r'https?://clocktower\.gstonegames\.com/grimoire(?:/|\?|$)', target):
        return '/'
    if target.startswith(GUIDE):
        return '/guide' + target[len(GUIDE)-1:]
    return ref


def rewrite(text, base, kind):
    # Remove only the statistics script, retaining the source skin and behavior.
    if base.startswith(WIKI):
        text = re.sub(r'<script[^>]*>[^<]*?var _hmt[\s\S]*?</script>', '', text)
    if kind == 'html':
        if base.startswith(WIKI):
            # Remove the entire shared footer: publisher logos, social icons
            # and their hover QR codes. Leave the surrounding skin intact.
            start_anchor = '<div class="footer-logo">'
            end_anchor = '<!--<div class="footer-lace">'
            assert text.count(start_anchor) == text.count(end_anchor) == 1, 'Wiki promotional footer patch target changed'
            start = text.index(start_anchor)
            end = text.index(end_anchor, start)
            text = text[:start].rstrip(' \t') + text[end:]
        def attribute(m):
            return m[1] + m[2] + html.escape(map_ref(m[3], base), quote=True) + m[2]
        text = re.sub(r'((?:href|src|action|poster)\s*=\s*)([\"\x27])(.*?)(?:\2)', attribute, text)
        text = re.sub(r'(srcset=)([\"\x27])(.*?)(?:\2)', lambda m: m[1]+m[2]+', '.join(map_ref(p.strip().split()[0], base)+' '+ ' '.join(p.strip().split()[1:]) for p in m[3].split(','))+m[2], text)
    # CSS URLs also occur inside ResourceLoader module JavaScript strings.
    text = re.sub(r'url\(([\"\x27]?)([^\s\"\x27)]+)\1\)', lambda m: 'url('+m[1]+map_ref(m[2], base)+m[1]+')', text)
    if base.startswith(GUIDE):
        if base.endswith('.webmanifest'):
            web_manifest = json.loads(text)
            for icon in web_manifest.get('icons', []):
                icon['src'] = map_ref(icon['src'], base)
            web_manifest.update(start_url='/guide', scope='/guide')
            return json.dumps(web_manifest, ensure_ascii=False)
        for ref in re.findall(r'[\"\x27](\./images/[^\"\x27]+)[\"\x27]', text):
            text = text.replace(ref, map_ref(ref, base))
        text = re.sub(r'\s*// 百度统计[\s\S]*?\}\)\(\);', '', text)
        text = text.replace('GetQueryString("type") || 0', 'GetQueryString("type") || 2')
    if base.startswith(WIKI):
        text = text.replace(WIKI, '')
        for key in ('wgScriptPath', 'wgResourceBasePath', 'wgExtensionAssetsPath'):
            text = text.replace('"'+key+'":""', '"'+key+'":"/wiki"')
        # Strings used to assemble dynamic ResourceLoader/API/image requests.
        for path in ('/load.php', '/api.php', '/index.php', '/rest.php', '/images', '/resources', '/skins', '/extensions'):
            text = re.sub(r'(?<=[\"\x27])' + re.escape(path) + r'(?=[/\"\x27?])', '/wiki'+path, text)
    return text


print('Building original tutorial and wiki skin', flush=True)
for url, item in resources.items():
    if '/api.php?' in url or '/index.php?' in url or url == canonical(GUIDE):
        continue
    destination = PUBLIC / item['path'].lstrip('/')
    destination.parent.mkdir(parents=True, exist_ok=True)
    body = (RAW / item['sha256']).read_bytes()
    if any(k in item['contentType'] for k in ('text/', 'javascript', 'json', 'manifest')):
        body = rewrite(body.decode(errors='replace'), url, 'text').encode()
    destination.write_bytes(body)
    item['localSha256'] = sha(body)

# Tutorial inline behavior is extracted so the main application can keep its
# strict CSP. Default /guide shows the grimoire tutorial, as does the menu link.
guide_html = rewrite(source(GUIDE), GUIDE, 'html')
guide_scripts = re.findall(r'<script[^>]*>([\s\S]*?)</script>', guide_html)
guide_html = re.sub(r'<script[^>]*>[\s\S]*?</script>', '', guide_html)
guide_html = guide_html.replace('</body>', '<script src="/guide/runtime.js"></script></body>')
(PUBLIC / 'guide').mkdir(exist_ok=True)
(PUBLIC / 'guide/index.html').write_text(guide_html)
(PUBLIC / 'guide/runtime.js').write_text('\n'.join(guide_scripts))

class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(); self.text = []; self.skip = 0
    def handle_starttag(self, tag, attrs):
        if tag in ('style', 'script'):
            self.skip += 1
    def handle_endtag(self, tag):
        if tag in ('style', 'script'):
            self.skip = max(0, self.skip - 1)
    def handle_data(self, text):
        if not self.skip:
            self.text.append(text)

index = {'pages': {}, 'modules': {name: resources[url]['path'] for name, url in manifest['modules'].items()}, 'resources': {item['path']: item['contentType'] for url, item in resources.items() if 'localSha256' in item}}
for title, page in pages.items():
    original = source(page['url'])
    body = rewrite(original, page['url'], 'html')
    filename = '/wiki/pages/' + sha(title.encode())[:24] + '.html'
    path = PUBLIC / filename.lstrip('/')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    parser = PlainText()
    content = re.search(r'<div[^>]*id="mw-content-text"[^>]*>([\s\S]*?)<div class="printfooter">', original)
    parser.feed(content[1] if content else original)
    text = ' '.join(' '.join(parser.text).split())
    index['pages'][title] = {'path': filename, 'pageid': page.get('pageid'), 'ns': page['ns'], 'text': text}
    page.update(path=filename, localSha256=sha(body.encode()))
index['capturedAt'] = manifest.get('capturedAt') if ARGS.offline else datetime.datetime.now(datetime.timezone.utc).isoformat()
(ROOT / 'data/wiki.json').write_text(json.dumps(index, ensure_ascii=False) + '\n')
manifest.update(capturedAt=index['capturedAt'], sources={'guide': GUIDE, 'wiki': WIKI}, counts={'pages': len(directory), 'articles': sum(p['ns'] == 0 for p in directory), 'uploads': len(manifest['images']), 'modules': len(index['modules']), 'resources': len(resources)})
manifest['generated'] = {name: {'sha256': sha((ROOT/name).read_bytes()), 'bytes': (ROOT/name).stat().st_size} for name in ['public/guide/index.html', 'public/guide/runtime.js', 'data/wiki.json']}
checkpoint()
print(json.dumps({'counts': manifest['counts'], 'failures': failures}, ensure_ascii=False, indent=2), flush=True)
