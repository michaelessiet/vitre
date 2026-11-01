import { describe, expect, it, vi } from "vite-plus/test";
import { verifyCloud } from "./verify-cloud.ts";

describe("deployed Cloud routes", () => {
  it("rejects a healthy old deployment missing Lens", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(verifyCloud("https://cloud.example.com", request)).rejects.toThrow(
      "/v1/cloud/lens returned 404",
    );
  });
  it("requires the account management route after Lens", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(verifyCloud("https://cloud.example.com", request)).rejects.toThrow(
      "/account/github returned 404",
    );
  });
  it("accepts the deployed health and authenticated feature routes", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response("GitHub accounts"));
    await expect(verifyCloud("https://cloud.example.com", request)).resolves.toBeUndefined();
  });
});
