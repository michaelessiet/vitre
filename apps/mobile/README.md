# Vitre Mobile

Expo application for existing Vitre Cloud accounts, for iOS and Android. The phone uses the cloud control plane and worker connections directly; the desktop does not need to be running.

## Run

1. Copy `.env.example` to `.env.local`. Set the cloud deployment URL, its Clerk publishable key, and the relay JWT template name. The template defaults to `t3-relay` and must issue the audience accepted by the relay (`t3-code-relay` in the standard setup). These are public client settings; never put provider credentials, GitHub tokens, or Clerk secret keys here.
2. Install workspace dependencies with `pnpm install` from the repository root.
3. Run `pnpm --filter @t3tools/mobile ios` or `pnpm --filter @t3tools/mobile android`. This creates the ignored native projects and builds an Expo development client. Expo Go is not the supported runtime. Local Android builds need `ANDROID_HOME` pointing to the installed SDK and a compatible JDK; verification used JDK 17.
4. Sign in with an existing account allowed by the cloud deployment. Provider and private GitHub access use that account's existing connections.

To inspect the interface without cloud credentials, run `EXPO_PUBLIC_SHOWCASE=1 pnpm --filter @t3tools/mobile dev` and open the development client. This explicitly labelled fixture does not connect to the cloud. It is unavailable in release builds. It exercises navigation and forms, not real provisioning.

EAS development, preview, and production profiles are included. Set `EXPO_PUBLIC_EAS_PROJECT_ID` to this app's EAS project before building with push support. Configure that project's APNs/FCM credentials and the Clerk native OAuth callback `vitre://auth/callback`. No existing app's signing or EAS project is reused.

The shared app icon and iOS scene lifecycle are configured in `app.config.ts`. The local `withIosSceneLifecycle` plugin connects Expo 57's scene delegate to the generated native project; iOS 27 otherwise terminates the app at launch. Keep this plugin until Expo's prebuild template adopts scenes, and regenerate the native project after changing this configuration. Its focused regression test checks the installed SDK's template: `vp test run apps/mobile/plugins/withIosSceneLifecycle.test.ts`.

## Cloud rollout

Deploy the updated relay and rebuild the cloud worker image together. Existing account documents migrate lazily to a durable project/snapshot registry. There is no desktop dependency or project-name-based merge. Older deployments omit the new capability flags, and the app explains which features require an upgrade.

New GitHub conversations resolve and register the canonical repository before task creation. Registration and creation have separate persisted idempotency keys. Existing-project creation pins an immutable workspace snapshot; the worker copies it into a new workspace, creates a new primary Git branch, and starts fresh history and provider state. Older checkpoints are converted in the cloud using only workspace members. Conversion failures appear in preparation progress and can be retried with the original snapshot.

Cached history, drafts, and pending request receipts are separated by account and deployment. Offline messages require an explicit Send or retry after reconnecting. Signing out clears local data. Push uses a separate version-2 device registry with encrypted tokens, a durable delivery outbox, and Expo ticket/receipt processing; existing native APNs registration is unchanged.

## Focused verification

From the repository root:

```sh
vp test run apps/mobile/src/creation.test.ts apps/mobile/src/showcase.test.ts apps/mobile/src/cloudState.test.ts packages/client-runtime/src/cloud/repository.test.ts infra/relay/src/cloud/projects.test.ts infra/relay/src/cloud/service.test.ts infra/relay/src/cloud/github.test.ts infra/relay/src/cloud/notifications.test.ts scripts/vitre/cloud/checkpoint.test.mjs scripts/vitre/cloud/worker.test.mjs
```

Native acceptance on a deployment containing these changes:

1. Close Vitre on the desktop. On each phone platform, paste an unconfigured public GitHub URL, resolve it, choose a branch, and send a prompt. Verify provisioning, streaming, model/reasoning/permission choices, approvals, diff review, and publication access checks.
2. Choose an uploaded non-Git project (including an additional root) or a Git project with saved unpublished/staged/unstaged changes. Inspect the source and timestamp, choose a retained snapshot, and create another conversation. Confirm fresh history/session state and verify edits in the copy do not change the original workspace. Repeat while the source is working, stopped, archived, and deleted.
3. Interrupt the response after repository registration or task acceptance. Reopen the sheet and choose **Check and retry**; exactly one task should exist and its pinned snapshot/commit must be unchanged.
4. Background the app during work, then reopen it. Verify reconnection and cursor recovery. Disconnect networking, reopen cached conversations, edit a draft, and reconnect; nothing sends until explicitly submitted.
5. With EAS push credentials configured, verify completion and input-needed notifications on physical iOS/Android devices, tap routing, duplicate suppression, token rotation, and sign-out while offline.

The development fixture and local tests do not substitute for these deployed acceptance checks or physical-device push delivery.
