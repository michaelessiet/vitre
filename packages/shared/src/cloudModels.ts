import { DEFAULT_MODEL, type ServerProviderModel } from "@t3tools/contracts";
import type { CloudProvider } from "@t3tools/contracts/cloud";

const labels: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};
function model(
  slug: string,
  name: string,
  provider: CloudProvider,
  efforts: string[],
  defaultEffort: string,
): ServerProviderModel {
  return {
    slug,
    name,
    isCustom: false,
    isDefault: slug === (provider === "codex" ? DEFAULT_MODEL : "claude-sonnet-5"),
    capabilities: {
      optionDescriptors: [
        {
          id: provider === "codex" ? "reasoningEffort" : "effort",
          label: "Reasoning",
          type: "select",
          currentValue: defaultEffort,
          options: efforts.map((id) => ({
            id,
            label: labels[id] ?? id,
            isDefault: id === defaultEffort,
          })),
        },
      ],
    },
  };
}
// Offline starting choices, matching the bundled providers. A live/cached
// provider catalog takes precedence, including its per-model reasoning limits.
const common = ["low", "medium", "high", "xhigh", "max"];
export const BUILT_IN_CLOUD_MODELS: Record<CloudProvider, readonly ServerProviderModel[]> = {
  codex: [
    model("gpt-6-astra", "GPT-6-Astra", "codex", [...common, "ultra"], "medium"),
    model("gpt-6-sol", "GPT-6-Sol", "codex", [...common, "ultra"], "medium"),
    model("gpt-6-luna", "GPT-6-Luna", "codex", common, "medium"),
    model("gpt-5.6-sol", "GPT-5.6-Sol", "codex", [...common, "ultra"], "low"),
    model("gpt-5.6-terra", "GPT-5.6-Terra", "codex", [...common, "ultra"], "medium"),
    model("gpt-5.6-luna", "GPT-5.6-Luna", "codex", common, "medium"),
  ],
  claude: [
    model("claude-sonnet-5", "Claude Sonnet 5", "claude", common, "high"),
    model("claude-opus-5", "Claude Opus 5", "claude", common, "high"),
    model("claude-opus-4-8", "Claude Opus 4.8", "claude", common, "high"),
  ],
};
