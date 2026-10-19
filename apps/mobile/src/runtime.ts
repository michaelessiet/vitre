import { cloudConversationLayer, type CloudClient } from "@t3tools/client-runtime/cloud";
import { Connectivity, EnvironmentSupervisor, Wakeups } from "@t3tools/client-runtime/connection";
import { EnvironmentCacheStore } from "@t3tools/client-runtime/platform";
import { request } from "@t3tools/client-runtime/rpc";
import {
  makeEnvironmentThreadState,
  threadSnapshotLoaderLayer,
} from "@t3tools/client-runtime/state/threads";
import {
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WS_METHODS,
  type ClientOrchestrationCommand,
  type OrchestrationThread,
  type ServerConfig,
} from "@t3tools/contracts";
import type { CloudTask } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as Network from "expo-network";
import { AppState } from "react-native";
import { environmentCache, type AccountStorage } from "./storage";

const network = (state: Network.NetworkState) =>
  state.isConnected === false ? ("offline" as const) : ("online" as const);
const connectivity = Connectivity.layer({
  status: Effect.promise(() => Network.getNetworkStateAsync()).pipe(Effect.map(network)),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        Network.addNetworkStateListener((state) => {
          Queue.offerUnsafe(queue, network(state));
        }),
      ),
      (subscription) => Effect.sync(() => subscription.remove()),
    ),
  ),
});
const wakeups = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        AppState.addEventListener("change", (state) => {
          if (state === "active") Queue.offerUnsafe(queue, "application-active");
        }),
      ),
      (subscription) => Effect.sync(() => subscription.remove()),
    ),
  ),
});

/** Disposing this scope closes the socket, subscriptions, timers and in-flight work. */
export function openConversation(
  client: CloudClient,
  task: CloudTask,
  storage: AccountStorage,
  callbacks: {
    thread: (thread: OrchestrationThread) => void;
    status: (status: string) => void;
    config: (config: ServerConfig) => void;
  },
) {
  const platform = Layer.mergeAll(
    connectivity,
    wakeups,
    FetchHttpClient.layer,
    Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => new WebSocket(url, protocols)),
    Layer.succeed(EnvironmentCacheStore, environmentCache(storage)),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(cloudConversationLayer(client, task), threadSnapshotLoaderLayer).pipe(
      Layer.provideMerge(platform),
    ),
  );
  const abort = new AbortController();
  void runtime
    .runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const thread = yield* makeEnvironmentThreadState(ThreadId.make(`cloud-${task.id}`));
          yield* SubscriptionRef.changes(thread).pipe(
            Stream.runForEach((state) =>
              Effect.sync(() => {
                if (Option.isSome(state.data)) callbacks.thread(state.data.value);
              }),
            ),
            Effect.forkScoped,
          );
          yield* SubscriptionRef.changes(supervisor.state).pipe(
            Stream.runForEach((state) => Effect.sync(() => callbacks.status(state.phase))),
            Effect.forkScoped,
          );
          yield* SubscriptionRef.changes(supervisor.session).pipe(
            Stream.runForEach((session) =>
              Option.isNone(session)
                ? Effect.void
                : session.value.initialConfig.pipe(
                    Effect.tap((config) => Effect.promise(() => storage.set("models", config))),
                    Effect.tap((config) => Effect.sync(() => callbacks.config(config))),
                    Effect.ignore,
                  ),
            ),
            Effect.forkScoped,
          );
          yield* Effect.never;
        }),
      ),
      { signal: abort.signal },
    )
    .catch(() => {
      if (!abort.signal.aborted) callbacks.status("disconnected");
    });
  return {
    dispatch: (command: ClientOrchestrationCommand) =>
      runtime.runPromise(request(ORCHESTRATION_WS_METHODS.dispatchCommand, command)),
    readFile: (cwd: string, relativePath: string) =>
      runtime.runPromise(request(WS_METHODS.projectsReadFile, { cwd, relativePath })),
    diff: (cwd: string, baseRef?: string) =>
      runtime.runPromise(
        request(WS_METHODS.reviewGetDiffPreview, { cwd, ...(baseRef ? { baseRef } : {}) }),
      ),
    retry: () =>
      runtime.runPromise(
        EnvironmentSupervisor.pipe(Effect.flatMap((supervisor) => supervisor.retryNow)),
      ),
    dispose() {
      abort.abort();
      void runtime.dispose();
    },
  };
}
export type ConversationConnection = ReturnType<typeof openConversation>;
