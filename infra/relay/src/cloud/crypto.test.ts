import { describe, expect, it } from "vite-plus/test";
import { CredentialVault } from "./crypto.ts";

describe("cloud credential encryption", () => {
  it("binds ciphertext to account, provider and credential version", async () => {
    const vault = new CredentialVault(btoa("x".repeat(32)));
    const sealed = await vault.seal("subscription-secret", "user:codex:1");
    expect(JSON.stringify(sealed)).not.toContain("subscription-secret");
    expect(await vault.open(sealed, "user:codex:1")).toBe("subscription-secret");
    await expect(vault.open(sealed, "other:codex:1")).rejects.toThrow();
    await expect(vault.open(sealed, "user:codex:2")).rejects.toThrow();
  });
  it("uses a new nonce for each encryption", async () => {
    const vault = new CredentialVault(btoa("x".repeat(32)));
    expect((await vault.seal("same", "context")).iv).not.toBe(
      (await vault.seal("same", "context")).iv,
    );
  });
});
