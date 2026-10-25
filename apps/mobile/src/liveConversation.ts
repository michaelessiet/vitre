import type { OrchestrationThread, ServerConfig } from "@t3tools/contracts";

export interface ConversationCallbacks {
  thread: (thread: OrchestrationThread) => void;
  status: (status: string, error: string | null) => void;
  config: (config: ServerConfig) => void;
}

/** Retired sockets must not overwrite the replacement connection's state. */
export function observeConversation<T extends { dispose(): void }>(
  open: (callbacks: ConversationCallbacks) => T,
  callbacks: ConversationCallbacks,
): T {
  let disposed = false;
  callbacks.status("connecting", null);
  const connection = open({
    thread: (thread) => {
      if (!disposed) callbacks.thread(thread);
    },
    status: (status, error) => {
      if (!disposed) callbacks.status(status, error);
    },
    config: (config) => {
      if (!disposed) callbacks.config(config);
    },
  });
  return {
    ...connection,
    dispose() {
      if (disposed) return;
      disposed = true;
      connection.dispose();
    },
  };
}

/** A lost RPC receipt must release the response controls and cancel the local request. */
export async function requestConversationResponse<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("The response was not confirmed. Reconnect and retry the same response."));
      abort.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([request(abort.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
