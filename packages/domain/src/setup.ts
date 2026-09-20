import type { RoleDefinition } from "./types.js";

export const setupTeams = ["townsfolk", "outsider", "minion", "demon"] as const;
export type SetupTeam = typeof setupTeams[number];
export type SetupCounts = Record<SetupTeam, number>;

// Standard setup sheet: https://wiki.bloodontheclocktower.com/Setup
export function standardSetup(playerCount: number): SetupCounts | null {
  if (!Number.isInteger(playerCount) || playerCount < 5 || playerCount > 15) return null;
  if (playerCount <= 6) return { townsfolk: 3, outsider: playerCount - 5, minion: 1, demon: 1 };
  const minion = Math.floor((playerCount - 7) / 3) + 1;
  return { townsfolk: 3 + minion * 2, outsider: (playerCount - 7) % 3, minion, demon: 1 };
}

export function adjustedSetup(playerCount: number, roleIds: string[]): SetupCounts | null {
  const counts = standardSetup(playerCount);
  if (counts && roleIds.includes("baron")) {
    counts.townsfolk -= 2;
    counts.outsider += 2;
  }
  return counts;
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function randomRoleSelection(roles: RoleDefinition[], playerCount: number, random = Math.random): string[] {
  const base = standardSetup(playerCount);
  if (!base) throw new Error("随机预选支持 5–15 位普通玩家；旅行者请单独安排。");
  // Other setup-changing abilities require storyteller decisions. Keep them available for manual selection.
  const eligible = [...new Map(roles.map(role => [role.id, role])).values()]
    .filter(role => !role.setup || ["baron", "drunk"].includes(role.id));
  const pick = (team: SetupTeam, count: number) => {
    const pool = eligible.filter(role => role.team === team);
    if (pool.length < count) throw new Error(`剧本中的${team === "townsfolk" ? "镇民" : team === "outsider" ? "外来者" : team === "minion" ? "爪牙" : "恶魔"}不足，或需要特殊开局配置。请手动选择。`);
    return shuffled(pool, random).slice(0, count).map(role => role.id);
  };
  const evil = [...pick("demon", base.demon), ...pick("minion", base.minion)];
  const counts = adjustedSetup(playerCount, evil)!;
  return [...pick("townsfolk", counts.townsfolk), ...pick("outsider", counts.outsider), ...evil];
}

export function bluffCandidates(roles: RoleDefinition[], selectedIds: string[], drunkAsRoleId?: string): RoleDefinition[] {
  return roles.filter(role => ["townsfolk", "outsider"].includes(role.team) && !selectedIds.includes(role.id) && role.id !== drunkAsRoleId);
}
