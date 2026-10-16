import * as Schema from "effect/Schema";
import { CloudDesktopAuthError } from "@t3tools/contracts/cloud";

/** Whether the conversation mutation is known not to have been accepted. */
export class CloudRequestFailure extends Error {
  readonly requestDisposition: "rejected" | "unknown";
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;
  constructor(
    message: string,
    requestDisposition: "rejected" | "unknown",
    code?: string,
    retryable?: boolean,
  ) {
    super(message);
    this.requestDisposition = requestDisposition;
    this.code = code;
    this.retryable = retryable;
  }
}

const isDesktopCloudError = Schema.is(CloudDesktopAuthError);

export function asDesktopCloudError(error: unknown, fallback: string): CloudDesktopAuthError {
  if (isDesktopCloudError(error)) return error;
  return new CloudDesktopAuthError({
    message: error instanceof Error ? error.message : fallback,
    requestDisposition: error instanceof CloudRequestFailure ? error.requestDisposition : "unknown",
    ...(error instanceof CloudRequestFailure && error.code ? { code: error.code } : {}),
    ...(error instanceof CloudRequestFailure && error.retryable !== undefined
      ? { retryable: error.retryable }
      : {}),
  });
}

export function beforeConversationDispatch(error: unknown): CloudRequestFailure {
  return new CloudRequestFailure(
    error instanceof Error ? error.message : "Cloud preparation failed before sending",
    "rejected",
    error instanceof CloudRequestFailure ? error.code : undefined,
    error instanceof CloudRequestFailure ? error.retryable : undefined,
  );
}
