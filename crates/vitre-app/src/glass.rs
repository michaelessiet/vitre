//! Shared tint colors for Vitre's native frosted window.
//!
//! AppKit supplies the macOS blur without GPUI's private layer rewriting.
//! GPUI supplies the blur on other platforms. These translucent theme
//! colors keep text readable while allowing the desktop color and light to
//! show through, in the same spirit as Cursor's macOS chrome.

use gpui::{App, Hsla};
use gpui_component::ActiveTheme as _;

use crate::client_settings::ClientSettings;

pub fn window_background() -> gpui::WindowBackgroundAppearance {
    if cfg!(target_os = "macos") {
        // Keep Metal transparent, but bypass GPUI's BlurredView subclass: it
        // rewrites private AppKit layers whose structure changes across OS releases.
        gpui::WindowBackgroundAppearance::Transparent
    } else {
        gpui::WindowBackgroundAppearance::Blurred
    }
}

#[cfg(target_os = "macos")]
pub fn install_window_effect(window: &gpui::Window) {
    use objc2::MainThreadOnly as _;
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
        NSVisualEffectState, NSVisualEffectView, NSWindowOrderingMode,
    };
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = HasWindowHandle::window_handle(window).expect("Vitre window handle");
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        unreachable!("macOS window must have an AppKit handle");
    };
    // SAFETY: GPUI exposes a live NSView for this window. Window creation runs
    // on the main thread, and the borrow does not outlive the window handle.
    let native_view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    let native_window = native_view.window().expect("attached GPUI window");
    let content = native_window.contentView().expect("GPUI content view");
    let effect = NSVisualEffectView::initWithFrame(
        NSVisualEffectView::alloc(content.mtm()),
        content.bounds(),
    );
    effect.setMaterial(NSVisualEffectMaterial::UnderWindowBackground);
    effect.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    effect.setState(NSVisualEffectState::Active);
    effect.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    // The superview retains the effect for the lifetime of the window. Keeping
    // it below the Metal content also leaves native browser children above it.
    content.addSubview_positioned_relativeTo(&effect, NSWindowOrderingMode::Below, None);
}

#[cfg(not(target_os = "macos"))]
pub fn install_window_effect(_: &gpui::Window) {}

/// A completely clear root lets every top-level pane composite directly onto
/// the platform blur rather than stacking two tints and becoming opaque.
pub fn root(cx: &App) -> Hsla {
    cx.theme().background.opacity(0.0)
}

pub fn background(cx: &App) -> Hsla {
    cx.theme()
        .background
        .opacity(ClientSettings::glass_opacity(cx))
}

pub fn sidebar(cx: &App) -> Hsla {
    cx.theme()
        .sidebar
        .opacity(ClientSettings::glass_opacity(cx))
}

/// Slightly denser than the main canvas so utility panes and floating controls
/// retain their hierarchy without losing the frosted character.
pub fn elevated(cx: &App) -> Hsla {
    cx.theme()
        .background
        .opacity((ClientSettings::glass_opacity(cx) + 0.08).min(1.0))
}

pub fn control(cx: &App) -> Hsla {
    cx.theme()
        .muted
        .opacity((ClientSettings::glass_opacity(cx) + 0.06).min(1.0))
}
