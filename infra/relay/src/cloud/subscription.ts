import { CloudError } from "./policy.ts";

/** Shared by initial connection and every refresh; API billing is never accepted. */
export function validateSubscriptionCredential(
  provider: "codex" | "claude",
  credential: string,
): void {
  if (!credential.trim() || credential.length > 65536)
    throw new CloudError("invalid_credential", "Credential is empty or too large", 400);
  if (provider === "claude") {
    if (!/^sk-ant-oat[^\s]+$/.test(credential))
      throw new CloudError(
        "invalid_credential",
        "Use a Claude subscription token from claude setup-token",
        400,
      );
    return;
  }
  let valid = false;
  try {
    const parsed = JSON.parse(credential) as {
      auth_mode?: string;
      OPENAI_API_KEY?: unknown;
      tokens?: { refresh_token?: unknown };
    } | null;
    valid =
      parsed !== null &&
      parsed.auth_mode !== "apikey" &&
      !parsed.OPENAI_API_KEY &&
      typeof parsed.tokens?.refresh_token === "string" &&
      parsed.tokens.refresh_token.length > 0;
  } catch {
    /* Fail closed without including provider payloads in the error. */
  }
  if (!valid)
    throw new CloudError(
      "invalid_credential",
      "Only Codex subscription credentials are accepted",
      400,
    );
}
