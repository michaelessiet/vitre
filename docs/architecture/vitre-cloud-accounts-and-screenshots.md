# Linked GitHub accounts and cloud screenshots

## One Vitre account on every device

The Clerk user ID is the Vitre account ID. Verified GitHub identities belong to
that user, alongside its other supported login methods. Linking is a one-time
account operation: signing in on mobile through either linked GitHub identity,
Google, or an email method already on the same Vitre account loads the same cloud
workspaces and GitHub account list. A separate Vitre account is not automatically
merged by matching an email address or a GitHub username.

Open **Settings → Cloud → GitHub accounts → Manage** on desktop, or **Settings →
GitHub accounts → Manage GitHub accounts** on mobile. Both open `/account/github`
on the relay. The browser must be signed in to the Vitre account that opened the
page. Link, reconnect, and remove use Clerk's verified external-account flow.
If Clerk requires a fresh session, the page offers **Sign in again**. An identity
already owned by another Vitre account must be resolved through account support;
this page does not transfer it.

Mobile refreshes linked identities after signing in and after returning from
account management. Desktop refreshes them when opening Cloud settings. An
explicit refresh action is also available.

### Repository access

- Each repository selection pins a Clerk external account ID (`githubAccountId`).
  Account display names are labels, never authorization keys.
- Discovery intersects repositories readable by that GitHub user with repositories
  installed on the Vitre GitHub App. Installing the app alone does not grant an
  unrelated Vitre user access.
- Execution rechecks the selected identity and immutable repository ID, then mints
  a repository-scoped, read-only installation token. Publication also requires the
  selected GitHub user's push permission before obtaining a write token. PRs are
  still published by the Vitre GitHub App.
- A missing or revoked identity cannot silently fall back to another account.
  When several identities can access a repository, choose an account explicitly
  or reuse its saved choice.
- Existing installation allowlists remain compatible. Anonymous public repository
  access carries no GitHub account ID.
- OAuth tokens stay in Clerk/server memory. Cloud overview data contains only
  account IDs, login names, and connection state.

GitHub OAuth needs the `repo` scope for private repositories, and the Vitre GitHub
App must be installed on those repositories. Organization restrictions and SSO
approval still apply. Reconnect an existing identity to grant missing scopes.

## Screenshots requested by the user

Cloud workers expose `cloud_screenshot` through the existing session-authenticated
MCP endpoint. It is absent from ordinary local backends. The tool requires the
session's preview capability and is described to agents as available when the
user requests a screenshot or visual verification.

Example request: “Implement the settings page, run it, and take a screenshot at
desktop and mobile widths.” The agent starts the frontend inside its workspace,
then calls the tool with its port, path, optional viewport, optional `fullPage`,
and an optional CSS selector to wait for. It receives an actual PNG image and a
unique `.vitre-screenshot-*/screenshot.png` path in the workspace to include in its
response. The workspace's normal checkpoint retention rules apply to saved files.

Each capture uses a fresh sandboxed Chromium process without an authenticated
browser profile. Navigation is restricted to the requested loopback origin;
Vitre's backend port and other loopback services are blocked. Ordinary external
subresources retain the worker's existing network policy. Capture time, viewport,
full-page dimensions, and PNG size are bounded; browser teardown runs on failure.
An app that requires login needs a test route or its own test authentication setup.

The worker image installs Chromium and system libraries for the exact installed
`playwright-core` version. `VITRE_CLOUD_SCREENSHOTS=true` is set by the worker;
`PLAYWRIGHT_BROWSERS_PATH` points to the image's shared, read-only browser files.
The Linux host must allow the user namespaces Chromium needs for its sandbox.
Docker's default seccomp profile blocks these; the image smoke test accepts
`VITRE_SMOKE_SECCOMP_PROFILE` for Playwright's namespace-enabled Docker profile.
Do not disable Chromium's sandbox to make the smoke test pass.

## Deployment and acceptance

Deploy the updated relay, native/mobile clients, and versioned worker runtime.
Existing resident workers need a drained runtime upgrade before they expose the
new screenshot tool. No additional credential database or data migration is
required: linked identities are owned by Clerk and cloud metadata is additive.

Focused automated coverage includes identity ownership, token selection,
repository access intersection, selected-account revocation, wrong-browser
account protection, mobile repository selection, MCP capability enforcement,
PNG persistence, and capture cleanup/limits. Native Cloud settings and mobile
Settings/account selection were exercised locally; account UI verification uses
development fixtures. The packaged Linux image passes backend authentication and
sandboxed Chromium PNG smoke checks.

Before release, complete a real two-account OAuth round trip on the deployed
Clerk instance: link personal/work GitHub identities, sign out, sign in through
each identity and another supported method on that same Vitre account, verify
both repository lists, then unlink one and verify its access is rejected. Also
request a screenshot from a deployed cloud conversation and open its saved file.
Local fixture tests do not substitute for this provider/deployment acceptance.

## References

- [Clerk account connection flow](https://clerk.com/docs/guides/development/custom-flows/account-updates/manage-sso-connections)
- [Clerk external accounts](https://clerk.com/docs/nextjs/reference/types/external-account)
- [GitHub installation access](https://docs.github.com/en/rest/apps/installations)
- [Playwright browser installation](https://playwright.dev/docs/browsers)
- [Playwright Docker sandbox configuration](https://playwright.dev/docs/docker)
