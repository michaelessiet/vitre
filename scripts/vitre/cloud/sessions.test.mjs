import { it, expect } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { exportSessions, restoreSessions } from "./sessions.mjs";
import { createLoginHome, devicePrompt } from "./auxiliary.mjs";

it("restores both provider sessions without exporting credentials", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-sessions-"));
  try {
    const homes = { codex: NodePath.join(root, "codex"), claude: NodePath.join(root, "claude") };
    for (const [provider, home] of Object.entries(homes)) {
      const directory = NodePath.join(
        home,
        provider === "codex" ? "sessions/2026/09" : "projects/-workspace-repository",
      );
      await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(directory, "session.jsonl"),
        JSON.stringify({ text: "message subscription-secret" }) + "\n",
      );
      await NodeFSP.writeFile(NodePath.join(home, "auth.json"), '{"secret":"must-not-export"}');
    }
    const bundle = await exportSessions(homes, ["subscription-secret"]);
    expect(bundle.files).toHaveLength(2);
    expect(JSON.stringify(bundle)).not.toContain("subscription-secret");
    expect(JSON.stringify(bundle)).not.toContain("must-not-export");
    const targets = {
      codex: NodePath.join(root, "restored-codex"),
      claude: NodePath.join(root, "restored-claude"),
    };
    await restoreSessions(bundle, targets);
    expect(
      await NodeFSP.readFile(
        NodePath.join(targets.codex, "sessions/2026/09/session.jsonl"),
        "utf8",
      ),
    ).toContain("[redacted]");
    await expect(
      restoreSessions(
        { version: 1, files: [{ name: "codex/sessions/../../auth.jsonl", content: "{}" }] },
        targets,
      ),
    ).rejects.toThrow("path");
    await NodeFSP.symlink("/tmp", NodePath.join(homes.codex, "sessions/escape"));
    await expect(exportSessions(homes)).rejects.toThrow("symlink");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
it("extracts only the official device URL and code from CLI output", () => {
  expect(devicePrompt("https://evil.example/device ABCD-EFGH")).toBeNull();
  expect(devicePrompt("Open https://auth.openai.com/codex/device\nEnter ABCD-EFGH")).toEqual({
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  });
});

it("creates an isolated owner-only login cache beneath the accessible user home", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "vitre-login-test-"));
  try {
    const first = await createLoginHome(base, process.getuid(), process.getgid());
    const second = await createLoginHome(base, process.getuid(), process.getgid());
    expect(path.dirname(first)).toBe(base);
    expect(first).not.toBe(second);
    const info = await fs.stat(first);
    expect(info.mode & 0o777).toBe(0o700);
    expect(info.uid).toBe(process.getuid());
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
