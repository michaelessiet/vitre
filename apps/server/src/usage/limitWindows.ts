/**
 * Plan limits from provider runtime events, per provider instance.
 *
 * Claude reports one window per `rate_limit_event` (5-hour session, weekly,
 * per-model weekly, extra usage); Codex reports sparse rolling snapshots of a
 * primary and secondary window. Cursor, Grok and OpenCode report no windows:
 * for them, and as a fallback for all, a turn that fails on a limit records
 * `limitReached`. Pure functions; the service owns state and persistence.
 */
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderUsageLimits,
  UsageLimitStatus,
  UsageLimitWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Used share at which a window reads as a warning when the provider gives no status. */
export const USAGE_WARNING_PERCENT = 80;

interface DriverProfile {
  readonly reportsWindows: boolean;
  readonly dashboardUrl?: string;
  readonly note?: string;
}

/** What each driver can tell Vitre about its limits. */
export function driverProfile(driver: string): DriverProfile {
  switch (driver) {
    case "claudeAgent":
      return { reportsWindows: true, dashboardUrl: "https://claude.ai/settings/usage" };
    case "codex":
      return { reportsWindows: true, dashboardUrl: "https://chatgpt.com/codex/settings/usage" };
    case "cursor":
      return {
        reportsWindows: false,
        dashboardUrl: "https://cursor.com/dashboard?tab=usage",
        note: "Cursor doesn't report plan usage to other apps. Vitre shows when a limit is hit.",
      };
    case "grok":
      return {
        reportsWindows: false,
        dashboardUrl: "https://grok.com/settings",
        note: "Grok doesn't report plan usage to other apps. Vitre shows when a limit is hit.",
      };
    case "opencode":
      return {
        reportsWindows: false,
        note: "OpenCode uses your providers' API keys, which have no plan windows. Vitre shows when a rate limit is hit.",
      };
    default:
      return { reportsWindows: false, note: "This provider doesn't report plan limits." };
  }
}

export function emptyLimits(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
}): ProviderUsageLimits {
  const profile = driverProfile(input.driver);
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    displayName: input.displayName,
    reportsWindows: profile.reportsWindows,
    windows: [],
    ...(profile.dashboardUrl ? { dashboardUrl: profile.dashboardUrl } : {}),
    ...(profile.note ? { note: profile.note } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Provider timestamps arrive as Unix seconds (or, defensively, milliseconds). */
function isoFromEpoch(value: unknown): string | undefined {
  const epoch = finite(value);
  if (epoch === undefined || epoch <= 0) return undefined;
  return DateTime.formatIso(DateTime.makeUnsafe(epoch < 1e12 ? epoch * 1000 : epoch));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function statusFromPercent(percent: number | undefined): UsageLimitStatus {
  if (percent === undefined) return "ok";
  if (percent >= 100) return "exceeded";
  return percent >= USAGE_WARNING_PERCENT ? "warning" : "ok";
}

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "Current session",
  seven_day: "Current week (all models)",
  seven_day_opus: "Current week (Opus)",
  seven_day_sonnet: "Current week (Sonnet)",
  overage: "Extra usage",
};
const CLAUDE_WINDOW_ORDER = Object.keys(CLAUDE_WINDOW_LABELS);

/** The window in one Claude `rate_limit_event`. */
export function claudeLimitWindow(rateLimits: unknown): UsageLimitWindow | undefined {
  const info = record(record(rateLimits)?.rate_limit_info);
  if (!info) return undefined;
  const id = typeof info.rateLimitType === "string" ? info.rateLimitType : "five_hour";
  // `utilization` is a fraction of the window.
  const utilization = finite(info.utilization);
  const usedPercent =
    utilization === undefined
      ? undefined
      : clampPercent(utilization <= 1 ? utilization * 100 : utilization);
  const reported =
    info.status === "rejected"
      ? "exceeded"
      : info.status === "allowed_warning"
        ? "warning"
        : undefined;
  const resetsAt = isoFromEpoch(info.resetsAt);
  return {
    id,
    label: CLAUDE_WINDOW_LABELS[id] ?? id.replaceAll("_", " "),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    status: reported ?? statusFromPercent(usedPercent),
  };
}

function codexWindowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined) return fallback;
  if (minutes === 10_080) return "Weekly limit";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

const CODEX_PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

/** The windows and plan in a Codex rate-limit snapshot (sparse: absent means unchanged). */
export function codexLimitSnapshot(rateLimits: unknown): {
  readonly windows: ReadonlyArray<UsageLimitWindow>;
  readonly planLabel?: string;
} {
  const snapshot = record(record(rateLimits)?.rateLimits) ?? record(rateLimits);
  if (!snapshot) return { windows: [] };
  const windows: UsageLimitWindow[] = [];
  for (const [id, fallback] of [
    ["primary", "Short-term limit"],
    ["secondary", "Weekly limit"],
  ] as const) {
    const window = record(snapshot[id]);
    const used = finite(window?.usedPercent);
    if (!window || used === undefined) continue;
    const usedPercent = clampPercent(used);
    const resetsAt = isoFromEpoch(window.resetsAt);
    const reached =
      snapshot.rateLimitReachedType !== undefined && snapshot.rateLimitReachedType !== null;
    windows.push({
      id,
      label: codexWindowLabel(finite(window.windowDurationMins), fallback),
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      status: reached && usedPercent >= 100 ? "exceeded" : statusFromPercent(usedPercent),
    });
  }
  const plan =
    typeof snapshot.planType === "string" ? CODEX_PLAN_LABELS[snapshot.planType] : undefined;
  return { windows, ...(plan ? { planLabel: plan } : {}) };
}

function mergeWindows(
  current: ReadonlyArray<UsageLimitWindow>,
  updates: ReadonlyArray<UsageLimitWindow>,
  order?: ReadonlyArray<string>,
): UsageLimitWindow[] {
  const byId = new Map(current.map((window) => [window.id, window]));
  for (const update of updates) byId.set(update.id, update);
  const merged = [...byId.values()];
  if (order) {
    const rank = (id: string) => {
      const index = order.indexOf(id);
      return index === -1 ? order.length : index;
    };
    merged.sort((a, b) => rank(a.id) - rank(b.id));
  }
  return merged;
}

const LIMIT_MESSAGE =
  /\b(rate[ -]?limit|usage limit|limit (?:reached|exceeded|hit)|quota|too many requests|429|out of credits|weekly limit|session limit)\b/i;

/** Whether an error message says the provider refused work because of a limit. */
export function isLimitMessage(message: string | undefined): boolean {
  return message !== undefined && LIMIT_MESSAGE.test(message);
}

function failureMessage(event: ProviderRuntimeEvent): string | undefined {
  switch (event.type) {
    case "runtime.error":
      return event.payload.message;
    case "turn.completed":
      return event.payload.state === "failed" ? event.payload.errorMessage : undefined;
    default:
      return undefined;
  }
}

/**
 * The limits after one runtime event, or `undefined` when the event says
 * nothing about limits. Windows whose reset time has passed drop back to 0%.
 */
export function applyUsageEvent(
  current: ProviderUsageLimits,
  event: ProviderRuntimeEvent,
): ProviderUsageLimits | undefined {
  if (event.type === "account.rate-limits.updated") {
    if (current.driver === "claudeAgent") {
      const window = claudeLimitWindow(event.payload.rateLimits);
      if (!window) return undefined;
      return {
        ...current,
        windows: mergeWindows(current.windows, [window], CLAUDE_WINDOW_ORDER),
        updatedAt: event.createdAt,
      };
    }
    if (current.driver === "codex") {
      const { windows, planLabel } = codexLimitSnapshot(event.payload.rateLimits);
      if (windows.length === 0 && !planLabel) return undefined;
      return {
        ...current,
        ...(planLabel ? { planLabel } : {}),
        windows: mergeWindows(current.windows, windows, ["primary", "secondary"]),
        updatedAt: event.createdAt,
      };
    }
    return undefined;
  }

  const message = failureMessage(event);
  if (message && isLimitMessage(message)) {
    return {
      ...current,
      limitReached: { at: event.createdAt, message: message.trim().slice(0, 400) },
      updatedAt: event.createdAt,
    };
  }
  // A turn that completed again means the limit no longer blocks work.
  if (
    current.limitReached &&
    event.type === "turn.completed" &&
    event.payload.state === "completed"
  ) {
    const { limitReached: _cleared, ...rest } = current;
    return { ...rest, updatedAt: event.createdAt };
  }
  return undefined;
}

/** Windows past their reset time read as unused until the provider says otherwise. */
export function expireWindows(limits: ProviderUsageLimits, nowMs: number): ProviderUsageLimits {
  let changed = false;
  const windows = limits.windows.map((window) => {
    if (!window.resetsAt || Date.parse(window.resetsAt) > nowMs) return window;
    changed = true;
    const { resetsAt: _reset, ...rest } = window;
    return { ...rest, usedPercent: 0, status: "ok" as const };
  });
  return changed ? { ...limits, windows } : limits;
}
