//! Reproducible native icon/layout pass. Never touches the user's live home.
use super::*;

const FIXTURES: &[(&str, &str)] = &[
    (
        "README.md",
        "# Vitre studio\n\nA calmer space to build great things.\n\nInline code may cross a source line: `first\nsecond`.\n",
    ),
    (
        "package.json",
        "{\n  \"name\": \"vitre-studio\",\n  \"private\": true\n}\n",
    ),
    (
        "Cargo.toml",
        "[package]\nname = \"vitre-studio\"\nversion = \"0.1.0\"\n",
    ),
    ("tsconfig.json", "{\"compilerOptions\":{\"strict\":true}}\n"),
    ("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
    (".gitignore", "node_modules/\ntarget/\n"),
    (".github/workflows/check.yml", "name: Checks\n"),
    (
        "src/components/Workspace.tsx",
        "import { useState } from 'react';\n\nexport function Workspace() {\n  const [mode, setMode] = useState('build');\n\n  return (\n    <main className=\"workspace\">\n      <h1>A little room to think.</h1>\n      <button onClick={() => setMode('plan')}>\n        {mode === 'build' ? 'Make a plan' : 'Ready to build'}\n      </button>\n    </main>\n  );\n}\n",
    ),
    (
        "src/components/workspace-toolbar-with-a-long-name.tsx",
        "export const title = 'Workspace';\n",
    ),
    ("src/main.rs", "fn main() { println!(\"Hello, Vitre\"); }\n"),
    ("src/theme.scss", "$accent: #8ba4ff;\n"),
    ("src/types.ts", "export type Mode = 'plan' | 'build';\n"),
    (
        "tests/workspace.test.ts",
        "// Workspace interaction tests\n",
    ),
    ("AGENTS.md", "# Project conventions\n"),
    ("unknown.custom", "A file without a recognized extension.\n"),
];

impl ChatApp {
    pub(in crate::chat) fn verify_icons_if_requested(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let Ok(mode) = std::env::var("VITRE_VERIFY_ICONS") else {
            return;
        };
        let home = crate::vitre_home();
        if !home
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("vitre-polish-"))
        {
            return;
        }
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.shell.snapshot.is_none() || STARTED.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let executor = cx.background_executor().clone();
        cx.spawn_in(window, async move |this, cx| {
            let run = async {
                let mut selected = None;
                for (title, icon) in [("Vitre studio", Some(br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6478ed"/><path d="m8 9 8 16 8-16h-5l-3 7-3-7z" fill="white"/></svg>"##.as_slice())), ("Design system", None), ("API playground", Some(b"invalid icon".as_slice()))] {
                    let project = fresh_id("vitre-project");
                    let cwd = home.join("workspace").join(&project).to_string_lossy().into_owned();
                    let thread = ThreadId(fresh_id("icon-thread"));
                    // Create a unique fixture directory before publishing the project;
                    // the favicon cache must see the finished fixture on its first read.
                    let seed_root = cwd.clone();
                    let language_fixtures = mode == "languages" || mode == "editor-shortcuts";
                    let kotlin_fixtures = mode == "kotlin";
                    let seed = Tokio::spawn_result(cx, async move {
                        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                            std::fs::create_dir_all(Path::new(&seed_root).parent().unwrap())?;
                            std::fs::create_dir(&seed_root)?; // Fail if anything already exists.
                            if let Some(icon) = icon { std::fs::write(Path::new(&seed_root).join("favicon.svg"), icon)?; }
                            for dir in ["src/components", "tests", ".github/workflows"] { std::fs::create_dir_all(Path::new(&seed_root).join(dir))?; }
                            for (path, text) in FIXTURES { std::fs::write(Path::new(&seed_root).join(path), text)?; }
                            if language_fixtures {
                                for (path, text) in crate::files::FilesPanel::verification_language_fixtures() {
                                    std::fs::write(Path::new(&seed_root).join(path), text)?;
                                }
                            }
                            if kotlin_fixtures {
                                for (path, text) in crate::files::FilesPanel::verification_kotlin_fixtures() {
                                    std::fs::write(Path::new(&seed_root).join(path), text)?;
                                }
                            }
                            let mut preview = image::RgbaImage::new(640,360);
                            for (x,y,pixel) in preview.enumerate_pixels_mut() {*pixel=image::Rgba([(x*120/640+50) as u8,(y*100/360+60) as u8,190,255]);}
                            preview.save(Path::new(&seed_root).join("preview.png"))?;
                            Ok(())
                        }).await?
                    });
                    seed.await.map_err(|e|e.to_string())?;
                    for payload in [
                        serde_json::json!({"type":"project.create","commandId":fresh_id("cmd"),"projectId":project,"title":title,"workspaceRoot":cwd,"createdAt":now_iso()}),
                        serde_json::json!({"type":"thread.create","commandId":fresh_id("cmd"),"projectId":project,"threadId":thread,"title":if selected.is_none(){"Refine the workspace"}else{"Start a new conversation"},"modelSelection":{"provider":"codex","model":"gpt-5"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":now_iso()})
                    ] {
                        let command = serde_json::from_value(payload).map_err(|e| e.to_string())?;
                        client.dispatch(&command).await.map_err(|e|e.user_message())?;
                    }
                    if selected.is_none() { selected = Some((thread, cwd)); }
                }
                let (thread, cwd) = selected.unwrap();
                loop { executor.timer(Duration::from_millis(80)).await; if this.update(cx,|a,_|a.shell_thread(&thread).is_some()).map_err(|e|e.to_string())? {break;} }
                this.update_in(cx,|a,w,cx| {
                    a.select_thread(thread.clone(),cx);
                    gpui_component::Theme::change(if mode == "light" {gpui_component::ThemeMode::Light}else{gpui_component::ThemeMode::Dark},Some(w),cx);
                    if mode == "narrow" { w.resize(gpui::size(px(1100.),px(800.))); }
                }).map_err(|e|e.to_string())?;
                loop {executor.timer(Duration::from_millis(80)).await; if this.update(cx,|a,_|a.thread.as_ref().is_some_and(|t|t.state.view.is_some()) && a.project_icons.entries.get(&cwd).is_some_and(|e|e.image.is_some())).map_err(|e|e.to_string())? {break;} }
                for path in ["README.md", "package.json", "Cargo.toml", "src/components/Workspace.tsx"] {
                    this.update_in(cx, |a,w,cx|a.dock_open_file(path.into(),Some(1),w,cx)).map_err(|e|e.to_string())?;
                    loop { executor.timer(Duration::from_millis(80)).await; if this.update(cx,|a,cx|a.files.as_ref().and_then(|f|f.read(cx).active_file_status()).is_some_and(|(p,_)|p==path)).map_err(|e|e.to_string())? {break;} }
                }
                executor.timer(Duration::from_millis(500)).await;
                if mode == "editor-shortcuts" {
                    let task = this.update_in(cx, |app, window, cx| {
                        app.files.as_ref().unwrap().update(cx, |panel, cx| panel.verify_languages(window, cx))
                    }).map_err(|e| e.to_string())?;
                    task.await?;
                    eprintln!("[vitre-editor-shortcuts-test] PASS: native editor LSP and shortcuts");
                    cx.update(|_, cx| cx.quit()).map_err(|e| e.to_string())?;
                    return Ok(());
                }
                if mode == "project-tabs" {
                    super::ui_verification::float_fixture(cx).await?;
                    this.update_in(cx, |app, window, cx| {
                        window.resize(gpui::size(px(1400.), px(900.)));
                        app.toggle_right_panel(window, cx);
                        ClientSettings::update(cx, |settings| settings.project_tabs_enabled = true);
                        assert!(ClientSettings::get(cx).project_tabs_enabled);
                        assert_eq!(app.tab_project_id(), app.shell_thread(&thread).map(|t| t.project_id.clone()));
                        cx.notify();
                    }).map_err(|e| e.to_string())?;
                    executor.timer(Duration::from_millis(700)).await;
                    super::ui_verification::capture("project-tabs", cx).await?;
                    // Open the new per-project menu in the rendered tab strip.
                    cx.update(|w, cx| {
                        let position = gpui::point(px(358.), px(22.));
                        w.dispatch_event(gpui::PlatformInput::MouseDown(gpui::MouseDownEvent { button: gpui::MouseButton::Left, position, modifiers: Default::default(), click_count: 1, first_mouse: false }),cx);
                        w.dispatch_event(gpui::PlatformInput::MouseUp(gpui::MouseUpEvent { button: gpui::MouseButton::Left, position, modifiers: Default::default(), click_count: 1 }),cx);
                    }).map_err(|e| e.to_string())?;
                    executor.timer(Duration::from_millis(300)).await;
                    super::ui_verification::capture("project-tab-actions", cx).await?;
                    super::ui_verification::key("escape", cx).await?;
                    let previous = this.update(cx, |app, _| app.tab_project_id()).map_err(|e| e.to_string())?;
                    // Click another project tab in the real rendered header.
                    cx.update(|w, cx| {
                        let position = gpui::point(px(430.), px(22.));
                        w.dispatch_event(gpui::PlatformInput::MouseDown(gpui::MouseDownEvent { button: gpui::MouseButton::Left, position, modifiers: Default::default(), click_count: 1, first_mouse: false }),cx);
                        w.dispatch_event(gpui::PlatformInput::MouseUp(gpui::MouseUpEvent { button: gpui::MouseButton::Left, position, modifiers: Default::default(), click_count: 1 }),cx);
                    }).map_err(|e| e.to_string())?;
                    executor.timer(Duration::from_millis(700)).await;
                    this.update(cx, |app, cx| {
                        assert_ne!(app.tab_project_id(), previous, "project tab click must switch projects");
                        ClientSettings::update(cx, |settings| settings.sidebar_v2_enabled = true);
                    }).map_err(|e| e.to_string())?;
                    executor.timer(Duration::from_millis(300)).await;
                    super::ui_verification::capture("project-tabs-switched", cx).await?;
                    this.update(cx, |_, cx| {
                        ClientSettings::update(cx, |settings| settings.project_tabs_enabled = false);
                        assert!(!ClientSettings::get(cx).project_tabs_enabled);
                    }).map_err(|e| e.to_string())?;
                    eprintln!("[vitre-project-tabs-test] PASS: layout toggle, project switching and Sidebar v2 rendering");
                    return super::project_tabs_verification::verify(&this, cx).await;
                }
                if mode == "kotlin" {
                    super::ui_verification::float_fixture(cx).await?;
                    let task = this.update_in(cx, |app, window, cx| {
                        window.resize(gpui::size(px(1400.), px(1000.)));
                        app.files.as_ref().unwrap().update(cx, |p, cx| p.verify_kotlin(window, cx))
                    }).map_err(|e| e.to_string())?;
                    return task.await;
                }
                if mode == "plan-timeline" {
                    return super::plan_timeline::verify(&this, cx).await;
                }
                if mode == "feedback" {
                    return super::feedback_verification::verify(&this, cx).await;
                }
                if mode == "reasoning" {
                    return super::reasoning_verification::verify(&this, cx).await;
                }
                if mode == "chat-text" {
                    return super::text_verification::verify(&this, cx).await;
                }
                if mode == "steering" {
                    return super::local_delivery::verify_steering(&this, cx).await;
                }
                if mode == "text-questions" {
                    super::ui_verification::float_fixture(cx).await?;
                    this.update_in(cx, |app, w, cx| {
                        w.resize(gpui::size(px(1200.), px(1000.)));
                        if app.dock_open() { app.toggle_right_panel(w, cx); }
                        app.sidebar_visible = false;
                        let stamp = tnes(now_iso());
                        let message = OrchestrationMessage {
                            attachments: None,
                            created_at: stamp.clone(),
                            id: MessageId("fixture-text-question".into()),
                            role: OrchestrationMessageRole::Assistant,
                            streaming: false,
                            text: tnes("Should upgrades affect **existing pools**, or should new versions apply **only to future pools**, leaving active pools unchanged?\n\nWhere are the project resources?"),
                            turn_id: None,
                            updated_at: stamp,
                        };
                        Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap())
                            .messages
                            .push(message);
                        app.rebuild_timeline(cx);
                        app.sync_text_question_form(w, cx);
                        let form = app.text_question_form.as_ref().unwrap();
                        assert_eq!(form.inputs.len(), 2);
                        assert_eq!(form.questions[0].options, ["existing pools", "only to future pools"]);
                        assert!(app.render_text_question_card(&form.message_id, cx).is_some());
                        assert!(app.text_question_answers(cx).is_none());
                        assert!(!app.can_send_text_answers(cx));
                        cx.notify();
                    }).map_err(|e|e.to_string())?;
                    executor.timer(Duration::from_millis(300)).await;
                    cx.update(|w, cx| w.draw(cx).clear(cx)).map_err(|e| e.to_string())?;
                    let option = this.update(cx, |app, _| {
                        *app.text_question_form.as_ref().unwrap().option_bounds.borrow().get(&(0,1)).expect("option was not laid out")
                    }).map_err(|e| e.to_string())?;
                    cx.update(|w, cx| {
                        let position = option.center();
                        w.dispatch_event(gpui::PlatformInput::MouseDown(gpui::MouseDownEvent { button: gpui::MouseButton::Left, position, modifiers: Default::default(), click_count: 1, first_mouse: false }),cx);
                        w.dispatch_event(gpui::PlatformInput::MouseUp(gpui::MouseUpEvent { button: gpui::MouseButton::Left, position, modifiers: Default::default(), click_count: 1 }),cx);
                    }).map_err(|e| e.to_string())?;
                    executor.timer(Duration::from_millis(150)).await;
                    let input_bounds = this.update(cx, |app, cx| {
                        let form = app.text_question_form.as_ref().unwrap();
                        assert_eq!(form.inputs[0].read(cx).value(), "only to future pools", "option click must populate its own input");
                        let bounds = form.inputs[1].read(cx).input_bounds();
                        assert!(bounds.size.height > px(30.) && bounds.size.width > px(100.), "free-text field must have visible dimensions");
                        bounds
                    }).map_err(|e| e.to_string())?;
                    cx.update(|w, cx| {
                        let position = input_bounds.center();
                        w.dispatch_event(gpui::PlatformInput::MouseDown(gpui::MouseDownEvent { button: gpui::MouseButton::Left, position, modifiers: Default::default(), click_count: 1, first_mouse: false }),cx);
                        w.dispatch_event(gpui::PlatformInput::MouseUp(gpui::MouseUpEvent { button: gpui::MouseButton::Left, position, modifiers: Default::default(), click_count: 1 }),cx);
                        w.draw(cx).clear(cx);
                        for key in ["r", "e", "s", "o", "u", "r", "c", "e", "s", "/"] {
                            w.dispatch_keystroke(gpui::Keystroke::parse(key).unwrap(), cx);
                        }
                    }).map_err(|e| e.to_string())?;
                    executor.timer(Duration::from_millis(150)).await;
                    this.update_in(cx, |app, w, cx| {
                        assert!(app.text_question_answers(cx).unwrap().contains("resources/"), "typing must reach the in-card field");
                        assert!(app.can_send_text_answers(cx));
                        let mut followup = app.display_messages.last().unwrap().clone();
                        followup.id = MessageId("fixture-question-followup".into());
                        followup.text = tnes("I'll wait for your answer.");
                        Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap()).messages.push(followup);
                        app.rebuild_timeline(cx);
                        app.sync_text_question_form(w, cx);
                        assert_eq!(app.text_question_form.as_ref().unwrap().inputs[0].read(cx).value(), "only to future pools");
                        assert!(app.text_question_answers(cx).unwrap().contains("resources/"));
                    }).map_err(|e|e.to_string())?;
                    if let Err(error) = super::ui_verification::capture("text-questions", cx).await {
                        eprintln!("[vitre-text-questions-test] screenshot unavailable: {error}");
                    }
                    this.update_in(cx, |app, w, cx| {
                        let mut reply = app.display_messages.last().unwrap().clone();
                        reply.id = MessageId("fixture-question-reply".into());
                        reply.role = OrchestrationMessageRole::User;
                        reply.text = tnes(app.text_question_answers(cx).unwrap());
                        Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap()).messages.push(reply);
                        app.rebuild_timeline(cx);
                        app.sync_text_question_form(w, cx);
                        assert!(app.text_question_form.is_none());
                    }).map_err(|e|e.to_string())?;
                    eprintln!("[vitre-text-questions-test] PASS: option mouse click, visible inputs, keyboard typing, send validation, follow-up retention and answered-card removal");
                    cx.update(|_,cx|cx.quit()).map_err(|e|e.to_string())?;
                    return Ok(());
                }
                if mode == "questions" {
                    this.update(cx, |app,cx| {
                        let activity = serde_json::from_value(serde_json::json!({
                            "id": "fixture-question-request", "kind": "user-input.requested", "createdAt": now_iso(), "summary": "Clarification requested", "tone": "tool", "turnId": null,
                            "payload": {"requestId": "fixture-questions", "questions": [
                                {"id": "stack", "header": "Tooling", "question": "Which package manager?", "options": [{"label": "pnpm", "description": "pnpm workspaces"}], "multiSelect": false},
                                {"id": "resources", "header": "Resources", "question": "Where are the project resources?", "options": [], "multiSelect": false}
                            ]}
                        })).unwrap();
                        Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap()).activities.push(activity);
                        app.rebuild_timeline(cx);
                        cx.notify();
                    }).map_err(|e|e.to_string())?;
                    executor.timer(Duration::from_millis(250)).await;
                    this.update_in(cx, |app,w,cx| {
                        assert_eq!(app.input_draft.as_ref().unwrap().question_index, 0);
                        app.toggle_user_input_option("pnpm".into(), w, cx);
                        assert_eq!(app.input_draft.as_ref().unwrap().question_index, 1);
                        app.input_answer.update(cx, |input,cx| input.replace_all("resources/ folder",w,cx));
                    }).map_err(|e|e.to_string())?;
                    executor.timer(Duration::from_millis(100)).await;
                    this.update_in(cx, |app,w,cx| {
                        let draft = app.input_draft.as_ref().unwrap();
                        let pending = app.active_pending_user_input().unwrap();
                        assert_eq!(user_input_answer(&pending.questions[1],draft), Some(serde_json::json!("resources/ folder")));
                        app.previous_user_input(w,cx);
                        assert_eq!(app.input_draft.as_ref().unwrap().question_index,0);
                        app.advance_user_input(w,cx);
                        assert_eq!(app.input_answer.read(cx).value(), "resources/ folder");
                    }).map_err(|e|e.to_string())?;
                    executor.timer(Duration::from_millis(250)).await;
                    eprintln!("[vitre-questions-test] PASS: native question card, choice, typed answer, back navigation and answer retention");
                    cx.update(|_,cx|cx.quit()).map_err(|e|e.to_string())?;
                    return Ok(());
                }
                if mode == "models" {
                    for _ in 0..150 {
                        let found = this.update(cx, |app,_| app.provider_snapshots.iter().any(|provider| provider.models.iter().any(|model| model.slug.0 == "claude-fable-5-1"))).map_err(|e|e.to_string())?;
                        if found { break; }
                        executor.timer(Duration::from_millis(100)).await;
                    }
                    this.update_in(cx, |app,w,cx| -> Result<(),String> {
                        app.open_model_picker(w,cx);
                        let picker = app.model_picker.as_ref().ok_or("Model picker missing")?;
                        let provider = picker.read(cx).providers.iter().find(|provider| provider.models.iter().any(|model| model.slug.0 == "claude-fable-5-1")).ok_or("Live Claude catalog did not include Fable 5.1")?.instance_id.0.clone();
                        picker.update(cx, |picker,cx| { picker.selected_provider = Some(provider); cx.notify(); });
                        Ok(())
                    }).map_err(|e|e.to_string())??;
                    executor.timer(Duration::from_millis(500)).await;
                    let visible = this.update(cx, |app,cx| app.model_picker.as_ref().is_some_and(|picker| picker.read(cx).choices.iter().any(|(selection,_)| model_selection_identity(selection).is_some_and(|(_,model)| model == "claude-fable-5-1")))).map_err(|e|e.to_string())?;
                    if !visible { return Err("Fable 5.1 missing from rendered picker choices".into()); }
                    eprintln!("[vitre-models-test] PASS: live Claude Code catalog includes Fable 5.1 in native model picker");
                    cx.update(|_,cx|cx.quit()).map_err(|e|e.to_string())?;
                    return Ok(());
                }
                if mode == "file-links" {
                    for url in ["README.md:2".to_string(), format!("file://{cwd}/package.json"), format!("{cwd}/preview.png")] {
                        this.update_in(cx, |app, window, cx| app.open_chat_link(&url, window, cx)).map_err(|e|e.to_string())?;
                        let expected = if url.ends_with("png") { "preview.png" } else if url.ends_with("json") { "package.json" } else { "README.md" };
                        let mut opened = false;
                        for _ in 0..60 {
                            executor.timer(Duration::from_millis(100)).await;
                            opened = this.update(cx, |app,cx| {
                                app.files.as_ref().is_some_and(|f| if expected.ends_with("png") { f.read(cx).verify_image_loaded() == Some(true) } else { f.read(cx).active_file_status().is_some_and(|(path,_)|path==expected) })
                            }).map_err(|e|e.to_string())?;
                            if opened { break; }
                        }
                        if !opened { return Err(format!("Chat link did not open {expected}")); }
                    }
                    let external = home.join("outside.md");
                    std::fs::write(&external, "# Outside the workspace\n").map_err(|e|e.to_string())?;
                    this.update_in(cx, |app,w,cx| app.open_chat_link(&external.to_string_lossy(),w,cx)).map_err(|e|e.to_string())?;
                    executor.timer(Duration::from_millis(700)).await;
                    if !this.update(cx, |app,cx| app.files.as_ref().is_some_and(|f| f.read(cx).active_file_status().is_some_and(|(p,_)|p=="outside.md"))).map_err(|e|e.to_string())? { return Err("External file link did not load".into()); }
                    eprintln!("[vitre-file-links-test] PASS: relative, absolute, file URL, line reference, image and outside-workspace file loading");
                    cx.update(|_,cx|cx.quit()).map_err(|e|e.to_string())?;
                    return Ok(());
                }
                if mode == "images" {
                    this.update_in(cx, |app, window, cx| app.verify_chat_images(window, cx)).map_err(|e|e.to_string())?;
                    return Ok(());
                }
                #[cfg(feature = "perf-probe")]
                if mode == "chat-perf" {
                    return super::perf_verification::verify(&this, cx).await;
                }
                #[cfg(not(feature = "perf-probe"))]
                if mode == "chat-perf" {
                    return Err("chat-perf requires the perf-probe Cargo feature".into());
                }
                if mode == "ask" {
                    this.update_in(cx, |app, window, cx| {
                        app.set_ask_mode(cx);
                        app.composer.update(cx, |input, cx| input.set_value("Explain this codebase using tools and MCP", window, cx));
                        app.save_composer_draft(cx);
                        let thread_id = app.thread.as_ref().unwrap().id.clone();
                        assert_eq!(app.current_interaction_mode(&thread_id), ProviderInteractionMode::Default);
                        let saved = app.drafts.load(&thread_id.0);
                        app.set_interaction_mode(ProviderInteractionMode::Default, cx);
                        assert!(!app.ask_mode);
                        app.draft_restore = Some(saved);
                        app.restore_composer_draft(window, cx);
                        assert!(app.ask_mode);
                        assert!(app.composer.read(cx).value().contains("Explain this codebase"));
                        cx.notify();
                    }).map_err(|e| e.to_string())?;
                    executor.timer(Duration::from_millis(500)).await;
                    eprintln!("[vitre-ask-test] PASS: Ask selection, normal tool-capable provider mode, Build switch, saved conversation restore and native rendering");
                    cx.update(|_, cx| cx.quit()).map_err(|e| e.to_string())?;
                    return Ok(());
                }
                cx.update(|w,cx| {
                    let position = gpui::point(px(70.),px(60.));
                    w.dispatch_event(gpui::PlatformInput::MouseDown(gpui::MouseDownEvent { button: gpui::MouseButton::Left, position, modifiers: Default::default(), click_count: 1, first_mouse: false }),cx);
                    w.dispatch_event(gpui::PlatformInput::MouseUp(gpui::MouseUpEvent { button: gpui::MouseButton::Left, position, modifiers: Default::default(), click_count: 1 }),cx);
                }).map_err(|e|e.to_string())?;
                executor.timer(Duration::from_millis(250)).await;
                if !this.update(cx,|a,_|a.quick_search.is_some()).map_err(|e|e.to_string())? {return Err("Sidebar Search hit target did not open the overlay".into());}
                this.update_in(cx,|a,w,cx|a.toggle_quick_search(QuickSearchMode::Open,w,cx)).map_err(|e|e.to_string())?;
                executor.timer(Duration::from_millis(150)).await;
                cx.update(|w,cx| {
                    let position = gpui::point(w.viewport_size().width - px(18.),px(22.));
                    w.dispatch_event(gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {button:gpui::MouseButton::Left,position,modifiers:Default::default(),click_count:1,first_mouse:false}),cx);
                    w.dispatch_event(gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {button:gpui::MouseButton::Left,position,modifiers:Default::default(),click_count:1}),cx);
                }).map_err(|e|e.to_string())?;
                executor.timer(Duration::from_millis(150)).await;
                if this.update(cx,|a,_|a.dock_open()).map_err(|e|e.to_string())? { return Err("Hide panel hit target did not close the dock".into()); }
                this.update_in(cx,|a,w,cx|a.toggle_right_panel(w,cx)).map_err(|e|e.to_string())?;
                let counts = this.update(cx, |a,_| (a.project_icons.entries.values().filter(|e|e.image.is_some()).count(),a.project_icons.entries.values().filter(|e|e.image.is_none()).count())).map_err(|e|e.to_string())?;
                if counts.0 == 0 || counts.1 < 2 {return Err(format!("Unexpected favicon/fallback counts: {counts:?}"));}
                if mode == "ui" {
                    if std::env::var_os("VITRE_MARKETING_CAPTURE").is_some() {
                        super::ui_verification::float_fixture(cx).await?;
                        cx.update(|window, _| window.resize(gpui::size(px(1400.), px(850.))))
                            .map_err(|error| error.to_string())?;
                        executor.timer(Duration::from_millis(500)).await;
                    }
                    this.update_in(cx, |app, window, cx| app.verify_surface_ui(window, cx)).map_err(|e| e.to_string())?;
                }
                if mode == "phase5" {
                    this.update_in(cx, |app, window, cx| app.verify_phase5(window, cx)).map_err(|e|e.to_string())?;
                }
                if mode == "tabs" {
                    this.update_in(cx, |app, window, cx| app.verify_dock_tabs(window, cx)).map_err(|e|e.to_string())?;
                }
                if mode == "menus" {
                    this.update_in(cx, |app, window, cx| app.verify_context_menus(window, cx)).map_err(|e|e.to_string())?;
                }
                if mode == "languages" {
                    let task = this.update_in(cx, |app, window, cx| app.files.as_ref().unwrap().update(cx, |p, cx| p.verify_languages(window, cx))).map_err(|e| e.to_string())?;
                    task.await?;
                    super::ui_verification::capture("languages-react", cx).await?;
                    let task = this.update_in(cx, |app, window, cx| app.files.as_ref().unwrap().update(cx, |p, cx| p.verify_refactor(window, cx))).map_err(|e| e.to_string())?;
                    task.await?;
                    let task = this.update_in(cx, |app, window, cx| app.files.as_ref().unwrap().update(cx, |p, cx| p.verify_debugger(window, cx))).map_err(|e| e.to_string())?;
                    task.await?;
                }
                Ok::<_,String>(())
            };
            let result = tokio::select! { r = run => r, _ = executor.timer(Duration::from_secs(if mode == "languages" || mode == "editor-shortcuts" || mode == "kotlin" || mode == "chat-perf" { 180 } else { 40 })) => Err("Icon verification timed out".into()) };
            match result {Ok(()) if mode == "editor-shortcuts" => {}, Ok(())=>eprintln!("[vitre-icons-test] PASS: signed SVG favicon, missing/broken fallbacks, nested file tree, four file tabs, Search and Hide panel mouse hit targets, dock restoration ({mode})"),Err(e)=>eprintln!("[vitre-icons-test] FAIL: {e}")}
        }).detach();
    }
}
