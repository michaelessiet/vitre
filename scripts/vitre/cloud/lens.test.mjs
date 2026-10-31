import { expect, it } from "vite-plus/test";
import { lensArguments, parseLensReply } from "./lens.mjs";
it("runs Codex in a disposable read-only session with execution and web tools disabled", () => {
  const args = lensArguments("codex", "model", "/schema", "/reply");
  for (const flag of [
    "--ephemeral",
    "read-only",
    "shell_tool",
    "apply_patch_freeform",
    "multi_agent",
    "apps",
    'web_search="disabled"',
  ])
    expect(args).toContain(flag);
  expect(args.at(-1)).toBe("-");
});
it("disables Claude built-in and inherited MCP tools", () => {
  const args = lensArguments("claude", "model", "", "");
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(args).toContain("mcp__*");
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain('{"mcpServers":{}}');
  expect(args).toContain("--no-session-persistence");
  expect(() => lensArguments("unknown", "model", "", "")).toThrow();
});
it("validates and narrows replies before callbacks", () => {
  expect(
    parseLensReply({
      text: "Review",
      recommendations: [{ id: "p", reason: "Idle", delete: true }],
      execute: true,
    }),
  ).toEqual({ text: "Review", recommendations: [{ id: "p", reason: "Idle" }] });
  for (const value of [
    { text: "", recommendations: [] },
    { text: "x".repeat(16001), recommendations: [] },
    { text: "Hi", recommendations: [{ id: "x".repeat(1025), reason: "" }] },
  ])
    expect(() => parseLensReply(value)).toThrow();
});
