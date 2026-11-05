// @effect-diagnostics nodeBuiltinImport:off - These bundler fixtures require native temporary ESM modules.
import { afterEach, vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as Bundle from "alchemy/Bundle";
import { relayWorkerBuild } from "../src/workerBuild.ts";

afterEach(() => vi.unstubAllGlobals());

it.effect("eliminates unused nested initializers without dropping error registration", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-purity-")),
    );
    try {
      const dependency = Bundle.annotateModule(
        `
      const build = (value) => ({ value });
      const nested = () => "UNUSED_SCHEMA";
      export const unused = build(nested());
      export const used = build("kept");
      export class RegisteredError extends Error {}
      const register = (error) => { error.code = 1013; };
      register(RegisteredError);
    `,
        "fixture.js",
        true,
      )!;
      const output = yield* Bundle.build(
        {
          input: "entry.js",
          plugins: [
            {
              name: "fixture",
              resolveId: (id) => id,
              load: (id) =>
                id === "entry.js"
                  ? 'export { used, RegisteredError } from "dependency.js";'
                  : dependency.code,
            },
          ],
        },
        { dir: directory, format: "esm" },
        { pure: false },
      );
      const javascript = output.files.find((file) => file.path.endsWith(".js"))!;
      expect(javascript.content).not.toContain("UNUSED_SCHEMA");
      const module = yield* Effect.promise(
        () =>
          import(
            /* @vite-ignore */ NodeURL.pathToFileURL(NodePath.join(directory, javascript.path)).href
          ),
      );
      expect(module.used).toEqual({ value: "kept" });
      expect(module.RegisteredError.code).toBe(1013);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }),
);

it.effect(
  "preserves bundled Cloudflare token decoding and API error matchers",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-sdk-")),
      );
      const require = NodeModule.createRequire(import.meta.resolve("alchemy"));
      const service = require.resolve("@distilled.cloud/cloudflare/zero-trust");
      const credentials = require.resolve("@distilled.cloud/cloudflare/Credentials");
      try {
        const output = yield* Bundle.build(
          {
            input: "sdk-fixture.js",
            plugins: [
              {
                name: "sdk-fixture",
                resolveId: (id) => (id === "sdk-fixture.js" ? id : null),
                load: (id) =>
                  id === "sdk-fixture.js"
                    ? `
          import { getTunnelCloudflaredToken } from ${JSON.stringify(service)};
          import { fromApiToken } from ${JSON.stringify(credentials)};
          import * as Effect from "effect/Effect";
          import * as Layer from "effect/Layer";
          import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
          export const token = () => Effect.runPromise(
            getTunnelCloudflaredToken({ accountId: "account", tunnelId: "tunnel" }).pipe(
              Effect.provide(fromApiToken({ apiToken: "test-token" }).pipe(Layer.provideMerge(FetchHttpClient.layer))),
              Effect.match({ onSuccess: (value) => ({ value }), onFailure: (error) => ({ error: error._tag }) }),
            ),
          );
        `
                    : null,
              },
            ],
          },
          { dir: directory, format: "esm" },
          relayWorkerBuild.build,
        );
        const javascript = output.files.find((file) => file.path.endsWith(".js"))!;
        expect(javascript.content).not.toContain("/access/ai-controls/mcp/portals");
        const module = yield* Effect.promise(
          () =>
            import(
              /* @vite-ignore */ NodeURL.pathToFileURL(NodePath.join(directory, javascript.path))
                .href
            ),
        );
        const request = vi.fn(async () =>
          Response.json({ success: true, result: "connector-token" }),
        );
        vi.stubGlobal("fetch", request);
        expect(yield* Effect.promise(() => module.token())).toEqual({ value: "connector-token" });
        request.mockResolvedValueOnce(
          Response.json(
            {
              success: false,
              errors: [{ code: 1054, message: "token missing" }],
            },
            { status: 404 },
          ),
        );
        expect(yield* Effect.promise(() => module.token())).toEqual({
          error: "TunnelTokenNotFound",
        });
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      }
    }),
  30_000,
);
