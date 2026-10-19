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
    # Reuse the town-ring target selection used by seat exchange, with its
    # own mode/icon so the player objects and seat ownership never move.
    anchor='i("li",{class:{disabled:e.session.lockedVote},on:{click:function(t){return e.swapPlayer()}}},[i("font-awesome-icon",{attrs:{icon:"exchange-alt"}}),e._v(" 换座 ")],1)'
    button='i("li",{on:{click:function(t){t.stopPropagation();return e.swapRoles()}}},[i("font-awesome-icon",{attrs:{icon:"people-arrows"}}),e._v(" 交换角色 ")],1),'
    replace(anchor, button + anchor.replace(' 换座 ', ' 交换座位 '))
    replace('swapPlayer(e){this.isMenuOpen=!1,', 'swapRoles(e){this.player.isMenuOpen=false;this.isMenuOpen=false;this.$emit("trigger",["swapRoles",e])},swapPlayer(e){this.isMenuOpen=!1,')
    anchor='i("font-awesome-icon",{staticClass:"swap",attrs:{icon:"exchange-alt",title:"与此玩家交换座位"},on:{click:function(t){return e.swapPlayer(e.player)}}})'
    icon='i("font-awesome-icon",{staticClass:"swap-roles",attrs:{icon:"people-arrows",title:"与此玩家交换角色"},on:{click:function(t){t.stopPropagation();return e.swapRoles(e.player)}}})'
    replace(anchor, anchor + ',' + icon)
    replace('class:{from:Math.max(e.swap,e.move,e.nominate)===s,swap:e.swap>-1,', 'class:{from:Math.max(e.swap,e.move,e.nominate,e.roleSwap)===s,"swap-roles":e.roleSwap>-1,swap:e.swap>-1,')
    replace('D={components:', 'D={watch:{players(){if(this.roleSwapSelection){const index=this.players.indexOf(this.roleSwapSelection.source);if(index<0)this.cancel();else this.roleSwap=index}},"session.sessionId"(){this.cancel()},"session.isSpectator"(value){if(value)this.cancel()}},components:')
    replace('swap:-1,move:-1,nominate:-1,', 'swap:-1,move:-1,nominate:-1,roleSwap:-1,roleSwapSelection:null,')
    replace('swapPlayer(e,t){', 'swapRoles(e,t){if(void 0===t){this.cancel();const selection=window.ClocktowerLocal.beginRoleSwap(this.players[e]);if(selection){this.roleSwap=e;this.roleSwapSelection=selection}}else{window.ClocktowerLocal.completeRoleSwap(this.roleSwapSelection,t);this.cancel()}},swapPlayer(e,t){')
    replace('cancel(){this.move=-1,this.swap=-1,this.nominate=-1}', 'cancel(){this.move=-1,this.swap=-1,this.nominate=-1,this.roleSwap=-1,this.roleSwapSelection=null}')
    replace('Pt={clear(e)', 'Pt={swapRoles(e,[a,b]){const first=e.players[a],second=e.players[b];if(first&&second&&a!==b)[first.role,second.role]=[second.role,first.role]},clear(e)')
    replace('case"players/swap":t.swapPlayer(i);', 'case"players/swapRoles":t.sendSwappedRoles(i);break;case"players/swap":t.swapPlayer(i);')
    replace('case"players/set":case"players/swap":case"players/move":', 'case"players/set":case"players/swapRoles":case"players/swap":case"players/move":')
    return source


def patch_session_css(source):
    # Mirror each original seat-exchange selector, including hover, source
    # cancellation and target hit areas; only the icon and mode differ.
    import re
    matches = 0
    def selectors(match):
        nonlocal matches
        original = match[0][:-1]
        extra = [selector.replace('svg.swap', 'svg.swap-roles').replace('li.swap:', 'li.swap-roles:')
                 for selector in original.split(',') if '.player .overlay svg.swap' in selector]
        matches += len(extra)
        return original + ',' + ','.join(extra) + '{'
    source = re.sub(r'[^{}]*\.player \.overlay svg\.swap[^{}]*\{', selectors, source)
    assert matches == 6, 'Role exchange CSS targets changed'
    return source
