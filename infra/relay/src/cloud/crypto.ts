import { CloudError } from "./policy.ts";

const encoder = new TextEncoder();
function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export async function sha256(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    typeof value === "string" ? encoder.encode(value) : value,
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SealedCredential {
  version: 1;
  iv: string;
  ciphertext: string;
}

/** AAD prevents swapping encrypted credentials between users, providers or versions. */
export class CredentialVault {
  private readonly key: Promise<CryptoKey>;
  constructor(encodedKey: string) {
    const bytes = unbase64(encodedKey);
    if (bytes.length !== 32)
      throw new CloudError(
        "invalid_encryption_key",
        "Cloud credential key must contain 32 random bytes",
        503,
      );
    this.key = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async seal(value: string, context: string): Promise<SealedCredential> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      await this.key,
      encoder.encode(value),
    );
    return { version: 1, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
  }
  async open(value: SealedCredential, context: string): Promise<string> {
    try {
      const result = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unbase64(value.iv), additionalData: encoder.encode(context) },
        await this.key,
        unbase64(value.ciphertext),
      );
      return new TextDecoder().decode(result);
    } catch {
      throw new CloudError("credential_unavailable", "Stored credential cannot be decrypted", 503);
    }
  }
}
