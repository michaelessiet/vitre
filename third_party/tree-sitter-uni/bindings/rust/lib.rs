//! Uni language support for the [tree-sitter] parsing library.
//!
//! ```
//! let code = r#"
//! fn main() {
//!     print("hello {1 + 2}")
//! }
//! "#;
//! let mut parser = tree_sitter::Parser::new();
//! parser
//!     .set_language(&tree_sitter_uni::LANGUAGE.into())
//!     .expect("Error loading Uni parser");
//! let tree = parser.parse(code, None).unwrap();
//! assert!(!tree.root_node().has_error());
//! ```
//!
//! [tree-sitter]: https://tree-sitter.github.io/

use tree_sitter_language::LanguageFn;

extern "C" {
    fn tree_sitter_uni() -> *const ();
}

/// The tree-sitter [`LanguageFn`] for this grammar.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_uni) };

/// The syntax highlighting query.
pub const HIGHLIGHTS_QUERY: &str = include_str!("../../queries/highlights.scm");

/// The language injection query.
pub const INJECTIONS_QUERY: &str = include_str!("../../queries/injections.scm");

/// The local variable query.
pub const LOCALS_QUERY: &str = include_str!("../../queries/locals.scm");

/// The symbol tagging query.
pub const TAGS_QUERY: &str = include_str!("../../queries/tags.scm");

/// The indentation query (nvim-treesitter captures).
pub const INDENTS_QUERY: &str = include_str!("../../queries/indents.scm");

/// The folding query.
pub const FOLDS_QUERY: &str = include_str!("../../queries/folds.scm");

/// The text object query (nvim-treesitter-textobjects captures).
pub const TEXTOBJECTS_QUERY: &str = include_str!("../../queries/textobjects.scm");

#[cfg(test)]
mod tests {
    use tree_sitter::{Language, Parser, Query};

    fn language() -> Language {
        super::LANGUAGE.into()
    }

    #[test]
    fn can_load_grammar() {
        let mut parser = Parser::new();
        parser
            .set_language(&language())
            .expect("Error loading Uni parser");
    }

    #[test]
    fn parses_a_program() {
        let mut parser = Parser::new();
        parser.set_language(&language()).unwrap();
        let code = r#"
import math

struct Point {
    x: f64
    y: f64

    fn len(self): f64 {
        return math.sqrt(self.x * self.x + self.y * self.y)
    }
}

fn main() {
    const points = List<Point>.new()
    const longest = points
        .iter()
        .map((p) => p.len())
        .max() ?? 0.0
    print("longest: {longest:.2}")
}
"#;
        let tree = parser.parse(code, None).unwrap();
        let root = tree.root_node();
        assert_eq!(root.kind(), "source_file");
        assert!(!root.has_error(), "{}", root.to_sexp());
        assert_eq!(root.named_child_count(), 3);
    }

    #[test]
    fn reports_a_syntax_error() {
        let mut parser = Parser::new();
        parser.set_language(&language()).unwrap();
        let tree = parser.parse("fn main() { const = }\n", None).unwrap();
        assert!(tree.root_node().has_error());
    }

    #[test]
    fn queries_compile() {
        let language = language();
        for (name, source) in [
            ("highlights", super::HIGHLIGHTS_QUERY),
            ("injections", super::INJECTIONS_QUERY),
            ("locals", super::LOCALS_QUERY),
            ("tags", super::TAGS_QUERY),
            ("indents", super::INDENTS_QUERY),
            ("folds", super::FOLDS_QUERY),
            ("textobjects", super::TEXTOBJECTS_QUERY),
        ] {
            if let Err(e) = Query::new(&language, source) {
                panic!("{name}.scm: {e}");
            }
        }
    }
}
