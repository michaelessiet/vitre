//! Opt-in native composer pass against a disposable project and real sidecar.
use super::*;

pub(super) async fn verify(
    app: &WeakEntity<ChatApp>,
    cwd: &str,
    cx: &mut gpui::AsyncWindowContext,
) -> Result<(), String> {
    ui_verification::float_fixture(cx).await?;
    app.update_in(cx, |app, window, cx| {
        window.resize(gpui::size(px(1150.), px(800.)));
        if app.dock_open() {
            app.toggle_right_panel(window, cx);
        }
        app.composer.update(cx, |input, cx| {
            input.set_value("$vitre-project", window, cx);
            input.set_selected_range(14..14, cx);
            input.focus(window, cx);
        });
        app.sync_composer_menu(cx);
    })
    .map_err(|error| error.to_string())?;

    let key = ("codex".to_string(), cwd.to_string());
    let executor = cx.background_executor().clone();
    let mut loaded = false;
    for _ in 0..150 {
        loaded = app
            .update(cx, |app, _| {
                app.scoped_capabilities
                    .get(&key)
                    .is_some_and(|(_, capabilities)| {
                        capabilities
                            .skills
                            .iter()
                            .any(|skill| skill.name == "vitre-project-check")
                    })
            })
            .map_err(|error| error.to_string())?;
        if loaded {
            break;
        }
        executor.timer(Duration::from_millis(100)).await;
    }
    if !loaded {
        return Err("Project skill did not reach the native composer".into());
    }

    app.update(cx, |app, _| {
        assert!(app.composer_menu.as_ref().is_some_and(|menu| {
            menu.items.iter().any(|item| {
                matches!(item, ComposerMenuItem::Skill { name, .. } if name == "vitre-project-check")
            })
        }));
    })
    .map_err(|error| error.to_string())?;
    if let Err(error) = ui_verification::capture("project-skills", cx).await {
        eprintln!("[vitre-capabilities-test] screenshot unavailable: {error}");
    }

    app.update_in(cx, |app, window, cx| {
        app.composer.update(cx, |input, cx| {
            input.set_value("$vitre-project-c", window, cx);
            input.set_selected_range(16..16, cx);
            input.focus(window, cx);
        });
        app.sync_composer_menu(cx);
    })
    .map_err(|error| error.to_string())?;
    let suggested = app
        .update(cx, |app, _| {
            app.composer_menu.as_ref().is_some_and(|menu| {
                menu.items.iter().any(|item| {
                    matches!(item, ComposerMenuItem::Skill { name, .. } if name == "vitre-project-check")
                })
            })
        })
        .map_err(|error| error.to_string())?;
    if !suggested {
        return Err("Project skill disappeared before keyboard selection".into());
    }
    ui_verification::key("enter", cx).await?;
    let inserted = app
        .update(cx, |app, cx| app.composer.read(cx).value())
        .map_err(|error| error.to_string())?;
    if inserted != "$vitre-project-check " {
        return Err(format!(
            "Enter produced {inserted:?} instead of the skill token"
        ));
    }

    app.update_in(cx, |app, window, cx| {
        app.composer.update(cx, |input, cx| {
            input.set_value("/pl", window, cx);
            input.set_selected_range(3..3, cx);
            input.focus(window, cx);
        });
        app.sync_composer_menu(cx);
    })
    .map_err(|error| error.to_string())?;
    ui_verification::key("enter", cx).await?;
    app.update(cx, |app, cx| {
        assert!(app.composer.read(cx).value().trim().is_empty());
    })
    .map_err(|error| error.to_string())?;

    app.update_in(cx, |app, window, cx| {
        app.composer.update(cx, |input, cx| {
            input.set_value("$vitre-no-match", window, cx);
            input.set_selected_range(15..15, cx);
            input.focus(window, cx);
        });
        app.sync_composer_menu(cx);
        assert!(
            app.composer_menu
                .as_ref()
                .is_some_and(|menu| menu.items.is_empty())
        );
    })
    .map_err(|error| error.to_string())?;
    if let Err(error) = ui_verification::capture("project-skills-empty", cx).await {
        eprintln!("[vitre-capabilities-test] screenshot unavailable: {error}");
    }
    ui_verification::key("escape", cx).await?;
    app.update(cx, |app, _| assert!(app.composer_menu.is_none()))
        .map_err(|error| error.to_string())?;

    let draft_has_skill = app
        .update_in(cx, |app, window, cx| {
            app.new_thread(None, window, cx);
            app.draft_model = Some(ModelSelection {
                instance_id: Some(Some(serde_json::json!("codex"))),
                model: serde_json::json!("gpt-5"),
                options: None,
                provider: None,
            });
            app.composer.update(cx, |input, cx| {
                input.set_value("$vitre-project-c", window, cx);
                input.set_selected_range(16..16, cx);
                input.focus(window, cx);
            });
            app.sync_composer_menu(cx);
            app.thread.is_none()
                && app.selected_provider(cx).is_some_and(|provider| provider.instance_id.0 == "codex")
                && app.composer_menu.as_ref().is_some_and(|menu| {
                    menu.items.iter().any(|item| {
                        matches!(item, ComposerMenuItem::Skill { name, .. } if name == "vitre-project-check")
                    })
                })
        })
        .map_err(|error| error.to_string())?;
    if !draft_has_skill {
        return Err("Project skill was unavailable in a new conversation draft".into());
    }

    eprintln!(
        "[vitre-capabilities-test] PASS: thread and draft project skills, long and empty suggestions, keyboard insert, /plan and Escape in the native app"
    );
    cx.update(|_, cx| cx.quit())
        .map_err(|error| error.to_string())?;
    Ok(())
}
