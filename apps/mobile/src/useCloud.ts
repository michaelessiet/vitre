import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Network from "expo-network";
import * as Schema from "effect/Schema";
import { OrchestrationThread, ServerConfig } from "@t3tools/contracts";
import { CloudOverview, type CloudCommand } from "@t3tools/contracts/cloud";
import { makeCloudClient, type CloudClient } from "@t3tools/client-runtime/cloud";
import { acceptHistory, acceptOverview } from "./cloudState";
import { accountStorage } from "./storage";
import { openConversation, type ConversationConnection } from "./runtime";

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
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [progress, setProgress] = useState("");
  const live = useRef<ConversationConnection | null>(null);
  const alive = useRef(true);
  const selection = useRef(selectedId);
  selection.current = selectedId;
  const task = overview?.tasks.find((task) => task.id === selectedId) ?? null;
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
  const refresh = useCallback(async () => {
    const next = await client.overview();
    accept(next);
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
  const receiveThread = useCallback(
    (incoming: OrchestrationThread) => {
      if (incoming.id !== `cloud-${selection.current}` || !alive.current) return;
      setThread((current) => acceptHistory(current, incoming));
      if (!incoming.messages.some((message) => message.streaming))
        void storage.set(`history:${selection.current}`, incoming);
    },
    [storage],
  );
  useEffect(() => {
    if (
      previewClient ||
      !task ||
      !active ||
      !online ||
      !task.worker ||
      !["ready", "starting"].includes(task.worker.state)
    )
      return;
    const connection = openConversation(client, task, storage, {
      thread: receiveThread,
      status: setConnectionStatus,
      config: setConfig,
    });
    live.current = connection;
    return () => {
      connection.dispose();
      if (live.current === connection) live.current = null;
      setConnectionStatus("disconnected");
    };
  }, [
    client,
    selectedId,
    task?.worker?.id,
    task?.worker?.environmentId,
    task?.worker?.state,
    task?.attempt?.id,
    active,
    online,
    storage,
    receiveThread,
  ]);
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
        setProgress(feed.events.findLast((event) => event.detail)?.detail ?? "");
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
  }, [client, selectedId, task?.result?.id, active, online, receiveThread, storage]);
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
    progress,
    live,
    command,
    accept,
    refresh,
    review,
  };
}
export type MobileCloud = ReturnType<typeof useCloud>;
