import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Text = Schema.String.check(Schema.isMaxLength(16000));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);
export const LensModel = Schema.Struct({
  provider: Schema.Literals(["codex", "claude"]),
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type LensModel = typeof LensModel.Type;
export const LensSchedule = Schema.Struct({
  frequency: Schema.Literals(["daily", "weekly"]),
  weekday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
  timeZone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type LensSchedule = typeof LensSchedule.Type;
export const LensSettings = Schema.Struct({
  enabled: Schema.Boolean,
  schedule: LensSchedule,
  model: Schema.NullOr(LensModel),
  staleConversationDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })),
  staleProjectDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 730 })),
});
export type LensSettings = typeof LensSettings.Type;
export const LensConversation = Schema.Struct({
  id: Id,
  projectId: Id,
  title: Schema.String.check(Schema.isMaxLength(1000)),
  updatedAt: Timestamp,
  lastAssistantAt: Schema.NullOr(Timestamp),
  readAt: Schema.NullOr(Timestamp),
  busy: Schema.Boolean,
  needsInput: Schema.Boolean,
  archived: Schema.Boolean,
  model: Schema.NullOr(LensModel),
  turns: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000000 })),
  excerpt: Schema.String.check(Schema.isMaxLength(4000)),
});
export type LensConversation = typeof LensConversation.Type;
export const LensProject = Schema.Struct({
  id: Id,
  title: Schema.String.check(Schema.isMaxLength(1000)),
  updatedAt: Timestamp,
});
export type LensProject = typeof LensProject.Type;
export const LensInventory = Schema.Struct({
  sourceId: Id,
  sourceLabel: Schema.String.check(Schema.isMaxLength(200)),
  models: Schema.optional(Schema.Array(LensModel).check(Schema.isMaxLength(200))),
  collectedAt: Timestamp,
  projects: Schema.Array(LensProject).check(Schema.isMaxLength(500)),
  conversations: Schema.Array(LensConversation).check(Schema.isMaxLength(2000)),
});
export type LensInventory = typeof LensInventory.Type;
export const LensRecommendation = Schema.Struct({
  id: Id,
  sourceId: Id,
  targetId: Id,
  title: Schema.String,
  reason: Text,
  kind: Schema.Literals(["unread", "follow_up", "archive_conversation", "remove_project"]),
  targetUpdatedAt: Timestamp,
  createdAt: Timestamp,
  status: Schema.Literals(["pending", "approved", "dismissed", "applied", "stale", "failed"]),
  error: Schema.NullOr(Text),
});
export type LensRecommendation = typeof LensRecommendation.Type;
export const LensMessage = Schema.Struct({
  id: Id,
  role: Schema.Literals(["user", "assistant"]),
  text: Text,
  createdAt: Timestamp,
  model: Schema.NullOr(LensModel),
});
export type LensMessage = typeof LensMessage.Type;
export const LensOverview = Schema.Struct({
  revision: Schema.Int,
  settingsRevision: Schema.Int,
  settings: LensSettings,
  nextRunAt: Schema.NullOr(Timestamp),
  lastRunAt: Schema.NullOr(Timestamp),
  running: Schema.Boolean,
  error: Schema.NullOr(Text),
  selectedModel: Schema.NullOr(LensModel),
  models: Schema.Array(LensModel),
  messages: Schema.Array(LensMessage),
  recommendations: Schema.Array(LensRecommendation),
  sources: Schema.Array(Schema.Struct({ id: Id, label: Schema.String, syncedAt: Timestamp })),
  activity: Schema.Array(Schema.Struct({ date: Schema.String, conversations: Schema.Int })),
});
export type LensOverview = typeof LensOverview.Type;
export const LensCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("settings.update"),
    idempotencyKey: Id,
    expectedRevision: Schema.Int,
    settings: LensSettings,
  }),
  Schema.Struct({ type: Schema.Literal("sweep"), idempotencyKey: Id }),
  Schema.Struct({
    type: Schema.Literal("chat"),
    idempotencyKey: Id,
    message: Text.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    type: Schema.Literal("decide"),
    idempotencyKey: Id,
    recommendationId: Id,
    decision: Schema.Literals(["approve", "dismiss"]),
  }),
  Schema.Struct({
    type: Schema.Literal("read"),
    idempotencyKey: Id,
    sourceId: Id,
    targetId: Id,
    through: Timestamp,
  }),
  Schema.Struct({
    type: Schema.Literal("read.batch"),
    idempotencyKey: Id,
    sourceId: Id,
    entries: Schema.Array(Schema.Struct({ targetId: Id, through: Timestamp })).check(
      Schema.isMaxLength(2000),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("sync"), idempotencyKey: Id, inventory: LensInventory }),
  Schema.Struct({
    type: Schema.Literal("action.result"),
    idempotencyKey: Id,
    recommendationId: Id,
    status: Schema.Literals(["applied", "stale", "failed"]),
    error: Schema.NullOr(Text),
  }),
]);
export type LensCommand = typeof LensCommand.Type;
export const LensModelReply = Schema.Struct({
  text: Text.check(Schema.isMinLength(1)),
  recommendations: Schema.Array(Schema.Struct({ id: Id, reason: Text })).check(
    Schema.isMaxLength(100),
  ),
});
export type LensModelReply = typeof LensModelReply.Type;
