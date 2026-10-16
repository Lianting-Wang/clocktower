import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const OPEN = WebSocket.OPEN;
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const indexOfSeat = (room, value) => Number.isInteger(value) && value >= 0 && value < room.seats.length;
const send = (socket, type, payload) => { if (socket?.readyState === OPEN) socket.send(JSON.stringify([type, payload])); };
const text = (value, limit = 200) => typeof value === 'string' && value.length <= limit;

export function attachRooms(server, { roles, stateDir, allowedOrigins = [], now = Date.now } = {}) {
  const rooms = new Map();
  const owners = new Map();
  const travelerIds = new Set(roles.filter(role => role.team === 'traveler').map(role => role.id));
  const ownerFile = stateDir && join(stateDir, 'room-owners.json');
  if (ownerFile) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try {
      for (const entry of JSON.parse(readFileSync(ownerFile, 'utf8'))) owners.set(...entry);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const persist = () => {
    if (!ownerFile) return;
    writeFileSync(ownerFile + '.tmp', JSON.stringify([...owners]), { mode: 0o600 });
    renameSync(ownerFile + '.tmp', ownerFile);
  };
  const broadcast = (room, sender, type, payload) => {
    for (const socket of room.peers.values()) if (socket !== sender) send(socket, type, payload);
  };
  const isTraveler = (room, id) => typeof id === 'string' && (travelerIds.has(id) || (Array.isArray(room.edition?.roles) && room.edition.roles.some(role => role && (role.id || role[0]) === id && (role.team || role[12]) === 'traveler')));
  const publicSeats = (room, seats) => seats.slice(0, 20).map(seat => ({
    name: text(seat?.name) ? seat.name : '',
    id: text(seat?.id, 64) ? seat.id : '',
    seatKey: text(seat?.seatKey, 64) && /^[a-zA-Z0-9_-]{1,64}$/.test(seat.seatKey) ? seat.seatKey : randomBytes(16).toString('hex'),
    isDead: !!seat?.isDead,
    isVoteless: !!seat?.isVoteless,
    pronouns: text(seat?.pronouns) ? seat.pronouns : '',
    ...(isTraveler(room, seat?.roleId) ? { roleId: seat.roleId } : {})
  }));
  const snapshot = room => ({ ...room.state, round: room.round, gamestate: room.seats });
  const seatState = room => ({ round: room.round, seats: room.seats.map(({ seatKey, id }) => ({ seatKey, id })) });
  const publishSeats = room => broadcast(room, null, 'seats', seatState(room));
  const prunePrivate = room => {
    for (const [id, value] of room.privateRoles) if (!room.seats.some(s => s.id === id && s.seatKey === value.seatKey)) room.privateRoles.delete(id);
  };
  const identity = (room, id, socket) => {
    const value = room.privateRoles.get(id);
    const index = room.seats.findIndex(s => s.id === id);
    const assigned = index >= 0 && value?.round === room.round && value.seatKey === room.seats[index].seatKey && value.credential === room.credentials.get(id);
    send(socket, 'identity', { round: room.round, assigned: !!assigned, index, ...(assigned ? { value: value.value, extra: value.extra, seatKey: value.seatKey } : {}) });
  };
  const remember = (room, key, action) => {
    if (room.requests.has(key)) return room.requests.get(key);
    const result = action();
    room.requests.set(key, result);
    if (room.requests.size > 512) room.requests.delete(room.requests.keys().next().value);
    return result;
  };
  const release = (room, id) => {
    for (const seat of room.seats) if (seat.id === id) seat.id = '';
    room.privateRoles.delete(id);
    publishSeats(room);
    identity(room, id, room.peers.get(id));
  };
  const replay = (room, socket) => {
    if (room.edition) send(socket, 'edition', room.edition);
    if (room.initialized) send(socket, 'gs', snapshot(room));
    for (const [key, value] of Object.entries(room.flags)) send(socket, key, value);
  };
  const normalize = (room, type, payload, privateMessage = false) => {
    switch (type) {
      case 'edition':
        if (!payload?.edition || typeof payload.edition !== 'object' || Array.isArray(payload.edition) || (payload.roles !== undefined && !Array.isArray(payload.roles))) return;
        room.edition = payload;
        return payload;
      case 'gs': {
        if (!payload || !Array.isArray(payload.gamestate) || payload.gamestate.length > 20) return;
        if (payload.round && payload.round !== room.round) return;
        const incoming = publicSeats(room, payload.gamestate);
        // An ordinary host snapshot can edit/reorder seats, but cannot release
        // a confirmed owner. Ownership changes use claim/release/leave only.
        if (new Set(incoming.map(s => s.seatKey)).size !== incoming.length) return;
        if (room.initialized) incoming.forEach((seat, index) => {
          const previous = payload.gamestate[index]?.seatKey ? room.seats.find(s => s.seatKey === seat.seatKey) : room.seats[index];
          if (previous && !payload.gamestate[index]?.seatKey) seat.seatKey = previous.seatKey;
          seat.id = previous?.id || '';
        });
        if (!room.initialized) incoming.forEach(seat => { if (!room.credentials.has(seat.id)) seat.id = ''; });
        const ids = new Set();
        incoming.forEach(seat => { if (seat.id && ids.has(seat.id)) seat.id = ''; if (seat.id) ids.add(seat.id); });
        room.seats = incoming;
        prunePrivate(room);
        if (!payload.isLightweight) {
          room.state = {
            isNight: !!payload.isNight,
            isVoteHistoryAllowed: payload.isVoteHistoryAllowed !== false,
            nomination: validNomination(room, payload.nomination) ? payload.nomination : false,
            votingSpeed: validSpeed(payload.votingSpeed) ? payload.votingSpeed : 3000,
            lockedVote: Number.isInteger(payload.lockedVote) ? Math.max(0, Math.min(room.seats.length + 1, payload.lockedVote)) : 0,
            isVoteInProgress: !!payload.isVoteInProgress,
            markedPlayer: indexOfSeat(room, payload.markedPlayer) ? payload.markedPlayer : -1,
            fabled: Array.isArray(payload.fabled) ? payload.fabled : [],
            votes: Array.isArray(payload.votes) ? payload.votes.slice(0, room.seats.length).map(Boolean) : []
          };
          room.initialized = true;
        }
        return payload.isLightweight ? { gamestate: room.seats, isLightweight: true } : snapshot(room);
      }
      case 'player': {
        if (!payload || !indexOfSeat(room, payload.index)) return;
        const { index, property, value } = payload;
        if (property === 'role') {
          if (!text(value, 100) || (payload.round && payload.round !== room.round)) return;
          if (!privateMessage && value && !isTraveler(room, value)) return;
          if (!privateMessage) {
            if (value) room.seats[index].roleId = value;
            else delete room.seats[index].roleId;
          }
          return { index, property, value, extra: privateMessage && Array.isArray(payload.extra?.bluffs) ? { bluffs: payload.extra.bluffs } : {} };
        }
        if (!['name', 'pronouns', 'isDead', 'isVoteless'].includes(property)) return;
        if (['isDead', 'isVoteless'].includes(property) ? typeof value !== 'boolean' : !text(value)) return;
        room.seats[index][property] = value;
        return { index, property, value };
      }
      case 'fabled':
        if (!Array.isArray(payload)) return;
        room.state.fabled = payload;
        return payload;
      case 'nomination':
        if (payload && !validNomination(room, payload)) return;
        room.state.nomination = payload || false;
        room.state.votes = [];
        room.state.lockedVote = 0;
        room.state.isVoteInProgress = false;
        return payload || false;
      case 'marked':
        if (payload !== -1 && !indexOfSeat(room, payload)) return;
        room.state.markedPlayer = payload;
        return payload;
      case 'votingSpeed':
        if (!validSpeed(payload)) return;
        room.state.votingSpeed = payload;
        return payload;
      case 'isNight': case 'isVoteHistoryAllowed': case 'isVoteInProgress': case 'isVote': case 'isPlayer':
        if (typeof payload !== 'boolean') return;
        if (type === 'isVote' || type === 'isPlayer') room.flags[type] = payload;
        else room.state[type] = payload;
        return payload;
      case 'clearVoteHistory': return null;
      case 'lock': {
        if (!Array.isArray(payload) || !Number.isInteger(payload[0]) || payload[0] < 0 || payload[0] > room.seats.length + 1 || !room.state.nomination) return;
        room.state.lockedVote = payload[0];
        return payload;
      }
      case 'swap': case 'move': {
        if (!Array.isArray(payload) || !payload.every(i => indexOfSeat(room, i)) || payload.length !== 2) return;
        const [a, b] = payload;
        if (type === 'swap') [room.seats[a], room.seats[b]] = [room.seats[b], room.seats[a]];
        else room.seats.splice(b, 0, room.seats.splice(a, 1)[0]);
        return payload;
      }
      case 'remove':
        if (!indexOfSeat(room, payload)) return;
        room.seats.splice(payload, 1);
        prunePrivate(room);
        return payload;
    }
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://local'); } catch { socket.destroy(); return; }
    const match = /^\/ws\/([a-z0-9]{1,10})\/([a-z0-9_-]{1,64})$/.exec(url.pathname);
    const origin = request.headers.origin;
    let sameOrigin = false;
    try { sameOrigin = !!origin && new URL(origin).host === request.headers.host; } catch { /* invalid origin */ }
    if (!match || (!sameOrigin && !allowedOrigins.includes(origin))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const token = url.searchParams.get('token') || '';
    if (!/^[a-f0-9]{64}$/.test(token)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, { roomId: match[1], peerId: match[2], token }));
  });
  wss.on('connection', (ws, { roomId, peerId, token }) => {
    const host = peerId === 'host';
    const tokenHash = digest(token);
    if (host && owners.has(roomId) && !same(owners.get(roomId).hash, tokenHash)) {
      ws.close(1000, '此小镇属于另一位说书人，请使用其他房间号。'); return;
    }
    cleanup();
    let room = rooms.get(roomId);
    if (!room) {
      room = { peers: new Map(), credentials: new Map(), seats: [], state: {}, flags: {}, initialized: false, host: null, updated: now(), offlineSince: null, round: randomBytes(16).toString('hex'), privateRoles: new Map(), requests: new Map() };
      rooms.set(roomId, room);
    }
    if (!host && room.credentials.has(peerId) && !same(room.credentials.get(peerId), tokenHash)) { ws.close(1000, '玩家身份校验失败。'); return; }
    if (!host && room.peers.size >= 64 && !room.peers.has(peerId)) { ws.close(1000, '小镇连接人数已达上限。'); return; }
    const old = room.peers.get(peerId);
    // A refresh can establish its new socket before the old page's close frame
    // arrives. Matching credentials resume the connection instead of rejecting
    // the legitimate storyteller or clearing the new tab's shared localStorage.
    if (old) old.close(1000, 'local-session-replaced');
    room.peers.set(peerId, ws);
    room.offlineSince = null;
    room.credentials.set(peerId, tokenHash);
    if (host) {
      room.host = ws;
      owners.set(roomId, { hash: tokenHash, lastSeen: now() });
      persist();
    }
    ws.isAlive = true;
    ws.latency = 0;
    ws.on('pong', () => { ws.isAlive = true; ws.latency = Math.max(0, Math.round((now() - ws.pingStart) / 2)) || 0; });
    let intervalStart = now(), count = 0;
    ws.on('message', raw => {
      if (room.peers.get(peerId) !== ws) return;
      if (now() - intervalStart > 30000) { intervalStart = now(); count = 0; }
      if (++count > (host ? 2000 : 150)) { ws.close(1008, '消息过于频繁。'); return; }
      let message;
      try { message = JSON.parse(raw.toString()); } catch { ws.close(1008, '无效消息。'); return; }
      if (!Array.isArray(message) || message.length < 1 || message.length > 2 || !text(message[0], 40)) { ws.close(1008, '无效消息。'); return; }
      const [type, payload] = message;
      room.updated = now();
      if (type === 'resume') {
        send(ws, 'resume', { ...seatState(room), initialized: room.initialized, hostOnline: !!room.host, onlinePeers: [...room.peers.keys()].filter(id => id !== 'host'), requestId: payload?.requestId, ...(host && room.initialized ? { snapshot: snapshot(room), flags: room.flags } : {}) });
        if (!host) { replay(room, ws); identity(room, peerId, ws); }
        return;
      }
      if (type === 'probe') { send(ws, 'probe', payload); return; }
      if (type === 'leave' && !host) { release(room, peerId); send(ws, 'left', null); return; }
      if (host && type === 'release') {
        const seat = room.seats.find(s => s.seatKey === payload?.seatKey);
        if (seat?.id) release(room, seat.id);
        return;
      }
      if (host && type === 'endRoom') {
        room.ended = true;
        broadcast(room, null, 'ended', null);
        rooms.delete(roomId); owners.delete(roomId); persist();
        for (const socket of room.peers.values()) socket.close(1000, 'local-room-ended');
        return;
      }
      if (host && (type === 'newRound' || type === 'resetRoles')) {
        if (!text(payload?.requestId, 64) || !payload.requestId) return;
        const result = remember(room, peerId + ':' + payload.requestId, () => {
          if (payload.round !== room.round) return { ok: false, requestId: payload.requestId, round: room.round };
          room.round = randomBytes(16).toString('hex');
          room.privateRoles.clear();
          room.seats.forEach(s => { delete s.roleId; s.isDead = false; s.isVoteless = false; });
          room.state = type === 'newRound'
            ? { ...room.state, isNight: true, fabled: [], nomination: false, votes: [], lockedVote: 0, isVoteInProgress: false, markedPlayer: -1 }
            : { ...room.state, fabled: [] };
          const changed = { round: room.round, requestId: payload.requestId, kind: type };
          broadcast(room, null, 'round', changed);
          broadcast(room, room.host, 'gs', snapshot(room));
          for (const [id, socket] of room.peers) if (id !== 'host') identity(room, id, socket);
          return { ...changed, ok: true };
        });
        send(ws, 'roundResult', result);
        return;
      }
      if (type === 'ping') {
        if (host) for (const [id, client] of room.peers) { if (id !== 'host') send(client, 'ping', [room.peers.size - 1, ws.latency + client.latency]); }
        else send(room.host, 'ping', [peerId, ws.latency + (room.host?.latency || 0)]);
        return;
      }
      if (type === 'direct') {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        if (!host) {
          const direct = payload.host;
          if (!Array.isArray(direct)) return;
          if (direct[0] === 'getGamestate') {
            replay(room, ws); identity(room, peerId, ws);
          } // Transport shutdown is presence only, never a logical leave.
          return;
        }
        for (const [recipient, direct] of Object.entries(payload)) {
          if (recipient === 'host' || !Array.isArray(direct)) continue;
          if (direct[0] === 'player' && direct[1]?.property === 'role' && room.seats[direct[1].index]?.id !== recipient) continue;
          const normalized = normalize(room, direct[0], direct[1], true);
          if (normalized !== undefined) {
            if (direct[0] === 'player' && normalized.property === 'role') {
              const credential = room.credentials.get(recipient);
              if (!credential) continue;
              room.privateRoles.set(recipient, { ...normalized, seatKey: room.seats[normalized.index].seatKey, credential, round: room.round });
              identity(room, recipient, room.peers.get(recipient));
              // Keep the original private message compatible with old clients.
              send(room.peers.get(recipient), 'player', { ...normalized, round: room.round });
            } else send(room.peers.get(recipient), direct[0], normalized);
          }
        }
        return;
      }
      if (type === 'claim' && !host) {
        const legacy = Array.isArray(payload);
        const requestId = legacy ? randomBytes(12).toString('hex') : payload?.requestId;
        if (!text(requestId, 64) || !requestId) return;
        const result = remember(room, peerId + ':' + requestId, () => {
          const seat = legacy ? payload[0] : payload.seatKey === null ? -1 : room.seats.findIndex(s => s.seatKey === payload.seatKey);
          const failure = error => ({ requestId, ok: false, error, round: room.round });
          if (!legacy && payload.round !== room.round) return failure('局面已更新，请重试。');
          if (seat !== -1 && !room.host) return failure('说书人暂时离线，请等待上线后入座。');
          if ((seat === -1 && !legacy && payload.seatKey !== null) || (seat !== -1 && !indexOfSeat(room, seat))) return failure('座位已变化，请重试。');
          if (seat !== -1 && room.seats[seat].id && room.seats[seat].id !== peerId) return failure('这个座位已被其他玩家占据，请选择其他座位。');
          const previous = room.seats.find(s => s.id === peerId);
          if (previous?.seatKey !== room.seats[seat]?.seatKey) room.privateRoles.delete(peerId);
          for (const p of room.seats) if (p.id === peerId) p.id = '';
          if (seat !== -1) room.seats[seat].id = peerId;
          send(room.host, 'claim', [seat, peerId]);
          publishSeats(room);
          identity(room, peerId, ws);
          return { requestId, ok: true, round: room.round, seatKey: room.seats[seat]?.seatKey || null };
        });
        send(ws, 'claimResult', result);
        return;
      }
      if (type === 'pronouns') {
        if (!Array.isArray(payload) || !indexOfSeat(room, payload[0]) || !text(payload[1])) return;
        if (!host && room.seats[payload[0]].id !== peerId) return;
        room.seats[payload[0]].pronouns = payload[1];
        broadcast(room, ws, type, payload);
        return;
      }
      if (type === 'vote') {
        if (!Array.isArray(payload) || !indexOfSeat(room, payload[0]) || typeof payload[1] !== 'boolean' || !room.state.nomination) return;
        const [seat, vote] = payload;
        if (!host) {
          const player = room.seats[seat];
          const exile = isTraveler(room, room.seats[room.state.nomination[1]]?.roleId);
          if (player.id !== peerId || (player.isDead && player.isVoteless && !exile)) return;
          const order = (seat - 1 + room.seats.length - room.state.nomination[1]) % room.seats.length;
          if (order < room.state.lockedVote - 1) return;
        }
        room.state.votes[seat] = vote;
        broadcast(room, ws, type, [seat, vote, host]);
        return;
      }
      if (!host) return;
      const normalized = normalize(room, type, payload);
      if (normalized !== undefined) {
        broadcast(room, ws, type, normalized);
        if (['gs', 'swap', 'move', 'remove'].includes(type)) { publishSeats(room); for (const [id, client] of room.peers) if (id !== 'host') identity(room, id, client); }
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (room.ended || room.peers.get(peerId) !== ws) return;
      room.peers.delete(peerId);
      room.updated = now();
      if (host) {
        room.host = null;
        owners.get(roomId).lastSeen = now();
        persist();
      } else send(room.host, 'bye', peerId);
      if (!room.peers.size) room.offlineSince = now();
    });
  });
  const cleanup = () => {
    const time = now();
    for (const [id, room] of rooms) if (!room.peers.size && room.offlineSince !== null && time - room.offlineSince >= 24 * 60 * 60 * 1000) rooms.delete(id);
    let changed = false;
    for (const [id, owner] of owners) if (!rooms.get(id)?.host && time - owner.lastSeen > 7 * 86400000) { owners.delete(id); changed = true; }
    if (changed) persist();
  };
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.pingStart = now();
      ws.ping();
    }
    cleanup();
  }, 30000);
  heartbeat.unref();
  return {
    rooms, cleanup,
    close: async () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
    }
  };
}

const validNomination = (room, value) => Array.isArray(value) && value.length === 2 && value.every(i => indexOfSeat(room, i));
const validSpeed = value => Number.isFinite(value) && value >= 100 && value <= 120000;
