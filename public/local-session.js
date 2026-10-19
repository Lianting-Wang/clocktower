/* Persistent local membership around the captured frontend. No external requests. */
(() => {
  'use strict';
  const key = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  const roomFrom = value => {
    if (!value) return '';
    let room = String(value).trim();
    if (/^https?:\/\//i.test(room)) {
      try { const url = new URL(room); room = url.searchParams.get('room') || url.hash.slice(1); } catch { return ''; }
    }
    return /^[a-z0-9]{1,10}$/i.test(room) ? room.toLowerCase() : '';
  };
  const invitation = () => roomFrom(new URL(location.href).searchParams.get('room') || location.hash.slice(1));
  const cleanUrl = () => { const url = new URL(location.href); url.searchParams.delete('room'); url.hash = ''; history.replaceState(null, '', url); };
  let active;
  window.ClocktowerLocal = {
    roomFrom, invitation,
    beginRoleSwap(source) {
      if (!active || active._store.state.session.isSpectator || !active.players.includes(source) || active.players.length < 2) return null;
      return { source, role: source.role, room: active.room, round: active._round };
    },
    completeRoleSwap(selection, target) {
      if (!active || !selection || active._store.state.session.isSpectator || target === selection.source) return;
      const { source, role, room, round } = selection;
      // Keep the selection tied to this player and round while the storyteller
      // picks a target directly on the town ring.
      if (active.room !== room || active._round !== round || !active.players.includes(source) || !active.players.includes(target) || source.role !== role) {
        active.notice('座位或角色已变化，请重新选择交换角色。'); return;
      }
      active._store.commit('players/swapRoles', [active.players.indexOf(source), active.players.indexOf(target)]);
      active.status(room ? '角色已交换。需要同步玩家手机时，请点“发送角色”。' : '角色已交换。');
    },
    copyInvite(room) {
      const url = new URL('/', location.origin); url.searchParams.set('room', room);
      navigator.clipboard.writeText(url.href);
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) active?.notice('邀请链接已复制。手机访问时，请将 127.0.0.1／localhost 换成电脑的局域网 IP，并用该地址重新打开后复制。');
      else active?.notice('邀请链接已复制。');
    },
    newRound() { active?.newRound(); },
    endRoom() { active?.endRoom(); },
    release(index) { active?.release(index); },
    resetRoles() { active?.resetRoles(); },
    session: (Base, dialogs) => class LocalSession extends Base {
      constructor(store) {
        super(store);
        active = this;
        // The captured base defaults to spectator until connect(). An offline
        // storyteller never connects, and must not have roles masked/saved as
        // empty when pagehide runs during refresh.
        this._isSpectator = store.state.session.isSpectator;
        this._dialogs = dialogs;
        this._ready = false;
        this._applying = false;
        this._paused = false;
        this._attempt = 0;
        this._round = '';
        this._status = '';
        this._pendingClaim = null;
        this._pendingRound = null;
        this._resumeCheck = () => { clearTimeout(this._visibilityTimer); this._visibilityTimer = setTimeout(() => this.checkConnection(), 100); };
        window.addEventListener('pageshow', this._resumeCheck);
        window.addEventListener('online', this._resumeCheck);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') this._resumeCheck();
          else if (this._isSpectator) this.hideIdentity();
        });
        window.addEventListener('pagehide', () => { if (this._isSpectator) this.hideIdentity(); this.closeTransport(); });
        if (store.state.session.sessionId) this.connect(store.state.session.sessionId);
      }
      get players() { return this._store.state.players.players; }
      get room() { return this._store.state.session.sessionId; }
      apply(fn) { const previous = this._applying; this._applying = true; try { return fn(); } finally { this._applying = previous; } }
      notice(message) { this._dialogs.alert(message); }
      status(message, action = '') {
        this._status = message;
        let box = document.getElementById('local-session-status');
        if (!box) {
          box = document.createElement('div'); box.id = 'local-session-status'; box.setAttribute('role', 'status');
          box.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);max-width:85vw;padding:9px 15px;border:1px solid #ac9568;border-radius:5px;background:rgba(22,24,24,.95);color:#eee4cb;font-size:14px;text-align:center;z-index:9999;box-shadow:0 2px 8px #0008;';
          document.body.append(box);
        }
        box.replaceChildren(); box.hidden = !message;
        box.append(document.createTextNode(message));
        if (action) {
          const button = document.createElement('button'); button.textContent = action;
          button.style.cssText = 'margin-left:10px;color:inherit;background:transparent;border:1px solid #ac9568;border-radius:3px;padding:4px 8px;cursor:pointer;';
          button.onclick = () => { this._paused = false; this._attempt = 0; this.reconnect(); };
          box.append(button);
        }
      }
      hideIdentity() {
        if (!this._store.state.players) return;
        this.apply(() => {
          for (const player of this.players) if (player.role?.team !== 'traveler') this._store.commit('players/update', { player, property: 'role', value: {} });
          this._store.commit('players/setBluff');
        });
      }
      syncSeated() {
        const session = this._store.state.session;
        this._store.state.grimoire.isSeat = this._isSpectator && this.players.some(p => p.id === session.playerId);
      }
      connect(room) {
        if (this._paused) return;
        if (this._currentChannel === room && this._socket?.readyState < 2 && this._isSpectator === this._store.state.session.isSpectator) return;
        if (!room) return;
        if (this._currentChannel && this._currentChannel !== room) this._pendingClaim = this._pendingRound = null;
        if (!this._store.state.session.playerId) this._store.commit('session/setPlayerId', key());
        this._isSpectator = this._store.state.session.isSpectator;
        this._open(room);
      }
      _open(room) {
        this.closeTransport();
        this._ready = false;
        if (this._isSpectator) this.hideIdentity();
        this.status('正在连接房间并恢复状态…');
        this._store.commit('session/setReconnecting', true);
        const socket = new WebSocket(this._wss + room + '/' + (this._isSpectator ? this._store.state.session.playerId : 'host'));
        this._socket = socket; this._currentChannel = room;
        socket.addEventListener('message', event => { if (this._socket === socket) this._handleMessage(event); });
        socket.onopen = () => {
          if (this._socket !== socket) return;
          this.raw('resume', { requestId: key() });
          this._ping();
        };
        socket.onerror = () => {};
        socket.onclose = event => {
          if (this._socket !== socket) return;
          this.closeTransport(); this._ready = false;
          if (this._isSpectator) this.hideIdentity();
          if (event.reason === 'local-session-replaced') {
            this._paused = true; this._store.commit('session/setReconnecting', false);
            this.status('此身份已在另一个页面打开。', '在此接管'); return;
          }
          if (event.code === 1000 && event.reason && event.reason !== 'local-room-ended') {
            this._paused = true; this.status(event.reason, '重试连接'); return;
          }
          if (event.reason === 'local-room-ended') { this.finishRoom(); return; }
          this.scheduleReconnect();
        };
        this._connectDeadline = setTimeout(() => { if (this._socket === socket && !this._ready) { this.closeTransport(); this.scheduleReconnect(); } }, 8000);
      }
      closeTransport() {
        for (const name of ['_pingTimer', '_reconnectTimer', '_connectDeadline', '_probeTimer', '_claimTimer', '_roundTimer']) { clearTimeout(this[name]); this[name] = null; }
        const socket = this._socket; this._socket = null; this._currentChannel = null;
        if (socket?.readyState < 2) socket.close(1000);
      }
      disconnect() {
        // This method is called by the original explicit Leave menu. Passive
        // network replacement uses closeTransport and never releases a seat.
        if (this._isSpectator) this.raw('leave', null);
        this.closeTransport(); this._ready = false; this._paused = false;
        this._pendingClaim = this._pendingRound = null;
        this._store.commit('session/setReconnecting', false); this.status(''); cleanUrl();
      }
      scheduleReconnect() {
        if (!this.room || this._paused) return;
        this._store.commit('session/setReconnecting', true);
        this.status('连接已中断，座位与已发身份仍保留，正在重连…', '立即重连');
        clearTimeout(this._reconnectTimer);
        const delay = Math.min(30000, 1000 * 2 ** Math.min(this._attempt++, 5));
        this._reconnectTimer = setTimeout(() => this.connect(this.room), delay);
      }
      reconnect() { if (this.room && !this._paused) { this.closeTransport(); this.connect(this.room); } }
      checkConnection() {
        if (!this.room || this._paused) return;
        if (this._socket?.readyState === 0) return;
        if (this._socket?.readyState !== 1) { this.reconnect(); return; }
        if (this._probeTimer) return;
        if (this._isSpectator) { this.hideIdentity(); this.status('正在恢复本局身份…'); }
        this._probeId = key(); this.raw('probe', this._probeId);
        this._probeTimer = setTimeout(() => this.reconnect(), 3000);
      }
      raw(type, payload) { if (this._socket?.readyState === 1) this._socket.send(JSON.stringify([type, payload])); }
      _send(type, payload) {
        if (this._applying || !this._ready) return;
        if (type === 'gs') payload = { ...payload, round: this._round };
        if (type === 'direct') {
          payload = Object.fromEntries(Object.entries(payload).map(([id, message]) => [id, message[0] === 'player' && message[1]?.property === 'role' ? [message[0], { ...message[1], round: this._round }] : message]));
        }
        this.raw(type, payload);
      }
      _ping() {
        this._send('ping', [this._isSpectator ? this._store.state.session.playerId : Object.keys(this._players).length, 'latency']);
        clearTimeout(this._pingTimer); this._pingTimer = setTimeout(() => this._ping(), this._pingInterval);
      }
      _handleMessage(event) {
        let type, payload;
        try { [type, payload] = JSON.parse(event.data); } catch { return; }
        if (type === 'probe' && payload === this._probeId) {
          clearTimeout(this._probeTimer); this._probeTimer = null;
          this.raw('resume', { requestId: key() }); return;
        }
        if (type === 'resume') {
          clearTimeout(this._connectDeadline);
          const previous = localStorage.getItem('clocktower.local.round.' + this.room);
          this._round = payload.round; this._initialized = payload.initialized;
          if (this._isSpectator && !payload.initialized) this.apply(() => this._store.commit('players/clear'));
          if (previous && previous !== payload.round && payload.initialized) this.resetLocalRound();
          localStorage.setItem('clocktower.local.round.' + this.room, payload.round);
          this._ready = true; this._attempt = 0;
          this._store.commit('session/setReconnecting', false);
          if (!this._isSpectator) {
            this._players = Object.fromEntries((payload.onlinePeers || []).map(id => [id, Date.now()]));
            this._store.commit('session/setPlayerCount', Object.keys(this._players).length);
            if (payload.snapshot) this.restoreHost(payload.snapshot, payload.flags);
            this.ownership(payload);
            this.sendGamestate();
            this.status('');
          }
          this._ping();
          if (this._pendingClaim) this.sendClaim();
          if (this._pendingRound) this.sendRound();
          return;
        }
        if (type === 'seats') { if (payload.round === this._round) this.ownership(payload); return; }
        if (type === 'identity') {
          if (!this._isSpectator || payload.round !== this._round) return;
          this.hideIdentity();
          const player = this.players[payload.index];
          if (payload.assigned && player?.id === this._store.state.session.playerId && player.seatKey === payload.seatKey) {
            this.apply(() => super._updatePlayer({ index: payload.index, property: 'role', value: payload.value, extra: payload.extra }));
          }
          this.syncSeated();
          this.status(payload.assigned ? '' : this._store.state.grimoire.isSeat ? '已恢复座位，等待说书人发放本局身份。' : this._initialized === false ? '等待说书人上线并设置座位。' : '已连接，请选择空座位入座。');
          return;
        }
        if (type === 'claimResult') {
          if (this._pendingClaim?.requestId !== payload.requestId) return;
          clearTimeout(this._claimTimer); this._pendingClaim = null; this.syncSeated();
          if (!payload.ok) { this.status(payload.error); this.notice(payload.error); }
          else this.status(this._store.state.grimoire.isSeat ? '入座成功，等待说书人发放身份。' : '已起身，可重新选择座位。');
          return;
        }
        if (type === 'roundResult') {
          if (this._pendingRound?.requestId !== payload.requestId) return;
          clearTimeout(this._roundTimer); this._pendingRound = null;
          if (!payload.ok || payload.round !== this._round) this.checkConnection();
          return;
        }
        if (type === 'round') {
          if (payload.round !== this._round) { this._round = payload.round; this.resetLocalRound(payload.kind); }
          localStorage.setItem('clocktower.local.round.' + this.room, payload.round);
          this.status(payload.kind === 'resetRoles' ? '角色已重置，座位已保留。' : this._isSpectator ? '新一局已开始，等待说书人发放身份。' : '新一局已开始，座位已保留。'); return;
        }
        if (type === 'ended') { this.finishRoom(); return; }
        if (type === 'player' && payload.property === 'role' && payload.round) return; // handled only by authenticated identity envelope
        if (!this._ready || (payload?.round && payload.round !== this._round)) return;
        this.apply(() => super._handleMessage(event));
      }
      ownership({ seats, initialized }) {
        this.apply(() => {
          this.players.forEach((player, index) => {
            const seat = player.seatKey ? seats.find(s => s.seatKey === player.seatKey) : seats[index];
            if (seat) {
              this._store.commit('players/update', { player, property: 'seatKey', value: seat.seatKey });
              this._store.commit('players/update', { player, property: 'id', value: seat.id });
            } else if (initialized !== false) this._store.commit('players/update', { player, property: 'id', value: '' });
          });
        });
        this.syncSeated();
      }
      restoreHost(snapshot, flags = {}) {
        this.apply(() => {
          const existing = this.players;
          this._store.commit('players/set', snapshot.gamestate.map((seat, index) => {
            const saved = existing.find(p => p.seatKey === seat.seatKey) || (!existing[index]?.seatKey ? existing[index] : null);
            const role = saved?.role || this._store.state.roles.get(seat.roleId) || this._store.getters.rolesJSONbyId.get(seat.roleId) || {};
            return { reminders: [], isMenuOpen: false, ...saved, ...seat, role };
          }));
          this._store.commit('toggleNight', !!snapshot.isNight);
          this._store.commit('session/setVoteHistoryAllowed', snapshot.isVoteHistoryAllowed);
          this._store.commit('session/nomination', { nomination: snapshot.nomination, votes: snapshot.votes, votingSpeed: snapshot.votingSpeed, lockedVote: snapshot.lockedVote, isVoteInProgress: snapshot.isVoteInProgress });
          this._store.commit('session/setMarkedPlayer', snapshot.markedPlayer);
          this._store.commit('players/setFabled', { fabled: (snapshot.fabled || []).map(role => this._store.state.fabled.get(role.id) || role) });
          if (typeof flags.isVote === 'boolean') this._store.commit('toggleVote', flags.isVote);
          if (typeof flags.isPlayer === 'boolean') this._store.commit('togglePlayer', flags.isPlayer);
          if (!this._store.state.grimoire.isCustomBg) {
            this._store.commit('setBackgroundClass', snapshot.isNight ? 'night' : 'bg_day');
            document.body.className = this._store.state.grimoire.backgroundClass;
          }
        });
      }
      sendGamestate(peer = '', lightweight = false) {
        if (!this._ready || this._isSpectator || this._applying) return;
        this.apply(() => { for (const player of this.players) if (!player.seatKey) this._store.commit('players/update', { player, property: 'seatKey', value: key() }); });
        super.sendGamestate(peer, lightweight);
      }
      _updateGamestate(payload) {
        this._initialized = true;
        this.hideIdentity();
        super._updateGamestate(payload);
        payload.gamestate.forEach((seat, index) => this._store.commit('players/update', { player: this.players[index], property: 'seatKey', value: seat.seatKey }));
        this.syncSeated();
      }
      sendEdition(peer = '') {
        if (this._isSpectator) return;
        const edition = this._store.state.edition;
        this._sendDirect(peer, 'edition', { edition: edition.isOfficial ? { id: edition.id } : edition, ...(!edition.isOfficial ? { roles: this._store.getters.customRolesStripped } : {}) });
      }
      sendPlayer(payload) {
        if (['id', 'seatKey'].includes(payload.property) || this._applying || !this._ready) return;
        if (!this._gamestate[this.players.indexOf(payload.player)]) return;
        super.sendPlayer(payload);
      }
      sendSwappedRoles(indices) {
        if (this._isSpectator || this._applying) return;
        for (const index of indices) {
          const player = this.players[index];
          if (player) this.sendPlayer({ player, property: 'role', value: player.role });
        }
      }
      _handlePing([peer = 0, latency] = []) {
        // Presence must never edit seat ownership.
        if (this._isSpectator) { this._store.commit('session/setPlayerCount', peer); if (latency) this._store.commit('session/setPing', parseInt(latency, 10)); }
        else if (peer) { this._players[peer] = Date.now(); this._store.commit('session/setPlayerCount', Object.keys(this._players).length); }
      }
      _updateSeat() {} // server's seats event is authoritative
      claimSeat(index) {
        if (!this._isSpectator || this._pendingClaim) return;
        if (!this._ready || this._socket?.readyState !== 1) { this.notice('尚未连接房间，请等待恢复连接后重试入座。'); this.checkConnection(); return; }
        this._pendingClaim = { requestId: key(), round: this._round, seatKey: index < 0 ? null : this.players[index]?.seatKey };
        this.sendClaim();
      }
      sendClaim() {
        const request = this._pendingClaim; if (!request) return;
        this.status(request.seatKey ? '正在入座，请稍候…' : '正在起身，请稍候…');
        this.raw('claim', request);
        clearTimeout(this._claimTimer);
        this._claimTimer = setTimeout(() => {
          if (!this._pendingClaim) return;
          this.raw('claim', request); // same request ID: lost acknowledgements are safe
          this._claimTimer = setTimeout(() => {
            if (!this._pendingClaim) return;
            this._pendingClaim = null;
            this.notice('入座确认超时，正在重新核对座位。恢复后可重试。'); this.checkConnection();
          }, 4000);
        }, 4000);
      }
      resetLocalRound(kind = 'newRound') {
        this.apply(() => {
          this._store.commit('players/set', this.players.map(p => ({ ...p, role: {}, reminders: [], isDead: false, isVoteless: false, isMarked: false, isMenuOpen: false })));
          this._store.commit('players/setBluff'); this._store.commit('players/setFabled', { fabled: [] });
          this._store.commit('session/distributeRoles', false);
          if (kind === 'newRound') {
            this._store.commit('session/nomination', {}); this._store.commit('session/clearVoteHistory');
            this._store.commit('session/setMarkedPlayer', -1);
            this._store.commit('toggleNight', true);
            if (!this._store.state.grimoire.isCustomBg) { this._store.commit('setBackgroundClass', 'night'); document.body.className = this._store.state.grimoire.backgroundClass; }
          }
        });
        this._gamestate = this.players.map(p => ({ ...p })); this.syncSeated();
      }
      requestRound(kind) {
        if (this._isSpectator || !this._ready || this._socket?.readyState !== 1) { this.notice('请先恢复说书人连接。'); return; }
        if (this._pendingRound) return;
        this._pendingRound = { kind, requestId: key(), round: this._round }; this.sendRound();
      }
      sendRound() {
        if (!this._pendingRound) return;
        this.raw(this._pendingRound.kind, this._pendingRound);
        clearTimeout(this._roundTimer);
        this._roundTimer = setTimeout(() => { if (this._pendingRound) { this.checkConnection(); if (this._ready) this.sendRound(); } }, 5000);
      }
      newRound() { this._dialogs.confirm('开始新局并保留所有座位？将清空角色、标记、死亡状态、提名和投票记录。', () => this.requestRound('newRound')); }
      resetRoles() { this.requestRound('resetRoles'); }
      release(index) {
        const player = this.players[index]; if (this._isSpectator || !player?.id) return;
        this._dialogs.confirm('释放这个座位？玩家需要重新入座并接收身份。', () => {
          if (this._ready) this.raw('release', { seatKey: player.seatKey }); else this.notice('请先恢复连接。');
        });
      }
      endRoom() { this._dialogs.confirm('结束整个房间？所有玩家将离开，座位和已发身份缓存会被清除。', () => { if (this._ready) this.raw('endRoom', null); else this.notice('请先恢复连接。'); }); }
      finishRoom() {
        this.closeTransport(); this._ready = false; this._paused = false; this._pendingClaim = this._pendingRound = null;
        this.apply(() => {
          this._store.commit('session/setSessionId', ''); this._store.commit('session/setReconnecting', false);
          if (this._isSpectator) { this.hideIdentity(); this._store.commit('players/clear'); }
          else for (const player of this.players) this._store.commit('players/update', { player, property: 'id', value: '' });
        });
        cleanUrl(); this.status('房间已结束。');
      }
    }
  };
})();
