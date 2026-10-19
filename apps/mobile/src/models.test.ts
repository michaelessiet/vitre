import { describe, expect, it } from "vite-plus/test";
import type { ServerConfig } from "@t3tools/contracts";
import { composerModel, composerModels } from "./models";

describe("mobile model selection without a running conversation", () => {
  it.each(["codex", "claude"] as const)(
    "offers models and default reasoning for %s before connecting",
    (provider) => {
      const models = composerModels(null, provider);
      expect(models.length).toBeGreaterThan(1);
      expect(composerModel(models)).toBeUndefined();
      const selected = composerModel(models, models[0]!.slug);
      expect(selected?.capabilities?.optionDescriptors?.[0]?.id).toBe(
        provider === "codex" ? "reasoningEffort" : "effort",
      );
      expect(composerModel(models, models[1]!.slug)?.slug).toBe(models[1]!.slug);
    },
  );
  it("uses the live model's actual reasoning limits, without mixing in fallback options", () => {
    const live = {
      slug: "live",
      name: "Live",
      isCustom: false,
      isDefault: true,
      capabilities: { optionDescriptors: [] },
    };
    const config = {
      providers: [{ driver: "codex", instanceId: "codex", models: [live] }],
    } as unknown as ServerConfig;
    expect(composerModels(config, "codex")).toEqual([live]);
    expect(
      composerModel(composerModels(config, "codex"), "live")?.capabilities?.optionDescriptors,
    ).toEqual([]);
    expect(composerModels(config, "claude").length).toBeGreaterThan(0);
    expect(composerModel([live], "unknown")).toBeUndefined();
  });
});
