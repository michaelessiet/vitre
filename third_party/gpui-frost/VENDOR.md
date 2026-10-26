# Vendored GPUI scene capture

- Upstream: https://github.com/zed-industries/zed
- Revision: `f66ed399cdde86092af8af3dc7b418abf45f37f8`
- Packages: `gpui`, `gpui_apple`, `gpui_macos`, `gpui_platform`
- License: Apache-2.0, declared by each package; the upstream license is preserved in `LICENSE-APACHE`.

These four packages expose GPUI's existing renderer readback through a small
production `scene-capture` feature. Vitre uses that feature for frosted popup
backgrounds. It reads the application's completed GPUI scene rather than the
screen or another application's window, so it needs no screen recording access.

Upstream only exposes this path under `test-support`. Enabling that feature in
production would also enable entity leak tracking and test utilities. The new
feature does not enable `test-support`, `leak-detection`, or `screen-capture`.

## Local patch

`scene-capture.patch` records the scene-capture changes against the revision
above. Those runtime changes are limited to:

1. Exposing `Window::render_to_image` and the matching `PlatformWindow` method
   under `scene-capture`, retaining the unsupported-platform default error.
2. Exposing the macOS implementation and Metal renderer readback under the same
   feature, including the required RGBA imports.
3. Routing scene capture through the existing dedicated offscreen texture
   helper, which synchronizes managed storage before readback on discrete GPUs.
   Capture does not acquire presentation drawables or disable the live layer's
   framebuffer-only optimization.
4. Forwarding the feature through `gpui_platform`, `gpui_macos`, and
   `gpui_apple` to `gpui`.

The existing capture operation synchronously renders and reads a completed
scene. Callers should capture once when a popup opens, process its pixels away
from the UI thread, and cache the result until dismissal. The capture contains
GPUI primitives; it does not include native browser subviews or AppKit's
behind-window visual effect. Other platforms currently use the unsupported
fallback unless their normal renderer implementation supplies readback.

## Transparent window blending

The Metal color and path-sprite pipelines use source-over destination alpha
(`OneMinusSourceAlpha`) as well as source-over RGB. Upstream's additive alpha
made overlapping translucent fills opaque in a transparent native window.
The GPU regression in `metal_renderer::transparency_tests` reads back two
layered quads and checks their resulting alpha. Preserve this fix when
updating the vendored packages.

## Packaging

The complete normal Rust sources, shader sources, build scripts, README files,
and Windows resources are copied unchanged except for the changes above.
Examples, external test assets, and example target declarations are omitted.
Vitre's tests compile these crates as dependencies; this is not a distribution
of the upstream standalone GPUI test suite.

The separate workspace manifest preserves the selected upstream dependency
specifications and lints. It allows deprecation warnings inside these four
packages: their unchanged Cocoa bindings were previously covered by Cargo's
dependency lint cap, and their warning volume would obscure application
diagnostics after switching to local paths. Application lints are unchanged.
Dependencies that were paths inside Zed point to the
same exact Git revision, except these four packages, which reference each other
locally. The application workspace excludes this inner workspace and patches
the four Git packages to these paths, preserving a single GPUI type graph.
The application's existing `ztracing` replacement remains in effect.

When updating the Zed pin, recopy these packages, regenerate the selected
workspace dependency specifications, and reapply `scene-capture.patch`. Keep
the feature gates narrow; test and headless-renderer infrastructure must retain
their upstream gates. Run application-scoped verification from the repository
root so its patches and lockfile remain authoritative.
