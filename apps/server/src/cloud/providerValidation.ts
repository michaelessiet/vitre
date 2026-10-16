import type { OrchestrationThread, ServerProvider } from "@t3tools/contracts";

export function cloudProviderForInstance(instanceId: string): "codex" | "claude" | null {
  if (instanceId === "codex") return "codex";
  if (instanceId === "claudeAgent" || instanceId === "claude") return "claude";
  return null;
}

export function validateCloudProvider(
  selection: OrchestrationThread["modelSelection"],
  providers: readonly Pick<
    ServerProvider,
    "instanceId" | "enabled" | "installed" | "availability" | "status" | "auth" | "models"
  >[],
) {
  const provider = providers.find((provider) => provider.instanceId === selection.instanceId);
  const model = provider?.models.find((model) => model.slug === selection.model && !model.isCustom);
  let reason: string | null = null;
  let retryable = false;
  if (
    !provider ||
    !provider.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status === "disabled"
  )
    reason = "The selected provider is unavailable in this cloud workspace";
  else if (provider.auth.status === "unknown") {
    // The CLI probe has not completed (or timed out) rather than reporting a
    // signed-out account; callers that just started the backend can retry.
    reason = "The selected provider's sign-in could not be verified yet in this cloud workspace";
    retryable = true;
  } else if (provider.auth.status !== "authenticated")
    reason = "Connect the selected provider account before moving to Cloud";
  else if (provider.status === "error")
    reason = "The selected provider is not ready in this cloud workspace";
  else if (!model) reason = "The selected model is not available for this cloud account";
  else if (
    (selection.options ?? []).some((option) => {
      const descriptor = model.capabilities?.optionDescriptors?.find(
        (entry) => entry.id === option.id,
      );
      return (
        !descriptor ||
        (descriptor.type === "boolean"
          ? typeof option.value !== "boolean"
          : !descriptor.options.some((choice) => choice.id === option.value))
      );
    })
  )
    reason = "The selected model options are not available in this cloud workspace";
  return {
    type: "providerValidation" as const,
    supported: reason === null,
    reason,
    ...(retryable ? { retryable: true } : {}),
  };
}
