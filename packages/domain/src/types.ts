export type RoleTeam =
  | "townsfolk"
  | "outsider"
  | "minion"
  | "demon"
  | "traveler"
  | "fabled";

export type Phase = "day" | "night";

export interface ReminderToken {
  id: string;
  name: string;
  roleId?: string;
  iconUrl?: string;
  color?: string;
  isCustom?: boolean;
}

export interface RoleDefinition {
  id: string;
  name: string;
  team: RoleTeam;
  ability: string;
  image?: string;
  imageAlt?: string;
  firstNight?: number;
  otherNight?: number;
  firstNightReminder?: string;
  otherNightReminder?: string;
  setup?: number | boolean;
  reminders?: string[];
  remindersGlobal?: string[];
  edition?: string | number;
  isOfficial?: boolean;
  flavor?: string;
}

export interface FabledDefinition extends Omit<RoleDefinition, "team"> {
  team: "fabled";
}

export interface EditionSummary {
  id: string;
  name: string;
  author?: string;
  story?: string;
  desc?: string;
  image?: string;
  minPlayers?: number;
  maxPlayers?: number;
  roles: string[];
  fabledIds?: string[];
  isOfficial?: boolean;
  source?: string;
  json?: string;
}

export interface PlayerState {
  seatId: string;
  name: string;
  pronouns?: string;
  clientId?: string;
  isDead: boolean;
  isVoteless: boolean;
  roleId?: string;
  perceivedRoleId?: string;
  reminders: ReminderToken[];
}

export type VoteChoice = "yes" | "no" | "abstain";

export interface NominationState {
  id: string;
  nominatorSeatId: string;
  nomineeSeatId: string;
  isVoteInProgress: boolean;
  startedAt?: string;
  pausedAt?: string;
  votingSpeedMs: number;
  lockedCount: number;
  votes: Record<string, VoteChoice>;
}

export interface VoteHistoryEntry {
  nominationId: string;
  nominatorSeatId: string;
  nomineeSeatId: string;
  votes: Record<string, VoteChoice>;
  lockedCount: number;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
}

export interface ContentOverride {
  edition: EditionSummary;
  roles: RoleDefinition[];
  fabled: FabledDefinition[];
}

export interface RoomState {
  id: string;
  hostSecret: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  phase: Phase;
  players: PlayerState[];
  markedSeatId: string | null;
  nomination: NominationState | null;
  voteHistory: VoteHistoryEntry[];
  isVoteHistoryAllowed: boolean;
  isGrimoirePublic: boolean;
  isPlayerInfoPublic: boolean;
  votingSpeedMsDefault: number;
  fabledIds: string[];
  bluffRoleIds: string[];
  rolesDistributed: boolean;
  edition: EditionSummary | null;
  customScript: ContentOverride | null;
  backgroundUrl: string | null;
  issues: string[];
}

export type ExportedRoomState = Omit<RoomState, "hostSecret">;

export interface CreateRoomOptions {
  roomId: string;
  hostSecret: string;
  createdAt?: string;
  expiresAt?: string;
}

export type PlayerPatch = Partial<
  Pick<PlayerState, "name" | "isDead" | "isVoteless"> & {
    pronouns: string | null;
    roleId: string | null;
  }
>;

export type RoomCommand =
  | { type: "add_seat"; seatId?: string; name?: string }
  | { type: "remove_seat"; seatId: string }
  | { type: "claim_seat"; seatId: string; clientId: string; name?: string }
  | { type: "release_seat"; seatId: string; clientId?: string }
  | { type: "update_player"; seatId: string; patch: PlayerPatch }
  | { type: "set_phase"; phase: Phase }
  | { type: "set_marked"; seatId: string | null }
  | { type: "set_vote_history_allowed"; value: boolean }
  | { type: "set_background"; backgroundUrl: string | null }
  | { type: "set_fabled"; fabledIds: string[] }
  | { type: "set_bluffs"; bluffRoleIds: string[] }
  | { type: "set_edition"; edition: EditionSummary | null }
  | {
      type: "set_custom_script";
      editionMeta: Partial<Omit<EditionSummary, "roles">>;
      roles: RoleDefinition[];
      fabled?: FabledDefinition[];
    }
  | { type: "clear_custom_script" }
  | { type: "distribute_roles"; roleIds: string[]; bluffRoleIds?: string[]; drunkAsRoleId?: string }
  | { type: "hide_roles" }
  | { type: "set_reminders"; seatId: string; reminders: ReminderToken[] }
  | { type: "upsert_reminder"; seatId: string; reminder: ReminderToken }
  | { type: "remove_reminder"; seatId: string; reminderId: string }
  | {
      type: "start_nomination";
      nominatorSeatId: string;
      nomineeSeatId: string;
      votingSpeedMs?: number;
    }
  | { type: "begin_vote" }
  | { type: "cast_vote"; seatId: string; vote: VoteChoice }
  | { type: "lock_vote"; count?: number }
  | { type: "finish_nomination" }
  | { type: "import_state"; state: ExportedRoomState };

export interface ApplyRoomCommandOptions {
  now?: string | Date;
  random?: () => number;
  expiresAt?: string;
  roleCatalog?: RoleDefinition[];
}
