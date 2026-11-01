// @effect-diagnostics globalConsole:off - Standalone HTTP deployment verification.
/** Catch a healthy but outdated Worker before recording a successful deployment. */
export async function verifyCloud(origin: string, request: typeof fetch = fetch) {
  const health = await request(new URL("/health", origin), {
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!health.ok || ((await health.json()) as { ok?: boolean }).ok !== true)
    throw new Error("Deployed cloud health check failed");
  for (const [path, expected] of [
    ["/v1/cloud/lens", 401],
    ["/account/github", 200],
  ] as const) {
    const response = await request(new URL(path, origin), {
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    await response.body?.cancel();
    if (response.status !== expected)
      throw new Error(`Deployed route ${path} returned ${response.status}; expected ${expected}`);
  }
}

if (import.meta.main) {
  await verifyCloud(process.argv[2]!);
  console.log("Cloud health, Lens, and GitHub account routes verified.");
}
