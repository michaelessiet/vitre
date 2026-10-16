//! Composer state belongs to its thread, including attachments and context.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct ComposerDraft {
    text: String,
    work_location: WorkLocation,
    cloud: CloudDraft,
    model: Option<ModelSelection>,
    mode: Option<ProviderInteractionMode>,
    runtime_mode: Option<RuntimeMode>,
    pending_cloud: Option<cloud_thread::CloudPendingSend>,
    pub(super) pending_local: Option<local_delivery::LocalPendingSend>,
    ask_mode: bool,
    attachments: Vec<PendingAttachment>,
    review_comments: Vec<ReviewCommentContext>,
    terminal_contexts: Vec<terminal_contexts::PendingTerminalContext>,
}

impl ComposerDraft {
    pub(super) fn for_local_plan(
        pending: local_delivery::LocalPendingSend,
        model: ModelSelection,
        runtime_mode: RuntimeMode,
    ) -> Self {
        Self {
            pending_local: Some(pending),
            model: Some(model),
            runtime_mode: Some(runtime_mode),
            mode: Some(ProviderInteractionMode::Default),
            ..Self::default()
        }
    }
}

enum DraftWrite {
    Save(String, Box<ComposerDraft>),
    Flush(std::sync::mpsc::Sender<()>),
    LocalPending(
        String,
        String,
        Option<Box<local_delivery::LocalPendingSend>>,
    ),
    Confirm(
        String,
        Box<ComposerDraft>,
        futures::channel::oneshot::Sender<Result<(), String>>,
    ),
}
pub(super) struct DraftStore {
    directory: PathBuf,
    writes: std::sync::mpsc::Sender<DraftWrite>,
    error: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    unreadable: std::sync::Arc<std::sync::Mutex<HashSet<String>>>,
}
impl DraftStore {
    pub fn new(home: &Path) -> Self {
        let directory = home.join("composer-drafts");
        let (writes, requests) = std::sync::mpsc::channel();
        let error = std::sync::Arc::new(std::sync::Mutex::new(None));
        let worker_dir = directory.clone();
        let worker_error = error.clone();
        let unreadable = std::sync::Arc::new(std::sync::Mutex::new(HashSet::new()));
        let worker_unreadable = unreadable.clone();
        // Serialize writes in order, off the render thread. In particular,
        // image attachments must not freeze typing while encoding JSON.
        std::thread::Builder::new()
            .name("vitre-drafts".into())
            .spawn(move || {
                while let Ok(request) = requests.recv() {
                    match request {
                        DraftWrite::Save(id, draft) => {
                            if let Err(e) =
                                Self::write_checked(&worker_dir, &id, &draft, &worker_unreadable)
                            {
                                *worker_error.lock().unwrap() = Some(e.to_string());
                            }
                        }
                        DraftWrite::Confirm(id, draft, done) => {
                            let result =
                                Self::write_checked(&worker_dir, &id, &draft, &worker_unreadable)
                                    .map_err(|e| e.to_string());
                            let _ = done.send(result);
                        }
                        DraftWrite::LocalPending(id, command_id, pending) => {
                            let path = worker_dir.join(format!(
                                "{}.json",
                                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&id)
                            ));
                            match Self::read_file(&path) {
                                Ok(Some(mut draft))
                                    if draft
                                        .pending_local
                                        .as_ref()
                                        .is_some_and(|p| p.command_id() == command_id) =>
                                {
                                    draft.pending_local = pending.map(|p| *p);
                                    if let Err(error) = Self::write_checked(
                                        &worker_dir,
                                        &id,
                                        &draft,
                                        &worker_unreadable,
                                    ) {
                                        *worker_error.lock().unwrap() = Some(error.to_string());
                                    }
                                }
                                Err(error) => {
                                    worker_unreadable.lock().unwrap().insert(id);
                                    *worker_error.lock().unwrap() = Some(error.to_string());
                                }
                                _ => {}
                            }
                        }
                        DraftWrite::Flush(done) => {
                            let _ = done.send(());
                        }
                    }
                }
            })
            .expect("start draft persistence worker");
        Self {
            directory,
            writes,
            error,
            unreadable,
        }
    }
    fn path(&self, id: &str) -> PathBuf {
        // IDs are opaque and may contain slashes in imported environments.
        self.directory.join(format!(
            "{}.json",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(id)
        ))
    }
    fn read_file(path: &Path) -> std::io::Result<Option<ComposerDraft>> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|error| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, format!(
                    "Could not decode saved draft ({:?} at line {}, column {}). Original preserved at {}",
                    error.classify(), error.line(), error.column(), path.display()))
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(std::io::Error::new(error.kind(), format!(
                "Could not read saved draft ({:?}). Original preserved at {}", error.kind(), path.display()))),
        }
    }
    pub fn load(&self, id: &str) -> ComposerDraft {
        self.flush();
        match Self::read_file(&self.path(id)) {
            Ok(draft) => {
                self.unreadable.lock().unwrap().remove(id);
                draft.unwrap_or_default()
            }
            Err(error) => {
                self.unreadable.lock().unwrap().insert(id.into());
                *self.error.lock().unwrap() = Some(error.to_string());
                ComposerDraft::default()
            }
        }
    }
    #[cfg(test)]
    pub fn clear_text(&self, id: &str) -> std::io::Result<()> {
        let mut draft = self.load(id);
        draft.text.clear();
        self.save(id, &draft)
    }
    pub fn copy_preferences(&self, source: &str, destination: &str) -> std::io::Result<()> {
        let mut draft = self.load(source);
        draft.text.clear();
        draft.attachments.clear();
        draft.review_comments.clear();
        draft.terminal_contexts.clear();
        draft.cloud.request_key = None;
        draft.cloud.request_identity = None;
        draft.cloud.prompt_recovery = None;
        draft.pending_cloud = None;
        draft.cloud.pending_start = None;
        draft.pending_local = None;
        self.save(destination, &draft)
    }

    pub(super) fn finish_cloud_start(
        &self,
        id: &str,
        request: &str,
        outcome: &crate::cloud::store::CreationOutcome,
        fallback: Option<cloud_thread::CloudPendingStart>,
    ) -> Option<ComposerDraft> {
        let mut draft = self.load(id);
        if draft.cloud.pending_start.is_none() {
            draft.cloud.pending_start = fallback;
        }
        let pending = draft
            .cloud
            .pending_start
            .as_ref()
            .filter(|pending| pending.input.idempotency_key == request)?;
        match outcome {
            crate::cloud::store::CreationOutcome::Unknown(error) => {
                let pending = draft.cloud.pending_start.as_mut().unwrap();
                pending.delivery = cloud_thread::CloudDeliveryState::Unknown;
                pending.error = Some(error.clone());
            }
            crate::cloud::store::CreationOutcome::Rejected(_) => {
                let pending = pending.clone();
                draft.text = if draft.text.is_empty() {
                    pending.raw_prompt
                } else {
                    format!("{}\n{}", pending.raw_prompt, draft.text)
                };
                draft.attachments.splice(0..0, pending.attachments);
                draft.review_comments.splice(0..0, pending.review_comments);
                draft
                    .terminal_contexts
                    .splice(0..0, pending.terminal_contexts);
                draft.cloud.pending_start = None;
                draft.cloud.request_key = None;
                draft.cloud.request_identity = None;
            }
            crate::cloud::store::CreationOutcome::Accepted(_) => {
                draft.cloud.pending_start = None;
                draft.cloud.request_key = None;
                draft.cloud.request_identity = None;
            }
        }
        let _ = self.save(id, &draft);
        Some(draft)
    }

    pub fn save(&self, id: &str, draft: &ComposerDraft) -> std::io::Result<()> {
        self.writes
            .send(DraftWrite::Save(id.into(), Box::new(draft.clone())))
            .map_err(|e| std::io::Error::other(e.to_string()))
    }
    pub fn save_confirmed(
        &self,
        id: &str,
        draft: &ComposerDraft,
    ) -> futures::channel::oneshot::Receiver<Result<(), String>> {
        let (done, result) = futures::channel::oneshot::channel();
        let _ = self.writes.send(DraftWrite::Confirm(
            id.into(),
            Box::new(draft.clone()),
            done,
        ));
        result
    }
    pub(super) fn update_local_pending(
        &self,
        id: &ThreadId,
        command_id: &str,
        pending: Option<&local_delivery::LocalPendingSend>,
    ) {
        if let Err(e) = self.writes.send(DraftWrite::LocalPending(
            id.0.clone(),
            command_id.into(),
            pending.cloned().map(Box::new),
        )) {
            *self.error.lock().unwrap() = Some(e.to_string());
        }
    }
    pub fn flush(&self) {
        let (done, result) = std::sync::mpsc::channel();
        if self.writes.send(DraftWrite::Flush(done)).is_ok() {
            let _ = result.recv();
        }
    }
    pub fn take_error(&self) -> Option<String> {
        self.error.lock().unwrap().take()
    }
    fn write_checked(
        directory: &Path,
        id: &str,
        draft: &ComposerDraft,
        unreadable: &std::sync::Mutex<HashSet<String>>,
    ) -> std::io::Result<()> {
        if unreadable.lock().unwrap().contains(id) {
            return Err(std::io::Error::other(
                "The saved draft could not be read. Repair the original file and reopen this conversation before saving; it has not been overwritten.",
            ));
        }
        Self::write(directory, id, draft)
    }
    fn write(directory: &Path, id: &str, draft: &ComposerDraft) -> std::io::Result<()> {
        use std::io::Write as _;
        std::fs::create_dir_all(directory)?;
        let path = directory.join(format!(
            "{}.json",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(id)
        ));
        // Distinct windows/processes may share a draft directory. Each writer
        // gets its own inode so another writer cannot truncate an in-flight file.
        let temp = path.with_extension(format!("tmp-{}-{}", std::process::id(), fresh_id("write")));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        serde_json::to_writer(&mut file, draft)?;
        file.flush()?;
        file.sync_all()?;
        std::fs::rename(temp, path)
    }
}

impl ChatApp {
    pub(super) fn render_composer_suggestions(
        &self,
        cx: &mut Context<Self>,
    ) -> (Option<AnyElement>, Option<AnyElement>) {
        // @-mention autocomplete rows (top of the composer shell). Rows are
        // plain-text inserts: `@path ` (quoted when the path has spaces).
        let mention_list: Option<gpui::AnyElement> = self
            .mention
            .as_ref()
            .filter(|mention| mention.loading || !mention.results.is_empty())
            .map(|mention| {
                let mut list = v_flex()
                    .w_full()
                    .py_1()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .bg(cx.theme().secondary);
                if mention.loading {
                    list = list.child(
                        h_flex()
                            .px_3()
                            .py_2()
                            .gap_2()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(Icon::new(IconName::LoaderCircle).size_3p5())
                            .child("Searching workspace…"),
                    );
                }
                for (index, entry) in mention.results.iter().enumerate() {
                    let icon = if entry.kind == ProjectEntryKind::Directory {
                        crate::icons::folder_icon(false, cx)
                    } else {
                        crate::icons::file_icon(&entry.path.0, cx)
                    };
                    list = list.child(
                        h_flex()
                            .id(("mention", index))
                            .px_3()
                            .py_1()
                            .gap_2()
                            .items_center()
                            .cursor_pointer()
                            .text_sm()
                            .when(index == mention.selected, |row| row.bg(cx.theme().accent))
                            .hover(|style| style.bg(cx.theme().accent))
                            .child(icon)
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .child(SharedString::from(entry.path.0.clone())),
                            )
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.apply_mention(index, window, cx);
                            })),
                    );
                }
                list.into_any_element()
            });
        let command_list: Option<gpui::AnyElement> = self.composer_menu.as_ref().map(|menu| {
            let mut list = v_flex()
                .w_full()
                .max_h(px(300.))
                .overflow_y_scrollbar()
                .py_1()
                .border_b_1()
                .border_color(cx.theme().border)
                .bg(cx.theme().secondary);
            if menu.items.is_empty() {
                list = list.child(
                    div()
                        .px_3()
                        .py_2()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("No matching suggestions"),
                );
            }
            for (index, item) in menu.items.iter().enumerate() {
                let (label, description, icon) = match item {
                    ComposerMenuItem::AskMode => (
                        "/ask".to_string(),
                        "Ask questions or request actions using tools, skills and MCP".to_string(),
                        IconName::MessageSquare,
                    ),
                    ComposerMenuItem::Model => (
                        "/model".to_string(),
                        "Switch response model for this thread".to_string(),
                        IconName::Bot,
                    ),
                    ComposerMenuItem::InteractionMode(ProviderInteractionMode::Plan) => (
                        "/plan".to_string(),
                        "Switch this thread into plan mode".to_string(),
                        IconName::SquarePen,
                    ),
                    ComposerMenuItem::InteractionMode(_) => (
                        "/default".to_string(),
                        "Switch this thread back to normal build mode".to_string(),
                        IconName::Bot,
                    ),
                    ComposerMenuItem::ProviderCommand { name, description } => (
                        format!("/{name}"),
                        description.clone(),
                        IconName::ChevronRight,
                    ),
                    ComposerMenuItem::Thread { title, detail, .. } => {
                        (format!("#{title}"), detail.clone(), IconName::MessageSquare)
                    }
                    ComposerMenuItem::Skill { name, description } => {
                        (format!("${name}"), description.clone(), IconName::SquarePen)
                    }
                };
                list = list.child(
                    h_flex()
                        .id(("composer-command", index))
                        .px_3()
                        .py_1p5()
                        .gap_2()
                        .items_center()
                        .cursor_pointer()
                        .when(index == menu.selected, |row| row.bg(cx.theme().accent))
                        .hover(|style| style.bg(cx.theme().accent))
                        .child(
                            Icon::new(icon)
                                .size_3p5()
                                .text_color(cx.theme().muted_foreground),
                        )
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .child(div().text_sm().truncate().child(SharedString::from(label)))
                                .child(
                                    div()
                                        .text_xs()
                                        .truncate()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(SharedString::from(description)),
                                ),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if let Some(menu) = &mut this.composer_menu {
                                menu.selected = index;
                            }
                            this.apply_active_composer_suggestion(window, cx);
                        })),
                );
            }
            list.into_any_element()
        });
        (mention_list, command_list)
    }
    pub(super) fn ensure_draft_project(&mut self, cx: &mut Context<Self>) {
        if self.thread.is_none()
            && self.draft_project.is_none()
            && let Some(project) = self
                .shell_threads()
                .into_iter()
                .filter(|t| {
                    self.sidebar.thread_last_visited(&t.id.0).is_some()
                        && !t.project_id.0.starts_with("cloud:")
                })
                .max_by(|a, b| {
                    self.sidebar
                        .thread_last_visited(&a.id.0)
                        .cmp(&self.sidebar.thread_last_visited(&b.id.0))
                })
                .map(|t| t.project_id)
                .or_else(|| {
                    self.shell
                        .snapshot
                        .as_ref()
                        .and_then(|s| s.projects.first())
                        .map(|p| p.id.clone())
                })
        {
            self.draft_restore = Some(self.drafts.load(&format!("project:{}", project.0)));
            self.draft_project = Some(project);
            cx.notify();
        }
    }
    pub(super) fn new_thread(
        &mut self,
        project: Option<ProjectId>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.draft_creating {
            return;
        }
        let project = project
            .or_else(|| {
                self.thread
                    .as_ref()
                    .and_then(|t| self.shell_thread(&t.id))
                    .map(|t| t.project_id.clone())
            })
            .or_else(|| self.draft_project.clone())
            .filter(|p| !p.0.starts_with("cloud:"));
        self.save_composer_draft(cx);
        self.close_open_thread(cx);
        self.draft_project = project;
        self.ensure_draft_project(cx);
        self.draft_restore = self
            .draft_project
            .as_ref()
            .map(|id| self.drafts.load(&format!("project:{}", id.0)))
            .or_else(|| Some(ComposerDraft::default()));
        self.restore_composer_draft(window, cx);
        self.composer.update(cx, |s, cx| s.focus(window, cx));
        cx.notify();
    }

    pub(super) fn draft_model_selection(&self, cx: &Context<Self>) -> Option<ModelSelection> {
        self.draft_model
            .clone()
            .or_else(|| {
                self.shell
                    .snapshot
                    .as_ref()?
                    .projects
                    .iter()
                    .find(|p| Some(&p.id) == self.draft_project.as_ref())?
                    .default_model_selection
                    .clone()
            })
            .or_else(|| default_model_selection(&self.provider_snapshots, cx))
    }

    pub(super) fn render_draft_landing(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (mentions, commands) = self.render_composer_suggestions(cx);
        let projects = self
            .shell
            .snapshot
            .as_ref()
            .map(|s| s.projects.clone())
            .unwrap_or_default();
        let selected = self
            .draft_project
            .as_ref()
            .and_then(|id| projects.iter().find(|p| &p.id == id));
        let name = selected
            .map(|p| p.title.0.clone())
            .unwrap_or_else(|| "Choose a project".into());
        let owner = cx.entity().downgrade();
        let model = self.draft_model_selection(cx);
        let slug = model.as_ref().and_then(|m| m.model.as_str());
        let instance = model
            .as_ref()
            .and_then(|m| m.instance_id.as_ref())
            .and_then(|v| v.as_ref())
            .and_then(|v| v.as_str());
        let model_info = self
            .provider_snapshots
            .iter()
            .flat_map(|p| p.models.iter().map(move |m| (p, m)))
            .find(|(p, m)| {
                Some(m.slug.0.as_str()) == slug && instance.is_none_or(|id| id == p.instance_id.0)
            });
        let model_label = model_info
            .map(|(_, m)| m.name.0.as_str())
            .or(slug)
            .unwrap_or("Choose model")
            .to_string();
        let descriptors = model_info
            .and_then(|(_, m)| m.capabilities.as_ref())
            .and_then(|c| c.option_descriptors.clone().flatten())
            .unwrap_or_default();
        let options = model
            .as_ref()
            .and_then(|m| m.options.as_ref())
            .and_then(|o| o.as_ref())
            .and_then(|o| o.as_array())
            .into_iter()
            .flatten()
            .filter_map(|o| Some((o.get("id")?.as_str()?.to_owned(), o.get("value")?.clone())))
            .collect();
        let reasoning = self.render_reasoning_picker(descriptors, options, cx);
        let picker = self.model_picker.clone();
        let focus = picker.as_ref().map(|p| p.read(cx).query.focus_handle(cx));
        let picker_owner = cx.weak_entity();
        let model_menu =
            gpui_component::popover::Popover::new("draft-model-menu")
                .anchor(gpui::Anchor::BottomLeft)
                .open(picker.is_some())
                .w((window.rem_size() * 32.)
                    .min(window.viewport_size().width - window.rem_size() * 2.))
                .p_1()
                .trigger(
                    Button::new("draft-model")
                        .ghost()
                        .small()
                        .label(model_label)
                        .when_some(model_info, |b, (p, _)| {
                            b.icon(crate::icons::provider_icon(&p.driver.0, cx))
                        })
                        .tooltip("Choose model")
                        .disabled(self.draft_creating),
                )
                .when_some(focus, |p, f| p.track_focus(&f))
                .on_open_change(move |open, w, cx| {
                    let _ = picker_owner.update(cx, |app, cx| {
                        if *open != app.model_picker.is_some() {
                            app.open_model_picker(w, cx);
                        }
                    });
                })
                .content(move |_, _, _| div().children(picker.clone()));
        let mode = self.render_mode_switch(
            self.draft_mode == Some(ProviderInteractionMode::Plan),
            window,
            cx,
        );
        let runtime = self.render_runtime_picker(
            self.draft_runtime_mode.clone(),
            window.viewport_size().width < px(1100.),
            cx,
        );
        let location = self.render_location_switch(cx);
        let send = Button::new("draft-send")
            .primary()
            .small()
            .icon(IconName::ArrowUp)
            .tooltip("Send message")
            .disabled(
                self.draft_creating
                    || (self.draft_work_location.is_cloud()
                        && self.cloud_start_blocker(cx).is_some())
                    || self.draft_project.is_none()
                    || (self.composer.read(cx).value().trim().is_empty()
                        && self.pending_attachments.is_empty()),
            )
            .on_click(cx.listener(|app, _, w, cx| app.send(w, cx)))
            .into_any_element();
        let controls = self.render_composer_controls(
            model_menu.into_any_element(),
            reasoning,
            location,
            mode,
            runtime,
            None,
            send,
            cx,
        );
        let status = self.render_conversation_status(window, cx);
        let compact = window.viewport_size().height < px(640.);
        v_flex().size_full().child(self.render_draft_header(cx)).child(v_flex().flex_1().min_w_0().min_h_0().bg(crate::glass::background(cx)).items_center().justify_center().p_5().when(compact, |body| body.p_3())
            .child(v_flex().w_full().max_w(px(768.)).gap_5().when(compact, |body| body.gap_2())
                .when(!compact, |body| body.child(v_flex().gap_2().child(div().text_2xl().font_semibold().child("What would you like to build?"))
                    .child(div().text_sm().text_color(cx.theme().muted_foreground).child("Draft your next conversation. It stays here until you send it."))))
                .when(selected.is_none(),|hero|hero.child(h_flex().child(Button::new("draft-open-folder").primary().label("Open a project folder…").on_click(cx.listener(|app,_,w,cx|app.open_add_project(w,cx))))))
                .when(self.draft_work_location.is_cloud(), |body| body.child(div().id("draft-onboarding").when(compact, |notice| notice.max_h(px(80.)).overflow_y_scroll()).child(self.render_cloud_onboarding(window, cx))))
                .child(h_flex().child(Button::new("draft-project").ghost().small().icon(IconName::Folder).label(name).disabled(self.draft_creating).dropdown_menu(move |menu, _, _| {
                    let mut menu = menu;
                    for project in &projects { let owner = owner.clone(); let id = project.id.clone(); menu = menu.item(PopupMenuItem::new(project.title.0.clone()).on_click(move |_, w, cx| {let _ = owner.update(cx, |app, cx| app.new_thread(Some(id.clone()), w, cx));})); } menu
                })))
                .child(v_flex().gap_2().child(status)
                .child(v_flex().rounded(px(22.)).border_1().border_color(cx.theme().border).bg(crate::glass::control(cx))
                    .overflow_hidden()
                    .on_drop(cx.listener(|app, paths: &ExternalPaths, w, cx| app.stage_attachment_paths(paths.paths().iter(), w, cx)))
                    .on_drop(cx.listener(|app, context: &crate::files::FileContext, w, cx| app.insert_file_context(context,w,cx)))
                    .on_action(|_: &gpui_component::input::Enter, _, cx| cx.stop_propagation())
                    .capture_key_down(cx.listener(|app, event: &gpui::KeyDownEvent, w, cx| {
                        let modifiers = event.keystroke.modifiers;
                        if event.keystroke.key == "v" && if cfg!(target_os="macos") {modifiers.platform} else {modifiers.control}
                            && let Some(clipboard) = cx.read_from_clipboard() && app.stage_clipboard_item(&clipboard,w,cx) {cx.stop_propagation();return;}
                        let handled = match event.keystroke.key.as_str() {
                            "up" => app.move_composer_suggestion(-1,cx), "down" => app.move_composer_suggestion(1,cx),
                            "escape" if app.mention.is_some() || app.composer_menu.is_some() => {app.mention=None;app.composer_menu=None;cx.notify();true}, _=>false
                        }; if handled {cx.stop_propagation();}
                    }))
                    .child(div().id("draft-suggestions").when(compact, |list| list.max_h(px(48.)).overflow_y_scroll()).children(mentions).children(commands))
                    .child(div().debug_selector(|| "draft-input-viewport".into()).px_3().pt_3().overflow_hidden().child(Textarea::new(&self.composer).appearance(false).disabled(self.draft_creating)))
                    .child(div().id("draft-attachments").when(compact, |list| list.max_h(px(32.)).overflow_y_scroll()).children(self.pending_attachments.iter().enumerate().map(|(i,a)| Button::new(("draft-attachment",i)).ghost().small().label(format!("{} ×",a.name))
                        .on_click(cx.listener(move |app,_,_,cx| {app.pending_attachments.remove(i); app.schedule_draft_save(cx); cx.notify();})))))
                    .child(div().flex_shrink_0().child(controls))))))
            .into_any_element()
    }
    pub(super) fn capture_composer_draft(&self, cx: &Context<Self>) -> ComposerDraft {
        let draft = ComposerDraft {
            text: self.composer.read(cx).value().to_string(),
            work_location: self.draft_work_location,
            cloud: CloudDraft {
                base_branch: Some(self.cloud_branch.read(cx).value().to_string()),
                issue_number: self.cloud_issue.read(cx).value().trim().parse().ok(),
                ..self.cloud_draft.clone()
            },
            model: self.draft_model.clone(),
            mode: self.draft_mode.clone(),
            runtime_mode: Some(self.draft_runtime_mode.clone()),
            pending_cloud: self
                .cloud_pending_send
                .clone()
                .filter(|pending| self.open_cloud_task_id().as_deref() == Some(&pending.task_id)),
            pending_local: self
                .thread
                .as_ref()
                .and_then(|open| self.local_outbox.get(&open.id))
                .cloned(),
            ask_mode: self.ask_mode,
            attachments: self.pending_attachments.clone(),
            review_comments: self.pending_review_comments.clone(),
            terminal_contexts: self.pending_terminal_contexts.clone(),
        };
        // Pending delivery is separate from editable input.
        draft
    }
    pub(super) fn insert_file_context(
        &mut self,
        context: &crate::files::FileContext,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .workspace_client()
            .is_none_or(|client| !Arc::ptr_eq(&client, &context.client))
            || self.is_cloud_thread() && !self.workspace_roots().contains(&context.cwd)
        {
            return;
        }
        if self.thread.is_none() && self.draft_project.is_none() {
            window.push_notification(
                Notification::info("Open a conversation before adding a file."),
                cx,
            );
            return;
        }
        let path = if self.search_root().as_deref() == Some(&context.cwd) {
            context.path.clone()
        } else {
            Path::new(&context.cwd)
                .join(&context.path)
                .to_string_lossy()
                .into_owned()
        };
        let token = if path
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\\')
        {
            format!("@{}", serde_json::to_string(&path).unwrap())
        } else {
            format!("@{path}")
        };
        self.composer.update(cx, |s, cx| {
            let value = s.value();
            s.set_value(
                format!(
                    "{}{}{} ",
                    value,
                    if value.is_empty() || value.ends_with(char::is_whitespace) {
                        ""
                    } else {
                        " "
                    },
                    token
                ),
                window,
                cx,
            );
            s.focus(window, cx);
        });
        self.schedule_draft_save(cx);
        cx.notify();
    }
    pub(super) fn schedule_draft_save(&mut self, cx: &mut Context<Self>) {
        if self.draft_restore.is_some() {
            return;
        }
        let executor = cx.background_executor().clone();
        self.draft_save_task = Some(cx.spawn(async move |this, cx| {
            executor.timer(Duration::from_millis(350)).await;
            let _ = this.update(cx, |this, cx| this.save_composer_draft(cx));
        }));
    }
    pub(super) fn save_composer_draft(&mut self, cx: &mut Context<Self>) {
        if self.draft_restore.is_some() {
            return;
        }
        let Some(id) = self.thread.as_ref().map(|t| t.id.0.clone()).or_else(|| {
            self.draft_project
                .as_ref()
                .map(|p| format!("project:{}", p.0))
        }) else {
            return;
        };
        let draft = self.capture_composer_draft(cx);
        if let Some(pending) = draft.cloud.pending_start.as_ref()
            && let Some(project) = pending.input.project_id.as_ref()
        {
            self.cloud_pending_starts
                .insert(project.clone(), pending.clone());
        }
        if let Some(pending) = draft.pending_cloud.as_ref() {
            self.cloud_pending_sends
                .insert(pending.task_id.clone(), pending.clone());
        }
        if let Err(e) = self.drafts.save(&id, &draft) {
            self.runtime_notice =
                Some(format!("Could not save the conversation draft: {e}").into());
        }
    }
    pub(super) fn restore_composer_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(mut draft) = self.draft_restore.take() else {
            self.reconcile_restored_cloud_prompt(window, cx);
            return;
        };
        // Older builds persisted the exact Ask wrapper as retry text. Only
        // migrate text proven to be that request, never arbitrary user drafts.
        if draft.cloud.prompt_recovery.is_none()
            && let Some(task_id) = self.open_cloud_task_id()
            && let Some(request_key) = draft.cloud.request_key.clone()
            && let Some(input) = draft.cloud.request_identity.as_ref().and_then(|json| {
                serde_json::from_str::<vitre_contracts::CloudContinueConversationInput>(json).ok()
            })
            && input.task_id == task_id
            && draft.text == input.prompt
            && let Some(raw_prompt) = draft.text.strip_prefix(&ask_mode_prompt(true, ""))
        {
            draft.cloud.prompt_recovery = Some(cloud_thread::CloudPromptRecovery {
                request_key,
                prompt: input.prompt,
                raw_prompt: raw_prompt.to_string(),
            });
            draft.text = raw_prompt.to_string();
        }
        if self.thread.is_none() {
            if let Some(project) = self.draft_project.as_ref()
                && let Some(pending) = self.cloud_pending_starts.get(&project.0)
            {
                draft.cloud.pending_start = Some(pending.clone());
            }
            if let Some(pending) = draft.cloud.pending_start.as_mut() {
                if pending.delivery == cloud_thread::CloudDeliveryState::Submitting {
                    pending.delivery = cloud_thread::CloudDeliveryState::Unknown;
                }
                if let Some(project) = pending.input.project_id.as_ref() {
                    self.cloud_pending_starts
                        .insert(project.clone(), pending.clone());
                }
            }
        }
        self.composer
            .update(cx, |s, cx| s.set_value(draft.text, window, cx));
        self.pending_attachments = draft.attachments;
        self.pending_review_comments = draft.review_comments;
        self.pending_terminal_contexts = draft.terminal_contexts;
        self.draft_model = draft.model;
        self.draft_mode = draft.mode;
        self.draft_runtime_mode = draft.runtime_mode.unwrap_or(RuntimeMode::FullAccess);
        self.cloud_pending_send = draft
            .pending_cloud
            .filter(|pending| self.open_cloud_task_id().as_deref() == Some(&pending.task_id));
        if let Some(pending) = self.cloud_pending_send.as_mut() {
            if pending.delivery == cloud_thread::CloudDeliveryState::Submitting {
                pending.delivery = cloud_thread::CloudDeliveryState::Unknown;
            }
            self.cloud_pending_sends
                .insert(pending.task_id.clone(), pending.clone());
        }
        self.restore_cloud_outbox_message(cx);
        let pending_local = draft.pending_local;
        self.ask_mode = draft.ask_mode;
        self.draft_work_location = draft.work_location;
        self.cloud_draft = draft.cloud;
        self.cloud_branch.update(cx, |s, cx| {
            s.set_value(
                self.cloud_draft.base_branch.clone().unwrap_or_default(),
                window,
                cx,
            )
        });
        self.cloud_issue.update(cx, |s, cx| {
            s.set_value(
                self.cloud_draft
                    .issue_number
                    .map(|n| n.to_string())
                    .unwrap_or_default(),
                window,
                cx,
            )
        });
        self.restore_local_outbox(pending_local, window, cx);
        self.sync_composer_menu(cx);
        self.sync_mention(cx);
        self.reconcile_restored_cloud_prompt(window, cx);
    }

    fn reconcile_restored_cloud_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(recovery) = self.cloud_draft.prompt_recovery.as_ref() else {
            return;
        };
        if !self.is_cloud_thread() {
            return;
        }
        // A user may start a different draft before history arrives. That draft
        // belongs to them even if the previous request is later acknowledged.
        let unchanged = self.composer.read(cx).value().as_ref() == recovery.raw_prompt;
        let acknowledged = self
            .thread
            .as_ref()
            .and_then(|open| open.state.view.as_ref())
            .is_some_and(|view| {
                view.messages.iter().any(|message| {
                    message.role == OrchestrationMessageRole::User
                        && message.id.0 == format!("{}-message", recovery.request_key)
                        && cloud_thread::cloud_message_matches_prompt(
                            &message.text.0,
                            &recovery.prompt,
                        )
                })
            });
        if !unchanged || acknowledged {
            self.cloud_draft.prompt_recovery = None;
            if acknowledged {
                self.cloud_draft.request_key = None;
                self.cloud_draft.request_identity = None;
                if unchanged {
                    self.composer
                        .update(cx, |s, cx| s.set_value("", window, cx));
                }
            }
            self.save_composer_draft(cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pending_creation() -> cloud_thread::CloudPendingStart {
        cloud_thread::CloudPendingStart {
            input: serde_json::from_value(serde_json::json!({
                "idempotencyKey":"immutable-first-send", "projectId":"project-a", "roots":[{"id":"primary","path":"/tmp/repository"}],
                "target":"cloud-local", "prompt":"original prompt", "provider":"codex", "model":"gpt-6-sol",
                "runtimeMode":"approval-required", "attachments":[]
            })).unwrap(),
            raw_prompt: "original prompt".into(), attachments: vec![], review_comments: vec![], terminal_contexts: vec![],
            delivery: cloud_thread::CloudDeliveryState::Submitting, error: None,
            requested_at: "2026-10-16T15:00:00Z".into(), account_identity: Some("relay|account-a".into()),
        }
    }

    #[test]
    fn unreadable_draft_is_reported_and_never_overwritten_by_autosave() {
        let home = std::env::temp_dir().join(fresh_id("vitre-draft-corrupt"));
        let store = DraftStore::new(&home);
        std::fs::create_dir_all(&store.directory).unwrap();
        let original = b"{invalid-draft";
        std::fs::write(store.path("thread"), original).unwrap();
        let _ = store.load("thread");
        let error = store.take_error().unwrap();
        assert!(error.contains("Could not decode saved draft"));
        assert!(!error.contains("invalid-draft"));
        let write = store.save_confirmed("thread", &ComposerDraft::default());
        assert!(futures::executor::block_on(write).unwrap().is_err());
        assert_eq!(std::fs::read(store.path("thread")).unwrap(), original);
        std::fs::write(store.path("thread"), b"{\"text\":\"recovered\"}").unwrap();
        assert_eq!(store.load("thread").text, "recovered");
        futures::executor::block_on(store.save_confirmed("thread", &ComposerDraft::default()))
            .unwrap()
            .unwrap();
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn concurrent_draft_writers_publish_complete_files() {
        let home = std::env::temp_dir().join(fresh_id("vitre-draft-writers"));
        let threads: Vec<_> = (0..4)
            .map(|index| {
                let home = home.clone();
                std::thread::spawn(move || {
                    let store = DraftStore::new(&home);
                    let draft = ComposerDraft {
                        text: format!("writer-{index}").repeat(1000),
                        ..Default::default()
                    };
                    for _ in 0..15 {
                        futures::executor::block_on(store.save_confirmed("thread", &draft))
                            .unwrap()
                            .unwrap();
                        let _ = store.load("thread");
                        assert!(store.take_error().is_none());
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn initial_cloud_outbox_survives_restart_and_uncertainty_with_exact_payload() {
        let home = std::env::temp_dir().join(fresh_id("vitre-first-send"));
        let store = DraftStore::new(&home);
        let pending = pending_creation();
        let draft = ComposerDraft {
            text: "typed afterward".into(),
            cloud: CloudDraft {
                pending_start: Some(pending.clone()),
                ..Default::default()
            },
            ..Default::default()
        };
        futures::executor::block_on(store.save_confirmed("project:project-a", &draft))
            .unwrap()
            .unwrap();
        let original = serde_json::to_value(&pending.input).unwrap();
        let restored = DraftStore::new(&home);
        let loaded = restored.load("project:project-a");
        assert_eq!(
            serde_json::to_value(&loaded.cloud.pending_start.as_ref().unwrap().input).unwrap(),
            original
        );
        let result = restored
            .finish_cloud_start(
                "project:project-a",
                "immutable-first-send",
                &crate::cloud::store::CreationOutcome::Unknown("reply lost".into()),
                None,
            )
            .unwrap();
        assert_eq!(result.text, "typed afterward");
        let saved = result.cloud.pending_start.unwrap();
        assert_eq!(saved.delivery, cloud_thread::CloudDeliveryState::Unknown);
        assert_eq!(serde_json::to_value(&saved.input).unwrap(), original);
        assert!(
            restored
                .finish_cloud_start(
                    "project:project-a",
                    "other-key",
                    &crate::cloud::store::CreationOutcome::Rejected("old response".into()),
                    None
                )
                .is_none()
        );
        restored.flush();
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn initial_cloud_rejection_restores_once_and_acceptance_preserves_new_input() {
        for accepted in [false, true] {
            let home = std::env::temp_dir().join(fresh_id("vitre-first-result"));
            let store = DraftStore::new(&home);
            let draft = ComposerDraft {
                text: "new typing".into(),
                cloud: CloudDraft {
                    pending_start: Some(pending_creation()),
                    ..Default::default()
                },
                ..Default::default()
            };
            futures::executor::block_on(store.save_confirmed("project:project-a", &draft))
                .unwrap()
                .unwrap();
            let outcome = if accepted {
                crate::cloud::store::CreationOutcome::Accepted("task-created".into())
            } else {
                crate::cloud::store::CreationOutcome::Rejected("definite rejection".into())
            };
            let result = store
                .finish_cloud_start("project:project-a", "immutable-first-send", &outcome, None)
                .unwrap();
            assert_eq!(
                result.text,
                if accepted {
                    "new typing"
                } else {
                    "original prompt\nnew typing"
                }
            );
            assert!(result.cloud.pending_start.is_none());
            assert!(
                store
                    .finish_cloud_start("project:project-a", "immutable-first-send", &outcome, None)
                    .is_none()
            );
            store.flush();
            std::fs::remove_dir_all(home).unwrap();
        }
    }

    #[test]
    fn independent_threads_restore_text_and_context_after_restart() {
        let dir = std::env::temp_dir().join(fresh_id("vitre-draft-test"));
        let store = DraftStore::new(&dir);
        store
            .save(
                "env/thread/one",
                &ComposerDraft {
                    text: "keep café\n".into(),
                    ask_mode: true,
                    attachments: vec![PendingAttachment {
                        name: "one.txt".into(),
                        mime_type: "text/plain".into(),
                        size_bytes: 1,
                        data_url: "data:text/plain;base64,eA==".into(),
                        is_image: false,
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .save(
                "two",
                &ComposerDraft {
                    text: "separate".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        store.flush();
        store
            .copy_preferences("env/thread/one", "cloud-new")
            .unwrap();
        store.flush();
        let preferences = store.load("cloud-new");
        assert!(preferences.ask_mode);
        assert!(preferences.text.is_empty());
        assert!(preferences.attachments.is_empty());
        let restored = DraftStore::new(&dir);
        assert_eq!(restored.load("env/thread/one").text, "keep café\n");
        assert!(restored.load("env/thread/one").ask_mode);
        assert!(!restored.load("two").ask_mode);
        assert_eq!(restored.load("env/thread/one").attachments.len(), 1);
        assert_eq!(restored.load("two").text, "separate");
        assert!(restored.load("missing").text.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
