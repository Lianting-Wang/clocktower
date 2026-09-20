import { describe, expect, it } from "vitest";
import { applyRoomCommand, createRoomState, roomView, type RoleDefinition } from "../src/index.js";

const catalog: RoleDefinition[] = [
  { id: "imp", name: "小恶魔", team: "demon", ability: "" },
  { id: "chef", name: "厨师", team: "townsfolk", ability: "" },
  { id: "drunk", name: "酒鬼", team: "outsider", ability: "" },
  { id: "empath", name: "共情者", team: "townsfolk", ability: "" },
  ...["a", "b", "c"].map(id => ({ id, name: id, team: "townsfolk" as const, ability: "" }))
];
function fixture() {
  let room = createRoomState({ roomId: "ROOM", hostSecret: "secret" });
  room.edition = { id: "test", name: "测试", roles: catalog.map(role => role.id) };
  for (const [i, roleId] of ["imp", "chef", "drunk"].entries()) {
    room = applyRoomCommand(room, { type: "add_seat", seatId: `s${i}` });
    room = applyRoomCommand(room, { type: "claim_seat", seatId: `s${i}`, clientId: `c${i}` });
    room = applyRoomCommand(room, { type: "update_player", seatId: `s${i}`, patch: { roleId } });
  }
  room.players[2].perceivedRoleId = "empath";
  room.players[1].reminders = [{ id: "private", name: "是酒鬼" }];
  room.bluffRoleIds = ["a", "b", "c"];
  return room;
}

describe("private role visibility", () => {
  it("hides all roles and bluffs before distribution even from seated players", () => {
    const room = fixture();
    for (const role of ["guest", "spectator"] as const) {
      const view = roomView(room, { role, clientId: "c0" }, catalog);
      expect(view.players.every(player => !player.roleId && !player.perceivedRoleId && !player.reminders.length)).toBe(true);
      expect(view.bluffRoleIds).toEqual([]);
    }
    expect(roomView(room, { role: "host", clientId: "host" }, catalog).players[0].roleId).toBe("imp");
  });
  it("shows only the seated player's role and reserves bluffs for the Demon", () => {
    const room = fixture(); room.rolesDistributed = true;
    const demon = roomView(room, { role: "guest", clientId: "c0" }, catalog);
    expect(demon.players.map(player => player.roleId)).toEqual(["imp", undefined, undefined]);
    expect(demon.bluffRoleIds).toEqual(["a", "b", "c"]);
    expect(demon.players[1].clientId).toBe("occupied");
    expect(roomView(room, { role: "guest", clientId: "c1" }, catalog).bluffRoleIds).toEqual([]);
    expect(roomView(room, { role: "guest", clientId: "unseated" }, catalog).players.every(player => !player.roleId)).toBe(true);
    expect(roomView(room, { role: "spectator", clientId: "c0" }, catalog).bluffRoleIds).toEqual([]);
  });
  it("gives the Drunk their assigned Townsfolk identity without leaking the actual role", () => {
    const room = fixture(); room.rolesDistributed = true;
    const drunk = roomView(room, { role: "guest", clientId: "c2" }, catalog);
    expect(drunk.players[2].roleId).toBe("empath");
    expect(drunk.players[2].perceivedRoleId).toBeUndefined();
    expect(room.players[2].roleId).toBe("drunk");
  });
  it("can revoke role visibility and does not mutate the host's room", () => {
    const room = fixture(); room.rolesDistributed = true;
    const hidden = applyRoomCommand(room, { type: "hide_roles" });
    expect(roomView(hidden, { role: "guest", clientId: "c0" }, catalog).players[0].roleId).toBeUndefined();
    expect(hidden.players[0].roleId).toBe("imp");
    expect(room.rolesDistributed).toBe(true);
  });
  it("rejects duplicate and incomplete bags without partially changing roles", () => {
    const room = fixture();
    for (const ids of [["imp"], ["imp", "imp", "chef"]]) expect(() => applyRoomCommand(room, { type: "distribute_roles", roleIds: ids }, { roleCatalog: catalog })).toThrow("座位数");
    expect(room.rolesDistributed).toBe(false);
  });
  it("rejects evil, duplicate, in-play, and perceived identities as bluffs", () => {
    const room = fixture();
    for (const bluffs of [["imp", "a", "b"], ["a", "a", "b"], ["chef", "a", "b"], ["empath", "a", "b"]]) {
      expect(() => applyRoomCommand(room, { type: "distribute_roles", roleIds: ["imp", "chef", "drunk"], drunkAsRoleId: "empath", bluffRoleIds: bluffs }, { roleCatalog: catalog })).toThrow("伪装");
    }
  });
  it("atomically distributes the chosen bag, shown identities, and three bluffs", () => {
    const room = applyRoomCommand(fixture(), { type: "distribute_roles", roleIds: ["imp", "chef", "drunk"], drunkAsRoleId: "empath", bluffRoleIds: ["a", "b", "c"] }, { roleCatalog: catalog });
    expect(room.rolesDistributed).toBe(true);
    expect(room.players.map(player => player.roleId).sort()).toEqual(["chef", "drunk", "imp"]);
    expect(room.players.find(player => player.roleId === "drunk")?.perceivedRoleId).toBe("empath");
    expect(room.bluffRoleIds).toEqual(["a", "b", "c"]);
  });
  it("prevents a single client from occupying multiple seats", () => {
    expect(() => applyRoomCommand(fixture(), { type: "claim_seat", seatId: "s1", clientId: "c0" })).toThrow();
  });
  it("changing scripts hides and clears the previous game's identities", () => {
    const room = fixture(); room.rolesDistributed = true;
    const next = applyRoomCommand(room, { type: "set_edition", edition: room.edition });
    expect(next.rolesDistributed).toBe(false);
    expect(next.players.every(player => !player.roleId && !player.perceivedRoleId)).toBe(true);
    expect(next.bluffRoleIds).toEqual([]);
  });
});
