import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const normalize = value => String(value || '').normalize('NFC').replaceAll('_', ' ').trim();
const link = title => '/wiki/index.php?title=' + encodeURIComponent(title);
const expandModules = value => value.split('|').flatMap(group => {
  const dot = group.lastIndexOf('.');
  const prefix = dot < 0 ? '' : group.slice(0, dot + 1);
  const names = dot < 0 ? group : group.slice(dot + 1);
  return names.split(',').map(name => prefix + name);
});

export function createWiki(root) {
  const index = JSON.parse(readFileSync(resolve(root, 'data/wiki.json'), 'utf8'));
  const pages = new Map(Object.entries(index.pages));
  const ids = new Map([...pages].filter(([, p]) => p.pageid).map(([title, p]) => [String(p.pageid), title]));
  const read = path => readFileSync(resolve(root, 'public', '.' + path), 'utf8');
  const modules = new Map(Object.entries(index.modules).map(([name, path]) => [name, read(path)]));
  const html = title => read(pages.get(title).path);
  const json = (res, value) => send(res, 200, JSON.stringify(value), 'application/json; charset=utf-8');
  let head = false;
  function send(res, status, body, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
    res.end(head ? undefined : body);
    return true;
  }
  function search(query, profile = 'default') {
    const terms = normalize(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return [...pages].filter(([, p]) => profile === 'all' || profile === 'advanced' ? p.ns >= 0 : profile === 'images' ? p.ns === 6 : p.ns === 0)
      .map(([title, p]) => {
        const lower = title.toLocaleLowerCase(), text = p.text.toLocaleLowerCase();
        return { title, ...p, score: terms.every(term => lower.includes(term)) ? (lower === terms.join(' ') ? 100 : 50) : terms.every(term => text.includes(term)) ? 1 : 0 };
      }).filter(p => p.score).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'));
  }
  function resultsPage(query, params) {
    const profile = ['default', 'images', 'all', 'advanced'].includes(params.get('profile')) ? params.get('profile') : 'default';
    const matches = search(query, profile);
    const offset = Math.max(0, Number.parseInt(params.get('offset'), 10) || 0);
    const limit = 20;
    const term = normalize(query).toLocaleLowerCase();
    const results = matches.slice(offset, offset + limit).map(p => {
      const position = p.text.toLocaleLowerCase().indexOf(term);
      const snippet = p.text.slice(Math.max(0, position - 55), Math.max(0, position - 55) + 180);
      return `<li class="mw-search-result"><div class="mw-search-result-heading"><a href="${link(p.title)}" title="${escape(p.title)}">${escape(p.title)}</a></div><div class="searchresult">${escape(snippet)}</div><div class="mw-search-result-data">${p.text.length.toLocaleString('zh-CN')}字</div></li>`;
    }).join('');
    const pagination = [offset > 0 ? offset - limit : null, offset + limit < matches.length ? offset + limit : null].map((n, i) => {
      if (n === null) return '';
      const p = new URLSearchParams({ title: '特殊:搜索', search: query, fulltext: '1', profile, offset: String(n) });
      return `<a href="/wiki/index.php?${escape(p)}">${i ? '下一页' : '上一页'}</a>`;
    }).join('　');
    let body = html('特殊:搜索');
    const start = body.indexOf('<div class="searchresults">');
    const end = body.indexOf('<div class="printfooter">', start);
    if (start < 0 || end < 0) throw new Error('Wiki search template changed');
    const resultsBody = matches.length ? `<p class="mw-search-results-info">第 ${offset + 1} 至 ${Math.min(offset + limit, matches.length)} 条结果，共 ${matches.length} 条</p><ul class="mw-search-results">${results}</ul><p>${pagination}</p>` : '<p class="mw-search-nonefound">找不到和查询相匹配的结果。</p>';
    body = body.slice(0, start) + `<div class="searchresults">${resultsBody}<div class="mw-search-visualclear"></div></div></div>` + body.slice(end);
    // Retain the original input/profile controls, without embedding user text
    // in source JavaScript or OOUI configuration attributes.
    body = body.replaceAll('CLOCKTOWER_LOCAL_SEARCH', encodeURIComponent(query));
    body = body.replace(/(<li class=)(['"])(current|normal)\2(><a href=)(['"])([^'"]*)\5/g, (all, before, quote, oldClass, middle, hrefQuote, href) => {
      const selected = new URL(href.replaceAll('&amp;', '&'), 'http://localhost').searchParams.get('profile') === profile;
      return before + quote + (selected ? 'current' : 'normal') + quote + middle + hrefQuote + href + hrefQuote;
    });
    body = body.replace(/(<input\b[^>]*\bname=['"]search['"][^>]*\bvalue=)(['"])[\s\S]*?\2/g, (_, before, quote) => before + quote + escape(query) + quote);
    body = body.replace(/data-ooui=(['"])([\s\S]*?)\1/g, (attribute, quote, value) => {
      const decoded = value.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      try {
        const config = JSON.parse(decoded);
        if (config.name !== 'search') return attribute;
        config.value = query;
        return 'data-ooui=' + quote + escape(JSON.stringify(config)) + quote;
      } catch { return attribute; }
    });
    return body;
  }
  return {
    contentType: path => index.resources[path],
    handle(req, res, url) {
      head = req.method === 'HEAD';
      const path = url.pathname;
      if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, '百科为本地只读快照，不支持登录、编辑或提交。', 'text/plain; charset=utf-8');
      if (path === '/wiki/load.php') {
        const names = expandModules(url.searchParams.get('modules') || '');
        if (names.length > 100 || names.some(name => !modules.has(name))) return send(res, 404, '/* 未收录的百科模块 */', 'text/javascript; charset=utf-8');
        return send(res, 200, [...new Set(names)].map(name => modules.get(name)).join('\n'), 'text/javascript; charset=utf-8');
      }
      if (path === '/wiki/api.php') {
        const q = url.searchParams;
        if (q.get('action') === 'opensearch') {
          const query = normalize(q.get('search'));
          const titles = search(query).filter(p => p.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, Math.min(50, Number(q.get('limit')) || 10));
          return json(res, [query, titles.map(p => p.title), titles.map(() => ''), titles.map(p => link(p.title))]);
        }
        if (q.get('action') === 'query' && q.get('list') === 'search') {
          const matches = search(q.get('srsearch'));
          return json(res, { batchcomplete: '', query: { searchinfo: { totalhits: matches.length }, search: matches.slice(0, 20).map(p => ({ ns: p.ns, title: p.title, pageid: p.pageid, snippet: escape(p.text.slice(0, 180)), size: p.text.length, wordcount: p.text.length })) } });
        }
        return json(res, { batchcomplete: '', query: { pages: {} } });
      }
      if (!['/wiki', '/wiki/', '/wiki/index.php'].includes(path)) return false;
      const q = url.searchParams;
      const query = normalize(q.get('search'));
      if (query) {
        if (!q.has('fulltext') && pages.has(query)) { res.writeHead(302, { Location: link(query) }); res.end(); return true; }
        return send(res, 200, resultsPage(query, q));
      }
      const title = normalize(q.get('title') || ids.get(q.get('curid')) || '首页');
      if (['特殊:搜索', 'Special:Search'].includes(title)) return send(res, 200, resultsPage('', q));
      if (q.has('action') && !['view', 'purge', 'render'].includes(q.get('action'))) return send(res, 405, '百科为本地只读快照，不提供编辑、历史版本或账号操作。', 'text/plain; charset=utf-8');
      if (!pages.has(title)) return send(res, 404, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>未收录页面</title><p>源站快照中没有“${escape(title)}”。</p><a href="/wiki">返回钟楼百科</a></html>`);
      if (title === '特殊:用户登录') return send(res, 405, '百科为本地只读快照，阅读和搜索无需登录。', 'text/plain; charset=utf-8');
      return send(res, 200, html(title));
    }
  };
}
