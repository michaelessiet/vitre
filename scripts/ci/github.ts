// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Dependency-free GitHub Actions API adapter.
export interface GitHubApi {
  request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T>;
}

export function githubApi(token: string, apiUrl = "https://api.github.com"): GitHubApi {
  if (!token) throw new Error("GitHub token is required");
  return {
    async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
      const response = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        // Do not include response bodies, credentials, or deployment configuration in errors.
        throw Object.assign(new Error(`GitHub ${method} ${path}: HTTP ${response.status}`), {
          status: response.status,
        });
      }
      return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
    },
  };
}

export async function listPages<T>(api: GitHubApi, path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const rows = await api.request<T[]>(
      "GET",
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    all.push(...rows);
    if (rows.length < 100) return all;
  }
}
