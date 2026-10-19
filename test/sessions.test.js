import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';
const secret = () => randomBytes(32).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t) {
  let time = 100000000;
  const app = createApp({ stateDir: null, now: () => time });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const connect = async (peer, token = secret()) => {
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/long/${peer}?token=${token}`, { origin });
    ws.messages = []; ws.on('message', raw => ws.messages.push(JSON.parse(raw)));
    ws.on('error', () => {}); ws.closed = once(ws, 'close');
    ws.sendMessage = (type, payload) => ws.send(JSON.stringify([type, payload]));
    ws.wait = async (type, filter = () => true) => {
      for (let i = 0; i < 400; i++) {
        const index = ws.messages.findIndex(([kind, value]) => kind === type && filter(value));
        if (index >= 0) return ws.messages.splice(index, 1)[0][1];
        await sleep(5);
      }
      throw new Error(`Missing ${type}: ${JSON.stringify(ws.messages)}`);
    };
    await once(ws, 'open'); return ws;
  };
  const resume = async ws => { ws.sendMessage('resume', { requestId: secret() }); return ws.wait('resume'); };
  const hostToken = secret(), host = await connect('host', hostToken);
  const info = await resume(host);
  host.sendMessage('edition', { edition: { id: 'tb' } });
  host.sendMessage('gs', { round: info.round, gamestate: Array.from({ length: 20 }, (_, i) => ({ name: `玩家${i + 1}`, id: '', seatKey: 'seat' + i, pronouns: '称谓' + i })), isNight: true, fabled: [], votes: [] });
  await host.wait('seats');
  const claim = async (ws, index, requestId = secret(), round = app.sessions.rooms.get('long').round) => {
    ws.sendMessage('claim', { seatKey: index < 0 ? null : 'seat' + index, requestId, round });
    return ws.wait('claimResult', result => result.requestId === requestId);
  };
  const role = (id, index, value, round = app.sessions.rooms.get('long').round, extra = {}) => host.sendMessage('direct', { [id]: ['player', { index, property: 'role', value, round, extra }] });
  return { ...app, host, hostToken, connect, resume, claim, role, advance(ms) { time += ms; app.sessions.cleanup(); } };
}

test('20 authoritative seat claims, concurrent conflict, retry and stale host snapshots', async t => {
  const { host, connect, claim, sessions } = await setup(t);
  const clients = await Promise.all(Array.from({ length: 20 }, (_, i) => connect('p' + i)));
  const [a, b] = await Promise.all([claim(clients[0], 0, 'race0'), claim(clients[1], 0, 'race1')]);
  assert.equal(Number(a.ok) + Number(b.ok), 1);
  const winner = a.ok ? 0 : 1, loser = 1 - winner;
  const room = sessions.rooms.get('long'); const initialOwner = room.seats[0].id;
  // Re-send an acknowledged request as if its acknowledgement had been lost.
  const repeat = await claim(clients[winner], 0, 'race' + winner);
  assert.equal(repeat.ok, true); assert.equal(room.seats[0].id, initialOwner);
  assert.equal((await claim(clients[loser], 1)).ok, true);
  for (let i = 2; i < 20; i++) assert.equal((await claim(clients[i], i)).ok, true);
  assert.equal(new Set(room.seats.map(s => s.id)).size, 20);
  const stale = room.seats.map(s => ({ ...s, id: '' }));
  host.sendMessage('gs', { gamestate: stale, isLightweight: true, round: room.round });
  host.sendMessage('player', { index: 0, property: 'id', value: '' });
  host.sendMessage('probe', 'barrier'); await host.wait('probe');
  assert.equal(room.seats[0].id, initialOwner);
  host.sendMessage('swap', [0, 19]); await host.wait('seats', p => p.seats[19].id === initialOwner);
  assert.equal(room.seats[19].seatKey, 'seat0');
  assert.equal(room.seats[19].id, initialOwner);
  assert.equal((await claim(clients[loser], -1)).ok, true);
  assert.equal(room.seats.find(s => s.seatKey === 'seat1').id, '');
});

test('hours offline preserve private identity; host may deal to an offline member', async t => {
  const { host, connect, claim, role, resume, sessions, advance } = await setup(t);
  const token = secret(); let player = await connect('p', token); const observer = await connect('watcher');
  await claim(player, 0);
  role('p', 0, 'imp', undefined, { bluffs: [{ id: 'chef' }] });
  assert.equal((await player.wait('identity', p => p.assigned)).value, 'imp');
  player.close(); await player.closed; advance(8 * 3600000);
  assert.equal(sessions.rooms.get('long').seats[0].id, 'p');
  role('p', 0, 'scarletwoman');
  host.sendMessage('probe', 'done'); await host.wait('probe');
  host.close(); await host.closed;
  player = await connect('p', token); const info = await resume(player);
  assert.equal(info.hostOnline, false);
  const restored = await player.wait('identity', p => p.assigned);
  assert.equal(restored.value, 'scarletwoman'); assert.deepEqual(restored.extra, {});
  assert.equal((await claim(observer, 1)).ok, false);
  await resume(observer); assert.equal((await observer.wait('identity')).assigned, false);
  assert.ok(!JSON.stringify(observer.messages).includes('scarletwoman'));
  const wrong = await connect('p'); assert.equal((await wrong.closed)[0], 1000);
});

test('all-offline retention expires at 24 hours and authenticated return resets the timer', async t => {
  const { host, hostToken, connect, claim, role, resume, sessions, advance } = await setup(t);
  const token = secret(); let player = await connect('p', token); await claim(player, 0);
  role('p', 0, 'imp'); await player.wait('identity', p => p.assigned);
  player.close(); host.close(); await Promise.all([player.closed, host.closed]);
  while (sessions.rooms.get('long').peers.size) await sleep(1);
  advance(24 * 3600000 - 1); assert.ok(sessions.rooms.has('long'));
  player = await connect('p', token); await resume(player);
  assert.equal((await player.wait('identity')).value, 'imp');
  advance(24 * 3600000); assert.ok(sessions.rooms.has('long'), 'connected member cancels expiry');
  player.close(); await player.closed;
  while (sessions.rooms.get('long').peers.size) await sleep(1);
  advance(24 * 3600000); assert.equal(sessions.rooms.has('long'), false);
  player = await connect('p', token); await resume(player);
  assert.equal((await player.wait('identity')).assigned, false);
  const restoredHost = await connect('host', hostToken); assert.equal(restoredHost.readyState, WebSocket.OPEN);
});

test('offline new round and redeal never restore the old role or demon bluffs; new round is idempotent', async t => {
  const { host, connect, claim, role, resume, sessions } = await setup(t);
  const token = secret(); let player = await connect('p', token); await claim(player, 0);
  const room = sessions.rooms.get('long'), oldRound = room.round;
  role('p', 0, 'imp', oldRound, { bluffs: [{ id: 'chef' }] }); await player.wait('identity', p => p.assigned);
  player.close(); await player.closed;
  host.sendMessage('player', { index: 0, property: 'isDead', value: true });
  host.sendMessage('nomination', [1, 0]); host.sendMessage('vote', [0, true]); host.sendMessage('marked', 0);
  const request = { requestId: 'new-game', round: oldRound };
  host.sendMessage('newRound', request); const result = await host.wait('roundResult');
  assert.equal(result.ok, true); assert.notEqual(room.round, oldRound);
  const newRound = room.round; host.sendMessage('newRound', request);
  assert.equal((await host.wait('roundResult')).round, newRound); assert.equal(room.round, newRound);
  assert.equal(room.seats[0].id, 'p'); assert.equal(room.seats[0].pronouns, '称谓0'); assert.equal(room.seats[0].name, '玩家1');
  assert.equal(room.seats[0].isDead, false); assert.deepEqual(room.state.votes, []); assert.equal(room.state.nomination, false); assert.equal(room.state.markedPlayer, -1); assert.equal(room.edition.edition.id, 'tb');
  role('p', 0, 'chef', newRound); role('p', 0, 'imp', oldRound, { bluffs: [{ id: 'baron' }] });
  host.sendMessage('probe', 'done'); await host.wait('probe');
  player = await connect('p', token); await resume(player);
  const restored = await player.wait('identity'); assert.equal(restored.round, newRound); assert.equal(restored.value, 'chef'); assert.deepEqual(restored.extra, {});
  host.sendMessage('resetRoles', { round: newRound, requestId: 'reset' }); await host.wait('roundResult');
  assert.equal((await player.wait('identity', p => p.round !== newRound)).assigned, false);
  assert.equal(room.privateRoles.size, 0);
});

test('host resume includes authoritative public state before a new snapshot is sent', async t => {
  const { host, hostToken, connect, claim, resume, sessions } = await setup(t);
  const player = await connect('p'); await claim(player, 0);
  host.sendMessage('nomination', [1, 0]); host.sendMessage('vote', [0, true]);
  host.sendMessage('isNight', false); host.sendMessage('marked', 0); host.sendMessage('lock', [1, false]);
  host.sendMessage('probe', 'done'); await host.wait('probe');
  host.close(); await host.closed;
  const restoredHost = await connect('host', hostToken); const info = await resume(restoredHost);
  assert.equal(info.seats[0].id, 'p'); assert.equal(info.snapshot.isNight, false);
  assert.deepEqual(info.snapshot.nomination, [1, 0]); assert.equal(info.snapshot.votes[0], true); assert.equal(info.snapshot.markedPlayer, 0); assert.equal(info.snapshot.lockedVote, 1);
  assert.equal(info.snapshot.gamestate[0].reminders, undefined);
  restoredHost.sendMessage('resetRoles', { requestId: 'keep-state', round: info.round }); await restoredHost.wait('roundResult');
  assert.deepEqual(sessions.rooms.get('long').state.nomination, [1, 0]); assert.equal(sessions.rooms.get('long').state.isNight, false);
});

test('duplicate tab replacement, explicit leave, host release, removal and room end revoke membership safely', async t => {
  const { host, connect, claim, role, resume, sessions } = await setup(t);
  const token = secret(), old = await connect('p', token); await claim(old, 0);
  role('p', 0, 'imp'); await old.wait('identity', p => p.assigned);
  const current = await connect('p', token); assert.equal((await old.closed)[1].toString(), 'local-session-replaced');
  await resume(current); assert.equal((await current.wait('identity')).value, 'imp');
  assert.equal(sessions.rooms.get('long').peers.get('p').readyState, WebSocket.OPEN);
  current.sendMessage('leave'); await current.wait('left');
  const room = sessions.rooms.get('long'); assert.equal(room.seats[0].id, ''); assert.equal(room.privateRoles.has('p'), false);
  await claim(current, 1); role('p', 1, 'imp'); await current.wait('identity', p => p.assigned);
  current.messages.length = 0;
  host.sendMessage('release', { seatKey: 'seat1' }); await current.wait('identity', p => !p.assigned);
  assert.equal(room.seats[1].id, ''); assert.equal(room.privateRoles.size, 0);
  await claim(current, 2); role('p', 2, 'chef'); await current.wait('identity', p => p.assigned);
  host.sendMessage('remove', 2); await current.wait('remove'); assert.equal(room.privateRoles.size, 0);
  host.sendMessage('endRoom'); await current.wait('ended'); await current.closed;
  assert.equal(sessions.rooms.has('long'), false);
});

// Execute the actual browser adapter and captured base class against a small
// Vuex-compatible store; this exercises reconnect races without a real phone.
function frontend({ isSpectator = true, connect = true } = {}) {
  const bundle = readFileSync('public/assets/clocktower.gstonegames.com/grimoire/js/app.d63695fc.js', 'utf8');
  const sockets = [], timers = new Map(), listeners = {}, storage = new Map(); let timerId = 0, randomCounter = 0;
  const store = { state: { session: { sessionId: '', playerId: 'p', isSpectator }, grimoire: { isSeat: false }, fabled: new Map(), players: { players: [{ name: 'P', id: 'p', seatKey: 's', role: { id: 'imp' } }], bluffs: [] }, roles: new Map([['chef', { id: 'chef' }]]) }, getters: { rolesJSONbyId: new Map() },
    commit(type, value) {
      const state = this.state;
      if (type === 'session/nomination') Object.assign(state.session, { nomination: false, votes: [], lockedVote: 0, isVoteInProgress: false });
      else if (type === 'session/clearVoteHistory') state.session.voteHistory = [];
      else if (type === 'session/distributeRoles') state.session.isRolesDistributed = value;
      else if (type === 'players/setFabled') state.players.fabled = value.fabled;
      else if (type === 'toggleNight') state.grimoire.isNight = value;
      else if (type === 'setBackgroundClass') state.grimoire.backgroundClass = value;
      else if (type === 'players/update') value.player[value.property] = value.value;
      else if (type === 'players/setBluff') { if (value) state.players.bluffs[value.index] = value.role; else state.players.bluffs = []; }
      else if (type === 'players/set') state.players.players = value;
      else if (type.startsWith('session/set')) { const field = type.slice(11); state.session[field[0].toLowerCase() + field.slice(1)] = value; }
    }
  };
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    addEventListener(type, fn) { this[type] = fn; }
    close() { this.readyState = 3; }
    send(raw) { (this.sent ||= []).push(JSON.parse(raw)); }
    receive(type, value) { this.message({ data: JSON.stringify([type, value]) }); }
    open() { this.readyState = 1; this.onopen(); }
  }
  const box = { replaceChildren() {}, append() {}, style: {}, setAttribute() {} };
  const document = { body: { append() {} }, getElementById: () => box, createElement: () => box, createTextNode: text => text, addEventListener(type, fn) { listeners[type] = fn; }, visibilityState: 'visible' };
  const window = { addEventListener(type, fn) { listeners[type] = fn; } };
  const context = { window, document, location: { origin: 'http://localhost:8080', protocol: 'http:', host: 'localhost:8080', href: 'http://localhost:8080/?room=abc', hash: '' }, history: { replaceState() {} }, navigator: { clipboard: { writeText() {} } }, crypto: { getRandomValues(a) { a.fill(++randomCounter); return a; } }, Uint8Array, URL, WebSocket: Socket, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); }, clearInterval() {}, console, St: { alert() {} } };
  runInNewContext(readFileSync('public/local-session.js', 'utf8'), context);
  const Base = runInNewContext(bundle.slice(bundle.indexOf('class Ct{'), bundle.indexOf('var Mt=')) + ';Ct', context);
  const Session = window.ClocktowerLocal.session(Base, { alert() {}, confirm(text, fn) { fn(); } });
  const session = new Session(store);
  if (connect) { store.state.session.sessionId = 'abc'; session.connect('abc'); }
  return { session, sockets, store, timers, listeners, local: window.ClocktowerLocal, context };
}

test('frontend invitations, resume masking, merged probes, exponential retry and tab takeover', () => {
  const { session, sockets, store, timers, listeners, local, context } = frontend();
  assert.equal(local.invitation(), 'abc');
  assert.equal(local.roomFrom('http://example/?room=ROOM12'), 'room12'); assert.equal(local.roomFrom('http://example/#legacy'), 'legacy'); assert.equal(local.roomFrom('bad room'), '');
  assert.equal(store.state.players.players[0].role.id, undefined, 'old role hidden before connecting');
  sockets[0].open(); sockets[0].receive('resume', { round: 'round1', seats: [{ seatKey: 's', id: 'p' }], initialized: true });
  sockets[0].receive('identity', { round: 'round1', assigned: true, index: 0, seatKey: 's', value: 'chef', extra: {} });
  assert.equal(store.state.players.players[0].role.id, 'chef');
  context.document.visibilityState = 'hidden'; listeners.visibilitychange(); assert.equal(store.state.players.players[0].role.id, undefined);
  session.checkConnection(); session.checkConnection();
  assert.equal(sockets[0].sent.filter(([type]) => type === 'probe').length, 1);
  const oldClose = sockets[0].onclose;
  session.reconnect(); assert.equal(sockets.length, 2);
  oldClose({ code: 1000, reason: 'local-session-replaced' }); assert.equal(session._paused, false);
  sockets[1].open(); sockets[1].receive('resume', { round: 'round1', seats: [] });
  sockets[1].onclose({ code: 1000, reason: 'local-session-replaced' }); assert.equal(session._paused, true);
  const count = sockets.length; session.checkConnection(); assert.equal(sockets.length, count);
  session._paused = false; session.reconnect();
  for (const expected of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    sockets.at(-1).onclose({ code: 1006 });
    const timer = timers.get(session._reconnectTimer); assert.equal(timer.delay, expected); timer.fn();
  }
  session.closeTransport();
});

test('frontend waits for claim results, retries the same request and ignores stale private messages', () => {
  const { session, sockets, store, timers } = frontend(); const socket = sockets[0];
  socket.open(); socket.receive('resume', { round: 'r1', seats: [{ seatKey: 's', id: '' }], initialized: true });
  session.claimSeat(0); const request = socket.sent.find(([type]) => type === 'claim')[1];
  assert.equal(store.state.grimoire.isSeat, false);
  assert.equal(session._status, '正在入座，请稍候…');
  timers.get(session._claimTimer).fn();
  const claims = socket.sent.filter(([type]) => type === 'claim'); assert.equal(claims.length, 2);
  assert.equal(claims[0][1].requestId, claims[1][1].requestId);
  socket.receive('seats', { round: 'r1', seats: [{ seatKey: 's', id: 'p' }] });
  socket.receive('claimResult', { requestId: request.requestId, round: 'r1', ok: true });
  assert.equal(session._pendingClaim, null); assert.equal(store.state.grimoire.isSeat, true);
  socket.receive('identity', { round: 'old', assigned: true, index: 0, seatKey: 's', value: 'imp', extra: { bluffs: [{ id: 'chef' }] } });
  socket.receive('player', { round: 'old', index: 0, property: 'role', value: 'imp', extra: {} });
  assert.equal(store.state.players.players[0].role.id, undefined);
  socket.receive('identity', { round: 'r1', assigned: true, index: 0, seatKey: 's', value: 'chef', extra: {} });
  assert.equal(store.state.players.players[0].role.id, 'chef');
  session._handlePing(); assert.equal(store.state.players.players[0].id, 'p');
  session.closeTransport();
});

test('new round clears all round state and preserves seating, script and UI settings', () => {
  const { session, sockets, store } = frontend(); const socket = sockets[0];
  socket.open(); socket.receive('resume', { round: 'old', seats: [{ seatKey: 's', id: 'p' }], initialized: true });
  const player = store.state.players.players[0];
  Object.assign(player, { name: '朋友', pronouns: '她', role: { id: 'imp' }, reminders: ['秘密'], isDead: true, isVoteless: true, isMarked: true });
  store.state.edition = { id: 'tb' }; store.state.grimoire.zoom = 4; store.state.grimoire.isNight = false;
  Object.assign(store.state.session, { nomination: [0, 0], votes: [true], lockedVote: 2, isVoteInProgress: true, voteHistory: ['记录'], markedPlayer: 0 });
  store.state.players.bluffs = [{ id: 'chef' }]; store.state.players.fabled = ['fabled'];
  socket.receive('round', { round: 'new', kind: 'newRound' });
  const after = store.state.players.players[0];
  for (const field of ['name', 'id', 'seatKey', 'pronouns']) assert.equal(after[field], player[field]);
  assert.equal(after.role.id, undefined); assert.equal(after.reminders.length, 0); assert.equal(after.isDead, false); assert.equal(after.isVoteless, false); assert.equal(after.isMarked, false);
  assert.equal(store.state.players.bluffs.length, 0); assert.equal(store.state.players.fabled.length, 0);
  assert.equal(store.state.session.nomination, false); assert.equal(store.state.session.votes.length, 0); assert.equal(store.state.session.voteHistory.length, 0); assert.equal(store.state.session.markedPlayer, -1);
  assert.equal(store.state.grimoire.isNight, true); assert.equal(store.state.grimoire.zoom, 4); assert.equal(store.state.edition.id, 'tb');
  socket.receive('identity', { round: 'old', assigned: true, index: 0, seatKey: 's', value: 'imp' });
  assert.equal(after.role.id, undefined);
  session.closeTransport();
});

test('manual save JSON keeps original fields and excludes network metadata', () => {
  const bundle = readFileSync('public/assets/clocktower.gstonegames.com/grimoire/js/app.d63695fc.js', 'utf8');
  const fn = bundle.match(/gamestate:(function\(\)\{return JSON.stringify\([\s\S]+?\)\}),/)[1];
  const exportState = runInNewContext('(' + fn + ')');
  const data = JSON.parse(exportState.call({ players: { bluffs: [], fabled: [], players: [{ name: '朋友', id: 'p', seatKey: 'network-only', role: { id: 'chef' }, reminders: [] }] }, edition: { isOfficial: true, id: 'tb' } }));
  assert.deepEqual(Object.keys(data), ['bluffs', 'edition', 'roles', 'fabled', 'players']);
  assert.equal(data.players[0].seatKey, undefined); assert.equal(data.players[0].role, 'chef'); assert.equal(data.round, undefined);
});

test('host restores seat order and public state while retaining private notes', () => {
  const { session, sockets, store } = frontend();
  session.closeTransport(); store.state.session.isSpectator = false; store.state.edition = { id: 'tb', isOfficial: true };
  const saved = store.state.players.players[0]; saved.role = { id: 'chef' }; saved.reminders = ['private'];
  session.connect('abc'); const socket = sockets.at(-1); socket.open();
  socket.receive('resume', { round: 'r1', initialized: true, seats: [{ seatKey: 's', id: 'p' }], snapshot: { gamestate: [{ name: '服务端名字', id: 'p', seatKey: 's', isDead: true, isVoteless: true, pronouns: '他' }], isNight: false, isVoteHistoryAllowed: true, fabled: [], markedPlayer: 0 } });
  assert.equal(store.state.players.players[0].role.id, 'chef'); assert.equal(store.state.players.players[0].reminders[0], 'private');
  assert.equal(store.state.players.players[0].name, '服务端名字'); assert.equal(store.state.players.players[0].id, 'p'); assert.equal(store.state.grimoire.isNight, false);
  const snapshot = socket.sent.find(([type]) => type === 'gs')[1];
  assert.equal(snapshot.gamestate[0].seatKey, 's'); assert.equal(snapshot.gamestate[0].id, 'p'); assert.equal(snapshot.isNight, false);
  session.closeTransport();
});

function roleExchange() {
  const fixture = frontend({ isSpectator: false });
  const { session, store, local, sockets } = fixture;
  const bundle = readFileSync('public/assets/clocktower.gstonegames.com/grimoire/js/app.d63695fc.js', 'utf8');
  const mutations = runInNewContext('(' + bundle.slice(bundle.indexOf('Pt={') + 3, bundle.indexOf(';var Vt=')) + ')');
  store.state.session.isSpectator = false; session._isSpectator = false;
  session._round = 'current'; session._ready = true; sockets[0].readyState = 1;
  store.state.players.players = [
    { name: '甲', pronouns: '他', id: 'p0', seatKey: 'seat0', role: { id: 'imp', name: '小恶魔', team: 'demon' }, reminders: [{ name: '中毒' }], isDead: true, isVoteless: true },
    { name: '乙', pronouns: '她', id: 'p1', seatKey: 'seat1', role: { id: 'chef', name: '厨师', team: 'townsfolk' }, reminders: [{ name: '醉酒' }], isDead: false, isVoteless: false }
  ];
  session._gamestate = store.state.players.players.map(({ role, ...player }) => ({ ...player }));
  const originalCommit = store.commit.bind(store);
  let swaps = 0;
  store.commit = (type, payload) => {
    if (type !== 'players/swapRoles') return originalCommit(type, payload);
    mutations.swapRoles(store.state.players, payload); swaps++;
    session.sendSwappedRoles(payload);
  };
  const start = bundle.indexOf('D={') + 2;
  const component = runInNewContext('(' + bundle.slice(start, bundle.indexOf('},U=D', start) + 1) + ')', {
    window: { ClocktowerLocal: local }, k: {}, b: {}, z: {}, V: {}, a: { b: () => ({}), d: () => ({}) }
  });
  const view = { ...component.data(), $store: store };
  Object.defineProperty(view, 'players', { get: () => store.state.players.players });
  Object.defineProperty(view, 'session', { get: () => store.state.session });
  for (const [name, method] of Object.entries(component.methods)) view[name] = method.bind(view);
  return { ...fixture, view, component, bundle, mutations, swapCount: () => swaps };
}

test('role exchange selects directly on the town and changes only roles, distributing only when requested', () => {
  const { session, store, sockets, view, swapCount, bundle } = roleExchange();
  const [a, b] = store.state.players.players, first = { ...a }, second = { ...b };
  view.handleTrigger(0, ['swapRoles']);
  assert.equal(view.roleSwap, 0); assert.equal(view.roleSwapSelection.source, a); assert.equal(swapCount(), 0);
  view.handleTrigger(1, ['swapRoles', b]);
  assert.equal(view.roleSwap, -1); assert.equal(view.roleSwapSelection, null); assert.equal(swapCount(), 1);
  assert.equal(store.state.players.players[0], a); assert.equal(store.state.players.players[1], b);
  assert.equal(a.role, second.role); assert.equal(b.role, first.role);
  for (const field of Object.keys(first).filter(field => field !== 'role')) assert.equal(a[field], first[field], field);
  for (const field of Object.keys(second).filter(field => field !== 'role')) assert.equal(b[field], second[field], field);
  assert.equal(sockets[0].sent?.length || 0, 0, 'hidden roles must not be broadcast or automatically distributed');
  session.distributeRoles();
  const [type, recipients] = sockets[0].sent.at(-1);
  assert.equal(type, 'direct'); assert.equal(recipients.p0[1].value, 'chef'); assert.equal(recipients.p1[1].value, 'imp');
  assert.equal(recipients.p0[1].index, 0); assert.equal(recipients.p1[1].index, 1);
  assert.match(bundle, /case"players\/swapRoles":t\.sendSwappedRoles\(i\)/);
  session.closeTransport();
});

test('role exchange preserves public traveler updates without exposing the hidden replacement', () => {
  const { session, store, sockets, view } = roleExchange();
  const [a, b] = store.state.players.players;
  a.role = { id: 'beggar', name: '乞丐', team: 'traveler' };
  session._gamestate[0].roleId = 'beggar';
  view.swapRoles(0); view.swapRoles(1, b);
  assert.deepEqual(sockets[0].sent.map(([type, payload]) => [type, payload.index, payload.value]), [['player', 0, ''], ['player', 1, 'beggar']]);
  assert.equal(a.id, 'p0'); assert.equal(b.id, 'p1');
  assert.ok(!JSON.stringify(sockets[0].sent).includes('chef'));
  session.closeTransport();
});

test('role exchange cancellation, stale selection and spectator access never modify seats', () => {
  const { session, store, view, swapCount } = roleExchange();
  const [a, b] = store.state.players.players;
  view.swapRoles(0); view.cancel(); view.swapRoles(1, b); assert.equal(swapCount(), 0);
  view.swapRoles(0); view.swapRoles(0, a); assert.equal(swapCount(), 0);
  view.swapRoles(0); session._round = 'new-round'; view.swapRoles(1, b); assert.equal(swapCount(), 0);
  view.swapRoles(0); store.state.players.players[0] = { ...a }; view.swapRoles(1, b); assert.equal(swapCount(), 0);
  view.swapRoles(0); store.state.players.players[0].role = { id: 'monk' }; view.swapRoles(1, b); assert.equal(swapCount(), 0);
  view.swapRoles(0); store.state.session.isSpectator = true; view.swapRoles(1, b);
  view.swapRoles(0); assert.equal(view.roleSwap, -1); assert.equal(swapCount(), 0);
  assert.equal(a.role.id, 'imp'); assert.equal(b.role.id, 'chef');
  session.closeTransport();
});

test('town selection modes are exclusive and cancel when the source seat disappears or the room changes', () => {
  const { session, store, view, component, swapCount } = roleExchange();
  view.swapPlayer(0); assert.equal(view.swap, 0);
  view.swapRoles(1); assert.equal(view.swap, -1); assert.equal(view.roleSwap, 1);
  view.movePlayer(0); assert.equal(view.roleSwap, -1); assert.equal(view.move, 0);
  view.swapRoles(0); assert.equal(view.move, -1);
  view.nominatePlayer(1); assert.equal(view.roleSwap, -1); assert.equal(view.nominate, 1);
  view.swapRoles(0); assert.equal(view.nominate, -1);
  store.state.players.players.reverse(); component.watch.players.call(view); assert.equal(view.roleSwap, 1);
  store.state.players.players.pop(); component.watch.players.call(view); assert.equal(view.roleSwap, -1);
  store.state.players.players.push({ name: '丙', role: {} });
  view.swapRoles(0); assert.equal(view.roleSwap, 0); component.watch['session.sessionId'].call(view); assert.equal(view.roleSwap, -1);
  assert.equal(swapCount(), 0);
  session.closeTransport();
});

test('role exchange persists through the original browser save plugin, including offline use', () => {
  const { session, store, view, bundle } = roleExchange();
  store.state.session.sessionId = ''; session._ready = false;
  view.swapRoles(0); view.swapRoles(1, store.state.players.players[1]);
  const start = bundle.indexOf('var wt=') + 7;
  const source = bundle.slice(start, bundle.indexOf(',Rt=i(', start));
  const saved = new Map(); let subscriber;
  const plugin = runInNewContext('(' + source + ')', { kt() {}, localStorage: { setItem(key, value) { saved.set(key, value); }, removeItem(key) { saved.delete(key); } } });
  plugin({ subscribe(callback) { subscriber = callback; } });
  subscriber({ type: 'players/swapRoles' }, store.state);
  const players = JSON.parse(saved.get('players'));
  assert.equal(players[0].role, 'chef'); assert.equal(players[1].role, 'imp');
  assert.equal(players[0].id, 'p0'); assert.equal(players[1].id, 'p1');
  assert.equal(players[0].seatKey, 'seat0'); assert.equal(players[1].name, '乙');
  session.closeTransport();
});

test('offline storyteller pagehide and backgrounding preserve private roles for refresh', () => {
  const { session, store, listeners, context, sockets } = frontend({ isSpectator: false, connect: false });
  assert.equal(sockets.length, 0); assert.equal(session._isSpectator, false);
  context.document.visibilityState = 'hidden'; listeners.visibilitychange();
  assert.equal(store.state.players.players[0].role.id, 'imp');
  listeners.pagehide(); assert.equal(store.state.players.players[0].role.id, 'imp');
  session.closeTransport();
});
