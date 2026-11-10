# Component patterns

## Pick the existing family

| User task                              | Pattern                                                           | Native reference                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Search and choose a resource/action    | `CommandState`, `Command`, `CommandItem` in a `Dialog`            | [Command palette](../../crates/vitre-app/src/palette/command_palette.rs), [Devices](../../crates/vitre-app/src/chat/mobile.rs) |
| Find a file or content                 | Quick Search with result preview                                  | [quick_search.rs](../../crates/vitre-app/src/palette/quick_search.rs)                                                          |
| Choose a workspace surface             | Shared card grid                                                  | [right_panel.rs](../../crates/vitre-app/src/chat/right_panel.rs)                                                               |
| Perform an action                      | Shared `Button` and its size/variant                              | [Button](../../third_party/gpui-component/crates/ui/src/button/button.rs)                                                      |
| Edit settings or submit a form         | Shared input/form controls in the existing settings/dialog layout | [settings/forms.rs](../../crates/vitre-app/src/settings/forms.rs)                                                              |
| Explain an action or report its result | Shared tooltip or notification                                    | [polish.rs](../../crates/vitre-app/src/chat/polish.rs)                                                                         |
| Keep work alongside chat               | Dock surface with the shared tab strip                            | [right_panel.rs](../../crates/vitre-app/src/chat/right_panel.rs)                                                               |
| Follow a subagent or background task   | Agent card (inline and in the Agents dock surface)                | [subagents_ui.rs](../../crates/vitre-app/src/chat/subagents_ui.rs)                                                             |

## Searchable picker

![Command palette reference](images/command-palette-dark.png)

Use the command palette family for a list that can grow. It provides search,
selection, virtual scrolling, and keyboard confirmation.

**Anatomy:** compact optional context header → search field → left-aligned rows
→ quiet keyboard footer. Each row has a small leading icon, a flexible label
column, and an optional trailing state/action. Put runtime, location, provider,
or other disambiguation on the muted secondary line. Show raw identifiers only
when otherwise identical choices need distinguishing; keep them searchable.

**Implementation:** use `Command::bordered(false)` inside the existing zero-padding
dialog. Keep its background transparent so the dialog's material supplies the
surface. Use `CommandItem::label`/`keywords` even with custom row content so search
continues to work. Resolve confirmation against the original item index returned
by the component. Use [the shared footer](../../crates/vitre-app/src/palette/chrome.rs)
for arrow, Enter, and Escape hints. Focus the query after the dialog mounts.

**States:** show a helpful empty inventory message, a separate no-results message,
visible selection, and readable running/stopped labels. Escape closes the picker
even with text entered. Selecting a stopped device opens its panel with a starting
state, then connects when booting finishes. Errors should explain the next action.

**Avoid:** a stack of outlined, centered action buttons for selectable records;
concatenating every property into one equally prominent line; decorative badges
on every item; manually implementing arrow-key navigation and scroll behavior.

## Buttons and toolbar actions

Use `Button` variants consistently with adjacent actions. Quiet toolbar controls
normally use a small/extra-small ghost treatment; standalone secondary actions
use the existing outline treatment. Reserve primary styling for the main action
of the current task. Match icon, height, padding, and radius within a toolbar.

Keep labels brief and action-oriented. Disabled controls retain a readable label
and explain the reason where useful. A choice row uses the selection family above.

Device controls use extra-small ghost buttons. **Stop** shuts down the selected
device; the tab's **Close** disconnects the display. Show **Stopping…** in place
while shutdown is pending, disable duplicate actions and input, then display a
short stopped status with a path to start again. Shutdown failures remain visible
and allow a retry.

See the [running toolbar](images/device-toolbar-light.png) and
[stopped state](images/device-stopped-light.png) in the native app.

## Surface cards

![Surface card family in the workspace](images/workspace-dark.png)

Extend the existing surface-card renderer. Every card has the same icon position,
padding, title weight, border, hover state, and description style. Equal column
wrappers keep the final odd card at the same width as its neighbors. The Devices
card belongs to this family; its click can open a picker without changing its style.

## Dialogs, panels, and state

Use `WindowExt::open_dialog` and the shared dialog layer for modal work. The
component owns material, entrance/resize motion, dismissal, and focus behavior.
Forms may use the normal title/body/footer layout. Searchable choice dialogs use
the compact command layout. Constrain growing content to a real scroll viewport.

Dock panels preserve the surrounding conversation. Keep their title and actions
in the shared toolbar scale. Loading, starting, empty, and error states need short,
specific copy. A device boot should remain visibly in progress until it is ready;
buttons that need an active connection stay disabled during startup.

The chat composer owns typing whenever it is focused. Embedded native views must
release keyboard focus when a picker or text input is selected. Verify this in
the native application because a static image cannot establish input routing.

## Agent cards

A subagent or background task is one card, drawn in place of the tool call
that launched it and again in the dock's **Agents** surface. State comes from
`vitre_state::subagents`.

**Anatomy:** outline icon (`Bot` for an agent, terminal for a background
task) → title (`Type · task`) over a muted meta line (status glyph, status,
elapsed, tools, tokens) → trailing extra-small ghost **Stop** while active →
chevron. One muted live line sits under the header: the small-model summary
while running, the result once finished. Several agents launched by one call
stack under a quiet `Running N of M agents` label.

**Expanded:** the task prompt, then the transcript on the work-row guide line
(`border-l`, `ml_6`): text and reasoning as short labelled paragraphs, tool
calls as icon + name + mono detail + result glyph. Only the latest steps show;
`Show N earlier steps` reveals the rest.

**States:** Stop changes to a disabled **Stopping…** until the provider
reports the end; a failed stop request restores the button and reports the
error. The Agents surface splits **Running** from **Finished** and has an empty
state. Colors are semantic: primary while running, warning when queued or
paused, success, danger, and muted when stopped.

## Inline visuals

Assistant messages can include a `vitre-visual` JSON fence. The shared
`visual_check` MCP tool validates its data before display, and the desktop
renders it with native components; there is no HTML, JavaScript, network
access, or command execution inside a visual.

[Inline visuals](../../crates/vitre-app/src/visuals.rs) use a small title and
provenance, large headline figures, quiet view tabs, a compact chart, and an
overflow menu for data/source/copy/reset. Avoid boxing every visual in a
contrasting card or filling a toolbar with utility actions. Use theme accents
sparingly and retain an equivalent data view.

Virtualize growing histories. Reuse the stable Markdown extension registry and
cached parsed message state; registering a fresh plugin each frame invalidates
Markdown and makes scrolling expensive.
