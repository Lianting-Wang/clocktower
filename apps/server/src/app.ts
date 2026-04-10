import { stat } from "node:fs/promises";
import path from "node:path";

import {
  readLocalCatalog,
  resolveContentPaths,
  syncCatalog,
  type SyncCatalogResult
} from "@clocktower/content";
import { exportRoomState } from "@clocktower/domain";
import {
  clientMessageSchema,
  createRoomRequestSchema,
  createRoomResponseSchema,
  roomBootstrapQuerySchema,
  roomBootstrapResponseSchema,
  syncContentResponseSchema
} from "@clocktower/protocol";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import websocketPlugin from "@fastify/websocket";
import Fastify from "fastify";

import { loadConfig, type AppConfig } from "./config.js";
import { SQLiteRoomStore } from "./database.js";
import { LocalRealtimeAdapter, RoomHub, type RoomConnection } from "./rooms.js";

interface ContentManagerState {
  status: "idle" | "syncing" | "failed" | "ready";
  snapshot: SyncCatalogResult;
}

export async function buildServer(config = loadConfig()) {
  const app = Fastify({
    logger: true
  });

  await app.register(cors, { origin: true });
  await app.register(websocketPlugin);

  const store = new SQLiteRoomStore(config.sqlitePath);
  const realtime = new LocalRealtimeAdapter();
  const hub = new RoomHub(store, realtime, config.roomTtlHours);
  const contentPaths = resolveContentPaths(config.rootDir);
  const contentState: ContentManagerState = {
    status: "idle",
    snapshot: await readLocalCatalog(config.rootDir)
  };

  hub.loadPersistedRooms(new Date().toISOString());
  hub.pruneExpired(new Date().toISOString());

  async function refreshContent(): Promise<SyncCatalogResult> {
    contentState.status = "syncing";
    const next = await syncCatalog({
      rootDir: config.rootDir,
      sourceMode: config.contentMode,
      assetMirrorEnabled: config.assetMirrorEnabled
    });
    contentState.snapshot = next;
    contentState.status = next.usedFallback ? "failed" : "ready";
    return next;
  }

  if (config.officialSyncEnabled && config.officialSyncOnBoot) {
    void refreshContent().catch((error) => {
      contentState.status = "failed";
      app.log.error(error, "official content sync failed on boot");
    });
  } else {
    contentState.status = "ready";
  }

  if (config.officialSyncEnabled && config.officialSyncInterval > 0) {
    setInterval(() => {
      void refreshContent().catch((error) => {
        contentState.status = "failed";
        app.log.error(error, "periodic content sync failed");
      });
    }, config.officialSyncInterval).unref();
  }

  await app.register(staticPlugin, {
    root: contentPaths.assetsDir,
    prefix: "/content/assets/",
    decorateReply: false
  });

  const webDistDir = path.resolve(config.rootDir, "apps/web/dist");
  if (await pathExists(webDistDir)) {
    await app.register(staticPlugin, {
      root: webDistDir,
      prefix: "/",
      decorateReply: false
    });
  }

  app.get("/api/health", async () => ({
    ok: true,
    time: new Date().toISOString(),
    contentStatus: contentState.status
  }));

  app.get("/api/content/catalog", async () => contentState.snapshot.catalog);

  app.post("/api/admin/content/sync", async (_request, reply) => {
    const snapshot = await refreshContent();
    return reply.send(
      syncContentResponseSchema.parse({
        ok: !snapshot.usedFallback,
        syncedAt: snapshot.syncedAt,
        usedFallback: snapshot.usedFallback,
        issues: snapshot.issues
      })
    );
  });

  app.post("/api/rooms", async (request, reply) => {
    const body = createRoomRequestSchema.parse(request.body ?? {});
    if (body.roomId) {
      return reply.code(400).send({
        message:
          "Explicit room IDs are reserved for a future version. Omit roomId for now."
      });
    }

    const nowIso = new Date().toISOString();
    const room = hub.createRoom(nowIso);
    const hostClientId = createClientId();
    const response = createRoomResponseSchema.parse({
      roomId: room.id,
      clientId: hostClientId,
      hostSecret: room.hostSecret,
      wsUrl: toWsUrl(config.publicBaseUrl, "/api/ws"),
      guestUrl: buildGuestUrl(config.publicBaseUrl, room.id),
      hostUrl: buildHostUrl(config.publicBaseUrl, room.id, room.hostSecret)
    });
    return reply.code(201).send(response);
  });

  app.get("/api/rooms/:roomId/bootstrap", async (request, reply) => {
    const roomId = String((request.params as { roomId: string }).roomId);
    const room = hub.getRoom(roomId);
    if (!room) {
      return reply.code(404).send({ message: "Room not found" });
    }

    const query = roomBootstrapQuerySchema.parse({
      clientId: String((request.query as Record<string, unknown>).clientId ?? ""),
      hostSecret: (request.query as Record<string, unknown>).hostSecret as string | undefined,
      spectator:
        String((request.query as Record<string, unknown>).spectator ?? "false") ===
        "true"
    });

    const role =
      query.hostSecret && query.hostSecret === room.hostSecret
        ? "host"
        : query.spectator
          ? "spectator"
          : "guest";

    const payload = roomBootstrapResponseSchema.parse({
      role,
      clientId: query.clientId,
      claimedSeatId: hub.claimedSeatId(room.id, query.clientId),
      wsUrl: toWsUrl(config.publicBaseUrl, "/api/ws"),
      guestUrl: buildGuestUrl(config.publicBaseUrl, room.id),
      hostUrl:
        role === "host"
          ? buildHostUrl(config.publicBaseUrl, room.id, room.hostSecret)
          : undefined,
      contentMode: config.contentMode,
      room: exportRoomState(room)
    });
    return reply.send(payload);
  });

  app.get(
    "/api/ws",
    { websocket: true },
    async (connection, _request) => {
      const connectionId = cryptoRandom();
      let joinedRoomId: string | null = null;
      let connectionMeta: RoomConnection | null = null;

      const send = (payload: unknown) => {
        connection.send(JSON.stringify(payload));
      };

      connection.on("message", (raw: string | Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const parsed = clientMessageSchema.safeParse(JSON.parse(String(raw)));
          if (!parsed.success) {
            send({ type: "error", message: parsed.error.message });
            return;
          }

          const message = parsed.data;
          if (message.type === "ping") {
            send({ type: "pong" });
            return;
          }

          if (message.type === "join_room") {
            const room = hub.getRoom(message.roomId);
            if (!room) {
              send({ type: "error", message: "Room not found" });
              return;
            }

            joinedRoomId = room.id;
            connectionMeta = {
              connectionId,
              clientId: message.clientId,
              role:
                message.hostSecret && message.hostSecret === room.hostSecret
                  ? "host"
                  : message.spectator
                    ? "spectator"
                    : "guest",
              send
            };
            hub.attachConnection(room.id, connectionMeta);
            send({ type: "room_snapshot", room: exportRoomState(room) });
            send({
              type: "content_status",
              status: contentState.status,
              issues: contentState.snapshot.issues
            });
            return;
          }

          if (!joinedRoomId || !connectionMeta) {
            send({ type: "error", message: "Join a room first." });
            return;
          }

          const room = hub.snapshot(joinedRoomId);
          const isHost = connectionMeta.role === "host";
          const claimedSeatId = hub.claimedSeatId(joinedRoomId, connectionMeta.clientId);

          switch (message.type) {
            case "claim_seat": {
              hub.applyCommand(
                joinedRoomId,
                {
                  type: "claim_seat",
                  seatId: message.seatId,
                  clientId: connectionMeta.clientId,
                  name: message.name
                },
                new Date().toISOString()
              );
              break;
            }

            case "release_seat": {
              if (!claimedSeatId || claimedSeatId !== message.seatId) {
                throw new Error("You can only release your own seat.");
              }
              hub.applyCommand(
                joinedRoomId,
                {
                  type: "release_seat",
                  seatId: message.seatId,
                  clientId: connectionMeta.clientId
                },
                new Date().toISOString()
              );
              break;
            }

            case "update_player": {
              if (!isHost) {
                if (
                  claimedSeatId !== message.seatId ||
                  Object.keys(message.patch).some((key) => !["name", "pronouns"].includes(key))
                ) {
                  throw new Error("Only the host can edit that field.");
                }
              }
              hub.applyCommand(
                joinedRoomId,
                {
                  type: "update_player",
                  seatId: message.seatId,
                  patch: message.patch
                },
                new Date().toISOString()
              );
              break;
            }

            case "cast_vote": {
              if (!claimedSeatId || claimedSeatId !== message.seatId) {
                throw new Error("You can only vote from your own claimed seat.");
              }
              hub.applyCommand(
                joinedRoomId,
                {
                  type: "cast_vote",
                  seatId: message.seatId,
                  vote: message.vote
                },
                new Date().toISOString()
              );
              break;
            }

            case "export_state": {
              send({ type: "export_state", state: exportRoomState(room) });
              break;
            }

            default: {
              if (!isHost) {
                throw new Error("Only the host can perform that action.");
              }
              hub.applyCommand(
                joinedRoomId,
                mapHostMessageToCommand(message),
                new Date().toISOString()
              );
            }
          }
        } catch (error) {
          send({
            type: "error",
            message: error instanceof Error ? error.message : "Unexpected server error"
          });
        }
      });

      connection.on("close", () => {
        if (joinedRoomId) {
          hub.detachConnection(joinedRoomId, connectionId);
        }
      });
    }
  );

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ message: "Not found" });
    }

    if (await pathExists(path.resolve(webDistDir, "index.html"))) {
      return reply.sendFile("index.html");
    }

    return reply.code(404).send({
      message: "Web assets are not built yet. Run `npm run build -w @clocktower/web`."
    });
  });

  return app;
}

function mapHostMessageToCommand(message: ReturnType<typeof clientMessageSchema.parse>) {
  switch (message.type) {
    case "add_seat":
      return { type: "add_seat", seatId: message.seatId, name: message.name } as const;
    case "remove_seat":
      return { type: "remove_seat", seatId: message.seatId } as const;
    case "distribute_roles":
      return { type: "distribute_roles", roleIds: message.roleIds } as const;
    case "set_fabled":
      return { type: "set_fabled", fabledIds: message.fabledIds } as const;
    case "set_bluffs":
      return { type: "set_bluffs", bluffRoleIds: message.bluffRoleIds } as const;
    case "set_reminders":
      return {
        type: "set_reminders",
        seatId: message.seatId,
        reminders: message.reminders
      } as const;
    case "start_nomination":
      return {
        type: "start_nomination",
        nominatorSeatId: message.nominatorSeatId,
        nomineeSeatId: message.nomineeSeatId,
        votingSpeedMs: message.votingSpeedMs
      } as const;
    case "begin_vote":
      return { type: "begin_vote" } as const;
    case "lock_vote":
      return { type: "lock_vote", count: message.count } as const;
    case "finish_nomination":
      return { type: "finish_nomination" } as const;
    case "set_phase":
      return { type: "set_phase", phase: message.phase } as const;
    case "set_marked":
      return { type: "set_marked", seatId: message.seatId } as const;
    case "import_state":
      return { type: "import_state", state: message.state } as const;
    case "set_edition":
      return { type: "set_edition", edition: message.edition } as const;
    case "set_custom_script":
      return {
        type: "set_custom_script",
        editionMeta: message.editionMeta,
        roles: message.roles,
        fabled: message.fabled
      } as const;
    case "clear_custom_script":
      return { type: "clear_custom_script" } as const;
    case "set_vote_history_allowed":
      return { type: "set_vote_history_allowed", value: message.value } as const;
    case "set_background":
      return { type: "set_background", backgroundUrl: message.backgroundUrl } as const;
    default:
      throw new Error(`Unsupported message ${message.type}`);
  }
}

function createClientId(): string {
  return cryptoRandom();
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 12);
}

function buildGuestUrl(baseUrl: string, roomId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/?room=${roomId}`;
}

function buildHostUrl(baseUrl: string, roomId: string, hostSecret: string): string {
  return `${baseUrl.replace(/\/$/, "")}/?room=${roomId}&hostSecret=${hostSecret}`;
}

function toWsUrl(baseUrl: string, pathname: string): string {
  const url = new URL(pathname, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
