import crypto from "node:crypto";

import {
  applyRoomCommand,
  createRoomState,
  exportRoomState,
  getSeatForClient,
  type RoomCommand,
  type RoomState
} from "@clocktower/domain";

import type { RoomStore } from "./database.js";

export interface RoomConnection {
  connectionId: string;
  clientId: string;
  role: "host" | "guest" | "spectator";
  send: (message: unknown) => void;
}

export interface RealtimeAdapter {
  broadcast(roomId: string, message: unknown, exceptConnectionId?: string): void;
  addConnection(roomId: string, connection: RoomConnection): void;
  removeConnection(roomId: string, connectionId: string): void;
}

export class LocalRealtimeAdapter implements RealtimeAdapter {
  private readonly rooms = new Map<string, Map<string, RoomConnection>>();

  public addConnection(roomId: string, connection: RoomConnection): void {
    const room = this.rooms.get(roomId) ?? new Map<string, RoomConnection>();
    room.set(connection.connectionId, connection);
    this.rooms.set(roomId, room);
  }

  public removeConnection(roomId: string, connectionId: string): void {
    const room = this.rooms.get(roomId);
    room?.delete(connectionId);
    if (room?.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  public broadcast(
    roomId: string,
    message: unknown,
    exceptConnectionId?: string
  ): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }
    for (const connection of room.values()) {
      if (connection.connectionId === exceptConnectionId) {
        continue;
      }
      connection.send(message);
    }
  }
}

export class RoomHub {
  private readonly rooms = new Map<string, RoomState>();

  public constructor(
    private readonly store: RoomStore,
    private readonly realtime: RealtimeAdapter,
    private readonly roomTtlHours: number
  ) {}

  public loadPersistedRooms(nowIso: string): void {
    const active = this.store.loadActiveRooms(nowIso);
    for (const room of active) {
      this.rooms.set(room.id, room);
    }
  }

  public pruneExpired(nowIso: string): number {
    const removed = this.store.pruneExpired(nowIso);
    for (const [roomId, room] of this.rooms) {
      if (room.expiresAt <= nowIso) {
        this.rooms.delete(roomId);
      }
    }
    return removed;
  }

  public createRoom(nowIso: string): RoomState {
    const roomId = createShortId(8).toUpperCase();
    const hostSecret = crypto.randomBytes(24).toString("hex");
    const room = createRoomState({
      roomId,
      hostSecret,
      createdAt: nowIso,
      expiresAt: addHours(nowIso, this.roomTtlHours)
    });
    this.rooms.set(room.id, room);
    this.store.saveRoom(room);
    return room;
  }

  public getRoom(roomId: string): RoomState | null {
    return this.rooms.get(roomId) ?? this.store.loadRoom(roomId);
  }

  public attachConnection(roomId: string, connection: RoomConnection): void {
    this.realtime.addConnection(roomId, connection);
  }

  public detachConnection(roomId: string, connectionId: string): void {
    this.realtime.removeConnection(roomId, connectionId);
  }

  public applyCommand(
    roomId: string,
    command: RoomCommand,
    nowIso: string
  ): RoomState {
    const room = this.getRequiredRoom(roomId);
    const next = applyRoomCommand(room, command, {
      now: nowIso,
      expiresAt: addHours(nowIso, this.roomTtlHours)
    });
    this.rooms.set(roomId, next);
    this.store.saveRoom(next);
    this.realtime.broadcast(roomId, {
      type: "room_event",
      event: command.type,
      room: exportRoomState(next)
    });
    return next;
  }

  public snapshot(roomId: string): RoomState {
    return this.getRequiredRoom(roomId);
  }

  public claimedSeatId(roomId: string, clientId: string): string | null {
    const room = this.getRequiredRoom(roomId);
    return getSeatForClient(room, clientId)?.seatId ?? null;
  }

  private getRequiredRoom(roomId: string): RoomState {
    const room = this.getRoom(roomId);
    if (!room) {
      throw new Error(`Room ${roomId} does not exist.`);
    }
    this.rooms.set(room.id, room);
    return room;
  }
}

function createShortId(length: number): string {
  return crypto.randomBytes(length).toString("base64url").slice(0, length);
}

function addHours(iso: string, hours: number): string {
  const date = new Date(iso);
  date.setHours(date.getHours() + hours);
  return date.toISOString();
}
