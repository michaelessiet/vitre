# Verification and maintenance

## Before implementing

1. Identify the component family and inspect its image and source.
2. Reuse the existing renderer and semantic tokens. Document an intentional new
   reusable pattern here when none fits.
3. Account for long labels, an empty collection, an error, and keyboard use while
   choosing the layout.

## Native verification

Launch Vitre with `vp run dev:vitre` and exercise the actual flow. Use a temporary
home with synthetic projects/conversations for captures. Follow the focused test
requirements in the repository's `AGENTS.md`.

- Check dark and light themes, readable glass, and the user's UI font scale.
- Check a narrow window, long names, and enough entries to require scrolling.
- For pickers: initial search focus, filtering, arrows, Enter, Escape, mouse
  selection, no results, and reopening after dismissal.
- For embedded content: switch back to the composer and type without sending a
  message; confirm that the device receives input only when focused.
- Verify loading/error states and transitions, as well as the successful state.
- Compare the new UI alongside the relevant existing component.
- Stop verification apps and watchers after the pass. A build intentionally left
  open for the user's requested testing is a separate handoff.

## Maintaining the images

Capture actual native UI with synthetic data. Keep complete screenshots so the
surrounding hierarchy is visible; link the full-size image for detailed inspection.
Do not include credentials, private conversation content, or customer projects.
Do not use generated mockups as evidence of implemented behavior.

Update [the image index](images/README.md) with the date, theme, state, and source
pattern whenever replacing a reference. Document base token changes in
[foundations](foundations.md) and regenerate the swatch sheet with:

```sh
node docs/design-language/render-colors.mjs
```

Keep images and documentation in the same change as a new shared pattern. Link the
guide from relevant feature documentation so the next contributor starts here.
