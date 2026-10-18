import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ConnectionPersistenceError,
  EnvironmentCacheStore,
} from "@t3tools/client-runtime/platform";
import { OrchestrationThreadDetailSnapshot, ServerConfig } from "@t3tools/contracts";

/** Account and deployment scope every cache, draft and pending request. Tokens use SecureStore. */
export function accountStorage(origin: string, accountId: string) {
  const prefix = `vitre.mobile.v1:${encodeURIComponent(origin)}:${encodeURIComponent(accountId)}:`;
  let active = true;
  let writes = Promise.resolve();
  return {
    async get<T>(key: string): Promise<T | null> {
      const value = await AsyncStorage.getItem(prefix + key);
      if (!active || value === null) return null;
      try {
        return JSON.parse(value) as T;
      } catch {
        return null;
      }
    },
    set(key: string, value: unknown) {
      writes = writes
        .catch(() => {})
        .then(async () => {
          if (!active) return;
          if (value === null) await AsyncStorage.removeItem(prefix + key);
          else await AsyncStorage.setItem(prefix + key, JSON.stringify(value));
        });
      return writes;
    },
    async clear() {
      active = false;
      await writes.catch(() => {});
      const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix));
      await AsyncStorage.multiRemove(keys);
    },
  };
}
export type AccountStorage = ReturnType<typeof accountStorage>;
export function environmentCache(storage: AccountStorage) {
  const read = <A>(key: string, schema: Schema.Decoder<A>) =>
    Effect.tryPromise({
      try: async () => {
        const data = await storage.get(key);
        return data === null ? Option.none<A>() : Schema.decodeUnknownOption(schema)(data);
      },
      catch: () =>
        new ConnectionPersistenceError({
          operation: "load-thread",
          message: "Could not read the offline cache",
        }),
    });
  const write = (key: string, data: unknown) =>
    Effect.tryPromise({
      try: () => storage.set(key, data),
      catch: () =>
        new ConnectionPersistenceError({
          operation: "save-thread",
          message: "Could not save the offline cache",
        }),
    });
  return EnvironmentCacheStore.of({
    loadThread: (env, thread) => read(`thread:${env}:${thread}`, OrchestrationThreadDetailSnapshot),
    saveThread: (env, snapshot) => write(`thread:${env}:${snapshot.thread.id}`, snapshot),
    removeThread: (env, thread) => write(`thread:${env}:${thread}`, null),
    loadServerConfig: () => read("models", ServerConfig),
    saveServerConfig: (_env, config) => write("models", config),
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
}
