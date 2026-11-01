// @effect-diagnostics nodeBuiltinImport:off - Deployment CLI process boundary.
import * as NodeProcess from "node:process";
import * as Runtime from "effect/Runtime";

/** Alchemy's bundler can retain handles after all deployment scopes have closed. */
export const deploymentTeardown: Runtime.Teardown = (exit) => {
  Runtime.defaultTeardown(exit, (code) => NodeProcess.exit(code));
};
