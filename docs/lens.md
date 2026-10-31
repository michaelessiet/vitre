# Lens

Lens lives above projects in the desktop sidebar and mobile conversation drawer.
It reviews the connected account's conversations and projects, keeps its own chat,
and proposes follow-ups and cleanup.

## Using Lens

- **Review now** requests an immediate review, including when scheduled reviews are off.
- **Chat** accepts questions about recent progress, missed follow-ups, and cleanup. A request for a review in chat also runs the model against the current inventory.
- **Schedule & model** selects daily or weekly reviews, a weekday, wall-clock time, IANA time zone, and inactivity thresholds. Scheduling starts off; weekly Monday at 09:00 UTC is the initial form value. Nonexistent daylight-saving times are skipped; repeated wall times run once.
- **Most used connected model** is automatic. Search can select other models, including unused models from the bundled cloud catalog and models discovered on connected desktops. The current cloud runner supports Codex and Claude subscription accounts. An explicit selection is shared across devices and used for scheduled reviews, manual reviews, and chat.
- **Review cleanup** opens an explicit confirmation before an archive or project removal. Cancel leaves the item untouched. Project removal deletes Vitre records and saved cloud snapshots; repository and desktop files stay in place. Conversation archives are recoverable.

The automatic model ranking weights each conversation's current model by its number
of user turns. It is an estimate, not per-turn historical model attribution.
A busy provider, unavailable account, or exhausted compute allowance returns a
retryable user-visible error; Lens never silently switches a selected provider.

## Inventory and execution

The relay refreshes cloud conversation summaries. An authenticated desktop with
`VITRE_CLOUD_DESKTOP_ENABLED=true` syncs local inventory and read markers every
minute, independently of the schedule toggle. Lens displays each source's last
sync time. Local cleanup waits for the originating desktop to reconnect.

Inventory includes project/conversation titles, timestamps, current models and turn
counts, pending-input/activity flags, and bounded recent message excerpts (the last
six messages, up to 4,000 characters per conversation). A review uses at most 40
recent conversations per source and 80,000 characters of inventory context. Missing
or older excerpts are not proof of inactivity. A source may have at most 500
projects and 2,000 conversations; exceeding that limit fails explicitly. There
are at most 15 desktop sources plus cloud.

The shared reducer generates eligible candidates. Busy, queued, unread, pending-input,
recently changed, and stale/offline records are protected from cleanup. Partial
projects during a cloud handoff are excluded. The model can select only supplied
candidate IDs; it cannot execute cleanup. Approval is revalidated against current
activity and timestamps, including on the desktop immediately before dispatch.

Each review uses a dedicated auxiliary cloud job with an exclusive provider lease,
a bounded timeout/output, and a separate temporary home. Codex runs read-only with
shell/app/search capabilities disabled; Claude runs without tools or MCP servers.
Credentials are encrypted at rest and bootstrap/callbacks are fenced by worker token,
lease, and credential version. Failed callbacks cannot publish a purported review.

## Native inline visuals

Assistant messages can include a `vitre-visual` JSON fence with headline metrics and
up to eight selectable bar, line, metrics, table, or flow views. The shared
`visual_check` MCP tool validates data before display. Both clients render native
components and support data/source inspection, copying, and reset. There is no
HTML, JavaScript, network access, or command execution inside a visual.

The presentation follows Monocode's inline hierarchy: large headline figures,
quiet tabs and grids, unboxed content, and utility actions in an overflow menu.
The contract deliberately supports bounded data views rather than arbitrary
Monocode JavaScript programs. See the [design patterns](design-language/components.md).

Native Lens lists virtualize messages and cache parsed Markdown. The visual
extension registry has a stable revision, preventing reparsing during every scroll
frame. Mobile uses bounded `FlatList` windows and memoized message/visual components;
unchanged background polls preserve the current view.

## Development and rollout

Ship the relay, machine agent/runtime image, desktop server, and clients together.
The existing relay maintenance schedule drives due reviews; the cloud deployment
needs an enabled machine executor and a connected provider subscription. The image
already copies all cloud runner `.mjs` files, including `lens.mjs`.
This change does not deploy the relay or invoke a real model during local QA.

Explicit sample-data entry points (no account credentials or real cleanup):

```sh
node scripts/vitre/lens-preview.ts
VITRE_HOME=/tmp/vitre-lens-qa VITRE_LENS_PREVIEW=1 vp run dev:vitre
EXPO_PUBLIC_SHOWCASE=1 EXPO_PUBLIC_SHOWCASE_LENS=1 pnpm --filter @t3tools/mobile dev --port 8089
```

The native preview transport is compiled only in debug builds and binds to loopback.
Mobile showcase is gated by `__DEV__`. Stop the preview server and Metro after QA.

Focused tests cover manual runs with scheduling off, explicit unused-model selection,
schedule/time-zone rules, approval and stale-state guards, read tracking, local
inventory limits, isolated job credential fencing, and bounded visual parsing.
The native regression test renders a 200-message history and verifies that unchanged
frames do not reparse Markdown. Full provider execution and hosted scheduled runs
still require verification after deployment.

## Local QA

Verified in the native macOS app and the iPhone 17 Pro simulator (iOS 26.5), using
explicit sample data:

- Immediate review with scheduling off, chat submission, and updated review results.
- Search and selection of an unused model, saving the model and weekly schedule.
- Cleanup cancellation, confirmed sample archive, and updated counts.
- Inline chart views, negative and zero values, long titles, and scrolling.
- Desktop keyboard model selection, compact window layout, and empty mobile state.

The focused suite passed 89 TypeScript/JavaScript tests and two native Rust tests.
Scoped type checks, lint, formatting, and the native build passed. The scrolling
regression checks Markdown parse reuse and virtualization; no frame-rate benchmark
or physical-device performance measurement was performed.

Reference captures: [desktop overview](design-language/images/lens-desktop-overview.png),
[desktop visual](design-language/images/lens-desktop-visual.png),
[iPhone overview](design-language/images/lens-mobile-overview.jpg), and
[iPhone visual](design-language/images/lens-mobile-visual.jpg).
