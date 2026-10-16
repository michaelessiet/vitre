import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { CloudClientError } from "@t3tools/client-runtime/cloud";
import type { CloudSavedResult } from "@t3tools/contracts/cloud";
import type { ProviderApprovalDecision } from "@t3tools/contracts";
import { Markdown } from "react-native-nitro-markdown";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { uuidv4 } from "../../lib/uuid";
import {
  buildPendingUserInputAnswers,
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  setComposerDraftText,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import { PendingApprovalCard } from "../threads/PendingApprovalCard";
import { PendingUserInputCard } from "../threads/PendingUserInputCard";
import { respondToCloudApproval, respondToCloudQuestion } from "./cloudWorkspace";
import {
  cloudDiffSummary,
  cloudSendAccepted,
  cloudStopSettled,
  cloudTaskOwnership,
  cloudTaskStatus,
  cloudTurnBusy,
  type PendingCloudSend,
} from "./mobileCloudState";
import {
  loadPendingCloudSend,
  transitionPendingCloudSend,
  updatePendingCloudSend,
} from "./mobileCloudStorage";
import { useVitreCloud } from "./useVitreCloud";

export function VitreCloudTaskScreen({ route }: StaticScreenProps<{ readonly taskId: string }>) {
  const taskId = route.params.taskId;
  const navigation = useNavigation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const scheme = useColorScheme();
  const { client, accountId, overview, task, history, error, refreshing, verified, refresh } =
    useVitreCloud(taskId, focused);
  const draftKey = accountId ? `vitre-cloud:${accountId}:${taskId}` : null;
  const draft = useComposerDraft(draftKey);
  const [pending, setPending] = useState<PendingCloudSend | null>(null);
  const [pendingLoadedKey, setPendingLoadedKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stoppingTurn, setStoppingTurn] = useState<{
    screenKey: string;
    taskId: string;
    turnRequestId: string | null;
    idempotencyKey: string;
    delivery: "requested" | "acknowledged" | "uncertain";
  } | null>(null);
  const [responding, setResponding] = useState<string | null>(null);
  const [inputDrafts, setInputDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [result, setResult] = useState<{
    taskId: string;
    resultId: string;
    value: CloudSavedResult;
  } | null>(null);
  const [resultError, setResultError] = useState(false);
  const [resultRetry, setResultRetry] = useState(0);
  const [diffOpen, setDiffOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const nearBottomRef = useRef(true);
  const pendingRef = useRef<PendingCloudSend | null>(null);
  pendingRef.current = pending;
  const stopOperationRef = useRef<string | null>(null);
  const stopInFlightRef = useRef(false);
  const respondingRequestRef = useRef<string | null>(null);
  const publicationOperationRef = useRef<string | null>(null);
  const screenKey = `${accountId ?? "signed-out"}:${taskId}`;
  const activeScreenKey = useRef(screenKey);
  activeScreenKey.current = screenKey;
  const activeStop = stoppingTurn?.screenKey === screenKey ? stoppingTurn : null;
  const activePending =
    pending?.accountId === accountId && pending.taskId === taskId ? pending : null;
  const pendingLoaded = pendingLoadedKey === screenKey;

  useEffect(() => {
    setActionError(null);
    setStoppingTurn(null);
    stopOperationRef.current = null;
    stopInFlightRef.current = false;
    setResponding(null);
    respondingRequestRef.current = null;
    setInputDrafts({});
    setDiffOpen(false);
    nearBottomRef.current = true;
    setPublishing(false);
    publicationOperationRef.current = null;
  }, [screenKey]);

  useEffect(() => {
    let current = true;
    setPending(null);
    setPendingLoadedKey(null);
    if (accountId)
      void loadPendingCloudSend(accountId, taskId)
        .then((value) => {
          if (current) {
            setPending(value);
            setPendingLoadedKey(screenKey);
          }
        })
        .catch((cause) => {
          if (current) {
            setActionError(
              cause instanceof Error ? cause.message : "Could not restore pending send",
            );
          }
        });
    return () => {
      current = false;
    };
  }, [accountId, screenKey, taskId]);

  useEffect(() => {
    if (
      !accountId ||
      !pending ||
      pending.accountId !== accountId ||
      pending.taskId !== taskId ||
      !cloudSendAccepted(pending, task, history)
    )
      return;
    setPending(null);
    void transitionPendingCloudSend(accountId, taskId, pending.idempotencyKey, null).catch(
      () => undefined,
    );
    if (draftKey && getComposerDraftSnapshot(draftKey).text === pending.prompt)
      clearComposerDraftContent(draftKey);
  }, [accountId, draftKey, history, pending, task, taskId]);

  useEffect(() => {
    if (!task || !activeStop) return;
    if (cloudStopSettled(task, activeStop.turnRequestId)) {
      setStoppingTurn(null);
      stopOperationRef.current = null;
      stopInFlightRef.current = false;
    }
  }, [activeStop, task]);

  useEffect(() => {
    if (!task?.result) {
      setResult(null);
      setResultError(false);
      return;
    }
    if (!client || !focused) return;
    const resultId = task.result.id;
    let current = true;
    setResultError(false);
    void client
      .result(taskId)
      .then((value) => {
        if (current) {
          setResult({ taskId, resultId, value });
          setResultError(false);
        }
      })
      .catch(() => {
        if (current) setResultError(true);
      });
    return () => {
      current = false;
    };
  }, [client, focused, resultRetry, task?.result?.id, taskId]);

  const approvals = useMemo(() => derivePendingApprovals(history?.activities ?? []), [history]);
  const questions = useMemo(() => derivePendingUserInputs(history?.activities ?? []), [history]);
  const activeApproval = task?.state === "waiting_for_input" ? (approvals.at(-1) ?? null) : null;
  const activeQuestion = task?.state === "waiting_for_input" ? (questions.at(-1) ?? null) : null;
  const questionAnswers = activeQuestion
    ? buildPendingUserInputAnswers(activeQuestion.questions, inputDrafts)
    : null;
  const busy = cloudTurnBusy(task, history);
  const ownership = cloudTaskOwnership(overview, task);
  const publication = overview?.publications.find(
    (item) =>
      item.taskId === taskId && item.resultId === task?.result?.id && item.kind === "pull_request",
  );
  const providerConnected = overview?.accounts.some(
    (item) => item.provider === task?.provider && item.state === "connected",
  );
  const visibleResult =
    result?.taskId === taskId && result.resultId === task?.result?.id ? result.value : null;
  const diffSummary = useMemo(
    () => cloudDiffSummary(visibleResult?.result.diff ?? ""),
    [visibleResult?.result.diff],
  );

  const send = useCallback(async () => {
    if (
      !client ||
      !accountId ||
      !draftKey ||
      !task ||
      !pendingLoaded ||
      !verified ||
      error ||
      ownership !== "cloud" ||
      !providerConnected
    )
      return;
    if (busy || activeStop !== null) return;
    const existing =
      pendingRef.current?.accountId === accountId && pendingRef.current.taskId === taskId
        ? pendingRef.current
        : null;
    const message: PendingCloudSend = existing ?? {
      accountId,
      taskId,
      idempotencyKey: uuidv4(),
      prompt: draft.text.trim(),
      createdAt: new Date().toISOString(),
      disposition: "submitting",
    };
    if (!message.prompt || (existing && existing.disposition === "submitting")) return;
    setActionError(null);
    const sending = { ...message, disposition: "submitting" as const };
    pendingRef.current = sending;
    setPending(sending);
    let dispatched = false;
    try {
      // The exact key and prompt are durable before the request leaves the phone.
      await updatePendingCloudSend(accountId, taskId, sending);
      dispatched = true;
      const response = await client.command({
        type: "task.continue",
        idempotencyKey: message.idempotencyKey,
        taskId,
        prompt: message.prompt,
      });
      if (response.entityId !== taskId)
        throw new Error("Cloud response belongs to another conversation");
      const transitioned = await transitionPendingCloudSend(
        accountId,
        taskId,
        message.idempotencyKey,
        null,
      );
      if (
        transitioned &&
        activeScreenKey.current === screenKey &&
        pendingRef.current?.idempotencyKey === message.idempotencyKey
      ) {
        setPending(null);
        pendingRef.current = null;
      }
      if (transitioned && getComposerDraftSnapshot(draftKey).text.trim() === message.prompt)
        clearComposerDraftContent(draftKey);
      void refresh();
    } catch (cause) {
      if (
        !dispatched ||
        (cause instanceof CloudClientError && cause.requestDisposition === "rejected")
      ) {
        if (dispatched)
          await transitionPendingCloudSend(accountId, taskId, message.idempotencyKey, null).catch(
            () => false,
          );
        if (
          activeScreenKey.current === screenKey &&
          pendingRef.current?.idempotencyKey === message.idempotencyKey
        ) {
          setPending(null);
          pendingRef.current = null;
        }
      } else {
        const uncertain = { ...message, disposition: "uncertain" as const };
        await transitionPendingCloudSend(
          accountId,
          taskId,
          message.idempotencyKey,
          uncertain,
        ).catch(() => false);
        if (
          activeScreenKey.current === screenKey &&
          pendingRef.current?.idempotencyKey === message.idempotencyKey
        ) {
          setPending(uncertain);
          pendingRef.current = uncertain;
        }
      }
      if (activeScreenKey.current === screenKey)
        setActionError(cause instanceof Error ? cause.message : "Could not confirm delivery");
    }
  }, [
    accountId,
    busy,
    client,
    draft.text,
    draftKey,
    error,
    pendingLoaded,
    ownership,
    providerConnected,
    refresh,
    activeStop,
    screenKey,
    task,
    taskId,
    verified,
  ]);

  const stop = useCallback(async () => {
    if (!client || !task || !verified || error || ownership !== "cloud" || stopInFlightRef.current)
      return;
    if (stopOperationRef.current && activeStop?.delivery !== "uncertain") return;
    const request =
      activeStop?.delivery === "uncertain"
        ? activeStop
        : activeStop === null && busy
          ? {
              screenKey,
              taskId,
              turnRequestId: task.turnRequestId ?? null,
              idempotencyKey: uuidv4(),
              delivery: "requested" as const,
            }
          : null;
    if (!request) return;
    stopInFlightRef.current = true;
    stopOperationRef.current = request.idempotencyKey;
    setStoppingTurn({ ...request, delivery: "requested" });
    setActionError(null);
    try {
      await client.command({
        type: "task.cancel",
        idempotencyKey: request.idempotencyKey,
        taskId,
        expectedTurnRequestId: request.turnRequestId,
      });
      if (
        activeScreenKey.current === screenKey &&
        stopOperationRef.current === request.idempotencyKey
      )
        setStoppingTurn((current) =>
          current?.idempotencyKey === request.idempotencyKey
            ? { ...current, delivery: "acknowledged" }
            : current,
        );
      void refresh();
    } catch (cause) {
      if (
        activeScreenKey.current === screenKey &&
        stopOperationRef.current === request.idempotencyKey
      ) {
        if (cause instanceof CloudClientError && cause.requestDisposition === "rejected") {
          setStoppingTurn(null);
          stopOperationRef.current = null;
        } else {
          setStoppingTurn((current) =>
            current?.idempotencyKey === request.idempotencyKey
              ? { ...current, delivery: "uncertain" }
              : current,
          );
          void refresh();
        }
        setActionError(cause instanceof Error ? cause.message : "Could not stop turn");
      }
    } finally {
      if (
        activeScreenKey.current === screenKey &&
        stopOperationRef.current === request.idempotencyKey
      )
        stopInFlightRef.current = false;
    }
  }, [activeStop, busy, client, error, ownership, refresh, screenKey, task, taskId, verified]);

  async function approval(decision: ProviderApprovalDecision) {
    if (
      !client ||
      !history ||
      !activeApproval ||
      respondingRequestRef.current ||
      ownership !== "cloud" ||
      !verified ||
      error
    )
      return;
    const requestScreenKey = screenKey;
    const requestId = activeApproval.requestId;
    respondingRequestRef.current = requestId;
    setResponding(requestId);
    try {
      await respondToCloudApproval(client, taskId, history.id, requestId, decision);
      void refresh();
    } catch (cause) {
      if (
        activeScreenKey.current === requestScreenKey &&
        respondingRequestRef.current === requestId
      )
        setActionError(cause instanceof Error ? cause.message : "Approval failed");
    } finally {
      if (
        activeScreenKey.current === requestScreenKey &&
        respondingRequestRef.current === requestId
      ) {
        setResponding(null);
        respondingRequestRef.current = null;
      }
    }
  }

  async function answerQuestion() {
    if (
      !client ||
      !history ||
      !activeQuestion ||
      !questionAnswers ||
      respondingRequestRef.current ||
      ownership !== "cloud" ||
      !verified ||
      error
    )
      return;
    const requestScreenKey = screenKey;
    const requestId = activeQuestion.requestId;
    respondingRequestRef.current = requestId;
    setResponding(requestId);
    try {
      await respondToCloudQuestion(client, taskId, history.id, requestId, questionAnswers);
      void refresh();
    } catch (cause) {
      if (
        activeScreenKey.current === requestScreenKey &&
        respondingRequestRef.current === requestId
      )
        setActionError(cause instanceof Error ? cause.message : "Could not submit answers");
    } finally {
      if (
        activeScreenKey.current === requestScreenKey &&
        respondingRequestRef.current === requestId
      ) {
        setResponding(null);
        respondingRequestRef.current = null;
      }
    }
  }

  function createPullRequest() {
    if (!client || !task?.result || publishing || !verified || error) return;
    if (publication?.url && publication.state === "published") {
      void Linking.openURL(publication.url);
      return;
    }
    if (publication?.state === "queued" || publication?.state === "publishing") return;
    const retry = publication?.state === "failed";
    Alert.alert(
      retry ? "Retry pull request?" : "Create pull request?",
      "Publish this cloud result to GitHub?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: retry ? "Retry PR" : "Create PR",
          onPress: () => {
            const operationId = uuidv4();
            const requestScreenKey = screenKey;
            publicationOperationRef.current = operationId;
            setPublishing(true);
            void client
              .command(
                retry
                  ? {
                      type: "publication.retry",
                      idempotencyKey: operationId,
                      publicationId: publication.id,
                    }
                  : {
                      type: "publication.create",
                      idempotencyKey: operationId,
                      taskId,
                      resultId: task.result!.id,
                      resultSha256: task.result!.sha256,
                      kind: "pull_request",
                      title: task.title ?? task.prompt.slice(0, 100),
                      body: task.result!.summary,
                    },
              )
              .then(() => refresh())
              .catch((cause) => {
                if (
                  activeScreenKey.current === requestScreenKey &&
                  publicationOperationRef.current === operationId
                )
                  setActionError(cause instanceof Error ? cause.message : "Could not create PR");
              })
              .finally(() => {
                if (
                  activeScreenKey.current === requestScreenKey &&
                  publicationOperationRef.current === operationId
                ) {
                  setPublishing(false);
                  publicationOperationRef.current = null;
                }
              });
          },
        },
      ],
    );
  }

  const dark = scheme !== "light";
  const screenColor = dark ? "#252525" : "#f7f7f8";
  return (
    <KeyboardAvoidingView
      className="flex-1 bg-screen"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ paddingTop: insets.top, backgroundColor: screenColor }}
    >
      <View className="min-h-17 flex-row items-center gap-3 border-b border-input-border px-4 py-2">
        <Pressable
          accessibilityLabel="Search cloud threads"
          onPress={() => navigation.navigate("VitreCloudHome")}
        >
          <SymbolView name="magnifyingglass" size={22} tintColor={iconColor} />
        </Pressable>
        <View className="flex-1">
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {task ? `${task.repository.owner}/${task.repository.name}` : "Vitre Cloud"}
          </Text>
          <Text numberOfLines={1} className="font-t3-bold text-base">
            {task?.title ?? history?.title ?? task?.prompt ?? "Cloud conversation"}
          </Text>
        </View>
        {task?.result &&
        task.repository.installationId !== "local" &&
        task.repository.installationId !== "public" ? (
          <Pressable
            accessibilityLabel="Create pull request"
            className="rounded-xl border border-input-border px-3 py-2"
            disabled={
              publishing ||
              publication?.state === "queued" ||
              publication?.state === "publishing" ||
              !verified ||
              !!error
            }
            onPress={createPullRequest}
          >
            <Text className="font-t3-medium text-sm">
              {publication?.state === "published"
                ? "Open PR"
                : publication?.state === "failed"
                  ? "Retry PR"
                  : publication
                    ? "Publishing…"
                    : "Create PR"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 24, gap: 22 }}
        onContentSizeChange={() => {
          if (focused && nearBottomRef.current) scrollRef.current?.scrollToEnd({ animated: false });
        }}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          nearBottomRef.current =
            contentSize.height - layoutMeasurement.height - contentOffset.y < 96;
        }}
        scrollEventThrottle={32}
      >
        {!accountId ? (
          <View className="rounded-2xl bg-subtle p-5">
            <Text className="font-t3-bold text-lg">Sign in to continue this conversation</Text>
            <Text className="mt-2 text-foreground-muted">
              Use the same account as Vitre on your computer.
            </Text>
            <Pressable
              className="mt-4 self-start rounded-xl bg-blue-600 px-4 py-3"
              onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
            >
              <Text className="font-t3-bold text-white">Sign in</Text>
            </Pressable>
          </View>
        ) : verified && !task ? (
          <View className="rounded-2xl bg-subtle p-5">
            <Text className="font-t3-bold text-lg">Conversation unavailable</Text>
            <Text className="mt-2 text-foreground-muted">
              This cloud conversation is no longer in your account.
            </Text>
            <Pressable
              className="mt-4 self-start"
              onPress={() => navigation.navigate("VitreCloudHome")}
            >
              <Text className="text-blue-400">Open cloud projects</Text>
            </Pressable>
          </View>
        ) : !task && !error ? (
          <ActivityIndicator />
        ) : null}
        {history?.messages.map((message) => (
          <View
            key={message.id}
            className={
              message.role === "user"
                ? "self-end max-w-[88%] rounded-2xl bg-subtle px-4 py-3"
                : "w-full py-2"
            }
          >
            {message.role === "assistant" ? (
              <Text className="mb-2 text-xs text-foreground-muted">
                Assistant · {new Date(message.updatedAt).toLocaleTimeString()}
              </Text>
            ) : null}
            <Markdown
              options={{ gfm: true }}
              theme={{
                colors: {
                  text: dark ? "#eeeeee" : "#202020",
                  heading: dark ? "#ffffff" : "#111111",
                  link: "#4a9bff",
                  surface: "transparent",
                },
                fontSizes: { m: 16 },
              }}
            >
              {message.text}
            </Markdown>
          </View>
        ))}
        {activeApproval && history ? (
          <PendingApprovalCard
            approval={activeApproval}
            disabled={!verified || !!error || ownership !== "cloud"}
            respondingApprovalId={responding as typeof activeApproval.requestId | null}
            onRespond={async (_id, decision) => approval(decision)}
          />
        ) : null}
        {activeQuestion && history ? (
          <PendingUserInputCard
            pendingUserInput={activeQuestion}
            submitDisabled={!verified || !!error || ownership !== "cloud"}
            drafts={inputDrafts}
            answers={questionAnswers}
            respondingUserInputId={responding as typeof activeQuestion.requestId | null}
            onSelectOption={(_id, questionId, label) =>
              setInputDrafts((current) => ({
                ...current,
                [questionId]: { selectedOptionLabel: label },
              }))
            }
            onChangeCustomAnswer={(_id, questionId, value) =>
              setInputDrafts((current) => ({ ...current, [questionId]: { customAnswer: value } }))
            }
            onSubmit={answerQuestion}
          />
        ) : null}
        {visibleResult?.result.diff ? (
          <View className="rounded-2xl bg-subtle p-4">
            <Pressable
              className="flex-row items-center justify-between"
              onPress={() => setDiffOpen((value) => !value)}
            >
              <View className="flex-row items-center gap-2">
                <SymbolView
                  name={diffOpen ? "chevron.down" : "chevron.right"}
                  size={15}
                  tintColor={iconColor}
                />
                <Text className="font-t3-bold">{diffSummary.files} changed files</Text>
                <Text className="text-emerald-400">+{diffSummary.added}</Text>
                <Text className="text-rose-400">−{diffSummary.removed}</Text>
              </View>
              <Text className="text-xs text-foreground-muted">
                {diffOpen ? "Hide diff" : "Open diff"}
              </Text>
            </Pressable>
            {diffOpen ? (
              <Text selectable className="mt-4 font-mono text-xs">
                {visibleResult.result.diff}
              </Text>
            ) : null}
          </View>
        ) : null}
        {task?.result && resultError ? (
          <Pressable className="self-start" onPress={() => setResultRetry((value) => value + 1)}>
            <Text className="text-blue-400">Retry loading the result and diff</Text>
          </Pressable>
        ) : null}
        {task?.error ? <Text className="text-rose-400">{task.error}</Text> : null}
        {task?.dependencySetup?.outcome === "failed" ? (
          <Text className="text-amber-400">
            Dependency setup failed
            {task.dependencySetup.detail ? `: ${task.dependencySetup.detail}` : ""}
          </Text>
        ) : null}
        {task?.state === "needs_auth" ? (
          <View className="rounded-2xl bg-subtle p-4">
            <Text className="font-t3-bold">
              {providerConnected ? "Ready to retry" : "Provider sign-in required"}
            </Text>
            {providerConnected && draftKey ? (
              <Pressable
                className="mt-3 self-start rounded-xl bg-blue-600 px-4 py-2"
                onPress={() => setComposerDraftText(draftKey, task.prompt)}
              >
                <Text className="font-t3-bold text-white">Reuse prompt after sign-in</Text>
              </Pressable>
            ) : task.provider === "codex" ? (
              <Pressable
                className="mt-3 self-start rounded-xl bg-blue-600 px-4 py-2"
                onPress={() => navigation.navigate("VitreCloudLogin")}
              >
                <Text className="font-t3-bold text-white">Connect Codex</Text>
              </Pressable>
            ) : (
              <Text className="mt-2 text-sm text-foreground-muted">
                Connect Claude in Vitre on your computer, then return here.
              </Text>
            )}
          </View>
        ) : null}
        {task?.state === "failed" && draftKey ? (
          <Pressable
            className="self-start rounded-xl bg-subtle px-4 py-3"
            onPress={() => setComposerDraftText(draftKey, task.prompt)}
          >
            <Text>Reuse prompt for a new turn</Text>
          </Pressable>
        ) : null}
        {task?.result && task.repository.installationId === "public" ? (
          <Text className="text-xs text-foreground-muted">
            Connect GitHub write access to create a pull request for this public repository.
          </Text>
        ) : null}
      </ScrollView>
      <View
        className="border-t border-input-border bg-screen px-4 pt-2"
        style={{ paddingBottom: Math.max(insets.bottom, 10), backgroundColor: screenColor }}
      >
        <View className="mb-2 min-h-7 flex-row items-center justify-between">
          <Text className="text-xs text-foreground-muted">
            {!accountId
              ? "Sign in required"
              : verified && !task
                ? "Conversation unavailable"
                : activeStop !== null
                  ? "Stopping…"
                  : error
                    ? history
                      ? "Disconnected · cached history"
                      : "Disconnected"
                    : task
                      ? cloudTaskStatus(task)
                      : "Connecting"}
            {activePending
              ? activePending.disposition === "uncertain"
                ? " · Delivery uncertain"
                : " · Sending"
              : ""}
          </Text>
          {error ? (
            <Pressable onPress={() => void refresh()}>
              <Text className="text-xs text-blue-400">Retry connection</Text>
            </Pressable>
          ) : refreshing && !task ? (
            <ActivityIndicator size="small" />
          ) : null}
        </View>
        {actionError ? <Text className="mb-2 text-xs text-rose-400">{actionError}</Text> : null}
        {task && ownership !== "cloud" ? (
          <Text className="mb-2 text-xs text-foreground-muted">
            {ownership === "local"
              ? "This conversation is now local on your computer."
              : ownership === "moving"
                ? "Conversation is moving between locations…"
                : "Checking conversation ownership before sending…"}
          </Text>
        ) : null}
        {activePending?.disposition === "uncertain" ? (
          <Pressable className="mb-2 self-start" onPress={() => void refresh()}>
            <Text className="text-xs text-blue-400">
              Check delivery, then retry with the same request
            </Text>
          </Pressable>
        ) : null}
        <View className="mb-2 flex-row items-center justify-between">
          <Text className="text-xs text-foreground-muted">
            Cloud: {task?.repository.installationId === "local" ? "Local" : "GitHub"}
          </Text>
          <Text numberOfLines={1} className="max-w-[50%] text-xs text-foreground-muted">
            {task?.branch ?? ""}
          </Text>
        </View>
        <View className="rounded-2xl border border-blue-600 bg-input p-3">
          <TextInput
            accessibilityLabel="Message cloud conversation"
            multiline
            className="min-h-14 border-0 bg-transparent px-1 py-1"
            placeholder="Message Vitre…"
            value={draft.text}
            onChangeText={(value) => {
              if (draftKey) setComposerDraftText(draftKey, value);
            }}
          />
          <View className="mt-2 flex-row items-center justify-between">
            <Text className="text-xs text-foreground-muted">
              {task?.model ?? "Default model"} ·{" "}
              {task?.interactionMode === "plan" ? "Plan" : "Build"}
            </Text>
            <Pressable
              accessibilityLabel={
                activeStop?.delivery === "uncertain"
                  ? "Retry stop request"
                  : activeStop
                    ? "Stopping cloud turn"
                    : busy
                      ? "Stop cloud turn"
                      : activePending?.disposition === "uncertain"
                        ? "Retry pending message"
                        : "Send message"
              }
              disabled={
                !client ||
                !task ||
                !verified ||
                !!error ||
                ownership !== "cloud" ||
                (!busy && !providerConnected) ||
                (!busy &&
                  !activeStop &&
                  (!pendingLoaded ||
                    (!draft.text.trim() && activePending?.disposition !== "uncertain") ||
                    activePending?.disposition === "submitting")) ||
                (activeStop !== null && activeStop.delivery !== "uncertain")
              }
              className="size-11 items-center justify-center rounded-full bg-blue-600 disabled:opacity-40"
              onPress={() => void (busy || activeStop ? stop() : send())}
            >
              <SymbolView
                name={busy || activeStop ? "stop.fill" : "arrow.up"}
                size={19}
                tintColor="white"
              />
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
