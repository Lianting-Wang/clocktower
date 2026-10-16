import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attachRooms } from './rooms.js';
import { createWiki } from './wiki.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject' };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

export function createApp({ stateDir = process.env.STATE_DIR || resolve(root, '.state'), allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean), offlineOnly = process.env.OFFLINE_ONLY === '1', now } = {}) {
  const roles = JSON.parse(readFileSync(resolve(root, 'data/roles.json')));
  const editions = JSON.parse(readFileSync(resolve(root, 'data/editions.json')));
  const manifest = JSON.parse(readFileSync(resolve(root, 'snapshot/manifest.json')));
  const publicDir = resolve(root, 'public');
  const wiki = createWiki(root);
  const assetPaths = new Map(Object.values(manifest.resources).map(item => [item.path.toLowerCase(), item.path]));
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:${offlineOnly ? '' : ' https: http:'}; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'${offlineOnly ? ` ws://${req.headers.host} wss://${req.headers.host}` : ' https: http: ws: wss:'}; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return json(res, 200, { status: 'ok', snapshot: manifest.capturedAt, counts: manifest.counts, rooms: sessions.rooms.size });
      if (url.pathname === '/grimoire' || url.pathname === '/grimoire/') { res.writeHead(302, { Location: '/' + url.search + url.hash }); res.end(); return; }
      // Encyclopedia resources always stay same-origin, including dynamically
      // requested MediaWiki modules. Inline source scripts are allowed only on
      // this read-only mirror; the grimoire retains its stricter script policy.
      if (url.pathname === '/wiki' || url.pathname.startsWith('/wiki/')) {
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
        if (wiki.handle(req, res, url)) return;
      }
      if (req.method === 'POST' && ['/ct/grimoireRoleJson/', '/ct/grimoire_edition_list/'].includes(url.pathname)) {
        let body = '', bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) { json(res, 413, { error: '请求过大' }); return; } body += chunk; }
        let query;
        try { query = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: '无效 JSON' }); }
        if (!query || typeof query !== 'object' || Array.isArray(query)) return json(res, 400, { error: '无效查询' });
        if (url.pathname.endsWith('grimoireRoleJson/')) return json(res, 200, roles);
        const tab = Number(query.tab || 1), page = Math.max(1, Number.parseInt(query.page, 10) || 1), limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 10));
        const name = typeof query.name === 'string' ? query.name.toLocaleLowerCase() : '';
        const items = editions.filter(item => item._tab === tab && item.name.toLocaleLowerCase().includes(name));
        return json(res, 200, { status: 200, cache_flag: 0, reason: '成功', data: { page_total: Math.ceil(items.length / limit), items: items.slice((page - 1) * limit, page * limit).map(({ _tab, ...item }) => item), total: items.length, current_page: page } });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '不支持的方法' });
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: '无效路径' }); }
      if (pathname.includes('\0') || pathname.includes('\\')) return json(res, 400, { error: '无效路径' });
      if (pathname === '/guide' || pathname === '/guide/') pathname = '/guide/index.html';
      pathname = assetPaths.get(pathname.toLowerCase()) || pathname;
      const path = resolve(publicDir, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
      if (!path.startsWith(publicDir + sep) || !existsSync(path) || !statSync(path).isFile()) return json(res, 404, { error: '未找到资源' });
      const stat = statSync(path);
      const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'no-cache');
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
      res.setHeader('Accept-Ranges', 'bytes');
      let start = 0, end = stat.size - 1, status = 200;
      if (req.method === 'GET' && req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        const invalid = () => { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Length': '0' }); res.end(); };
        if (!range || (!range[1] && !range[2])) { invalid(); return; }
        if (range[1]) {
          start = Number(range[1]);
          if (range[2]) end = Math.min(end, Number(range[2]));
        } else start = Math.max(0, stat.size - Number(range[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= stat.size || end < start) { invalid(); return; }
        status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      res.setHeader('Content-Type', wiki.contentType(pathname) || types[extname(path).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', status === 206 ? end - start + 1 : stat.size);
      res.writeHead(status);
      if (req.method === 'HEAD' || !stat.size) res.end();
      else createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: '服务暂时不可用' });
      else res.destroy();
      console.error('HTTP request failed:', error.message);
    }
  });
  const sessions = attachRooms(server, { roles: roles.data.role, stateDir, allowedOrigins, now });
  return { server, sessions, close: async () => { await sessions.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp();
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1';
  app.server.listen(port, host, () => console.log(`Clocktower Local: http://${host === '0.0.0.0' ? 'localhost' : host}:${app.server.address().port}/`));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
