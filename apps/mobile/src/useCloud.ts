import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import * as Schema from "effect/Schema";
import { OrchestrationThread, ServerConfig } from "@t3tools/contracts";
import { CloudOverview, type CloudCommand } from "@t3tools/contracts/cloud";
import { makeCloudClient, type CloudClient } from "@t3tools/client-runtime/cloud";
import { acceptHistory, acceptOverview, liveConversationKey, taskProgress } from "./cloudState";
import { accountStorage } from "./storage";
import { openConversation, type ConversationConnection } from "./runtime";
import { observeConversation } from "./liveConversation";

const decodeOverview = Schema.decodeUnknownOption(CloudOverview);
const decodeConfig = Schema.decodeUnknownOption(ServerConfig);
const decodeThread = Schema.decodeUnknownOption(OrchestrationThread);

export function useCloud(
  origin: string,
  accountId: string,
  getToken: () => Promise<string | null>,
  previewClient?: CloudClient,
) {
  const token = useRef(getToken);
  token.current = getToken;
  const storage = useMemo(() => accountStorage(origin, accountId), [origin, accountId]);
  const client = useMemo(
    () =>
      previewClient ??
      makeCloudClient({ baseUrl: origin, accessToken: async () => (await token.current()) ?? "" }),
    [origin, accountId, previewClient],
  );
  const [overview, setOverview] = useState<CloudOverview | null>(null);
  const [selectedId, select] = useState<string | null>(null);
  const [thread, setThread] = useState<OrchestrationThread | null>(null);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [diff, setDiff] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [active, setActive] = useState(AppState.currentState === "active");
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const [connectionState, setConnectionState] = useState<{
    key: string;
    status: string;
    error: string | null;
  } | null>(null);
  const [progress, setProgress] = useState("");
  const live = useRef<ConversationConnection | null>(null);
  const alive = useRef(true);
  const selection = useRef(selectedId);
  selection.current = selectedId;
  const task = overview?.tasks.find((task) => task.id === selectedId) ?? null;
  const connectionKey = liveConversationKey(task, connectionGeneration);
  const currentConnection =
    active && online && connectionState?.key === connectionKey ? connectionState : null;
  const connectionStatus = currentConnection?.status ?? "disconnected";
  const connectionError = currentConnection?.error ?? null;
  const accept = useCallback(
    (next: CloudOverview) => {
      if (!alive.current) return;
      setOverview((current) => {
        const accepted = acceptOverview(current, next);
        void storage.set("overview", accepted);
        return accepted;
      });
    },
    [storage],
  );
  const githubRefreshed = useRef(false);
  useEffect(() => {
    githubRefreshed.current = false;
  }, [client]);
  const refresh = useCallback(async () => {
    const next = await client.overview();
    accept(next);
    if (next.githubManageUrl && !githubRefreshed.current) {
      const result = await client.command({
        type: "github.refresh",
        idempotencyKey: Crypto.randomUUID(),
      });
      githubRefreshed.current = true;
      accept(result.overview);
    }
  }, [client, accept]);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void (async () => {
      const [saved, last, models] = await Promise.all([
        storage.get("overview"),
        storage.get<string>("selection"),
        storage.get("models"),
      ]);
      if (cancelled) return;
      const cached = decodeOverview(saved);
      if (cached._tag === "Some") setOverview((current) => current ?? cached.value);
      if (last) select((current) => current ?? last);
      const decoded = decodeConfig(models);
      if (decoded._tag === "Some") setConfig(decoded.value);
    })();
    const app = AppState.addEventListener("change", (state) => setActive(state === "active"));
    const network = Network.addNetworkStateListener((state) =>
      setOnline(state.isConnected !== false),
    );
    void Network.getNetworkStateAsync().then((state) => {
      if (!cancelled) setOnline(state.isConnected !== false);
    });
    return () => {
      alive.current = false;
      cancelled = true;
      app.remove();
      network.remove();
    };
  }, [storage]);
  useEffect(() => {
    if (!active || !online) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh();
        if (!cancelled) setError(null);
      } catch (error) {
        if (!cancelled)
          setError(error instanceof Error ? error.message : "Cloud is temporarily unavailable");
      }
      if (!cancelled)
        timer = setTimeout(() => {
          void poll();
        }, 5000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, online, refresh]);
  useEffect(() => {
    if (selectedId) void storage.set("selection", selectedId);
  }, [selectedId, storage]);
  useEffect(() => {
    let cancelled = false;
    setThread(null);
    setDiff("");
    setProgress("");
    if (!selectedId) return;
    void storage.get(`history:${selectedId}`).then((saved) => {
      const decoded = decodeThread(saved);
      if (!cancelled && decoded._tag === "Some")
        setThread((current) => acceptHistory(current, decoded.value));
    });
    void storage.get<string>(`diff:${selectedId}`).then((saved) => {
      if (!cancelled && saved) setDiff(saved);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, storage]);
  useEffect(() => {
    if (
      selectedId &&
      thread?.id === `cloud-${selectedId}` &&
      !thread.messages.some((message) => message.streaming)
    )
      void storage.set(`history:${selectedId}`, thread);
  }, [thread, selectedId, storage]);
  const receiveThread = useCallback((incoming: OrchestrationThread) => {
    if (incoming.id !== `cloud-${selection.current}` || !alive.current) return;
    setThread((current) => acceptHistory(current, incoming));
  }, []);
  useEffect(() => {
    if (previewClient || !task || !active || !online || !connectionKey) return;
    const connection = observeConversation(
      (callbacks) => openConversation(client, task, storage, callbacks),
      {
        thread: receiveThread,
        status: (status, error) => setConnectionState({ key: connectionKey, status, error }),
        config: setConfig,
      },
    );
    live.current = connection;
    return () => {
      connection.dispose();
      if (live.current === connection) live.current = null;
      setConnectionState(null);
    };
  }, [client, connectionKey, previewClient, active, online, storage, receiveThread]);
  useEffect(() => {
    if (!selectedId || !active || !online) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const feed = await client.events(selectedId);
        if (cancelled) return;
        const decoded = decodeThread(feed.conversation);
        if (decoded._tag === "Some") receiveThread(decoded.value);
        setProgress(taskProgress(feed.events, task));
        if (task?.result) {
          const result = await client.result(selectedId);
          if (!cancelled) {
            setDiff(result.result.diff);
            void storage.set(`diff:${selectedId}`, result.result.diff);
          }
        }
      } catch {
        /* Preserve cached history while the worker is unavailable. */
      }
      if (!cancelled)
        timer = setTimeout(() => {
          void poll();
        }, 6000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    client,
    selectedId,
    task?.attempt?.id,
    task?.state,
    task?.result?.id,
    active,
    online,
    receiveThread,
    storage,
  ]);
  // A failed/new selection must not prevent discovery from another ready worker.
  const catalogTask = overview?.tasks.find(
    (candidate) =>
      candidate.worker?.state === "ready" &&
      ["running", "waiting_for_input"].includes(candidate.state),
  );
  useEffect(() => {
    if (
      config ||
      previewClient ||
      !active ||
      !online ||
      !catalogTask ||
      catalogTask.id === selectedId
    )
      return;
    const connection = openConversation(client, catalogTask, storage, {
      thread: () => {},
      status: () => {},
      config: setConfig,
    });
    return () => connection.dispose();
  }, [config, previewClient, active, online, catalogTask?.id, selectedId, client, storage]);
  const command = useCallback(
    async (command: CloudCommand) => {
      if (!online || !active)
        throw new Error("You're offline. Your draft is saved; send it when you're back online.");
      const result = await client.command(command);
      accept(result.overview);
      return result;
    },
    [client, accept, online, active],
  );
  const reconnect = useCallback(async () => {
    if (!online || !active) throw new Error("Reconnect when the app is online and active.");
    // Rebuild the runtime and its observers even if initialization failed. Merely
    // retrying the old supervisor cannot revive a terminated subscription scope.
    setConnectionGeneration((generation) => generation + 1);
    // Reconnect from known worker data even if this overview request fails.
    await refresh();
  }, [online, active, refresh]);
  const review = async () => {
    if (live.current && connectionStatus === "connected" && task) {
      const result = await live.current.diff(
        thread?.worktreePath ?? "/workspace/repository",
        task.baseSha ?? undefined,
      );
      const next = result.sources.map((source) => source.diff).join("\n");
      setDiff(next);
      await storage.set(`diff:${task.id}`, next);
    }
  };
  return {
    client,
    storage,
    overview,
    task,
    selectedId,
    select,
    thread,
    config,
    diff,
    error,
    setError,
    online,
    connectionStatus,
    connectionError,
    reconnect,
    progress,
    live,
    command,
    accept,
    refresh,
    review,
  };
}
export type MobileCloud = ReturnType<typeof useCloud>;
