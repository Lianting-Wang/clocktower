import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { buildServer } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const connections: WebSocket[] = [];
let app: Awaited<ReturnType<typeof buildServer>>;
afterEach(async () => {
  connections.forEach(socket => socket.terminate());
  connections.length = 0;
  await app?.close();
});

function next(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off("message", receive); reject(new Error(`No ${type} response`)); }, 2000);
    function receive(raw: WebSocket.RawData) {
      const message = JSON.parse(String(raw));
      if (message.type === "error" || message.type === type) {
        clearTimeout(timeout); socket.off("message", receive);
        if (message.type === "error") reject(new Error(message.message));
        else resolve(message);
      }
    }
    socket.on("message", receive);
  });
}
async function command(socket: WebSocket, message: unknown, type = "room_event") {
  const response = next(socket, type);
  socket.send(JSON.stringify(message));
  return response;
}

describe("role privacy across transports", () => {
  it("filters bootstrap, broadcasts, and exports, and rejects non-host distribution", async () => {
    app = await buildServer({ ...loadConfig(), rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."), sqlitePath: ":memory:", officialSyncEnabled: false, officialSyncOnBoot: false, contentMode: "local" });
    await app.ready();
    const created = (await app.inject({ method: "POST", url: "/api/rooms", payload: {} })).json();
    const connect = async (clientId: string, hostSecret?: string) => {
      const socket = await app.injectWS("/api/ws"); connections.push(socket);
      await command(socket, { type: "join_room", roomId: created.roomId, clientId, hostSecret }, "room_snapshot");
      return socket;
    };
    const host = await connect(created.clientId, created.hostSecret);
    const guest = await connect("player-a");
    const other = await connect("player-b");
    const roles = [
      { id: "test-demon", name: "测试恶魔", team: "demon", ability: "" },
      ...["test-good", "skin-a", "skin-b", "skin-c"].map(id => ({ id, name: id, team: "townsfolk", ability: "" }))
    ];
    await command(host, { type: "set_custom_script", editionMeta: { name: "测试剧本" }, roles });
    await command(host, { type: "add_seat", seatId: "s1" });
    await command(host, { type: "add_seat", seatId: "s2" });
    await command(guest, { type: "claim_seat", seatId: "s1" });
    await command(other, { type: "claim_seat", seatId: "s2" });
    await command(host, { type: "update_player", seatId: "s1", patch: { roleId: "test-demon" } });
    const bootstrap = async (clientId: string) => (await app.inject({ method: "GET", url: `/api/rooms/${created.roomId}/bootstrap?clientId=${clientId}` })).json().room;
    expect((await bootstrap("player-a")).players.every((seat: any) => !seat.roleId)).toBe(true);
    const guestEvent = next(guest, "room_event");
    const otherEvent = next(other, "room_event");
    const distributed = await command(host, { type: "distribute_roles", roleIds: ["test-demon", "test-good"], bluffRoleIds: ["skin-a", "skin-b", "skin-c"] });
    const views = [await guestEvent, await otherEvent];
    for (const view of views) {
      expect(view.room.players.filter((seat: any) => seat.roleId)).toHaveLength(1);
      expect(view.room).not.toHaveProperty("hostSecret");
      const ownRole = view.room.players.find((seat: any) => seat.roleId).roleId;
      expect(view.room.bluffRoleIds).toHaveLength(ownRole === "test-demon" ? 3 : 0);
    }
    expect(distributed.room.players.every((seat: any) => seat.roleId)).toBe(true);
    expect((await bootstrap("player-a")).players.filter((seat: any) => seat.roleId)).toHaveLength(1);
    const exported = await command(guest, { type: "export_state" }, "export_state");
    expect(exported.state.players.filter((seat: any) => seat.roleId)).toHaveLength(1);
    await expect(command(guest, { type: "distribute_roles", roleIds: ["test-good", "test-demon"] })).rejects.toThrow("Only the host");
    const reminder = { id: "source:death", name: "死亡", roleId: "test-demon", iconUrl: "/content/assets/demon.png" };
    const markedGuest = next(guest, "room_event");
    const marked = await command(host, { type: "upsert_reminder", seatId: "s2", reminder });
    expect(marked.room.players.find((seat: any) => seat.seatId === "s2").reminders).toEqual([reminder]);
    expect((await markedGuest).room.players.every((seat: any) => seat.reminders.length === 0)).toBe(true);
    const repeated = await command(host, { type: "upsert_reminder", seatId: "s2", reminder });
    expect(repeated.room.players.find((seat: any) => seat.seatId === "s2").reminders).toHaveLength(1);
    await command(host, { type: "upsert_reminder", seatId: "s2", reminder: { ...reminder, id: "source:poison", name: "中毒" } });
    await expect(command(guest, { type: "remove_reminder", seatId: "s2", reminderId: reminder.id })).rejects.toThrow("Only the host");
    const removed = await command(host, { type: "remove_reminder", seatId: "s2", reminderId: reminder.id });
    expect(removed.room.players.find((seat: any) => seat.seatId === "s2").reminders.map((token: any) => token.name)).toEqual(["中毒"]);
    expect((await bootstrap("player-b")).players.every((seat: any) => seat.reminders.length === 0)).toBe(true);
    const hidden = next(guest, "room_event");
    await command(host, { type: "hide_roles" });
    expect((await hidden).room.players.every((seat: any) => !seat.roleId)).toBe(true);
    expect((await bootstrap("player-a")).bluffRoleIds).toEqual([]);
  });
});
