// @effect-diagnostics globalDate:off - Deterministic fixture/calendar verification without an Effect runtime.
/** Explicit development fixture shared by mobile showcase and native QA. No account or compute access. */
import type { LensCommand, LensOverview } from "@t3tools/contracts/lens";
import {
  beginLensRun,
  emptyLens,
  finishLensRun,
  lensActionStillValid,
  lensOverview,
  markLensRead,
  nextLensRun,
  LENS_DAY,
} from "./lens.ts";
export function makeLensPreview() {
  const state = emptyLens();
  const now = () => Date.now();
  const at = (days: number) => new Date(now() - days * LENS_DAY).toISOString();
  const base = {
    projectId: "parlay",
    updatedAt: at(40),
    lastAssistantAt: null,
    readAt: null,
    busy: false,
    needsInput: false,
    archived: false,
    model: { provider: "codex" as const, model: "gpt-5.6-sol" },
    turns: 8,
    excerpt: "Completed session loading improvements; documentation follow-up remains.",
  };
  state.inventories.cloud = {
    sourceId: "cloud",
    sourceLabel: "Cloud · sample data",
    collectedAt: at(0),
    projects: [
      {
        id: "old-project",
        title:
          "Winter prototype — archived experiments and an intentionally long project title to verify wrapping",
        updatedAt: at(55),
      },
      { id: "parlay", title: "Parlay", updatedAt: at(0) },
    ],
    conversations: [
      {
        ...base,
        id: "session",
        title: "Fix unauthenticated session loading",
        updatedAt: at(0),
        lastAssistantAt: at(0),
      },
      {
        ...base,
        id: "followup",
        title: "Review the launch checklist",
        updatedAt: at(2),
        needsInput: true,
      },
      { ...base, id: "old-thread", title: "Retired onboarding experiment" },
    ],
  };
  const receipts = new Set<string>();
  const overview = (): LensOverview =>
    structuredClone(lensOverview(state, now(), ["codex", "claude"]));
  return {
    lens: async () => overview(),
    lensCommand: async (command: LensCommand): Promise<LensOverview> => {
      if (receipts.has(command.idempotencyKey)) return overview();
      if (command.type === "settings.update") {
        if (command.expectedRevision !== (state.settingsRevision ?? 0))
          throw new Error("Settings changed. Refresh and save again.");
        const next = nextLensRun(command.settings.schedule, now());
        state.settings = command.settings;
        state.settingsRevision = (state.settingsRevision ?? 0) + 1;
        state.nextRunAt = command.settings.enabled ? next : null;
      } else if (command.type === "chat" || command.type === "sweep") {
        const run = beginLensRun(
          state,
          command.idempotencyKey,
          command.type === "chat" ? command.message : null,
          now(),
          ["codex", "claude"],
        );
        finishLensRun(
          state,
          run.id,
          {
            text:
              "You moved the session loading fix forward this week. The launch checklist is still waiting for your input, and one reply is unread. The onboarding experiment and winter prototype may be ready to clear away. Review the cards before applying any cleanup.\n\nThis is sample data for interface verification.\n\n```vitre-visual\n" +
              JSON.stringify({
                version: 1,
                title: "A view of your week",
                metrics: [
                  { label: "Completed", value: 4 },
                  { label: "Needs attention", value: 2 },
                ],
                description:
                  "Illustrative sample counts; switch views or inspect the underlying data.",
                views: [
                  {
                    label: "Progress",
                    kind: "line",
                    points: [
                      { label: "Mon", value: 1 },
                      { label: "Tue", value: 3 },
                      { label: "Wed", value: 2 },
                      { label: "Thu", value: 5 },
                      { label: "Fri", value: 4 },
                    ],
                  },
                  {
                    label: "Balance",
                    kind: "bar",
                    points: [
                      { label: "Completed", value: 4 },
                      { label: "Remaining", value: -2 },
                      { label: "Unchanged", value: 0 },
                    ],
                  },
                  {
                    label: "Plan",
                    kind: "flow",
                    steps: [
                      "Read the session loading reply",
                      "Answer the launch checklist question",
                      "Review and approve cleanup",
                    ],
                  },
                  {
                    label: "Details",
                    kind: "table",
                    columns: ["Item", "Status"],
                    rows: [
                      ["Session loading", "Ready to read"],
                      ["Launch checklist", "Needs an answer"],
                    ],
                  },
                ],
              }) +
              "\n```",
            recommendations: run.candidates.map((entry) => ({
              id: entry.id,
              reason: entry.reason,
            })),
          },
          null,
          now(),
        );
      } else if (command.type === "decide") {
        state.recommendations = state.recommendations.map((entry) =>
          entry.id !== command.recommendationId || entry.status !== "pending"
            ? entry
            : {
                ...entry,
                status:
                  command.decision === "dismiss"
                    ? "dismissed"
                    : lensActionStillValid(state, entry, now())
                      ? "applied"
                      : "stale",
              },
        );
      } else if (command.type === "read") {
        markLensRead(state, command.sourceId, command.targetId, command.through, now());
        state.recommendations = state.recommendations.map((entry) =>
          entry.kind === "unread" && !lensActionStillValid(state, entry, now())
            ? { ...entry, status: "applied" }
            : entry,
        );
      }
      state.revision++;
      receipts.add(command.idempotencyKey);
      return overview();
    },
  };
}
