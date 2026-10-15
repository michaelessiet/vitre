import * as FileSystem from "effect/FileSystem";
import { ProcessRunner } from "../../../processRunner.ts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const SystemBrowserInput = Schema.Struct({
  operation: Schema.Literals(["browsers", "tabs", "open", "evaluate"]),
  browser: Schema.optional(Schema.Literals(["brave", "chrome", "edge", "safari"])),
  url: Schema.optional(Schema.String),
  windowId: Schema.optional(Schema.Number),
  tabIndex: Schema.optional(Schema.Number),
  expectedUrl: Schema.optional(Schema.String),
  expression: Schema.optional(Schema.String),
});

export const SystemBrowserToolkit = Toolkit.make(
  Tool.make("system_browser", {
    description:
      "Use the Mac's installed browser and existing signed-in sessions. For public pages, local apps, and screenshots prefer Vitre's preview_* tools. First use operation=browsers to find installed browsers, then tabs with browser=brave|chrome|edge|safari to inspect URLs and one-based tabIndex/windowId. open creates a new tab for an http(s) URL. evaluate runs synchronous JavaScript in an existing tab to read the DOM, click, type, or navigate; supply windowId, tabIndex, expectedUrl from tabs, and expression. Never assume a tab index remains valid: re-list after opening/closing tabs. macOS Automation permission and the browser's Allow JavaScript from Apple Events setting are required for evaluation; report permission errors to the user. Does not launch an isolated browser or copy cookies.",
    parameters: SystemBrowserInput,
    success: Schema.Unknown,
    failure: Schema.String,
    dependencies: [McpInvocationContext.McpInvocationContext, FileSystem.FileSystem, ProcessRunner],
  })
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true),
);
