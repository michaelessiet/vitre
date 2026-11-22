//! Uni (`.uni`) syntax highlighting.
//!
//! The grammar is vendored in `third_party/tree-sitter-uni` and registered
//! with the highlighter's registry at start-up, under the name
//! [`super::language_for_path`] yields for a `.uni` path and a ```` ```uni ````
//! fence carries. Registering here keeps the gpui-component fork's built-in
//! language set as upstream ships it.
use gpui_component::highlighter::{LanguageConfig, LanguageRegistry};

/// Registry name, file extension and LSP language id.
pub(crate) const LANGUAGE: &str = "uni";

/// The grammar's highlights under the capture names the themes style.
const HIGHLIGHTS: &str = include_str!("../../languages/uni/highlights.scm");

/// Add Uni to the highlighter registry. Idempotent.
///
/// No injections: Uni embeds no other language, and an interpolated
/// expression is part of its own syntax tree. No locals either, since the
/// highlights query marks no pattern as local-sensitive.
pub(crate) fn register() {
    LanguageRegistry::singleton().register(
        LANGUAGE,
        &LanguageConfig::new(
            LANGUAGE,
            tree_sitter_uni::LANGUAGE.into(),
            Vec::new(),
            HIGHLIGHTS,
            "",
            "",
        ),
    );
}
