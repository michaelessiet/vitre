import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { cloudTaskStatus } from "./mobileCloudState";
import { useVitreCloud } from "./useVitreCloud";

export function VitreCloudHomeScreen() {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const colorScheme = useColorScheme();
  const [query, setQuery] = useState("");
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const { accountId, overview, error, refresh } = useVitreCloud(undefined, focused);
  const groups = useMemo(() => {
    const map = new Map<string, NonNullable<typeof overview>["tasks"]>();
    for (const task of overview?.tasks ?? []) {
      if (task.archivedAt) continue;
      const project = `${task.repository.owner}/${task.repository.name}`;
      if (!`${project} ${task.title ?? task.prompt}`.toLowerCase().includes(query.toLowerCase()))
        continue;
      map.set(project, [...(map.get(project) ?? []), task]);
    }
    return [...map]
      .map(([project, tasks]) => ({
        project,
        tasks: [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      }))
      .sort((a, b) => (b.tasks[0]?.updatedAt ?? "").localeCompare(a.tasks[0]?.updatedAt ?? ""));
  }, [overview, query]);
  const codexAccount = overview?.accounts.find((item) => item.provider === "codex");

  return (
    <View
      className="flex-1 bg-screen"
      style={{
        paddingTop: insets.top,
        backgroundColor: colorScheme === "light" ? "#f7f7f8" : "#252525",
      }}
    >
      <View className="flex-row items-center justify-between px-5 py-4">
        <Pressable accessibilityLabel="Back to threads" onPress={() => navigation.goBack()}>
          <SymbolView name="chevron.left" size={21} tintColor={iconColor} />
        </Pressable>
        <Text className="font-t3-bold text-lg">Vitre Cloud</Text>
        <Pressable
          accessibilityLabel="New cloud conversation"
          onPress={() => navigation.navigate("VitreCloudNew")}
        >
          <SymbolView name="square.and.pencil" size={21} tintColor={iconColor} />
        </Pressable>
      </View>
      <View className="mx-4 mb-3 flex-row items-center gap-3 rounded-2xl border border-input-border bg-input px-4">
        <SymbolView name="magnifyingglass" size={18} tintColor={iconColor} />
        <TextInput
          accessibilityLabel="Search cloud threads"
          className="min-h-12 flex-1 border-0 bg-transparent px-0"
          placeholder="Search threads"
          value={query}
          onChangeText={setQuery}
        />
      </View>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: insets.bottom + 28 }}
        refreshControl={
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={() => {
              setPullRefreshing(true);
              void refresh().finally(() => setPullRefreshing(false));
            }}
          />
        }
      >
        {error && overview ? (
          <View className="mx-4 mb-4 flex-row items-center justify-between gap-3 rounded-2xl bg-subtle p-4">
            <Text className="flex-1 text-sm text-foreground-muted">
              Disconnected · showing saved projects
            </Text>
            <Pressable onPress={() => void refresh()}>
              <Text className="text-sm text-blue-400">Retry</Text>
            </Pressable>
          </View>
        ) : null}
        {accountId && overview && codexAccount?.state !== "connected" ? (
          <View className="mx-4 mb-4 rounded-2xl bg-subtle p-4">
            <Text className="font-t3-bold">
              {codexAccount?.state === "usage_limited"
                ? "Codex usage limit reached"
                : "Codex needs sign-in"}
            </Text>
            <Text className="mt-1 text-sm text-foreground-muted">
              {codexAccount?.state === "usage_limited"
                ? "New Codex turns are unavailable until the account limit resets."
                : "Connect Codex to work on cloud conversations from this phone."}
            </Text>
            {codexAccount?.state !== "usage_limited" ? (
              <Pressable
                className="mt-3 self-start rounded-xl bg-blue-600 px-4 py-2"
                onPress={() => navigation.navigate("VitreCloudLogin")}
              >
                <Text className="font-t3-bold text-white">Connect Codex</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {!accountId ? (
          <View className="px-6 py-10">
            <Text className="font-t3-bold text-lg">Sign in to open your cloud projects</Text>
            <Text className="mt-2 text-foreground-muted">
              Use the same account as Vitre on your computer.
            </Text>
            <Pressable
              className="mt-5 self-start rounded-xl bg-blue-600 px-4 py-3"
              onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
            >
              <Text className="font-t3-bold text-white">Sign in</Text>
            </Pressable>
          </View>
        ) : error && !overview ? (
          <View className="px-6 py-10">
            <Text className="font-t3-bold text-lg">Could not load cloud projects</Text>
            <Text className="mt-2 text-foreground-muted">{error}</Text>
            <Pressable
              className="mt-5 self-start rounded-xl bg-subtle px-4 py-3"
              onPress={() => void refresh()}
            >
              <Text>Retry</Text>
            </Pressable>
          </View>
        ) : !overview ? (
          <ActivityIndicator className="mt-12" />
        ) : groups.length === 0 ? (
          <View className="px-6 py-10">
            <Text className="font-t3-bold text-lg">
              {query ? "No matching threads" : "No cloud conversations yet"}
            </Text>
            {!query ? (
              <Text className="mt-2 text-foreground-muted">
                Start one in any public GitHub repository or a repository you have connected.
              </Text>
            ) : null}
          </View>
        ) : (
          groups.map(({ project, tasks }) => (
            <View key={project} className="mb-6">
              <View className="flex-row items-center justify-between px-6 py-3">
                <View className="flex-row items-center gap-3">
                  <View className="size-8 items-center justify-center rounded-lg bg-blue-900/70">
                    <Text className="font-t3-bold text-xs text-blue-200">
                      {project.split("/")[1]?.slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                  <Text className="font-t3-bold text-base">{project}</Text>
                </View>
                <Text className="text-sm text-foreground-muted">{tasks.length}</Text>
              </View>
              {tasks.map((task) => (
                <Pressable
                  key={task.id}
                  accessibilityLabel={`Open ${task.title ?? task.prompt}`}
                  className="mx-3 min-h-17 flex-row items-center gap-3 rounded-xl px-4 py-3 active:bg-subtle"
                  onPress={() => navigation.navigate("VitreCloudTask", { taskId: task.id })}
                >
                  <View
                    className={`size-2 rounded-full ${["running", "preparing", "queued"].includes(task.state) && !task.idle ? "bg-sky-400" : task.state === "failed" ? "bg-rose-400" : "bg-transparent"}`}
                  />
                  <View className="flex-1">
                    <Text numberOfLines={1} className="font-t3-medium text-base">
                      {task.title ?? task.prompt}
                    </Text>
                    <Text numberOfLines={1} className="mt-1 text-xs text-foreground-muted">
                      {cloudTaskStatus(task)} · Cloud:{" "}
                      {task.repository.installationId === "local" ? "Local" : "GitHub"}
                    </Text>
                  </View>
                  <Text className="text-xs text-foreground-muted">
                    {relativeTime(task.updatedAt)}
                  </Text>
                </Pressable>
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
