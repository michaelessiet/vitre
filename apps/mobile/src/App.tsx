import { Lens } from "./Lens";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import * as ExpoLinking from "expo-linking";
import { ClerkProvider, useAuth, useSSO } from "@clerk/expo";
import { useSignIn } from "@clerk/expo/legacy";
import { tokenCache } from "@clerk/expo/token-cache";
import { makeShowcaseClient } from "./showcase";
import { useCloudNotifications } from "./notifications";
import { Conversation } from "./Conversation";
import { NewConversation } from "./NewConversation";
import { busyTask, relativeTime, taskStatus } from "./cloudState";
import { useCloud, type MobileCloud } from "./useCloud";
import { Button, colors, Icon, IconButton, Sheet, styles } from "./ui";
import { useReducedMotion } from "./motion";

WebBrowser.maybeCompleteAuthSession();
const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
const origin = process.env.EXPO_PUBLIC_CLOUD_URL;
const relayJwtTemplate = process.env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE || "t3-relay";

function ConversationDrawer({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const drawerWidth = Math.min(width * 0.82, 480);

  useEffect(() => {
    if (reducedMotion) {
      progress.stopAnimation();
      progress.setValue(visible ? 1 : 0);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 230 : 180,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [visible, reducedMotion, progress]);

  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "yes" : "no-hide-descendants"}
      style={{ position: "absolute", inset: 0, flexDirection: "row" }}
    >
      <Animated.View style={{ flex: 1, opacity: progress }}>
        <Pressable
          accessibilityLabel="Close conversation drawer"
          style={{ flex: 1, backgroundColor: "#0009" }}
          onPress={onClose}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal={visible}
        style={{
          width: drawerWidth,
          backgroundColor: "#252525",
          borderTopLeftRadius: 19,
          paddingTop: 8,
          transform: [
            {
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [drawerWidth, 0],
              }),
            },
          ],
        }}
      >
        {children}
      </Animated.View>
    </View>
  );
}

function SignIn() {
  const { startSSOFlow } = useSSO();
  const { isLoaded, signIn, setActive } = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [factor, setFactor] = useState<"email_code" | "totp" | null>(null);
  const [second, setSecond] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const login = async (strategy?: "oauth_github" | "oauth_google") => {
    if (!isLoaded) return;
    setBusy(true);
    setError(null);
    try {
      if (strategy) {
        const result = await startSSOFlow({
          strategy,
          redirectUrl: ExpoLinking.createURL("auth/callback"),
        });
        if (result.createdSessionId) await result.setActive?.({ session: result.createdSessionId });
        else if (result.authSessionResult?.type === "success")
          throw new Error(
            "Finish signing in with your existing Vitre account. Additional verification may be required.",
          );
      } else {
        const result = factor
          ? second
            ? await signIn.attemptSecondFactor({ strategy: factor, code })
            : await signIn.attemptFirstFactor({ strategy: "email_code", code })
          : await signIn.create({ identifier: email.trim(), ...(password ? { password } : {}) });
        if (result.status === "complete") await setActive({ session: result.createdSessionId });
        else if (result.status === "needs_second_factor") {
          if (result.supportedSecondFactors?.some((factor) => factor.strategy === "totp")) {
            setSecond(true);
            setFactor("totp");
          } else {
            const supported = result.supportedSecondFactors?.find(
              (factor) => factor.strategy === "email_code",
            );
            if (!supported || !("emailAddressId" in supported))
              throw new Error(
                "Use your account's supported sign-in method to finish verification.",
              );
            await signIn.prepareSecondFactor({
              strategy: "email_code",
              emailAddressId: supported.emailAddressId,
            });
            setSecond(true);
            setFactor("email_code");
          }
        } else if (result.status === "needs_first_factor") {
          const supported = result.supportedFirstFactors?.find(
            (factor) => factor.strategy === "email_code",
          );
          if (!supported || !("emailAddressId" in supported))
            throw new Error("Enter your password or use a connected sign-in provider.");
          await signIn.prepareFirstFactor({
            strategy: "email_code",
            emailAddressId: supported.emailAddressId,
          });
          setFactor("email_code");
        } else
          throw new Error(
            "This sign-in needs an additional step. Complete it through your existing Vitre account.",
          );
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Sign-in failed. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 28, gap: 14 }}
        >
          <Icon name="cloud-outline" size={43} color={colors.cyan} />
          <Text style={{ color: colors.text, fontSize: 36, fontWeight: "600", marginTop: 12 }}>
            Vitre
          </Text>
          <Text style={[styles.muted, { fontSize: 16, lineHeight: 24, marginBottom: 22 }]}>
            Your conversations, wherever you are.
          </Text>
          {factor ? (
            <>
              <Text style={styles.text}>
                {factor === "totp"
                  ? "Enter your authenticator code"
                  : "Enter the code sent to your email"}
              </Text>
              <TextInput
                accessibilityLabel="Verification code"
                style={styles.input}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                autoComplete="one-time-code"
              />
            </>
          ) : (
            <>
              <TextInput
                accessibilityLabel="Email"
                placeholder="Email"
                placeholderTextColor={colors.dim}
                style={styles.input}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                value={email}
                onChangeText={setEmail}
              />
              <TextInput
                accessibilityLabel="Password"
                placeholder="Password (or continue with email code)"
                placeholderTextColor={colors.dim}
                style={styles.input}
                secureTextEntry
                autoComplete="current-password"
                value={password}
                onChangeText={setPassword}
              />
            </>
          )}
          <Button
            primary
            disabled={busy || !isLoaded || (!factor && !email.trim())}
            onPress={() => {
              void login();
            }}
          >
            {busy ? "Signing in…" : factor ? "Verify" : "Sign in"}
          </Button>
          {!factor && (
            <>
              <Button
                disabled={busy}
                onPress={() => {
                  void login("oauth_github");
                }}
              >
                Continue with GitHub
              </Button>
              <Button
                disabled={busy}
                onPress={() => {
                  void login("oauth_google");
                }}
              >
                Continue with Google
              </Button>
            </>
          )}
          {error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          <Text style={[styles.muted, { marginTop: 18 }]}>
            Sign in with the account you already use for Vitre Cloud.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function CloudScreen({
  cloud,
  onSignOut,
  preview = false,
  startInLens = false,
  notifications,
}: {
  cloud: MobileCloud;
  onSignOut: () => Promise<void>;
  preview?: boolean;
  startInLens?: boolean;
  notifications?: ReturnType<typeof useCloudNotifications>;
}) {
  const [drawer, setDrawer] = useState(!startInLens && !cloud.selectedId);
  const [lensOpen, setLensOpen] = useState(startInLens);
  useEffect(() => {
    if (cloud.selectedId) setLensOpen(false);
  }, [cloud.selectedId]);
  const [newConversation, setNewConversation] = useState<{ project?: string } | null>(null);
  const [settings, setSettings] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [filter, setFilter] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const deleteRequest = useRef<{
    type: "project.delete";
    projectId: string;
    expectedRevision: number;
    idempotencyKey: string;
  } | null>(null);
  const deleteProject = () => {
    const project = cloud.overview?.projects?.find((project) => project.id === projectMenu);
    if (!project || deletingProject) return;
    const count = cloud.overview?.tasks.filter((task) => task.projectId === project.id).length ?? 0;
    Alert.alert(
      `Delete ${project.title}?`,
      `Delete this saved cloud project and its ${count} cloud conversation${count === 1 ? "" : "s"}? Running work will stop and saved snapshots will no longer be available. Your GitHub repository and desktop files will not be deleted.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete project",
          style: "destructive",
          onPress: () => {
            if (
              deleteRequest.current?.projectId !== project.id ||
              deleteRequest.current.expectedRevision !== project.revision
            )
              deleteRequest.current = {
                type: "project.delete",
                projectId: project.id,
                expectedRevision: project.revision,
                idempotencyKey: Crypto.randomUUID(),
              };
            setDeletingProject(true);
            setProjectError(null);
            void cloud
              .command(deleteRequest.current)
              .then((result) => {
                if (
                  cloud.selectedId &&
                  !result.overview.tasks.some((task) => task.id === cloud.selectedId)
                )
                  cloud.select(null);
                deleteRequest.current = null;
                setProjectMenu(null);
              })
              .catch((error: unknown) => {
                setProjectError(
                  error instanceof Error ? error.message : "Could not delete project. Retry.",
                );
                void cloud.refresh().catch(() => {});
              })
              .finally(() => setDeletingProject(false));
          },
        },
      ],
    );
  };
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const groups = useMemo(() => {
    const groups = new Map<
      string,
      { title: string; tasks: NonNullable<typeof cloud.overview>["tasks"][number][] }
    >();
    for (const project of cloud.overview?.projects ?? [])
      groups.set(project.id, { title: project.title, tasks: [] });
    for (const task of cloud.overview?.tasks ?? []) {
      const id = task.projectId ?? task.repository.id;
      if (!groups.has(id)) groups.set(id, { title: task.repository.name, tasks: [] });
      if (
        (!filter || busyTask(task)) &&
        `${task.title ?? task.prompt} ${task.repository.name}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
        groups.get(id)!.tasks.push(task);
    }
    return [...groups]
      .filter(([, group]) => (!query && !filter) || group.tasks.length)
      .sort(([, a], [, b]) => a.title.localeCompare(b.title))
      .map(([id, group]) => ({
        id,
        ...group,
        tasks: group.tasks.sort((a, b) =>
          sort === "recent"
            ? b.updatedAt.localeCompare(a.updatedAt)
            : (a.title ?? a.prompt).localeCompare(b.title ?? b.prompt),
        ),
      }));
  }, [cloud.overview, query, filter, sort]);
  useEffect(() => {
    const open = (url: string) => {
      const match = /^vitre:\/\/(?:cloud\/)?conversations\/([a-zA-Z0-9_-]{1,128})(?:[?#].*)?$/.exec(
        url,
      );
      if (match?.[1]) {
        cloud.select(match[1]);
        setDrawer(false);
      }
    };
    void Linking.getInitialURL().then((url) => {
      if (url) open(url);
    });
    const subscription = Linking.addEventListener("url", ({ url }) => open(url));
    return () => subscription.remove();
  }, [cloud.select]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (drawer) {
        setDrawer(false);
        return true;
      }
      if (lensOpen) {
        setLensOpen(false);
        setDrawer(true);
        return true;
      }
      if (cloud.selectedId) {
        cloud.select(null);
        setDrawer(true);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [drawer, lensOpen, cloud.selectedId, cloud.select]);
  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      {/* Expo StatusBar uses a named appearance, not a React Native style object. */}
      {/* oxlint-disable-next-line react/style-prop-object */}
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {preview && (
          <Text style={{ textAlign: "center", color: colors.cyan, fontSize: 11, padding: 4 }}>
            Interface preview · sample conversations
          </Text>
        )}
        {lensOpen ? (
          <Lens
            cloud={cloud}
            onMenu={() => setDrawer(true)}
            onOpen={(id) => {
              cloud.select(id);
              setLensOpen(false);
            }}
          />
        ) : cloud.task ? (
          <Conversation
            key={cloud.task.id}
            cloud={cloud}
            task={cloud.task}
            onMenu={() => setDrawer(true)}
          />
        ) : (
          <View style={{ flex: 1, padding: 24 }}>
            <View style={[styles.row, { justifyContent: "space-between" }]}>
              <Text style={styles.heading}>Vitre</Text>
              <IconButton
                name="albums-outline"
                label="Open conversations"
                onPress={() => setDrawer(true)}
              />
            </View>
            <View style={{ flex: 1, justifyContent: "center", gap: 17 }}>
              <Icon name="chatbubbles-outline" size={38} color={colors.cyan} />
              <Text style={{ fontSize: 29, color: colors.text, fontWeight: "600" }}>
                Pick up where you left off.
              </Text>
              <Text style={styles.muted}>
                {cloud.selectedId
                  ? "This conversation may have been removed or moved. Choose another from your projects."
                  : "Check in, chat, and keep work moving on your cloud conversations."}
              </Text>
              <Button primary onPress={() => setNewConversation({})}>
                New cloud conversation
              </Button>
              <Button onPress={() => setDrawer(true)}>Browse conversations</Button>
              {!cloud.overview && !cloud.error && <ActivityIndicator color={colors.cyan} />}
              {cloud.error && <Text style={styles.error}>{cloud.error}</Text>}
            </View>
          </View>
        )}
        <ConversationDrawer visible={drawer} onClose={() => setDrawer(false)}>
          <View style={[styles.row, { paddingHorizontal: 5, gap: 0 }]}>
            <IconButton name="close" label="Close drawer" onPress={() => setDrawer(false)} />
            <View
              style={[
                styles.row,
                {
                  backgroundColor: "#1f1f1f",
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 10,
                  paddingHorizontal: 10,
                  height: 40,
                  flex: 1,
                },
              ]}
            >
              <Icon name="search" size={17} />
              <TextInput
                accessibilityLabel="Search conversations"
                placeholder="Search threads"
                placeholderTextColor={colors.text}
                value={query}
                onChangeText={setQuery}
                style={{ color: colors.text, fontSize: 15, flex: 1 }}
              />
            </View>
            <IconButton
              name="swap-vertical"
              label={`Sort by ${sort === "recent" ? "name" : "recent"}`}
              onPress={() => setSort(sort === "recent" ? "name" : "recent")}
            />
            <IconButton
              name={filter ? "filter" : "filter-outline"}
              label={filter ? "Show all conversations" : "Show active conversations"}
              onPress={() => setFilter(!filter)}
            />
          </View>
          <View style={{ paddingHorizontal: 15, paddingTop: 12, paddingBottom: 6 }}>
            <Button
              onPress={() => {
                setDrawer(false);
                setNewConversation({});
                setLensOpen(false);
              }}
            >
              ＋ New conversation
            </Button>
          </View>
          <View style={{ paddingHorizontal: 15, paddingBottom: 6 }}>
            <Button
              onPress={() => {
                cloud.select(null);
                setLensOpen(true);
                setDrawer(false);
              }}
            >
              Lens
            </Button>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 25 }}
          >
            {groups.map((group) => (
              <View key={group.id} style={{ marginTop: 18 }}>
                <View style={styles.row}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${collapsed.has(group.id) ? "Expand" : "Collapse"} ${group.title}`}
                    style={[styles.row, { flex: 1, minHeight: 44, paddingLeft: 5 }]}
                    onPress={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      })
                    }
                  >
                    <Icon
                      name={collapsed.has(group.id) ? "chevron-forward" : "chevron-down"}
                      color={colors.dim}
                      size={15}
                    />
                    <View
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 6,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "#293c52",
                      }}
                    >
                      <Text style={{ color: "#9ac7f0", fontSize: 12, fontWeight: "600" }}>
                        {group.title.slice(0, 2).toUpperCase()}
                      </Text>
                    </View>
                    <Text style={{ color: colors.text, fontSize: 17, fontWeight: "600", flex: 1 }}>
                      {group.title}
                    </Text>
                    <Text style={styles.muted}>{group.tasks.length}</Text>
                  </Pressable>
                  <IconButton
                    name="ellipsis-horizontal"
                    label={`${group.title} project menu`}
                    onPress={() => setProjectMenu(group.id)}
                  />
                </View>
                {!collapsed.has(group.id) &&
                  group.tasks.map((task) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${task.title ?? task.prompt}, ${taskStatus(task)}`}
                      key={task.id}
                      onPress={() => {
                        cloud.select(task.id);
                        setLensOpen(false);
                        setDrawer(false);
                      }}
                      style={[
                        styles.row,
                        {
                          minHeight: 50,
                          borderRadius: 10,
                          paddingHorizontal: 12,
                          gap: 8,
                          backgroundColor: cloud.selectedId === task.id ? "#3b3b3b" : "transparent",
                          marginTop: 1,
                        },
                      ]}
                    >
                      {cloud.selectedId === task.id && (
                        <View
                          style={{
                            position: "absolute",
                            left: 0,
                            top: 12,
                            bottom: 12,
                            width: 2,
                            borderRadius: 2,
                            backgroundColor: colors.blue,
                          }}
                        />
                      )}
                      {busyTask(task) && (
                        <View
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: 4,
                            backgroundColor: colors.cyan,
                          }}
                        />
                      )}
                      <Text numberOfLines={1} style={{ color: colors.text, fontSize: 16, flex: 1 }}>
                        {task.title ?? task.prompt}
                      </Text>
                      <Text style={{ color: colors.dim, fontSize: 13 }}>
                        {relativeTime(task.updatedAt)}
                      </Text>
                    </Pressable>
                  ))}
              </View>
            ))}
            {!groups.length && (
              <Text style={[styles.muted, { padding: 15 }]}>No matching conversations.</Text>
            )}
          </ScrollView>
          <View
            style={{
              borderTopColor: "#353535",
              borderTopWidth: 1,
              paddingHorizontal: 17,
              paddingBottom: 12,
            }}
          >
            <Pressable
              accessibilityRole="button"
              onPress={() => setSettings(true)}
              style={[styles.row, { minHeight: 54 }]}
            >
              <Icon name="settings-outline" />
              <Text style={styles.text}>Settings</Text>
            </Pressable>
            <View style={styles.row}>
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: cloud.online && !cloud.error ? colors.green : colors.dim,
                }}
              />
              <Text style={styles.muted}>
                Cloud workspace · {cloud.online && !cloud.error ? "connected" : "offline"}
              </Text>
            </View>
          </View>
        </ConversationDrawer>
        {newConversation && (
          <NewConversation
            cloud={cloud}
            initialProject={newConversation.project}
            onClose={() => setNewConversation(null)}
          />
        )}
        {projectMenu && (
          <Sheet
            title={
              cloud.overview?.projects?.find((project) => project.id === projectMenu)?.title ??
              "Project"
            }
            onClose={() => {
              if (!deletingProject) {
                setProjectMenu(null);
                setProjectError(null);
              }
            }}
          >
            <Button
              disabled={
                !cloud.overview?.capabilities?.projectCreation ||
                !cloud.overview.projects?.find((project) => project.id === projectMenu)
                  ?.latestSnapshot
              }
              onPress={() => {
                setNewConversation({ project: projectMenu });
                setProjectMenu(null);
                setDrawer(false);
              }}
            >
              New cloud conversation
            </Button>
            <Button
              disabled={
                deletingProject ||
                !cloud.online ||
                !cloud.overview?.capabilities?.projectDeletion ||
                !cloud.overview.projects?.some((project) => project.id === projectMenu)
              }
              onPress={deleteProject}
              style={{ borderColor: colors.red }}
            >
              {deletingProject ? "Deleting…" : "Delete cloud project"}
            </Button>
            {projectError && (
              <Text accessibilityRole="alert" style={styles.error}>
                {projectError}
              </Text>
            )}
            {!cloud.overview?.capabilities?.projectDeletion && (
              <Text style={styles.muted}>
                Update the cloud deployment to delete saved projects.
              </Text>
            )}
            {!cloud.overview?.capabilities?.projectCreation && (
              <Text style={styles.muted}>
                Update your cloud deployment to create conversations from saved projects.
              </Text>
            )}
          </Sheet>
        )}
        {settings && (
          <Sheet title="Settings" onClose={() => setSettings(false)}>
            <Text style={styles.heading}>Vitre Cloud</Text>
            <Text style={styles.muted}>
              Cloud conversations continue when your computer is closed.
            </Text>
            <Text style={styles.label}>Provider accounts</Text>
            {cloud.overview?.accounts.map((account) => (
              <Text key={account.provider} style={styles.text}>
                {account.provider === "codex" ? "Codex" : "Claude"} ·{" "}
                {account.state.replaceAll("_", " ")}
              </Text>
            ))}
            <Text style={styles.muted}>
              Manage provider subscriptions in Vitre on your computer.
            </Text>
            <Text style={styles.label}>GitHub accounts</Text>
            <Text style={styles.muted}>
              Connect personal and work GitHub accounts for repository access. Use your existing
              Vitre sign-in to access these connections on desktop and mobile.
            </Text>
            {cloud.overview?.githubAccounts?.map((account) => (
              <Text key={account.id} style={styles.text}>
                @{account.login} · {account.state === "connected" ? "Connected" : "Needs sign-in"}
              </Text>
            ))}
            {cloud.overview?.githubManageUrl && (
              <Button
                onPress={async () => {
                  try {
                    await WebBrowser.openBrowserAsync(cloud.overview!.githubManageUrl!);
                    await cloud.command({
                      type: "github.refresh",
                      idempotencyKey: Crypto.randomUUID(),
                    });
                  } catch (error) {
                    Alert.alert(
                      "GitHub accounts",
                      error instanceof Error
                        ? error.message
                        : "Could not refresh accounts. Try again.",
                    );
                  }
                }}
              >
                Manage GitHub accounts
              </Button>
            )}
            {cloud.overview?.githubManageUrl && (
              <Button
                onPress={async () => {
                  try {
                    await cloud.command({
                      type: "github.refresh",
                      idempotencyKey: Crypto.randomUUID(),
                    });
                  } catch (error) {
                    Alert.alert(
                      "GitHub accounts",
                      error instanceof Error
                        ? error.message
                        : "Could not refresh accounts. Try again.",
                    );
                  }
                }}
              >
                Refresh GitHub accounts
              </Button>
            )}
            <Text style={styles.label}>Notifications</Text>
            <Text style={styles.muted}>Get notified when work finishes or needs your input.</Text>
            {notifications && (
              <Button
                onPress={() => {
                  void (
                    notifications.enabled ? notifications.disable() : notifications.enable()
                  ).catch((error: Error) => setSettingsError(error.message));
                }}
              >
                {notifications.enabled ? "Disable notifications" : "Enable notifications"}
              </Button>
            )}
            {notifications?.error && <Text style={styles.error}>{notifications.error}</Text>}
            <Text style={styles.label}>Offline storage</Text>
            <Text style={styles.muted}>
              Saved conversations and drafts stay on this device. Messages are sent only when you
              tap Send while online.
            </Text>
            {settingsError && <Text style={styles.error}>{settingsError}</Text>}
            <Button
              onPress={() => {
                void onSignOut().catch((error: unknown) =>
                  setSettingsError(error instanceof Error ? error.message : "Could not sign out"),
                );
              }}
            >
              Sign out and clear local data
            </Button>
          </Sheet>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Account() {
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useAuth();
  if (!isLoaded)
    return (
      <View style={[styles.screen, { justifyContent: "center" }]}>
        <ActivityIndicator color={colors.cyan} />
      </View>
    );
  if (!isSignedIn || !userId) return <SignIn />;
  return (
    <SignedIn
      key={userId}
      accountId={userId}
      getToken={() => getToken({ template: relayJwtTemplate })}
      signOut={signOut}
    />
  );
}
function SignedIn({
  accountId,
  getToken,
  signOut,
}: {
  accountId: string;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
}) {
  const cloud = useCloud(origin!, accountId, getToken);
  const notifications = useCloudNotifications(
    cloud.client,
    cloud.storage,
    accountId,
    cloud.selectedId,
    cloud.select,
    cloud.overview?.capabilities?.mobileNotifications === true,
  );
  return (
    <CloudScreen
      cloud={cloud}
      notifications={notifications}
      onSignOut={async () => {
        await notifications.unregister().catch(() => {
          /* Offline sign-out still clears this device. Push content is generic and account-scoped. */
        });
        cloud.live.current?.dispose();
        await cloud.storage.clear();
        await signOut();
      }}
    />
  );
}
function Showcase() {
  const client = useMemo(makeShowcaseClient, []);
  const startInLens = process.env.EXPO_PUBLIC_SHOWCASE_LENS === "1";
  const cloud = useCloud(
    "https://preview.invalid",
    startInLens ? "lens-preview" : "preview",
    async () => null,
    client,
  );
  return (
    <CloudScreen
      preview
      startInLens={startInLens}
      cloud={cloud}
      onSignOut={async () => {
        await cloud.storage.clear();
      }}
    />
  );
}
export default function App() {
  const validOrigin = (() => {
    try {
      const url = new URL(origin ?? "");
      return (
        url.protocol === "https:" &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  })();
  return (
    <SafeAreaProvider>
      {__DEV__ && process.env.EXPO_PUBLIC_SHOWCASE === "1" ? (
        <Showcase />
      ) : publishableKey && validOrigin ? (
        <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
          <Account />
        </ClerkProvider>
      ) : (
        <SafeAreaView style={[styles.screen, { padding: 26, justifyContent: "center", gap: 18 }]}>
          <Icon name="cloud-outline" color={colors.cyan} size={40} />
          <Text style={styles.heading}>Connect this build to Vitre</Text>
          <Text style={styles.text}>
            This build needs its cloud deployment and sign-in configuration.
          </Text>
          <Text style={styles.muted}>
            Set EXPO_PUBLIC_CLOUD_URL and EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY in
            apps/mobile/.env.local, then rebuild.
          </Text>
        </SafeAreaView>
      )}
    </SafeAreaProvider>
  );
}
