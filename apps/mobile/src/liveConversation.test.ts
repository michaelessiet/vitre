import { expect, it, vi } from "vite-plus/test";
import {
  observeConversation,
  requestConversationResponse,
  type ConversationCallbacks,
} from "./liveConversation";

it("ignores late socket callbacks after replacing the conversation connection", () => {
  const status = vi.fn();
  const thread = vi.fn();
  const config = vi.fn();
  let oldCallbacks!: ConversationCallbacks;
  const dispose = vi.fn(() => oldCallbacks.status("disconnected", "Old socket closed"));
  const oldConnection = observeConversation(
    (callbacks) => {
      oldCallbacks = callbacks;
      return { dispose };
    },
    { status, thread, config },
  );
  expect(status).toHaveBeenLastCalledWith("connecting", null);
  oldCallbacks.status("backoff", "Cloud computer is starting");
  expect(status).toHaveBeenLastCalledWith("backoff", "Cloud computer is starting");
  oldConnection.dispose();
  const nextConnection = observeConversation(
    (callbacks) => {
      callbacks.status("connected", null);
      return { dispose: vi.fn() };
    },
    { status, thread, config },
  );
  oldCallbacks.status("disconnected", "Old socket closed");
  oldCallbacks.thread({} as Parameters<ConversationCallbacks["thread"]>[0]);
  oldCallbacks.config({} as Parameters<ConversationCallbacks["config"]>[0]);
  expect(status).toHaveBeenLastCalledWith("connected", null);
  expect(thread).not.toHaveBeenCalled();
  expect(config).not.toHaveBeenCalled();
  oldConnection.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
  nextConnection.dispose();
});

it("times out an unconfirmed approval and aborts its local RPC so it can be retried", async () => {
  vi.useFakeTimers();
  try {
    const aborted = vi.fn();
    const request = vi.fn(
      (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted();
            reject(new Error("Interrupted"));
          });
        }),
    );
    const result = requestConversationResponse(request);
    const failure = expect(result).rejects.toThrow("Reconnect and retry the same response");
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("clears the response deadline on success or failure without retrying the command", async () => {
  vi.useFakeTimers();
  try {
    const success = vi.fn(async () => ({ sequence: 12 }));
    expect(await requestConversationResponse(success)).toEqual({ sequence: 12 });
    const failure = vi.fn(async () => {
      throw new Error("Request was already resolved");
    });
    await expect(requestConversationResponse(failure)).rejects.toThrow("already resolved");
    expect(success).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
