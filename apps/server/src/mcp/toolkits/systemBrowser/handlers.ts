import * as FileSystem from "effect/FileSystem";
import { ProcessRunner } from "../../../processRunner.ts";
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SystemBrowserInput, SystemBrowserToolkit } from "./tools.ts";

const decodeBrowserResult = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const applications = {
  brave: "Brave Browser",
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
  safari: "Safari",
} as const;

// All caller-controlled values travel in argv as JSON, never as script source
// or shell text. Only the requested page expression is evaluated in the tab.
export const browserScript = `function run(argv) {
  var input = JSON.parse(argv[0]);
  var app = Application(input.application);
  var safari = input.browser === "safari";
  if (input.operation !== "open" && !app.running()) {
    if (input.operation === "tabs") return JSON.stringify({tabs: []});
    throw new Error("Browser is not running; list tabs again.");
  }
  if (input.operation === "open") {
    if (app.windows.length === 0) {
      if (safari) app.Document().make();
      else app.Window().make();
    }
    var tab = app.Tab({url: input.url});
    app.windows[0].tabs.push(tab);
    app.activate();
    return JSON.stringify({opened: input.url});
  }
  var windows = app.windows();
  if (input.operation === "tabs") {
    var tabs = [];
    windows.forEach(function(window) {
      window.tabs().forEach(function(tab, index) {
        tabs.push({windowId: Number(window.id()), tabIndex: index + 1,
          title: safari ? tab.name() : tab.title(), url: tab.url()});
      });
    });
    return JSON.stringify({tabs: tabs});
  }
  var window = windows.filter(function(w) { return Number(w.id()) === input.windowId; })[0];
  if (!window) throw new Error("Window no longer exists; list tabs again.");
  var tabs = window.tabs();
  var tab = tabs[input.tabIndex - 1];
  if (!tab || tab.url() !== input.expectedUrl) throw new Error("Tab changed; list tabs again before evaluating.");
  var result = safari ? app.doJavaScript(input.expression, {in: tab})
    : tab.execute({javascript: input.expression});
  return JSON.stringify({result: result === undefined ? null : result});
}`;

export function browserArguments(input: typeof SystemBrowserInput.Type): string[] {
  if (!input.browser) throw new Error("Choose a browser returned by operation=browsers.");
  if (input.operation === "open") {
    const url = new URL(input.url ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http(s) URLs can be opened.");
    }
  }
  if (input.operation === "evaluate") {
    if (
      !Number.isInteger(input.windowId) ||
      !Number.isInteger(input.tabIndex) ||
      (input.tabIndex ?? 0) < 1 ||
      !input.expectedUrl ||
      !input.expression
    ) {
      throw new Error(
        "Evaluation requires windowId, one-based tabIndex, expectedUrl, and expression.",
      );
    }
  }
  return [
    "-l",
    "JavaScript",
    "-e",
    browserScript,
    JSON.stringify({
      ...input,
      application: applications[input.browser],
    }),
  ];
}

export const runSystemBrowser = Effect.fn("SystemBrowser.run")(function* (
  input: typeof SystemBrowserInput.Type,
) {
  if ((yield* HostProcessPlatform) !== "darwin")
    return yield* Effect.fail(
      "System browser automation currently requires macOS. Use preview_* tools on this host.",
    );
  if (input.operation === "browsers") {
    const fs = yield* FileSystem.FileSystem;
    const installed: Array<{ browser: string; application: string }> = [];
    for (const [browser, application] of Object.entries(applications)) {
      for (const root of ["/Applications", `${NodeOS.homedir()}/Applications`]) {
        if (yield* fs.exists(`${root}/${application}.app`)) {
          installed.push({ browser, application });
          break;
        }
      }
    }
    return { browsers: installed };
  }
  const args = yield* Effect.try({
    try: () => browserArguments(input),
    catch: (error) => String(error),
  });
  const runner = yield* ProcessRunner;
  const result = yield* runner.run({
    command: "/usr/bin/osascript",
    args,
    timeout: "20 seconds",
    maxOutputBytes: 1_000_000,
  });
  if (result.code !== 0)
    return yield* Effect.fail(
      `System browser automation failed. Check macOS Automation permission and Allow JavaScript from Apple Events in the browser. ${result.stderr}`,
    );
  return yield* decodeBrowserResult(result.stdout).pipe(
    Effect.mapError(() => "Browser returned invalid data; use a smaller page expression."),
  );
});

export const SystemBrowserToolkitHandlersLive = SystemBrowserToolkit.toLayer({
  system_browser: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("preview");
      return yield* runSystemBrowser(input);
    }).pipe(Effect.mapError((error) => (typeof error === "string" ? error : error.message))),
});
