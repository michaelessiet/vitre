//! Read-only diff and test output for a finished task. Compact on purpose:
//! the point is to decide whether to open a PR, not to edit.
use super::*;
use vitre_contracts::CloudSavedResult;
use vitre_state::diff_patch::{PatchFile, PatchLineKind};

pub(crate) fn render_diff(files: &[PatchFile], cx: &App) -> AnyElement {
    if files.is_empty() {
        return empty_state(
            "No changes yet. The diff appears once the worker saves a checkpoint.",
            cx,
        );
    }
    let mut column = v_flex().gap_4().w_full().pb_2();
    for (file_index, file) in files.iter().enumerate() {
        let mut card = v_flex()
            .w_full()
            .rounded_lg()
            .border_1()
            .border_color(cx.theme().border)
            .overflow_hidden()
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .px_3()
                    .py_1p5()
                    .bg(cx.theme().muted.opacity(0.5))
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(Icon::new(crate::assets::VitreIcon::FileDiff).size_3p5())
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_xs()
                            .font_family("monospace")
                            .truncate()
                            .child(file.display_path().to_owned()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().success)
                            .child(format!("+{}", file.additions)),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().danger)
                            .child(format!("−{}", file.deletions)),
                    ),
            );
        if file.binary {
            card = card.child(
                div()
                    .px_3()
                    .py_2()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child("Binary file changed"),
            );
        }
        for (hunk_index, hunk) in file.hunks.iter().enumerate() {
            card = card.child(
                div()
                    .px_3()
                    .py_0p5()
                    .text_xs()
                    .font_family("monospace")
                    .text_color(cx.theme().info)
                    .bg(cx.theme().info.opacity(0.06))
                    .child(format!(
                        "@@ -{},{} +{},{} @@ {}",
                        hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines, hunk.header
                    )),
            );
            let mut rows = v_flex().w_full();
            for (line_index, line) in hunk.lines.iter().enumerate() {
                let (row_bg, number_bg, bar, sign) = match line.kind {
                    PatchLineKind::Add => (
                        cx.theme().success.opacity(0.08),
                        cx.theme().success.opacity(0.12),
                        cx.theme().success.opacity(0.55),
                        "+",
                    ),
                    PatchLineKind::Del => (
                        cx.theme().danger.opacity(0.08),
                        cx.theme().danger.opacity(0.12),
                        cx.theme().danger.opacity(0.55),
                        "−",
                    ),
                    PatchLineKind::Context => (
                        gpui::transparent_black(),
                        gpui::transparent_black(),
                        gpui::transparent_black(),
                        " ",
                    ),
                };
                let number = |value: Option<u32>| {
                    div()
                        .w(px(40.))
                        .flex_shrink_0()
                        .px_1()
                        .text_right()
                        .text_color(cx.theme().muted_foreground)
                        .bg(number_bg)
                        .child(value.map(|v| v.to_string()).unwrap_or_default())
                };
                rows = rows.child(
                    h_flex()
                        .id(SharedString::from(format!(
                            "diff-{file_index}-{hunk_index}-{line_index}"
                        )))
                        .w_full()
                        .min_h(px(20.))
                        .items_stretch()
                        .text_xs()
                        .font_family("monospace")
                        .bg(row_bg)
                        .child(number(line.old_line))
                        .child(number(line.new_line))
                        .child(div().w(px(3.)).flex_shrink_0().bg(bar))
                        .child(
                            div()
                                .w(px(14.))
                                .flex_shrink_0()
                                .text_center()
                                .text_color(cx.theme().muted_foreground)
                                .child(sign),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .pr_2()
                                .whitespace_nowrap()
                                .overflow_hidden()
                                .child(line.content.clone()),
                        ),
                );
            }
            card = card.child(rows);
        }
        column = column.child(card);
    }
    column.into_any_element()
}

pub(crate) fn render_tests(
    task: &CloudTask,
    result: Option<&CloudSavedResult>,
    cx: &App,
) -> AnyElement {
    if task.repository.test_command.trim().is_empty() {
        return empty_state(
            "No test command is configured for this repository. Add one in Settings → Cloud and the worker runs it after every checkpoint.",
            cx,
        );
    }
    let Some(result) = result else {
        return empty_state("Tests run after the worker saves a checkpoint.", cx);
    };
    let output = result.result.test_output.0.clone();
    let (color, label) = match result.result.test_exit_code {
        Some(0) => (cx.theme().success, "Passed".to_string()),
        Some(code) => (cx.theme().danger, format!("Failed · exit {code}")),
        None => (cx.theme().muted_foreground, "Not run".to_string()),
    };
    v_flex()
        .gap_2()
        .w_full()
        .pb_2()
        .child(
            h_flex().gap_2().items_center().child(
                Tag::custom(color.opacity(0.1), color, color.opacity(0.25))
                    .small()
                    .rounded_full()
                    .child(label),
            ),
        )
        .child(if output.trim().is_empty() {
            empty_state("The test run produced no output.", cx)
        } else {
            div()
                .w_full()
                .p_3()
                .rounded_lg()
                .border_1()
                .border_color(cx.theme().border)
                .bg(cx.theme().muted.opacity(0.4))
                .font_family("monospace")
                .text_xs()
                .whitespace_normal()
                .child(output)
                .into_any_element()
        })
        .into_any_element()
}

fn empty_state(text: &'static str, cx: &App) -> AnyElement {
    div()
        .py_8()
        .w_full()
        .text_sm()
        .text_center()
        .text_color(cx.theme().muted_foreground)
        .child(text)
        .into_any_element()
}
