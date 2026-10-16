import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Script, runInNewContext } from 'node:vm';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';

const secret = () => randomBytes(32).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const seats = n => Array.from({ length: n }, (_, i) => ({ name: `玩家${i + 1}`, id: `p${i}`, isDead: false, isVoteless: false, pronouns: '' }));
const gs = (players = seats(3)) => ({ gamestate: players, isNight: true, isVoteHistoryAllowed: true, nomination: false, votingSpeed: 3000, lockedVote: 0, isVoteInProgress: false, markedPlayer: -1, fabled: [] });

async function setup(t, options = {}) {
  const app = createApp({ stateDir: null, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const connect = async (peer, room = 'test', token = secret()) => {
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/${room}/${peer}?token=${token}`, { origin });
    ws.messages = [];
    ws.on('message', raw => ws.messages.push(JSON.parse(raw.toString())));
    ws.on('error', () => {});
    ws.closed = once(ws, 'close');
    ws.sendMessage = (type, payload) => ws.send(JSON.stringify([type, payload]));
    ws.wait = async (type, predicate = () => true) => {
      const end = Date.now() + 2500;
      while (Date.now() < end) {
        const index = ws.messages.findIndex(([kind, payload]) => kind === type && predicate(payload));
        if (index >= 0) return ws.messages.splice(index, 1)[0][1];
        await sleep(5);
      }
      throw new Error(`Timed out waiting for ${type}; received ${JSON.stringify(ws.messages)}`);
    };
    await once(ws, 'open');
    return ws;
  };
  return { ...app, origin, connect };
}

async function initialize(host, observer, players = seats(3)) {
  host.sendMessage('edition', { edition: { id: 'tb' } });
  host.sendMessage('gs', gs(players));
  await observer.wait('gs');
  observer.messages.length = 0;
}

test('local API exposes all captured content, search and pagination', async t => {
  const { origin } = await setup(t);
  const query = async (path, body = {}) => {
    const response = await fetch(origin + path, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 200);
    assert.equal(result.reason, '成功');
    return result;
  };
  const roles = await query('/ct/grimoireRoleJson/');
  assert.equal(roles.data.role.length, 205);
  assert.equal(roles.data.fabled.length, 27);
  for (const role of [...roles.data.role, ...roles.data.fabled]) {
    assert.match(role.image, /^\/assets\//);
    assert.ok(existsSync(resolve('public', '.' + role.image)));
  }
  let total = 0;
  for (const tab of [1, 2, 3]) {
    const first = await query('/ct/grimoire_edition_list/', { tab, limit: 10 });
    const items = [];
    for (let page = 1; page <= first.data.page_total; page++) {
      const response = await query('/ct/grimoire_edition_list/', { tab, limit: 10, page });
      items.push(...response.data.items);
    }
    assert.equal(items.length, first.data.total);
    assert.equal(new Set(items.map(i => i.id)).size, items.length);
    total += items.length;
    for (const item of items) {
      assert.match(item.json, /^\/assets\//);
      const response = await fetch(origin + item.json);
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(await response.json()));
    }
  }
  assert.equal(total, 132);
  const search = await query('/ct/grimoire_edition_list/', { tab: 1, name: '暗流' });
  assert.equal(search.data.total, 1);
  assert.equal(search.data.items[0].name, '暗流涌动');
  const empty = await query('/ct/grimoire_edition_list/', { tab: 1, name: '不存在的剧本名字' });
  assert.equal(empty.data.total, 0);
});

test('HTTP paths, MIME types, health, caching and malformed input', async t => {
  const { origin } = await setup(t);
  assert.equal((await fetch(origin + '/healthz').then(r => r.json())).status, 'ok');
  assert.equal((await fetch(origin + '/', { redirect: 'manual' })).status, 200);
  assert.equal((await fetch(origin + '/grimoire/?town=legacy', { redirect: 'manual' })).headers.get('location'), '/?town=legacy');
  for (const path of ['/snapshot/roles.json', '/server/index.js', '/.state/room-owners.json', '/%2e%2e%2fpackage.json']) assert.equal((await fetch(origin + path)).status, 404);
  const bad = await fetch(origin + '/ct/grimoireRoleJson/', { method: 'POST', body: '{' });
  assert.equal(bad.status, 400);
  const large = await fetch(origin + '/ct/grimoireRoleJson/', { method: 'POST', body: 'x'.repeat(65537) });
  assert.equal(large.status, 413);
  const response = await fetch(origin + '/');
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.ok(!html.includes('hm.baidu.com'));
  assert.ok(!html.includes('https://fonts.googleapis.com'));
  assert.ok(html.includes('/local-runtime.js'));
  const head = await fetch(origin + '/', { method: 'HEAD' });
  assert.equal((await head.text()).length, 0);
  assert.equal((await fetch(origin + '/', { headers: { 'If-None-Match': head.headers.get('etag') } })).status, 304);
  for (const path of html.matchAll(/<script src="([^"]+)"/g)) {
    const response = await fetch(origin + path[1]);
    assert.match(response.headers.get('content-type'), /javascript/);
    new Script(await response.text());
  }
});

test('public state strips private roles and reminders; private roles and bluffs reach only recipients', async t => {
  const { connect } = await setup(t);
  const host = await connect('host'), p0 = await connect('p0'), p1 = await connect('p1'), observer = await connect('watcher');
  const players = seats(3);
  players[0].roleId = 'imp'; players[0].role = { id: 'imp' }; players[0].reminders = [{ name: '秘密标记' }];
  players[1].roleId = 'beggar';
  host.sendMessage('edition', { edition: { id: 'tb' } });
  host.sendMessage('gs', gs(players));
  const state = await observer.wait('gs');
  assert.equal(state.gamestate[0].roleId, undefined);
  assert.equal(state.gamestate[0].role, undefined);
  assert.equal(state.gamestate[0].reminders, undefined);
  assert.equal(state.gamestate[1].roleId, 'beggar');
  p0.messages.length = p1.messages.length = observer.messages.length = 0;
  host.sendMessage('direct', { p0: ['player', { index: 0, property: 'role', value: 'imp', extra: { bluffs: [{ id: 'chef' }] } }] });
  const role = await p0.wait('player');
  assert.equal(role.value, 'imp'); assert.equal(role.extra.bluffs[0].id, 'chef');
  await sleep(25);
  assert.equal(p1.messages.length, 0); assert.equal(observer.messages.length, 0);
  host.sendMessage('player', { index: 1, property: 'role', value: 'beggar' });
  assert.deepEqual((await observer.wait('player')).extra, {});
});

test('players cannot impersonate the host, other players, or direct secret messages', async t => {
  const { connect, sessions } = await setup(t);
  const host = await connect('host'), p0 = await connect('p0'), p1 = await connect('p1');
  await initialize(host, p1);
  p0.sendMessage('isNight', false);
  p0.sendMessage('player', { index: 1, property: 'id', value: 'p0' });
  p0.sendMessage('direct', { p1: ['player', { index: 1, property: 'role', value: 'imp' }] });
  p0.sendMessage('pronouns', [1, '伪造']);
  p0.sendMessage('ping', ['p1', 'latency']);
  const ping = await host.wait('ping');
  assert.equal(ping[0], 'p0');
  assert.equal(sessions.rooms.get('test').state.isNight, true);
  assert.equal(sessions.rooms.get('test').seats[1].id, 'p1');
  assert.equal(sessions.rooms.get('test').seats[1].pronouns, '');
  assert.equal(p1.messages.length, 0);
});

test('seat claims are bound to the sender and conflicting claims cannot steal a seat', async t => {
  const { connect, sessions } = await setup(t);
  const host = await connect('host'), p0 = await connect('a'), p1 = await connect('b');
  await initialize(host, p1, seats(3).map(p => ({ ...p, id: '' })));
  p0.sendMessage('claim', [0, 'someoneelse']);
  assert.deepEqual(await host.wait('claim'), [0, 'a']);
  p1.sendMessage('claim', [0, 'b']);
  p1.sendMessage('ping', ['b', 'latency']);
  await host.wait('ping');
  assert.equal(sessions.rooms.get('test').seats[0].id, 'a');
  assert.ok(!host.messages.some(([kind]) => kind === 'claim'));
  p0.sendMessage('claim', [2, 'a']);
  await host.wait('claim');
  assert.equal(sessions.rooms.get('test').seats[0].id, '');
  assert.equal(sessions.rooms.get('test').seats[2].id, 'a');
});

test('voting enforces seat ownership, lock order and dead votes while permitting storyteller override', async t => {
  const { connect, sessions } = await setup(t);
  const host = await connect('host'), p0 = await connect('p0'), p1 = await connect('p1');
  await initialize(host, p1);
  host.sendMessage('nomination', [0, 1]);
  await p1.wait('nomination');
  p0.sendMessage('vote', [1, true, true]);
  p0.sendMessage('vote', [0, true, true]);
  assert.deepEqual(await host.wait('vote'), [0, true, false]);
  assert.equal(sessions.rooms.get('test').state.votes[1], undefined);
  host.sendMessage('lock', [2, false]);
  await p1.wait('lock');
  p1.sendMessage('vote', [2, true, false]);
  p1.sendMessage('ping', ['p1', 'latency']);
  await host.wait('ping');
  assert.equal(sessions.rooms.get('test').state.votes[2], undefined);
  host.sendMessage('player', { index: 0, property: 'isDead', value: true });
  host.sendMessage('player', { index: 0, property: 'isVoteless', value: true });
  await p1.wait('player', p => p.property === 'isVoteless');
  p0.sendMessage('vote', [0, false, false]);
  p0.sendMessage('ping', ['p0', 'latency']);
  await host.wait('ping');
  assert.equal(sessions.rooms.get('test').state.votes[0], true);
  host.sendMessage('vote', [0, false, false]);
  assert.deepEqual(await p1.wait('vote', p => p[2] === true), [0, false, true]);
});

test('public state replay, seat moves, and 20 seated player connections stay isolated between rooms', async t => {
  const { connect, sessions } = await setup(t);
  const host = await connect('host');
  const clients = await Promise.all(Array.from({ length: 20 }, (_, i) => connect('p' + i)));
  const other = await connect('other', 'other');
  await initialize(host, clients[0], seats(20));
  host.sendMessage('swap', [0, 19]);
  await clients[1].wait('swap');
  host.sendMessage('move', [19, 1]);
  await clients[1].wait('move');
  host.sendMessage('isNight', false);
  await clients[1].wait('isNight');
  const expected = sessions.rooms.get('test').seats.map(p => p.name);
  host.close(); await once(host, 'close');
  const observer = await connect('late');
  observer.sendMessage('direct', { host: ['getGamestate', 'fake'] });
  const replay = await observer.wait('gs');
  assert.deepEqual(replay.gamestate.map(p => p.name), expected);
  assert.equal(replay.isNight, false);
  assert.equal(other.messages.length, 0);
  assert.equal(clients.length, 20);
});

test('owner credentials survive service restart; same-owner refresh replaces stale sockets', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'clocktower-test-'));
  const first = await setup(t, { stateDir });
  const token = secret();
  const host = await first.connect('host', 'owned', token);
  const wrong = await first.connect('host', 'owned');
  const [code] = await once(wrong, 'close'); assert.equal(code, 1000);
  const duplicate = await first.connect('host', 'owned', token);
  const [oldCode, oldReason] = await host.closed;
  assert.equal(oldCode, 1000);
  assert.equal(oldReason.toString(), 'local-session-replaced');
  assert.equal(duplicate.readyState, WebSocket.OPEN);
  duplicate.close(); await duplicate.closed;
  const second = await setup(t, { stateDir });
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const rejected = await second.connect('host', 'owned');
  assert.equal((await once(rejected, 'close'))[0], 1000);
  const restored = await second.connect('host', 'owned', token);
  restored.sendMessage('ping', []);
  assert.equal(restored.readyState, WebSocket.OPEN);
});

test('malformed messages close one client without crashing the service; origin and token are required', async t => {
  const { origin, connect } = await setup(t);
  const host = await connect('host');
  const bad = await connect('bad');
  bad.send('{');
  assert.equal((await once(bad, 'close'))[0], 1008);
  assert.equal((await fetch(origin + '/healthz')).status, 200);
  const noToken = new WebSocket(origin.replace('http:', 'ws:') + '/ws/test/other', { origin });
  const [error] = await once(noToken, 'error'); assert.match(error.message, /401/);
  const wrongOrigin = new WebSocket(origin.replace('http:', 'ws:') + '/ws/test/other?token=' + secret(), { origin: 'https://unrelated.example' });
  const [error2] = await once(wrongOrigin, 'error'); assert.match(error2.message, /403/);
  assert.equal(host.readyState, WebSocket.OPEN);
});

test('custom compact traveler roles stay public and permit exile votes from dead players', async t => {
  const { connect } = await setup(t);
  const host = await connect('host'), p0 = await connect('p0'), p1 = await connect('p1');
  host.sendMessage('edition', { edition: { id: 'custom' }, roles: [{ 0: 'guest', 1: '自制旅行者', 12: 'traveler' }] });
  const players = seats(3); players[0].isDead = true; players[0].isVoteless = true; players[1].roleId = 'guest';
  host.sendMessage('gs', gs(players));
  const state = await p1.wait('gs'); assert.equal(state.gamestate[1].roleId, 'guest');
  host.sendMessage('nomination', [0, 1]); await p0.wait('nomination');
  p0.sendMessage('vote', [0, true, false]);
  assert.deepEqual(await host.wait('vote'), [0, true, false]);
  host.sendMessage('edition', { edition: { id: 'custom' }, roles: {} });
  host.sendMessage('edition', { edition: { id: 'custom' }, roles: [null] });
  host.sendMessage('gs', gs(seats(3)));
  assert.equal((await p1.wait('gs')).gamestate.length, 3);
});

test('strict offline CSP allows local assets and local sockets but no remote origins', async t => {
  const { origin } = await setup(t, { offlineOnly: true });
  const response = await fetch(origin + '/');
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp.includes("connect-src 'self' ws://127.0.0.1:"));
  assert.ok(!csp.includes(' https:'));
  assert.ok(!csp.includes(' http:'));
  assert.ok(!csp.includes(' ws:;'));
});

test('patched bundle removes active original-service URLs and retains original state shape', () => {
  const manifest = JSON.parse(readFileSync('snapshot/manifest.json'));
  const resource = Object.entries(manifest.resources).find(([url]) => /\/js\/app\./.test(url))[1];
  const bundle = readFileSync(resolve('public', '.' + resource.path), 'utf8');
  assert.ok(!bundle.includes('https://oss.gstonegames.com/'));
  assert.ok(!bundle.includes('wss://clocktower.gstonegames.com:8081/'));
  assert.ok(bundle.includes('fe=location.origin'));
  assert.ok(bundle.includes('this._handlePing([t,0])'));
  for (const field of ['bluffs:', 'edition:', 'roles:', 'fabled:', 'players:']) assert.ok(bundle.includes(field));
});

test('frontend cached/API initialization reuses one socket and stale close events cannot clear a new room', () => {
  const manifest = JSON.parse(readFileSync('snapshot/manifest.json'));
  const resource = Object.entries(manifest.resources).find(([url]) => /\/js\/app\./.test(url))[1];
  const bundle = readFileSync(resolve('public', '.' + resource.path), 'utf8');
  const source = bundle.slice(bundle.indexOf('class Ct{'), bundle.indexOf('var Mt='));
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    addEventListener() {}
    close() { this.readyState = 3; }
  }
  const LocalSession = runInNewContext(source + ';Ct', {
    WebSocket: FakeSocket, location: { protocol: 'http:', host: 'localhost:8080' },
    setTimeout: () => 1, clearTimeout() {}, clearInterval() {}, St: { alert() {} }
  });
  const store = {
    state: { session: { playerId: 'testplayer', sessionId: '', isSpectator: false } },
    commit(type, value) { if (type === 'session/setSessionId') this.state.session.sessionId = value; }
  };
  const session = new LocalSession(store);
  session.connect('first'); session.connect('first');
  assert.equal(sockets.length, 1, 'CONNECTING socket must be reused');
  sockets[0].readyState = 1;
  session.connect('first');
  assert.equal(sockets.length, 1, 'OPEN socket must be reused after API initialization');
  session.connect('second');
  assert.equal(sockets.length, 2);
  store.state.session.sessionId = 'second';
  sockets[0].onclose({ code: 1000, reason: '' });
  assert.equal(session._socket, sockets[1]);
  assert.equal(store.state.session.sessionId, 'second');
  session.disconnect();
});

test('countdown audio supports byte ranges, suffix ranges, validators and unsatisfiable requests', async t => {
  const { origin } = await setup(t);
  const url = origin + '/assets/oss.gstonegames.com/data_file/clocktower/web/sounds/countdown.mp3';
  const full = await fetch(url);
  const size = Number(full.headers.get('content-length'));
  assert.ok(size > 16);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg');
  await full.arrayBuffer();
  const partial = await fetch(url, { headers: { Range: 'bytes=0-15' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 0-15/${size}`);
  assert.equal((await partial.arrayBuffer()).byteLength, 16);
  const suffix = await fetch(url, { headers: { Range: 'bytes=-16' } });
  assert.equal(suffix.status, 206);
  assert.equal((await suffix.arrayBuffer()).byteLength, 16);
  const stale = await fetch(url, { headers: { Range: 'bytes=0-15', 'If-Range': 'stale-etag' } });
  assert.equal(stale.status, 200); await stale.arrayBuffer();
  const invalid = await fetch(url, { headers: { Range: `bytes=${size}-` } });
  assert.equal(invalid.status, 416);
});

test('root navigation removes the promotional tab and puts local wiki below tutorial', async t => {
  const { origin } = await setup(t);
  const response = await fetch(origin + '/', { redirect: 'manual' });
  assert.equal(response.status, 200);
  const page = await response.text();
  const appPath = [...page.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).find(path => /\/js\/app\./.test(path));
  const script = await fetch(origin + appPath).then(r => r.text());
  assert.ok(!script.includes('staticClass:"svg fa-broadcast-tower"'));
  assert.ok(!script.includes('"session"===e.tab?['));
  assert.ok(script.includes('[e._v(" 教程 ")]),e._m(0)'));
  assert.ok(script.includes('href:"/wiki"'));
  assert.ok(script.includes('window.open("/guide?type=2&bIsWM="'));
  assert.ok(!script.includes('https://clocktower-wiki.gstonegames.com/'));
});

test('original tutorial and the complete wiki page inventory are available offline', async t => {
  const { origin } = await setup(t, { offlineOnly: true });
  for (const path of ['/guide', '/guide/']) {
    const response = await fetch(origin + path, { redirect: 'manual' });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes('id="mdbutton1"'));
    assert.ok(body.includes('/guide/runtime.js'));
    assert.ok(!body.includes('hm.baidu.com'));
  }
  const runtime = await fetch(origin + '/guide/runtime.js').then(r => r.text());
  assert.ok(runtime.includes('GetQueryString("type") || 2'));
  for (const image of ['stroller_md.png', 'player_md.png', 'stroller_h5.png', 'player_h5.png', 'stroller_pc.png', 'player_pc.png']) {
    const response = await fetch(origin + '/guide/images/' + image, { method: 'HEAD' });
    assert.equal(response.status, 200, image);
    assert.match(response.headers.get('content-type'), /image\/png/);
  }
  const wiki = JSON.parse(readFileSync(new URL('../data/wiki.json', import.meta.url)));
  for (const [title, item] of Object.entries(wiki.pages)) {
    if (item.ns < 0) continue;
    const response = await fetch(origin + '/wiki/index.php?title=' + encodeURIComponent(title));
    assert.equal(response.status, 200, title);
    assert.match(response.headers.get('content-type'), /text\/html/);
  }
  const home = await fetch(origin + '/wiki').then(r => r.text());
  assert.ok(home.includes('关于钟楼百科'));
  assert.ok(home.includes('/wiki/index.php?title='));
  assert.ok(!home.includes('hm.baidu.com'));
  assert.ok(!/\b(?:src|href)="https:\/\/clocktower-wiki/.test(home));
});

test('wiki search, suggestions, module grouping and read-only boundaries stay local', async t => {
  const { origin } = await setup(t);
  const search = async params => fetch(origin + '/wiki/index.php?' + new URLSearchParams(params));
  const blank = await search({ title: '特殊:搜索' }).then(r => r.text());
  assert.ok(!blank.includes('CLOCKTOWER_LOCAL_SEARCH'));
  assert.equal((await search({ search: '小恶魔' })).url, origin + '/wiki/index.php?title=' + encodeURIComponent('小恶魔'));
  const results = await search({ search: '恶魔', fulltext: '1' }).then(r => r.text());
  assert.ok(results.includes('class="mw-search-results"'));
  assert.ok(results.includes('/wiki/index.php?title=' + encodeURIComponent('小恶魔')));
  const none = await search({ search: 'zz_不存在的词_zz', fulltext: '1' }).then(r => r.text());
  assert.ok(none.includes('找不到和查询相匹配的结果'));
  const injection = await search({ search: '\"><img src=x onerror=alert(1)>', fulltext: '1' }).then(r => r.text());
  assert.ok(!injection.includes('<img src=x'));
  const suggestions = await fetch(origin + '/wiki/api.php?action=opensearch&search=' + encodeURIComponent('小恶')).then(r => r.json());
  assert.ok(suggestions[1].includes('小恶魔'));
  assert.ok(suggestions[3].every(path => path.startsWith('/wiki/')));
  const module = await fetch(origin + '/wiki/load.php?modules=jquery%7Cmediawiki.base%7Cskins.pivot.js,modernizr');
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/);
  new Script(await module.text());
  assert.equal((await fetch(origin + '/wiki/load.php?modules=../../server/index.js')).status, 404);
  assert.equal((await fetch(origin + '/wiki/index.php?title=' + encodeURIComponent('首页') + '&action=edit')).status, 405);
  assert.equal((await fetch(origin + '/wiki/api.php', { method: 'POST', body: 'action=login' })).status, 405);
  assert.equal((await search({ title: '<script>未收录</script>' })).status, 404);
});
