import { z } from "zod";

const urlLikeSchema = z.string().refine(
  (value) => /^https?:\/\//i.test(value) || value.startsWith("/"),
  {
    message: "Expected an absolute URL or a root-relative asset path."
  }
);

export const phaseSchema = z.enum(["day", "night"]);
export const voteChoiceSchema = z.enum(["yes", "no", "abstain"]);
export const roleTeamSchema = z.enum([
  "townsfolk",
  "outsider",
  "minion",
  "demon",
  "traveler",
  "fabled"
]);

export const reminderTokenSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  roleId: z.string().optional(),
  iconUrl: z.string().url().optional(),
  color: z.string().optional(),
  isCustom: z.boolean().optional()
});

export const roleDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  team: roleTeamSchema,
  ability: z.string(),
  image: urlLikeSchema.optional(),
  imageAlt: z.string().optional(),
  firstNight: z.number().int().optional(),
  otherNight: z.number().int().optional(),
  firstNightReminder: z.string().optional(),
  otherNightReminder: z.string().optional(),
  setup: z.union([z.number().int(), z.boolean()]).optional(),
  reminders: z.array(z.string()).optional(),
  remindersGlobal: z.array(z.string()).optional(),
  edition: z.union([z.string(), z.number()]).optional(),
  isOfficial: z.boolean().optional(),
  flavor: z.string().optional()
});

export const fabledDefinitionSchema = roleDefinitionSchema.extend({
  team: z.literal("fabled")
});

export const editionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  author: z.string().optional(),
  story: z.string().optional(),
  desc: z.string().optional(),
  image: urlLikeSchema.optional(),
  minPlayers: z.number().int().optional(),
  maxPlayers: z.number().int().optional(),
  roles: z.array(z.string()),
  fabledIds: z.array(z.string()).optional(),
  isOfficial: z.boolean().optional(),
  source: z.string().optional(),
  json: z.string().optional()
});

export const playerStateSchema = z.object({
  seatId: z.string().min(1),
  name: z.string().min(1),
  pronouns: z.string().optional(),
  clientId: z.string().optional(),
  isDead: z.boolean(),
  isVoteless: z.boolean(),
  roleId: z.string().optional(),
  reminders: z.array(reminderTokenSchema)
});

export const nominationStateSchema = z.object({
  id: z.string().min(1),
  nominatorSeatId: z.string().min(1),
  nomineeSeatId: z.string().min(1),
  isVoteInProgress: z.boolean(),
  startedAt: z.string().datetime().optional(),
  pausedAt: z.string().datetime().optional(),
  votingSpeedMs: z.number().int().positive(),
  lockedCount: z.number().int().nonnegative(),
  votes: z.record(z.string(), voteChoiceSchema)
});

export const voteHistoryEntrySchema = z.object({
  nominationId: z.string().min(1),
  nominatorSeatId: z.string().min(1),
  nomineeSeatId: z.string().min(1),
  votes: z.record(z.string(), voteChoiceSchema),
  lockedCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  passed: z.boolean()
});

export const contentOverrideSchema = z.object({
  edition: editionSchema,
  roles: z.array(roleDefinitionSchema),
  fabled: z.array(fabledDefinitionSchema)
});

export const exportedRoomStateSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  phase: phaseSchema,
  players: z.array(playerStateSchema),
  markedSeatId: z.string().nullable(),
  nomination: nominationStateSchema.nullable(),
  voteHistory: z.array(voteHistoryEntrySchema),
  isVoteHistoryAllowed: z.boolean(),
  isGrimoirePublic: z.boolean(),
  isPlayerInfoPublic: z.boolean(),
  votingSpeedMsDefault: z.number().int().positive(),
  fabledIds: z.array(z.string()),
  bluffRoleIds: z.array(z.string()),
  edition: editionSchema.nullable(),
  customScript: contentOverrideSchema.nullable(),
  backgroundUrl: z.string().nullable(),
  issues: z.array(z.string())
});

export const contentCatalogSchema = z.object({
  sourceMode: z.enum(["local", "mirror_official", "remote_proxy", "import_only"]),
  syncedAt: z.string().datetime().optional(),
  assetsBaseUrl: z.string(),
  countdownAudioUrl: urlLikeSchema.optional(),
  issues: z.array(z.string()),
  roles: z.array(roleDefinitionSchema),
  fabled: z.array(fabledDefinitionSchema),
  editions: z.array(editionSchema)
});

export const createRoomRequestSchema = z.object({
  roomId: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional()
});

export const createRoomResponseSchema = z.object({
  roomId: z.string().min(1),
  clientId: z.string().min(1),
  hostSecret: z.string().min(1),
  wsUrl: z.string().min(1),
  guestUrl: z.string().min(1),
  hostUrl: z.string().min(1)
});

export const roomBootstrapQuerySchema = z.object({
  clientId: z.string().min(1),
  hostSecret: z.string().min(1).optional(),
  spectator: z.boolean().optional()
});

export const roomBootstrapResponseSchema = z.object({
  role: z.enum(["host", "guest", "spectator"]),
  clientId: z.string().min(1),
  claimedSeatId: z.string().nullable(),
  wsUrl: z.string().min(1),
  guestUrl: z.string().min(1),
  hostUrl: z.string().min(1).optional(),
  contentMode: contentCatalogSchema.shape.sourceMode,
  room: exportedRoomStateSchema
});

export const syncContentResponseSchema = z.object({
  ok: z.boolean(),
  syncedAt: z.string().datetime().optional(),
  usedFallback: z.boolean(),
  issues: z.array(z.string())
});

const playerPatchSchema = z.object({
  name: z.string().optional(),
  pronouns: z.string().nullable().optional(),
  isDead: z.boolean().optional(),
  isVoteless: z.boolean().optional(),
  roleId: z.string().nullable().optional()
});

const joinRoomMessageSchema = z.object({
  type: z.literal("join_room"),
  roomId: z.string().min(1),
  clientId: z.string().min(1),
  hostSecret: z.string().optional(),
  spectator: z.boolean().optional()
});

const claimSeatMessageSchema = z.object({
  type: z.literal("claim_seat"),
  seatId: z.string().min(1),
  name: z.string().optional()
});

const addSeatMessageSchema = z.object({
  type: z.literal("add_seat"),
  seatId: z.string().optional(),
  name: z.string().optional()
});

const removeSeatMessageSchema = z.object({
  type: z.literal("remove_seat"),
  seatId: z.string().min(1)
});

const releaseSeatMessageSchema = z.object({
  type: z.literal("release_seat"),
  seatId: z.string().min(1)
});

const updatePlayerMessageSchema = z.object({
  type: z.literal("update_player"),
  seatId: z.string().min(1),
  patch: playerPatchSchema
});

const distributeRolesMessageSchema = z.object({
  type: z.literal("distribute_roles"),
  roleIds: z.array(z.string().min(1))
});

const setFabledMessageSchema = z.object({
  type: z.literal("set_fabled"),
  fabledIds: z.array(z.string().min(1))
});

const setBluffsMessageSchema = z.object({
  type: z.literal("set_bluffs"),
  bluffRoleIds: z.array(z.string().min(1)).max(3)
});

const setRemindersMessageSchema = z.object({
  type: z.literal("set_reminders"),
  seatId: z.string().min(1),
  reminders: z.array(reminderTokenSchema)
});

const startNominationMessageSchema = z.object({
  type: z.literal("start_nomination"),
  nominatorSeatId: z.string().min(1),
  nomineeSeatId: z.string().min(1),
  votingSpeedMs: z.number().int().positive().optional()
});

const beginVoteMessageSchema = z.object({
  type: z.literal("begin_vote")
});

const castVoteMessageSchema = z.object({
  type: z.literal("cast_vote"),
  seatId: z.string().min(1),
  vote: voteChoiceSchema
});

const lockVoteMessageSchema = z.object({
  type: z.literal("lock_vote"),
  count: z.number().int().nonnegative().optional()
});

const finishNominationMessageSchema = z.object({
  type: z.literal("finish_nomination")
});

const setPhaseMessageSchema = z.object({
  type: z.literal("set_phase"),
  phase: phaseSchema
});

const setMarkedMessageSchema = z.object({
  type: z.literal("set_marked"),
  seatId: z.string().nullable()
});

const importStateMessageSchema = z.object({
  type: z.literal("import_state"),
  state: exportedRoomStateSchema
});

const exportStateMessageSchema = z.object({
  type: z.literal("export_state")
});

const setEditionMessageSchema = z.object({
  type: z.literal("set_edition"),
  edition: editionSchema.nullable()
});

const setCustomScriptMessageSchema = z.object({
  type: z.literal("set_custom_script"),
  editionMeta: editionSchema.partial().omit({ roles: true }).default({}),
  roles: z.array(roleDefinitionSchema),
  fabled: z.array(fabledDefinitionSchema).optional()
});

const clearCustomScriptMessageSchema = z.object({
  type: z.literal("clear_custom_script")
});

const setVoteHistoryAllowedMessageSchema = z.object({
  type: z.literal("set_vote_history_allowed"),
  value: z.boolean()
});

const setBackgroundMessageSchema = z.object({
  type: z.literal("set_background"),
  backgroundUrl: z.string().nullable()
});

const pingMessageSchema = z.object({
  type: z.literal("ping")
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  joinRoomMessageSchema,
  claimSeatMessageSchema,
  addSeatMessageSchema,
  removeSeatMessageSchema,
  releaseSeatMessageSchema,
  updatePlayerMessageSchema,
  distributeRolesMessageSchema,
  setFabledMessageSchema,
  setBluffsMessageSchema,
  setRemindersMessageSchema,
  startNominationMessageSchema,
  beginVoteMessageSchema,
  castVoteMessageSchema,
  lockVoteMessageSchema,
  finishNominationMessageSchema,
  setPhaseMessageSchema,
  setMarkedMessageSchema,
  importStateMessageSchema,
  exportStateMessageSchema,
  setEditionMessageSchema,
  setCustomScriptMessageSchema,
  clearCustomScriptMessageSchema,
  setVoteHistoryAllowedMessageSchema,
  setBackgroundMessageSchema,
  pingMessageSchema
]);

const roomSnapshotMessageSchema = z.object({
  type: z.literal("room_snapshot"),
  room: exportedRoomStateSchema
});

const roomEventMessageSchema = z.object({
  type: z.literal("room_event"),
  event: z.string().min(1),
  room: exportedRoomStateSchema
});

const errorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string().min(1)
});

const exportStateResponseSchema = z.object({
  type: z.literal("export_state"),
  state: exportedRoomStateSchema
});

const contentStatusMessageSchema = z.object({
  type: z.literal("content_status"),
  status: z.enum(["idle", "syncing", "failed", "ready"]),
  issues: z.array(z.string())
});

const pongMessageSchema = z.object({
  type: z.literal("pong")
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  roomSnapshotMessageSchema,
  roomEventMessageSchema,
  errorMessageSchema,
  exportStateResponseSchema,
  contentStatusMessageSchema,
  pongMessageSchema
]);

export type ContentCatalog = z.infer<typeof contentCatalogSchema>;
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;
export type RoomBootstrapQuery = z.infer<typeof roomBootstrapQuerySchema>;
export type RoomBootstrapResponse = z.infer<typeof roomBootstrapResponseSchema>;
export type SyncContentResponse = z.infer<typeof syncContentResponseSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
