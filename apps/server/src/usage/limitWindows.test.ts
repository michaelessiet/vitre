import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { EventId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyUsageEvent,
  claudeLimitWindow,
  codexLimitSnapshot,
  emptyLimits,
  expireWindows,
  isLimitMessage,
} from "./limitWindows.ts";

const limitsFor = (driver: string) =>
  emptyLimits({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName: driver,
  });

const base = {
  eventId: EventId.make("evt"),
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-11-10T12:00:00.000Z",
};

const rateLimits = (driver: string, payload: unknown) =>
  ({
    ...base,
    provider: ProviderDriverKind.make(driver),
    type: "account.rate-limits.updated",
    payload: { rateLimits: payload },
  }) as ProviderRuntimeEvent;

// 2026-11-10T15:00:00Z in Unix seconds.
const RESET = 1_794_322_800;

describe("claudeLimitWindow", () => {
  it("labels windows the way Claude Code does and reads utilization as a fraction", () => {
    expect(
      claudeLimitWindow({
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 0.41,
          resetsAt: RESET,
        },
      }),
    ).toEqual({
      id: "five_hour",
      label: "Current session",
      usedPercent: 41,
      resetsAt: "2026-11-10T15:00:00.000Z",
      status: "ok",
    });
  });

  it("takes the provider's warning and rejection over the percentage", () => {
    expect(
      claudeLimitWindow({
        rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day" },
      }),
    ).toMatchObject({ label: "Current week (all models)", status: "warning" });
    expect(
      claudeLimitWindow({
        rate_limit_info: { status: "rejected", rateLimitType: "seven_day_opus", utilization: 0.5 },
      }),
    ).toMatchObject({ label: "Current week (Opus)", status: "exceeded" });
  });
});

describe("codexLimitSnapshot", () => {
  it("names windows by their length and reads the plan", () => {
    expect(
      codexLimitSnapshot({
        rateLimits: {
          planType: "pro",
          primary: { usedPercent: 85, windowDurationMins: 300, resetsAt: RESET },
          secondary: { usedPercent: 12, windowDurationMins: 10_080 },
        },
      }),
    ).toEqual({
      planLabel: "Pro",
      windows: [
        {
          id: "primary",
          label: "5-hour limit",
          usedPercent: 85,
          resetsAt: "2026-11-10T15:00:00.000Z",
          status: "warning",
        },
        { id: "secondary", label: "Weekly limit", usedPercent: 12, status: "ok" },
      ],
    });
  });
});

describe("applyUsageEvent", () => {
  it("merges Claude windows in a fixed order", () => {
    let limits = limitsFor("claudeAgent");
    for (const type of ["seven_day", "five_hour"]) {
      limits =
        applyUsageEvent(
          limits,
          rateLimits("claudeAgent", {
            rate_limit_info: { status: "allowed", rateLimitType: type, utilization: 0.1 },
          }),
        ) ?? limits;
    }
    expect(limits.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(limits.updatedAt).toBe(base.createdAt);
  });

  it("keeps Codex windows a sparse update leaves out", () => {
    let limits = limitsFor("codex");
    limits =
      applyUsageEvent(
        limits,
        rateLimits("codex", {
          rateLimits: { primary: { usedPercent: 10 }, secondary: { usedPercent: 20 } },
        }),
      ) ?? limits;
    limits =
      applyUsageEvent(
        limits,
        rateLimits("codex", { rateLimits: { primary: { usedPercent: 30 } } }),
      ) ?? limits;
    expect(limits.windows.map((window) => window.usedPercent)).toEqual([30, 20]);
  });

  it("records a limit failure for providers without windows and clears it on success", () => {
    const failed = applyUsageEvent(limitsFor("cursor"), {
      ...base,
      provider: ProviderDriverKind.make("cursor"),
      type: "runtime.error",
      payload: { message: "You've hit your usage limit. It resets on Dec 1." },
    } as ProviderRuntimeEvent);
    expect(failed?.limitReached?.message).toContain("usage limit");
    const recovered = applyUsageEvent(failed!, {
      ...base,
      provider: ProviderDriverKind.make("cursor"),
      type: "turn.completed",
      payload: { state: "completed" },
    } as ProviderRuntimeEvent);
    expect(recovered?.limitReached).toBeUndefined();
  });

  it("ignores ordinary failures and other events", () => {
    expect(isLimitMessage("permission denied")).toBe(false);
    expect(isLimitMessage("429 Too Many Requests")).toBe(true);
    expect(
      applyUsageEvent(limitsFor("grok"), {
        ...base,
        provider: ProviderDriverKind.make("grok"),
        type: "runtime.error",
        payload: { message: "Network unreachable" },
      } as ProviderRuntimeEvent),
    ).toBeUndefined();
  });
});

describe("emptyLimits and expireWindows", () => {
  it("explains providers that report no windows", () => {
    expect(limitsFor("cursor")).toMatchObject({
      reportsWindows: false,
      dashboardUrl: expect.any(String),
    });
    expect(limitsFor("opencode").note).toContain("API keys");
    expect(limitsFor("claudeAgent").reportsWindows).toBe(true);
  });

  it("resets windows whose reset time has passed", () => {
    const limits = {
      ...limitsFor("codex"),
      windows: [
        {
          id: "primary",
          label: "5-hour limit",
          usedPercent: 90,
          resetsAt: "2026-11-10T10:00:00.000Z",
          status: "warning" as const,
        },
      ],
    };
    expect(expireWindows(limits, Date.parse("2026-11-10T11:00:00.000Z")).windows[0]).toEqual({
      id: "primary",
      label: "5-hour limit",
      usedPercent: 0,
      status: "ok",
    });
  });
});
