import type { ServerConfig, ServerProviderModel } from "@t3tools/contracts";
import type { CloudProvider } from "@t3tools/contracts/cloud";
import { BUILT_IN_CLOUD_MODELS } from "@t3tools/shared/cloudModels";

export function composerModels(config: ServerConfig | null, provider: CloudProvider) {
  const driver = provider === "claude" ? "claudeAgent" : "codex";
  const live = config?.providers.find(
    (entry) => entry.driver === driver || entry.instanceId === driver,
  )?.models;
  return live?.length ? live : BUILT_IN_CLOUD_MODELS[provider];
}
export function composerModel(models: readonly ServerProviderModel[], slug?: string) {
  return models.find((model) => model.slug === slug);
}
