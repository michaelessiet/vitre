import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import { CloudClientError } from "@t3tools/client-runtime/cloud";
import type { CloudProjectSnapshot, CloudRepository } from "@t3tools/contracts/cloud";
import { Composer, defaultSettings, type ComposerSettings } from "./Composer";
import { uploadAttachments, type LocalAttachment } from "./attachments";
import { createConversation, resolveRepository, type PendingCreation } from "./creation";
import type { MobileCloud } from "./useCloud";
import { Button, colors, Icon, Sheet, styles } from "./ui";

interface Draft {
  source: "github" | "project";
  url: string;
  branch: string;
  projectId: string;
  snapshotId: string;
  prompt: string;
  settings: ComposerSettings;
  attachments: LocalAttachment[];
}
export function NewConversation({
  cloud,
  initialProject,
  onClose,
}: {
  cloud: MobileCloud;
  initialProject?: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    source: initialProject ? "project" : "github",
    url: "",
    branch: "",
    projectId: initialProject ?? "",
    snapshotId: "",
    prompt: "",
    settings: defaultSettings,
    attachments: [],
  });
  const [loaded, setLoaded] = useState(false);
  const [githubAccountId, setGitHubAccountId] = useState<string>();
  const [repository, setRepository] = useState<CloudRepository | null>(null);
  const [snapshots, setSnapshots] = useState<readonly CloudProjectSnapshot[]>([]);
  const [pending, setPending] = useState<PendingCreation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }));
  const project = cloud.overview?.projects?.find((project) => project.id === draft.projectId);
  const selected =
    snapshots.find(
      (snapshot) => snapshot.id === (draft.snapshotId || project?.latestSnapshot?.id),
    ) ?? (draft.snapshotId ? undefined : project?.latestSnapshot);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      cloud.storage.get<Draft>("new-draft"),
      cloud.storage.get<PendingCreation>("pending-creation"),
    ]).then(([saved, request]) => {
      if (cancelled) return;
      if (saved && !initialProject) setDraft(saved);
      if (request) setPending(request);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [cloud.storage, initialProject]);
  useEffect(() => {
    if (loaded) void cloud.storage.set("new-draft", draft);
  }, [draft, loaded, cloud.storage]);
  useEffect(() => {
    let cancelled = false;
    setSnapshots([]);
    if (draft.projectId && cloud.overview?.capabilities?.projectCreation)
      void cloud.client
        .projectSnapshots(draft.projectId)
        .then((snapshots) => {
          if (!cancelled) setSnapshots(snapshots);
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setError(error instanceof Error ? error.message : "Could not load saved workspaces");
        });
    return () => {
      cancelled = true;
    };
  }, [draft.projectId, cloud.client, cloud.overview?.capabilities?.projectCreation]);
  const resolve = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await resolveRepository(
        cloud.client,
        draft.url,
        cloud.overview?.repositories ?? [],
        githubAccountId,
      );
      setRepository(found);
      patch({ branch: found.defaultBranch });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not resolve repository");
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!cloud.online || busy || !loaded) return;
    setBusy(true);
    setError(null);
    let request = pending;
    try {
      if (!request) {
        if (!draft.prompt.trim()) throw new Error("Enter a prompt to start the conversation.");
        const attachments = await uploadAttachments(cloud.client, draft.attachments);
        const { model, ...otherSettings } = draft.settings;
        const settings = { ...otherSettings, ...(model ? { model } : {}), attachments };
        const idempotencyKey = Crypto.randomUUID();
        if (draft.source === "project") {
          if (!selected) throw new Error("Choose an available saved workspace.");
          request = {
            command: {
              type: "task.createFromProject",
              idempotencyKey,
              projectId: draft.projectId,
              snapshotId: selected.id,
              prompt: draft.prompt.trim(),
              ...settings,
            },
          };
        } else {
          if (!repository || !draft.branch.trim())
            throw new Error("Resolve the repository and select a base branch first.");
          request = {
            registration: {
              type: "repository.save",
              idempotencyKey: Crypto.randomUUID(),
              repository,
            },
            command: {
              type: "task.create",
              idempotencyKey,
              repositoryId: repository.id,
              baseBranch: draft.branch.trim(),
              prompt: draft.prompt.trim(),
              kind: "build",
              issueNumber: null,
              ...settings,
            },
          };
        }
        setPending(request);
      }
      const result = await createConversation(cloud.client, cloud.storage, request);
      cloud.accept(result.overview);
      cloud.select(result.entityId);
      onClose();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Creation was interrupted. Retry to check the same request.",
      );
      if (error instanceof CloudClientError && error.requestDisposition === "rejected") {
        // Registration may have succeeded. Keep its receipt while correcting only
        // a definitively rejected creation. Refresh repository revision before retry.
        setPending(null);
        await cloud.storage.set("pending-creation", null);
        const refreshed = await cloud.client.overview().catch(() => null);
        if (refreshed) {
          cloud.accept(refreshed);
          setRepository((previous) =>
            previous
              ? (refreshed.repositories.find((repo) => repo.id === previous.id) ?? previous)
              : previous,
          );
        }
      }
    } finally {
      setBusy(false);
    }
  };
  const locked = !!pending || busy;
  return (
    <Sheet title="New cloud conversation" onClose={onClose}>
      {pending ? (
        <View style={styles.card}>
          <Text style={styles.text}>A creation request is pending.</Text>
          <Text style={styles.muted}>
            Retry to recover the same conversation. Its source, snapshot, and settings are pinned.
          </Text>
          <Button
            primary
            disabled={busy || !cloud.online}
            onPress={() => {
              void start();
            }}
          >
            Check and retry
          </Button>
        </View>
      ) : (
        <>
          <View style={styles.row}>
            <Button
              primary={draft.source === "github"}
              disabled={locked}
              style={{ flex: 1 }}
              onPress={() => patch({ source: "github" })}
            >
              GitHub repository
            </Button>
            <Button
              primary={draft.source === "project"}
              disabled={locked}
              style={{ flex: 1 }}
              onPress={() => patch({ source: "project" })}
            >
              Cloud project
            </Button>
          </View>
          {draft.source === "github" ? (
            <>
              <Text style={styles.label}>Repository URL or owner/repo</Text>
              <TextInput
                style={styles.input}
                accessibilityLabel="GitHub repository"
                placeholder="https://github.com/owner/repo"
                placeholderTextColor={colors.dim}
                autoCapitalize="none"
                autoCorrect={false}
                value={draft.url}
                editable={!locked}
                onChangeText={(url) => {
                  patch({ url });
                  setRepository(null);
                }}
              />
              {!!cloud.overview?.githubAccounts?.length && (
                <>
                  <Text style={styles.label}>GitHub account</Text>
                  <Button
                    disabled={locked}
                    primary={!githubAccountId}
                    onPress={() => {
                      setGitHubAccountId(undefined);
                      setRepository(null);
                    }}
                  >
                    Saved account or public access
                  </Button>
                  {cloud.overview.githubAccounts.map((account) => (
                    <Button
                      key={account.id}
                      disabled={locked || account.state !== "connected"}
                      primary={githubAccountId === account.id}
                      onPress={() => {
                        setGitHubAccountId(account.id);
                        setRepository(null);
                      }}
                    >
                      @{account.login}
                    </Button>
                  ))}
                </>
              )}
              <Button
                disabled={locked || !draft.url || !cloud.online}
                onPress={() => {
                  void resolve();
                }}
              >
                Find repository
              </Button>
              {repository && (
                <>
                  <Text style={styles.muted}>
                    {repository.owner}/{repository.name} ·{" "}
                    {repository.installationId === "public"
                      ? "Public repository"
                      : repository.githubAccountId
                        ? `@${cloud.overview?.githubAccounts?.find((account) => account.id === repository.githubAccountId)?.login ?? "Linked GitHub account"}`
                        : "Deployment access"}
                  </Text>
                  <Text style={styles.label}>Base branch</Text>
                  <TextInput
                    accessibilityLabel="Base branch"
                    style={styles.input}
                    value={draft.branch}
                    onChangeText={(branch) => patch({ branch })}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!locked}
                  />
                </>
              )}
              <Text style={styles.muted}>
                Public repositories need no prior setup. Private repositories use your account’s
                existing GitHub connection.
              </Text>
            </>
          ) : (
            <>
              {!cloud.overview?.capabilities?.projectCreation ? (
                <Text style={styles.error}>
                  Update your cloud deployment to create conversations from saved projects.
                </Text>
              ) : (
                <>
                  <Text style={styles.label}>Previously hoisted projects</Text>
                  {!cloud.overview.projects?.length && (
                    <Text style={styles.muted}>
                      No saved cloud projects yet. Hoist a project from Vitre on your computer once,
                      then use it here from anywhere.
                    </Text>
                  )}
                  {cloud.overview.projects?.map((item) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Choose ${item.title}`}
                      key={item.id}
                      disabled={locked || !item.latestSnapshot}
                      onPress={() => patch({ projectId: item.id, snapshotId: "" })}
                      style={[
                        styles.card,
                        styles.row,
                        item.id === draft.projectId && { borderColor: colors.blue, borderWidth: 1 },
                      ]}
                    >
                      <Icon
                        name="folder-outline"
                        color={item.latestSnapshot ? colors.text : colors.dim}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.text}>{item.title}</Text>
                        <Text style={styles.muted}>
                          {item.latestSnapshot
                            ? item.repository
                              ? `${item.repository.owner}/${item.repository.name}`
                              : "Uploaded project"
                            : "Temporarily unavailable · waiting for a verified saved workspace"}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                  {selected && (
                    <View style={styles.card}>
                      <Text style={styles.text}>Copy saved workspace</Text>
                      <Text style={styles.muted}>{selected.sourceTitle}</Text>
                      <Text style={styles.muted}>
                        {selected.branch ?? selected.baseBranch} ·{" "}
                        {new Date(selected.savedAt).toLocaleString()}
                      </Text>
                      <Text style={styles.muted}>
                        {selected.roots.length > 1
                          ? `${selected.roots.length} workspace roots · `
                          : ""}
                        Fresh conversation and an independent workspace.
                      </Text>
                      {cloud.overview.tasks.some(
                        (task) =>
                          task.id === selected.sourceTaskId &&
                          task.state === "running" &&
                          !task.idle,
                      ) && (
                        <Text style={{ color: colors.cyan, fontSize: 13 }}>
                          Source is working. This uses its last verified saved snapshot.
                        </Text>
                      )}
                      {!selected.workspace && (
                        <Text style={styles.muted}>
                          This older checkpoint will be prepared in the cloud. Progress appears in
                          the conversation.
                        </Text>
                      )}
                    </View>
                  )}
                  {snapshots.length > 1 && (
                    <>
                      <Text style={styles.label}>Choose a saved snapshot</Text>
                      {snapshots.map((snapshot) => (
                        <Button
                          key={snapshot.id}
                          primary={snapshot.id === selected?.id}
                          disabled={locked}
                          onPress={() => patch({ snapshotId: snapshot.id })}
                        >
                          {snapshot.sourceTitle} · {new Date(snapshot.savedAt).toLocaleString()}
                        </Button>
                      ))}
                    </>
                  )}
                </>
              )}
            </>
          )}
          <Text style={styles.label}>What would you like to work on?</Text>
          <Composer
            text={draft.prompt}
            onText={(prompt) => patch({ prompt })}
            settings={draft.settings}
            onSettings={(settings) => patch({ settings })}
            config={cloud.config}
            attachments={draft.attachments}
            onAttachments={(attachments) => patch({ attachments })}
            onSend={() => {
              void start();
            }}
            disabled={
              locked ||
              !loaded ||
              !cloud.online ||
              (draft.source === "github" ? !repository : !selected)
            }
          />
        </>
      )}
      {busy && (
        <View style={styles.row}>
          <ActivityIndicator color={colors.cyan} />
          <Text style={styles.muted}>
            {pending ? "Starting cloud conversation…" : "Preparing…"}
          </Text>
        </View>
      )}
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {!cloud.online && (
        <Text style={styles.muted}>
          Offline · Your draft is saved. Send when you’re back online.
        </Text>
      )}
    </Sheet>
  );
}
