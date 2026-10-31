import { expect, it } from "@effect/vitest";
import { requestRouteFamily } from "./requestRouting.ts";

it("selects only the requested API while preserving path boundaries", () => {
  expect(requestRouteFamily("/v1/cloud?after=1")).toBe("cloud");
  expect(requestRouteFamily("https://relay.test/v1/cloud/provider-login")).toBe("cloud");
  expect(requestRouteFamily("/v1/cloudish")).toBe("relay");
  expect(requestRouteFamily("/v1/server/link")).toBe("relay");
  expect(requestRouteFamily("/v1/cloud/openapi.json")).toBe("documentation");
  expect(requestRouteFamily("/docs?theme=dark")).toBe("documentation");
  expect(requestRouteFamily("/account/github?user=vitre-user")).toBe("documentation");
  expect(requestRouteFamily("/account/github/unknown")).toBe("relay");
});
