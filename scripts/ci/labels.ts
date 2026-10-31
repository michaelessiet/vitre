// @effect-diagnostics nodeBuiltinImport:off - Trusted, dependency-free GitHub label automation.
import * as NodeFS from "node:fs";
import { git, type Git } from "./changes.ts";
import { githubApi, listPages, type GitHubApi } from "./github.ts";

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && "status" in error && error.status === status
  );
}

export async function syncDefinitions(api: GitHubApi, repository: string, labels: Label[]) {
  const prefix = `/repos/${repository}/labels`;
  for (const label of labels) {
    const path = `${prefix}/${encodeURIComponent(label.name)}`;
    let existing: Label;
    try {
      existing = await api.request<Label>("GET", path);
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
      try {
        await api.request("POST", prefix, { ...label });
        continue;
      } catch (createError) {
        if (!hasStatus(createError, 422)) throw createError;
        // Another label job can create it between the GET and POST. Reconcile it.
        existing = await api.request<Label>("GET", path);
      }
    }
    if (
      existing.color !== label.color ||
      (existing.description ?? "") !== (label.description ?? "")
    ) {
      await api.request("PATCH", path, { color: label.color, description: label.description });
    }
  }
}

export function sizeLabel(lines: number): string {
  if (lines < 10) return "size:XS";
  if (lines < 30) return "size:S";
  if (lines < 100) return "size:M";
  if (lines < 500) return "size:L";
  if (lines < 1000) return "size:XL";
  return "size:XXL";
}

export function sumNumstat(text: string): number {
  return text
    .split("\n")
    .filter(Boolean)
    .reduce((total, line) => {
      const [additions, deletions] = line.split("\t");
      return (
        total +
        (Number.parseInt(additions ?? "", 10) || 0) +
        (Number.parseInt(deletions ?? "", 10) || 0)
      );
    }, 0);
}

export function measureSize(base: string, head: string, runGit: Git = git) {
  // Inspect PR objects as passive data; never check them out or invoke diff drivers.
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--numstat",
    "--ignore-all-space",
    "--ignore-blank-lines",
    `${base}...${head}`,
  ];
  const all = sumNumstat(runGit([...args, "--"]));
  const nonTest = sumNumstat(
    runGit([
      ...args,
      "--",
      ".",
      ":(glob,exclude)**/__tests__/**",
      ":(glob,exclude)**/test/**",
      ":(glob,exclude)**/tests/**",
      ":(glob,exclude)apps/server/integration/**",
      ":(glob,exclude)**/*.test.*",
      ":(glob,exclude)**/*.spec.*",
      ":(glob,exclude)**/*.browser.*",
      ":(glob,exclude)**/*.integration.*",
    ]),
  );
  const effective = nonTest === 0 ? all : nonTest;
  return { all, nonTest, effective, label: sizeLabel(effective) };
}

export async function syncSizeLabel(
  api: GitHubApi,
  repository: string,
  number: number,
  next: string,
  labels: Label[],
) {
  const path = `/repos/${repository}/issues/${number}/labels`;
  const managed = new Set(
    labels.filter((label) => label.name.startsWith("size:")).map((label) => label.name),
  );
  if (!managed.has(next)) throw new Error("Unknown size label");
  const current = await listPages<Label>(api, path);
  for (const label of current) {
    if (!managed.has(label.name) || label.name === next) continue;
    try {
      await api.request("DELETE", `${path}/${encodeURIComponent(label.name)}`);
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    }
  }
  if (!current.some((label) => label.name === next)) {
    await api.request("POST", path, { labels: [next] });
  }
}

if (import.meta.main) {
  const api = githubApi(process.env.GH_TOKEN!, process.env.GITHUB_API_URL);
  const repository = process.env.GITHUB_REPOSITORY!;
  const definitions: Label[] = JSON.parse(
    NodeFS.readFileSync(new URL("../../.github/labels.json", import.meta.url), "utf8"),
  );
  if (process.argv[2] === "sync") {
    await syncDefinitions(api, repository, definitions);
  } else if (process.argv[2] === "size") {
    const event = JSON.parse(NodeFS.readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
    const number = Number(event.pull_request.number);
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error("Invalid pull request number");
    const prPath = `/repos/${repository}/pulls/${number}`;
    type Pull = { base: { sha: string }; head: { sha: string } };
    const current = await api.request<Pull>("GET", prPath);
    if (
      current.head.sha === event.pull_request.head.sha &&
      current.base.sha === event.pull_request.base.sha
    ) {
      git(["fetch", "--no-tags", "origin", current.base.sha]);
      git([
        "fetch",
        "--no-tags",
        "origin",
        `+refs/pull/${number}/head:refs/remotes/pr-size/${number}`,
      ]);
      const head = git(["rev-parse", `refs/remotes/pr-size/${number}`]).trim();
      if (head !== current.head.sha)
        throw new Error("Pull request changed while fetching; a newer run will label it");
      const size = measureSize(current.base.sha, head);
      const latest = await api.request<Pull>("GET", prPath);
      if (latest.head.sha === head && latest.base.sha === current.base.sha) {
        await syncDefinitions(
          api,
          repository,
          definitions.filter((label) => label.name.startsWith("size:")),
        );
        await syncSizeLabel(api, repository, number, size.label, definitions);
        NodeFS.appendFileSync(
          process.env.GITHUB_STEP_SUMMARY!,
          `PR #${number}: ${size.effective} effective lines → ${size.label}.\n`,
        );
      }
    }
  } else {
    throw new Error("Expected sync or size");
  }
}
