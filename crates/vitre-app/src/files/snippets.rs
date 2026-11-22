//! Built-in and user-authored snippets; data only, no executable expressions.
use super::*;
use gpui_component::WindowExt as _;

#[derive(Clone)]
struct Snippet {
    title: String,
    prefix: String,
    body: String,
}

fn snippet_language(language: &str) -> &str {
    match language {
        "ts" | "mts" | "cts" => "typescript",
        "js" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" | "pyi" | "pyw" => "python",
        other => other,
    }
}

fn defaults(language: &str) -> Vec<Snippet> {
    let rows: &[(&str, &str, &str)] = match snippet_language(language) {
        "tsx" | "jsx" | "javascript" | "typescript" => &[
            (
                "Arrow function",
                "fn",
                "const ${1:name} = (${2:args}) => {\n  $0\n};",
            ),
            (
                "Export React component",
                "component",
                "export function ${1:Component}(${2:props}) {\n  return <${3:div}>$0</$3>;\n}",
            ),
            (
                "React state",
                "state",
                "const [${1:value}, ${2:setValue}] = useState(${3:initialValue});$0",
            ),
            ("Console log", "log", "console.log(${1:value});$0"),
            (
                "Async function",
                "async",
                "async function ${1:name}(${2:args}) {\n  $0\n}",
            ),
            (
                "For of loop",
                "for",
                "for (const ${1:item} of ${2:items}) {\n  $0\n}",
            ),
        ],
        "rust" => &[
            (
                "Function",
                "fn",
                "fn ${1:name}(${2:args}) -> ${3:()} {\n    $0\n}",
            ),
            (
                "Unit test",
                "test",
                "#[test]\nfn ${1:test_name}() {\n    $0\n}",
            ),
            ("Implementation", "impl", "impl ${1:Type} {\n    $0\n}"),
            (
                "Match expression",
                "match",
                "match ${1:value} {\n    ${2:pattern} => $0,\n}",
            ),
        ],
        "python" => &[
            ("Function", "def", "def ${1:name}(${2:args}):\n    $0"),
            (
                "Class",
                "class",
                "class ${1:Name}:\n    def __init__(self, ${2:args}):\n        $0",
            ),
            (
                "Main entry point",
                "main",
                "if __name__ == \"__main__\":\n    $0",
            ),
        ],
        "go" => &[(
            "Function",
            "func",
            "func ${1:Name}(${2:args}) ${3:error} {\n\t$0\n}",
        )],
        // The Uni editor extensions' snippets, at `uni fmt`'s four spaces.
        "uni" => &[
            (
                "Function",
                "fn",
                "fn ${1:name}(${2}): ${3:void} {\n    $0\n}",
            ),
            (
                "Async function",
                "async fn",
                "async fn ${1:name}(${2}): ${3:Result<void>} {\n    $0\n}",
            ),
            (
                "Exported function",
                "export fn",
                "export fn ${1:name}(${2}): ${3:void} {\n    $0\n}",
            ),
            ("Main entry point", "main", "fn main() {\n    $0\n}"),
            (
                "Struct",
                "struct",
                "struct ${1:Name} {\n    ${2:field}: ${3:i64}\n\n    fn ${4:method}(self) {\n        $0\n    }\n}",
            ),
            (
                "Enum",
                "enum",
                "enum ${1:Name} {\n    ${2:First}\n    ${3:Second}(${4:value}: ${5:i64})\n}",
            ),
            (
                "Match statement",
                "match",
                "match ${1:value} {\n    ${2:Pattern} => ${3:result}\n    _ => $0\n}",
            ),
            (
                "Test block",
                "test",
                "test \"${1:what it checks}\" {\n    assert $0\n}",
            ),
            (
                "For loop",
                "for",
                "for ${1:item} in ${2:items} {\n    $0\n}",
            ),
            (
                "If const",
                "if const",
                "if const ${1:value} = ${2:optional} {\n    $0\n}",
            ),
        ],
        _ => &[("TODO comment", "todo", "${1:TODO}: $0")],
    };
    rows.iter()
        .map(|(title, prefix, body)| Snippet {
            title: (*title).into(),
            prefix: (*prefix).into(),
            body: (*body).into(),
        })
        .collect()
}

fn custom_snippets(source: &str, language: &str) -> anyhow::Result<Vec<Snippet>> {
    let definitions: std::collections::BTreeMap<String, serde_json::Value> =
        serde_json::from_str(source)?;
    definitions
        .into_iter()
        .filter_map(|(title, definition)| {
            if let Some(scope) = definition.get("scope").and_then(|v| v.as_str())
                && !scope
                    .split(',')
                    .any(|s| snippet_language(s.trim()) == snippet_language(language))
            {
                return None;
            }
            Some((|| {
                let prefix = definition
                    .get("prefix")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&title)
                    .to_string();
                let body = match definition.get("body") {
                    Some(serde_json::Value::String(body)) => body.clone(),
                    Some(serde_json::Value::Array(lines)) => lines
                        .iter()
                        .map(|v| {
                            v.as_str().ok_or_else(|| {
                                anyhow::anyhow!("{title}: snippet lines must be strings")
                            })
                        })
                        .collect::<anyhow::Result<Vec<_>>>()?
                        .join("\n"),
                    _ => anyhow::bail!("{title}: missing snippet body"),
                };
                Ok(Snippet {
                    title,
                    prefix,
                    body,
                })
            })())
        })
        .collect()
}

struct SnippetPicker {
    owner: WeakEntity<FilesPanel>,
    generation: u64,
    selection: std::ops::Range<usize>,
    source: ropey::Rope,
    filter: Entity<InputState>,
    items: Vec<Snippet>,
    _subscription: Subscription,
}

impl Render for SnippetPicker {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self.filter.read(cx).value().to_lowercase();
        v_flex().gap_2().child(Input::new(&self.filter)).child(
            v_flex().id("snippet-list").max_h(px(380.)).overflow_y_scrollbar().children(self.items.iter().enumerate().filter(|(_, item)| format!("{} {}", item.title, item.prefix).to_lowercase().contains(&query)).map(|(i, item)| {
                let body = item.body.clone();
                Button::new(("snippet", i)).ghost().justify_start().label(format!("{}   ·   {}", item.title, item.prefix)).on_click(cx.listener(move |picker, _, window, cx| {
                    let inserted = picker.owner.update(cx, |panel, cx| {
                        if panel.open_generation != picker.generation || panel.editor.read(cx).text() != &picker.source {
                            window.push_notification("The document changed while the snippet picker was open.", cx); return false;
                        }
                        panel.editor.update(cx, |state, cx| {
                            state.set_selected_range(picker.selection.clone(), cx);
                            match state.insert_snippet(&body, window, cx) {
                                Ok(()) => true,
                                Err(error) => { window.push_notification(error, cx); false }
                            }
                        })
                    }).unwrap_or(false);
                    if inserted {
                        window.close_dialog(cx);
                        let _ = picker.owner.update(cx, |panel, cx| panel.editor.update(cx, |s, cx| s.focus(window, cx)));
                    }
                }))
            }))
        )
    }
}

impl FilesPanel {
    pub(super) fn show_snippets(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(open) = &self.open else {
            return;
        };
        if !self.editor.read(cx).is_editable() {
            return;
        }
        let language = language_for_path(&open.relative_path);
        let mut items = defaults(&language);
        let source = self.editor.read(cx).text().clone();
        let selection = self.editor.read(cx).selected_range();
        let generation = self.open_generation;
        let client = self.client.clone();
        let cwd = self.cwd.clone();
        cx.spawn_in(window, async move |this, cx| {
            let custom = client
                .call::<ProjectsReadFile>(&ProjectReadFileInput {
                    cwd: tnes(cwd),
                    relative_path: tnes(".vitre/snippets.json"),
                })
                .await;
            let _ = this.update_in(cx, |_, window, cx| {
                if let Ok(file) = custom {
                    match custom_snippets(&file.contents.0, &language) {
                        Ok(custom) => items.extend(custom),
                        Err(error) => window.push_notification(
                            format!("Invalid .vitre/snippets.json: {error}"),
                            cx,
                        ),
                    }
                }
                let owner = this.clone();
                let picker = cx.new(|cx| {
                    let filter =
                        cx.new(|cx| InputState::new(window, cx).placeholder("Search snippets…"));
                    let subscription = cx.observe(&filter, |_, _, cx| cx.notify());
                    SnippetPicker {
                        owner,
                        generation,
                        source,
                        selection,
                        filter,
                        items,
                        _subscription: subscription,
                    }
                });
                let focus = picker.read(cx).filter.read(cx).focus_handle(cx);
                window.open_dialog(cx, move |dialog, _, _| {
                    dialog
                        .title("Insert snippet")
                        .w(px(520.))
                        .child(picker.clone())
                });
                window.on_next_frame(move |window, cx| focus.focus(window, cx));
            });
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every Uni built-in, with its defaults in place, is a Uni program.
    #[test]
    fn uni_snippets_expand_to_valid_source() {
        use gpui_component::highlighter::SyntaxHighlighter;
        uni::register();
        let placeholder = regex::Regex::new(r"\$\{\d+(?::([^}]*))?\}").unwrap();
        let items = defaults(&language_for_path("src/main.uni"));
        for prefix in [
            "fn",
            "async fn",
            "export fn",
            "main",
            "struct",
            "enum",
            "match",
            "test",
            "for",
            "if const",
        ] {
            let item = items
                .iter()
                .find(|item| item.prefix == prefix)
                .unwrap_or_else(|| panic!("missing Uni snippet {prefix:?}"));
            let source = placeholder
                .replace_all(&item.body, "$1")
                .replace("$0", "true");
            assert!(!source.contains('\t'), "{prefix}: Uni indents with spaces");
            // Statements only parse inside a function.
            let source = if source.starts_with("match")
                || source.starts_with("for")
                || source.starts_with("if")
            {
                format!("fn probe(value: i64, items: List<i64>, optional: i64) {{\n{source}\n}}\n")
            } else {
                format!("{source}\n")
            };
            let mut parser = SyntaxHighlighter::try_new(uni::LANGUAGE).unwrap();
            parser.update(None, &ropey::Rope::from(source.as_str()), None);
            let root = parser.tree().unwrap().root_node();
            assert!(!root.has_error(), "{prefix}: {source}\n{}", root.to_sexp());
        }
    }

    #[test]
    fn custom_snippets_filter_language_and_accept_multiline_bodies() {
        let items = custom_snippets(r#"{"test":{"prefix":"t","scope":"rust,tsx","body":["${1:name}","$0"]},"python":{"scope":"python","body":"def $0"}}"#, "tsx").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].body, "${1:name}\n$0");
        assert!(custom_snippets(r#"{"bad":{"body":[42]}}"#, "tsx").is_err());
        for (path, title) in [
            ("main.ts", "Arrow function"),
            ("main.cts", "Arrow function"),
            ("main.rs", "Function"),
            ("main.py", "Function"),
            ("App.tsx", "Export React component"),
            ("main.uni", "If const"),
        ] {
            assert!(
                defaults(&language_for_path(path))
                    .iter()
                    .any(|item| item.title == title),
                "Missing built-ins for {path}"
            );
        }
        assert_eq!(
            custom_snippets(r#"{"test":{"scope":"typescript","body":"$0"}}"#, "ts")
                .unwrap()
                .len(),
            1
        );
    }
}
