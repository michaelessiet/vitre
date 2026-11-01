import { expect, it } from "@effect/vitest";
import { proxyChain } from "alchemy/Util/proxy-chain";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";
import { CloudStore, emptyDocument, layer } from "./store.ts";

it.effect("returns runnable Effects when the database is a request-bound query proxy", () => {
  const rows = [{ userId: "owner", revision: 7, document: emptyDocument() }];
  const query = Object.assign(Effect.succeed(rows), {
    where: () => ({ limit: () => Effect.succeed(rows) }),
  });
  const database = proxyChain(Effect.succeed({ select: () => ({ from: () => query }) }));
  return Effect.gen(function* () {
    const store = yield* CloudStore;
    const read = store.read("owner");
    // A raw query proxy works with yield*, but hangs when a runtime evaluates
    // it as an Effect directly (including the GitHub Promise adapter).
    expect(Effect.isEffect(read)).toBe(true);
    expect(Effect.isEffect(store.users)).toBe(true);
    const fiber = yield* Effect.forkChild(read);
    expect((yield* Fiber.join(fiber)).state.revision).toBe(7);
    expect(yield* store.users).toEqual(["owner"]);
  }).pipe(
    Effect.provide(
      layer.pipe(Layer.provide(Layer.succeed(RelayDb, database as unknown as RelayDb["Service"]))),
    ),
  );
});
