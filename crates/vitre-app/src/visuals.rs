//! Native, data-only inline visuals inspired by Monocode's native visual surfaces.
use gpui::*;
use gpui_component::{
    ActiveTheme as _, IconName, Selectable as _, Sizable as _, StyledExt as _,
    button::{Button, ButtonVariants as _},
    chart::{BarChart, LineChart},
    h_flex,
    menu::{DropdownMenu as _, PopupMenuItem},
    text::{MarkdownNode, MarkdownParseContext, MarkdownPlugin, TextView, markdown_ast},
    v_flex,
};
use serde::Deserialize;
use std::{
    hash::{Hash, Hasher},
    sync::LazyLock,
};

/// Register once. A fresh registry has a fresh revision and forces every TextView
/// to discard its parsed document on every frame (including scroll frames).
pub(crate) fn markdown_extensions() -> gpui_component::text::MarkdownExtensions {
    static EXTENSIONS: LazyLock<gpui_component::text::MarkdownExtensions> =
        LazyLock::new(|| gpui_component::text::MarkdownExtensions::default().plugin(VisualPlugin));
    EXTENSIONS.clone()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct VisualSpec {
    version: u8,
    title: String,
    #[serde(default)]
    description: String,
    views: Vec<VisualView>,
    #[serde(default)]
    metrics: Vec<Point>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VisualView {
    label: String,
    kind: String,
    #[serde(default)]
    points: Vec<Point>,
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default)]
    rows: Vec<Vec<String>>,
    #[serde(default)]
    steps: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Point {
    label: String,
    value: f64,
}
pub(crate) fn parse(source: &str) -> Result<VisualSpec, String> {
    if source.len() > 65536 {
        return Err("Visuals must be smaller than 64 KiB.".into());
    }
    let spec: VisualSpec = serde_json::from_str(source)
        .map_err(|_| "The visual is incomplete or has an unsupported format.".to_owned())?;
    let label = |value: &str| value.encode_utf16().count() <= 200;
    if spec.version != 1
        || !label(&spec.title)
        || spec.description.encode_utf16().count() > 1000
        || spec.metrics.len() > 8
        || spec
            .metrics
            .iter()
            .any(|p| !label(&p.label) || !p.value.is_finite() || p.value.abs() > 1e12)
        || spec.views.is_empty()
        || spec.views.len() > 8
    {
        return Err("Unsupported visual version or size.".into());
    }
    for view in &spec.views {
        if !label(&view.label)
            || view.points.len() > 64
            || view.columns.len() > 8
            || view.rows.len() > 64
            || view.steps.len() > 32
            || view
                .points
                .iter()
                .any(|p| !label(&p.label) || !p.value.is_finite() || p.value.abs() > 1e12)
            || view.columns.iter().chain(&view.steps).any(|s| !label(s))
            || view
                .rows
                .iter()
                .any(|row| row.len() > 8 || row.iter().any(|s| !label(s)))
        {
            return Err("This visual exceeds the supported size.".into());
        }
        match view.kind.as_str() {
            "bar" | "line" | "metrics" if !view.points.is_empty() => {}
            "table"
                if !view.columns.is_empty()
                    && view.rows.iter().all(|r| r.len() == view.columns.len()) => {}
            "flow" if !view.steps.is_empty() => {}
            _ => return Err("This visual needs valid data for its view type.".into()),
        }
    }
    Ok(spec)
}

pub(crate) struct VisualPlugin;
impl MarkdownPlugin for VisualPlugin {
    fn is_block(&self) -> bool {
        true
    }
    fn name(&self) -> &str {
        "vitre-visual"
    }
    fn parse(
        &self,
        node: &markdown_ast::Node,
        cx: &MarkdownParseContext<'_>,
    ) -> Option<MarkdownNode> {
        let markdown_ast::Node::Code(code) = node else {
            return None;
        };
        if code.lang.as_deref() != Some("vitre-visual") {
            return None;
        }
        // Retain source and validation failures in the transcript so nothing disappears silently.
        Some(
            MarkdownNode::new("vitre-visual", code.value.clone())
                .text(code.value.clone())
                .markdown(cx.node_source(node).unwrap_or_default()),
        )
    }
    fn render(&self, node: &MarkdownNode, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let source = node.data::<String>().cloned().unwrap_or_default();
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        source.hash(&mut hash);
        window.use_keyed_state(format!("visual-{}", hash.finish()), cx, |_, _| {
            VisualPanel::new(source)
        })
    }
}
struct VisualPanel {
    source: String,
    spec: Result<VisualSpec, String>,
    selected: usize,
    show_source: bool,
    show_data: bool,
}
impl VisualPanel {
    fn new(source: String) -> Self {
        Self {
            spec: parse(&source),
            source,
            selected: 0,
            show_source: false,
            show_data: false,
        }
    }
}
impl Render for VisualPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let owner = cx.weak_entity();
        let mut body = v_flex().w_full().min_w_0().gap_4().py_4();
        body = body.child(
            h_flex()
                .gap_2()
                .child(
                    div().flex_1().min_w_0().text_sm().font_medium().child(
                        self.spec
                            .as_ref()
                            .map_or("Visualization", |s| s.title.as_str())
                            .to_owned(),
                    ),
                )
                .child(
                    Button::new("visual-options")
                        .xsmall()
                        .ghost()
                        .icon(IconName::Ellipsis)
                        .tooltip("Visualization options")
                        .dropdown_menu(move |menu, _, _| {
                            let source = owner.clone();
                            let copy = owner.clone();
                            let reset = owner.clone();
                            let data = owner.clone();
                            menu.item(PopupMenuItem::new("View source / visual").on_click(
                                move |_, _, cx| {
                                    let _ = source.update(cx, |panel, cx| {
                                        panel.show_source = !panel.show_source;
                                        cx.notify();
                                    });
                                },
                            ))
                            .item(PopupMenuItem::new("Copy source").on_click(move |_, _, cx| {
                                let _ = copy.update(cx, |panel, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(
                                        panel.source.clone(),
                                    ))
                                });
                            }))
                            .item(PopupMenuItem::new("Show data / chart").on_click(
                                move |_, _, cx| {
                                    let _ = data.update(cx, |panel, cx| {
                                        panel.show_data = !panel.show_data;
                                        panel.show_source = false;
                                        cx.notify();
                                    });
                                },
                            ))
                            .item(
                                PopupMenuItem::new("Reset view").on_click(move |_, _, cx| {
                                    let _ = reset.update(cx, |panel, cx| {
                                        panel.selected = 0;
                                        panel.show_source = false;
                                        panel.show_data = false;
                                        cx.notify();
                                    });
                                }),
                            )
                        }),
                ),
        );
        if self.show_source {
            return body.child(TextView::markdown(
                "visual-json",
                format!("```json\n{}\n```", self.source),
            ));
        }
        let spec = match &self.spec {
            Ok(spec) => spec,
            Err(error) => {
                return body.child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().danger)
                        .child(error.clone()),
                );
            }
        };
        if !spec.description.is_empty() {
            body = body.child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(spec.description.clone()),
            );
        }
        if !spec.metrics.is_empty() {
            body = body.child(h_flex().flex_wrap().gap_6().py_2().children(
                spec.metrics.iter().map(|metric| {
                    v_flex()
                        .min_w(px(100.))
                        .flex_1()
                        .gap_2()
                        .child(
                            div()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child(metric.label.clone()),
                        )
                        .child(
                            div()
                                .text_3xl()
                                .font_semibold()
                                .child(metric.value.to_string()),
                        )
                }),
            ));
        }
        if spec.views.len() > 1 {
            body = body.child(h_flex().gap_1().flex_wrap().children(
                spec.views.iter().enumerate().map(|(i, view)| {
                    Button::new(format!("visual-tab-{i}"))
                        .small()
                        .ghost()
                        .selected(self.selected == i)
                        .label(view.label.clone())
                        .on_click(cx.listener(move |panel, _, _, cx| {
                            panel.selected = i;
                            cx.notify();
                        }))
                }),
            ));
        }
        let view = &spec.views[self.selected.min(spec.views.len() - 1)];
        if matches!(view.kind.as_str(), "bar" | "line") && !self.show_data {
            let color = cx.theme().primary;
            let chart: AnyElement = if view.kind == "line" {
                LineChart::new(view.points.clone())
                    .id("native-visual-line")
                    .name(view.label.clone())
                    .natural()
                    .x(|p: &Point| SharedString::from(p.label.clone()))
                    .y(|p| p.value)
                    .stroke(cx.theme().primary)
                    .into_any_element()
            } else {
                BarChart::new(view.points.clone())
                    .id("native-visual-bars")
                    .name(view.label.clone())
                    .value_axis(true)
                    .band(|p: &Point| SharedString::from(p.label.clone()))
                    .value(|p| p.value)
                    .fill(move |_, _, _, _| color)
                    .into_any_element()
            };
            body = body.child(div().h(px(220.)).w_full().child(chart));
        }
        if view.kind == "metrics" || self.show_data && matches!(view.kind.as_str(), "bar" | "line")
        {
            body = body.child(v_flex().gap_2().children(view.points.iter().map(|point| {
                h_flex()
                    .gap_4()
                    .child(div().flex_1().text_sm().child(point.label.clone()))
                    .child(div().font_semibold().child(point.value.to_string()))
            })));
        }
        if view.kind == "table" {
            let row = |values: &[String]| {
                h_flex().gap_3().items_start().children(
                    values
                        .iter()
                        .map(|value| div().flex_1().min_w_0().text_sm().child(value.clone())),
                )
            };
            body = body
                .child(row(&view.columns).font_semibold())
                .children(view.rows.iter().map(|values| {
                    row(values)
                        .py_1()
                        .border_t_1()
                        .border_color(cx.theme().border)
                }));
        }
        if view.kind == "flow" {
            body = body.children(view.steps.iter().enumerate().map(|(i, step)| {
                h_flex()
                    .gap_3()
                    .items_start()
                    .child(
                        div()
                            .text_color(cx.theme().primary)
                            .child(format!("{}", i + 1)),
                    )
                    .child(div().flex_1().min_w_0().text_sm().child(step.clone()))
            }));
        }
        body
    }
}

#[cfg(test)]
mod tests {
    use super::parse;
    #[test]
    fn accepts_charts_and_rejects_unsafe_or_unbounded_inputs() {
        assert!(parse(r#"{"version":1,"title":"Week","views":[{"label":"Work","kind":"bar","points":[{"label":"Mon","value":-3}]}]}"#).is_ok());
        assert!(
            parse(r#"{"version":1,"title":"Bad","script":"fetch('secret')","views":[]}"#).is_err()
        );
        assert!(parse(&" ".repeat(65537)).is_err());
        assert!(parse(r#"{"version":1,"title":"Bad","views":[{"label":"x","kind":"table","columns":["a"],"rows":[["b","c"]]}]}"#).is_err());
    }
}
