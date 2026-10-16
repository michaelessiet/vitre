import { StackActions, useNavigation } from "@react-navigation/native";
import { CloudClientError } from "@t3tools/client-runtime/cloud";
import type { CloudProvider, CloudRepository } from "@t3tools/contracts/cloud";
import type { RuntimeMode } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { uuidv4 } from "../../lib/uuid";
import { useVitreCloud } from "./useVitreCloud";

function githubIdentity(value: string): { owner: string; name: string } | null {
  const match =
    /^(?:https:\/\/github\.com\/)?([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      value.trim(),
    );
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

interface CreateAttempt {
  readonly accountId: string;
  readonly key: string;
  readonly repositoryInput: string;
  readonly prompt: string;
  readonly provider: CloudProvider;
  readonly permission: RuntimeMode;
  repository: CloudRepository | null;
  repositorySaved: boolean;
}

export function VitreCloudNewScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const colorScheme = useColorScheme();
  const {
    client,
    accountId,
    overview,
    verified,
    error: connectionError,
    refresh,
  } = useVitreCloud();
  const [repositoryInput, setRepositoryInput] = useState("");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<CloudProvider>("codex");
  const [permission, setPermission] = useState<RuntimeMode>("approval-required");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [heldAttempt, setHeldAttempt] = useState<CreateAttempt | null>(null);
  const attemptRef = useRef<CreateAttempt | null>(null);
  const submittingRef = useRef(false);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  useEffect(() => {
    attemptRef.current = null;
    submittingRef.current = false;
    setHeldAttempt(null);
    setSubmitting(false);
    setError(null);
  }, [accountId]);
  const repositories = useMemo(
    () =>
      overview?.repositories.filter(
        (item) => item.id !== "local" && item.installationId !== "local",
      ) ?? [],
    [overview],
  );
  const providerAccount = overview?.accounts.find((item) => item.provider === provider);

  async function create() {
    if (
      !client ||
      !accountId ||
      !verified ||
      connectionError ||
      submittingRef.current ||
      providerAccount?.state !== "connected"
    )
      return;
    const previous = attemptRef.current;
    const identity = githubIdentity(previous?.repositoryInput ?? repositoryInput);
    if (!identity) {
      setError("Enter a GitHub repository as owner/name or its URL.");
      return;
    }
    if (!previous && !prompt.trim()) return;
    const attempt: CreateAttempt = previous ?? {
      accountId,
      key: uuidv4(),
      repositoryInput: repositoryInput.trim(),
      prompt: prompt.trim(),
      provider,
      permission,
      repository: null,
      repositorySaved: false,
    };
    if (attempt.accountId !== accountId) return;
    attemptRef.current = attempt;
    setHeldAttempt(attempt);
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      let repository: CloudRepository | undefined =
        attempt.repository ??
        repositories.find(
          (item) =>
            item.owner.toLowerCase() === identity.owner.toLowerCase() &&
            item.name.toLowerCase() === identity.name.toLowerCase(),
        );
      if (repository && !attempt.repository) {
        attempt.repository = repository;
        attempt.repositorySaved = true;
      }
      if (!repository) {
        const publicRepository = await client.publicRepository(identity.owner, identity.name);
        if (accountRef.current !== attempt.accountId || attemptRef.current !== attempt) return;
        if (!publicRepository)
          throw new CloudClientError(
            404,
            "repository_unavailable",
            "Repository is private or unavailable. Connect GitHub access on desktop first.",
            "rejected",
          );
        repository = publicRepository;
        attempt.repository = repository;
      }
      if (!attempt.repositorySaved) {
        await client.command({
          type: "repository.save",
          idempotencyKey: `${attempt.key}-repository`,
          repository,
        });
        if (accountRef.current !== attempt.accountId || attemptRef.current !== attempt) return;
        attempt.repositorySaved = true;
      }
      if (accountRef.current !== attempt.accountId || attemptRef.current !== attempt) return;
      attempt.repository = repository;
      const result = await client.command({
        type: "task.create",
        idempotencyKey: attempt.key,
        repositoryId: repository.id,
        baseBranch: repository.defaultBranch,
        provider: attempt.provider,
        kind: "build",
        prompt: attempt.prompt,
        issueNumber: null,
        runtimeMode: attempt.permission,
        keepAliveSeconds: 900,
      });
      if (accountRef.current !== attempt.accountId || attemptRef.current !== attempt) return;
      attemptRef.current = null;
      navigation.dispatch(StackActions.replace("VitreCloudTask", { taskId: result.entityId }));
    } catch (cause) {
      if (accountRef.current !== attempt.accountId || attemptRef.current !== attempt) return;
      if (cause instanceof CloudClientError && cause.requestDisposition === "rejected") {
        attemptRef.current = null;
        setHeldAttempt(null);
      }
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not confirm whether the cloud conversation started",
      );
    } finally {
      if (accountRef.current === attempt.accountId && attemptRef.current === attempt) {
        submittingRef.current = false;
        setSubmitting(false);
      } else if (accountRef.current === attempt.accountId && attemptRef.current === null) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  return (
    <View
      className="flex-1 bg-screen"
      style={{
        paddingTop: insets.top,
        backgroundColor: colorScheme === "light" ? "#f7f7f8" : "#252525",
      }}
    >
      <View className="flex-row items-center gap-4 px-5 py-4">
        <Pressable accessibilityLabel="Back to cloud projects" onPress={() => navigation.goBack()}>
          <SymbolView name="chevron.left" size={21} tintColor={iconColor} />
        </Pressable>
        <Text className="font-t3-bold text-xl">New cloud conversation</Text>
      </View>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 30,
          gap: 18,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {!client ? (
          <View className="rounded-2xl border border-input-border bg-subtle p-4">
            <Text className="font-t3-bold">Sign in to start a cloud conversation</Text>
            <Text className="mt-1 text-sm text-foreground-muted">
              Use the same account as Vitre on your computer.
            </Text>
            <Pressable
              className="mt-3 self-start rounded-xl bg-blue-600 px-4 py-2"
              onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
            >
              <Text className="font-t3-bold text-white">Sign in</Text>
            </Pressable>
          </View>
        ) : null}
        {client && connectionError ? (
          <View className="rounded-2xl bg-subtle p-4">
            <Text className="text-sm text-foreground-muted">
              Disconnected · check the cloud connection before starting.
            </Text>
            <Pressable className="mt-2 self-start" onPress={() => void refresh()}>
              <Text className="text-blue-400">Retry connection</Text>
            </Pressable>
          </View>
        ) : null}
        <View className="gap-2">
          <Text className="font-t3-bold text-sm">GitHub project</Text>
          <TextInput
            accessibilityLabel="GitHub repository"
            editable={!heldAttempt}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="owner/repository or GitHub URL"
            value={repositoryInput}
            onChangeText={setRepositoryInput}
          />
          <Text className="text-xs text-foreground-muted">
            Public repositories work without installing the GitHub App. Connected private
            repositories are also available.
          </Text>
        </View>
        {repositories.length > 0 ? (
          <View className="gap-2">
            <Text className="font-t3-bold text-sm">Your projects</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {repositories.map((item) => (
                  <Pressable
                    key={item.id}
                    disabled={!!heldAttempt}
                    className="rounded-full border border-input-border bg-subtle px-3 py-2"
                    onPress={() => setRepositoryInput(`${item.owner}/${item.name}`)}
                  >
                    <Text className="text-sm">
                      {item.owner}/{item.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          </View>
        ) : null}
        <View className="gap-2">
          <Text className="font-t3-bold text-sm">What should Vitre do?</Text>
          <TextInput
            accessibilityLabel="Cloud task prompt"
            editable={!heldAttempt}
            multiline
            className="min-h-36"
            placeholder="Describe the work…"
            textAlignVertical="top"
            value={prompt}
            onChangeText={setPrompt}
          />
        </View>
        <View className="gap-2">
          <Text className="font-t3-bold text-sm">Provider</Text>
          <View className="flex-row gap-2">
            {(["codex", "claude"] as const).map((value) => (
              <Pressable
                key={value}
                disabled={!!heldAttempt}
                className={`rounded-full px-4 py-2 ${provider === value ? "bg-blue-600" : "bg-subtle"}`}
                onPress={() => setProvider(value)}
              >
                <Text className={provider === value ? "text-white" : ""}>
                  {value === "codex" ? "Codex" : "Claude"}
                </Text>
              </Pressable>
            ))}
          </View>
          {client && providerAccount?.state !== "connected" ? (
            providerAccount?.state === "usage_limited" ? (
              <Text className="text-sm text-amber-400">Usage limit reached for this provider.</Text>
            ) : provider === "codex" ? (
              <Pressable
                className="self-start"
                onPress={() => navigation.navigate("VitreCloudLogin")}
              >
                <Text className="text-sm text-blue-400">Connect Codex before starting</Text>
              </Pressable>
            ) : (
              <Text className="text-sm text-foreground-muted">
                Connect Claude in Vitre on your computer before starting.
              </Text>
            )
          ) : null}
        </View>
        <View className="gap-2">
          <Text className="font-t3-bold text-sm">Permissions</Text>
          <View className="flex-row gap-2">
            {(
              [
                { value: "approval-required", label: "Supervised" },
                { value: "full-access", label: "Full access" },
              ] as const
            ).map((item) => (
              <Pressable
                key={item.value}
                disabled={!!heldAttempt}
                className={`rounded-full px-4 py-2 ${permission === item.value ? "bg-blue-600" : "bg-subtle"}`}
                onPress={() => setPermission(item.value)}
              >
                <Text className={permission === item.value ? "text-white" : ""}>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        {error ? <Text className="text-rose-400">{error}</Text> : null}
        {heldAttempt && !submitting ? (
          <Text className="text-xs text-foreground-muted">
            Retry keeps the original project, prompt, provider, and permissions.
          </Text>
        ) : null}
        <Pressable
          accessibilityLabel="Start cloud conversation"
          disabled={
            submitting ||
            !client ||
            !verified ||
            !!connectionError ||
            (!heldAttempt && !prompt.trim()) ||
            providerAccount?.state !== "connected"
          }
          className="min-h-13 items-center justify-center rounded-2xl bg-blue-600 disabled:opacity-50"
          onPress={() => void create()}
        >
          {submitting ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text className="font-t3-bold text-white">
              {heldAttempt ? "Retry original request" : "Start in cloud"}
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}
