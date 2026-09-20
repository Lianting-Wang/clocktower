import { useEffect, useMemo, useRef, useState } from "react";
import { adjustedSetup, bluffCandidates, randomRoleSelection, setupTeams, standardSetup, type ExportedRoomState, type RoleDefinition, type RoleTeam } from "@clocktower/domain";
import type { ContentCatalog } from "@clocktower/protocol";

export const teamNames: Record<RoleTeam, string> = { townsfolk: "镇民", outsider: "外来者", minion: "爪牙", demon: "恶魔", traveler: "旅行者", fabled: "奇遇" };
export function RoleImage({ role }: { role: RoleDefinition }) {
  return <img className="role-image" src={role.image ?? `https://oss.gstonegames.com/data_file/clocktower/role_icon/${role.imageAlt ?? role.id}.png`} alt="" loading="lazy" onError={event => { event.currentTarget.style.visibility = "hidden"; }} />;
}

interface RolePickerProps {
  open: boolean;
  showTravelers: boolean;
  onShowTravelersChange: (show: boolean) => void;
  room: ExportedRoomState;
  catalog: ContentCatalog | null;
  onClose: () => void;
  onSend: (message: Record<string, unknown>) => void;
  serverError: string | null;
}

export function RolePicker({ open, room, catalog, onClose, onSend, serverError, showTravelers, onShowTravelersChange }: RolePickerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bluffs, setBluffs] = useState<string[]>([]);
  const [drunkAs, setDrunkAs] = useState("");
  const [mode, setMode] = useState<"roles" | "bluffs">("roles");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const roles = useMemo(() => {
    const all = new Map([...(catalog?.roles ?? []), ...(room.customScript?.roles ?? [])].map(role => [role.id, role]));
    return (room.edition?.roles ?? []).map(id => all.get(id)).filter((role): role is RoleDefinition => !!role);
  }, [catalog, room.edition, room.customScript]);
  const byId = new Map(roles.map(role => [role.id, role]));
  const travelers = selected.filter(id => byId.get(id)?.team === "traveler");
  const playerCount = room.players.length - travelers.length;
  const recommended = adjustedSetup(playerCount, selected);
  const actual = Object.fromEntries(setupTeams.map(team => [team, selected.filter(id => byId.get(id)?.team === team).length]));
  const validBluffs = bluffCandidates(roles, selected, drunkAs);
  const needsBluffs = playerCount >= 7 && actual.demon > 0;
  const drunkChoices = roles.filter(role => role.team === "townsfolk" && !selected.includes(role.id));
  const countMatches = selected.length === room.players.length && selected.length > 0;
  const bluffError = (needsBluffs || bluffs.length > 0) && bluffs.length !== 3;
  const canDistribute = countMatches && !bluffError && (!selected.includes("drunk") || drunkChoices.some(role => role.id === drunkAs)) && bluffs.every(id => validBluffs.some(role => role.id === id));
  const setupMismatch = recommended && setupTeams.some(team => actual[team] !== recommended[team]);
  const unsupportedSetup = selected.map(id => byId.get(id)).filter(role => role?.setup && !["baron", "drunk"].includes(role.id));

  useEffect(() => {
    setSelected(room.players.flatMap(player => player.roleId ? [player.roleId] : []));
    setBluffs(room.bluffRoleIds);
    setDrunkAs(room.players.find(player => player.roleId === "drunk")?.perceivedRoleId ?? "");
    setError(null);
  }, [room.id, room.edition?.id, room.edition?.roles.join(",")]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  const updateSelection = (next: string[]) => {
    setSelected(next);
    const nextDrunk = next.includes("drunk")
      ? roles.find(role => role.team === "townsfolk" && !next.includes(role.id) && role.id === drunkAs)?.id
        ?? roles.find(role => role.team === "townsfolk" && !next.includes(role.id))?.id ?? ""
      : "";
    setDrunkAs(nextDrunk);
    setBluffs(current => current.filter(id => !next.includes(id) && id !== nextDrunk));
    setError(null);
  };
  const randomize = () => {
    try { updateSelection([...randomRoleSelection(roles, playerCount), ...travelers]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法随机预选。"); }
  };
  const visible = (mode === "roles" ? roles : validBluffs).filter(role => `${role.name} ${role.ability}`.includes(query.trim()));

  return (
    <dialog ref={dialog} className="role-picker" aria-labelledby="role-picker-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="role-picker__layout">
        <header className="role-picker__header">
          <div><span className="eyebrow">PREPARE THE STORY</span><h2 id="role-picker-title">剧本与角色</h2><p>先预选，再调整。确认分发后，已入座的玩家才能看到自己的身份。</p></div>
          <button className="console-close" onClick={onClose} aria-label="关闭角色选择">关闭</button>
        </header>
        <div className="role-picker__toolbar">
          <label>当前剧本<select value={room.edition?.id ?? ""} onChange={event => { setSelected([]); setBluffs([]); setDrunkAs(""); onSend({ type: "set_edition", edition: catalog?.editions.find(edition => edition.id === event.target.value) ?? null }); }}>
            <option value="">选择剧本</option>
            {room.customScript ? <option value={room.customScript.edition.id}>{room.customScript.edition.name}</option> : null}
            {catalog?.editions.map(edition => <option key={edition.id} value={edition.id}>{edition.name}</option>)}
          </select></label>
          <label className="picker-search">搜索角色<input placeholder="角色名称或能力" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <button className="btn picker-random-mobile" disabled={!room.edition || !standardSetup(playerCount)} onClick={randomize}>按人数随机预选</button>
          <label className="traveler-toggle"><input type="checkbox" checked={showTravelers} onChange={event => onShowTravelersChange(event.target.checked)} />显示旅行者</label>
        </div>
        <div className="role-picker__body">
          <section className="role-picker__catalog">
            <div className="picker-tabs" aria-label="选择内容">
              <button className={mode === "roles" ? "active" : ""} aria-pressed={mode === "roles"} onClick={() => setMode("roles")}>入场角色 <span>{selected.length}</span></button>
              <button className={mode === "bluffs" ? "active" : ""} aria-pressed={mode === "bluffs"} onClick={() => setMode("bluffs")}>恶魔伪装 <span>{bluffs.length}/3</span></button>
            </div>
            {mode === "bluffs" ? <p className="picker-help">选择三个未入场的善良角色，分发时仅告知恶魔。酒鬼实际看到的身份不能用作伪装。</p> : null}
            {!room.edition ? <p className="picker-empty">请先选择剧本，再挑选本局的角色。</p> : null}
            {([...setupTeams, ...(showTravelers && mode === "roles" ? ["traveler" as const] : [])]).map(team => {
              const group = visible.filter(role => role.team === team);
              if (!group.length) return null;
              return <section className={`picker-team ${team}`} key={team}>
                <h3>{teamNames[team]} <span>{group.length}</span>{team === "traveler" ? <small>不计入普通玩家配置</small> : null}</h3>
                <div className="role-options">{group.map(role => {
                  const active = (mode === "roles" ? selected : bluffs).includes(role.id);
                  return <button key={role.id} className={`role-option ${active ? "is-selected" : ""}`} aria-pressed={active} disabled={mode === "bluffs" && !active && bluffs.length >= 3} onClick={() => {
                    if (mode === "roles") updateSelection(active ? selected.filter(id => id !== role.id) : [...selected, role.id]);
                    else setBluffs(active ? bluffs.filter(id => id !== role.id) : [...bluffs, role.id]);
                  }}>
                    <span className="role-option__portrait"><RoleImage role={role} /><span className="role-check" aria-hidden="true">{active ? "✓" : "+"}</span></span>
                    <strong>{role.name}</strong><span className="role-option__ability">{role.ability}</span>
                  </button>;
                })}</div>
              </section>;
            })}
            {room.edition && !visible.some(role => role.team !== "traveler" || showTravelers) ? <p className="picker-empty">没有符合条件的角色。</p> : null}
          </section>
          <aside className="picker-summary">
            <span className="eyebrow">YOUR CAST</span><h3>本局预选</h3>
            <p>{room.players.length} 个座位 · {room.players.filter(player => player.clientId).length} 人已入座</p>
            <div className="setup-counts">{setupTeams.map(team => <div key={team}><span>{teamNames[team]}</span><strong>{actual[team]}<small> / {recommended?.[team] ?? "—"}</small></strong></div>)}</div>
            <p className="picker-help">已选 / 建议{travelers.length ? ` · 另有 ${travelers.length} 位旅行者` : ""}{selected.includes("baron") ? " · 男爵：外来者 +2" : ""}</p>
            <button className="btn" disabled={!room.edition || !standardSetup(playerCount)} onClick={randomize}>↻ 随机选择</button>
            <p className="picker-help">按人数预选，点击卡片可自由增减。特殊开局角色（男爵、酒鬼除外）请手动选择并校对配置。</p>
            <div className="chosen-roles">{selected.map(id => { const role = byId.get(id); return role ? <button key={id} className="chip" onClick={() => updateSelection(selected.filter(value => value !== id))}>{role.name} ×</button> : null; })}</div>
            {selected.includes("drunk") ? <label className="drunk-identity">酒鬼看到的镇民身份<select value={drunkAs} onChange={event => { setDrunkAs(event.target.value); setBluffs(bluffs.filter(id => id !== event.target.value)); }}><option value="">选择未入场镇民</option>{drunkChoices.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label> : null}
            <div className="bluff-summary"><h3>恶魔伪装</h3><div className="chosen-roles">{bluffs.map(id => <button className="chip" key={id} onClick={() => setBluffs(bluffs.filter(value => value !== id))}>{byId.get(id)?.name} ×</button>)}</div><button className="btn" onClick={() => setMode("bluffs")}>选择伪装 · {bluffs.length}/3</button><button className="btn" disabled={validBluffs.length < 3} onClick={() => { const pool = [...validBluffs]; for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; } setBluffs(pool.slice(0, 3).map(role => role.id)); }}>随机选择伪装</button></div>
            {playerCount <= 6 && playerCount >= 5 ? <p className="picker-help">5–6 人局默认无需恶魔伪装；主持人也可手动设置。</p> : null}
            {!countMatches ? <p className="picker-warning">已选 {selected.length} 个角色，需要与 {room.players.length} 个座位一致。</p> : null}
            {setupMismatch ? <p className="picker-warning">当前阵营人数与建议配置不同，请确认这是你的手动调整。</p> : null}
            {unsupportedSetup.length ? <p className="picker-warning">{unsupportedSetup.map(role => role!.name).join("、")}涉及特殊开局，请按角色能力校对。</p> : null}
            {bluffError ? <p className="picker-warning">分发前请选好三个恶魔伪装。</p> : null}
          </aside>
        </div>
        <footer className="role-picker__footer">
          <div><strong>{room.rolesDistributed ? "身份已发放" : "身份未发放，玩家不可见"}</strong><span role={error || serverError ? "alert" : undefined}>{error ?? serverError ?? "预选与调整不会自动发放；点击分发才会随机安排到座位。"}</span></div>
          {room.rolesDistributed ? <button className="btn" onClick={() => onSend({ type: "hide_roles" })}>收回身份显示</button> : null}
          <button className="btn btn--primary" disabled={!canDistribute} onClick={() => { setError(null); onSend({ type: "distribute_roles", roleIds: selected, bluffRoleIds: bluffs, drunkAsRoleId: selected.includes("drunk") ? drunkAs : undefined }); }}>分发角色 · {selected.length} 人</button>
        </footer>
      </div>
    </dialog>
  );
}
