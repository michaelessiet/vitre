import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import { RelayApi } from "@t3tools/contracts/relay";
import { CloudApi } from "../cloud/api.ts";

// These handlers contain only immutable schema/documentation data. Compiling
// them outside the request avoids rebuilding Scalar's embedded JS and serializing
// the specifications on every poll. No request services or credentials are cached.
const documentation = Effect.runSync(
  Effect.scoped(HttpRouter.toHttpEffect(HttpApiScalar.layer(RelayApi, { path: "/docs" }))),
);

export const documentationLayer = Layer.mergeAll(
  HttpRouter.add("GET", "/docs", documentation),
  HttpRouter.add(
    "GET",
    "/openapi.json",
    Effect.succeed(HttpServerResponse.jsonUnsafe(OpenApi.fromApi(RelayApi))),
  ),
  HttpRouter.add(
    "GET",
    "/v1/cloud/openapi.json",
    Effect.succeed(HttpServerResponse.jsonUnsafe(OpenApi.fromApi(CloudApi))),
  ),
);
