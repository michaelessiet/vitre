# Foundations

## Source of truth

| Concern                                         | Implementation                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| Dark/light colors, fonts, radii                 | [themes/vitre.json](../../crates/vitre-app/themes/vitre.json)       |
| Glass surfaces and popup tint                   | [glass.rs](../../crates/vitre-app/src/glass.rs)                     |
| Shared navigation geometry                      | [ui.rs](../../crates/vitre-app/src/ui.rs)                           |
| User font, transparency, and editor preferences | [client_settings.rs](../../crates/vitre-app/src/client_settings.rs) |
| Native font and theme setup                     | [main.rs](../../crates/vitre-app/src/main.rs)                       |
| App-specific outline icons                      | [assets.rs](../../crates/vitre-app/src/assets.rs)                   |

## Color and material

Read colors through `cx.theme()`. Choose by purpose: `foreground` for primary
text, `muted_foreground` for metadata, `border` for separators, `accent` for
selection, `primary` for primary actions, and `danger` for errors. Preserve the
paired foreground when using a semantic fill. Do not use a literal dark-mode
color in a feature component.

| Token              | Dark base   | Light base | Use                             |
| ------------------ | ----------- | ---------- | ------------------------------- |
| background         | `#000000`   | `#fcfcfc`  | Main canvas                     |
| foreground         | `#f1f3f7`   | `#27272a`  | Primary text and icons          |
| muted.foreground   | `#a3a3a3`   | `#71717b`  | Supporting text                 |
| popover.background | `#181818`   | `#ffffff`  | Floating surfaces               |
| accent.background  | `#191a1d`   | `#f4f4f5`  | Selected/active surface         |
| border             | `#ffffff14` | `#e4e4e7`  | Quiet separators                |
| primary.background | `#366ffb`   | `#1b4ed8`  | Primary action and focus family |

See [all visual samples](images/colors.svg). The table records base values;
`glass::apply_theme` adjusts live surface alpha. Use `glass::background`,
`glass::sidebar`, `glass::elevated`, and `glass::control` for their corresponding
layers. Keep the root clear and let the shared dialog/popover system supply
its backdrop. Painting another opaque panel inside a popup removes the material.
Opacity applies to the surface, leaving text and icons readable.

## Typography

- UI family: **DM Sans**, with the user's UI size (16 logical pixels by default).
- Code: use the editor's configured monospace family and size. The theme's
  monospace base is Menlo 13; the client editor preference defaults to 14.
- Main labels: regular weight; compact section titles may use semibold.
- Common utility hierarchy: `text_sm()` for labels and `text_xs()` for secondary
  information. At the default rem these are 14 and 12 logical pixels.
- Large type belongs to the workspace welcome/empty canvas. Pickers use compact
  titles and list text. Existing palette metadata has some 10–11 px exceptions;
  copy the matching component instead of inventing another scale.
- Truncate long row labels and metadata in a `min_w_0().flex_1()` region. Keep
  status, shortcuts, and action icons from shrinking. Meaningful details should
  remain available through search, detail views, or a tooltip.

## Geometry

The app uses logical pixels; a Retina screenshot contains twice as many physical
pixels. Measure against the source, rather than counting screenshot pixels.

| Element                     | Existing geometry                                  |
| --------------------------- | -------------------------------------------------- |
| Standard navigation icon    | 16 px (`ui::ICON`)                                 |
| File tree row / indent      | 28 px / 16 px                                      |
| Workspace chrome            | 44 px high                                         |
| Theme radius / large radius | 8 px / 12 px                                       |
| Search/command dialog       | 576 px wide, 72 px top margin                      |
| Command results viewport    | Up to 300 px high in the native palettes           |
| Common spacing              | 4, 8, 12, 16, 24 px through shared spacing helpers |

Use the existing component size variants and spacing helpers. Keep borders thin
and corners consistent within a family. Surface cards use equal columns, shared
padding, an outline icon, a title, and one muted description.

## Icons, motion, and accessibility

Use the shipped outline icon set through `Icon`/`IconName` or `VitreIcon`. Utility
icons inherit the text color and normally use `size_4()`; quiet trailing indicators
can use `size_3()`. Add accessible labels/tooltips for icon-only actions.

Use the shared dialog and transition behavior, including reduced motion. Provide
a visible focus/selection state. Status must include text or an icon with a label
so color alone is never required to understand it. Keep every action reachable
with the keyboard.
