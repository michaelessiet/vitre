/** Repository OAuth connections are independent of Clerk's single GitHub sign-in identity. */
import type { CloudGitHubAccount } from "@t3tools/contracts/cloud";
import type { GitHubAccounts, GitHubIdentity } from "./githubAccounts.ts";
import { GitHubCloudClient, type GitHubConfiguration } from "./github.ts";
import { CredentialVault, type SealedCredential } from "./crypto.ts";
import type { CloudAccountDocument } from "./store.ts";
import { CloudError } from "./policy.ts";

export type GitHubConnectionCommand =
  | { type: "start"; requestId: string }
  | { type: "poll"; requestId: string }
  | { type: "disconnect"; accountId: string };
export interface GitHubConnectionStatus {
  status: "pending" | "connected" | "disconnected";
  requestId?: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  pollAfterMs?: number;
  account?: CloudGitHubAccount;
}
export interface StoredGitHubConnection {
  account: CloudGitHubAccount;
  providerUserId: string;
  clientId: string;
  version: string;
  sealed: SealedCredential;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  refreshLease?: { id: string; until: number };
}
export interface GitHubConnectionFlow {
  expiresAt: number;
  nextPollAt: number;
  intervalMs: number;
  clientId?: string;
  userCode?: string;
  sealed?: SealedCredential;
  lease?: string;
  accountId?: string;
}
export interface GitHubConnectionStore {
  read(userId: string): Promise<CloudAccountDocument>;
  mutate<A>(userId: string, reduce: (document: CloudAccountDocument) => A): Promise<A>;
}
type Tokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
};
const failure = (code: string, message: string, status = 409) =>
  new CloudError(code, message, status);
const accountContext = (user: string, id: string, version: string) =>
  [user, "github", id, version].join(":");
const flowContext = (user: string, id: string) => [user, "github-device", id].join(":");
const boundedString = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;
const seconds = (value: unknown, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;
function tokens(value: Record<string, unknown>, now: number): Tokens {
  if (
    !boundedString(value.access_token, 1024) ||
    (value.expires_in !== undefined && !seconds(value.expires_in, 86400)) ||
    (value.refresh_token !== undefined && !boundedString(value.refresh_token, 1024)) ||
    (value.refresh_token_expires_in !== undefined &&
      !seconds(value.refresh_token_expires_in, 366 * 86400))
  ) {
    throw failure(
      "github_invalid_response",
      "GitHub returned an invalid authorization response",
      502,
    );
  }
  return {
    accessToken: value.access_token,
    ...(typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}),
    expiresAt: typeof value.expires_in === "number" ? now + value.expires_in * 1000 : null,
    refreshExpiresAt:
      typeof value.refresh_token_expires_in === "number"
        ? now + value.refresh_token_expires_in * 1000
        : null,
  };
}
const nonce = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
export class GitHubConnections implements GitHubAccounts {
  private readonly clerk: GitHubAccounts;
  private readonly config: GitHubConfiguration;
  private readonly store: GitHubConnectionStore;
  private readonly vault: CredentialVault;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(
    clerk: GitHubAccounts,
    config: GitHubConfiguration,
    store: GitHubConnectionStore,
    vault: CredentialVault,
    fetcher: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.clerk = clerk;
    this.config = config;
    this.store = store;
    this.vault = vault;
    this.fetcher = fetcher.bind(globalThis);
    this.now = now;
  }
  private async oauth(path: string, parameters: Record<string, string>) {
    const response = await this.fetcher("https://github.com/login/" + path, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
      // Workers supports manual/follow only. Never forward OAuth credentials
      // to a redirect destination; reject the response before parsing it.
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400)
      throw failure(
        "github_invalid_response",
        "GitHub authorization returned an unexpected redirect",
        502,
      );
    const value = (await response.json()) as Record<string, unknown>;
    if (!response.ok && typeof value.error !== "string")
      throw failure("github_unavailable", "GitHub authorization is temporarily unavailable", 502);
    return value;
  }
  private pending(requestId: string, flow: GitHubConnectionFlow): GitHubConnectionStatus {
    return {
      status: "pending",
      requestId,
      expiresAt: flow.expiresAt,
      pollAfterMs: Math.max(1000, flow.nextPollAt - this.now()),
      ...(flow.userCode
        ? { userCode: flow.userCode, verificationUri: "https://github.com/login/device" }
        : {}),
    };
  }
  async list(userId: string): Promise<CloudGitHubAccount[]> {
    const document = await this.store.read(userId);
    const linked = Object.values(document.private.githubConnections ?? {});
    const identities = await this.clerk.list(userId);
    // Keep Clerk IDs stable for existing repositories; repository connections have their own IDs.
    return [
      ...identities,
      ...linked.map((entry) => ({
        ...entry.account,
        state:
          entry.expiresAt !== null &&
          entry.expiresAt <= this.now() &&
          (entry.refreshExpiresAt === null || entry.refreshExpiresAt <= this.now())
            ? ("needs_auth" as const)
            : entry.account.state,
      })),
    ];
  }
  async connection(
    userId: string,
    command: GitHubConnectionCommand,
  ): Promise<GitHubConnectionStatus> {
    if (command.type === "disconnect") {
      await this.store.mutate(userId, (doc) => {
        delete doc.private.githubConnections?.[command.accountId];
        delete doc.state.githubAccounts;
      });
      return { status: "disconnected" };
    }
    if (command.type === "start") return this.start(userId, command.requestId);
    return this.poll(userId, command.requestId);
  }
  private async start(userId: string, requestId: string): Promise<GitHubConnectionStatus> {
    const now = this.now();
    const lease = nonce();
    const selected = await this.store.mutate(userId, (doc) => {
      const flows = (doc.private.githubConnectionFlows ??= {});
      for (const [id, flow] of Object.entries(flows)) if (flow.expiresAt <= now) delete flows[id];
      const current = flows[requestId];
      if (current) return { flow: current, acquired: false };
      if (
        Object.keys(flows).length >= 5 ||
        Object.keys(doc.private.githubConnections ?? {}).length >= 20
      )
        throw failure(
          "github_connection_limit",
          "Finish an active connection or remove an old account first",
          400,
        );
      const flow: GitHubConnectionFlow = {
        expiresAt: now + 15 * 60_000,
        nextPollAt: now + 60_000,
        intervalMs: 5000,
        lease,
      };
      flows[requestId] = flow;
      return { flow, acquired: true };
    });
    if (!selected.acquired) {
      if (selected.flow.accountId) return this.completed(userId, selected.flow.accountId);
      return this.pending(requestId, selected.flow);
    }
    try {
      const app = await new GitHubCloudClient(this.config, this.fetcher).application(now);
      const value = await this.oauth("device/code", {
        client_id: app.clientId,
        scope: "offline_access",
      });
      if (value.error === "device_flow_disabled")
        throw failure(
          "github_device_flow_disabled",
          "The Vitre GitHub App needs Device Flow enabled before connecting repository accounts.",
          503,
        );
      if (
        !boundedString(value.device_code, 1024) ||
        !boundedString(value.user_code, 32) ||
        value.verification_uri !== "https://github.com/login/device" ||
        !seconds(value.expires_in, 1800) ||
        !seconds(value.interval, 60)
      ) {
        throw failure(
          "github_invalid_response",
          "GitHub could not start account authorization. Try again.",
          502,
        );
      }
      const flow: GitHubConnectionFlow = {
        expiresAt: this.now() + Number(value.expires_in) * 1000,
        nextPollAt: this.now() + Number(value.interval) * 1000,
        intervalMs: Math.max(5000, Number(value.interval) * 1000),
        clientId: app.clientId,
        userCode: value.user_code,
        sealed: await this.vault.seal(value.device_code, flowContext(userId, requestId)),
      };
      await this.store.mutate(userId, (doc) => {
        if (doc.private.githubConnectionFlows?.[requestId]?.lease !== lease)
          throw failure("github_connection_expired", "Start a new GitHub connection");
        doc.private.githubConnectionFlows[requestId] = flow;
      });
      return this.pending(requestId, flow);
    } catch (error) {
      await this.store.mutate(userId, (doc) => {
        if (doc.private.githubConnectionFlows?.[requestId]?.lease === lease)
          delete doc.private.githubConnectionFlows[requestId];
      });
      throw error;
    }
  }
  private async completed(userId: string, accountId: string): Promise<GitHubConnectionStatus> {
    const account = (await this.store.read(userId)).private.githubConnections?.[accountId]?.account;
    if (!account)
      throw failure("github_account_unlinked", "This repository account was disconnected", 403);
    return { status: "connected", account };
  }
  private async poll(userId: string, requestId: string): Promise<GitHubConnectionStatus> {
    const now = this.now();
    const lease = nonce();
    const selected = await this.store.mutate(userId, (doc) => {
      const flow = doc.private.githubConnectionFlows?.[requestId];
      if (!flow || flow.expiresAt <= now)
        throw failure(
          "github_connection_expired",
          "The GitHub code expired. Start a new connection.",
        );
      if (flow.accountId || now < flow.nextPollAt) return { flow, acquired: false };
      if (!flow.sealed || !flow.clientId)
        throw failure(
          "github_connection_expired",
          "GitHub authorization did not start. Start a new connection.",
        );
      flow.lease = lease;
      flow.nextPollAt = now + 60_000;
      return { flow, acquired: true };
    });
    const flow = selected.flow;
    if (flow.accountId) return this.completed(userId, flow.accountId);
    if (!selected.acquired) return this.pending(requestId, flow);
    try {
      const deviceCode = await this.vault.open(flow.sealed!, flowContext(userId, requestId));
      const value = await this.oauth("oauth/access_token", {
        client_id: flow.clientId!,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (value.error === "authorization_pending" || value.error === "slow_down") {
        const updated = await this.store.mutate(userId, (doc) => {
          const current = doc.private.githubConnectionFlows?.[requestId];
          if (!current || current.lease !== lease)
            throw failure("github_connection_expired", "Start a new GitHub connection");
          if (value.error === "slow_down")
            current.intervalMs = Math.min(60_000, current.intervalMs + 5000);
          current.nextPollAt = this.now() + current.intervalMs;
          delete current.lease;
          return current;
        });
        return this.pending(requestId, updated);
      }
      if (value.error)
        throw failure(
          "github_authorization_failed",
          "GitHub authorization was declined or expired. Start a new connection.",
        );
      const credential = tokens(value, this.now());
      const response = await this.fetcher("https://api.github.com/user", {
        headers: {
          Authorization: "Bearer " + credential.accessToken,
          Accept: "application/vnd.github+json",
          "User-Agent": "Vitre-Cloud",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw failure(
          "github_identity_unavailable",
          "GitHub could not verify the connected account",
          502,
        );
      const identity = (await response.json()) as { id?: number; login?: string };
      if (
        !Number.isSafeInteger(identity.id) ||
        identity.id! <= 0 ||
        !boundedString(identity.login, 100)
      )
        throw failure(
          "github_identity_unavailable",
          "GitHub could not verify the connected account",
          502,
        );
      const account: CloudGitHubAccount = {
        id: "gha_" + identity.id,
        login: identity.login,
        state: "connected",
      };
      const version = nonce();
      const sealed = await this.vault.seal(
        JSON.stringify(credential),
        accountContext(userId, account.id, version),
      );
      await this.store.mutate(userId, (doc) => {
        const current = doc.private.githubConnectionFlows?.[requestId];
        if (!current || current.lease !== lease || current.expiresAt <= this.now())
          throw failure("github_connection_expired", "Start a new GitHub connection");
        const connections = (doc.private.githubConnections ??= {});
        if (!connections[account.id] && Object.keys(connections).length >= 20)
          throw failure("github_connection_limit", "Remove an old repository account first", 400);
        connections[account.id] = {
          account,
          providerUserId: String(identity.id),
          clientId: flow.clientId!,
          version,
          sealed,
          expiresAt: credential.expiresAt,
          refreshExpiresAt: credential.refreshExpiresAt,
        };
        doc.private.githubConnectionFlows![requestId] = {
          expiresAt: now + 15 * 60_000,
          nextPollAt: 0,
          intervalMs: 5000,
          accountId: account.id,
        };
        delete doc.state.githubAccounts;
      });
      return { status: "connected", account };
    } catch (error) {
      await this.store.mutate(userId, (doc) => {
        const current = doc.private.githubConnectionFlows?.[requestId];
        if (current?.lease === lease) {
          delete current.lease;
          current.nextPollAt = this.now() + current.intervalMs;
        }
      });
      throw error;
    }
  }
  async credential(userId: string, accountId: string): Promise<GitHubIdentity> {
    if (!accountId.startsWith("gha_")) return this.clerk.credential(userId, accountId);
    const connection = (await this.store.read(userId)).private.githubConnections?.[accountId];
    if (!connection || connection.account.state !== "connected")
      throw failure("github_account_unlinked", "Reconnect this repository account", 403);
    let credential = JSON.parse(
      await this.vault.open(
        connection.sealed,
        accountContext(userId, accountId, connection.version),
      ),
    ) as Tokens;
    if (credential.expiresAt !== null && credential.expiresAt < this.now() + 60_000) {
      if (
        !credential.refreshToken ||
        (credential.refreshExpiresAt !== null && credential.refreshExpiresAt <= this.now())
      )
        throw failure("github_needs_auth", "Reconnect this GitHub repository account", 403);
      const lease = nonce();
      const claimed = await this.store.mutate(userId, (doc) => {
        const current = doc.private.githubConnections?.[accountId];
        if (!current || current.version !== connection.version) return false;
        if (current.refreshLease && current.refreshLease.until > this.now()) return false;
        current.refreshLease = { id: lease, until: this.now() + 30_000 };
        return true;
      });
      if (!claimed)
        throw failure(
          "github_refresh_in_progress",
          "GitHub authorization is refreshing. Try again shortly.",
          503,
        );
      try {
        const value = await this.oauth("oauth/access_token", {
          client_id: connection.clientId,
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
        });
        if (value.error)
          throw failure("github_needs_auth", "Reconnect this GitHub repository account", 403);
        credential = tokens(value, this.now());
        const version = nonce();
        const sealed = await this.vault.seal(
          JSON.stringify(credential),
          accountContext(userId, accountId, version),
        );
        await this.store.mutate(userId, (doc) => {
          const current = doc.private.githubConnections?.[accountId];
          if (
            !current ||
            current.version !== connection.version ||
            current.refreshLease?.id !== lease
          )
            throw failure(
              "github_account_unlinked",
              "The GitHub connection changed. Try again.",
              403,
            );
          Object.assign(current, {
            version,
            sealed,
            expiresAt: credential.expiresAt,
            refreshExpiresAt: credential.refreshExpiresAt,
          });
          delete current.refreshLease;
        });
      } catch (error) {
        if (error instanceof CloudError && error.code === "github_needs_auth") {
          await this.store.mutate(userId, (doc) => {
            const current = doc.private.githubConnections?.[accountId];
            if (current?.version === connection.version) {
              current.account = { ...current.account, state: "needs_auth" };
              delete doc.state.githubAccounts;
            }
          });
        }
        throw error;
      } finally {
        await this.store.mutate(userId, (doc) => {
          const current = doc.private.githubConnections?.[accountId];
          if (current?.refreshLease?.id === lease) delete current.refreshLease;
        });
      }
    }
    return {
      id: accountId,
      providerUserId: connection.providerUserId,
      token: credential.accessToken,
    };
  }
}
