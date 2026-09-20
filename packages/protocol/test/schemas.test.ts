import { describe, expect, it } from "vitest";

import {
  clientMessageSchema,
  contentCatalogSchema,
  createRoomRequestSchema,
  exportedRoomStateSchema
} from "../src/index.js";

describe("protocol schemas", () => {
  it("accepts atomic reminder changes with local source icons", () => {
    expect(clientMessageSchema.parse({ type: "upsert_reminder", seatId: "s2", reminder: { id: "death", name: "死亡", roleId: "no_dashii", iconUrl: "/content/assets/no_dashii.png" } }).type).toBe("upsert_reminder");
    expect(clientMessageSchema.parse({ type: "remove_reminder", seatId: "s2", reminderId: "death" }).type).toBe("remove_reminder");
    expect(clientMessageSchema.safeParse({ type: "remove_reminder", seatId: "s2", reminderId: "" }).success).toBe(false);
  });

  it("parses a valid room request", () => {
    const payload = createRoomRequestSchema.parse({ roomId: "ROOM_01" });
    expect(payload.roomId).toBe("ROOM_01");
  });

  it("rejects an invalid client message", () => {
    const result = clientMessageSchema.safeParse({
      type: "claim_seat",
      seatId: ""
    });

    expect(result.success).toBe(false);
  });

  it("accepts an exported room snapshot", () => {
    const result = exportedRoomStateSchema.safeParse({
      id: "ROOM01",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
      phase: "day",
      players: [],
      markedSeatId: null,
      nomination: null,
      voteHistory: [],
      isVoteHistoryAllowed: true,
      isGrimoirePublic: false,
      isPlayerInfoPublic: false,
      votingSpeedMsDefault: 4000,
      fabledIds: [],
      bluffRoleIds: [],
      edition: null,
      customScript: null,
      backgroundUrl: null,
      issues: []
    });

    expect(result.success).toBe(true);
  });

  it("accepts mirrored local asset paths in the content catalog", () => {
    const result = contentCatalogSchema.safeParse({
      sourceMode: "mirror_official",
      syncedAt: "2026-01-01T00:00:00.000Z",
      assetsBaseUrl: "/content/assets",
      countdownAudioUrl:
        "/content/assets/oss.gstonegames.com/data_file/clocktower/web/sounds/countdown.mp3",
      issues: [],
      roles: [
        {
          id: "washerwoman",
          name: "洗衣妇",
          team: "townsfolk",
          ability: "测试",
          image: "/content/assets/oss.gstonegames.com/data_file/clocktower/role_icon/washerwoman.png"
        }
      ],
      fabled: [],
      editions: [
        {
          id: "tb",
          name: "暗流涌动",
          roles: ["washerwoman"],
          image: "/content/assets/oss.gstonegames.com/static/image/team/202206/example.jpg"
        }
      ]
    });

    expect(result.success).toBe(true);
  });
});
