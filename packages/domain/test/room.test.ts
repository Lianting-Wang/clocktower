import { describe, expect, it } from "vitest";

import {
  applyRoomCommand,
  createRoomState,
  exportRoomState,
  getNominationResult
} from "../src/index.js";

describe("room domain", () => {
  it("claims and releases seats", () => {
    let room = createRoomState({
      roomId: "ROOM01",
      hostSecret: "host_secret"
    });
    room = applyRoomCommand(room, { type: "add_seat", seatId: "s1", name: "一号位" });
    room = applyRoomCommand(room, {
      type: "claim_seat",
      seatId: "s1",
      clientId: "client_1"
    });

    expect(room.players[0]?.clientId).toBe("client_1");

    room = applyRoomCommand(room, {
      type: "release_seat",
      seatId: "s1",
      clientId: "client_1"
    });

    expect(room.players[0]?.clientId).toBeUndefined();
  });

  it("distributes roles across seats", () => {
    let room = createRoomState({
      roomId: "ROOM01",
      hostSecret: "host_secret"
    });

    room = applyRoomCommand(room, { type: "add_seat", seatId: "s1" });
    room = applyRoomCommand(room, { type: "add_seat", seatId: "s2" });
    room = applyRoomCommand(room, { type: "add_seat", seatId: "s3" });
    room = applyRoomCommand(
      room,
      {
        type: "distribute_roles",
        roleIds: ["washerwoman", "chef", "imp"]
      },
      { random: () => 0.2 }
    );

    expect(room.players.map((player) => player.roleId).filter(Boolean)).toHaveLength(3);
  });

  it("tracks nomination votes and vote history", () => {
    let room = createRoomState({
      roomId: "ROOM01",
      hostSecret: "host_secret"
    });
    room = applyRoomCommand(room, { type: "add_seat", seatId: "s1" });
    room = applyRoomCommand(room, { type: "add_seat", seatId: "s2" });
    room = applyRoomCommand(room, { type: "add_seat", seatId: "s3" });
    room = applyRoomCommand(room, {
      type: "start_nomination",
      nominatorSeatId: "s1",
      nomineeSeatId: "s2"
    });
    room = applyRoomCommand(room, { type: "begin_vote" }, { now: "2026-01-01T00:00:00.000Z" });
    room = applyRoomCommand(room, { type: "cast_vote", seatId: "s1", vote: "yes" });
    room = applyRoomCommand(room, { type: "cast_vote", seatId: "s2", vote: "no" });
    room = applyRoomCommand(room, { type: "cast_vote", seatId: "s3", vote: "yes" });

    expect(getNominationResult(room)).toEqual({
      yesVotes: 2,
      threshold: 2,
      passed: true
    });

    room = applyRoomCommand(room, { type: "finish_nomination" }, { now: "2026-01-01T00:00:10.000Z" });

    expect(room.voteHistory).toHaveLength(1);
    expect(room.voteHistory[0]?.passed).toBe(true);
    expect(room.nomination).toBeNull();
  });

  it("imports state without leaking the host secret", () => {
    let room = createRoomState({
      roomId: "ROOM01",
      hostSecret: "host_secret"
    });
    room = applyRoomCommand(room, { type: "add_seat", seatId: "s1" });

    const exported = exportRoomState(room);

    expect(exported).not.toHaveProperty("hostSecret");

    room = applyRoomCommand(room, { type: "import_state", state: exported });
    expect(room.hostSecret).toBe("host_secret");
  });
});
