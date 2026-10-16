import { useIsFocused, useNavigation } from "@react-navigation/native";
import { CloudLoginStatus } from "@t3tools/contracts/cloud";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { uuidv4 } from "../../lib/uuid";
import { useVitreCloud } from "./useVitreCloud";

const activeLogins = new Map<string, string>();

export function VitreCloudLoginScreen() {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const colorScheme = useColorScheme();
  const { client, accountId, overview, refresh } = useVitreCloud(undefined, focused);
  const [login, setLogin] = useState<{ accountId: string; id: string } | null>(null);
  const [statusState, setStatusState] = useState<{
    accountId: string;
    id: string;
    value: typeof CloudLoginStatus.Type;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loginId = accountId
    ? login?.accountId === accountId
      ? login.id
      : (activeLogins.get(accountId) ?? null)
    : null;
  const status =
    statusState?.accountId === accountId && statusState.id === loginId ? statusState.value : null;
  const connected = overview?.accounts.some(
    (item) => item.provider === "codex" && item.state === "connected",
  );

  const poll = useCallback(async () => {
    if (!client || !accountId || !loginId) return null;
    return client.loginStatus(loginId);
  }, [accountId, client, loginId]);

  useEffect(() => {
    if (!focused || !loginId || !client) return;
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      if (stopped || inFlight) return;
      if (timer) clearTimeout(timer);
      timer = null;
      inFlight = true;
      try {
        const next = await poll();
        if (stopped || !next || !accountId || !loginId) return;
        setStatusState({ accountId, id: loginId, value: next });
        if (next.state === "completed") {
          activeLogins.delete(accountId);
          void refresh();
        }
        if (next.state === "failed") activeLogins.delete(accountId);
        if (!stopped && next && (next.state === "starting" || next.state === "running")) {
          timer = setTimeout(check, 1500);
        }
      } catch (cause) {
        if (!stopped) {
          setError(cause instanceof Error ? cause.message : "Could not check Codex sign-in");
          timer = setTimeout(check, 3000);
        }
      } finally {
        inFlight = false;
      }
    };
    void check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [accountId, client, focused, loginId, poll, refresh]);

  async function start() {
    if (!client || !accountId || starting) return;
    setStarting(true);
    setError(null);
    try {
      const value = await client.startCodexLogin(uuidv4());
      activeLogins.set(accountId, value.id);
      setStatusState(null);
      setLogin({ accountId, id: value.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start Codex sign-in");
    } finally {
      setStarting(false);
    }
  }

  async function openVerification() {
    if (!status?.verificationUrl) return;
    try {
      const url = new URL(status.verificationUrl);
      if (url.protocol !== "https:") throw new Error("Invalid sign-in address");
      await Linking.openURL(url.toString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open sign-in page");
    }
  }

  return (
    <View
      className="flex-1 px-5"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        backgroundColor: colorScheme === "light" ? "#f7f7f8" : "#252525",
      }}
    >
      <View className="flex-row items-center gap-4 py-4">
        <Pressable accessibilityLabel="Back to cloud projects" onPress={() => navigation.goBack()}>
          <SymbolView name="chevron.left" size={21} tintColor={iconColor} />
        </Pressable>
        <Text className="font-t3-bold text-xl">Connect Codex</Text>
      </View>
      <Text className="mt-6 text-foreground-muted">
        Sign in to Codex to start or continue cloud conversations from your phone.
      </Text>
      {connected || status?.state === "completed" ? (
        <View className="mt-6 rounded-2xl bg-subtle p-5">
          <Text className="font-t3-bold text-emerald-400">Codex connected</Text>
          <Pressable className="mt-4 self-start" onPress={() => navigation.goBack()}>
            <Text className="text-blue-400">Return to Vitre Cloud</Text>
          </Pressable>
        </View>
      ) : (
        <View className="mt-6 gap-4 rounded-2xl bg-subtle p-5">
          {status?.userCode && status.state !== "failed" ? (
            <>
              <Text className="text-xs text-foreground-muted">
                Enter this code on the sign-in page
              </Text>
              <Pressable
                accessibilityLabel="Copy Codex sign-in code"
                onPress={() => void Clipboard.setStringAsync(status.userCode!)}
              >
                <Text selectable className="font-mono text-3xl tracking-widest">
                  {status.userCode}
                </Text>
              </Pressable>
              <Pressable
                className="self-start rounded-xl bg-blue-600 px-4 py-3"
                onPress={() => void openVerification()}
              >
                <Text className="font-t3-bold text-white">Open sign-in page</Text>
              </Pressable>
              <Text className="text-xs text-foreground-muted">
                Vitre will connect automatically when you finish sign-in.
              </Text>
            </>
          ) : loginId && status?.state !== "failed" ? (
            <View className="flex-row items-center gap-3">
              <ActivityIndicator />
              <Text>Preparing Codex sign-in…</Text>
            </View>
          ) : (
            <Pressable
              className="self-start rounded-xl bg-blue-600 px-4 py-3"
              disabled={starting || !client}
              onPress={() => void start()}
            >
              <Text className="font-t3-bold text-white">
                {starting ? "Starting…" : "Start Codex sign-in"}
              </Text>
            </Pressable>
          )}
          {status?.error ? <Text className="text-rose-400">{status.error}</Text> : null}
        </View>
      )}
      {error ? <Text className="mt-4 text-rose-400">{error}</Text> : null}
    </View>
  );
}
