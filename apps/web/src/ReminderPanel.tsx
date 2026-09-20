import type { PlayerState, RoleDefinition } from "@clocktower/domain";
import { RoleImage } from "./RolePicker";

interface ReminderPanelProps {
  player: PlayerState;
  sources: RoleDefinition[];
  onSend: (message: Record<string, unknown>) => void;
}

export function ReminderPanel({ player, sources, onSend }: ReminderPanelProps) {
  const groups = [...new Map(sources.map(role => [role.id, role])).values()]
    .map(role => ({ role, names: [...new Set([...(role.reminders ?? []), ...(role.remindersGlobal ?? [])])] }))
    .filter(group => group.names.length);
  const byId = new Map(sources.map(role => [role.id, role]));
  return <section className="reminder-editor" aria-label="角色标记">
    <h3>角色标记</h3>
    <p className="picker-help">将本局角色提供的标记添加给 {player.name}。点击已有标记可移除。</p>
    <div className="reminder-editor__current" aria-label="已有标记">
      {player.reminders.map(reminder => <button key={reminder.id} className="chip reminder-chip" aria-label={`移除${byId.get(reminder.roleId ?? "")?.name ?? (reminder.isCustom ? "自定义" : "")}标记：${reminder.name}`} onClick={() => onSend({ type: "remove_reminder", seatId: player.seatId, reminderId: reminder.id })}>
        {reminder.iconUrl ? <img src={reminder.iconUrl} alt="" /> : null}
        <span>{reminder.name}<small>{byId.get(reminder.roleId ?? "")?.name ?? (reminder.isCustom ? "自定义" : "")}</small></span><span aria-hidden="true">×</span>
      </button>)}
      {!player.reminders.length ? <span className="reminder-empty">尚无标记</span> : null}
    </div>
    <div className="reminder-sources">
      {groups.map(({ role, names }) => <section className="reminder-source" key={role.id} aria-label={`${role.name}提供的标记`}>
        <header><RoleImage role={role} /><strong>{role.name}</strong></header>
        <div className="chip-wrap">{names.map(name => {
          const id = `${player.seatId}:role:${role.id}:${name}`;
          const active = player.reminders.some(reminder => reminder.roleId === role.id && reminder.name === name);
          return <button key={name} className="chip chip--ghost" disabled={active} aria-label={`添加${role.name}标记：${name}`} onClick={() => onSend({
            type: "upsert_reminder", seatId: player.seatId,
            reminder: { id, name, roleId: role.id, iconUrl: role.image ?? `https://oss.gstonegames.com/data_file/clocktower/role_icon/${role.imageAlt ?? role.id}.png` }
          })}>{active ? "✓" : "+"} {name}</button>;
        })}</div>
      </section>)}
      {!groups.length ? <p className="picker-help">本局角色暂无预设标记，可以添加自定义标记。</p> : null}
    </div>
    <label className="inline-form"><span>自定义标记</span><input placeholder="输入文字后回车" onKeyDown={event => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      const name = event.currentTarget.value.trim().slice(0, 80);
      if (!name) return;
      onSend({ type: "upsert_reminder", seatId: player.seatId, reminder: { id: `${player.seatId}:custom:${name}`, name, isCustom: true } });
      event.currentTarget.value = "";
    }} /></label>
  </section>;
}
