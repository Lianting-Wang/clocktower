import { exportRoomState } from "./room.js";
import type { ExportedRoomState, RoleDefinition, RoomState } from "./types.js";

/** All HTTP, WebSocket, and export responses use this same view of private information. */
export function roomView(room: RoomState, viewer: { role: "host" | "guest" | "spectator"; clientId: string }, catalog: RoleDefinition[] = []): ExportedRoomState {
  const result = exportRoomState(room);
  if (viewer.role === "host") return result;
  const roles = new Map([...catalog, ...(room.customScript?.roles ?? [])].map(role => [role.id, role]));
  const ownSeat = viewer.role === "guest" ? room.players.find(player => player.clientId === viewer.clientId) : undefined;
  const published = room.rolesDistributed === true;
  result.players = result.players.map(player => {
    const own = ownSeat?.seatId === player.seatId;
    const visible = published && (own || room.isGrimoirePublic);
    if (!visible) delete player.roleId;
    else if (own && player.roleId === "drunk") player.roleId = player.perceivedRoleId;
    delete player.perceivedRoleId;
    player.reminders = [];
    if (player.clientId && !own) player.clientId = "occupied";
    return player;
  });
  const ownRole = roles.get(ownSeat?.roleId ?? "");
  if (!published || ownRole?.team !== "demon") result.bluffRoleIds = [];
  if (!room.isVoteHistoryAllowed) result.voteHistory = [];
  return result;
}
