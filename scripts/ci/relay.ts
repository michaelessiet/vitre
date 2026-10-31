// @effect-diagnostics nodeBuiltinImport:off - Standalone deployment preflight; no infrastructure mutations.
import * as NodeFS from "node:fs";
import { affectsRelay, changedFiles, git, type Git } from "./changes.ts";
import { githubApi, type GitHubApi } from "./github.ts";

export function deploymentAllowed(input: {
  enabled: string | undefined;
  event: string | undefined;
  ref: string | undefined;
  result: string | undefined;
  candidate: string | undefined;
  sha: string | undefined;
}): boolean {
  return (
    input.enabled === "true" &&
    input.event === "push" &&
    input.ref === "refs/heads/main" &&
    input.result === "success" &&
    Boolean(input.sha) &&
    input.candidate === input.sha
  );
}

export async function lastSuccessfulDeployment(
  api: GitHubApi,
  repository: string,
): Promise<string | null> {
  for (let page = 1; ; page++) {
    const deployments = await api.request<{ id: number; sha: string }[]>(
      "GET",
      `/repos/${repository}/deployments?environment=production&per_page=100&page=${page}`,
    );
    for (const deployment of deployments) {
      // An older success can have a later inactive status after another deployment.
      for (let statusPage = 1; ; statusPage++) {
        const statuses = await api.request<{ state: string }[]>(
          "GET",
          `/repos/${repository}/deployments/${deployment.id}/statuses?per_page=100&page=${statusPage}`,
        );
        if (statuses.some((status) => status.state === "success")) return deployment.sha;
        if (statuses.length < 100) break;
      }
    }
    if (deployments.length < 100) return null;
  }
}

export function relayChanges(candidate: string, baseline: string | null, runGit: Git = git) {
  if (!baseline) return { deploy: true, reason: "No successful production deployment baseline" };
  if (candidate === baseline) return { deploy: false, reason: "Commit already deployed" };
  // Unlike CI's change selection, missing deployment history must fail closed.
  const mergeBase = runGit(["merge-base", candidate, baseline]).trim();
  if (mergeBase === candidate) return { deploy: false, reason: "A descendant is already deployed" };
  if (mergeBase !== baseline)
    throw new Error("Production deployment history diverges from this commit");
  const deploy = changedFiles(baseline, candidate, runGit).some(affectsRelay);
  return {
    deploy,
    reason: deploy
      ? "Relay inputs changed since the last deployment"
      : "No relay changes since the last deployment",
  };
}

export function validateRelayConfiguration(env: Record<string, string | undefined>): string[] {
  const errors: string[] = [];
  const required = [
    "RELAY_STACK_NAME",
    "RELAY_STAGE",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "AXIOM_ORG_ID",
    "AXIOM_TOKEN",
    "RELAY_API_ZONE_NAME",
    "RELAY_TUNNEL_ZONE_NAME",
    "RELAY_DATABASE_ADMIN_URL",
    "RELAY_DATABASE_URL",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_AUDIENCE",
  ];
  for (const name of ["RELAY_PERSONAL_DEPLOYMENT", "RELAY_MOBILE_ENABLED", "VITRE_CLOUD_ENABLED"]) {
    if (env[name] !== "true" && env[name] !== "false")
      errors.push(`${name} must be explicitly true or false`);
  }
  if (env.RELAY_MOBILE_ENABLED === "true") {
    required.push(
      "APNS_ENVIRONMENT",
      "APNS_TEAM_ID",
      "APNS_KEY_ID",
      "APNS_BUNDLE_ID",
      "APNS_PRIVATE_KEY",
    );
    if (env.APNS_ENVIRONMENT && !["sandbox", "production"].includes(env.APNS_ENVIRONMENT)) {
      errors.push("APNS_ENVIRONMENT must be sandbox or production");
    }
  }
  if (env.VITRE_CLOUD_ENABLED === "true") {
    required.push(
      "VITRE_CLOUD_ALLOWED_USER_ID",
      "VITRE_CLOUD_MACHINE_URL",
      "VITRE_CLOUD_MACHINE_TOKEN",
      "VITRE_CLOUD_ENCRYPTION_KEY",
    );
  }
  // Require a complete group whenever configured, including while cloud starts are disabled.
  for (const group of [
    ["RELAY_DATABASE_CA_CERT", "RELAY_DATABASE_CA_CERTIFICATE_ID"],
    ["VITRE_CLOUD_MACHINE_URL", "VITRE_CLOUD_MACHINE_TOKEN"],
    ["VITRE_GITHUB_APP_ID", "VITRE_GITHUB_PRIVATE_KEY", "VITRE_GITHUB_INSTALLATION_IDS"],
  ]) {
    if (group.some((key) => env[key]?.trim())) required.push(...group);
  }
  for (const name of new Set(required)) {
    if (!env[name]?.trim()) errors.push(`${name} is required`);
  }
  return errors;
}

if (import.meta.main) {
  if (process.argv[2] === "configuration") {
    const errors = validateRelayConfiguration(process.env);
    if (errors.length) throw new Error(`Invalid deployment configuration:\n${errors.join("\n")}`);
  } else {
    const allowed = deploymentAllowed({
      enabled: process.env.RELAY_DEPLOY_ENABLED,
      event: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF,
      result: process.env.CI_RESULT,
      candidate: process.env.CANDIDATE_SHA,
      sha: process.env.GITHUB_SHA,
    });
    let result = { deploy: false, reason: "Deployment is disabled or this is not validated main" };
    if (allowed) {
      const baseline = await lastSuccessfulDeployment(
        githubApi(process.env.GH_TOKEN!, process.env.GITHUB_API_URL),
        process.env.GITHUB_REPOSITORY!,
      );
      if (baseline) git(["fetch", "--no-tags", "origin", baseline]);
      result = relayChanges(process.env.CANDIDATE_SHA!, baseline);
    }
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT!, `deploy=${result.deploy}\n`);
    NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY!, `${result.reason}.\n`);
  }
}
