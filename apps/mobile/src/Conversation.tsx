import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Animated,
  FlatList,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import {
  ApprovalRequestId,
  CommandId,
  ThreadId,
  type OrchestrationMessage,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import { CloudClientError } from "@t3tools/client-runtime/cloud";
import type { CloudCommand, CloudTask } from "@t3tools/contracts/cloud";
import { Composer, defaultSettings, type ComposerSettings } from "./Composer";
import { uploadAttachments, type LocalAttachment } from "./attachments";
import {
  busyTask,
  cloudOwned,
  diffFiles,
  pendingRequests,
  relativeTime,
  taskStatus,
} from "./cloudState";
import type { MobileCloud } from "./useCloud";
import { Button, colors, Icon, IconButton, Sheet, styles } from "./ui";
import { messageLink } from "./messageLinks";
import { useReducedMotion } from "./motion";

function MessageEntrance({ animate, children }: { animate: boolean; children: ReactNode }) {
  const progress = useRef(new Animated.Value(animate ? 0 : 1)).current;

  useEffect(() => {
    if (!animate) return;
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [animate, progress]);

  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

function WorkingIndicator({
  children,
  reducedMotion,
}: {
  children: ReactNode;
  reducedMotion: boolean;
}) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reducedMotion) {
      opacity.stopAnimation();
      opacity.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.4, duration: 650, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 650, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity, reducedMotion]);

  return (
    <View style={[styles.row, { marginTop: 20 }]}>
      <Animated.View
        style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.cyan, opacity }}
      />
      <Text style={styles.muted}>{children}</Text>
    </View>
  );
}

type PendingSend = Extract<CloudCommand, { type: "task.continue" }>;
interface Draft {
  text: string;
  settings: ComposerSettings;
  attachments: LocalAttachment[];
}
export function Conversation({
  cloud,
  task,
  onMenu,
}: {
  cloud: MobileCloud;
  task: CloudTask;
  onMenu: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    text: "",
    settings: {
      ...defaultSettings,
      provider: task.provider,
      model: task.model,
      modelOptions: task.modelOptions ?? [],
      runtimeMode: task.runtimeMode ?? "approval-required",
      interactionMode: task.interactionMode ?? "default",
    },
    attachments: [],
  });
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [linkedFile, setLinkedFile] = useState<{
    path: string;
    result?: ProjectReadFileResult;
    error?: string;
  } | null>(null);
  const fileRequest = useRef(0);
  const openMessageLink = async (url: string) => {
    try {
      const link = messageLink(url, cloud.thread?.worktreePath ?? "/workspace/repository");
      if (link.kind === "web") {
        await Linking.openURL(link.url);
        return;
      }
      const requestId = ++fileRequest.current;
      setLinkedFile({ path: link.relativePath });
      try {
        if (!cloud.live.current || cloud.connectionStatus !== "connected")
          throw new Error("Reconnect to the cloud workspace to open this file.");
        const result = await cloud.live.current.readFile(link.cwd, link.relativePath);
        if (fileRequest.current === requestId) setLinkedFile({ path: link.relativePath, result });
      } catch (error) {
        if (fileRequest.current === requestId)
          setLinkedFile({
            path: link.relativePath,
            error: error instanceof Error ? error.message : "Could not open this file.",
          });
      }
    } catch (error) {
      Alert.alert(
        "Cannot open link",
        error instanceof Error ? error.message : "Could not open this link.",
      );
    }
  };
  const [review, setReview] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [responding, setResponding] = useState<string | null>(null);
  const [publish, setPublish] = useState(false);
  const [prTitle, setPrTitle] = useState(task.title ?? task.prompt.slice(0, 100));
  const [prBody, setPrBody] = useState("Changes prepared in Vitre Cloud.");
  const prKey = useRef(Crypto.randomUUID());
  const stopKey = useRef<{ turn: string | undefined; key: string } | null>(null);
  const responseKeys = useRef(new Map<string, string>());
  const list = useRef<FlatList<OrchestrationMessage>>(null);
  const atBottom = useRef(true);
  const openedHistory = useRef(false);
  const knownMessageIds = useRef(new Set<string>());
  const seededHistory = useRef(false);
  const reducedMotion = useReducedMotion();
  const patch = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }));
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      cloud.storage.get<Draft>(`draft:${task.id}`),
      cloud.storage.get<PendingSend>(`pending:${task.id}`),
    ]).then(([saved, request]) => {
      if (cancelled) return;
      if (saved) setDraft(saved);
      setPending(request);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [task.id, cloud.storage]);
  useEffect(() => {
    if (ready) void cloud.storage.set(`draft:${task.id}`, draft);
  }, [draft, ready, task.id, cloud.storage]);
  useEffect(() => {
    if (pending && task.turnRequestId === pending.idempotencyKey) {
      setPending(null);
      patch({ text: "", attachments: [] });
      void cloud.storage.set(`pending:${task.id}`, null);
    }
  }, [pending, task.turnRequestId, task.id, cloud.storage]);
  const send = async () => {
    if (sending || !cloud.online || !ready) return;
    setSending(true);
    setError(null);
    try {
      const { model, provider: _provider, ...settings } = draft.settings;
      const command: PendingSend = pending ?? {
        type: "task.continue",
        taskId: task.id,
        idempotencyKey: Crypto.randomUUID(),
        prompt: draft.text.trim(),
        attachments: await uploadAttachments(cloud.client, draft.attachments),
        ...(cloud.overview?.capabilities?.followUpSettings
          ? { ...settings, ...(model ? { model } : {}) }
          : {}),
      };
      await cloud.storage.set(`pending:${task.id}`, command);
      setPending(command);
      await cloud.command(command);
      setPending(null);
      patch({ text: "", attachments: [] });
      await cloud.storage.set(`pending:${task.id}`, null);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The message response was interrupted. Retry the same request.",
      );
      if (error instanceof CloudClientError && error.requestDisposition === "rejected") {
        setPending(null);
        await cloud.storage.set(`pending:${task.id}`, null);
      }
    } finally {
      setSending(false);
    }
  };
  const stop = async () => {
    setSending(true);
    setError(null);
    try {
      if (!stopKey.current || stopKey.current.turn !== task.turnRequestId)
        stopKey.current = { turn: task.turnRequestId, key: Crypto.randomUUID() };
      await cloud.command({
        type: "task.cancel",
        taskId: task.id,
        idempotencyKey: stopKey.current.key,
        expectedTurnRequestId: task.turnRequestId ?? null,
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not stop work");
    } finally {
      setSending(false);
    }
  };
  const respond = async (id: string, decision?: "accept" | "decline") => {
    setResponding(id);
    setError(null);
    try {
      if (!cloud.live.current || cloud.connectionStatus !== "connected")
        throw new Error("Reconnect to the cloud computer to respond. Your answer is retained.");
      const key = `${id}:${decision ?? JSON.stringify(answers)}`;
      const commandId = responseKeys.current.get(key) ?? Crypto.randomUUID();
      responseKeys.current.set(key, commandId);
      const common = {
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make(`cloud-${task.id}`),
        requestId: ApprovalRequestId.make(id),
        createdAt: new Date().toISOString(),
      };
      await cloud.live.current.dispatch(
        decision
          ? { ...common, type: "thread.approval.respond", decision }
          : {
              ...common,
              type: "thread.user-input.respond",
              answers: Object.fromEntries(
                Object.entries(answers).map(([id, value]) => [id, { answers: [value] }]),
              ),
            },
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not submit response");
    } finally {
      setResponding(null);
    }
  };
  const showReview = async () => {
    setReview(true);
    try {
      await cloud.review();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Showing the last saved diff");
    }
  };
  const createPr = async () => {
    if (!task.result) return;
    setSending(true);
    setError(null);
    try {
      await cloud.command({
        type: "publication.create",
        idempotencyKey: prKey.current,
        taskId: task.id,
        resultId: task.result.id,
        resultSha256: task.result.sha256,
        kind: "pull_request",
        title: prTitle.trim(),
        body: prBody.trim(),
      });
      setPublish(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create pull request");
    } finally {
      setSending(false);
    }
  };
  const files = diffFiles(cloud.diff);
  const busy = busyTask(task);
  const owned = cloudOwned(cloud.overview, task);
  const requests = pendingRequests(cloud.thread);
  const messages = cloud.thread?.messages ?? [];
  if (!seededHistory.current && messages.length) {
    for (const message of messages) knownMessageIds.current.add(message.id);
    seededHistory.current = true;
  }
  const changedFiles = (message: OrchestrationMessage) =>
    cloud.thread?.checkpoints.find((checkpoint) => checkpoint.assistantMessageId === message.id);
  const renderMessage = ({ item }: { item: OrchestrationMessage }) => {
    const animate = !reducedMotion && !knownMessageIds.current.has(item.id);
    knownMessageIds.current.add(item.id);
    const user = item.role === "user";
    const checkpoint = changedFiles(item);
    const activities =
      cloud.thread?.activities.filter((activity) => activity.turnId === item.turnId) ?? [];
    return (
      <MessageEntrance animate={animate}>
        <View style={{ paddingTop: user ? 28 : 36, paddingBottom: 4 }}>
          {!user && activities.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show work activity"
              onPress={() => setActivity(item.turnId ?? "all")}
              style={[
                styles.row,
                {
                  paddingBottom: 12,
                  marginBottom: 12,
                  borderBottomColor: "#353535",
                  borderBottomWidth: 1,
                },
              ]}
            >
              <Text style={styles.muted}>
                Worked
                {activities.length > 1
                  ? ` for ${Math.max(1, Math.round((Date.parse(activities.at(-1)!.createdAt) - Date.parse(activities[0]!.createdAt)) / 1000))}s`
                  : ""}
              </Text>
              <Icon name="chevron-forward" size={14} color={colors.muted} />
            </Pressable>
          )}
          <View
            style={
              user
                ? {
                    alignSelf: "flex-end",
                    maxWidth: "92%",
                    borderRadius: 22,
                    backgroundColor: colors.input,
                    paddingHorizontal: 17,
                    paddingVertical: 12,
                  }
                : undefined
            }
          >
            {user ? (
              <Text selectable style={{ color: colors.text, fontSize: 17, lineHeight: 25 }}>
                {item.text.replace(/\n\n<vitre_cloud_context>[\s\S]*?<\/vitre_cloud_context>$/, "")}
              </Text>
            ) : (
              <Markdown
                style={{
                  body: { color: colors.text, fontSize: 16, lineHeight: 26 },
                  paragraph: { marginTop: 4, marginBottom: 15 },
                  code_inline: {
                    backgroundColor: "#222222",
                    color: colors.text,
                    borderColor: colors.border,
                    borderWidth: 1,
                    borderRadius: 4,
                  },
                  fence: {
                    backgroundColor: colors.input,
                    color: colors.text,
                    borderColor: colors.border,
                    fontSize: 13,
                  },
                  link: { color: "#499cff" },
                  blockquote: { backgroundColor: colors.surface, borderLeftColor: colors.dim },
                }}
                onLinkPress={(url) => {
                  void openMessageLink(url);
                  return false;
                }}
              >
                {item.text}
              </Markdown>
            )}
            {item.attachments?.map((attachment) => (
              <Text key={attachment.id} style={styles.muted}>
                ↳ {attachment.name}
              </Text>
            ))}
          </View>
          {checkpoint && checkpoint.files.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open changed files"
              onPress={() => {
                void showReview();
              }}
              style={[styles.card, styles.row, { marginTop: 10, padding: 13 }]}
            >
              <Icon name="chevron-forward" size={15} />
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: "600" }}>
                {checkpoint.files.length} changed {checkpoint.files.length === 1 ? "file" : "files"}
              </Text>
              <Text style={{ color: colors.green, fontSize: 13 }}>
                +{checkpoint.files.reduce((total, file) => total + file.additions, 0)}
              </Text>
              <Text style={{ color: colors.red, fontSize: 13 }}>
                −{checkpoint.files.reduce((total, file) => total + file.deletions, 0)}
              </Text>
              <View style={{ flex: 1 }} />
              <Icon name="document-text-outline" size={18} />
            </Pressable>
          )}
          <View
            style={[styles.row, { justifyContent: user ? "flex-end" : "flex-start", marginTop: 2 }]}
          >
            <IconButton
              label="Copy message"
              name="copy-outline"
              onPress={() => {
                void Clipboard.setStringAsync(item.text);
              }}
            />
            <Text style={{ color: colors.dim, fontSize: 12 }}>{relativeTime(item.createdAt)}</Text>
          </View>
        </View>
      </MessageEntrance>
    );
  };
  return (
    <>
      <View
        style={[
          styles.row,
          {
            paddingLeft: 18,
            paddingRight: 6,
            minHeight: 67,
            borderBottomWidth: 1,
            borderBottomColor: "#333333",
          },
        ]}
      >
        <Pressable
          style={{ flex: 1, minWidth: 0 }}
          onPress={onMenu}
          accessibilityRole="button"
          accessibilityLabel="Open projects"
        >
          <View style={styles.row}>
            <View
              style={{
                width: 18,
                height: 18,
                backgroundColor: "#283c51",
                borderRadius: 5,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: "#96c4eb", fontSize: 10 }}>
                {task.repository.name[0]?.toUpperCase()}
              </Text>
            </View>
            <Text style={styles.muted}>{task.repository.name}</Text>
          </View>
          <Text
            numberOfLines={1}
            style={{ color: colors.text, fontWeight: "600", fontSize: 16, marginTop: 3 }}
          >
            {cloud.thread?.title ?? task.title ?? task.prompt}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create PR"
          onPress={() => setPublish(true)}
          style={[
            styles.row,
            {
              borderColor: colors.border,
              borderWidth: 1,
              paddingHorizontal: 10,
              height: 34,
              borderRadius: 8,
            },
          ]}
        >
          <Icon name="git-pull-request-outline" size={17} />
          <Text style={{ fontSize: 14, color: colors.text }}>Create PR</Text>
        </Pressable>
        <IconButton
          name="ellipsis-horizontal"
          label="Conversation actions"
          onPress={() =>
            Alert.alert("Conversation", taskStatus(task), [
              {
                text: "Review changes",
                onPress: () => {
                  void showReview();
                },
              },
              ...(busy
                ? [
                    {
                      text: "Stop work",
                      onPress: () => {
                        void stop();
                      },
                    },
                  ]
                : []),
              { text: "Cancel", style: "cancel" },
            ])
          }
        />
        <IconButton name="albums-outline" label="Open conversation drawer" onPress={onMenu} />
      </View>
      {!cloud.online && (
        <Text style={[styles.muted, { paddingHorizontal: 18, paddingVertical: 7 }]}>
          Offline · Reading saved conversation
        </Text>
      )}
      {!owned && (
        <Text style={[styles.muted, { padding: 12 }]}>
          This conversation is on another device or is moving. Saved history remains available.
        </Text>
      )}
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(message) => message.id}
        renderItem={renderMessage}
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 18, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          atBottom.current =
            event.nativeEvent.contentSize.height -
              event.nativeEvent.layoutMeasurement.height -
              event.nativeEvent.contentOffset.y <
            100;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (messages.length && (!openedHistory.current || atBottom.current)) {
            openedHistory.current = true;
            list.current?.scrollToEnd({ animated: false });
          }
        }}
        ListEmptyComponent={
          <View style={{ paddingTop: 38, gap: 14 }}>
            <Icon name="cloud-outline" color={colors.cyan} size={32} />
            <Text style={styles.heading}>{taskStatus(task)}</Text>
            <Text style={styles.text}>{task.prompt}</Text>
            <Text style={styles.muted}>
              {cloud.progress === task.error
                ? ""
                : cloud.progress || "Your cloud conversation will appear here."}
            </Text>
          </View>
        }
        ListFooterComponent={
          <>
            {busy && (
              <WorkingIndicator reducedMotion={reducedMotion}>
                {taskStatus(task)}
                {cloud.progress ? ` · ${cloud.progress}` : ""}
              </WorkingIndicator>
            )}
            {task.error && <Text style={styles.error}>{task.error}</Text>}
            {requests.map((request) => (
              <View
                key={request.id}
                style={[styles.card, { marginTop: 16, borderColor: "#53524a", borderWidth: 1 }]}
              >
                <Text style={styles.heading}>
                  {request.kind === "approval" ? "Approval needed" : "Your input is needed"}
                </Text>
                <Text style={styles.text}>{request.summary}</Text>
                {request.kind === "approval" && (
                  <View
                    style={{
                      backgroundColor: colors.background,
                      borderRadius: 8,
                      padding: 12,
                      gap: 8,
                    }}
                  >
                    <Text style={styles.muted}>{request.approval.label}</Text>
                    <Text
                      selectable
                      style={[
                        styles.text,
                        {
                          fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                          fontSize: 13,
                          lineHeight: 20,
                        },
                      ]}
                    >
                      {request.approval.detail ??
                        "The provider did not include details for this request."}
                    </Text>
                  </View>
                )}
                {request.kind === "approval" ? (
                  <View style={styles.row}>
                    <Button
                      disabled={
                        responding !== null || !owned || cloud.connectionStatus !== "connected"
                      }
                      onPress={() => {
                        void respond(request.id, "decline");
                      }}
                    >
                      Decline
                    </Button>
                    <Button
                      primary
                      disabled={
                        responding !== null || !owned || cloud.connectionStatus !== "connected"
                      }
                      onPress={() => {
                        void respond(request.id, "accept");
                      }}
                    >
                      Allow
                    </Button>
                  </View>
                ) : (
                  <>
                    {request.questions.map((question) => (
                      <View key={question.id} style={{ gap: 8 }}>
                        <Text style={styles.text}>{question.question}</Text>
                        {question.options?.map((option) => (
                          <Button
                            key={option.label}
                            primary={answers[question.id] === option.label}
                            onPress={() => setAnswers({ ...answers, [question.id]: option.label })}
                          >
                            {option.label}
                          </Button>
                        ))}
                        <TextInput
                          accessibilityLabel={question.question}
                          placeholder="Your answer"
                          placeholderTextColor={colors.dim}
                          style={styles.input}
                          value={answers[question.id] ?? ""}
                          onChangeText={(value) => setAnswers({ ...answers, [question.id]: value })}
                        />
                      </View>
                    ))}
                    <Button
                      primary
                      disabled={
                        responding !== null ||
                        !owned ||
                        cloud.connectionStatus !== "connected" ||
                        request.questions.some((question) => !answers[question.id]?.trim())
                      }
                      onPress={() => {
                        void respond(request.id);
                      }}
                    >
                      Send answers
                    </Button>
                  </>
                )}
              </View>
            ))}
            {cloud.overview?.publications
              .filter((publication) => publication.taskId === task.id)
              .map((publication) => (
                <Pressable
                  key={publication.id}
                  onPress={() => {
                    if (publication.url) void Linking.openURL(publication.url);
                  }}
                  style={[styles.card, { marginTop: 16 }]}
                >
                  <Text style={styles.text}>
                    {publication.state === "published"
                      ? "Pull request created ↗"
                      : `Pull request · ${publication.state}`}
                  </Text>
                  {publication.state === "failed" && (
                    <Button
                      onPress={() => {
                        void cloud
                          .command({
                            type: "publication.retry",
                            publicationId: publication.id,
                            idempotencyKey: Crypto.randomUUID(),
                          })
                          .catch((error: Error) => setError(error.message));
                      }}
                    >
                      Retry publication
                    </Button>
                  )}
                </Pressable>
              ))}
          </>
        }
      />
      <View style={{ paddingHorizontal: 14, paddingBottom: 8, paddingTop: 4 }}>
        {(error || cloud.error) && (
          <Text accessibilityRole="alert" style={[styles.error, { paddingBottom: 8 }]}>
            {error ?? cloud.error}
          </Text>
        )}
        {pending && (
          <View style={[styles.row, { marginBottom: 8 }]}>
            <Text style={[styles.muted, { flex: 1 }]}>
              Send interrupted. Retry checks the same message.
            </Text>
            <Button
              disabled={!cloud.online || sending}
              onPress={() => {
                void send();
              }}
            >
              Retry
            </Button>
          </View>
        )}
        <View style={[styles.row, { paddingHorizontal: 7, paddingBottom: 8 }]}>
          <Icon name="cloud-outline" size={14} color={colors.dim} />
          <Text style={[styles.muted, { flex: 1 }]}>Cloud workspace</Text>
          <Icon name="git-branch-outline" size={14} color={colors.dim} />
          <Text numberOfLines={1} style={[styles.muted, { maxWidth: "48%" }]}>
            {cloud.thread?.branch ?? task.branch}
          </Text>
        </View>
        <Composer
          text={draft.text}
          onText={(text) => patch({ text })}
          settings={draft.settings}
          onSettings={(settings) => patch({ settings: { ...settings, provider: task.provider } })}
          attachments={draft.attachments}
          onAttachments={(attachments) => patch({ attachments })}
          config={cloud.config}
          onSend={() => {
            void send();
          }}
          onStop={() => {
            void stop();
          }}
          busy={busy}
          disabled={sending || !ready || !cloud.online || !owned || !!pending}
          providerLocked
          settingsLocked={!cloud.overview?.capabilities?.followUpSettings}
        />
      </View>
      {linkedFile && (
        <Sheet
          title={linkedFile.path}
          onClose={() => {
            fileRequest.current++;
            setLinkedFile(null);
          }}
        >
          {linkedFile.error ? (
            <Text style={styles.error}>{linkedFile.error}</Text>
          ) : linkedFile.result ? (
            <>
              {linkedFile.result.truncated && (
                <Text style={styles.muted}>This large file is truncated.</Text>
              )}
              <Text
                selectable
                style={[
                  styles.text,
                  {
                    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                    fontSize: 13,
                    lineHeight: 20,
                  },
                ]}
              >
                {linkedFile.result.contents || "This file is empty."}
              </Text>
            </>
          ) : (
            <Text style={styles.muted}>Loading file…</Text>
          )}
        </Sheet>
      )}
      {activity && (
        <Sheet title="Work activity" onClose={() => setActivity(null)}>
          {cloud.thread?.activities
            .filter((item) => activity === "all" || item.turnId === activity)
            .map((item) => (
              <View key={item.id} style={styles.card}>
                <Text style={styles.text}>{item.summary}</Text>
                <Text style={styles.muted}>{relativeTime(item.createdAt)}</Text>
              </View>
            ))}
        </Sheet>
      )}
      {review && (
        <Sheet title="Changed files" onClose={() => setReview(false)}>
          {!files.length && (
            <Text style={styles.muted}>
              {cloud.diff
                ? "The saved diff is available below."
                : "No saved changes yet. Changes appear after the agent saves a checkpoint."}
            </Text>
          )}
          {files.map((file) => (
            <View key={file.name} style={{ gap: 8 }}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setOpenFile(openFile === file.name ? null : file.name)}
                style={[styles.card, styles.row]}
              >
                <Icon name="document-text-outline" size={18} />
                <Text style={[styles.text, { flex: 1 }]}>{file.name}</Text>
                <Text style={{ color: colors.green }}>+{file.additions}</Text>
                <Text style={{ color: colors.red }}>−{file.deletions}</Text>
              </Pressable>
              {openFile === file.name && (
                <ScrollView horizontal>
                  <View style={{ padding: 10, backgroundColor: colors.input }}>
                    {file.text.split("\n").map((line, index) => (
                      <Text
                        selectable
                        // Lines occupy fixed positions in the immutable selected diff.
                        // oxlint-disable-next-line react/no-array-index-key
                        key={index}
                        style={{
                          fontFamily: "monospace",
                          fontSize: 12,
                          lineHeight: 19,
                          color: line.startsWith("+")
                            ? colors.green
                            : line.startsWith("-")
                              ? colors.red
                              : colors.text,
                        }}
                      >
                        {line || " "}
                      </Text>
                    ))}
                  </View>
                </ScrollView>
              )}
            </View>
          ))}
          {files.length === 0 && !!cloud.diff && (
            <Text selectable style={styles.text}>
              {cloud.diff}
            </Text>
          )}
        </Sheet>
      )}
      {publish && (
        <Sheet title="Create pull request" onClose={() => setPublish(false)}>
          <Text style={styles.muted}>
            Publish the latest saved result for review. GitHub publication requires connected write
            access.
          </Text>
          {!task.result && (
            <Text style={styles.error}>Wait for a verified result before publishing.</Text>
          )}
          <Text style={styles.label}>Title</Text>
          <TextInput
            accessibilityLabel="Pull request title"
            style={styles.input}
            value={prTitle}
            onChangeText={(title) => {
              setPrTitle(title);
              prKey.current = Crypto.randomUUID();
            }}
          />
          <Text style={styles.label}>Description</Text>
          <TextInput
            accessibilityLabel="Pull request description"
            style={[styles.input, { minHeight: 130 }]}
            multiline
            value={prBody}
            onChangeText={(body) => {
              setPrBody(body);
              prKey.current = Crypto.randomUUID();
            }}
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <Button
            primary
            disabled={!task.result || sending || !cloud.online || !prTitle.trim() || !prBody.trim()}
            onPress={() => {
              void createPr();
            }}
          >
            Create PR
          </Button>
        </Sheet>
      )}
    </>
  );
}
