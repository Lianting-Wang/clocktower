"""Checked, repeatable integration points for the captured Vue frontend."""
def patch_session(source):
    def replace(old, new, count=1):
        nonlocal source
        assert source.count(old) == count, 'Local session patch target changed: ' + old[:90]
        source = source.replace(old, new)
    replace('this._store.state.session.sessionId&&this.connect(this._store.state.session.sessionId)}_open', 'false}_open')
    replace('const t=new Ct(e);e.subscribe', 'const t=new (window.ClocktowerLocal.session(Ct,St))(e);e.subscribe')
    replace('const i=window.location.hash.substr(1);i&&', 'const i=window.ClocktowerLocal.invitation();i&&')
    replace('!window.location.hash.substr(1)', '!window.ClocktowerLocal.invitation()')
    replace('name:e.name,id:e.id,isDead:e.isDead', 'name:e.name,id:e.id,seatKey:e.seatKey,isDead:e.isDead')
    replace('claimSeat(){this.isMenuOpen=!1,this.$emit("trigger",["claimSeat"]),this.grimoire.isSeat=!this.grimoire.isSeat}', 'claimSeat(){this.isMenuOpen=!1,this.$emit("trigger",["claimSeat"])}')
    replace('copySessionUrl(){const e=window.location.href.split("#")[0],t=e+"#"+this.session.sessionId;navigator.clipboard.writeText(t)}', 'copySessionUrl(){window.ClocktowerLocal.copyInvite(this.session.sessionId)}')
    replace('t.match(/^https?:\\/\\//i)&&(t=t.split("#").pop()),t&&', 't=window.ClocktowerLocal.roomFrom(t),t&&')
    replace('e.$store.dispatch("players/clearRoles")', 'e.session.sessionId&&!e.session.isSpectator?window.ClocktowerLocal.resetRoles():e.$store.dispatch("players/clearRoles")')
    replace('s=e.players.map(({name:e,id:t,pronouns:i})=>({...xt,name:e,id:t,pronouns:i}))', 's=e.players.map(({name:e,id:t,pronouns:i,seatKey:s})=>({...xt,name:e,id:t,pronouns:i,seatKey:s}))')
    # Network metadata is deliberately absent from the original manual JSON.
    replace('players:this.players.players.map(e=>({...e,role:e.role.id||{}}))', 'players:this.players.players.map(({seatKey:t,...e})=>({...e,role:e.role.id||{}}))')
    replace('r.map(e=>({...e,role:this.$store.state.roles.get(e.role)', 'r.map(({seatKey:t,...e})=>({...e,role:this.$store.state.roles.get(e.role)')
    # Two host-only actions next to the existing role distribution menu.
    anchor='[e._v(" 发送角色 "),s("em",[e._v("[I]")])]),'
    buttons='e.session.sessionId&&!e.session.isSpectator?s("li",{on:{click:function(t){t.stopPropagation();window.ClocktowerLocal.copyInvite(e.session.sessionId)}}},[e._v(" 复制邀请链接 ")]):e._e(),e.session.sessionId&&!e.session.isSpectator?s("li",{on:{click:function(t){t.stopPropagation();window.ClocktowerLocal.newRound()}}},[e._v(" 开始新局，保留座位 ")]):e._e(),e.session.sessionId&&!e.session.isSpectator?s("li",{on:{click:function(t){t.stopPropagation();window.ClocktowerLocal.endRoom()}}},[e._v(" 结束房间 ")]):e._e(),'
    replace(anchor, anchor+buttons)
    # The existing host seat-release entry now uses the authoritative protocol.
    replace('return e.updatePlayer("id","",!0)', 'e.isMenuOpen=false;window.ClocktowerLocal.release(e.index)')
    replace('e._v(" 清空位置 ")', 'e._v(" 释放座位 ")')
    return source
