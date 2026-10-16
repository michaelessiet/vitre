//! Opt-in native integration pass. Always use a disposable VITRE_HOME.
use super::*;
use crate::cloud::{
    SessionState,
    store::{CloudEvent, TaskDetail},
    tests::fixtures,
};
use vitre_contracts::CloudTaskState;

impl ChatApp {
    pub(super) fn verify_cloud_threads_if_requested(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if std::env::var("VITRE_VERIFY_CLOUD_THREADS").as_deref() != Ok("1")
            || self.client.is_none()
            || self.shell.snapshot.is_none()
            || STARTED.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let client = self.client.clone().unwrap();
        let executor = cx.background_executor().clone();
        cx.spawn_in(window,async move |this,cx| {
            let verify = async {
                let project=fresh_id("verify-project");
                let local=ThreadId(fresh_id("verify-local"));
                let root=std::env::var("VITRE_HOME")?;
                let cwd=PathBuf::from(root).join(&project).to_string_lossy().into_owned();
                for payload in [
                    serde_json::json!({"type":"project.create","commandId":fresh_id("cmd"),"projectId":project,"title":"Cloud UI verification","workspaceRoot":cwd,"createWorkspaceRootIfMissing":true,"createdAt":now_iso()}),
                    serde_json::json!({"type":"thread.create","commandId":fresh_id("cmd"),"projectId":project,"threadId":local,"title":"Local conversation","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":now_iso()})
                ] {
                    let command:ClientOrchestrationCommand=serde_json::from_value(payload)?;
                    client.dispatch(&command).await.map_err(|e|anyhow::anyhow!(e.user_message()))?;
                }
                loop {
                    if this.update(cx,|a,_|a.shell_thread(&local).is_some())? {break;}
                    executor.timer(Duration::from_millis(50)).await;
                }
                this.update_in(cx,|a,w,cx|a.new_thread(Some(ProjectId(project.clone())),w,cx))?;
                executor.timer(Duration::from_millis(180)).await;
                this.update_in(cx,|a,w,cx|{
                    assert_eq!(a.draft_work_location,WorkLocation::Local);
                    a.pending_attachments.push(PendingAttachment { name:"verification.txt".into(), mime_type:"text/plain".into(), size_bytes:1, data_url:"data:text/plain;base64,eA==".into(), is_image:false });
                    a.set_draft_work_location(WorkLocation::Cloud,w,cx);
                    assert_eq!(a.pending_attachments.len(),1);
                    a.set_draft_work_location(WorkLocation::CloudLocal,w,cx);
                    assert_eq!(a.pending_attachments.len(),1);
                    a.cloud_store.update(cx,|s,cx|{s.session=SessionState::SignedOut;cx.notify();});
                })?;
                executor.timer(Duration::from_millis(180)).await;
                eprintln!("[vitre-cloud-ui] cloud draft and signed-out onboarding rendered");
                this.update(cx,|a,cx|{
                    a.cloud_store.update(cx,|s,cx|{
                        s.apply_overview(fixtures::overview(vec![fixtures::repository()],vec![fixtures::task("task-1",CloudTaskState::Completed,true)]),cx);
                        s.details.insert("task-1".into(),TaskDetail{conversation:Some(Arc::new(fixtures::thread())),result:Some(fixtures::saved_result()),..Default::default()});
                        cx.emit(CloudEvent::Changed);
                    });
                    a.rebuild_cloud_shells(cx);
                    a.select_thread(cloud_thread::cloud_thread_id("task-1"),cx);
                })?;
                executor.timer(Duration::from_millis(180)).await;
                this.update_in(cx,|a,w,cx| {
                    assert!(a.is_cloud_thread()); assert!(a.search_root().is_none());
                    assert!(a.cloud_send_blocker(cx).is_none()); assert!(a.revert_turn_counts.is_empty());
                    a.open_workspace_surface(vitre_state::right_panel::SurfaceKind::Diff,w,cx);
                })?;
                executor.timer(Duration::from_millis(180)).await;
                this.update_in(cx,|a,w,cx|a.open_workspace_surface(vitre_state::right_panel::SurfaceKind::Tests,w,cx))?;
                executor.timer(Duration::from_millis(180)).await;
                // Exercise active-environment tools with a real isolated sidecar
                // standing in for the cloud transport; no provider turn is started.
                let remote_project=fresh_id("verify-remote-project");
                let remote_root=PathBuf::from(std::env::var("VITRE_HOME")?).join(&remote_project).to_string_lossy().into_owned();
                for payload in [
                    serde_json::json!({"type":"project.create","commandId":fresh_id("cmd"),"projectId":remote_project,"title":"Remote tools verification","workspaceRoot":remote_root,"createWorkspaceRootIfMissing":true,"createdAt":now_iso()}),
                    serde_json::json!({"type":"thread.create","commandId":fresh_id("cmd"),"projectId":remote_project,"threadId":"cloud-task-1","title":"Cloud tools fixture","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":now_iso()})
                ] {
                    client.dispatch(&serde_json::from_value(payload)?).await.map_err(|e|anyhow::anyhow!(e.user_message()))?;
                }
                for _ in 0..60 {
                    if client.shell().borrow().snapshot.as_ref().is_some_and(|snapshot|snapshot.threads.iter().any(|thread|thread.id.0=="cloud-task-1")) { break; }
                    executor.timer(Duration::from_millis(50)).await;
                }
                this.update(cx,|a,_| {
                    let ThreadFeed::Cloud(feed)=&mut a.thread.as_mut().unwrap().feed else {panic!("cloud feed")};
                    feed.live=Some((client.clone(),Arc::new(client.open_thread(cloud_thread::cloud_thread_id("task-1")))));
                    assert_eq!(a.search_root().as_deref(),Some(remote_root.as_str()));
                })?;
                for kind in [vitre_state::right_panel::SurfaceKind::Files,vitre_state::right_panel::SurfaceKind::Search,vitre_state::right_panel::SurfaceKind::Terminal] {
                    this.update_in(cx,|a,w,cx|a.open_workspace_surface(kind,w,cx))?;
                    executor.timer(Duration::from_millis(180)).await;
                }
                this.update(cx,|a,cx| {
                    assert_eq!(a.files.as_ref().unwrap().read(cx).cwd(),remote_root);
                    assert!(a.files.as_ref().unwrap().read(cx).uses_client(&client));
                    assert_eq!(a.thread_launch_defaults().unwrap().cwd,remote_root);
                    a.sync_cloud_thread(cx);
                    assert!(a.workspace_client().is_none());
                    assert!(a.search_root().is_none());
                })?;
                this.update(cx, |a, cx| {
                    let binding: vitre_contracts::CloudConversationBinding = serde_json::from_value(serde_json::json!({
                        "conversationId":local.0,"localThreadId":local.0,"cloudTaskId":"task-1","target":"cloud-local",
                        "generation":1,"leaseOwner":"verification","leaseExpiresAt":null,"aliases":["task-1"]
                    })).unwrap();
                    a.cloud_store.update(cx, |store, cx| { store.overview.as_mut().unwrap().bindings = Some(vec![binding]); cx.notify(); });
                    a.rebuild_cloud_shells(cx);
                    a.select_thread(local.clone(), cx);
                    assert!(a.is_cloud_thread());
                    assert_eq!(a.thread.as_ref().unwrap().id, local);
                    assert_eq!(a.shell_threads().iter().filter(|thread| thread.id == local).count(), 1);
                    assert_eq!(a.execution_thread_id().unwrap().0, "cloud-task-1");
                    a.cloud_store.update(cx, |store, cx| {
                        let binding = &mut store.overview.as_mut().unwrap().bindings.as_mut().unwrap()[0];
                        binding.target = vitre_contracts::CloudExecutionTarget::Local;
                        binding.generation = 2;
                        cx.notify();
                    });
                    a.rebuild_cloud_shells(cx);
                    a.select_thread(local.clone(), cx);
                    assert!(!a.is_cloud_thread());
                })?;
                eprintln!("[vitre-cloud-ui] attachments, active tools, disconnect fencing and one stable sidebar identity verified");
                this.update(cx,|a,cx|a.open_cloud_sheet(crate::cloud::Sheet::confirm_delete("task-1".into(),"Verification".into()),cx))?;
                executor.timer(Duration::from_millis(180)).await;
                ui_verification::key("escape",cx).await.map_err(anyhow::Error::msg)?;
                this.update(cx,|a,cx|{
                    assert!(a.cloud_sheet.is_none());
                    eprintln!("[vitre-cloud-ui] shared cloud conversation, Diff/Tests and Escape rendered");
                    a.select_thread(local.clone(),cx);
                })?;
                let mut polls=0;
                loop {
                    if this.update(cx,|a,_|a.thread.as_ref().is_some_and(|t|t.id==local && t.state.view.is_some()))? {break;}
                    polls+=1;
                    if polls==40 { this.update(cx,|a,_|eprintln!("[vitre-cloud-ui] local state: {:?}",a.thread.as_ref().map(|t|(&t.id,&t.state.phase,t.state.deleted))))?; }
                    executor.timer(Duration::from_millis(50)).await;
                }
                executor.timer(Duration::from_millis(180)).await;
                this.update(cx,|a,_| {assert!(!a.is_cloud_thread());assert_eq!(a.search_root().as_deref(),Some(cwd.as_str()));})?;
                anyhow::Ok(())
            };
            let outcome=tokio::select! { outcome=verify => outcome, _=executor.timer(Duration::from_secs(45)) => Err(anyhow::anyhow!("native verification timed out")) };
            match outcome {
                Ok(())=>eprintln!("[vitre-cloud-ui] PASS: local draft, cloud onboarding, shared cloud conversation, saved Diff/Tests, sheet Escape, local conversation"),
                Err(error)=>eprintln!("[vitre-cloud-ui] FAIL: {error:#}"),
            }
            let _=this.update(cx,|_,cx|cx.quit());
        }).detach();
    }
}
