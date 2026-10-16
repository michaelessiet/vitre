import { type OrchestrationCommand, OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "./Errors.ts";

const isDispatchError = Schema.is(OrchestrationDispatchCommandError);
const isInvariantError = Schema.is(OrchestrationCommandInvariantError);
const isPreviouslyRejected = Schema.is(OrchestrationCommandPreviouslyRejectedError);

export function toDispatchCommandError(cause: unknown, fallbackMessage: string) {
  return isDispatchError(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message: cause instanceof Error ? cause.message : fallbackMessage,
        requestDisposition: "unknown",
        cause,
      });
}

/** Only the engine's receipt-aware result can prove this immutable command was rejected. */
export function toEngineDispatchCommandError(cause: unknown, command: OrchestrationCommand) {
  const code =
    isInvariantError(cause) && cause.commandType === command.type
      ? (cause.code ?? "command_invariant")
      : isPreviouslyRejected(cause) && cause.commandId === command.commandId
        ? "command_rejected"
        : undefined;
  if (code === undefined) {
    return toDispatchCommandError(cause, "Failed to dispatch orchestration command");
  }
  return new OrchestrationDispatchCommandError({
    message: cause instanceof Error ? cause.message : "Orchestration command rejected",
    code,
    requestDisposition: "rejected",
    cause,
  });
}
