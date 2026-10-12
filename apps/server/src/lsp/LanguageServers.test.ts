import type { CustomLanguageServer } from "@t3tools/contracts";
import { LSP_SUPPORTED_EXTENSIONS } from "@t3tools/shared/lspSupport";
import { describe, expect, it } from "vite-plus/test";

import { BUILTIN_EXTENSIONS, languageBindingForPath, resolveRegistry } from "./LanguageServers.ts";

const RUBY_SERVER: CustomLanguageServer = {
  serverId: "ruby",
  displayName: "solargraph",
  command: "solargraph",
  args: ["stdio"],
  extensions: [".rb", ".rake"],
  languageId: "ruby",
};

describe("LanguageServers", () => {
  it("stays in parity with the shared LSP_SUPPORTED_EXTENSIONS set", () => {
    for (const extension of LSP_SUPPORTED_EXTENSIONS) {
      expect(languageBindingForPath(`file${extension}`)).not.toBe(null);
    }
    // The reverse direction: anything the server binds must be advertised.
    for (const extension of BUILTIN_EXTENSIONS) {
      expect(LSP_SUPPORTED_EXTENSIONS.has(extension)).toBe(true);
    }
  });

  describe("resolveRegistry", () => {
    it("includes the optional Kotlin default when no custom servers are configured", () => {
      const registry = resolveRegistry([]);
      expect(new Set(registry.supportedExtensions)).toEqual(
        new Set([...BUILTIN_EXTENSIONS, ".kt", ".kts"]),
      );
      expect(registry.bindingForPath("src/index.ts")?.languageId).toBe("typescript");
      expect(registry.bindingForPath("README.md")).toBe(null);
      for (const path of ["src/Greeting.kt", "build.gradle.kts", "Main.KT"]) {
        expect(registry.bindingForPath(path)).toMatchObject({
          languageId: "kotlin",
          server: { command: "kotlin-language-server", args: [], bundled: false },
        });
      }
    });

    it("preserves custom Kotlin server commands and extension ownership", () => {
      for (const serverId of ["kotlin", "jetbrains-kotlin"]) {
        const registry = resolveRegistry([
          {
            serverId,
            displayName: "Custom Kotlin",
            command: "my-kotlin-server",
            args: ["--stdio"],
            languageId: "kotlin",
            extensions: [".kt", ".kts"],
          },
        ]);
        expect(registry.bindingForPath("Main.kt")?.server.command).toBe("my-kotlin-server");
        expect(registry.bindingForPath("build.gradle.kts")?.server.serverId).toBe(serverId);
        expect(
          registry.servers.filter((server) => server.command === "kotlin-language-server"),
        ).toHaveLength(0);
      }
    });

    it("adds only unclaimed Kotlin extensions beside a custom binding", () => {
      const registry = resolveRegistry([
        {
          serverId: "scripts",
          displayName: "Scripts",
          command: "script-server",
          args: [],
          languageId: "kotlin",
          extensions: [".kts"],
        },
      ]);
      expect(registry.bindingForPath("Main.kt")?.server.command).toBe("kotlin-language-server");
      expect(registry.bindingForPath("build.gradle.kts")?.server.command).toBe("script-server");
    });

    it("merges custom servers and binds their extensions", () => {
      const registry = resolveRegistry([RUBY_SERVER]);
      const binding = registry.bindingForPath("app/models/user.rb");
      expect(binding?.languageId).toBe("ruby");
      expect(binding?.server.serverId).toBe("ruby");
      expect(binding?.server.command).toBe("solargraph");
      expect(binding?.server.bundled).toBe(false);
      expect(registry.bindingForPath("lib/tasks/db.rake")?.server.serverId).toBe("ruby");
      expect(registry.supportedExtensions).toContain(".rb");
      expect(registry.servers.some((server) => server.serverId === "ruby")).toBe(true);
    });

    it("lets built-ins win on serverId and extension collisions", () => {
      const registry = resolveRegistry([
        {
          serverId: "typescript",
          displayName: "impostor",
          command: "impostor",
          args: [],
          extensions: [".imp"],
          languageId: "impostor",
        },
        {
          serverId: "clasher",
          displayName: "clasher",
          command: "clasher",
          args: [],
          extensions: [".ts", ".cls"],
          languageId: "clasher",
        },
      ]);
      // Built-in serverId wins: the impostor is dropped entirely.
      expect(registry.servers.filter((server) => server.serverId === "typescript")).toHaveLength(1);
      expect(registry.bindingForPath("x.imp")).toBe(null);
      // Built-in extension wins; the custom server keeps its other extensions.
      expect(registry.bindingForPath("x.ts")?.server.serverId).toBe("typescript");
      expect(registry.bindingForPath("x.cls")?.server.serverId).toBe("clasher");
    });
  });
});
