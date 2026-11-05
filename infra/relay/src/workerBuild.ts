export const relayWorkerBuild = {
  compatibility: {
    date: "2026-05-22",
    flags: ["nodejs_compat"],
  },
  // Remove complete unused schema initializers, including nested calls.
  // Bare error-matcher registrations must retain their side effects.
  build: { pure: { initializerPackages: ["@distilled.cloud/cloudflare"] } },
};
