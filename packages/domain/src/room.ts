import {
  type ApplyRoomCommandOptions,
  type ContentOverride,
  type CreateRoomOptions,
  type EditionSummary,
  type ExportedRoomState,
  type FabledDefinition,
  type PlayerState,
  type ReminderToken,
  type RoleDefinition,
  type RoomCommand,
  type RoomState,
  type VoteChoice,
  type VoteHistoryEntry
} from "./types.js";

const DEFAULT_VOTING_SPEED_MS = 4_000;
const DEFAULT_ROOM_TTL_HOURS = 24;

function iso(input?: string | Date): string {
  return input instanceof Date
    ? input.toISOString()
    : input ?? new Date().toISOString();
}

function addHours(fromIso: string, hours: number): string {
  const date = new Date(fromIso);
  date.setHours(date.getHours() + hours);
  return date.toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createId(prefix: string, random: () => number = Math.random): string {
  const token = Math.floor(random() * 36 ** 8)
    .toString(36)
    .padStart(8, "0");
  return `${prefix}_${token}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function bySeatId(players: PlayerState[], seatId: string): PlayerState {
  const player = players.find((item) => item.seatId === seatId);
  if (!player) {
    throw new Error(`Seat ${seatId} was not found.`);
  }
  return player;
}

function nextSeatName(players: PlayerState[]): string {
  return `玩家 ${players.length + 1}`;
}

function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function normalizeCustomRoles(
  roles: RoleDefinition[],
  fabled: FabledDefinition[] = []
): ContentOverride {
  const edition: EditionSummary = {
    id: "custom",
    name: "自定义剧本",
    roles: roles.filter((role) => role.team !== "fabled").map((role) => role.id),
    fabledIds: fabled.map((item) => item.id),
    isOfficial: false
  };

  return {
    edition,
    roles: roles.map((role) => ({ ...role })),
    fabled: fabled.map((item) => ({ ...item }))
  };
}

export function createRoomState(options: CreateRoomOptions): RoomState {
  const createdAt = iso(options.createdAt);

  return {
    id: options.roomId,
    hostSecret: options.hostSecret,
    createdAt,
    updatedAt: createdAt,
    expiresAt: options.expiresAt ?? addHours(createdAt, DEFAULT_ROOM_TTL_HOURS),
    phase: "day",
    players: [],
    markedSeatId: null,
    nomination: null,
    voteHistory: [],
    isVoteHistoryAllowed: true,
    isGrimoirePublic: false,
    isPlayerInfoPublic: false,
    votingSpeedMsDefault: DEFAULT_VOTING_SPEED_MS,
    fabledIds: [],
    bluffRoleIds: [],
    rolesDistributed: false,
    edition: null,
    customScript: null,
    backgroundUrl: null,
    issues: []
  };
}

export function exportRoomState(room: RoomState): ExportedRoomState {
  const { hostSecret: _hostSecret, ...safe } = clone(room);
  return safe;
}

export function importRoomState(
  current: RoomState,
  state: ExportedRoomState,
  options: ApplyRoomCommandOptions = {}
): RoomState {
  const next = clone(state) as RoomState;
  next.hostSecret = current.hostSecret;
  next.id = current.id;
  next.createdAt = current.createdAt;
  next.updatedAt = iso(options.now);
  next.expiresAt = options.expiresAt ?? current.expiresAt;
  return next;
}

function finishNominationInternal(
  room: RoomState,
  now: string
): RoomState {
  if (!room.nomination) {
    return room;
  }

  const alivePlayers = room.players.filter((player) => !player.isDead);
  const yesVotes = Object.values(room.nomination.votes).filter(
    (vote) => vote === "yes"
  ).length;
  const passed = yesVotes >= Math.ceil(alivePlayers.length / 2);

  const entry: VoteHistoryEntry = {
    nominationId: room.nomination.id,
    nominatorSeatId: room.nomination.nominatorSeatId,
    nomineeSeatId: room.nomination.nomineeSeatId,
    votes: clone(room.nomination.votes),
    lockedCount: room.nomination.lockedCount,
    startedAt: room.nomination.startedAt ?? now,
    finishedAt: now,
    passed
  };

  return {
    ...room,
    nomination: null,
    voteHistory: [...room.voteHistory, entry],
    markedSeatId: passed ? entry.nomineeSeatId : room.markedSeatId
  };
}

export function applyRoomCommand(
  current: RoomState,
  command: RoomCommand,
  options: ApplyRoomCommandOptions = {}
): RoomState {
  const now = iso(options.now);
  const random = options.random ?? Math.random;
  const room = clone(current);

  switch (command.type) {
    case "add_seat": {
      room.players.push({
        seatId: command.seatId ?? createId("seat", random),
        name: command.name ?? nextSeatName(room.players),
        isDead: false,
        isVoteless: false,
        reminders: []
      });
      break;
    }

    case "remove_seat": {
      room.players = room.players.filter((player) => player.seatId !== command.seatId);
      if (
        room.nomination &&
        (room.nomination.nomineeSeatId === command.seatId ||
          room.nomination.nominatorSeatId === command.seatId)
      ) {
        room.nomination = null;
      }
      if (room.markedSeatId === command.seatId) {
        room.markedSeatId = null;
      }
      break;
    }

    case "claim_seat": {
      const player = bySeatId(room.players, command.seatId);
      if (player.clientId && player.clientId !== command.clientId) {
        throw new Error("Seat is already claimed by another player.");
      }
      const existing = room.players.find(seat => seat.clientId === command.clientId && seat.seatId !== player.seatId);
      if (existing) throw new Error("请先从当前座位起身，再认领其他座位。");
      player.clientId = command.clientId;
      if (command.name?.trim()) {
        player.name = command.name.trim();
      }
      break;
    }

    case "release_seat": {
      const player = bySeatId(room.players, command.seatId);
      if (command.clientId && player.clientId && player.clientId !== command.clientId) {
        throw new Error("Seat is claimed by another client.");
      }
      delete player.clientId;
      break;
    }

    case "update_player": {
      const player = bySeatId(room.players, command.seatId);
      if (typeof command.patch.name === "string") {
        player.name = command.patch.name;
      }
      if (typeof command.patch.pronouns === "string") {
        player.pronouns = command.patch.pronouns;
      }
      if (command.patch.pronouns === null) {
        delete player.pronouns;
      }
      if (typeof command.patch.isDead === "boolean") {
        player.isDead = command.patch.isDead;
        if (!command.patch.isDead) {
          player.isVoteless = false;
        }
      }
      if (typeof command.patch.isVoteless === "boolean") {
        player.isVoteless = command.patch.isVoteless;
      }
      if (command.patch.roleId !== undefined) delete player.perceivedRoleId;
      if (command.patch.roleId === null) {
        delete player.roleId;
      } else if (typeof command.patch.roleId === "string") {
        player.roleId = command.patch.roleId;
      }
      break;
    }

    case "set_phase": {
      room.phase = command.phase;
      break;
    }

    case "set_marked": {
      room.markedSeatId = command.seatId;
      break;
    }

    case "set_vote_history_allowed": {
      room.isVoteHistoryAllowed = command.value;
      break;
    }

    case "set_background": {
      room.backgroundUrl = command.backgroundUrl;
      break;
    }

    case "set_fabled": {
      room.fabledIds = unique(command.fabledIds);
      break;
    }

    case "set_bluffs": {
      validateBluffs(command.bluffRoleIds, room.players.map(player => player.roleId ?? ""), [...(options.roleCatalog ?? []), ...(room.customScript?.roles ?? [])], room.players.find(player => player.roleId === "drunk")?.perceivedRoleId);
      room.bluffRoleIds = [...command.bluffRoleIds];
      break;
    }

    case "set_edition": {
      room.rolesDistributed = false;
      room.bluffRoleIds = [];
      room.players.forEach(player => { delete player.roleId; delete player.perceivedRoleId; player.reminders = []; });
      room.edition = command.edition ? clone(command.edition) : null;
      room.customScript = null;
      if (!command.edition) {
        room.fabledIds = [];
        room.bluffRoleIds = [];
      }
      break;
    }

    case "set_custom_script": {
      room.rolesDistributed = false;
      room.bluffRoleIds = [];
      room.players.forEach(player => { delete player.roleId; delete player.perceivedRoleId; player.reminders = []; });
      const override = normalizeCustomRoles(command.roles, command.fabled);
      override.edition = {
        ...override.edition,
        ...command.editionMeta
      };
      room.customScript = override;
      room.edition = override.edition;
      room.fabledIds = unique(override.edition.fabledIds ?? []);
      break;
    }

    case "clear_custom_script": {
      room.customScript = null;
      break;
    }

    case "hide_roles": {
      room.rolesDistributed = false;
      break;
    }

    case "distribute_roles": {
      const catalog = [...(options.roleCatalog ?? []), ...(room.customScript?.roles ?? [])];
      const roles = new Map(catalog.map(role => [role.id, role]));
      const seats = room.players;
      if (!seats.length || command.roleIds.length !== seats.length || new Set(command.roleIds).size !== command.roleIds.length) {
        throw new Error("预选角色必须与座位数一致，且不能重复。");
      }
      if (catalog.length && command.roleIds.some(id => !roles.has(id) || roles.get(id)!.team === "fabled" || (room.edition && !room.edition.roles.includes(id)))) {
        throw new Error("请选择当前剧本中的角色。");
      }
      if (command.roleIds.includes("drunk") && (!command.drunkAsRoleId || roles.get(command.drunkAsRoleId)?.team !== "townsfolk" || command.roleIds.includes(command.drunkAsRoleId) || !room.edition?.roles.includes(command.drunkAsRoleId))) {
        throw new Error("请为酒鬼选择一个未入场的镇民身份。");
      }
      const bluffs = command.bluffRoleIds ?? [];
      validateBluffs(bluffs, command.roleIds, catalog, command.drunkAsRoleId);
      const ordinaryCount = command.roleIds.filter(id => roles.get(id)?.team !== "traveler").length;
      if (ordinaryCount >= 7 && command.roleIds.some(id => roles.get(id)?.team === "demon") && bluffs.length !== 3) throw new Error("请先为恶魔设置三个未入场的善良角色作为伪装。");
      if (room.edition && bluffs.some(id => !room.edition!.roles.includes(id))) throw new Error("恶魔伪装必须来自当前剧本。");
      const shuffledRoles = shuffle(command.roleIds, random);
      seats.forEach((player, index) => {
        player.roleId = shuffledRoles[index];
        player.perceivedRoleId = player.roleId === "drunk" ? command.drunkAsRoleId : undefined;
        player.reminders = [];
      });
      room.bluffRoleIds = bluffs;
      room.rolesDistributed = true;
      break;
    }

    case "set_reminders": {
      const player = bySeatId(room.players, command.seatId);
      player.reminders = command.reminders.map((reminder) => ({ ...reminder }));
      break;
    }

    case "upsert_reminder": {
      const player = bySeatId(room.players, command.seatId);
      const existing = player.reminders.findIndex(
        (item) => item.id === command.reminder.id
      );
      if (existing === -1) {
        player.reminders.push({ ...command.reminder });
      } else {
        player.reminders[existing] = { ...command.reminder };
      }
      break;
    }

    case "remove_reminder": {
      const player = bySeatId(room.players, command.seatId);
      player.reminders = player.reminders.filter(
        (item) => item.id !== command.reminderId
      );
      break;
    }

    case "start_nomination": {
      bySeatId(room.players, command.nominatorSeatId);
      bySeatId(room.players, command.nomineeSeatId);
      room.nomination = {
        id: createId("nom", random),
        nominatorSeatId: command.nominatorSeatId,
        nomineeSeatId: command.nomineeSeatId,
        isVoteInProgress: false,
        votingSpeedMs: command.votingSpeedMs ?? room.votingSpeedMsDefault,
        lockedCount: 0,
        votes: {}
      };
      break;
    }

    case "begin_vote": {
      if (!room.nomination) {
        throw new Error("There is no active nomination.");
      }
      room.nomination.isVoteInProgress = true;
      room.nomination.startedAt = now;
      room.nomination.pausedAt = undefined;
      break;
    }

    case "cast_vote": {
      if (!room.nomination) {
        throw new Error("There is no active nomination.");
      }
      bySeatId(room.players, command.seatId);
      room.nomination.votes[command.seatId] = command.vote;
      break;
    }

    case "lock_vote": {
      if (!room.nomination) {
        throw new Error("There is no active nomination.");
      }
      const maxCount = room.players.length;
      room.nomination.lockedCount =
        typeof command.count === "number"
          ? Math.min(Math.max(command.count, 0), maxCount)
          : Math.min(room.nomination.lockedCount + 1, maxCount);
      break;
    }

    case "finish_nomination": {
      return stampRoom(finishNominationInternal(room, now), now, options.expiresAt);
    }

    case "import_state": {
      return importRoomState(room, command.state, options);
    }

    default: {
      const exhaustive: never = command;
      throw new Error(`Unsupported command ${(exhaustive as { type: string }).type}`);
    }
  }

  return stampRoom(room, now, options.expiresAt);
}

function stampRoom(
  room: RoomState,
  now: string,
  expiresAt?: string
): RoomState {
  room.updatedAt = now;
  room.expiresAt = expiresAt ?? room.expiresAt;
  return room;
}

export function getSeatForClient(
  room: RoomState,
  clientId: string
): PlayerState | undefined {
  return room.players.find((player) => player.clientId === clientId);
}

export function canClientVote(room: RoomState, seatId: string): boolean {
  if (!room.nomination) {
    return false;
  }
  const player = bySeatId(room.players, seatId);
  if (player.isDead && player.isVoteless) {
    return false;
  }
  return room.nomination.isVoteInProgress;
}

export function makeReminder(
  name: string,
  seed: string,
  roleId?: string
): ReminderToken {
  return {
    id: `${seed}:${name}`,
    name,
    roleId,
    isCustom: !roleId
  };
}

export function getRoomRoleCatalog(room: RoomState): RoleDefinition[] {
  return room.customScript?.roles ?? [];
}

export function getRoomFabledCatalog(room: RoomState): FabledDefinition[] {
  return room.customScript?.fabled ?? [];
}

export function getNominationResult(
  room: RoomState
): { yesVotes: number; threshold: number; passed: boolean } | null {
  if (!room.nomination) {
    return null;
  }

  const alivePlayers = room.players.filter((player) => !player.isDead);
  const yesVotes = Object.values(room.nomination.votes).filter(
    (vote: VoteChoice) => vote === "yes"
  ).length;
  const threshold = Math.ceil(alivePlayers.length / 2);

  return {
    yesVotes,
    threshold,
    passed: yesVotes >= threshold
  };
}

function validateBluffs(bluffs: string[], roleIds: string[], catalog: RoleDefinition[], drunkAsRoleId?: string): void {
  const byId = new Map(catalog.map(role => [role.id, role]));
  if ((bluffs.length !== 0 && bluffs.length !== 3) || new Set(bluffs).size !== bluffs.length || bluffs.some(id => roleIds.includes(id) || id === drunkAsRoleId || (catalog.length && !["townsfolk", "outsider"].includes(byId.get(id)?.team ?? "")))) {
    throw new Error("请选择三个不同、未入场的善良角色作为恶魔伪装，或清空伪装。");
  }
}
