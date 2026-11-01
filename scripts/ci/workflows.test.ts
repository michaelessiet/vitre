// @effect-diagnostics nodeBuiltinImport:off - Validate security-sensitive workflow wiring without running Actions.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const workflow = (name: string) =>
  parse(
    NodeFS.readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
  );

describe("workflow boundaries", () => {
  it("keeps queued relay deployment serialized without canceling active deployments", () => {
    const relay = workflow("deploy-relay");
    expect(Object.keys(relay.on)).toEqual(["workflow_call"]);
    expect(relay.concurrency).toEqual({
      group: "vitre-relay-production",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(relay.jobs.eligibility.environment).toBeUndefined();
    expect(relay.jobs.deploy.needs).toBe("eligibility");
    expect(relay.jobs.deploy.environment.name).toBe("production");
    expect(relay.jobs.deploy.steps[0].with.ref).toBe("${{ inputs.ref }}");
    expect(relay.jobs.deploy.env.VITRE_CLOUD_REQUIRE_EXISTING_STACK).toBe("true");
  });

  it("automatically deploys validated main unless explicitly paused", () => {
    const job = workflow("ci").jobs.relay;
    expect(job.needs).toBe("result");
    expect(job.if).toContain("needs.result.result == 'success'");
    expect(job.if).toContain("github.event_name == 'push'");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).toContain("vars.RELAY_DEPLOY_ENABLED != 'false'");
    expect(job.with.ref).toBe("${{ github.sha }}");
  });

  it("builds and verifies the runtime before deploying the relay", () => {
    const job = workflow("deploy-relay").jobs.deploy;
    const names = job.steps.map((step: { name?: string }) => step.name);
    expect(names.indexOf("Validate production configuration")).toBeLessThan(
      names.indexOf("Build and smoke test cloud runtime"),
    );
    expect(names.indexOf("Publish and install matching runtime")).toBeLessThan(
      names.indexOf("Deploy existing relay stack"),
    );
    expect(names.indexOf("Verify deployed routes")).toBeGreaterThan(
      names.indexOf("Deploy existing relay stack"),
    );
    const build = job.steps.find(
      (step: { name?: string }) => step.name === "Build and smoke test cloud runtime",
    );
    expect(JSON.stringify(build)).not.toContain("secrets.");
    expect(job.permissions["id-token"]).toBe("write");
    expect(workflow("ci").jobs.relay.permissions["id-token"]).toBe("write");
  });

  it("keeps build artifacts free of deployment environments and credentials", () => {
    const build = workflow("build-vitre");
    const text = NodeFS.readFileSync(
      new URL("../../.github/workflows/build-vitre.yml", import.meta.url),
      "utf8",
    );
    expect(Object.keys(build.on)).toEqual(["workflow_call"]);
    expect(build.jobs.package.environment).toBeUndefined();
    expect(text).not.toMatch(/secrets\.|npm publish|read-state/);
    const upload = build.jobs.package.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(upload.with["retention-days"]).toBe(14);
    expect(upload.with["if-no-files-found"]).toBe("error");
  });

  it("runs PR labeling exclusively from trusted base code without dependency installation", () => {
    const pr = workflow("pr-size");
    expect(Object.keys(pr.on)).toEqual(["pull_request_target"]);
    const steps = pr.jobs.label.steps;
    expect(steps[0].with.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(steps[0].with["persist-credentials"]).toBe(false);
    expect(
      steps.filter((step: { run?: string }) => step.run).map((step: { run: string }) => step.run),
    ).toEqual(["node scripts/ci/labels.ts size"]);
    expect(
      steps.some(
        (step: { uses?: string }) =>
          step.uses?.includes("cache") || step.uses?.includes("setup-tools"),
      ),
    ).toBe(false);
  });

  it("keeps label definitions complete, unique, and synchronized when changed", () => {
    const labels = JSON.parse(
      NodeFS.readFileSync(new URL("../../.github/labels.json", import.meta.url), "utf8"),
    ) as { name: string }[];
    expect(new Set(labels.map((label) => label.name)).size).toBe(labels.length);
    expect(labels.map((label) => label.name)).toEqual(
      expect.arrayContaining([
        "bug",
        "enhancement",
        "needs-triage",
        "size:XS",
        "size:S",
        "size:M",
        "size:L",
        "size:XL",
        "size:XXL",
      ]),
    );
    expect(workflow("issue-labels").on.push.paths).toContain(".github/labels.json");
    expect(Object.keys(workflow("issue-labels").on)).toContain("workflow_dispatch");
  });
});
