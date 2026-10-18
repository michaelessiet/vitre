import { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import Constants from "expo-constants";
import type { CloudClient } from "@t3tools/client-runtime/cloud";
import type { AccountStorage } from "./storage";

const deviceKey = "vitre.mobile.device.v2";
async function deviceId() {
  let id = await SecureStore.getItemAsync(deviceKey);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(deviceKey, id);
  }
  return id;
}
export function notificationTask(data: Record<string, unknown>, accountId: string): string | null {
  return data.version === 2 &&
    data.accountId === accountId &&
    typeof data.taskId === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(data.taskId)
    ? data.taskId
    : null;
}
export function useCloudNotifications(
  client: CloudClient,
  storage: AccountStorage,
  accountId: string,
  activeTask: string | null,
  select: (taskId: string) => void,
  available: boolean,
) {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(activeTask);
  active.current = activeTask;
  const handled = useRef(new Set<string>());
  const projectId =
    Constants.easConfig?.projectId ??
    (Constants.expoConfig?.extra?.eas?.projectId as string | undefined);
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const register = async (ask: boolean) => {
    if (!projectId)
      throw new Error("Push notifications need this build’s EAS project and push credentials.");
    if (!available) throw new Error("Update your cloud deployment to enable mobile notifications.");
    if (Platform.OS === "android")
      await Notifications.setNotificationChannelAsync("conversations", {
        name: "Cloud conversations",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    const permissions = ask
      ? await Notifications.requestPermissionsAsync()
      : await Notifications.getPermissionsAsync();
    if (!permissions.granted)
      throw new Error("Allow notifications in your phone’s settings to receive cloud updates.");
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    await client.registerMobileDevice({
      version: 2,
      deviceId: await deviceId(),
      platform,
      token: token.data,
    });
    await storage.set("notifications-enabled", true);
    setEnabled(true);
  };
  const disable = async () => {
    await client.registerMobileDevice({
      version: 2,
      deviceId: await deviceId(),
      platform,
      token: null,
    });
    await storage.set("notifications-enabled", false);
    setEnabled(false);
  };
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      if (!(await storage.get<boolean>("notifications-enabled")) || cancelled) return;
      setEnabled(true);
      await register(false).catch((error: unknown) => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : "Could not refresh notifications");
      });
    };
    void sync();
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    const tokens = Notifications.addPushTokenListener(() => {
      void sync();
    });
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const data = response.notification.request.content.data ?? {};
      const task = notificationTask(data, accountId);
      const id =
        typeof data.eventId === "string" ? data.eventId : response.notification.request.identifier;
      if (task && !handled.current.has(id)) {
        handled.current.add(id);
        select(task);
      }
    };
    const responses = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then(open);
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const task = notificationTask(notification.request.content.data ?? {}, accountId);
        const show = task !== null && task !== active.current;
        return {
          shouldShowBanner: show,
          shouldShowList: show,
          shouldPlaySound: false,
          shouldSetBadge: false,
        };
      },
    });
    return () => {
      cancelled = true;
      app.remove();
      tokens.remove();
      responses.remove();
      Notifications.setNotificationHandler(null);
    };
  }, [client, storage, accountId, available]);
  return {
    enabled,
    error,
    available: !!projectId && available,
    enable: async () => {
      setError(null);
      try {
        await register(true);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Could not enable notifications");
      }
    },
    disable,
    unregister: async () => {
      if (await storage.get<boolean>("notifications-enabled")) await disable();
    },
  };
}
