import { describe, expect, it } from "vite-plus/test";
import { makeCloudClient } from "./index.ts";

describe("cloud authentication errors", () => {
  it("explains relay token rejection instead of showing a generic request error", async () => {
    const client = makeCloudClient({
      baseUrl: "https://relay.example.test",
      accessToken: async () => "session-token",
      fetch: async () =>
        new Response(
          JSON.stringify({
            _tag: "RelayAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_bearer",
            traceId: "test",
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(client.overview()).rejects.toMatchObject({
      status: 401,
      code: "auth_invalid",
      requestDisposition: "rejected",
      message: expect.stringContaining("Clerk JWT template"),
    });
  });
});
