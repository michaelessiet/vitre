import { Visual } from "./Visual";
import Markdown, { type RenderRules } from "react-native-markdown-display";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Crypto from "expo-crypto";
import type {
  LensCommand,
  LensOverview,
  LensRecommendation,
  LensSettings,
} from "@t3tools/contracts/lens";
import type { MobileCloud } from "./useCloud";
import { Button, colors, Icon, IconButton, Sheet, styles } from "./ui";

const dateLabel = (value: string) =>
  new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const key = () => Crypto.randomUUID();

export function Lens({
  cloud,
  onMenu,
  onOpen,
}: {
  cloud: MobileCloud;
  onMenu: () => void;
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<LensOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<LensCommand | null>(null);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"overview" | "chat">("overview");
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  const [modelSearch, setModelSearch] = useState<string | null>(null);
  const [form, setForm] = useState<LensSettings | null>(null);
  const [time, setTime] = useState("");
  const [days, setDays] = useState(["14", "30"]);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const formRevision = useRef(0);
  const accept = useCallback(
    (next: LensOverview) =>
      setData((current) =>
        !current ||
        next.revision > current.revision ||
        (next.revision === current.revision && JSON.stringify(next) !== JSON.stringify(current))
          ? next
          : current,
      ),
    [],
  );
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const refresh = async () => {
      if (AppState.currentState !== "active") return;
      try {
        const next = await cloud.client.lens();
        if (!cancelled) {
          accept(next);
          setPollError(null);
        }
      } catch (error) {
        if (!cancelled)
          setPollError(
            error instanceof Error ? error.message : "Lens could not connect. Try again.",
          );
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      cancelled = true;
      alive.current = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [cloud.client, accept]);
  const request = async (command: LensCommand) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (command.type === "chat") setTab("chat");
    setBusy(true);
    setError(null);
    setRetry(command);
    try {
      const next = await cloud.client.lensCommand(command);
      if (!alive.current) return;
      accept(next);
      setRetry(null);
      if (command.type === "chat") setDraft("");
      if (command.type === "settings.update") setEditing(false);
    } catch (error) {
      if (alive.current)
        setError(
          error instanceof Error ? error.message : "Lens could not connect. Retry this request.",
        );
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const blocked = busy || !!retry || !!data?.running || !data;
  const send = () => {
    if (draft.trim() && !blocked)
      void request({ type: "chat", idempotencyKey: key(), message: draft.trim() });
  };
  const approve = (action: LensRecommendation) => {
    const project = action.kind === "remove_project";
    Alert.alert(
      project ? "Remove this project?" : "Archive this conversation?",
      `${action.title}\n\n${project ? "This permanently removes the project, its conversations, and saved cloud snapshots from Vitre. Repository and desktop files stay in place." : "This hides the conversation from your active list. You can restore it from the archive."}${action.sourceId !== "cloud" ? "\n\nYour desktop will apply the action when it next connects, if the item is still unchanged." : ""}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: project ? "Remove project" : "Archive",
          style: project ? "destructive" : "default",
          onPress: () =>
            void request({
              type: "decide",
              idempotencyKey: key(),
              recommendationId: action.id,
              decision: "approve",
            }),
        },
      ],
    );
  };
  const openSettings = () => {
    if (!data) return;
    setForm(structuredClone(data.settings));
    formRevision.current = data.settingsRevision;
    setTime(
      `${String(data.settings.schedule.hour).padStart(2, "0")}:${String(data.settings.schedule.minute).padStart(2, "0")}`,
    );
    setDays([String(data.settings.staleConversationDays), String(data.settings.staleProjectDays)]);
    setEditing(true);
  };
  const save = () => {
    if (!form || !data) return;
    const match = /^(\d{1,2}):(\d{2})$/.exec(time);
    const conversationDays = Number(days[0]),
      projectDays = Number(days[1]);
    if (
      !match ||
      Number(match[1]) > 23 ||
      Number(match[2]) > 59 ||
      !Number.isInteger(conversationDays) ||
      conversationDays < 1 ||
      conversationDays > 365 ||
      !Number.isInteger(projectDays) ||
      projectDays < 1 ||
      projectDays > 730
    ) {
      Alert.alert(
        "Check your schedule",
        "Use HH:MM, 1–365 conversation days, and 1–730 project days.",
      );
      return;
    }
    void request({
      type: "settings.update",
      idempotencyKey: key(),
      expectedRevision: formRevision.current,
      settings: {
        ...form,
        staleConversationDays: conversationDays,
        staleProjectDays: projectDays,
        schedule: {
          ...form.schedule,
          hour: Number(match[1]),
          minute: Number(match[2]),
          timeZone: form.schedule.timeZone.trim(),
        },
      },
    });
  };
  const errors = error ?? pollError ?? data?.error;
  const errorView = errors ? (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="alert" style={styles.error}>
        {errors}
      </Text>
      {retry && (
        <View style={[styles.row, { flexWrap: "wrap" }]}>
          <Button disabled={busy} onPress={() => void request(retry)}>
            Retry request
          </Button>
          <Button
            disabled={busy}
            onPress={() => {
              setRetry(null);
              setError(null);
            }}
          >
            Dismiss error
          </Button>
        </View>
      )}
    </View>
  ) : null;
  const rows = useMemo(() => {
    const rows: ReviewRow[] = [];
    if (!data) return rows;
    for (const [title, cleanup] of [
      ["Needs your attention", false],
      ["Room to tidy up", true],
    ] as const) {
      const actions = data.recommendations.filter(
        (action) =>
          isCleanup(action) === cleanup && !["applied", "dismissed"].includes(action.status),
      );
      if (actions.length) rows.push({ type: "section", id: title, title, count: actions.length });
      rows.push(...actions.map((action): ReviewRow => ({ type: "action", id: action.id, action })));
    }
    if (!rows.length) rows.push({ type: "empty", id: "empty" });
    if (showHistory) {
      const done = data.recommendations.filter((action) =>
        ["applied", "dismissed"].includes(action.status),
      );
      if (done.length)
        rows.push({
          type: "section",
          id: "handled",
          title: "Recently handled",
          count: done.length,
        });
      rows.push(...done.map((action): ReviewRow => ({ type: "action", id: action.id, action })));
    }
    return rows;
  }, [data, showHistory]);
  const filteredModels = useMemo(
    () =>
      data?.models.filter((model) =>
        `${model.provider} ${model.model}`
          .toLowerCase()
          .includes((modelSearch ?? "").toLowerCase()),
      ) ?? [],
    [data?.models, modelSearch],
  );
  const messages = useMemo(() => (data?.messages ?? []).toReversed(), [data?.messages]);
  const renderAction = (action: LensRecommendation) => (
    <View style={lensStyles.action}>
      <View style={[styles.row, { alignItems: "flex-start" }]}>
        <View style={{ paddingTop: 4 }}>
          <Icon
            name={isCleanup(action) ? "archive-outline" : "chatbubble-ellipses-outline"}
            size={18}
            color={colors.muted}
          />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={lensStyles.caption}>{actionLabel(action)}</Text>
          <Text style={[styles.text, { fontWeight: "500" }]}>{action.title}</Text>
          <Text style={styles.muted} numberOfLines={2}>
            {action.reason}
          </Text>
          {action.reason.length > 160 && (
            <Pressable
              accessibilityRole="button"
              onPress={() => Alert.alert(action.title, action.reason)}
              style={{ paddingVertical: 8 }}
            >
              <Text style={lensStyles.link}>Read details</Text>
            </Pressable>
          )}
        </View>
      </View>
      {action.error && <Text style={styles.error}>{action.error}</Text>}
      {action.status === "pending" ? (
        <View style={[styles.row, { paddingLeft: 26, marginTop: 4 }]}>
          <Button
            disabled={blocked}
            onPress={() =>
              isCleanup(action)
                ? approve(action)
                : action.sourceId === "cloud"
                  ? onOpen(action.targetId)
                  : Alert.alert(
                      "On your desktop",
                      "Open this conversation on its original desktop to read or reply.",
                    )
            }
          >
            {isCleanup(action) ? "Review cleanup" : "Open conversation"}
          </Button>
          <Pressable
            accessibilityRole="button"
            disabled={blocked}
            onPress={() =>
              void request({
                type: "decide",
                idempotencyKey: key(),
                recommendationId: action.id,
                decision: "dismiss",
              })
            }
            style={{ padding: 12, opacity: blocked ? 0.4 : 1 }}
          >
            <Text style={styles.muted}>Dismiss</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={[styles.muted, { paddingLeft: 26 }]}>
          {
            {
              approved: "Approved · waiting for desktop",
              applied: "Done",
              stale: "Changed since review · review again",
              failed: "Could not apply · review again",
              dismissed: "Dismissed",
            }[action.status]
          }
        </Text>
      )}
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.row, { paddingHorizontal: 10, minHeight: 54 }]}>
        <IconButton name="albums-outline" label="Open conversations" onPress={onMenu} />
        <Text accessibilityRole="header" style={[styles.heading, { flex: 1, fontSize: 18 }]}>
          Lens
        </Text>
        <Button
          disabled={blocked}
          onPress={() => void request({ type: "sweep", idempotencyKey: key() })}
        >
          {data?.running ? "Reviewing…" : "Review now"}
        </Button>
        <IconButton
          name="options-outline"
          label="Lens schedule and model"
          disabled={!data || busy}
          onPress={openSettings}
        />
      </View>
      <View
        style={[
          styles.row,
          {
            paddingHorizontal: 20,
            gap: 22,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border,
          },
        ]}
      >
        {(["overview", "chat"] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === value }}
            onPress={() => setTab(value)}
            style={{
              paddingVertical: 12,
              borderBottomWidth: 2,
              borderBottomColor: tab === value ? colors.text : "transparent",
            }}
          >
            <Text
              style={{
                color: tab === value ? colors.text : colors.muted,
                fontSize: 14,
                fontWeight: "500",
              }}
            >
              {value === "overview" ? "Overview" : "Chat"}
            </Text>
          </Pressable>
        ))}
        {data?.running && <Text style={styles.muted}>Reviewing…</Text>}
      </View>
      {errors && <View style={{ padding: 16 }}>{errorView}</View>}
      {!data && !errors && (
        <ActivityIndicator
          accessibilityLabel="Loading Lens"
          color={colors.cyan}
          style={{ margin: 30 }}
        />
      )}
      {tab === "overview" ? (
        <FlatList<ReviewRow>
          key="review"
          data={rows}
          keyExtractor={(row) => row.id}
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={7}
          contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 32 }}
          ListHeaderComponent={
            data ? <Overview data={data} onDiscuss={() => setTab("chat")} /> : null
          }
          renderItem={({ item }) =>
            item.type === "action" ? (
              renderAction(item.action)
            ) : item.type === "section" ? (
              <View style={{ paddingTop: 26, gap: 4 }}>
                <Text accessibilityRole="header" style={[styles.text, { fontWeight: "600" }]}>
                  {item.title} <Text style={styles.muted}> {item.count}</Text>
                </Text>
                {item.title === "Room to tidy up" && (
                  <Text style={styles.muted}>Review each suggestion. You decide what goes.</Text>
                )}
              </View>
            ) : (
              <View style={{ alignItems: "center", paddingVertical: 36, gap: 10 }}>
                <Icon name="checkmark-circle-outline" color={colors.muted} size={28} />
                <Text style={styles.text}>
                  {data?.lastRunAt ? "You're all caught up." : "Ready when you are."}
                </Text>
                <Text style={[styles.muted, { textAlign: "center" }]}>
                  Run a review to find unread replies, follow-ups, and things to tidy up.
                </Text>
              </View>
            )
          }
          ListFooterComponent={
            data ? (
              <View style={{ paddingTop: 26, gap: 8 }}>
                <Text style={styles.muted}>
                  {data.nextRunAt
                    ? `Next review ${dateLabel(data.nextRunAt)} · local time`
                    : "Scheduled reviews are off"}
                </Text>
                <Text style={lensStyles.caption}>
                  {data.selectedModel
                    ? `${data.selectedModel.model}${data.settings.model ? "" : " · most used connected model"}`
                    : "Connect an AI account to start reviewing."}
                </Text>
                {data.sources.map((source) => (
                  <Text key={source.id} style={lensStyles.caption}>
                    {source.label} · synced {dateLabel(source.syncedAt)}
                  </Text>
                ))}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setShowHistory(!showHistory)}
                  style={{ paddingVertical: 12 }}
                >
                  <Text style={lensStyles.link}>
                    {showHistory ? "Hide handled" : "Recently handled"}
                  </Text>
                </Pressable>
              </View>
            ) : null
          }
        />
      ) : (
        <>
          <FlatList
            key="chat"
            data={messages}
            inverted={messages.length > 0}
            keyExtractor={(message) => message.id}
            initialNumToRender={6}
            maxToRenderPerBatch={4}
            windowSize={5}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: 22,
              paddingVertical: 16,
              ...(messages.length ? {} : { flexGrow: 1, justifyContent: "center" }),
            }}
            renderItem={({ item }) => <Message message={item} />}
            ListEmptyComponent={
              <View style={{ gap: 18 }}>
                <Icon name="aperture-outline" size={30} color={colors.cyan} />
                <Text style={[styles.heading, { fontSize: 26 }]}>Make sense of your week.</Text>
                <Text style={styles.muted}>
                  Ask about progress, loose ends, or what to clean up across your projects.
                </Text>
                {[
                  "What did I do this week?",
                  "What needs my attention?",
                  "What can I clean up?",
                ].map((message) => (
                  <Button
                    key={message}
                    disabled={blocked}
                    onPress={() => void request({ type: "chat", idempotencyKey: key(), message })}
                  >
                    {message}
                  </Button>
                ))}
              </View>
            }
          />
          {data?.running && (
            <Text style={[styles.muted, { paddingHorizontal: 22 }]}>Lens is thinking…</Text>
          )}
          <View
            style={[
              styles.row,
              {
                margin: 12,
                padding: 6,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.border,
                borderRadius: 16,
                backgroundColor: colors.input,
                alignItems: "flex-end",
              },
            ]}
          >
            <TextInput
              accessibilityLabel="Message Lens"
              placeholder="Ask Lens about your week…"
              placeholderTextColor={colors.muted}
              value={draft}
              onChangeText={setDraft}
              maxLength={16000}
              style={{
                flex: 1,
                minHeight: 44,
                maxHeight: 140,
                padding: 10,
                fontSize: 16,
                color: colors.text,
              }}
              multiline
            />
            <IconButton
              name="arrow-up-circle"
              label="Send message to Lens"
              disabled={blocked || !draft.trim()}
              onPress={send}
            />
          </View>
        </>
      )}
      {editing && form && (
        <Sheet
          title={modelSearch === null ? "Lens schedule & model" : "Lens model"}
          onClose={() => (modelSearch === null ? setEditing(false) : setModelSearch(null))}
        >
          {modelSearch === null ? (
            <>
              {errorView}
              <View style={styles.row}>
                <Text style={[styles.text, { flex: 1 }]}>Scheduled reviews</Text>
                <Switch
                  accessibilityLabel="Enable scheduled Lens reviews"
                  value={form.enabled}
                  onValueChange={(enabled) => setForm({ ...form, enabled })}
                />
              </View>
              <Text style={styles.muted}>
                Lens uses project titles and recent conversation excerpts from your connected
                workspaces for reviews. Cleanup always needs approval.
              </Text>
              <View style={styles.row}>
                {(["weekly", "daily"] as const).map((frequency) => (
                  <Button
                    key={frequency}
                    primary={form.schedule.frequency === frequency}
                    onPress={() => setForm({ ...form, schedule: { ...form.schedule, frequency } })}
                  >
                    {frequency === "weekly" ? "Weekly" : "Daily"}
                  </Button>
                ))}
              </View>
              {form.schedule.frequency === "weekly" && (
                <View style={[styles.row, { flexWrap: "wrap" }]}>
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, weekday) => (
                    <Button
                      key={day}
                      primary={form.schedule.weekday === weekday}
                      onPress={() => setForm({ ...form, schedule: { ...form.schedule, weekday } })}
                    >
                      {day}
                    </Button>
                  ))}
                </View>
              )}
              <Text style={styles.label}>Time (24 hour)</Text>
              <TextInput
                accessibilityLabel="Lens review time"
                value={time}
                onChangeText={setTime}
                style={styles.input}
                placeholder="09:00"
                placeholderTextColor={colors.muted}
              />
              <Text style={styles.label}>Time zone</Text>
              <TextInput
                accessibilityLabel="Lens time zone"
                value={form.schedule.timeZone}
                onChangeText={(timeZone) =>
                  setForm({ ...form, schedule: { ...form.schedule, timeZone } })
                }
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Africa/Lagos"
                placeholderTextColor={colors.muted}
              />
              {["Inactive conversation days", "Stale project days"].map((label, index) => (
                <View key={label}>
                  <Text style={styles.label}>{label}</Text>
                  <TextInput
                    accessibilityLabel={label}
                    value={days[index]}
                    onChangeText={(value) =>
                      setDays(days.map((entry, i) => (i === index ? value : entry)))
                    }
                    style={styles.input}
                    keyboardType="number-pad"
                  />
                </View>
              ))}
              <Text style={styles.label}>AI model</Text>
              <Button onPress={() => setModelSearch("")}>
                {form.model?.model ?? "Most used connected model"}
              </Button>
              <Button primary disabled={busy || !!retry} onPress={save}>
                Save settings
              </Button>
            </>
          ) : (
            <>
              <TextInput
                accessibilityLabel="Search Lens models"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Search models…"
                placeholderTextColor={colors.muted}
                value={modelSearch}
                onChangeText={setModelSearch}
                autoFocus
                style={styles.input}
              />
              {"most used connected model".includes(modelSearch.toLowerCase()) && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: form.model === null }}
                  onPress={() => {
                    setForm({ ...form, model: null });
                    setModelSearch(null);
                  }}
                  style={lensStyles.modelRow}
                >
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={styles.text}>Most used connected model</Text>
                    <Text style={styles.muted}>Choose automatically from your usage</Text>
                  </View>
                  {form.model === null && <Icon name="checkmark" color={colors.cyan} size={18} />}
                </Pressable>
              )}
              {filteredModels.map((model) => (
                <Pressable
                  key={`${model.provider}:${model.model}`}
                  accessibilityRole="button"
                  accessibilityState={{
                    selected:
                      form.model?.provider === model.provider && form.model.model === model.model,
                  }}
                  onPress={() => {
                    setForm({ ...form, model });
                    setModelSearch(null);
                  }}
                  style={lensStyles.modelRow}
                >
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={styles.text}>{model.model}</Text>
                    <Text style={styles.muted}>
                      {model.provider === "claude" ? "Claude" : "Codex"}
                    </Text>
                  </View>
                  {form.model?.provider === model.provider && form.model.model === model.model && (
                    <Icon name="checkmark" color={colors.cyan} size={18} />
                  )}
                </Pressable>
              ))}
              {!!data?.models.length &&
                filteredModels.length === 0 &&
                !"most used connected model".includes(modelSearch.toLowerCase()) && (
                  <Text style={styles.muted}>No models match your search.</Text>
                )}
              {!data?.models.length && (
                <Text style={styles.muted}>
                  Connect a Codex or Claude account to choose its models.
                </Text>
              )}
            </>
          )}
        </Sheet>
      )}
    </View>
  );
}

type ReviewRow =
  | { type: "section"; id: string; title: string; count: number }
  | { type: "action"; id: string; action: LensRecommendation }
  | { type: "empty"; id: string };
const isCleanup = (action: LensRecommendation) =>
  action.kind === "archive_conversation" || action.kind === "remove_project";
const actionLabel = (action: LensRecommendation) =>
  ({
    unread: "Unread reply",
    follow_up: "Waiting for you",
    archive_conversation: "Inactive conversation",
    remove_project: "Stale project",
  })[action.kind];
const markdownRules: RenderRules = {
  fence: (node, _children, _parent, style) =>
    (node as typeof node & { sourceInfo?: string }).sourceInfo?.trim() === "vitre-visual" ? (
      <Visual key={node.key} source={node.content} />
    ) : (
      <Text key={node.key} selectable style={style.fence}>
        {node.content}
      </Text>
    ),
};
const markdownStyle = { body: { color: colors.text, fontSize: 15, lineHeight: 24 } };
const Message = memo(
  function Message({ message }: { message: LensOverview["messages"][number] }) {
    return (
      <View style={{ paddingVertical: 16, gap: 6 }}>
        <Text style={lensStyles.caption}>{message.role === "user" ? "You" : "Lens"}</Text>
        <Markdown style={markdownStyle} rules={markdownRules}>
          {message.text}
        </Markdown>
      </View>
    );
  },
  (a, b) => a.message.id === b.message.id && a.message.text === b.message.text,
);
function Overview({ data, onDiscuss }: { data: LensOverview; onDiscuss: () => void }) {
  const count = (kind: LensRecommendation["kind"]) =>
    data.recommendations.filter((action) => action.kind === kind && action.status === "pending")
      .length;
  const maximum = Math.max(1, ...data.activity.map((day) => day.conversations));
  const active = data.activity.reduce((sum, day) => sum + day.conversations, 0);
  const summary = data.messages
    .findLast((message) => message.role === "assistant")
    ?.text.split("```")[0]
    ?.split("\n\n")[0]
    ?.replaceAll("**", "")
    .slice(0, 320);
  return (
    <View style={{ gap: 22, paddingTop: 28, paddingBottom: 8 }}>
      <View style={{ gap: 8 }}>
        <Text style={[lensStyles.caption, { letterSpacing: 1 }]}>ACROSS YOUR WORKSPACE</Text>
        <Text style={[styles.heading, { fontSize: 28, letterSpacing: -0.6 }]}>
          Your week, in focus.
        </Text>
        <Text style={styles.muted}>
          {data.lastRunAt
            ? `Last reviewed ${dateLabel(data.lastRunAt)}`
            : "A little perspective on what needs you next."}
        </Text>
      </View>
      <View style={[styles.row, { alignItems: "flex-start" }]}>
        {[
          [count("unread"), "Unread replies"],
          [count("follow_up"), "Waiting for you"],
          [count("archive_conversation") + count("remove_project"), "To tidy up"],
        ].map(([value, label]) => (
          <View key={label} style={{ flex: 1, gap: 9 }}>
            <Text style={lensStyles.caption}>{label}</Text>
            <Text style={{ fontSize: 32, fontWeight: "600", color: colors.text }}>{value}</Text>
          </View>
        ))}
      </View>
      <View style={[styles.row, { gap: 16 }]}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={styles.muted}>{active} recent conversations</Text>
          <Text style={lensStyles.caption}>Last activity · 7 days, UTC</Text>
        </View>
        <View
          accessible
          accessibilityLabel={data.activity
            .map((day) => `${day.date}: ${day.conversations}`)
            .join(", ")}
          style={{ width: 110, height: 32, flexDirection: "row", alignItems: "flex-end", gap: 5 }}
        >
          {data.activity.map((day) => (
            <View
              key={day.date}
              style={{
                flex: 1,
                height: 3 + (29 * day.conversations) / maximum,
                borderRadius: 2,
                backgroundColor: day.conversations ? colors.cyan : colors.border,
              }}
            />
          ))}
        </View>
      </View>
      {summary && (
        <View style={{ borderLeftWidth: 2, borderLeftColor: colors.cyan, paddingLeft: 14, gap: 8 }}>
          <Text style={[styles.text, { fontSize: 15 }]}>{summary}</Text>
          <Pressable accessibilityRole="button" onPress={onDiscuss} style={{ paddingVertical: 8 }}>
            <Text style={lensStyles.link}>Discuss with Lens →</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
const lensStyles = StyleSheet.create({
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  caption: { fontSize: 12, lineHeight: 18, color: colors.muted },
  link: { fontSize: 13, color: colors.text, fontWeight: "500" },
  action: {
    paddingVertical: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 8,
  },
});
