# Vendored: tree-sitter-uni

- Source: https://github.com/michaelessiet/uni-lang, directory `editors/tree-sitter-uni`
- Revision: `6bb59ee6c50b434e054e5e8cd6e5cd46fce8f0e6`
- License: MIT (declared by the upstream crate manifest and `package.json`; see LICENSE).

The tree-sitter grammar for the Uni language (`.uni`), vendored as a path
dependency because the grammar is not yet on the default branch of its
repository. Vitre registers it with the editor's highlighter at start-up
(`crates/vitre-app/src/files/uni.rs`).

Copied verbatim: `grammar.js`, `src/parser.c`, `src/scanner.c`,
`src/tree_sitter/`, `queries/`, `bindings/rust/build.rs`.

Local adaptations:

- `Cargo.toml`: `publish = false`, the `tree-sitter` dev-dependency moved from
  0.25 to 0.26 (the version the gpui-component fork resolves), packaging
  metadata dropped.
- `bindings/rust/lib.rs`: the `NODE_TYPES` constant is removed together with
  `src/node-types.json` and `src/grammar.json`, which nothing here reads; the
  rest is formatted for this workspace's rustfmt and Clippy gates.
- The Node binding, the corpus tests and the editor-query generator are not
  included.

`queries/highlights.scm` uses Neovim capture names. The query Vitre loads is
`crates/vitre-app/languages/uni/highlights.scm`, the same patterns under the
capture names Vitre's themes style.

To update: copy the files listed above from the new revision, regenerate
nothing (`src/parser.c` is committed upstream, ABI 14), update the revision
here, re-derive Vitre's highlights query from upstream's
`editors/zed/languages/uni/highlights.scm`, and run
`cargo test -p tree-sitter-uni` and the `language_support_uni` tests.
