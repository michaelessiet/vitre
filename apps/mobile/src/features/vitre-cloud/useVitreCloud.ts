import { useAtomValue } from "@effect/atom-react";
import { makeCloudClient, type CloudClient } from "@t3tools/client-runtime/cloud";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { CloudOverview } from "@t3tools/contracts/cloud";
import { OrchestrationThread, type OrchestrationThread as Thread } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

import { runtime } from "../../lib/runtime";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { acceptCloudHistory, acceptCloudOverview } from "./mobileCloudState";

const decodeThread = Schema.decodeUnknownOption(OrchestrationThread);
const overviewCache = new Map<string, CloudOverview>();
const threadCache = new Map<string, Thread>();
const threadSourceCache = new Map<string, "feed" | "result">();

export function useVitreCloudClient(): { client: CloudClient | null; accountId: string | null } {
  const session = useAtomValue(managedRelaySessionAtom);
  const relayUrl = resolveCloudPublicConfig().relay.url;
  const client = useMemo(
    () =>
      session && relayUrl
        ? makeCloudClient({
            baseUrl: relayUrl,
            accessToken: async () => {
              const token = await runtime.runPromise(session.readClerkToken());
              return token ?? "";
            },
          })
        : null,
    [relayUrl, session],
  );
  return { client, accountId: session?.accountId ?? null };
}

export function useVitreCloud(taskId?: string, active = true) {
  const { client, accountId } = useVitreCloudClient();
  const accountTaskKey = accountId && taskId ? `${accountId}:${taskId}` : null;
  const scope = JSON.stringify([accountId, taskId ?? null]);
  const [overviewState, setOverviewState] = useState<{
    accountId: string | null;
    value: CloudOverview | null;
  }>(() => ({
    accountId,
    value: accountId ? (overviewCache.get(accountId) ?? null) : null,
  }));
  const [historyState, setHistoryState] = useState<{
    key: string | null;
    value: Thread | null;
  }>(() => ({
    key: accountTaskKey,
    value: accountTaskKey ? (threadCache.get(accountTaskKey) ?? null) : null,
  }));
  const [errorState, setErrorState] = useState<{ scope: string; value: string | null }>(() => ({
    scope,
    value: null,
  }));
  const [refreshingState, setRefreshingState] = useState<{ scope: string; value: boolean }>(() => ({
    scope,
    value: false,
  }));
  const [verifiedState, setVerifiedState] = useState<{ scope: string; value: boolean }>(() => ({
    scope,
    value: false,
  }));
  const overview = overviewState.accountId === accountId ? overviewState.value : null;
  const history = historyState.key === accountTaskKey ? historyState.value : null;
  const error = errorState.scope === scope ? errorState.value : null;
  const refreshing = refreshingState.scope === scope && refreshingState.value;
  const verified = verifiedState.scope === scope && verifiedState.value;
  const generation = useRef(0);
  const busy = useRef<string | null>(null);

  useEffect(() => {
    setOverviewState({
      accountId,
      value: accountId ? (overviewCache.get(accountId) ?? null) : null,
    });
    setHistoryState({
      key: accountTaskKey,
      value: accountTaskKey ? (threadCache.get(accountTaskKey) ?? null) : null,
    });
    setErrorState({ scope, value: null });
    setVerifiedState({ scope, value: false });
    setRefreshingState({ scope, value: false });
  }, [accountId, accountTaskKey, scope]);

  const refresh = useCallback(async () => {
    if (!client || !accountId || busy.current === scope) return;
    busy.current = scope;
    const requestGeneration = generation.current;
    setRefreshingState({ scope, value: true });
    try {
      const freshOverview = await client.overview();
      if (requestGeneration !== generation.current) return;
      const accepted = acceptCloudOverview(overviewCache.get(accountId) ?? null, freshOverview);
      overviewCache.set(accountId, accepted);
      setOverviewState({ accountId, value: accepted });
      setVerifiedState({ scope, value: true });
      if (taskId && accountTaskKey) {
        if (!accepted.tasks.some((item) => item.id === taskId)) {
          threadCache.delete(accountTaskKey);
          threadSourceCache.delete(accountTaskKey);
          setHistoryState({ key: accountTaskKey, value: null });
          setErrorState({ scope, value: null });
          return;
        }
        const feed = await client.events(taskId);
        if (requestGeneration !== generation.current) return;
        const parsed = decodeThread(feed.conversation);
        let next = threadCache.get(accountTaskKey) ?? null;
        if (Option.isSome(parsed)) {
          next =
            threadSourceCache.get(accountTaskKey) === "result"
              ? parsed.value
              : acceptCloudHistory(next, parsed.value);
          threadSourceCache.set(accountTaskKey, "feed");
        } else if (
          next === null &&
          accepted.tasks.some((item) => item.id === taskId && item.result)
        ) {
          const saved = await client.result(taskId);
          const checkpoint = decodeThread(saved.result.conversation);
          if (Option.isSome(checkpoint)) {
            next = checkpoint.value;
            threadSourceCache.set(accountTaskKey, "result");
          }
        }
        if (next) threadCache.set(accountTaskKey, next);
        setHistoryState({ key: accountTaskKey, value: next });
      }
      setErrorState({ scope, value: null });
    } catch (cause) {
      if (requestGeneration === generation.current) {
        setErrorState({
          scope,
          value: cause instanceof Error ? cause.message : "Cloud connection interrupted",
        });
      }
    } finally {
      if (requestGeneration === generation.current) setRefreshingState({ scope, value: false });
      if (busy.current === scope) busy.current = null;
    }
  }, [accountId, accountTaskKey, client, scope, taskId]);

  useEffect(() => {
    generation.current += 1;
    if (!client || !accountId || !active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      if (AppState.currentState === "active") await refresh();
      if (!stopped) timer = setTimeout(poll, taskId ? 2000 : 5000);
    };
    void poll();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      stopped = true;
      generation.current += 1;
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [accountId, active, client, refresh, taskId]);

  const task = overview?.tasks.find((item) => item.id === taskId) ?? null;
  return { client, accountId, overview, task, history, error, refreshing, verified, refresh };
}
