import { describe, expect, it } from "vitest";
import { adjustedSetup, bluffCandidates, randomRoleSelection, setupTeams, standardSetup, type RoleDefinition } from "../src/index.js";

const roles: RoleDefinition[] = [
  ...Array.from({ length: 13 }, (_, i) => ({ id: `town${i}`, name: `镇民${i}`, team: "townsfolk" as const, ability: "" })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `out${i}`, name: `外来者${i}`, team: "outsider" as const, ability: "" })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `minion${i}`, name: `爪牙${i}`, team: "minion" as const, ability: "" })),
  { id: "imp", name: "小恶魔", team: "demon", ability: "" },
  { id: "beggar", name: "乞丐", team: "traveler", ability: "" }
];

describe("role setup", () => {
  it.each([
    [5, 3, 0, 1, 1], [6, 3, 1, 1, 1], [7, 5, 0, 1, 1], [8, 5, 1, 1, 1], [9, 5, 2, 1, 1],
    [10, 7, 0, 2, 1], [11, 7, 1, 2, 1], [12, 7, 2, 2, 1], [13, 9, 0, 3, 1], [14, 9, 1, 3, 1], [15, 9, 2, 3, 1]
  ])("selects the correct teams for %i players", (count, townsfolk, outsider, minion, demon) => {
    const selected = randomRoleSelection(roles, count, () => .4);
    const expected = { townsfolk, outsider, minion, demon };
    expect(standardSetup(count)).toEqual(expected);
    expect(new Set(selected).size).toBe(count);
    for (const team of setupTeams) expect(selected.filter(id => roles.find(role => role.id === id)?.team === team)).toHaveLength(expected[team]);
    expect(selected).not.toContain("beggar");
  });

  it("applies the Baron's two extra outsiders before choosing good roles", () => {
    const pool = roles.filter(role => role.team !== "minion").concat({ id: "baron", name: "男爵", team: "minion", setup: true, ability: "" });
    const selected = randomRoleSelection(pool, 7);
    expect(adjustedSetup(7, selected)).toEqual({ townsfolk: 3, outsider: 2, minion: 1, demon: 1 });
    expect(selected.filter(id => id.startsWith("out"))).toHaveLength(2);
  });

  it("fails rather than filling missing teams with arbitrary characters", () => {
    expect(() => randomRoleSelection(roles.filter(role => role.team !== "demon"), 7)).toThrow("恶魔不足");
    expect(() => randomRoleSelection(roles, 4)).toThrow("5–15");
    expect(() => randomRoleSelection(roles, 16)).toThrow("5–15");
  });

  it("only offers unused good roles as bluffs, excluding the Drunk's shown identity", () => {
    const candidates = bluffCandidates(roles, ["town0", "imp"], "town1");
    expect(candidates.every(role => ["townsfolk", "outsider"].includes(role.team))).toBe(true);
    expect(candidates.map(role => role.id)).not.toEqual(expect.arrayContaining(["town0", "town1"]));
  });
});
