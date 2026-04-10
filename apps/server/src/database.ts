import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { RoomState } from "@clocktower/domain";

export interface RoomStore {
  loadRoom(roomId: string): RoomState | null;
  loadActiveRooms(nowIso: string): RoomState[];
  saveRoom(room: RoomState): void;
  pruneExpired(nowIso: string): number;
}

export class SQLiteRoomStore implements RoomStore {
  private readonly db: Database.Database;

  public constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }

  public loadRoom(roomId: string): RoomState | null {
    const row = this.db
      .prepare("SELECT snapshot FROM rooms WHERE id = ? LIMIT 1")
      .get(roomId) as { snapshot: string } | undefined;

    if (!row) {
      return null;
    }

    return JSON.parse(row.snapshot) as RoomState;
  }

  public loadActiveRooms(nowIso: string): RoomState[] {
    const rows = this.db
      .prepare("SELECT snapshot FROM rooms WHERE expires_at > ?")
      .all(nowIso) as Array<{ snapshot: string }>;
    return rows.map((row) => JSON.parse(row.snapshot) as RoomState);
  }

  public saveRoom(room: RoomState): void {
    this.db
      .prepare(
        `
        INSERT INTO rooms (id, snapshot, updated_at, expires_at)
        VALUES (@id, @snapshot, @updatedAt, @expiresAt)
        ON CONFLICT(id) DO UPDATE SET
          snapshot = excluded.snapshot,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `
      )
      .run({
        id: room.id,
        snapshot: JSON.stringify(room),
        updatedAt: room.updatedAt,
        expiresAt: room.expiresAt
      });
  }

  public pruneExpired(nowIso: string): number {
    const result = this.db
      .prepare("DELETE FROM rooms WHERE expires_at <= ?")
      .run(nowIso);
    return result.changes;
  }
}
