import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { cloudProviderForInstance, validateCloudProvider } from "./providerValidation.ts";

const selection = { instanceId: ProviderInstanceId.make("codex"), model: "available-model" };
const provider = {
  instanceId: selection.instanceId,
  enabled: true,
  installed: true,
  status: "ready" as const,
  auth: { status: "authenticated" as const },
  models: [{ slug: selection.model, name: "Available", isCustom: false, capabilities: null }],
};
describe("cloud provider preflight", () => {
  it("maps Claude's canonical instance to its existing cloud account", () => {
    expect(cloudProviderForInstance("claudeAgent")).toBe("claude");
    expect(cloudProviderForInstance("claude")).toBe("claude");
    expect(cloudProviderForInstance("codex")).toBe("codex");
    expect(cloudProviderForInstance("custom-instance")).toBeNull();
  });
  it("rejects unsupported options instead of silently substituting defaults", () => {
    const capable = {
      ...provider,
      models: [
        {
          ...provider.models[0]!,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select" as const,
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
    };
    expect(
      validateCloudProvider({ ...selection, options: [{ id: "effort", value: "high" }] }, [capable])
        .supported,
    ).toBe(true);
    expect(
      validateCloudProvider({ ...selection, options: [{ id: "effort", value: "unsupported" }] }, [
        capable,
      ]).supported,
    ).toBe(false);
    expect(
      validateCloudProvider({ ...selection, options: [{ id: "unknown", value: true }] }, [capable])
        .supported,
    ).toBe(false);
  });
  it("keeps the exact selected model and requires live account support", () => {
    expect(validateCloudProvider(selection, [provider]).supported).toBe(true);
    expect(
      validateCloudProvider({ ...selection, model: "retired-model" }, [provider]),
    ).toMatchObject({
      supported: false,
      reason: "The selected model is not available for this cloud account",
    });
    expect(
      validateCloudProvider(selection, [
        { ...provider, models: [{ ...provider.models[0]!, isCustom: true }] },
      ]).supported,
    ).toBe(false);
    expect(selection.model).toBe("available-model");
  });
  it("rejects missing, disabled, disconnected and failed providers", () => {
    expect(validateCloudProvider(selection, []).supported).toBe(false);
    for (const invalid of [
      { ...provider, enabled: false },
      { ...provider, installed: false },
      { ...provider, availability: "unavailable" as const },
      { ...provider, status: "error" as const },
      { ...provider, auth: { status: "unauthenticated" as const } },
      { ...provider, auth: { status: "unknown" as const } },
    ])
      expect(validateCloudProvider(selection, [invalid]).supported).toBe(false);
    expect(
      validateCloudProvider(selection, [
        { ...provider, auth: { status: "unauthenticated" as const } },
      ]).retryable,
    ).toBeUndefined();
    expect(
      validateCloudProvider(selection, [{ ...provider, auth: { status: "unknown" as const } }]),
    ).toMatchObject({
      supported: false,
      retryable: true,
      reason: "The selected provider's sign-in could not be verified yet in this cloud workspace",
    });
  });
});
