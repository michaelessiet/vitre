import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { childEnvironment } from "./worker.mjs";

export const lensReplySchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "recommendations"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 16000 },
    recommendations: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "reason"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 1024 },
          reason: { type: "string", maxLength: 16000 },
        },
      },
    },
  },
};

export function lensArguments(provider, model, schemaPath, outputPath) {
  if (provider === "codex")
    return [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--disable",
      "shell_tool",
      "--disable",
      "apply_patch_freeform",
      "--disable",
      "multi_agent",
      "--disable",
      "apps",
      "--config",
      'web_search="disabled"',
      "--model",
      model,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-",
    ];
  if (provider === "claude")
    return [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(lensReplySchema),
      "--model",
      model,
      "--tools",
      "",
      "--disallowedTools",
      "mcp__*",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--no-session-persistence",
    ];
  throw new Error("Unsupported Lens provider");
}

export function parseLensReply(value) {
  const reply = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !reply ||
    typeof reply.text !== "string" ||
    !reply.text.trim() ||
    reply.text.length > 16000 ||
    !Array.isArray(reply.recommendations) ||
    reply.recommendations.length > 100 ||
    reply.recommendations.some(
      (entry) =>
        !entry ||
        typeof entry.id !== "string" ||
        !entry.id ||
        entry.id.length > 1024 ||
        typeof entry.reason !== "string" ||
        entry.reason.length > 16000,
    )
  ) {
    throw new Error("Lens returned an invalid review");
  }
  return {
    text: reply.text,
    recommendations: reply.recommendations.map(({ id, reason }) => ({ id, reason })),
  };
}

async function runModel(binary, args, options, prompt, timeout) {
  const child = NodeChildProcess.spawn(binary, args, {
    ...options,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(stop, timeout);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (Buffer.byteLength(output) > 1024 * 1024) stop();
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0 || Buffer.byteLength(output) > 1024 * 1024)
      throw new Error("Lens model did not complete");
    return output;
  } finally {
    clearTimeout(timer);
    stop();
  }
}

/** One disposable, unprivileged home; no user project or supervisor credentials are inherited. */
export async function runLensModel(bootstrap, timeout) {
  const { provider, model } = bootstrap.model;
  if (
    typeof model !== "string" ||
    !model ||
    model.length > 200 ||
    typeof bootstrap.prompt !== "string" ||
    bootstrap.prompt.length > 300000
  )
    throw new Error("Invalid Lens request");
  const home = await NodeFSP.mkdtemp("/home/vitre/.lens-");
  const owned = async (path, contents) => {
    await NodeFSP.writeFile(path, contents, { mode: 0o600 });
    await NodeFSP.chown(path, 10001, 10001);
  };
  try {
    await NodeFSP.chmod(home, 0o700);
    await NodeFSP.chown(home, 10001, 10001);
    const schemaPath = NodePath.join(home, "reply-schema.json");
    const outputPath = NodePath.join(home, "reply.json");
    await owned(schemaPath, JSON.stringify(lensReplySchema));
    const env = { ...childEnvironment(home) };
    if (provider === "codex") {
      const auth = JSON.parse(bootstrap.credential);
      if (auth.OPENAI_API_KEY || !auth.tokens?.refresh_token)
        throw new Error("Subscription login required");
      env.CODEX_HOME = home;
      await owned(NodePath.join(home, "auth.json"), bootstrap.credential);
    } else if (provider === "claude" && bootstrap.credential.startsWith("sk-ant-oat")) {
      env.CLAUDE_CONFIG_DIR = home;
      env.CLAUDE_CODE_OAUTH_TOKEN = bootstrap.credential;
    } else throw new Error("Subscription login required");
    const output = await runModel(
      provider === "codex" ? "codex" : "claude",
      lensArguments(provider, model, schemaPath, outputPath),
      { cwd: home, env, uid: 10001, gid: 10001 },
      bootstrap.prompt,
      Math.min(timeout, 300000),
    );
    if (provider === "codex") {
      if ((await NodeFSP.stat(outputPath)).size > 1024 * 1024)
        throw new Error("Lens reply exceeded its size limit");
      return {
        reply: parseLensReply(await NodeFSP.readFile(outputPath, "utf8")),
        credential: await NodeFSP.readFile(NodePath.join(home, "auth.json"), "utf8"),
      };
    }
    const envelope = JSON.parse(output);
    return { reply: parseLensReply(envelope.structured_output ?? envelope.result) };
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
}
