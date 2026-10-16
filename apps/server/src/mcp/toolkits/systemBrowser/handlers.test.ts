import * as NodeVM from "node:vm";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { ChildProcessSpawner } from "effect/unstable/process";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { ProcessRunner } from "../../../processRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SystemBrowserToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { browserArguments, browserScript, runSystemBrowser } from "./handlers.ts";

it("passes page code and URLs as data rather than interpolating shell or AppleScript source", () => {
  const expression = 'document.title + "\\\"; $(touch /tmp/should-not-exist)"';
  const args = browserArguments({
    operation: "evaluate",
    browser: "brave",
    windowId: 1,
    tabIndex: 1,
    expectedUrl: "https://example.com/",
    expression,
  });
  expect(args[3]).toBe(browserScript);
  expect(args[3]).not.toContain(expression);
  expect(JSON.parse(args[4]!)).toMatchObject({ expression, application: "Brave Browser" });
  expect(() =>
    browserArguments({ operation: "open", browser: "safari", url: "javascript:alert(1)" }),
  ).toThrow("http(s)");
  expect(() => browserArguments({ operation: "evaluate", browser: "brave", expression })).toThrow(
    "expectedUrl",
  );
});

it("refuses stale tab targets before evaluating page code", () => {
  let evaluations = 0;
  const tab = {
    url: () => "https://changed.example/",
    execute: () => {
      evaluations++;
      return "ok";
    },
  };
  const app = { running: () => true, windows: () => [{ id: () => "7", tabs: () => [tab] }] };
  const run = NodeVM.runInNewContext(`${browserScript}; run`, { Application: () => app });
  const input = {
    operation: "evaluate",
    browser: "brave",
    windowId: 7,
    tabIndex: 1,
    expectedUrl: "https://expected.example/",
    expression: "document.title",
  };
  expect(() => run([JSON.stringify(input)])).toThrow("Tab changed");
  expect(evaluations).toBe(0);
  expect(JSON.parse(run([JSON.stringify({ ...input, expectedUrl: tab.url() })]))).toEqual({
    result: "ok",
  });
  expect(evaluations).toBe(1);
});

it("uses Safari's JavaScript command for Safari tabs", () => {
  const tab = { url: () => "https://example.com/" };
  const app = {
    running: () => true,
    windows: () => [{ id: () => 2, tabs: () => [tab] }],
    doJavaScript: (expression: string, options: { in: unknown }) => {
      expect(options.in).toBe(tab);
      return expression;
    },
  };
  const run = NodeVM.runInNewContext(`${browserScript}; run`, { Application: () => app });
  expect(
    JSON.parse(
      run([
        JSON.stringify({
          operation: "evaluate",
          browser: "safari",
          windowId: 2,
          tabIndex: 1,
          expectedUrl: tab.url(),
          expression: "document.title",
        }),
      ]),
    ),
  ).toEqual({ result: "document.title" });
});

it.effect("surfaces browser permission failures rather than returning success", () => {
  return runSystemBrowser({ operation: "tabs", browser: "brave" }).pipe(
    Effect.provideService(ProcessRunner, {
      run: () =>
        Effect.succeed({
          stdout: "",
          stderr: "Not authorized to send Apple events",
          code: ChildProcessSpawner.ExitCode(1),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.match({ onFailure: (error) => String(error), onSuccess: () => "unexpected success" }),
    Effect.map((error) => expect(String(error)).toContain("Automation permission")),
  );
});

const testLayer = SystemBrowserToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(NodeServices.layer),
);

it.effect(
  "registers the system browser for every provider and enforces the browser capability",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      for (const provider of ["codex", "claudeAgent", "opencode", "cursor", "grok"]) {
        for (const allowed of [false, true]) {
          const result = yield* server
            .callTool({ name: "system_browser", arguments: { operation: "browsers" } })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, {
                environmentId: EnvironmentId.make("browser-test"),
                threadId: ThreadId.make("browser-test"),
                providerSessionId: provider,
                providerInstanceId: ProviderInstanceId.make(provider),
                capabilities: new Set<McpInvocationContext.McpCapability>(
                  allowed ? ["preview"] : [],
                ),
                issuedAt: 0,
                expiresAt: Number.MAX_SAFE_INTEGER,
              }),
              Effect.provideService(
                McpSchema.McpServerClient,
                McpSchema.McpServerClient.of({
                  clientId: 1,
                  initializePayload: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1" },
                  },
                  getClient: Effect.die("unused"),
                }),
              ),
            );
          expect(result.isError ?? false).toBe(!allowed);
          if (!allowed)
            expect(result.content).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ type: "text", text: expect.stringContaining("preview") }),
              ]),
            );
        }
      }
    }).pipe(Effect.provideService(HostProcessPlatform, "darwin"), Effect.provide(testLayer)),
);
