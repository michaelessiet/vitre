import { describe, expect, it } from "vite-plus/test";

import {
  managedProviderInstanceEnvironment,
  mergeProviderInstanceEnvironment,
} from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
  it("preserves provider variables while appending the managed Git boundary once", () => {
    const original = [
      { name: "GIT_CEILING_DIRECTORIES", value: "/existing", sensitive: false },
      { name: "PRIVATE_VALUE", value: "test-only", sensitive: true },
    ];
    const bounded = managedProviderInstanceEnvironment(original, "/state");
    expect(bounded.filter((item) => item.name === "GIT_CEILING_DIRECTORIES")).toHaveLength(1);
    expect(bounded.find((item) => item.name === "GIT_CEILING_DIRECTORIES")!.value).toContain(
      "/existing",
    );
    expect(bounded.find((item) => item.name === "GIT_CEILING_DIRECTORIES")!.value).toContain(
      "cloud-workspaces",
    );
    expect(bounded.find((item) => item.name === "PRIVATE_VALUE")).toEqual(original[1]);
    expect(managedProviderInstanceEnvironment(bounded, "/state")).toEqual(bounded);
    expect(managedProviderInstanceEnvironment(original, undefined)).toBe(original);
    expect(original[0]!.value).toBe("/existing");
  });
});
