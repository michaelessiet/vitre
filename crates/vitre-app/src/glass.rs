//! Shared tint colors for Vitre's native frosted window.
//!
//! AppKit supplies the macOS blur without GPUI's private layer rewriting.
//! GPUI supplies the blur on other platforms. These translucent theme
//! colors keep text readable while allowing the desktop color and light to
//! show through, in the same spirit as Cursor's macOS chrome.

mod backdrop;

use gpui::{App, Hsla};
use gpui_component::{ActiveTheme as _, Theme};

use crate::client_settings::ClientSettings;

/// Install the cached, blurred app backdrop used by floating surfaces.
pub fn install_popup_effect(cx: &mut App) {
    backdrop::install(cx);
}

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

/// Keep floating surfaces on the same glass setting as the window. Both token
/// forms are used by the component library (dialogs and menus use the color,
/// while tooltips use the renderable token).
pub fn apply_popup_theme(cx: &mut App) {
    let opacity = ClientSettings::glass_opacity(cx);
    apply_popup_opacity(Theme::global_mut(cx), opacity);
    Theme::sync_base(cx);
}

fn apply_popup_opacity(theme: &mut Theme, opacity: f32) {
    // Replace alpha: repeatedly editing opacity must not compound the tint.
    // A modest elevation keeps content readable while preserving the user's
    // transparency preference, including a genuinely opaque 100% setting.
    theme.popover = theme.popover.alpha((opacity + 0.08).clamp(0.0, 1.0));
    theme.tokens.popover = theme.popover.into();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn popup_opacity_tracks_glass_without_compounding_alpha() {
        let mut theme = Theme::default();
        let palette_color = gpui::hsla(0.6, 0.3, 0.2, 1.0);
        theme.popover = palette_color;

        apply_popup_opacity(&mut theme, 0.4);
        assert_eq!(theme.popover, palette_color.alpha(0.4 + 0.08));
        assert_eq!(theme.tokens.popover.color, theme.popover);
        assert_eq!(theme.tokens.popover.background, theme.popover.into());

        apply_popup_opacity(&mut theme, 0.4);
        assert_eq!(theme.popover, palette_color.alpha(0.4 + 0.08));
        apply_popup_opacity(&mut theme, 0.8);
        assert_eq!(theme.popover, palette_color.alpha(0.8 + 0.08));
        apply_popup_opacity(&mut theme, 1.0);
        assert_eq!(theme.popover, palette_color);
        assert_eq!(theme.tokens.popover.color, palette_color);
    }

    #[test]
    fn popup_opacity_preserves_the_new_palette_after_a_theme_change() {
        let mut theme = Theme::default();
        theme.popover = gpui::hsla(0.6, 0.3, 0.2, 1.0);
        apply_popup_opacity(&mut theme, 0.8);

        let light_popup = gpui::hsla(0.1, 0.05, 0.98, 1.0);
        theme.popover = light_popup;
        apply_popup_opacity(&mut theme, 0.8);

        assert_eq!(theme.popover, light_popup.alpha(0.8 + 0.08));
        assert_eq!(theme.tokens.popover.color, theme.popover);
        assert_eq!(theme.semantic_tokens().colors.surface, theme.popover);
    }
}
