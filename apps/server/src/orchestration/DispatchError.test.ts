import { describe, expect, it } from "vite-plus/test";
import { CommandId, OrchestrationDispatchCommandError, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { toDispatchCommandError, toEngineDispatchCommandError } from "./DispatchError.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandDecodeError,
  OrchestrationProjectorDecodeError,
} from "./Errors.ts";

const command = {
  type: "thread.delete" as const,
  commandId: CommandId.make("delete-1"),
  threadId: ThreadId.make("thread-1"),
};
const invariant = new OrchestrationCommandInvariantError({
  commandType: command.type,
  code: "execution_busy",
  detail: "Turn is active",
});

describe("dispatch delivery disposition", () => {
  it("marks matching engine invariants and rejected receipts as definite rejection", () => {
    expect(toEngineDispatchCommandError(invariant, command)).toMatchObject({
      requestDisposition: "rejected",
      code: "execution_busy",
    });
    const rejected = new OrchestrationCommandPreviouslyRejectedError({
      commandId: command.commandId,
      detail: "Previously rejected",
    });
    expect(toEngineDispatchCommandError(rejected, command)).toMatchObject({
      requestDisposition: "rejected",
      code: "command_rejected",
    });
  });

  it("does not treat a bootstrap subcommand rejection as proof about the final command", () => {
    expect(toDispatchCommandError(invariant, "Bootstrap failed").requestDisposition).toBe(
      "unknown",
    );
    expect(
      toEngineDispatchCommandError(invariant, { ...command, type: "thread.unarchive" })
        .requestDisposition,
    ).toBe("unknown");
    const rejected = new OrchestrationCommandPreviouslyRejectedError({
      commandId: "different-command",
      detail: "Previously rejected",
    });
    expect(toEngineDispatchCommandError(rejected, command).requestDisposition).toBe("unknown");
  });

  it("keeps commit, decode, and unclassified failures uncertain", () => {
    for (const error of [
      new Error("Response lost after commit"),
      new OrchestrationProjectorDecodeError({
        eventType: "thread.deleted",
        issue: "Projection failed",
      }),
      new OrchestrationCommandDecodeError({ issue: "Payload invalid" }),
      { _tag: "EnvironmentAuthorizationError", message: "Scope removed after a previous attempt" },
    ]) {
      expect(toEngineDispatchCommandError(error, command).requestDisposition).toBe("unknown");
    }
  });

  it("preserves explicit outcomes and keeps legacy errors ambiguous on the wire", () => {
    const rejected = toEngineDispatchCommandError(invariant, command);
    expect(toDispatchCommandError(rejected, "fallback")).toBe(rejected);
    const codec = Schema.toCodecJson(OrchestrationDispatchCommandError);
    const legacy = Schema.decodeUnknownSync(codec)({
      _tag: "OrchestrationDispatchCommandError",
      message: "Legacy failure",
    });
    expect(legacy.requestDisposition).toBeUndefined();
    const wire = Schema.encodeUnknownSync(codec)(rejected);
    expect(Schema.decodeUnknownSync(codec)(wire).requestDisposition).toBe("rejected");
  });
});
