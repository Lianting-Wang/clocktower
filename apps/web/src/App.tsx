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

import { RoleImage, RolePicker, teamNames } from "./RolePicker";
import { RoleTooltip } from "./RoleTooltip";
import { buildNightOrder } from "./nightOrder";
import { NightOrderPanel } from "./NightOrderPanel";
import { ReminderPanel } from "./ReminderPanel";

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

function roleImageUrl(role?: RoleDefinition | FabledDefinition | null): string | undefined {
  if (!role) {
    return undefined;
  }
  return role.image ?? `https://oss.gstonegames.com/data_file/clocktower/role_icon/${role.imageAlt ?? role.id}.png`;
}

function teamCounts(
  room: ExportedRoomState | null,
  rolesById: Map<string, RoleDefinition>
): Record<"townsfolk" | "outsider" | "minion" | "demon" | "traveler", number> {
  const counts = {
    townsfolk: 0,
    outsider: 0,
    minion: 0,
    demon: 0,
    traveler: 0
  };

  if (!room) {
    return counts;
  }

  room.players.forEach((player) => {
    const role = player.roleId ? rolesById.get(player.roleId) : undefined;
    if (role && role.team in counts) {
      counts[role.team as keyof typeof counts] += 1;
    }
  });

  return counts;
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
      setSession(current => current ? { ...current, claimedSeatId: nextRoom.players.find(player => player.clientId === current.clientId)?.seatId ?? null } : current);
    });
  };

  const sendMessage = (payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setError("实时连接尚未建立。");
      return;
    }
    setError(null);
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
    setSelectedSeatId,
    setJoinRoomId,
    setNominationDraft,
    createRoom,
    bootstrapRoom,
    sendMessage,
    setSession,
    setRoom,
    setError
  };
}

function ClockEmblem({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 240 240" fill="none" aria-hidden="true">
      <circle cx="120" cy="120" r="111" stroke="currentColor" strokeWidth="0.6" />
      <circle cx="120" cy="120" r="101" stroke="currentColor" strokeWidth="0.6" strokeDasharray="1 5" />
      <path d="M120 0v20M120 220v20M0 120h20M220 120h20" stroke="currentColor" />
      <path d="M77 191h86M84 185V91h72v94M78 91h84L120 25 78 91ZM95 91V76m50 15V76M106 185v-35a14 14 0 0 1 28 0v35M97 185v-34m46 34v-34M91 135h58M120 14v15" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="120" cy="112" r="16" stroke="currentColor" strokeWidth="1.5" />
      <path d="M120 101v11l8 5M116 61h8M111 69h18" stroke="currentColor" strokeWidth="1.5" />
      <path d="M48 165V124l19-22 10 13m86 0 10-13 19 22v41M42 165h35m86 0h35" stroke="currentColor" opacity=".45" />
      <path d="m120 210 3 5-3 5-3-5 3-5Z" fill="currentColor" />
    </svg>
  );
}

function Brand() {
  return <div className="brand"><ClockEmblem /><span>血染钟楼<small>CLOCKTOWER LOCAL</small></span></div>;
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
    setSelectedSeatId,
    setJoinRoomId,
    setNominationDraft,
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showTravelers, setShowTravelers] = useState(false);
  const firstNightPositions = useMemo(() => new Map(buildNightOrder(editionRoles, "first", showTravelers).map(entry => [entry.role.id, entry.position])), [editionRoles, showTravelers]);
  const otherNightPositions = useMemo(() => new Map(buildNightOrder(editionRoles, "other", showTravelers).map(entry => [entry.role.id, entry.position])), [editionRoles, showTravelers]);
  const reminderSources = useMemo(() => {
    const inPlay = new Set(room?.players.flatMap(player => player.roleId ? [player.roleId] : []));
    return [...roles.filter(role => inPlay.has(role.id)), ...fabled.filter(role => room?.fabledIds.includes(role.id))];
  }, [roles, fabled, room?.players, room?.fabledIds]);
  const [tooltip, setTooltip] = useState<{ anchor: HTMLElement | null; text: string }>({ anchor: null, text: "" });
  const [controlsOpen, setControlsOpen] = useState(false);
  const [entering, setEntering] = useState(false);
  const [panelMode, setPanelMode] = useState<"seat" | "host" | "reference" | "night" | "history" | null>(null);
  useEffect(() => {
    const dismissPanels = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTooltip({ anchor: null, text: "" });
        setPickerOpen(false);
        setControlsOpen(false);
        setPanelMode(null);
      }
    };
    window.addEventListener("keydown", dismissPanels);
    return () => window.removeEventListener("keydown", dismissPanels);
  }, []);

  const aliveCount = room?.players.filter((player) => !player.isDead).length ?? 0;
  const availableVotes = room?.players.filter((player) => !player.isVoteless).length ?? 0;
  const roleCounts = useMemo(() => teamCounts(room, rolesById), [room, rolesById]);
  const selectedSeatRole = selectedSeat?.roleId ? rolesById.get(selectedSeat.roleId) : undefined;
  const panelTitleMap: Record<NonNullable<typeof panelMode>, string> = {
    seat: "座位详情",
    host: canHost ? "主持控制台" : "房间信息",
    reference: "角色能力表",
    night: "夜晚顺序表",
    history: "投票历史"
  };
  const connectionLabel =
    status === "connected"
      ? "已连接"
      : status === "reconnecting"
        ? "重连中"
        : status === "loading"
          ? "载入中"
          : status === "error"
            ? "错误"
            : "空闲";
  const sessionLabel =
    session?.role === "host" ? "主持人" : session?.role === "spectator" ? "观战" : "玩家";

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

  };

  const handleReleaseSeat = (seatId: string) => {
    sendMessage({ type: "release_seat", seatId });

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

  const enterRoom = async (create: boolean) => {
    setEntering(true);
    setError(null);
    try {
      await (create ? createRoom() : handleJoinRoom());
    } catch (reason) {
      setError(formatClientError(reason, "暂时无法进入房间，请稍后重试。"));
    } finally {
      setEntering(false);
    }
  };

  if (!room || !session) {
    return (
      <main className="landing">
        <header className="landing-header">
          <Brand />
          <span className="header-caption">一场关于信任与谎言的游戏</span>
          <span className="connection"><i className={catalog ? "ready" : ""} />{catalog ? "魔典已就绪" : "正在准备魔典"}</span>
        </header>
        <section className="hero">
          <div className="hero__story">
            <span className="eyebrow"><span /> THE TOWN AWAITS</span>
            <h1>夜幕将至，<br />故事由你<span>开启。</span></h1>
            <p className="hero__description">钟声响起，小镇苏醒。<br />召集你的伙伴，在交谈与推理之间，找出藏匿的真相。</p>
            <div className="hero__details"><span>社交推理</span><span>角色扮演</span><span>实时同步</span></div>
          </div>
          <div className="entry-card">
            <div className="entry-card__art"><ClockEmblem /><span>每个座位，都有一个秘密。</span></div>
            <div className="entry-card__body">
              <div className="entry-card__title"><h2>欢迎来到小镇</h2><span>YOUR NEXT STORY</span></div>
              <p>成为说书人，或赴一场朋友的邀约。</p>
              <button className="btn btn--primary create-room" disabled={entering} onClick={() => void enterRoom(true)}>
                <span>{entering ? "正在进入…" : "创建房间"}</span><span aria-hidden="true">↗</span>
              </button>
              <div className="entry-divider"><span>已有邀约</span></div>
              <form className="join-box" onSubmit={(event) => { event.preventDefault(); void enterRoom(false); }}>
                <label className="sr-only" htmlFor="room-code">房间号</label>
                <input id="room-code" value={joinRoomId} onChange={(event) => setJoinRoomId(event.target.value)} placeholder="输入房间号" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
                <button className="btn" disabled={entering} type="submit">加入 <span aria-hidden="true">→</span></button>
              </form>
              {error ? <p className="error-banner" role="alert">{error}</p> : null}
              <div className="entry-note"><span aria-hidden="true">◇</span> 无需注册，入座即刻开始</div>
            </div>
          </div>
        </section>
        <section className="landing-features" aria-label="游戏体验">
          <article><span className="feature-number">01</span><div><h3>准备你的魔典</h3><p>选择剧本，安排角色，让故事就位。</p></div></article>
          <article><span className="feature-number">02</span><div><h3>邀请伙伴入座</h3><p>分享房间，与熟悉的声音再次相聚。</p></div></article>
          <article><span className="feature-number">03</span><div><h3>让真相浮出水面</h3><p>从第一夜到最后一票，一同见证结局。</p></div></article>
        </section>
        <footer className="landing-footer"><span>本地自托管的血染钟楼魔典</span><span>好故事，始于同一张圆桌。 <span aria-hidden="true">✦</span></span></footer>
      </main>
    );
  }

  return (
    <main className={`grimoire-root ${room.phase === "night" ? "is-night" : "is-day"}`}>
      <section
        className={`grimoire-shell ${panelMode ? "has-panel" : ""}`}
        style={
          room.backgroundUrl
            ? {
                backgroundImage: room.backgroundUrl.startsWith("linear-gradient")
                  ? room.backgroundUrl
                  : `url("${room.backgroundUrl}")`,
                backgroundPosition: "center",
                backgroundSize: "cover"
              }
            : undefined
        }
      >
        <header className="game-header">
          <Brand />
          <nav className="game-nav" aria-label="魔典工具">
            <button className={panelMode === "reference" ? "active" : ""} onClick={() => setPanelMode("reference")}>角色能力</button>
            <button className={panelMode === "night" ? "active" : ""} onClick={() => setPanelMode("night")}>夜晚顺序</button>
            <button className={panelMode === "history" ? "active" : ""} onClick={() => setPanelMode("history")}>投票历史</button>
          </nav>
          <div id="controls">
            <span className="connection"><i className={status === "connected" ? "ready" : ""} />{sessionLabel} · {connectionLabel}</span>
            <button className="menu-toggle" onClick={() => setControlsOpen(!controlsOpen)} aria-label="切换控制菜单" aria-expanded={controlsOpen} aria-controls="room-menu">•••</button>
            {controlsOpen ? <div className="menu" id="room-menu">
              <span className="eyebrow">房间 {room.id}</span>
              <button onClick={() => { setPanelMode("host"); setControlsOpen(false); }}>{canHost ? "主持控制台" : "房间信息"}</button>
              <button onClick={handleExportState}>导出状态</button>
              <button onClick={() => { window.history.replaceState({}, "", "/"); window.location.reload(); }}>离开小镇 ↗</button>
            </div> : null}
          </div>
        </header>
        <aside className="game-sidebar">
          <div className="room-heading"><span className="eyebrow">THE GRIMOIRE</span><span className="room-code">#{room.id}</span></div>
          <div className="script-card">
            <div className="script-card__art">{room.edition?.image ? <img src={room.edition.image} alt="" /> : <ClockEmblem />}</div>
            <span className="eyebrow">当前剧本</span>
            <h2>{room.edition?.name ?? "故事尚未开启"}</h2>
            <p>{room.edition?.author ? `作者 / ${room.edition.author}` : "选好剧本，等待第一声钟响。"}</p>
            {canHost ? <button className="btn btn--primary" onClick={() => { setPickerOpen(true); setTooltip({ anchor: null, text: "" }); }}>选择剧本与角色 <span aria-hidden="true">↗</span></button> : null}
            <button className="btn" onClick={() => setPanelMode("host")}>{canHost ? "房间设置" : "查看房间信息"} <span aria-hidden="true">↗</span></button>
            {!canHost && claimedSeat ? <button className="btn btn--primary" onClick={() => { setSelectedSeatId(claimedSeat.seatId); setPanelMode("seat"); }}>查看我的身份</button> : null}
          </div>
          <section className="town-overview" aria-label="小镇概览">
            <h3>小镇概览</h3>
            <div className="town-stats"><div><strong>{room.players.length}</strong><span>玩家</span></div><div><strong>{aliveCount}</strong><span>存活</span></div><div><strong>{availableVotes}</strong><span>可投票</span></div></div>
            {canHost || room.isGrimoirePublic ? <div className="team-counts"><span className="townsfolk">镇民 <b>{roleCounts.townsfolk}</b></span><span className="outsider">外来者 <b>{roleCounts.outsider}</b></span><span className="minion">爪牙 <b>{roleCounts.minion}</b></span><span className="demon">恶魔 <b>{roleCounts.demon}</b></span>{roleCounts.traveler ? <span>旅行者 <b>{roleCounts.traveler}</b></span> : null}</div> : null}
          </section>
          <div className="phase-card"><span className="phase-symbol" aria-hidden="true">{room.phase === "night" ? "☾" : "☼"}</span><div><strong>{room.phase === "night" ? "夜幕降临" : "白昼时分"}</strong><span>{room.phase === "night" ? "小镇沉睡，秘密苏醒。" : "倾听每一个人的故事。"}</span></div></div>
          {canHost ? <button className="btn phase-action" onClick={() => sendMessage({ type: "set_phase", phase: room.phase === "day" ? "night" : "day" })}>进入{room.phase === "day" ? "夜晚" : "白天"}<span aria-hidden="true">→</span></button> : null}
          <p className="sidebar-note">每一句话，都可能改变结局。</p>
        </aside>
        <section className="table-area" aria-label="小镇圆桌">
          <div className="table-heading"><div><span className="eyebrow">TOWN SQUARE</span><h2>小镇圆桌</h2></div><span className="phase-tag">{room.phase === "night" ? "☾ 夜晚" : "☼ 白天"}</span></div>
          {error && !panelMode ? <p className="error-banner" role="alert">{error}</p> : null}
        <div
          id="townsquare"
          className={`${session.role === "spectator" ? "spectator" : ""} ${nomination ? "vote" : ""}`}
        >
          <div className="table-center"><ClockEmblem /><strong>{room.edition?.name ?? "静候开场"}</strong><span>{room.players.length ? "点击座位，翻开你的故事" : "添加座位，邀请伙伴入座"}</span>{!room.players.length && canHost ? <button className="btn" onClick={() => sendMessage({ type: "add_seat" })}>添加座位</button> : null}</div>
          <ul className={`circle size-${Math.min(Math.max(room.players.length, 1), 15)}`}>
            {room.players.map((player, index) => {
              const role = player.roleId ? rolesById.get(player.roleId) : undefined;
              const isClaimedByMe = player.seatId === session.claimedSeatId;
              const revealRole = canHost || (room.rolesDistributed && (isClaimedByMe || room.isGrimoirePublic));
              const visibleRole = revealRole ? role : undefined;
              const teamClass = visibleRole?.team ?? "default";
              const firstPosition = canHost && role ? firstNightPositions.get(role.id) : undefined;
              const otherPosition = canHost && role ? otherNightPositions.get(role.id) : undefined;
              const curveId = `curve-${player.seatId}`;
              const displayLabel = visibleRole?.name ?? (player.clientId ? "保密" : "空位");
              const tokenAbility = visibleRole?.ability ?? (player.clientId ? "该玩家的角色当前对你隐藏。" : "点击后可认领该座位。");
              const reminderPreview = player.reminders.slice(0, 2);

              return (
                <li
                  key={player.seatId}
                  style={{ ...roundPosition(index, room.players.length), width: `${room.players.length <= 6 ? 18 : room.players.length <= 10 ? 15 : room.players.length <= 15 ? 12 : 10}%`, zIndex: selectedSeatId === player.seatId ? 40 : room.players.length - index }}
                >
                  <div className="seat-shell">
                    <div
                      className={`player ${teamClass} ${player.isDead ? "dead" : ""} ${
                        player.isVoteless ? "no-vote" : ""
                      } ${isClaimedByMe ? "you" : ""} ${
                        room.markedSeatId === player.seatId ? "marked" : ""
                      }`}
                    >
                      <div className="life" />
                      {([
                        { period: "first", label: "首个夜晚", position: firstPosition, reminder: role?.firstNightReminder },
                        { period: "other", label: "其他夜晚", position: otherPosition, reminder: role?.otherNightReminder }
                      ]).map(({ period, label, position, reminder }) => position ? <button
                        key={period}
                        type="button"
                        className={`night-order ${period}`}
                        aria-label={`${label}第 ${position} 位行动`}
                        onMouseEnter={event => setTooltip({ anchor: event.currentTarget, text: `${label} · 第 ${position} 位行动。${reminder || role?.ability || ""}` })}
                        onMouseLeave={() => setTooltip({ anchor: null, text: "" })}
                        onFocus={event => setTooltip({ anchor: event.currentTarget, text: `${label} · 第 ${position} 位行动。${reminder || role?.ability || ""}` })}
                        onBlur={() => setTooltip({ anchor: null, text: "" })}
                      ><em>{position}</em></button> : null)}
                      <button
                        type="button"
                        className={`token ${visibleRole?.id ?? (player.clientId ? "hidden" : "empty")}`}
                        aria-label={`${index + 1}号座位 ${player.name} · ${displayLabel}`}
                        onMouseEnter={event => setTooltip({ anchor: event.currentTarget, text: tokenAbility })}
                        onMouseLeave={() => setTooltip({ anchor: null, text: "" })}
                        onFocus={event => setTooltip({ anchor: event.currentTarget, text: tokenAbility })}
                        onBlur={() => setTooltip({ anchor: null, text: "" })}
                        onClick={() => {
                          setSelectedSeatId(player.seatId);
                          setPanelMode("seat");
                        }}
                      >
                        {!visibleRole ? <span className="empty-symbol" aria-hidden="true">{player.clientId ? "◇" : "+"}</span> : null}
                        {visibleRole ? (
                          <>
                            <span
                              className="icon"
                              style={
                                roleImageUrl(visibleRole)
                                  ? { backgroundImage: `url("${roleImageUrl(visibleRole)}")` }
                                  : undefined
                              }
                            />
                            {visibleRole.firstNight || visibleRole.firstNightReminder ? <span className="leaf-left" /> : null}
                            {visibleRole.otherNight || visibleRole.otherNightReminder ? <span className="leaf-right" /> : null}
                            {visibleRole.setup ? <span className="leaf-orange" /> : null}
                          </>
                        ) : null}
                        <svg viewBox="0 0 150 150" className="name">
                          <path d="M 13 75 C 13 160, 138 160, 138 75" id={curveId} fill="transparent" />
                          <text
                            width="150"
                            x="66.6%"
                            textAnchor="middle"
                            fontSize={displayLabel.length > 8 ? "90%" : "110%"}
                            className="label mozilla"
                          >
                            <textPath href={`#${curveId}`}> {displayLabel} </textPath>
                          </text>
                        </svg>
                        <div className={`edition edition-${teamClass}`} />
                      </button>
                      <div className="overlay">
                        {room.markedSeatId === player.seatId ? <span className="overlay-badge overlay-badge--marked">处</span> : null}
                        {nomination?.votes[player.seatId] === "yes" ? <span className="overlay-badge overlay-badge--yes">赞</span> : null}
                        {isClaimedByMe ? <span className="overlay-badge overlay-badge--seat">座</span> : null}
                      </div>
                      <button
                        type="button"
                        className={`name1 ${selectedSeatId === player.seatId ? "active" : ""}`}
                        title={player.pronouns ? `${player.name} · ${player.pronouns}` : player.name}
                        onClick={() => {
                          setSelectedSeatId(player.seatId);
                          setPanelMode("seat");
                        }}
                      >
                        <span className="play_num">{index + 1}.</span>
                        <span className="play_name">{player.name}</span>
                      </button>
                      {reminderPreview.map((reminder, reminderIndex) => (
                        <div
                          key={reminder.id}
                          className={`reminder ${reminder.isCustom ? "custom" : ""}`}
                          title={`${reminder.name}${reminder.roleId ? ` · ${rolesById.get(reminder.roleId)?.name ?? reminderSources.find(role => role.id === reminder.roleId)?.name ?? ""}` : ""}`}
                          style={{
                            left: `${-14 + reminderIndex * 14}%`,
                            bottom: `${reminderIndex * 14 - 2}%`
                          }}
                        >
                          {reminder.iconUrl ? (
                            <span className="icon" style={{ backgroundImage: `url("${reminder.iconUrl}")` }} />
                          ) : null}
                          <span className="text">{reminder.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {nomination ? (
            <button className="vote-banner" onClick={() => { setPanelMode("seat"); setSelectedSeatId(nomination.nomineeSeatId); }}>
              <strong>
                {room.players.find((player) => player.seatId === nomination.nominatorSeatId)?.name}
                {" → "}
                {room.players.find((player) => player.seatId === nomination.nomineeSeatId)?.name}
              </strong>
              <span>
                {yesVotes} / {threshold}
              </span>
            </button>
          ) : null}
        </div>
        <div className="table-footer"><span><i /> {room.players.filter((player) => player.clientId).length} 位玩家已入座</span><span>处决门槛 <strong>{threshold}</strong> 票</span>{canHost ? <span>夜序 · 左：首夜 / 右：其他夜晚</span> : null}</div>
        </section>

        {panelMode ? (
          <section key={panelMode === "seat" ? `seat:${selectedSeatId}` : panelMode} className="grimoire-console" aria-label={panelTitleMap[panelMode]}>
            <header className="grimoire-console__header">
              <div>
                <span className="grimoire-console__eyebrow">房间 {room.id}</span>
                <h2>{panelTitleMap[panelMode]}</h2>
              </div>
              <button type="button" className="console-close" onClick={() => setPanelMode(null)}>
                关闭
              </button>
            </header>

            {error ? <p className="error-banner">{error}</p> : null}
            {contentIssues.length ? (
              <div className="issue-strip">
                {contentIssues.map((issue) => (
                  <span key={issue}>{issue}</span>
                ))}
              </div>
            ) : null}

            {panelMode === "seat" ? (
              selectedSeat ? (
                <div className="console-grid" key={selectedSeat.seatId}>
                  <section className="console-section">
                    <h3>座位信息</h3>
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
                    <div className="console-inline">
                      <span>{selectedSeat.clientId ? "已入座" : "空位"}</span>
                      <span>{selectedSeat.isDead ? "死亡" : "存活"}</span>
                      <span>{selectedSeat.isVoteless ? "无票" : "有票"}</span>
                    </div>
                    <div className="console-actions">
                      {!selectedSeat.clientId ? (
                        <button className="btn btn--primary" onClick={() => handleClaimSeat(selectedSeat.seatId)}>
                          认领座位
                        </button>
                      ) : isHostSeat(session, selectedSeat.seatId) ? (
                        <button className="btn" onClick={() => handleReleaseSeat(selectedSeat.seatId)}>
                          起身
                        </button>
                      ) : null}
                      {canHost ? (
                        <>
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
                          <button
                            className="btn"
                            onClick={() =>
                              sendMessage({
                                type: "set_marked",
                                seatId: room.markedSeatId === selectedSeat.seatId ? null : selectedSeat.seatId
                              })
                            }
                          >
                            {room.markedSeatId === selectedSeat.seatId ? "取消处决标记" : "标记待处决"}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </section>

                  <section className="console-section">
                    <h3>角色与备忘</h3>
                    <p className="console-copy">
                      当前角色:{" "}
                      <strong>
                        {canHost || selectedSeat.seatId === session.claimedSeatId || room.isGrimoirePublic
                          ? selectedSeatRole?.name ?? "未分配"
                          : selectedSeat.clientId
                            ? "保密"
                            : "空位"}
                      </strong>
                    </p>
                    {canHost ? (
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
                    ) : null}
                    {selectedSeatRole ? <p className="console-copy">{selectedSeatRole.ability}</p> : null}
                    {!canHost && !room.rolesDistributed ? <p className="picker-help">主持人尚未发放身份。请确认座位后等待分发。</p> : null}
                    {canHost && selectedSeat.perceivedRoleId ? <p className="console-copy">玩家看到的身份：{rolesById.get(selectedSeat.perceivedRoleId)?.name}</p> : null}
                    {(selectedSeatRole?.team === "demon" && (canHost || selectedSeat.seatId === claimedSeat?.seatId)) && room.bluffRoleIds.length > 0 ? <section className="demon-bluffs"><h3>恶魔伪装</h3>{room.bluffRoleIds.map(id => { const bluff = rolesById.get(id); return bluff ? <article key={id}><RoleImage role={bluff} /><div><strong>{bluff.name}</strong><p>{bluff.ability}</p></div></article> : null; })}</section> : null}
                    {canHost ? <ReminderPanel player={selectedSeat} sources={reminderSources} onSend={sendMessage} /> : null}
                  </section>

                  <section className="console-section">
                    <h3>提名与投票</h3>
                    {nomination ? (
                      <>
                        <p className="console-copy">
                          提名人:{" "}
                          <strong>
                            {room.players.find((player) => player.seatId === nomination.nominatorSeatId)?.name}
                          </strong>
                        </p>
                        <p className="console-copy">
                          被提名人:{" "}
                          <strong>
                            {room.players.find((player) => player.seatId === nomination.nomineeSeatId)?.name}
                          </strong>
                        </p>
                        <p className="console-copy">
                          赞成票 {yesVotes} / 门槛 {threshold}
                        </p>
                        <div className="console-actions">
                          {canHost ? (
                            <>
                              <button className="btn" onClick={() => sendMessage({ type: "begin_vote" })}>
                                开始投票
                              </button>
                              <button className="btn" onClick={() => sendMessage({ type: "lock_vote" })}>
                                锁定下一票
                              </button>
                              <button
                                className="btn btn--primary"
                                onClick={() => sendMessage({ type: "finish_nomination" })}
                              >
                                结束提名
                              </button>
                            </>
                          ) : null}
                          {claimedSeat ? (
                            <>
                              <button
                                className="btn"
                                onClick={() =>
                                  sendMessage({
                                    type: "cast_vote",
                                    seatId: claimedSeat.seatId,
                                    vote: "yes"
                                  })
                                }
                              >
                                投赞成
                              </button>
                              <button
                                className="btn"
                                onClick={() =>
                                  sendMessage({
                                    type: "cast_vote",
                                    seatId: claimedSeat.seatId,
                                    vote: "no"
                                  })
                                }
                              >
                                投反对
                              </button>
                              <button
                                className="btn"
                                onClick={() =>
                                  sendMessage({
                                    type: "cast_vote",
                                    seatId: claimedSeat.seatId,
                                    vote: "abstain"
                                  })
                                }
                              >
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
                      <p className="console-copy">主持人发起提名后，你可以在这里投票。</p>
                    )}
                  </section>
                </div>
              ) : (
                <p className="console-copy">点击圆桌上的玩家座位查看详情。</p>
              )
            ) : null}

            {panelMode === "host" ? (
              <div className="console-grid console-grid--wide">
                <section className="console-section">
                  <h3>房间操作</h3>
                  <div className="console-actions">
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
                        <button className="btn" onClick={() => sendMessage({ type: "add_seat" })}>
                          添加座位
                        </button>
                        {selectedSeat ? (
                          <button
                            className="btn"
                            onClick={() => sendMessage({ type: "remove_seat", seatId: selectedSeat.seatId })}
                          >
                            移除选中座位
                          </button>
                        ) : null}
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
                        <button
                          className="btn"
                          onClick={() =>
                            sendMessage({
                              type: "set_vote_history_allowed",
                              value: !room.isVoteHistoryAllowed
                            })
                          }
                        >
                          投票历史: {room.isVoteHistoryAllowed ? "开启" : "关闭"}
                        </button>
                        <button className="btn" onClick={() => sendMessage({ type: "set_edition", edition: null })}>
                          清空剧本
                        </button>
                        <button className="btn" onClick={() => sendMessage({ type: "clear_custom_script" })}>
                          清除自定义剧本
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
                      </>
                    ) : null}
                  </div>
                </section>

                <section className="console-section">
                  <h3>剧本与角色</h3>
                  <p className="console-copy">{room.edition?.name ?? "尚未选择剧本"}</p>
                  <p className="console-copy">{room.rolesDistributed ? "身份已发放" : "身份未发放，玩家不可见"}</p>
                  {canHost ? <button className="btn btn--primary" onClick={() => setPickerOpen(true)}>打开角色选择</button> : null}
                </section>

                <section className="console-section">
                  <h3>奇遇</h3>
                  <div className="catalog-grid catalog-grid--dense">
                    {fabled.map((item) => {
                      const active = room.fabledIds.includes(item.id);
                      return (
                        <button
                          key={item.id}
                          className={`catalog-pill ${active ? "is-selected" : ""}`}
                          aria-pressed={active}
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
                </section>
              </div>
            ) : null}

            {panelMode === "reference" ? (
              <div className="reference-list">
                {editionRoles.filter(role => showTravelers || role.team !== "traveler").map((role) => (
                  <article key={role.id} className={`reference-card ${role.team}`}>
                    <header>
                      <strong>{role.name}</strong>
                      <span>{teamNames[role.team]}</span>
                    </header>
                    <p>{role.ability}</p>
                    <small>
                      首夜 {firstNightPositions.has(role.id) ? `第 ${firstNightPositions.get(role.id)} 位` : "—"} · 其他夜晚 {otherNightPositions.has(role.id) ? `第 ${otherNightPositions.get(role.id)} 位` : "—"}
                    </small>
                  </article>
                ))}
              </div>
            ) : null}

            {panelMode === "night" ? (
              <NightOrderPanel roles={editionRoles} showTravelers={showTravelers} />
            ) : null}

            {panelMode === "history" ? (
              room.voteHistory.length > 0 ? (
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
                        {Object.values(entry.votes).filter((vote) => vote === "yes").length} 赞成 ·{" "}
                        {new Date(entry.finishedAt).toLocaleString()}
                      </small>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="console-copy">还没有已完成的投票记录。</p>
              )
            ) : null}
          </section>
        ) : null}
      </section>
      {canHost ? <RolePicker showTravelers={showTravelers} onShowTravelersChange={setShowTravelers} open={pickerOpen} room={room} catalog={catalog} onClose={() => setPickerOpen(false)} onSend={sendMessage} serverError={error} /> : null}
      {!pickerOpen ? <RoleTooltip anchor={tooltip.anchor} text={tooltip.text} /> : null}
    </main>
  );
}

function isHostSeat(session: SessionState | null, seatId: string): boolean {
  return session?.claimedSeatId === seatId;
}
