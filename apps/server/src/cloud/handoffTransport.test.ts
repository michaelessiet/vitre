import { expect, it } from "vite-plus/test";
import { handoffRelay } from "./handoffTransport.ts";

it.each(["execution_busy", "command_rejected"])(
  "preserves %s as a definitive freeze rejection",
  async (reason) => {
    const relay = handoffRelay(
      { relayUrl: "https://relay.test", accessToken: "test" },
      async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/connection"))
          return Response.json({
            environmentId: "test",
            httpBaseUrl: "https://worker.test",
            bootstrapToken: "test",
          });
        if (path === "/oauth/token") return Response.json({ access_token: "test" });
        return Response.json({ code: "invalid_request", reason }, { status: 400 });
      },
    );
    const request = await relay.environment("task");
    await expect(request("/api/orchestration/dispatch", {})).rejects.toMatchObject({
      code: reason,
      requestDisposition: "rejected",
      retryable: true,
    });
  },
);

it("keeps worker proxy errors ambiguous without exposing their response body", async () => {
  const relay = handoffRelay(
    { relayUrl: "https://relay.test", accessToken: "test" },
    async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/connection"))
        return Response.json({
          environmentId: "test",
          httpBaseUrl: "https://worker.test",
          bootstrapToken: "test",
        });
      if (path === "/oauth/token") return Response.json({ access_token: "test" });
      return new Response("private proxy content", { status: 502 });
    },
  );
  const request = await relay.environment("task");
  await expect(request("/api/orchestration/dispatch", {})).rejects.toMatchObject({
    message: "Cloud workspace request failed (502)",
    requestDisposition: "unknown",
  });
});
