//! Disposable Kotlin editor/LSP verification (debug builds only).
use super::*;
use gpui::Task;
use gpui_component::input::CompletionProvider as _;
use lsp_types::{CompletionContext, CompletionResponse, CompletionTriggerKind};

pub(super) const SOURCE: &str = "// Kotlin editor verification\nfun greet(name: String): String {\n    return \"Hello, $name\"\n}\n\nfun main() {\n    val message = greet(\"World\")\n    println(message)\n    val invalid: Int = \"wrong\"\n}\n";

impl FilesPanel {
    pub(crate) fn verification_kotlin_fixtures() -> &'static [(&'static str, &'static str)] {
        &[
            ("Main.kt", SOURCE),
            (
                "example.kts",
                "val greeting = \"Hello\"\nprintln(greeting)\n",
            ),
        ]
    }

    pub(crate) fn verify_kotlin(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        self.open_file("Main.kt".into(), window, cx);
        cx.spawn_in(window, async move |this, cx| {
            let executor = cx.background_executor().clone();
            let run = async {
                loop {
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                    if this.update(cx, |p, _| p.lsp.current_document().as_deref() == Some("Main.kt"))
                        .map_err(|e| e.to_string())? { break; }
                }
                let hover = this.update_in(cx, |p, window, cx| {
                    let text = p.editor.read(cx).text().clone();
                    let offset = SOURCE.find("greet(\"World\")").unwrap();
                    p.editor.update(cx, |s, cx| {
                        s.set_selected_range(offset..offset, cx);
                        s.focus(window, cx);
                    });
                    p.lsp.hover(&text, offset, window, cx)
                }).map_err(|e| e.to_string())?;
                let hover = hover.await.map_err(|e| e.to_string())?.ok_or("Kotlin hover was empty")?;
                if !format!("{:?}", hover.contents).contains("greet") { return Err("Kotlin hover did not resolve greet".into()); }
                let definitions = this.update_in(cx, |p, window, cx| {
                    let text = p.editor.read(cx).text().clone();
                    p.lsp.definitions(&text, SOURCE.find("greet(\"World\")").unwrap(), window, cx)
                }).map_err(|e| e.to_string())?;
                let definitions = definitions.await.map_err(|e| e.to_string())?;
                if !definitions.iter().any(|d| d.target_uri.as_str().ends_with("/Main.kt") && d.target_selection_range.start.line == 1) {
                    return Err(format!("Kotlin definition did not resolve: {definitions:?}"));
                }
                let completions = this.update_in(cx, |p, window, cx| {
                    let text = p.editor.read(cx).text().clone();
                    p.lsp.completions(&text, SOURCE.find("greet(\"World\")").unwrap() + 3,
                        CompletionContext { trigger_kind: CompletionTriggerKind::INVOKED, trigger_character: None }, window, cx)
                }).map_err(|e| e.to_string())?;
                let completions = completions.await.map_err(|e| e.to_string())?;
                let items = match completions { CompletionResponse::Array(items) => items, CompletionResponse::List(list) => list.items };
                if !items.iter().any(|item| item.label.contains("greet")) { return Err(format!("Kotlin completion missed greet: {items:?}")); }
                loop {
                    if this.update(cx, |p, _| p.diagnostics.get("Main.kt").is_some_and(|items| items.iter().any(|d| d.range.start.line.0 == 8)))
                        .map_err(|e| e.to_string())? { break; }
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                }
                eprintln!("[vitre-kotlin-test] PASS: native editor attached automatically; hover, definition, completion and streamed type-error diagnostics");
                cx.update(|window, cx| window.draw(cx).clear(cx)).map_err(|e| e.to_string())?;
                crate::chat::ui_verification::capture("kotlin-editor", cx).await?;
                Ok(())
            };
            tokio::select! {
                result = run => result,
                _ = executor.timer(Duration::from_secs(120)) => Err("Kotlin editor verification timed out".into()),
            }
        })
    }
}
