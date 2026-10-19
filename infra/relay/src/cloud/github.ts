import { CloudError } from "./policy.ts";
import type { CloudRepository, CloudTask, CloudPublication } from "@t3tools/contracts/cloud";

const utf8 = new TextEncoder();
const encode = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
const json64 = (value: unknown) => encode(utf8.encode(JSON.stringify(value)));

const der = (tag: number, bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const length: number[] = [];
  for (let value = bytes.length; value > 0; value = Math.floor(value / 256))
    length.unshift(value & 255);
  return Uint8Array.from([
    tag,
    ...(bytes.length < 128 ? [bytes.length] : [128 + length.length, ...length]),
    ...bytes,
  ]);
};

/** GitHub downloads PKCS#1 keys; Web Crypto imports the PKCS#8 envelope. */
export function githubPrivateKeyBytes(pem: string): Uint8Array<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")), (c) =>
    c.charCodeAt(0),
  );
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return bytes;
  return der(
    0x30,
    Uint8Array.from([
      0x02,
      0x01,
      0x00, // version
      0x30,
      0x0d,
      0x06,
      0x09,
      0x2a,
      0x86,
      0x48,
      0x86,
      0xf7,
      0x0d,
      0x01,
      0x01,
      0x01,
      0x05,
      0x00,
      ...der(0x04, bytes),
    ]),
  );
}

export interface GitHubConfiguration {
  appId: string;
  privateKey: string;
  installationIds: ReadonlyArray<string>;
}
export class GitHubCloudClient {
  private readonly config: GitHubConfiguration;
  private readonly fetcher: typeof fetch;
  constructor(config: GitHubConfiguration, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher.bind(globalThis);
  }
  private async appToken(now: number): Promise<string> {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      githubPrivateKeyBytes(this.config.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const claims = `${json64({ alg: "RS256", typ: "JWT" })}.${json64({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: this.config.appId })}`;
    return `${claims}.${encode(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8.encode(claims))))}`;
  }
  async request(path: string, token: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: "application/vnd.github+json",
        "user-agent": "Vitre-Cloud",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404)
      throw new CloudError(
        "github_not_found",
        "GitHub resource is unavailable or access is missing",
        404,
      );
    if (!response.ok)
      throw new CloudError("github_unavailable", `GitHub request failed (${response.status})`, 502);
    return response.status === 204 ? null : response.json();
  }
  /** Public access is verified anonymously; "public" is not an installation credential. */
  async publicRepository(owner: string, name: string): Promise<CloudRepository | null> {
    if (![owner, name].every((part) => /^[\w.-]+$/.test(part)))
      throw new CloudError("invalid_repository", "Invalid GitHub repository name", 400);
    const response = await this.fetcher(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "Vitre-Cloud",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new CloudError("github_unavailable", `GitHub request failed (${response.status})`, 502);
    const repo = (await response.json()) as {
      id?: number;
      private?: boolean;
      owner?: { login?: string };
      name?: string;
      default_branch?: string;
    };
    if (
      repo.private !== false ||
      !Number.isSafeInteger(repo.id) ||
      repo.id! <= 0 ||
      typeof repo.owner?.login !== "string" ||
      typeof repo.name !== "string" ||
      typeof repo.default_branch !== "string"
    )
      throw new CloudError(
        "github_invalid_response",
        "GitHub did not verify a public repository",
        502,
      );
    return {
      id: String(repo.id),
      installationId: "public",
      owner: repo.owner.login,
      name: repo.name,
      defaultBranch: repo.default_branch,
      setupCommand: "",
      testCommand: "",
      revision: 0,
    };
  }
  async repositoryToken(
    repository: CloudRepository,
    now: number,
    permission: "read" | "write" = "read",
  ): Promise<string> {
    if (!this.config.installationIds.includes(repository.installationId))
      throw new CloudError(
        "github_installation_denied",
        "GitHub installation is not allowlisted",
        403,
      );
    const repositoryId = Number(repository.id);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0)
      throw new CloudError("invalid_repository", "GitHub repository ID must be numeric", 400);
    const result = (await this.request(
      `/app/installations/${encodeURIComponent(repository.installationId)}/access_tokens`,
      await this.appToken(now),
      "POST",
      {
        repository_ids: [repositoryId],
        permissions: {
          contents: permission,
          metadata: "read",
          issues: permission,
          pull_requests: permission,
        },
      },
    )) as { token?: unknown };
    if (typeof result.token !== "string")
      throw new CloudError(
        "github_invalid_response",
        "GitHub did not return an installation token",
        502,
      );
    return result.token;
  }
  async repositories(now: number): Promise<CloudRepository[]> {
    const repositories: CloudRepository[] = [];
    for (const installationId of this.config.installationIds) {
      const auth = (await this.request(
        `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        await this.appToken(now),
        "POST",
        { permissions: { contents: "read", metadata: "read" } },
      )) as { token: string };
      for (let page = 1; page <= 100; page++) {
        const result = (await this.request(
          `/installation/repositories?per_page=100&page=${page}`,
          auth.token,
        )) as {
          repositories: Array<{
            id: number;
            owner: { login: string };
            name: string;
            default_branch: string;
          }>;
        };
        for (const repo of result.repositories)
          repositories.push({
            id: String(repo.id),
            installationId,
            owner: repo.owner.login,
            name: repo.name,
            defaultBranch: repo.default_branch,
            setupCommand: "",
            testCommand: "",
            revision: 0,
          });
        if (result.repositories.length < 100) break;
      }
    }
    return repositories;
  }
  async readAccess(repository: CloudRepository, now: number): Promise<string> {
    // Connected repositories use their scoped installation credential. Anonymous
    // requests share an IP quota at the edge and must not gate connected access.
    const token =
      repository.installationId === "public" ? "" : await this.repositoryToken(repository, now);
    const metadata = token
      ? ((await this.request(
          `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
          token,
        )) as { id?: unknown })
      : await this.publicRepository(repository.owner, repository.name);
    if (!metadata)
      throw new CloudError(
        "repository_private",
        "Repository is no longer public; connect GitHub access",
        403,
      );
    if (String(metadata.id) !== repository.id)
      throw new CloudError(
        "repository_changed",
        "Repository identity does not match the configured GitHub repository",
        409,
      );
    return token;
  }
  async resolve(
    repository: CloudRepository,
    branch: string,
    now: number,
  ): Promise<{ sha: string; token: string }> {
    const token = await this.readAccess(repository, now);
    const result = (await this.request(
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${encodeURIComponent(branch)}`,
      token,
    ).catch((error: unknown) => {
      if (error instanceof CloudError && error.code === "github_not_found")
        throw new CloudError(
          "invalid_branch",
          "The selected branch is unavailable. Check its name and try again.",
          400,
        );
      throw error;
    })) as { sha?: unknown };
    if (typeof result.sha !== "string" || !/^[a-f0-9]{40}$/.test(result.sha))
      throw new CloudError("invalid_revision", "GitHub did not return a commit SHA", 502);
    return { sha: result.sha, token };
  }
  async verifyRepository(repository: CloudRepository, now: number): Promise<CloudRepository> {
    const resolved =
      repository.installationId === "public"
        ? await this.publicRepository(repository.owner, repository.name)
        : (await this.repositories(now)).find(
            (entry) =>
              entry.id === repository.id && entry.installationId === repository.installationId,
          );
    if (
      !resolved ||
      resolved.id !== repository.id ||
      resolved.owner.toLowerCase() !== repository.owner.toLowerCase() ||
      resolved.name.toLowerCase() !== repository.name.toLowerCase()
    )
      throw new CloudError(
        "repository_access",
        "Repository is unavailable. Check the URL or connect GitHub access for this repository.",
        403,
      );
    return {
      ...repository,
      id: resolved.id,
      owner: resolved.owner,
      name: resolved.name,
      defaultBranch: resolved.defaultBranch,
    };
  }
  async issue(
    repository: CloudRepository,
    issueNumber: number,
    token: string,
  ): Promise<{ title: string; body: string }> {
    const result = (await this.request(
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${issueNumber}`,
      token,
    )) as { title: string; body: string | null };
    return { title: result.title, body: result.body ?? "" };
  }

  /** Called only by the publication service, never the execution worker API. */
  async publish(
    task: CloudTask,
    publication: CloudPublication,
    commit: string | null,
    now: number,
    allowCreate: boolean,
  ): Promise<string> {
    const token = await this.repositoryToken(task.repository, now, "write");
    const prefix = `/repos/${encodeURIComponent(task.repository.owner)}/${encodeURIComponent(task.repository.name)}`;
    if (publication.kind === "pull_request") {
      if (!commit || !/^[a-f0-9]{40}$/.test(commit))
        throw new CloudError("invalid_commit", "Publication commit is missing");
      const pulls = (await this.request(
        `${prefix}/pulls?state=all&head=${encodeURIComponent(`${task.repository.owner}:${task.branch}`)}&per_page=100`,
        token,
      )) as Array<{
        html_url: string;
        head: { sha: string };
        base: { ref: string };
        title: string;
        body: string | null;
      }>;
      const existing = pulls.find(
        (p) =>
          p.head.sha === commit &&
          p.base.ref === task.baseBranch &&
          p.title === publication.title &&
          (p.body ?? "") === publication.body,
      );
      if (existing) return existing.html_url;
      if (pulls.length)
        throw new CloudError(
          "publication_conflict",
          "The task branch already has a different pull request",
        );
      if (!allowCreate)
        throw new CloudError(
          "publication_uncertain",
          "GitHub outcome is uncertain; reconcile before approving another publication",
        );
      const result = (await this.request(`${prefix}/pulls`, token, "POST", {
        head: task.branch,
        base: task.baseBranch,
        title: publication.title,
        body: publication.body,
        draft: true,
      })) as { html_url: string };
      return result.html_url;
    }
    if (!task.issueNumber) throw new CloudError("issue_required", "Publication has no issue");
    for (let page = 1; page <= 100; page++) {
      const comments = (await this.request(
        `${prefix}/issues/${task.issueNumber}/comments?per_page=100&page=${page}`,
        token,
      )) as Array<{
        body: string;
        html_url: string;
        performed_via_github_app?: { id: number } | null;
      }>;
      const existing = comments.find(
        (c) =>
          c.body === publication.body &&
          String(c.performed_via_github_app?.id) === this.config.appId,
      );
      if (existing) return existing.html_url;
      if (comments.length < 100) {
        if (!allowCreate)
          throw new CloudError(
            "publication_uncertain",
            "GitHub outcome is uncertain; reconcile before approving another publication",
          );
        const result = (await this.request(
          `${prefix}/issues/${task.issueNumber}/comments`,
          token,
          "POST",
          { body: publication.body },
        )) as { html_url: string };
        return result.html_url;
      }
    }
    throw new CloudError("publication_uncertain", "Too many comments to reconcile safely");
  }
}
