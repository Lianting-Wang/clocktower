import { startTransition, useEffect, useMemo, useRef, useState } from "react";

import type {
  EditionSummary,
  ExportedRoomState,
  FabledDefinition,
  RoleDefinition
} from "@clocktower/domain";
import {
  contentCatalogSchema,
  createRoomResponseSchema,
  roomBootstrapResponseSchema,
  serverMessageSchema,
  type ContentCatalog,
  type ServerMessage
} from "@clocktower/protocol";

type SessionRole = "host" | "guest" | "spectator";

interface SessionState {
  roomId: string;
  clientId: string;
  role: SessionRole;
  hostSecret?: string;
  guestUrl: string;
  hostUrl?: string;
  wsUrl: string;
  claimedSeatId: string | null;
}

interface NominationDraft {
  nominatorSeatId: string;
  nomineeSeatId: string;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

function apiUrl(pathname: string): string {
  if (!API_BASE) {
    return pathname;
  }
  return `${API_BASE.replace(/\/$/, "")}${pathname}`;
}

function formatClientError(
  error: unknown,
  fallback: string,
  schemaHint?: string
): string {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ZodError"
  ) {
    console.error(schemaHint ?? fallback, error);
    return schemaHint ?? fallback;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

function createLocalClientId(roomId: string): string {
  const key = storageKey(roomId);
  const existing = localStorage.getItem(key);
  if (existing) {
    return existing;
  }
  const next = Math.random().toString(36).slice(2, 12);
  localStorage.setItem(key, next);
  return next;
}

function storageKey(roomId: string): string {
  return `clocktower:client:${roomId}`;
}

function roleCatalog(
  catalog: ContentCatalog | null,
  room: ExportedRoomState | null
): RoleDefinition[] {
  const base = catalog?.roles ?? [];
  const custom = room?.customScript?.roles ?? [];
  return [...base, ...custom];
}

function fabledCatalog(
  catalog: ContentCatalog | null,
  room: ExportedRoomState | null
): FabledDefinition[] {
  const base = catalog?.fabled ?? [];
  const custom = room?.customScript?.fabled ?? [];
  return [...base, ...custom];
}

function roleMap(roles: RoleDefinition[]): Map<string, RoleDefinition> {
  return new Map(roles.map((role) => [role.id, role]));
}

function currentEditionRoles(
  roles: RoleDefinition[],
  edition: EditionSummary | null | undefined
): RoleDefinition[] {
  if (!edition) {
    return [];
  }
  const ids = new Set(edition.roles);
  return roles.filter((role) => ids.has(role.id));
}

function computeThreshold(room: ExportedRoomState): number {
  const alive = room.players.filter((player) => !player.isDead).length;
  return Math.max(1, Math.ceil(alive / 2));
}

function roundPosition(index: number, total: number): React.CSSProperties {
  const angle = (Math.PI * 2 * index) / Math.max(total, 1) - Math.PI / 2;
  const x = 50 + Math.cos(angle) * 39;
  const y = 50 + Math.sin(angle) * 39;
  return {
    left: `${x}%`,
    top: `${y}%`
  };
}

function sanitizeText(value: string): string {
  return value.trim();
}

function useRoomState() {
  const [catalog, setCatalog] = useState<ContentCatalog | null>(null);
  const [room, setRoom] = useState<ExportedRoomState | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null);
  const [joinRoomId, setJoinRoomId] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "connected" | "reconnecting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [contentIssues, setContentIssues] = useState<string[]>([]);
  const [nominationDraft, setNominationDraft] = useState<NominationDraft>({
    nominatorSeatId: "",
    nomineeSeatId: ""
  });
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);

  const loadCatalog = async () => {
    const response = await fetch(apiUrl("/api/content/catalog"));
    const payload = contentCatalogSchema.parse(await response.json());
    startTransition(() => {
      setCatalog(payload);
      setContentIssues(payload.issues);
    });
  };

  const bootstrapRoom = async (roomId: string, hostSecret?: string) => {
    setStatus("loading");
    setError(null);
    const clientId = createLocalClientId(roomId);
    const query = new URLSearchParams({
      clientId
    });
    if (hostSecret) {
      query.set("hostSecret", hostSecret);
    }
    const response = await fetch(apiUrl(`/api/rooms/${roomId}/bootstrap?${query.toString()}`));
    if (!response.ok) {
      throw new Error(`房间 ${roomId} 不存在或已过期。`);
    }
    const payload = roomBootstrapResponseSchema.parse(await response.json());
    startTransition(() => {
      setRoom(payload.room);
      setSession({
        roomId,
        clientId: payload.clientId,
        role: payload.role,
        hostSecret,
        guestUrl: payload.guestUrl,
        hostUrl: payload.hostUrl,
        wsUrl: payload.wsUrl,
        claimedSeatId: payload.claimedSeatId
      });
      setJoinRoomId(roomId);
      setSelectedSeatId(payload.claimedSeatId);
      setSelectedRoleIds(payload.room.edition?.roles.slice(0, payload.room.players.length) ?? []);
      setContentIssues((prev) => [...new Set([...prev, ...payload.room.issues])]);
      setStatus("connected");
    });
  };

  const connectSocket = (nextSession: SessionState) => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const socket = new WebSocket(nextSession.wsUrl);
    wsRef.current = socket;

    socket.addEventListener("open", () => {
      setStatus("connected");
      socket.send(
        JSON.stringify({
          type: "join_room",
          roomId: nextSession.roomId,
          clientId: nextSession.clientId,
          hostSecret: nextSession.hostSecret,
          spectator: nextSession.role === "spectator"
        })
      );
    });

    socket.addEventListener("message", (event) => {
      const message = serverMessageSchema.parse(JSON.parse(String(event.data)));
      handleServerMessage(message);
    });

    socket.addEventListener("close", () => {
      setStatus("reconnecting");
      if (reconnectTimer.current) {
        window.clearTimeout(reconnectTimer.current);
      }
      reconnectTimer.current = window.setTimeout(() => {
        if (session) {
          connectSocket(session);
        }
      }, 2_000);
    });
  };

  const handleServerMessage = (message: ServerMessage) => {
    if (message.type === "error") {
      setError(message.message);
      return;
    }
    if (message.type === "content_status") {
      setContentIssues(message.issues);
      return;
    }
    if (message.type === "pong") {
      return;
    }
    if (message.type === "export_state") {
      navigator.clipboard.writeText(JSON.stringify(message.state, null, 2)).catch(() => {});
      return;
    }
    const nextRoom = message.room;
    startTransition(() => {
      setRoom(nextRoom);
      setSelectedRoleIds((current) =>
        current.length ? current : nextRoom.edition?.roles.slice(0, nextRoom.players.length) ?? []
      );
    });
  };

  const sendMessage = (payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setError("实时连接尚未建立。");
      return;
    }
    wsRef.current.send(JSON.stringify(payload));
  };

  useEffect(() => {
    void loadCatalog().catch((reason) => {
      setError(
        formatClientError(
          reason,
          "加载内容目录失败。",
          "本地内容目录格式与当前前端版本不匹配。请重启前端/服务端并强制刷新浏览器。"
        )
      );
    });

    const params = new URLSearchParams(window.location.search);
    const roomId = params.get("room");
    const hostSecret = params.get("hostSecret") ?? undefined;
    if (roomId) {
      void bootstrapRoom(roomId, hostSecret).catch((reason) => {
        setStatus("error");
        setError(
          formatClientError(
            reason,
            "进入房间失败。",
            "房间数据格式与当前前端版本不匹配。请重启前端/服务端并强制刷新浏览器。"
          )
        );
      });
    }

    return () => {
      if (reconnectTimer.current) {
        window.clearTimeout(reconnectTimer.current);
      }
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (session) {
      connectSocket(session);
    }
  }, [session?.roomId, session?.clientId, session?.role]);

  const createRoom = async () => {
    const response = await fetch(apiUrl("/api/rooms"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const payload = createRoomResponseSchema.parse(await response.json());
    localStorage.setItem(storageKey(payload.roomId), payload.clientId);
    window.history.replaceState({}, "", `/?room=${payload.roomId}&hostSecret=${payload.hostSecret}`);
    await bootstrapRoom(payload.roomId, payload.hostSecret);
  };

  return {
    catalog,
    room,
    session,
    selectedSeatId,
    joinRoomId,
    status,
    error,
    contentIssues,
    nominationDraft,
    selectedRoleIds,
    setSelectedSeatId,
    setJoinRoomId,
    setNominationDraft,
    setSelectedRoleIds,
    createRoom,
    bootstrapRoom,
    sendMessage,
    setSession,
    setRoom,
    setError
  };
}

export function App() {
  const {
    catalog,
    room,
    session,
    selectedSeatId,
    joinRoomId,
    status,
    error,
    contentIssues,
    nominationDraft,
    selectedRoleIds,
    setSelectedSeatId,
    setJoinRoomId,
    setNominationDraft,
    setSelectedRoleIds,
    createRoom,
    bootstrapRoom,
    sendMessage,
    setSession,
    setRoom,
    setError
  } = useRoomState();

  const roles = useMemo(() => roleCatalog(catalog, room), [catalog, room]);
  const fabled = useMemo(() => fabledCatalog(catalog, room), [catalog, room]);
  const rolesById = useMemo(() => roleMap(roles), [roles]);
  const editionRoles = useMemo(
    () => currentEditionRoles(roles, room?.edition),
    [roles, room?.edition]
  );
  const selectedSeat = room?.players.find((player) => player.seatId === selectedSeatId) ?? null;
  const claimedSeat = room?.players.find((player) => player.seatId === session?.claimedSeatId) ?? null;
  const nomination = room?.nomination ?? null;
  const threshold = room ? computeThreshold(room) : 0;
  const yesVotes = nomination
    ? Object.values(nomination.votes).filter((vote) => vote === "yes").length
    : 0;
  const canHost = session?.role === "host";

  const handleJoinRoom = async () => {
    if (!joinRoomId.trim()) {
      setError("请输入房间号。");
      return;
    }
    window.history.replaceState({}, "", `/?room=${joinRoomId.trim().toUpperCase()}`);
    await bootstrapRoom(joinRoomId.trim().toUpperCase()).catch((reason) => {
      setError(
        formatClientError(
          reason,
          "进入房间失败。",
          "房间数据格式与当前前端版本不匹配。请重启前端/服务端并强制刷新浏览器。"
        )
      );
    });
  };

  const handleClaimSeat = (seatId: string) => {
    sendMessage({
      type: "claim_seat",
      seatId,
      name: claimedSeat?.name
    });
    if (session) {
      setSession({ ...session, claimedSeatId: seatId });
    }
  };

  const handleReleaseSeat = (seatId: string) => {
    sendMessage({ type: "release_seat", seatId });
    if (session) {
      setSession({ ...session, claimedSeatId: null });
    }
  };

  const handleUpdatePlayer = (
    seatId: string,
    patch: Record<string, unknown>
  ) => {
    sendMessage({
      type: "update_player",
      seatId,
      patch
    });
  };

  const handleExportState = () => {
    sendMessage({ type: "export_state" });
  };

  const handleImportState = async (file: File) => {
    const text = await file.text();
    const parsed = JSON.parse(text) as ExportedRoomState;
    sendMessage({ type: "import_state", state: parsed });
  };

  const handleCustomScriptImport = async (file: File) => {
    const raw = JSON.parse(await file.text()) as Array<Record<string, unknown>>;
    const metaIndex = raw.findIndex((item) => item.id === "_meta");
    const meta = metaIndex >= 0 ? raw.splice(metaIndex, 1)[0] : {};
    sendMessage({
      type: "set_custom_script",
      editionMeta: {
        id: "custom",
        name: String(meta.name ?? "自定义剧本"),
        author: typeof meta.author === "string" ? meta.author : undefined,
        story: typeof meta.story === "string" ? meta.story : undefined,
        desc: typeof meta.description === "string" ? meta.description : undefined
      },
      roles: raw.map((item) => ({
        id: String(item.id),
        name: String(item.name ?? item.id),
        team: String(item.team ?? "townsfolk"),
        ability: String(item.ability ?? ""),
        image: typeof item.image === "string" ? item.image : undefined,
        firstNight: typeof item.firstNight === "number" ? item.firstNight : undefined,
        otherNight: typeof item.otherNight === "number" ? item.otherNight : undefined,
        reminders: Array.isArray(item.reminders)
          ? item.reminders.map((entry) => String(entry))
          : undefined,
        remindersGlobal: Array.isArray(item.remindersGlobal)
          ? item.remindersGlobal.map((entry) => String(entry))
          : undefined
      }))
    });
  };

  if (!room || !session) {
    return (
      <main className="landing">
        <section className="hero">
          <div className="hero__badge">Clocktower Local</div>
          <h1>本地自托管的血染钟楼魔典</h1>
          <p>
            内容从本地内容仓读取，对局状态由本地 WebSocket 服务同步。房主持有管理密钥，玩家通过邀请链接入座。
          </p>
          <div className="hero__actions">
            <button className="btn btn--primary" onClick={() => void createRoom()}>
              创建房间
            </button>
            <div className="join-box">
              <input
                value={joinRoomId}
                onChange={(event) => setJoinRoomId(event.target.value)}
                placeholder="输入房间号"
              />
              <button className="btn" onClick={() => void handleJoinRoom()}>
                加入
              </button>
            </div>
          </div>
          <div className="hero__meta">
            <span>实时状态: {status}</span>
            <span>内容源: {catalog?.sourceMode ?? "loading"}</span>
          </div>
          {error ? <p className="error-banner">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="topbar__eyebrow">房间 {room.id}</div>
          <h1>{room.edition?.name ?? "未选择剧本"}</h1>
          <p>
            当前阶段: <strong>{room.phase === "day" ? "白天" : "夜晚"}</strong>
            {" · "}
            连接状态: <strong>{status}</strong>
          </p>
        </div>
        <div className="topbar__actions">
          <button className="btn" onClick={() => navigator.clipboard.writeText(session.guestUrl)}>
            复制玩家链接
          </button>
          {session.hostUrl ? (
            <button className="btn" onClick={() => navigator.clipboard.writeText(session.hostUrl!)}>
              复制主持链接
            </button>
          ) : null}
          <button className="btn" onClick={handleExportState}>
            导出状态
          </button>
          {canHost ? (
            <>
              <button
                className="btn"
                onClick={() =>
                  sendMessage({
                    type: "set_phase",
                    phase: room.phase === "day" ? "night" : "day"
                  })
                }
              >
                切换昼夜
              </button>
              <label className="btn btn--file">
                导入状态
                <input
                  hidden
                  type="file"
                  accept="application/json"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void handleImportState(file);
                    }
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </>
          ) : null}
        </div>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}
      {contentIssues.length ? (
        <div className="issue-strip">
          {contentIssues.map((issue) => (
            <span key={issue}>{issue}</span>
          ))}
        </div>
      ) : null}

      <section className="dashboard">
        <aside className="panel panel--tall">
          <div className="panel__section">
            <h2>主持面板</h2>
            <p>{canHost ? "你当前持有房主管理权限。" : "你当前是玩家/观战视角。"}</p>
            {canHost ? (
              <div className="stack">
                <button className="btn" onClick={() => sendMessage({ type: "set_vote_history_allowed", value: !room.isVoteHistoryAllowed })}>
                  投票历史: {room.isVoteHistoryAllowed ? "开启" : "关闭"}
                </button>
                <button className="btn" onClick={() => sendMessage({ type: "set_background", backgroundUrl: room.backgroundUrl ? null : "linear-gradient(160deg,#211712 0%,#5a2f1d 100%)" })}>
                  {room.backgroundUrl ? "清除背景" : "切换背景"}
                </button>
                <button className="btn" onClick={() => sendMessage({ type: "set_edition", edition: null })}>
                  清空剧本
                </button>
                <button className="btn" onClick={() => sendMessage({ type: "clear_custom_script" })}>
                  清除自定义剧本
                </button>
              </div>
            ) : null}
          </div>

          <div className="panel__section">
            <h2>剧本与角色</h2>
            <select
              value={room.edition?.id ?? ""}
              onChange={(event) => {
                const edition = catalog?.editions.find((item) => item.id === event.target.value) ?? null;
                sendMessage({ type: "set_edition", edition });
                setSelectedRoleIds(edition?.roles.slice(0, room.players.length) ?? []);
              }}
              disabled={!canHost}
            >
              <option value="">选择剧本</option>
              {catalog?.editions.map((edition) => (
                <option key={edition.id} value={edition.id}>
                  {edition.name}
                </option>
              ))}
            </select>
            <div className="token-grid">
              {editionRoles.map((role) => {
                const selected = selectedRoleIds.includes(role.id);
                return (
                  <button
                    key={role.id}
                    className={`token ${selected ? "token--selected" : ""}`}
                    onClick={() => {
                      if (!canHost) {
                        return;
                      }
                      setSelectedRoleIds((current) =>
                        current.includes(role.id)
                          ? current.filter((item) => item !== role.id)
                          : [...current, role.id]
                      );
                    }}
                  >
                    <strong>{role.name}</strong>
                    <span>{role.team}</span>
                  </button>
                );
              })}
            </div>
            {canHost ? (
              <div className="stack">
                <button
                  className="btn btn--primary"
                  onClick={() =>
                    sendMessage({
                      type: "distribute_roles",
                      roleIds:
                        selectedRoleIds.length > 0
                          ? selectedRoleIds
                          : editionRoles.slice(0, room.players.length).map((role) => role.id)
                    })
                  }
                >
                  分发角色
                </button>
                <label className="btn btn--file">
                  导入自定义剧本
                  <input
                    hidden
                    type="file"
                    accept="application/json"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        void handleCustomScriptImport(file);
                      }
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>
            ) : null}
          </div>

          <div className="panel__section">
            <h2>奇遇与伪装</h2>
            <div className="token-grid token-grid--dense">
              {fabled.map((item) => {
                const active = room.fabledIds.includes(item.id);
                return (
                  <button
                    key={item.id}
                    className={`token ${active ? "token--selected" : ""}`}
                    disabled={!canHost}
                    onClick={() =>
                      canHost &&
                      sendMessage({
                        type: "set_fabled",
                        fabledIds: active
                          ? room.fabledIds.filter((entry) => entry !== item.id)
                          : [...room.fabledIds, item.id]
                      })
                    }
                  >
                    <strong>{item.name}</strong>
                  </button>
                );
              })}
            </div>
            <div className="token-grid token-grid--dense">
              {roles
                .filter((role) => role.team === "demon" || role.team === "minion")
                .map((role) => {
                  const active = room.bluffRoleIds.includes(role.id);
                  return (
                    <button
                      key={role.id}
                      className={`token ${active ? "token--selected" : ""}`}
                      disabled={!canHost}
                      onClick={() => {
                        if (!canHost) {
                          return;
                        }
                        const next = active
                          ? room.bluffRoleIds.filter((entry) => entry !== role.id)
                          : [...room.bluffRoleIds, role.id].slice(0, 3);
                        sendMessage({ type: "set_bluffs", bluffRoleIds: next });
                      }}
                    >
                      <strong>{role.name}</strong>
                      <span>{role.team}</span>
                    </button>
                  );
                })}
            </div>
          </div>
        </aside>

        <section className="board panel">
          <div className="board__header">
            <div>
              <h2>镇广场</h2>
              <p>{room.players.length} 个座位 · 已认领 {room.players.filter((player) => player.clientId).length} 个</p>
            </div>
            {canHost ? (
              <div className="stack stack--inline">
                <button className="btn" onClick={() => sendMessage({ type: "add_seat" })}>
                  添加座位
                </button>
                {selectedSeat ? (
                  <button className="btn" onClick={() => sendMessage({ type: "remove_seat", seatId: selectedSeat.seatId })}>
                    移除选中座位
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="table-wrap">
            <div className="table-center">
              <div className="table-center__clock">{room.phase === "day" ? "DAY" : "NIGHT"}</div>
              <span>{room.edition?.name ?? "请先选择剧本"}</span>
            </div>

            {room.players.map((player, index) => {
              const role = player.roleId ? rolesById.get(player.roleId) : undefined;
              const isClaimedByMe = player.seatId === session.claimedSeatId;
              return (
                <button
                  key={player.seatId}
                  className={`seat-card ${selectedSeatId === player.seatId ? "seat-card--active" : ""} ${isClaimedByMe ? "seat-card--claimed" : ""}`}
                  style={roundPosition(index, room.players.length)}
                  onClick={() => {
                    setSelectedSeatId(player.seatId);
                    if (canHost) {
                      setNominationDraft((current) =>
                        !current.nominatorSeatId
                          ? { ...current, nominatorSeatId: player.seatId }
                          : !current.nomineeSeatId || current.nomineeSeatId === current.nominatorSeatId
                            ? { ...current, nomineeSeatId: player.seatId }
                            : { nominatorSeatId: player.seatId, nomineeSeatId: "" }
                      );
                    }
                  }}
                >
                  <span className="seat-card__index">{index + 1}</span>
                  <strong>{player.name}</strong>
                  <small>{player.pronouns ?? "未设置称谓"}</small>
                  <div className="seat-card__meta">
                    <span>{player.clientId ? "已入座" : "空位"}</span>
                    {player.isDead ? <span>死亡</span> : null}
                    {player.isVoteless ? <span>无票</span> : null}
                  </div>
                  <div className="seat-card__role">
                    {canHost || isClaimedByMe ? role?.name ?? "未分配角色" : player.clientId ? "角色已隐藏" : "空座"}
                  </div>
                  {room.markedSeatId === player.seatId ? <div className="seat-card__badge">待处决</div> : null}
                </button>
              );
            })}
          </div>

          <div className="mobile-seat-list">
            {room.players.map((player, index) => {
              const role = player.roleId ? rolesById.get(player.roleId) : undefined;
              const isClaimedByMe = player.seatId === session.claimedSeatId;
              return (
                <button
                  key={`mobile-${player.seatId}`}
                  className={`seat-row ${selectedSeatId === player.seatId ? "seat-row--active" : ""}`}
                  onClick={() => setSelectedSeatId(player.seatId)}
                >
                  <div>
                    <strong>
                      {index + 1}. {player.name}
                    </strong>
                    <small>{canHost || isClaimedByMe ? role?.name ?? "未分配角色" : "角色已隐藏"}</small>
                  </div>
                  <span>{player.clientId ? "已认领" : "空位"}</span>
                </button>
              );
            })}
          </div>
        </section>

        <aside className="panel panel--tall">
          <div className="panel__section">
            <h2>座位详情</h2>
            {selectedSeat ? (
              <>
                <label>
                  名称
                  <input
                    defaultValue={selectedSeat.name}
                    onBlur={(event) =>
                      handleUpdatePlayer(selectedSeat.seatId, {
                        name: sanitizeText(event.target.value)
                      })
                    }
                  />
                </label>
                <label>
                  称谓
                  <input
                    defaultValue={selectedSeat.pronouns ?? ""}
                    onBlur={(event) =>
                      handleUpdatePlayer(selectedSeat.seatId, {
                        pronouns: sanitizeText(event.target.value) || null
                      })
                    }
                  />
                </label>
                {canHost ? (
                  <>
                    <label>
                      角色
                      <select
                        value={selectedSeat.roleId ?? ""}
                        onChange={(event) =>
                          handleUpdatePlayer(selectedSeat.seatId, {
                            roleId: event.target.value || null
                          })
                        }
                      >
                        <option value="">未分配</option>
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="stack stack--inline">
                      <button
                        className="btn"
                        onClick={() =>
                          handleUpdatePlayer(selectedSeat.seatId, {
                            isDead: !selectedSeat.isDead
                          })
                        }
                      >
                        {selectedSeat.isDead ? "复活" : "标记死亡"}
                      </button>
                      <button
                        className="btn"
                        onClick={() =>
                          handleUpdatePlayer(selectedSeat.seatId, {
                            isVoteless: !selectedSeat.isVoteless
                          })
                        }
                      >
                        {selectedSeat.isVoteless ? "恢复票权" : "移除票权"}
                      </button>
                    </div>
                  </>
                ) : null}
                <div className="stack stack--inline">
                  {!selectedSeat.clientId ? (
                    <button className="btn btn--primary" onClick={() => handleClaimSeat(selectedSeat.seatId)}>
                      认领座位
                    </button>
                  ) : isHostSeat(session, selectedSeat.seatId) ? (
                    <button className="btn" onClick={() => handleReleaseSeat(selectedSeat.seatId)}>
                      起身
                    </button>
                  ) : null}
                </div>
                <div className="reminders">
                  <h3>备忘标记</h3>
                  <div className="chip-wrap">
                    {selectedSeat.reminders.map((reminder) => (
                      <button
                        key={reminder.id}
                        className="chip"
                        onClick={() =>
                          canHost &&
                          sendMessage({
                            type: "update_player",
                            seatId: selectedSeat.seatId,
                            patch: {}
                          })
                        }
                      >
                        {reminder.name}
                      </button>
                    ))}
                  </div>
                  {canHost ? (
                    <>
                      <div className="chip-wrap">
                        {(rolesById.get(selectedSeat.roleId ?? "")?.reminders ?? []).map((reminder) => (
                          <button
                            key={reminder}
                            className="chip chip--ghost"
                            onClick={() =>
                              sendMessage({
                                type: "set_reminders",
                                seatId: selectedSeat.seatId,
                                reminders: [
                                  ...selectedSeat.reminders,
                                  {
                                    id: `${selectedSeat.seatId}:${reminder}`,
                                    name: reminder,
                                    roleId: selectedSeat.roleId
                                  }
                                ]
                              })
                            }
                          >
                            + {reminder}
                          </button>
                        ))}
                      </div>
                      <label className="inline-form">
                        <span>自定义标记</span>
                        <input
                          placeholder="输入文字后回车"
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") {
                              return;
                            }
                            const value = sanitizeText((event.target as HTMLInputElement).value);
                            if (!value) {
                              return;
                            }
                            sendMessage({
                              type: "set_reminders",
                              seatId: selectedSeat.seatId,
                              reminders: [
                                ...selectedSeat.reminders,
                                {
                                  id: `${selectedSeat.seatId}:custom:${value}`,
                                  name: value,
                                  isCustom: true
                                }
                              ]
                            });
                            (event.target as HTMLInputElement).value = "";
                          }}
                        />
                      </label>
                    </>
                  ) : null}
                </div>
              </>
            ) : (
              <p>点击圆桌上的座位查看详情。</p>
            )}
          </div>

          <div className="panel__section">
            <h2>提名与投票</h2>
            {nomination ? (
              <>
                <p>
                  提名人: <strong>{room.players.find((player) => player.seatId === nomination.nominatorSeatId)?.name}</strong>
                </p>
                <p>
                  被提名人: <strong>{room.players.find((player) => player.seatId === nomination.nomineeSeatId)?.name}</strong>
                </p>
                <p>
                  赞成票 {yesVotes} / 门槛 {threshold}
                </p>
                <div className="stack stack--inline">
                  {canHost ? (
                    <>
                      <button className="btn" onClick={() => sendMessage({ type: "begin_vote" })}>
                        开始投票
                      </button>
                      <button className="btn" onClick={() => sendMessage({ type: "lock_vote" })}>
                        锁定下一票
                      </button>
                      <button className="btn btn--primary" onClick={() => sendMessage({ type: "finish_nomination" })}>
                        结束提名
                      </button>
                      <button className="btn" onClick={() => sendMessage({ type: "set_marked", seatId: nomination.nomineeSeatId })}>
                        标记待处决
                      </button>
                    </>
                  ) : null}
                  {claimedSeat ? (
                    <>
                      <button className="btn" onClick={() => sendMessage({ type: "cast_vote", seatId: claimedSeat.seatId, vote: "yes" })}>
                        投赞成
                      </button>
                      <button className="btn" onClick={() => sendMessage({ type: "cast_vote", seatId: claimedSeat.seatId, vote: "no" })}>
                        投反对
                      </button>
                      <button className="btn" onClick={() => sendMessage({ type: "cast_vote", seatId: claimedSeat.seatId, vote: "abstain" })}>
                        弃权
                      </button>
                    </>
                  ) : null}
                </div>
              </>
            ) : canHost ? (
              <>
                <label>
                  提名人
                  <select
                    value={nominationDraft.nominatorSeatId}
                    onChange={(event) =>
                      setNominationDraft((current) => ({
                        ...current,
                        nominatorSeatId: event.target.value
                      }))
                    }
                  >
                    <option value="">选择座位</option>
                    {room.players.map((player) => (
                      <option key={player.seatId} value={player.seatId}>
                        {player.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  被提名人
                  <select
                    value={nominationDraft.nomineeSeatId}
                    onChange={(event) =>
                      setNominationDraft((current) => ({
                        ...current,
                        nomineeSeatId: event.target.value
                      }))
                    }
                  >
                    <option value="">选择座位</option>
                    {room.players.map((player) => (
                      <option key={player.seatId} value={player.seatId}>
                        {player.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="btn btn--primary"
                  onClick={() =>
                    sendMessage({
                      type: "start_nomination",
                      nominatorSeatId: nominationDraft.nominatorSeatId,
                      nomineeSeatId: nominationDraft.nomineeSeatId,
                      votingSpeedMs: room.votingSpeedMsDefault
                    })
                  }
                >
                  发起提名
                </button>
              </>
            ) : (
              <p>主持人发起提名后，你可以在这里投票。</p>
            )}
          </div>

          <div className="panel__section">
            <h2>夜晚顺序 / 参考</h2>
            <div className="reference-list">
              {editionRoles
                .slice()
                .sort((left, right) => (left.firstNight ?? 99) - (right.firstNight ?? 99))
                .map((role) => (
                  <article key={role.id} className="reference-card">
                    <header>
                      <strong>{role.name}</strong>
                      <span>{role.team}</span>
                    </header>
                    <p>{role.ability}</p>
                    <small>
                      首夜 {role.firstNight ?? "-"} · 其他夜晚 {role.otherNight ?? "-"}
                    </small>
                  </article>
                ))}
            </div>
            {room.voteHistory.length > 0 ? (
              <>
                <h3>投票历史</h3>
                <div className="reference-list">
                  {room.voteHistory.map((entry) => (
                    <article key={entry.nominationId} className="reference-card">
                      <header>
                        <strong>
                          {room.players.find((player) => player.seatId === entry.nominatorSeatId)?.name}
                          {" → "}
                          {room.players.find((player) => player.seatId === entry.nomineeSeatId)?.name}
                        </strong>
                        <span>{entry.passed ? "通过" : "未通过"}</span>
                      </header>
                      <small>
                        {Object.values(entry.votes).filter((vote) => vote === "yes").length} 赞成
                      </small>
                    </article>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </aside>
      </section>
    </main>
  );
}

function isHostSeat(session: SessionState | null, seatId: string): boolean {
  return session?.claimedSeatId === seatId;
}
