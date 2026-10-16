import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { documentationLayer } from "./documentation.ts";

it.effect("serves static documentation across independently scoped requests", () =>
  Effect.gen(function* () {
    for (const path of ["/docs", "/openapi.json", "/v1/cloud/openapi.json", "/docs"]) {
      const response = yield* Effect.scoped(
        HttpRouter.toHttpEffect(documentationLayer).pipe(
          Effect.flatMap((handler) => handler),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request(`https://relay.test${path}`)),
          ),
        ),
      );
      expect(response.status).toBe(200);
      const web = HttpServerResponse.toWeb(response);
      if (path === "/docs") {
        const html = yield* Effect.promise(() => web.text());
        expect(html).toContain("api-reference");
        expect(html).toContain("Vitre");
      } else {
        const spec = yield* Effect.promise(() => web.json());
        expect(spec).toHaveProperty("openapi");
        expect(spec).toHaveProperty("paths");
      }
    }
  }),
);
