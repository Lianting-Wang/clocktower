import { useState } from "react";
import type { RoleDefinition } from "@clocktower/domain";
import { buildNightOrder, type NightPeriod } from "./nightOrder";
import { RoleImage, teamNames } from "./RolePicker";

export function NightOrderPanel({ roles, showTravelers }: { roles: RoleDefinition[]; showTravelers: boolean }) {
  const [period, setPeriod] = useState<NightPeriod>("first");
  const entries = buildNightOrder(roles, period, showTravelers);
  return <section className="night-schedule">
    <div className="picker-tabs" aria-label="夜晚类型">
      <button aria-pressed={period === "first"} className={period === "first" ? "active" : ""} onClick={() => setPeriod("first")}>首个夜晚</button>
      <button aria-pressed={period === "other"} className={period === "other" ? "active" : ""} onClick={() => setPeriod("other")}>其他夜晚</button>
    </div>
    <p className="picker-help">按当前剧本的行动顺序排列，从先醒到后醒。{showTravelers ? "包含旅行者。" : "已隐藏旅行者。"}</p>
    <ol className="night-schedule__list" aria-label={period === "first" ? "首个夜晚行动顺序" : "其他夜晚行动顺序"}>
      {entries.map(({ role, position }) => <li key={role.id} className={`night-step ${role.team}`}>
        <span className="night-step__number" aria-label={`第 ${position} 位行动`}>{position}</span>
        <RoleImage role={role} />
        <div><header><strong>{role.name}</strong><span>{teamNames[role.team]}</span></header><p>{(period === "first" ? role.firstNightReminder : role.otherNightReminder) || role.ability}</p></div>
      </li>)}
    </ol>
    {!entries.length ? <p className="picker-empty">当前剧本在这个夜晚没有需要唤醒的角色。</p> : null}
  </section>;
}
