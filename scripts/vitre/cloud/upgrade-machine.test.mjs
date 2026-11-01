import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

it("verifies runtime isolation, archive validation, and activation rollback", () => {
  const result = NodeChildProcess.spawnSync(
    "python3",
    [NodeURL.fileURLToPath(new URL("./upgrade-machine-test.py", import.meta.url))],
    { encoding: "utf8", timeout: 20_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it("pulls only verified releases and retries failed activation without rollback to stale pointers", () => {
  const result = NodeChildProcess.spawnSync(
    "python3",
    [NodeURL.fileURLToPath(new URL("./pull-runtime-test.py", import.meta.url))],
    { encoding: "utf8", timeout: 20_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
