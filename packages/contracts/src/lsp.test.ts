import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { LspServerStatus } from "./lsp.ts";

const decodeStatus = Schema.decodeUnknownSync(LspServerStatus);

describe("LspServerStatus", () => {
  it("decodes older servers without extension metadata", () => {
    expect(
      decodeStatus({
        serverId: "custom",
        displayName: "Custom",
        state: "starting",
      }).extensions,
    ).toEqual([]);
  });
  it("preserves extension metadata for status indicators", () => {
    expect(
      decodeStatus({
        serverId: "custom",
        displayName: "Custom",
        state: "failed",
        extensions: [".fake"],
      }).extensions,
    ).toEqual([".fake"]);
  });
});
