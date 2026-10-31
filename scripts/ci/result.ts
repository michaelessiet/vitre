// @effect-diagnostics nodeBuiltinImport:off - Standalone CI entrypoint.
import * as NodeFS from "node:fs";

export function checkResults(needs: Record<string, { result: string }>, native: boolean): string[] {
  const expected = {
    changes: "success",
    check: "success",
    test: "success",
    native: native ? "success" : "skipped",
  };
  return Object.entries(expected)
    .filter(([job, result]) => needs[job]?.result !== result)
    .map(([job, result]) => `${job}: expected ${result}, got ${needs[job]?.result ?? "missing"}`);
}

if (import.meta.main) {
  const failures = checkResults(
    JSON.parse(process.env.CI_NEEDS!),
    process.env.NATIVE_CHECKS === "true",
  );
  NodeFS.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY!,
    failures.length
      ? `Validation failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`
      : "All required validation passed.\n",
  );
  if (failures.length) process.exitCode = 1;
}
